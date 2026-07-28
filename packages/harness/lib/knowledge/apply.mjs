import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  ensureStore,
  appendLedger,
  readLedger,
  listLearnings,
  commitStore,
  normalizeSlug,
  repoId,
  parseLearningFrontmatter,
  readStoreConfig,
} from './store.mjs';
import { MAX_OPS_PER_RUN, LEARNING_BYTE_CAP, QUARANTINE_THRESHOLD } from './consolidate.mjs';
import { scanSecrets } from '../secret-scan.mjs';

/**
 * The SOLE writer of the learnings store. The consolidation skill emits an
 * operations JSON and writes nothing; every contract (op count, byte cap,
 * secret scan, imperative lint, disputed rule) is enforced here — so the
 * anti-collapse guarantees hold even on hosts without hooks.
 */

const FILE_TOUCHING = new Set(['ADD', 'STRENGTHEN', 'SUPERSEDE']);
const DISPUTED_FIX_THRESHOLD = 3;
// Codes that indicate the CONTENT of a specific op was rejected (bad shape,
// secret-shaped, imperative lint, over the byte cap, a dedup/rename
// collision, or a missing target) — as opposed to run-level or lock-level
// rejections (E_MODE, E_DELTA_CONTRACT, E_LOCKED, E_APPLY_FAILED) that say
// nothing about any one op's episodes and must never record a strike.
const CONTENT_FAILURE_CODES = new Set(['E_SCHEMA', 'E_SECRET', 'E_LINT', 'E_BYTE_CAP', 'E_EXISTS', 'E_TARGET']);
const ANCHOR_RE = /\b[\w][\w./-]*\.(?:mjs|js|ts|tsx|py|java|sql|md|ya?ml|json)\b/g;
const ANCHOR_CAP = 8;

function fail(code, reason) {
  return { code, reason };
}

function yamlQuote(v) {
  return `"${String(v)
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t')}"`;
}

export function todayClamped() {
  // Today's date, ISO-truncated to the day. (Not actually clamped against
  // anything — a real clock-skew guard would need an external reference.)
  return new Date().toISOString().slice(0, 10);
}

/**
 * Deterministic anchor extraction: for every episode whose own file exists
 * under the workspace, scan its text for repo-relative paths and keep the
 * ones that resolve to real files — excluding the episode's own path so a
 * doc doesn't anchor itself. Dedupe, sort, cap at 8 (module-private; only
 * `renderLearning` writes the result).
 */
function extractAnchors({ workspace, episodes }) {
  const found = new Set();
  for (const e of episodes || []) {
    if (!e.path) continue;
    const full = path.join(workspace, e.path);
    if (!fs.existsSync(full)) continue;
    let text;
    try {
      text = fs.readFileSync(full, 'utf8');
    } catch {
      continue;
    }
    const matches = text.match(ANCHOR_RE) || [];
    for (const m of matches) {
      if (m === e.path) continue;
      if (!fs.existsSync(path.join(workspace, m))) continue;
      found.add(m);
    }
  }
  return [...found].sort().slice(0, ANCHOR_CAP);
}

function renderLearning({ trigger, body, episodes, anchors = [], origin, status, source, supersededBy, mergedFrom }) {
  const lines = [
    '---',
    'schema: 1',
    `trigger: ${yamlQuote(trigger)}`,
    `status: ${status}`,
    `source: ${source}`,
    'episodes:',
  ];
  for (const e of episodes) {
    lines.push(`  - path: ${e.path}`);
    lines.push(`    sha256: ${yamlQuote(e.sha256)}`);
    lines.push(`    kind: ${e.kind === 'insight' ? 'insight' : e.kind === 'human-teaching' ? 'human-teaching' : 'fix'}`);
    lines.push(`    plan: ${e.plan || ''}`);
  }
  if (anchors.length) {
    lines.push('anchors:');
    for (const a of anchors) lines.push(`  - ${a}`);
  } else {
    lines.push('anchors: []');
  }
  lines.push(`superseded_by: ${supersededBy || 'null'}`);
  lines.push(`last_confirmed: ${todayClamped()}`);
  if (mergedFrom?.length) lines.push(`merged_from: [${mergedFrom.join(', ')}]`);
  lines.push(`origin: ${origin}`);
  lines.push('---', '', body.trim(), '');
  return lines.join('\n');
}

