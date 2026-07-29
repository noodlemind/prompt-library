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
  episodeLines,
  readGovernance,
  appendGovernance,
  serializeLearning,
} from './store.mjs';
import { MAX_OPS_PER_RUN, LEARNING_BYTE_CAP, QUARANTINE_THRESHOLD, DOMAIN_ACTIVE_CAP, isActiveFm } from './consolidate.mjs';
import { scanSecrets } from '../secret-scan.mjs';
import { absorbHandEdits, mirrorLearnings } from './admin.mjs';
import { parseMergedFrom } from './listing.mjs';

/**
 * The SOLE writer of the learnings store. The consolidation skill emits an
 * operations JSON and writes nothing; every contract (op count, byte cap,
 * secret scan, imperative lint, disputed rule) is enforced here — so the
 * anti-collapse guarantees hold even on hosts without hooks.
 */

const FILE_TOUCHING = new Set(['ADD', 'STRENGTHEN', 'SUPERSEDE', 'MERGE']);
const DISPUTED_FIX_THRESHOLD = 3;
// Codes that indicate the CONTENT of a specific op was rejected (bad shape,
// secret-shaped, imperative lint, over the byte cap, a dedup/rename collision
// against an ON-DISK learning, or a missing target) — as opposed to FOUR
// other rejection classes that must NEVER record a strike:
//   - run-level/lock-level rejections (E_MODE, E_DELTA_CONTRACT, E_LOCKED,
//     E_APPLY_FAILED, E_DOMAIN_CAP): say nothing about any one op's
//     episodes. E_DOMAIN_CAP in particular is cap pressure, a run-level
//     resource limit, not a defect in the episodes that produced the op.
//   - composition rejections: an op colliding with a SIBLING op earlier in
//     the SAME run — "target already consumed by an earlier op in this run",
//     "target already strengthened by an earlier op in this run" (both
//     E_TARGET), and "already introduced by an earlier op in this run"
//     (E_EXISTS). These say the op-SET was malformed (two ops raced for the
//     same id/target), not that either op's offered episodes were bad, so
//     the branches producing them return a plain fail(...) below instead of
//     calling rejectOp — they never touch this set despite sharing an
//     E_EXISTS/E_TARGET code with a real, strike-worthy on-disk variant.
//   - promoted-target rejections (promotedTargetRejection, below): a
//     STRENGTHEN/SUPERSEDE/MERGE aimed at a learning already promoted to a
//     primitive. Also E_TARGET, also never routed through rejectOp — the
//     offered episodes aren't defective, the op's CHOICE of target is, so a
//     model repeatedly aiming at a promoted id must never accumulate toward
//     quarantine for it.
//   - inactive-target rejections: a STRENGTHEN/SUPERSEDE aimed at a target
//     already superseded/retired/disputed ON DISK from a PRIOR run (also
//     E_TARGET, also a plain fail, never rejectOp — same reasoning as
//     promoted-target: the op's episodes aren't defective, its choice of a
//     dead target is).
const CONTENT_FAILURE_CODES = new Set(['E_SCHEMA', 'E_SECRET', 'E_LINT', 'E_BYTE_CAP', 'E_EXISTS', 'E_TARGET']);

/**
 * How many file-touches an op counts toward MAX_OPS_PER_RUN. A MERGE writes
 * one new learning AND tombstones every target, so it counts as
 * `1 + targets.length` — a 2-target MERGE is as expensive as 3 plain ADDs.
 */
function opWeight(op) {
  if (op.op === 'MERGE') return 1 + (Array.isArray(op.targets) ? op.targets.length : 0);
  return FILE_TOUCHING.has(op.op) ? 1 : 0;
}

/** A target too well-evidenced or human-taught to demote without a human. */
function isDisputedTargetFm(fm) {
  return verifiedFixLinks(fm) >= DISPUTED_FIX_THRESHOLD || fm.source === 'human';
}

/** Count of active (not superseded/retired/disputed) learnings in a domain. */
function activeCountInDomain(existing, domain) {
  let n = 0;
  for (const l of existing.values()) {
    if (l.domain === domain && isActiveFm(l.fm)) n++;
  }
  return n;
}

