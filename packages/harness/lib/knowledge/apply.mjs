import fs from 'node:fs';
import path from 'node:path';
import {
  ensureStore,
  appendLedger,
  listLearnings,
  commitStore,
  normalizeSlug,
  repoId,
  parseLearningFrontmatter,
  readStoreConfig,
} from './store.mjs';
import { MAX_OPS_PER_RUN, LEARNING_BYTE_CAP } from './consolidate.mjs';
import { scanSecrets } from '../secret-scan.mjs';

/**
 * The SOLE writer of the learnings store. The consolidation skill emits an
 * operations JSON and writes nothing; every contract (op count, byte cap,
 * secret scan, imperative lint, disputed rule) is enforced here — so the
 * anti-collapse guarantees hold even on hosts without hooks.
 */

const FILE_TOUCHING = new Set(['ADD', 'STRENGTHEN', 'SUPERSEDE']);
const DISPUTED_FIX_THRESHOLD = 3;
const ANCHOR_RE = /\b[\w][\w./-]*\.(?:mjs|js|ts|tsx|py|java|sql|md|ya?ml|json)\b/g;
const ANCHOR_CAP = 8;

function fail(code, reason) {
  return { code, reason };
}

function yamlQuote(v) {
  return `"${String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
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

  const { dir } = ensureStore(workspace, { home, dryRun });
  const origin = repoId(workspace);
  const existing = new Map(listLearnings(dir).map((l) => [l.id, l]));

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
      if (bad) return { applied: [], rejected: [bad], committed: false, exitCode: 1 };
      planned.push({ ...op });
      continue;
    }
    if (!FILE_TOUCHING.has(op.op)) {
      return { applied: [], rejected: [fail('E_SCHEMA', `op ${i}: unknown op ${op.op}`)], committed: false, exitCode: 1 };
    }
    const bad = validateEpisodes(op.episodes, i);
    if (bad) return { applied: [], rejected: [bad], committed: false, exitCode: 1 };

    if (op.op === 'STRENGTHEN' || op.op === 'SUPERSEDE') {
      if (!op.target || !existing.has(op.target)) {
        return { applied: [], rejected: [fail('E_TARGET', `op ${i}: target ${op.target || '(none)'} does not exist`)], committed: false, exitCode: 1 };
      }
    }

    if (op.op === 'ADD' || op.op === 'SUPERSEDE') {
      if (!op.domain || !op.slug || !op.trigger || !op.body) {
        return { applied: [], rejected: [fail('E_SCHEMA', `op ${i}: ${op.op} needs domain, slug, trigger, body`)], committed: false, exitCode: 1 };
      }
      const secrets = scanSecrets(`${op.trigger}\n${op.body}`);
      if (secrets.length) {
        return { applied: [], rejected: [fail('E_SECRET', `op ${i}: secret-shaped content (${secrets.map((s) => s.id).join(', ')})`)], committed: false, exitCode: 1 };
      }
      const lint = lintImperative(op);
      if (lint) {
        return { applied: [], rejected: [fail('E_LINT', `op ${i}: ${lint}`)], committed: false, exitCode: 1 };
      }
    }

    if (op.op === 'SUPERSEDE') {
      const target = existing.get(op.target);
      if (verifiedFixLinks(target.fm) >= DISPUTED_FIX_THRESHOLD || target.fm.source === 'human') {
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
    // human-teaching evidence land active with source: human — no provisional
    // damping for teachings (design §6). Anything else (including a mix) is
    // the standard auto/provisional lane.
    const source = op.episodes.length && op.episodes.every((e) => e.kind === 'human-teaching') ? 'human' : 'auto';
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
      return {
        applied: [],
        rejected: [fail('E_BYTE_CAP', `${id} exceeds ${LEARNING_BYTE_CAP} bytes — split into two claims`)],
        committed: false,
        exitCode: 1,
      };
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
    for (const { op, id, domain, slug, content } of writes) {
      const file = path.join(dir, 'learnings', domain, `${slug}.md`);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, content, 'utf8');
      applied.push({ op: op.op, id });
      for (const e of op.episodes) ledgerEntries.push({ path: e.path, sha256: e.sha256, learning: id, at });
      if (op.op === 'SUPERSEDE') {
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
  } finally {
    fs.rmdirSync(lockPath);
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