function lintImperative({ body, trigger, episodes }) {
  const allInsight = episodes.length > 0 && episodes.every((e) => e.kind === 'insight');
  if (!allInsight) return null;
  const text = `${trigger}\n${body}`;
  if (/```(sh|bash|shell|zsh)/.test(text)) return 'imperative shell fence in insight-only learning';
  if (/\b(curl|wget)\s/i.test(text)) return 'imperative download command in insight-only learning';
  if (/https?:\/\//i.test(text)) return 'bare URL in insight-only learning';
  return null;
}

function validateEpisodes(episodes, opIndex) {
  if (!Array.isArray(episodes) || !episodes.length) {
    return fail('E_SCHEMA', `op ${opIndex}: episodes must be a non-empty array`);
  }
  for (const e of episodes) {
    if (!e.path || !/^[0-9a-f]{64}$/.test(e.sha256 || '')) {
      return fail('E_SCHEMA', `op ${opIndex}: each episode needs path + sha256`);
    }
  }
  return null;
}

function verifiedFixLinks(fm) {
  return (fm.episodes || []).filter((e) => e.kind === 'fix').length;
}

/**
 * Verify an asserted human-teaching episode against disk. Used both for the
 * SUPERSEDE disputed-demotion exemption and for `source`/`status` derivation
 * on ADD/SUPERSEDE writes — in both cases the op JSON's `episodes[].kind`
 * field is just an assertion (model- or human-authored text that nothing
 * else validates), so trusting it to grant elevated standing would let
 * anyone claim human-teaching for an episode that was never taught by a
 * human. An episode only counts if: its path resolves inside the workspace
 * (no `../` escape), its file exists there, the file's CURRENT content
 * hashes to the asserted sha256 (not stale/edited since), and the file's OWN
 * frontmatter independently says `kind: human-teaching` (not just the op's
 * claim). Any mismatch fails closed (false) — never throws, so a
 * missing/unreadable/escaping file simply falls back to the non-human lane.
 */
function verifyHumanTeachingEpisode(workspace, e) {
  if (e.kind !== 'human-teaching' || !e.path || !e.sha256) return false;
  // Containment guard: same root/startsWith idiom purge uses — an episode
  // path that escapes the workspace must never even be read.
  const root = path.resolve(workspace);
  const full = path.resolve(root, e.path);
  if (full !== root && !full.startsWith(root + path.sep)) return false;
  let text;
  try {
    text = fs.readFileSync(full, 'utf8');
  } catch {
    return false;
  }
  if (crypto.createHash('sha256').update(text).digest('hex') !== e.sha256) return false;
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return false;
  const kindLine = m[1].split('\n').find((l) => /^kind:\s*/.test(l));
  const kind = kindLine ? kindLine.replace(/^kind:\s*/, '').replace(/^["']|["']$/g, '').trim() : null;
  return kind === 'human-teaching';
}

export function applyOps({ workspace, opsPath, dryRun = false, home }) {
  // Kill switch: consolidate is a write path gated to mode 'on' only — checked
  // first, before the ops file is even parsed, and before the lockfile below.
  const { mode } = readStoreConfig(workspace, { home });
  if (mode !== 'on') {
    return {
      applied: [],
      rejected: [{ code: 'E_MODE', reason: `knowledge mode is ${mode} — run: harness knowledge on` }],
      committed: false,
      exitCode: 2,
    };
  }

  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(opsPath, 'utf8'));
  } catch (err) {
    return { applied: [], rejected: [fail('E_SCHEMA', `unreadable ops file: ${err.message}`)], committed: false, exitCode: 1 };
  }
  if (parsed.schema !== 1 || !Array.isArray(parsed.ops)) {
    return { applied: [], rejected: [fail('E_SCHEMA', 'ops file must be { schema: 1, ops: [...] }')], committed: false, exitCode: 1 };
  }

  const { dir, git } = ensureStore(workspace, { home, dryRun });
  const origin = repoId(workspace);
  const existing = new Map(listLearnings(dir).map((l) => [l.id, l]));

  /**
   * Three-strikes bookkeeping (design §3): a content-failure code raised by a
   * SPECIFIC op records one failure entry per episode of that op — never for
   * codes outside CONTENT_FAILURE_CODES, and never on dryRun or when the
   * store has no git (best effort, mirrors the rest of the store's degraded
   * modes). Episodes without a structurally valid path+sha256 are skipped —
   * there is nothing reliable to key a strike on. On an episode's 3rd
   * accumulated failure, the SAME append also writes the quarantine marker.
   * Never throws: a bookkeeping error must never mask the real rejection.
   */
  function recordContentFailure(code, episodes) {
    if (dryRun || !git || !CONTENT_FAILURE_CODES.has(code)) return;
    const eps = (episodes || []).filter((e) => e && e.path && /^[0-9a-f]{64}$/.test(e.sha256 || ''));
    if (!eps.length) return;
    try {
      const ledger = readLedger(dir);
      const at = todayClamped();
      const entries = [];
      for (const e of eps) {
        const priorFailures = ledger.filter((le) => le.failure && le.path === e.path && le.sha256 === e.sha256).length;
        entries.push({ path: e.path, sha256: e.sha256, failure: code, at });
        if (priorFailures + 1 >= QUARANTINE_THRESHOLD) {
          entries.push({ path: e.path, sha256: e.sha256, quarantined: true, learning: null, at });
        }
      }
      appendLedger(dir, entries);
      commitStore(dir, `consolidate: record failure ${code}`);
    } catch {
      // Best effort — failure recording must never mask the original rejection.
    }
  }

  function rejectOp(code, reason, episodes) {
    recordContentFailure(code, episodes);
    return { applied: [], rejected: [fail(code, reason)], committed: false, exitCode: 1 };
  }

  const fileTouching = parsed.ops.filter((o) => FILE_TOUCHING.has(o.op));
  if (fileTouching.length > MAX_OPS_PER_RUN) {
    return {
      applied: [],
      rejected: [fail('E_DELTA_CONTRACT', `run touches ${fileTouching.length} files — max ${MAX_OPS_PER_RUN} (anti-collapse contract)`)],
      committed: false,
      exitCode: 1,
    };
  }

  // Validate every op before writing anything — all-or-nothing runs.
  const planned = [];
  const disputes = [];
  for (let i = 0; i < parsed.ops.length; i++) {
    const op = parsed.ops[i];
    if (op.op === 'NOOP') {
      const bad = validateEpisodes(op.episodes, i);
      if (bad) return rejectOp(bad.code, bad.reason, op.episodes);
      planned.push({ ...op });
      continue;
    }
    if (!FILE_TOUCHING.has(op.op)) {
      return rejectOp('E_SCHEMA', `op ${i}: unknown op ${op.op}`, op.episodes);
    }
    const bad = validateEpisodes(op.episodes, i);
    if (bad) return rejectOp(bad.code, bad.reason, op.episodes);

    if (op.op === 'STRENGTHEN' || op.op === 'SUPERSEDE') {
      if (!op.target || !existing.has(op.target)) {
        return rejectOp('E_TARGET', `op ${i}: target ${op.target || '(none)'} does not exist`, op.episodes);
      }
    }

    if (op.op === 'ADD' || op.op === 'SUPERSEDE') {
      if (!op.domain || !op.slug || !op.trigger || !op.body) {
        return rejectOp('E_SCHEMA', `op ${i}: ${op.op} needs domain, slug, trigger, body`, op.episodes);
      }
      if (op.op === 'ADD') {
        // Dedup-miss protection: an ADD whose id already exists must never
        // silently overwrite the existing learning — reject the whole run
        // and route the caller to STRENGTHEN (more evidence) or SUPERSEDE
        // (replace the claim) instead.
        const addId = `${normalizeSlug(op.domain)}/${normalizeSlug(op.slug)}`;
        if (existing.has(addId)) {
          return rejectOp(
            'E_EXISTS',
            `op ${i}: ${addId} already exists — use STRENGTHEN (more evidence) or SUPERSEDE (replace the claim)`,
            op.episodes
          );
        }
      }
      const secrets = scanSecrets(`${op.trigger}\n${op.body}`);
      if (secrets.length) {
        return rejectOp('E_SECRET', `op ${i}: secret-shaped content (${secrets.map((s) => s.id).join(', ')})`, op.episodes);
      }
      const lint = lintImperative(op);
      if (lint) {
        return rejectOp('E_LINT', `op ${i}: ${lint}`, op.episodes);
      }
    }

    if (op.op === 'SUPERSEDE') {
      const target = existing.get(op.target);
      const newId = `${normalizeSlug(op.domain)}/${normalizeSlug(op.slug)}`;

      // Rename-collision guard: a SUPERSEDE writing to an id that already
      // belongs to a DIFFERENT existing learning must never silently
      // clobber it. Only the in-place shape (new id === the op's own
      // target) is allowed to "collide" — that's a replacement, not a
      // collision.
      if (newId !== op.target && existing.has(newId)) {
        return rejectOp(
          'E_EXISTS',
          `op ${i}: ${newId} already exists — choose a different slug or SUPERSEDE it directly instead of ${op.target}`,
          op.episodes
        );
      }

      // The human-teaching disputed-demotion exemption applies ONLY to the
      // in-place re-teach shape `remember` emits (new id === target — a
      // human re-teaching the SAME trigger/domain, never a rename) AND only
      // once every asserted human-teaching episode is verified against disk
      // (see verifyHumanTeachingEpisode) — the op's own `kind` field is not
      // itself proof of anything.
      const isReteachShape = newId === op.target;
      const allHumanTeaching =
        isReteachShape && op.episodes.length > 0 && op.episodes.every((e) => verifyHumanTeachingEpisode(workspace, e));
      if (!allHumanTeaching && (verifiedFixLinks(target.fm) >= DISPUTED_FIX_THRESHOLD || target.fm.source === 'human')) {
        // Demotion of well-evidenced or human-taught knowledge gets a human
        // reviewer: mark disputed, never silently supersede.
        disputes.push({ index: i, target: op.target });
        continue;
      }
    }
    planned.push({ ...op, index: i });
  }

  // Compose ADD/SUPERSEDE files and enforce the byte cap before writing.
  const writes = [];
  for (const op of planned) {
    if (op.op !== 'ADD' && op.op !== 'SUPERSEDE') continue;
    const domain = normalizeSlug(op.domain);
    const slug = normalizeSlug(op.slug);
    const id = `${domain}/${slug}`;
    // A direct human statement outranks statistics: episodes made entirely of
    // VERIFIED human-teaching evidence (see verifyHumanTeachingEpisode) land
    // active with source: human — no provisional damping for teachings
    // (design §6). An asserted-but-unverifiable human-teaching kind (a
    // fabricated or nonexistent episode) fails toward the standard
    // auto/provisional lane instead — this derivation never throws or
    // rejects the op, it just withholds the elevated standing.
    const source = op.episodes.length && op.episodes.every((e) => verifyHumanTeachingEpisode(workspace, e)) ? 'human' : 'auto';
    const status = source === 'human' ? 'active' : 'provisional';
    const content = renderLearning({
      trigger: op.trigger,
      body: op.body,
      episodes: op.episodes,
      anchors: extractAnchors({ workspace, episodes: op.episodes }),
      origin,
      status,
      source,
      supersededBy: null,
      mergedFrom: op.merged_from,
    });
    if (Buffer.byteLength(content, 'utf8') > LEARNING_BYTE_CAP) {
      return rejectOp('E_BYTE_CAP', `${id} exceeds ${LEARNING_BYTE_CAP} bytes — split into two claims`, op.episodes);
    }
    writes.push({ op, id, domain, slug, content });
  }

  if (dryRun) {
    return {
      applied: planned.map((o) => ({ op: o.op, id: o.target || (o.domain && `${normalizeSlug(o.domain)}/${normalizeSlug(o.slug)}`) || null })),
      rejected: disputes.map((d) => ({ ...fail('E_DISPUTED', 'disputed-pending-human'), reason: 'disputed-pending-human', target: d.target })),
      committed: false,
      exitCode: 0,
      dryRun: true,
    };
  }

  // Single-writer lock.
  const lockPath = path.join(dir, '.lock');
  try {
    fs.mkdirSync(lockPath);
  } catch {
    return { applied: [], rejected: [fail('E_LOCKED', 'another consolidation holds the store lock')], committed: false, exitCode: 1 };
  }

  const applied = [];
  const rejected = [];
  const ledgerEntries = [];
  const at = todayClamped();
  try {
    try {
      for (const { op, id, domain, slug, content } of writes) {
        const file = path.join(dir, 'learnings', domain, `${slug}.md`);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, content, 'utf8');
        applied.push({ op: op.op, id });
        for (const e of op.episodes) ledgerEntries.push({ path: e.path, sha256: e.sha256, learning: id, at });
        // A SUPERSEDE whose target is the SAME id as the file just written
        // (human re-teaching the same trigger/domain) is an in-place
        // replacement, not a tombstone-and-replace: `file` above already IS
        // the target's file, freshly overwritten with the new claim and
        // `superseded_by: null` (renderLearning always writes null for a new
        // write). Stamping superseded_by onto it here would point the new
        // content at itself, so that step only runs when target !== id.
        if (op.op === 'SUPERSEDE' && op.target !== id) {
          const target = existing.get(op.target);
          updateFrontmatterField(target.file, 'superseded_by', id);
        }
      }

      for (const op of planned) {
        if (op.op === 'STRENGTHEN') {
          const target = existing.get(op.target);
          strengthenLearning(target, op.episodes, workspace);
          applied.push({ op: 'STRENGTHEN', id: op.target });
          for (const e of op.episodes) ledgerEntries.push({ path: e.path, sha256: e.sha256, learning: op.target, at });
        } else if (op.op === 'NOOP') {
          applied.push({ op: 'NOOP', id: op.reason || null });
          for (const e of op.episodes) ledgerEntries.push({ path: e.path, sha256: e.sha256, learning: null, at });
        }
      }

      for (const d of disputes) {
        const target = existing.get(d.target);
        updateFrontmatterField(target.file, 'status', 'disputed');
        rejected.push({ ...fail('E_DISPUTED', 'disputed-pending-human'), reason: 'disputed-pending-human', target: d.target });
      }

      if (ledgerEntries.length) appendLedger(dir, ledgerEntries);
      rebuildIndex(dir);
    } catch (err) {
      // Atomic apply: the mutation phase (learning files → target
      // frontmatter → ledger append → INDEX rebuild) can throw mid-way,
      // leaving partial state. Most of the time the store tree is
      // committed-clean before this call (every successful apply ends in a
      // commit), so a hard reset + clean fully undoes the partial writes —
      // same git-invocation style as commitStore. Best effort beyond that:
      // if the store has never committed yet (no HEAD), `reset --hard` is a
      // no-op, but `clean -fd` still sweeps the untracked partial writes, so
      // atomicity still holds — the never-committed baseline stub files
      // (INDEX.md, empty ledger) get swept up too, but those self-heal via
      // ensureStore/rebuildIndex on the next call. If the store has no git
      // at all (ensureStore degraded), there's nothing to run, so we skip
      // restore entirely and just fail.
      if (git) {
        spawnSync('git', ['reset', '--hard'], { cwd: dir, encoding: 'utf8' });
        spawnSync('git', ['clean', '-fd'], { cwd: dir, encoding: 'utf8' });
      }
      return {
        applied: [],
        rejected: [fail('E_APPLY_FAILED', err.message)],
        committed: false,
        exitCode: 1,
      };
    }
  } finally {
    // The rollback above may have already removed the untracked .lock
    // directory via `git clean -fd` — tolerate that instead of throwing.
    fs.rmSync(lockPath, { recursive: true, force: true });
  }

  const summary = applied.map((a) => `${a.op.toLowerCase()}${a.id ? ` ${a.id}` : ''}`).join(' · ') || 'noop';
  const { committed } = commitStore(dir, `consolidate: ${summary}`);
  return { applied, rejected, committed, exitCode: 0, storeDir: dir, indexPath: path.join(dir, 'INDEX.md') };
}

export function updateFrontmatterField(file, field, value) {
  const text = fs.readFileSync(file, 'utf8');
  const re = new RegExp(`^${field}:.*$`, 'm');
  const next = re.test(text)
    ? text.replace(re, `${field}: ${value}`)
    : text.replace(/^---\n/, `---\n${field}: ${value}\n`);
  fs.writeFileSync(file, next, 'utf8');
}

function strengthenLearning(target, episodes, workspace) {
  const text = fs.readFileSync(target.file, 'utf8');
  const { fm, body } = parseLearningFrontmatter(text);
  const seen = new Set((fm.episodes || []).map((e) => `${e.path}@${e.sha256}`));
  const merged = [...(fm.episodes || [])];
  let gainedFix = false;
  for (const e of episodes) {
    if (seen.has(`${e.path}@${e.sha256}`)) continue;
    merged.push(e);
    if (e.kind === 'fix') gainedFix = true;
  }
  // One verified confirmation activates a provisional learning (rank damping ends).
  const status = fm.status === 'provisional' && gainedFix ? 'active' : fm.status || 'active';
  const content = renderLearning({
    trigger: fm.trigger || '',
    body,
    episodes: merged,
    anchors: extractAnchors({ workspace, episodes: merged }),
    origin: fm.origin || 'unknown',
    status,
    source: fm.source || 'auto',
    supersededBy: fm.superseded_by || null,
    mergedFrom: null,
  });
  fs.writeFileSync(target.file, content, 'utf8');
}

export function rebuildIndex(dir) {
  const active = listLearnings(dir).filter(
    (l) => !l.fm.superseded_by && !['retired', 'disputed'].includes(l.fm.status)
  );
  const lines = [
    '# Learnings Index',
    '',
    '_Rebuilt by `harness consolidate --apply`. One line per active learning._',
    '',
    ...active.map((l) => `- [${l.id}] ${l.fm.trigger || ''}`),
    '',
  ];
  fs.writeFileSync(path.join(dir, 'INDEX.md'), lines.join('\n'), 'utf8');
}