/** The normalized `domain/slug` id an ADD/SUPERSEDE/MERGE op would write to. */
function newIdFor(op) {
  return `${normalizeSlug(op.domain)}/${normalizeSlug(op.slug)}`;
}
const ANCHOR_RE = /\b[\w][\w./-]*\.(?:mjs|js|ts|tsx|py|java|sql|md|ya?ml|json)\b/g;
const ANCHOR_CAP = 8;

function fail(code, reason) {
  return { code, reason };
}

/**
 * A promoted learning's behavior now lives in a primitive (design §10) — a
 * STRENGTHEN/SUPERSEDE/MERGE writing over it would let the learning drift
 * from the primitive that superseded it, with nothing to catch the
 * divergence. Rejected unconditionally, both lanes, no human-teaching
 * reteach exemption: a human refining a promoted claim should update the
 * primitive, not resurrect the learning. This is a content-shape rejection
 * (E_TARGET) but deliberately NOT routed through rejectOp/
 * recordContentFailure — the offered episodes aren't defective, the op's
 * choice of target is, so a model repeatedly aiming at a promoted id must
 * never accumulate toward quarantine for it.
 */
function promotedTargetRejection(i, id, promotedTo) {
  return {
    applied: [],
    governed: [],
    rejected: [
      fail(
        'E_TARGET',
        `op ${i}: target ${id} is promoted — behavior supersedes knowledge; update the primitive (${promotedTo}) or choose a new slug`
      ),
    ],
    committed: false,
    exitCode: 1,
  };
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

function renderLearning({ trigger, body, episodes, anchors = [], origin, status, source, supersededBy, mergedFrom, promotedTo }) {
  const lines = [
    '---',
    'schema: 1',
    `trigger: ${yamlQuote(trigger)}`,
    `status: ${status}`,
    `source: ${source}`,
    'episodes:',
    // Shared with store.mjs's serializeLearning (episodeLines) — a pathless
    // episode is dropped and a missing/unrecognized kind defaults to 'fix',
    // so a STRENGTHEN re-render of a store file carrying a pre-existing
    // malformed episode entry (a hand edit, or stale on-disk record) never
    // regresses to emitting a literal `path: undefined` / `kind: undefined`.
    ...episodeLines(episodes),
  ];
  if (anchors.length) {
    lines.push('anchors:');
    for (const a of anchors) lines.push(`  - ${a}`);
  } else {
    lines.push('anchors: []');
  }
  lines.push(`superseded_by: ${supersededBy || 'null'}`);
  lines.push(`last_confirmed: ${todayClamped()}`);
  if (mergedFrom?.length) lines.push(`merged_from: [${mergedFrom.join(', ')}]`);
  if (promotedTo) lines.push(`promoted_to: ${promotedTo}`);
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

export function applyOps({ workspace, opsPath, dryRun = false, home, approve = false, log = () => {} }) {
  // Absorb any hand edit sitting in the store BEFORE anything else — even
  // before the mode gate. The failure path below can `git reset --hard` the
  // store tree; a dirty hand edit caught in that reset would be destroyed
  // along with the partial op-write it's cleaning up, so it must be
  // committed on its own first. Advisory: never blocks the run it guards.
  // Skipped on dryRun — a preview must never leave a real commit behind.
  if (!dryRun) {
    try {
      absorbHandEdits({ workspace, home, log });
    } catch {
      // best effort — a hand-edit absorb failure must never block applyOps.
    }
  }

  // Kill switch: consolidate is a write path gated to mode 'on' — checked
  // first, before the ops file is even parsed, and before the lockfile below.
  // 'suggest' is a conditional exception: it only proceeds when the caller
  // passes approve (set by a human re-running with --yes after reviewing the
  // ops JSON) — every other non-'on' mode rejects regardless of approve.
  const { mode } = readStoreConfig(workspace, { home });
  if (mode !== 'on' && !(mode === 'suggest' && approve)) {
    const reason =
      mode === 'suggest'
        ? 'knowledge mode is suggest — review the ops JSON, then re-run apply with --yes'
        : `knowledge mode is ${mode} — run: harness knowledge on`;
    return {
      applied: [],
      governed: [],
      rejected: [{ code: 'E_MODE', reason }],
      committed: false,
      exitCode: 2,
    };
  }

  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(opsPath, 'utf8'));
  } catch (err) {
    return { applied: [], governed: [], rejected: [fail('E_SCHEMA', `unreadable ops file: ${err.message}`)], committed: false, exitCode: 1 };
  }
  if (parsed.schema !== 1 || !Array.isArray(parsed.ops)) {
    return { applied: [], governed: [], rejected: [fail('E_SCHEMA', 'ops file must be { schema: 1, ops: [...] }')], committed: false, exitCode: 1 };
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
    // Dedupe by path@sha256 before recording: an op citing the same episode
    // twice (a malformed or duplicated op JSON, not two distinct pieces of
    // evidence) must record ONE strike per run, not one per reference — a
    // duplicate reference would otherwise double-count toward the 3-strike
    // quarantine threshold within a single run.
    const seenKeys = new Set();
    const eps = (episodes || [])
      .filter((e) => e && e.path && /^[0-9a-f]{64}$/.test(e.sha256 || ''))
      .filter((e) => {
        const key = `${e.path}@${e.sha256}`;
        if (seenKeys.has(key)) return false;
        seenKeys.add(key);
        return true;
      });
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
    return { applied: [], governed: [], rejected: [fail(code, reason)], committed: false, exitCode: 1 };
  }

  const fileTouchCount = parsed.ops.reduce((n, o) => n + opWeight(o), 0);
  if (fileTouchCount > MAX_OPS_PER_RUN) {
    return {
      applied: [],
      governed: [],
      rejected: [fail('E_DELTA_CONTRACT', `run touches ${fileTouchCount} files — max ${MAX_OPS_PER_RUN} (anti-collapse contract)`)],
      committed: false,
      exitCode: 1,
    };
  }

  // Running per-domain active-count projection for the cap check below.
  // Seeded lazily from the on-disk snapshot the first time a domain is
  // touched, then updated AS ops are planned, IN FILE ORDER — this is what
  // makes a multi-op run (e.g. three same-domain ADDs) stack correctly
  // against the cap: each op's check sees every earlier op's effect in this
  // same run, not just the pre-run snapshot (a per-op check against the
  // static snapshot alone would let N ops each pass a test that's true
  // individually but false collectively).
  const domainProjection = new Map();
  function projectedActive(domain) {
    if (!domainProjection.has(domain)) {
      domainProjection.set(domain, activeCountInDomain(existing, domain));
    }
    return domainProjection.get(domain);
  }
  function bumpProjectedActive(domain, delta) {
    domainProjection.set(domain, projectedActive(domain) + delta);
  }

  // Same-run consumption tracking. Validation otherwise only ever reads the
  // static `existing` snapshot taken before the loop started, so without
  // this a later op could target a learning an EARLIER op in this same run
  // already tombstoned (silently orphaning it, double-crediting the domain
  // projection) or introduce the exact id an earlier op already claimed
  // (silently clobbering it at write time, since both would resolve to the
  // same file path).
  const consumedTargets = new Set(); // SUPERSEDE/MERGE targets already spoken for this run
  // STRENGTHEN targets already spoken for this run, tracked SEPARATELY from
  // consumedTargets: a STRENGTHEN doesn't tombstone its target (it's still
  // the same live learning afterward), so a later STRENGTHEN on the same
  // target is not itself a conflict — only a later SUPERSEDE/MERGE reusing a
  // strengthened target is, since applyOps runs every SUPERSEDE/MERGE/ADD
  // write (first loop) BEFORE any STRENGTHEN executes (second loop below),
  // so without this a same-run STRENGTHEN-before-SUPERSEDE would still let
  // the SUPERSEDE's write land first and the STRENGTHEN would then apply the
  // OLD claim's evidence onto the just-tombstoned file — non-corrupting but
  // incoherent, since that evidence was meant for the claim the SUPERSEDE
  // just replaced.
  const strengthenedTargets = new Set();
  const plannedIds = new Set(); // new ids (ADD/SUPERSEDE-rename/MERGE) already claimed this run
  function idTaken(id) {
    return existing.has(id) || plannedIds.has(id);
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
      // Checked before the consumed-target check and before any of
      // SUPERSEDE's own reteach/dispute logic further below — a promoted
      // target is rejected unconditionally, never conditionally exempted.
      const promotedTo = existing.get(op.target).fm.promoted_to;
      if (promotedTo) {
        return promotedTargetRejection(i, op.target, promotedTo);
      }
      // Cross-run target-activeness (MERGE already required this — see the
      // isActiveFm check in its own branch below): a target already
      // superseded/retired/disputed ON DISK from a PRIOR run must never
      // accept a fresh STRENGTHEN/SUPERSEDE — that would let a model silently
      // resurrect or overwrite a demoted learning without a human's
      // dispute -> confirm round trip. Composition-class plain fail (like the
      // consumedTargets/strengthenedTargets checks below) — an inactive
      // target is not a defect in this op's own episodes, so no strike.
      if (!isActiveFm(existing.get(op.target).fm)) {
        return {
          applied: [],
          governed: [],
          rejected: [
            fail('E_TARGET', `op ${i}: target ${op.target} is not active — SUPERSEDE an active learning or choose a new slug`),
          ],
          committed: false,
          exitCode: 1,
        };
      }
      if (consumedTargets.has(op.target)) {
        // Composition rejection (sibling op raced for this target this same
        // run) — plain fail, never a strike against this op's episodes.
        return {
          applied: [],
          governed: [],
          rejected: [fail('E_TARGET', `op ${i}: target ${op.target} already consumed by an earlier op in this run`)],
          committed: false,
          exitCode: 1,
        };
      }
      // A SUPERSEDE reusing a target an earlier STRENGTHEN in this same run
      // already claimed: composition rejection, same reasoning as the
      // consumedTargets check above — plain fail, never a strike. STRENGTHEN
      // itself is exempt (a later STRENGTHEN on its own earlier target is not
      // a conflict — see strengthenedTargets' declaration above).
      if (op.op === 'SUPERSEDE' && strengthenedTargets.has(op.target)) {
        return {
          applied: [],
          governed: [],
          rejected: [
            fail('E_TARGET', `op ${i}: target ${op.target} already strengthened by an earlier op in this run — combine into one op`),
          ],
          committed: false,
          exitCode: 1,
        };
      }
    }

    if (op.op === 'STRENGTHEN') {
      strengthenedTargets.add(op.target);
    }

    if (op.op === 'MERGE') {
      if (!Array.isArray(op.targets) || op.targets.length < 2) {
        return rejectOp('E_SCHEMA', `op ${i}: MERGE needs targets (>= 2 existing active learning ids)`, op.episodes);
      }
      for (const t of op.targets) {
        if (!existing.has(t)) {
          return rejectOp('E_TARGET', `op ${i}: target ${t} does not exist`, op.episodes);
        }
      }
      for (const t of op.targets) {
        const promotedTo = existing.get(t).fm.promoted_to;
        if (promotedTo) {
          return promotedTargetRejection(i, t, promotedTo);
        }
      }
      for (const t of op.targets) {
        if (consumedTargets.has(t)) {
          // Composition rejection (sibling op raced for this target this
          // same run) — plain fail, never a strike against this op's episodes.
          return {
            applied: [],
            governed: [],
            rejected: [fail('E_TARGET', `op ${i}: target ${t} already consumed by an earlier op in this run`)],
            committed: false,
            exitCode: 1,
          };
        }
        // A MERGE reusing a target an earlier STRENGTHEN this same run
        // already claimed — same composition reasoning as the consumedTargets
        // check above.
        if (strengthenedTargets.has(t)) {
          return {
            applied: [],
            governed: [],
            rejected: [
              fail('E_TARGET', `op ${i}: target ${t} already strengthened by an earlier op in this run — combine into one op`),
            ],
            committed: false,
            exitCode: 1,
          };
        }
      }
      for (const t of op.targets) {
        if (!isActiveFm(existing.get(t).fm)) {
          return rejectOp('E_TARGET', `op ${i}: target ${t} is not active (already superseded/retired/disputed)`, op.episodes);
        }
      }
    }

    if (op.op === 'ADD' || op.op === 'SUPERSEDE' || op.op === 'MERGE') {
      if (!op.domain || !op.slug || !op.trigger || !op.body) {
        return rejectOp('E_SCHEMA', `op ${i}: ${op.op} needs domain, slug, trigger, body`, op.episodes);
      }
      const newId = newIdFor(op);
      if (op.op === 'ADD') {
        // Dedup-miss protection: an ADD whose id already exists — on disk OR
        // already claimed by an EARLIER op in this same run — must never
        // silently overwrite that learning (or that other op's write, once
        // both would resolve to the same file path) — reject the whole run
        // and route the caller to STRENGTHEN (more evidence) or SUPERSEDE
        // (replace the claim) instead.
        if (idTaken(newId)) {
          if (existing.has(newId)) {
            // Real on-disk dedup miss — a content-failure strike is warranted.
            return rejectOp(
              'E_EXISTS',
              `op ${i}: ${newId} already exists — use STRENGTHEN (more evidence) or SUPERSEDE (replace the claim)`,
              op.episodes
            );
          }
          // Composition rejection (a sibling op already claimed this id this
          // same run) — plain fail, never a strike against this op's episodes.
          return {
            applied: [],
            governed: [],
            rejected: [fail('E_EXISTS', `op ${i}: ${newId} was already introduced by an earlier op in this run`)],
            committed: false,
            exitCode: 1,
          };
        }
        // Domain write cap (design §9): an ADD into a domain already at
        // DOMAIN_ACTIVE_CAP active learnings is a plain run-level rejection,
        // never a content-failure strike — cap pressure is not an episode
        // defect. Checked against the RUNNING projection (not a static
        // snapshot) so earlier same-run ADD/SUPERSEDE/MERGE ops in this same
        // domain are already reflected.
        const domain = normalizeSlug(op.domain);
        if (projectedActive(domain) >= DOMAIN_ACTIVE_CAP) {
          return {
            applied: [],
            governed: [],
            rejected: [
              fail('E_DOMAIN_CAP', `domain ${domain} at cap (${DOMAIN_ACTIVE_CAP} active) — MERGE existing learnings or retire first`),
            ],
            committed: false,
            exitCode: 1,
          };
        }
        bumpProjectedActive(domain, 1);
        plannedIds.add(newId);
      }
      if (op.op === 'MERGE' && idTaken(newId)) {
        if (existing.has(newId)) {
          // Real on-disk dedup miss — a content-failure strike is warranted.
          return rejectOp(
            'E_EXISTS',
            `op ${i}: ${newId} already exists — merging onto an existing id is not supported, SUPERSEDE it as a target instead`,
            op.episodes
          );
        }
        // Composition rejection (a sibling op already claimed this id this
        // same run) — plain fail, never a strike against this op's episodes.
        return {
          applied: [],
          governed: [],
          rejected: [fail('E_EXISTS', `op ${i}: ${newId} was already introduced by an earlier op in this run`)],
          committed: false,
          exitCode: 1,
        };
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

    if (op.op === 'MERGE') {
      const disputedTargets = op.targets.filter((t) => isDisputedTargetFm(existing.get(t).fm));
      if (disputedTargets.length) {
        // Demotion of well-evidenced or human-taught knowledge gets a human
        // reviewer: the whole MERGE is rejected (no new file written) and
        // each offending target is marked disputed — untouched targets stay
        // exactly as they were, same one-op granularity as SUPERSEDE.
        for (const t of disputedTargets) disputes.push({ index: i, target: t });
        continue;
      }

      // MERGE is exempt from the cap check ONLY as a NET effect: its own
      // targets' removal is credited to the running projection FIRST — if
      // every target lives in the destination domain, that removal always
      // outweighs the merge's own +1 and the check below never trips. But
      // when a target lives in a DIFFERENT domain than the destination (or
      // an earlier op in this same run already used up the room the targets
      // would have freed), the destination domain gets a bare, uncredited
      // +1 — exactly like an ADD — so it has to pass the same cap check.
      for (const t of op.targets) {
        bumpProjectedActive(existing.get(t).domain, -1);
      }
      const domain = normalizeSlug(op.domain);
      if (projectedActive(domain) >= DOMAIN_ACTIVE_CAP) {
        return {
          applied: [],
          governed: [],
          rejected: [
            fail('E_DOMAIN_CAP', `domain ${domain} at cap (${DOMAIN_ACTIVE_CAP} active) — MERGE existing learnings or retire first`),
          ],
          committed: false,
          exitCode: 1,
        };
      }
      bumpProjectedActive(domain, 1);
      plannedIds.add(newIdFor(op));
      for (const t of op.targets) consumedTargets.add(t);
    }

    if (op.op === 'SUPERSEDE') {
      const target = existing.get(op.target);
      const newId = newIdFor(op);

      // Rename-collision guard: a SUPERSEDE writing to an id that already
      // belongs to a DIFFERENT existing learning — on disk OR already
      // claimed by an earlier op in this run — must never silently clobber
      // it. Only the in-place shape (new id === the op's own target) is
      // allowed to "collide" — that's a replacement, not a collision.
      if (newId !== op.target && idTaken(newId)) {
        if (existing.has(newId)) {
          // Real on-disk dedup miss — a content-failure strike is warranted.
          return rejectOp(
            'E_EXISTS',
            `op ${i}: ${newId} already exists — choose a different slug or SUPERSEDE it directly instead of ${op.target}`,
            op.episodes
          );
        }
        // Composition rejection (a sibling op already claimed this id this
        // same run) — plain fail, never a strike against this op's episodes.
        return {
          applied: [],
          governed: [],
          rejected: [fail('E_EXISTS', `op ${i}: ${newId} was already introduced by an earlier op in this run`)],
          committed: false,
          exitCode: 1,
        };
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
      if (!allHumanTeaching && isDisputedTargetFm(target.fm)) {
        // Demotion of well-evidenced or human-taught knowledge gets a human
        // reviewer: mark disputed, never silently supersede.
        disputes.push({ index: i, target: op.target });
        continue;
      }

      // Domain write cap: only a SUPERSEDE introducing a NEW id can grow a
      // domain's active count — the in-place reteach shape replaces the same
      // file, net zero. This op's OWN tombstone is credited first (against
      // the running projection, so it can always net-zero-replace itself
      // even at exactly the cap), then the new id's domain is checked —
      // against the running projection, so earlier same-run ops already
      // count.
      if (newId !== op.target) {
        bumpProjectedActive(target.domain, -1);
        const domain = normalizeSlug(op.domain);
        if (projectedActive(domain) >= DOMAIN_ACTIVE_CAP) {
          return {
            applied: [],
            governed: [],
            rejected: [
              fail('E_DOMAIN_CAP', `domain ${domain} at cap (${DOMAIN_ACTIVE_CAP} active) — MERGE existing learnings or retire first`),
            ],
            committed: false,
            exitCode: 1,
          };
        }
        bumpProjectedActive(domain, 1);
        plannedIds.add(newId);
      }
      consumedTargets.add(op.target);
    }
    planned.push({ ...op, index: i });
  }

  // Compose ADD/SUPERSEDE/MERGE files and enforce the byte cap before writing.
  const writes = [];
  for (const op of planned) {
    if (op.op !== 'ADD' && op.op !== 'SUPERSEDE' && op.op !== 'MERGE') continue;
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
      mergedFrom: op.op === 'MERGE' ? op.targets : op.merged_from,
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
      // A preview never touches the store, so governance reapplication never
      // runs — always empty, same as every other pre-mutation return below.
      governed: [],
    };
  }

  // Single-writer lock.
  const lockPath = path.join(dir, '.lock');
  try {
    fs.mkdirSync(lockPath);
  } catch {
    return { applied: [], governed: [], rejected: [fail('E_LOCKED', 'another consolidation holds the store lock')], committed: false, exitCode: 1 };
  }

  const applied = [];
  const rejected = [];
  const ledgerEntries = [];
  const governed = [];
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
        // A MERGE tombstones EVERY target it consolidates into the new id —
        // none of them can equal `id` (MERGE always writes a brand-new id).
        if (op.op === 'MERGE') {
          for (const t of op.targets) {
            const target = existing.get(t);
            updateFrontmatterField(target.file, 'superseded_by', id);
          }
        }
      }

      // Governance reapplication (Milestone 4 Task 2): every id the write
      // loop above just (re)wrote — a fresh ADD/SUPERSEDE/MERGE file, never a
      // STRENGTHEN (that only ever touches an EXISTING file) — may already
      // carry a standing human retire/dispute/promote decision from BEFORE a
      // `consolidate --rebuild` wiped the corpus. Reapply it here, inside
      // this same rollback window, so the regenerated learning honors what a
      // human already decided instead of silently reverting to whatever the
      // fresh op claims. `confirm` is deliberately excluded — it is not a
      // demotion to restore, so it never reapplies. EXCEPTION: an op whose
      // EVERY episode verifies as human-teaching (verifyHumanTeachingEpisode)
      // is the human retracting their own earlier call by re-teaching the
      // same trigger/domain — the standing decision is overridden instead of
      // enforced, and a fresh `confirm` record (never overwriting the
      // history, always appended) supersedes it via readGovernance's
      // latest-per-id replay.
      const governance = readGovernance(dir);
      for (const { op, id, domain, slug } of writes) {
        const entry = governance.get(id);
        if (!entry || !['retire', 'dispute', 'promote'].includes(entry.action)) continue;
        const isReteach = op.episodes.length > 0 && op.episodes.every((e) => verifyHumanTeachingEpisode(workspace, e));
        if (isReteach) {
          appendGovernance(dir, { id, action: 'confirm', reason: 'superseded by re-teach', to: null, at });
          continue;
        }
        const file = path.join(dir, 'learnings', domain, `${slug}.md`);
        if (entry.action === 'promote') {
          // promoted_to may be entirely absent from the just-written file —
          // the same parse -> mutate fm -> serializeLearning re-render
          // lifecycle.mjs's own promote branch uses, not
          // updateFrontmatterField's regex-insert.
          const text = fs.readFileSync(file, 'utf8');
          const { fm, body } = parseLearningFrontmatter(text);
          fs.writeFileSync(file, serializeLearning({ ...fm, promoted_to: entry.to }, body), 'utf8');
        } else {
          updateFrontmatterField(file, 'status', entry.action === 'retire' ? 'retired' : 'disputed');
        }
        governed.push({ id, action: entry.action });
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
        governed: [],
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

  // An apply run whose only effect was disputing targets (no ADD/STRENGTHEN/
  // SUPERSEDE/MERGE/NOOP actually applied) must not commit as "noop" — that
  // erases the one real thing this run DID do (mark targets disputed) from
  // the store's own git history. Only reached when applied is genuinely
  // empty — a run that both applies something AND disputes something else
  // still summarizes by what applied.
  const summary = applied.length
    ? applied.map((a) => `${a.op.toLowerCase()}${a.id ? ` ${a.id}` : ''}`).join(' · ')
    : disputes.length
      ? `dispute ${disputes.map((d) => d.target).join(', ')}`
      : 'noop';
  const { committed } = commitStore(dir, `consolidate: ${summary}`);
  try {
    mirrorLearnings({ workspace, home, log });
  } catch {
    // best effort — a mirror failure must never block applyOps.
  }
  return { applied, rejected, committed, exitCode: 0, storeDir: dir, indexPath: path.join(dir, 'INDEX.md'), governed };
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
    // fm.merged_from is the raw bracketed string this same module's
    // renderLearning wrote (`merged_from: [id1, id2]`), parsed back by
    // store.mjs's parseLearningFrontmatter as a literal scalar — never the
    // array renderLearning itself expects. Without unwrapping it here, a
    // STRENGTHEN on a merged learning would pass null through and silently
    // drop its merged_from provenance on every re-render.
    mergedFrom: parseMergedFrom(fm.merged_from),
    // A promoted learning that later gains more evidence must not have its
    // promotion silently erased — STRENGTHEN carries the existing
    // promoted_to (if any) forward, unlike a fresh ADD/SUPERSEDE/MERGE write
    // which never starts out already promoted.
    promotedTo: fm.promoted_to || null,
  });
  fs.writeFileSync(target.file, content, 'utf8');
}

export function rebuildIndex(dir) {
  const active = listLearnings(dir).filter((l) => isActiveFm(l.fm));
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
