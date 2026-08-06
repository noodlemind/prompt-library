import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  ensureStore,
  withStoreTransaction,
  StoreTransactionAbort,
  rollbackStore,
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
  inertLine,
  provenanceLines,
  provenanceBytes,
} from './store.mjs';
import { deriveGitContext, isDetachedKey } from '../git-context.mjs';
import { MAX_OPS_PER_RUN, LEARNING_BYTE_CAP, QUARANTINE_THRESHOLD, DOMAIN_ACTIVE_CAP, isActiveFm, collectEpisodes, splitLedger } from './consolidate.mjs';
import { scanSecrets } from '../secret-scan.mjs';
import { absorbOrAbort, mirrorLearnings } from './admin.mjs';
import { parseMergedFrom } from './listing.mjs';
import { resolveWriteLayer, ensureBucket, migrateRenamedBucket, episodeEligibleForLayer, storeHasBuckets } from './layer.mjs';
import { bucketDirFor, readBucketMeta, bucketAncestryOk, isSafeBucketKey } from './overlay.mjs';
import { readFileNoFollow, assertNoSymlinkAncestors, assertRealpathContained } from '../fs-safe.mjs';

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
//   - inactive-target rejections: a STRENGTHEN/SUPERSEDE/MERGE aimed at a
//     target already superseded/retired/disputed ON DISK from a PRIOR run
//     (also E_TARGET, also a plain fail, never rejectOp — same reasoning as
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
    kind: 'reject',
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
 * Every containment-valid candidate full path for an episode's declared
 * relative path — workspace root FIRST, then (when a copilotHome is given)
 * `copilotHome/knowledge` SECOND. These are the exact same two roots
 * consolidate.mjs's `collectEpisodes` scans (product-repo-private
 * `docs/solutions/` and the global `~/.copilot/knowledge/solutions/`), so a
 * global episode's candidates-emitted path (relative to
 * `copilotHome/knowledge`, e.g. `solutions/perf/team-fix.md`) resolves the
 * same way it was collected from — a model asserting the path verbatim (as
 * instructed) must not have its evidence rejected purely because apply.mjs
 * only ever checked the workspace root. Each root gets its OWN PHYSICAL
 * containment guard (`assertNoSymlinkAncestors`, fs-safe.mjs — the same
 * helper purgeEpisode uses, closing the asymmetry an adversarial review
 * found: a path escaping ONE root lexically (a `../` climb) OR resolving
 * through a symlinked intermediate directory (e.g. `docs/solutions` itself
 * being a symlink — probe A2) is simply excluded from the candidate list for
 * THAT root — it is never allowed to "borrow" containment from the other
 * root. A plain lexical resolve+startsWith check here previously let a
 * symlinked `docs/solutions` verify an OUTSIDE file as genuine episode
 * evidence, since only the leaf was ever checked for being a symlink.
 * Returns an empty array when `p` is falsy or escapes/is unsafe under every
 * configured root. Existence is NOT checked here — callers try each
 * candidate in order (workspace first) and decide what "exists" means for
 * their own read (readFileNoFollow, fs.existsSync, ...). Each candidate
 * carries the `root` it resolved under so the reader can hand that exact root
 * to readFileNoFollow for a canonicalize-after-acquire containment verify —
 * the read must be checked against the SAME root the candidate came from.
 */
function resolveEpisodeFile(workspace, copilotHome, p) {
  if (!p) return [];
  const roots = [path.resolve(workspace)];
  if (copilotHome) roots.push(path.resolve(copilotHome, 'knowledge'));
  const candidates = [];
  for (const root of roots) {
    const full = assertNoSymlinkAncestors(root, p);
    if (full) candidates.push({ full, root });
  }
  return candidates;
}

/** The first candidate (workspace root first, then the global root) that
 * actually exists on disk — as a `{ full, root }` pair so the caller can
 * containment-verify the read against the matched root — or null if the path
 * escapes every root or exists in none of them. */
function firstExistingEpisodeFile(workspace, copilotHome, p) {
  for (const { full, root } of resolveEpisodeFile(workspace, copilotHome, p)) {
    if (fs.existsSync(full)) return { full, root };
  }
  return null;
}

/**
 * Deterministic anchor extraction: for every episode whose own file exists
 * under the workspace OR the global knowledge root, scan its text for
 * repo-relative paths and keep the ones that resolve to real WORKSPACE files
 * — excluding the episode's own path so a doc doesn't anchor itself. A
 * global episode's evidence can still anchor a learning to product code (the
 * outer read tries both roots), but the anchor TARGETS extracted from its
 * text are always resolved against the workspace only: an anchor is a
 * pointer into the product repo an agent can go read, never into another
 * machine's `~/.copilot`, so scanning a global episode's text for workspace
 * files is still workspace-anchored, not two-rooted. Dedupe, sort, cap at 8
 * (module-private; only `renderLearning` writes the result).
 */
function extractAnchors({ workspace, copilotHome, episodes }) {
  const found = new Set();
  const root = path.resolve(workspace);
  // Containment guard (same root/startsWith idiom this module uses
  // elsewhere, e.g. verifyEpisodeKind) — workspace-only, deliberately: see
  // the doc comment above on why anchor TARGETS never cross into the global
  // root even when the episode itself does.
  const containsWorkspace = (rel) => {
    const full = path.resolve(root, rel);
    return full === root || full.startsWith(root + path.sep) ? full : null;
  };
  for (const e of episodes || []) {
    if (!e.path) continue;
    const hit = firstExistingEpisodeFile(workspace, copilotHome, e.path);
    if (!hit) continue;
    // Never follow a symlinked episode file — its target's content must
    // never be scanned for anchor text either. `root: hit.root` runs the
    // canonicalize-after-acquire containment verify against the matched root.
    const text = readFileNoFollow(hit.full, { root: hit.root });
    if (text === null) continue;
    const matches = text.match(ANCHOR_RE) || [];
    for (const m of matches) {
      if (m === e.path) continue;
      const mFull = containsWorkspace(m);
      if (!mFull || !fs.existsSync(mFull)) continue;
      found.add(m);
    }
  }
  return [...found].sort().slice(0, ANCHOR_CAP);
}

function renderLearning({
  trigger,
  body,
  episodes,
  anchors = [],
  origin,
  status,
  source,
  supersededBy,
  mergedFrom,
  promotedTo,
  promotedToGolden,
  provenance,
}) {
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
  // Same field, same position, same optionality as serializeLearning
  // (store.mjs). Without it here, ANY re-render through this function silently
  // dropped the branch→golden tombstone — the STRENGTHEN path re-rendered a
  // promoted bucket entry back into an ACTIVE claim that shadowed the golden
  // claim it had become, was re-offered by `knowledge promote`, and stopped
  // matching `prune --merged`'s fullyPromoted() check.
  if (promotedToGolden) lines.push(`promoted_to_golden: ${promotedToGolden}`);
  lines.push(`origin: ${origin}`);
  // Git provenance (blueprint P1/P9) — same shared rendering serializeLearning
  // (store.mjs) uses, so a fresh write and a round-trip re-render emit
  // byte-identical provenance lines. Optional: absent fields render nothing.
  lines.push(...provenanceLines(provenance || {}));
  lines.push('---', '', body.trim(), '');
  return lines.join('\n');
}

// PRIMARY injection control — command CONTENT, matched by invocation SHAPE, not
// by dialect name or fence label. A curated learning is read verbatim into the
// orient pack a model acts on, so a body carrying an executable command is a
// prompt-injection surface no matter what fence (or none) wraps it. Applied to
// trigger+body of EVERY learning regardless of episode kind. Each pattern
// targets an invocation shape, never a prose mention — "use rm carefully",
// "never eval untrusted input", "the powershell script handles retries" do not
// match, but the executable forms do. This is the durable half: new fence
// labels can't route around a `| sh` or `curl … | bash` payload.
const COMMAND_CONTENT_PATTERNS = [
  [/\b(curl|wget)\s/i, 'download command (curl/wget)'],
  // Pipe INTO a shell interpreter — the classic `curl … | sh`. Negative
  // lookahead for a trailing `|` so a markdown table cell (`| sh |`) is not
  // mistaken for a pipeline; a real pipe-to-shell never has a following pipe.
  [/\|\s*(sh|bash|zsh|ksh|csh|dash|ash|pwsh|powershell)\b(?!\s*\|)/i, 'pipe-to-shell'],
  [/\bsudo\s/i, 'sudo invocation'],
  [/\brm\s+-[a-z]*[rf]/i, 'rm -rf / -f'],
  [/\bchmod\s+(\+[rwxa]+|[0-7]{3,4})\b/i, 'chmod +x / octal'],
  [/\b(bash|sh|zsh|ksh)\s+-c\b/i, 'shell -c invocation'],
  // Interpreter inline-exec shapes (P1#2b) — a language runtime handed code to
  // run on the command line (`node -e "process.exit(1)"`, `python -c ...`).
  // BEST-EFFORT defense-in-depth, never a completeness claim: each requires
  // the exec flag as invocation syntax, so a prose mention of "node"/"python"
  // never matches. `<interp> -e|--eval` for the JS runtimes; `<interp> -c|-e`
  // for the -c/-e family (python/perl/ruby/php).
  [/\b(?:node|deno|bun)\s+(?:--eval\b|-e\b)/i, 'node -e / --eval'],
  [/\b(?:python3?|perl|ruby|php)\s+-[ce]\b/i, 'interpreter -c/-e exec'],
  // cmd /c (and cmd.exe /c) — the Windows shell handed an inline command.
  [/\bcmd(?:\.exe)?\s+\/c\b/i, 'cmd /c invocation'],
  // eval as an INVOCATION (followed by a quote/paren/dollar/backtick), never
  // the bare word — so "never eval untrusted input" prose is not rejected.
  [/\beval\s*[("'`$]/i, 'eval invocation'],
  [/\b(iex|Invoke-Expression)\b/i, 'PowerShell Invoke-Expression'],
];

// DEFENSE-IN-DEPTH — a fenced code block in a language that renders as an
// executable snippet to a model. Backtick AND tilde fences, an optional space
// before the info string, and ANY indentation (CommonMark treats a ≥4-space
// indent as a code block rather than a fence, but such a fence still reads as
// executable to a model, so this security check matches at any indent). The
// dialect list is deliberately broad; the CONTENT patterns above are the real
// guarantee, this only catches an empty-but-labeled or otherwise content-light
// fenced block.
const SHELL_FENCE_PATTERN =
  /(^|\n)[ \t]*(`{3,}|~{3,})[ \t]*(sh|bash|shell|zsh|fish|ksh|csh|dash|ash|sh-session|shell-session|shellsession|console|terminal|powershell|pwsh|ps|ps1|cmd|bat|batch|dos)\b/i;

function lintImperative({ body, trigger, episodes }) {
  const text = `${trigger}\n${body}`;
  for (const [re, label] of COMMAND_CONTENT_PATTERNS) {
    if (re.test(text)) return `executable command content (${label}) in learning`;
  }
  if (SHELL_FENCE_PATTERN.test(text)) return 'shell command fence in learning';
  // BARE-URL check stays insight-gated: a fix learning legitimately citing a
  // doc URL must not be rejected, but an insight-only claim has no verified
  // evidence — the advisory fence is a labeling choice, not the injection
  // control, so a bare URL in an insight-only learning stays disallowed here.
  const allInsight = episodes.length > 0 && episodes.every((e) => e.kind === 'insight');
  if (allInsight && /https?:\/\//i.test(text)) return 'bare URL in insight-only learning';
  return null;
}

// C0 control chars (0x00-0x1F) plus DEL (0x7F) — the same set `inertLine`
// (store.mjs) collapses at render time. Admission rejects them outright
// rather than silently sanitizing, so a rejected op gets a clear E_SCHEMA
// instead of the model discovering its trigger/plan was silently mangled.
const CONTROL_CHAR_RE = /[\x00-\x1f\x7f]/;

/**
 * Episode `plan` values feed promotion eligibility (consolidate.mjs's
 * verifiedAndPlans: a distinct-plans count) as pure assertions — nothing on
 * the read path verifies a `plan` points at a real plan file; it remains an
 * assertion feeding only human-gated displays (`harness learnings --why`,
 * `consolidate --status`), never an automated decision on its own (P1-1,
 * documented in docs/MEMORY-MODEL.md). Still admitted with a shape check:
 * when present, must be a short, single-line, workspace-relative-LOOKING
 * string — never a vehicle for a control-char injection (inertLine's doc
 * comment covers the render-side half of that same defense) or a `..`
 * traversal segment that could mislead a human reading it later. Absent,
 * null, or empty is fine — `plan` is optional.
 */
function validPlanField(plan) {
  if (plan === undefined || plan === null || plan === '') return true;
  if (typeof plan !== 'string') return false;
  if (plan.length > 200) return false;
  if (CONTROL_CHAR_RE.test(plan)) return false;
  if (path.isAbsolute(plan)) return false;
  if (plan.split(/[\\/]+/).some((seg) => seg === '..')) return false;
  return true;
}

function validateEpisodes(episodes, opIndex) {
  if (!Array.isArray(episodes) || !episodes.length) {
    return fail('E_SCHEMA', `op ${opIndex}: episodes must be a non-empty array`);
  }
  // One link per episode. An op listing the SAME `path@sha256` more than once
  // is not two pieces of evidence — but every count downstream reads the
  // rendered `episodes:` block as a flat list, so a duplicate inflates
  // `verifiedFixLinks` (the protected/disputed-target threshold) and
  // `verifiedAndPlans` (promotion eligibility) from a single episode file.
  // Rejected at admission rather than silently deduped, so the op-set's author
  // learns its evidence was double-counted instead of the store quietly
  // disagreeing with the ops JSON.
  const seenEpisodeKeys = new Set();
  for (const e of episodes) {
    if (
      !e ||
      typeof e !== 'object' ||
      typeof e.path !== 'string' ||
      !e.path ||
      typeof e.sha256 !== 'string' ||
      !/^[0-9a-f]{64}$/.test(e.sha256)
    ) {
      return fail('E_SCHEMA', `op ${opIndex}: each episode needs path + sha256`);
    }
    const key = `${e.path}@${e.sha256}`;
    if (seenEpisodeKeys.has(key)) {
      return fail('E_SCHEMA', `op ${opIndex}: episode ${e.path} is listed more than once — one link per episode`);
    }
    seenEpisodeKeys.add(key);
    if (!validPlanField(e.plan)) {
      return fail(
        'E_SCHEMA',
        `op ${opIndex}: episode plan must be a short (<=200 char), single-line, workspace-relative path with no ".." segments`
      );
    }
  }
  return null;
}

function verifiedFixLinks(fm) {
  return (fm.episodes || []).filter((e) => e.kind === 'fix').length;
}

/**
 * Verify an asserted episode kind against disk. Used for: the SUPERSEDE
 * disputed-demotion exemption and `source`/`status` derivation on ADD/
 * SUPERSEDE writes (human-teaching assertions), and — closing the symmetric
 * gap — admission of every `fix`/`insight`-kind episode an ADD/STRENGTHEN/
 * SUPERSEDE/MERGE op offers, before its kind is ever trusted downstream by
 * `gainedFix` (composeStrengthenedLearning), `verifiedFixLinks`, or promotion math
 * (consolidate.mjs's verifiedAndPlans). In every case the op JSON's
 * `episodes[].kind` field is just an assertion (model- or human-authored
 * text nothing else validates) — trusting it lets anyone claim evidence for
 * a fix that was never actually verified, or human-teaching for an episode
 * never taught by a human. An episode verifies when: its path resolves
 * inside the workspace (no `../` escape), its file exists there, the file's
 * CURRENT content hashes to the asserted sha256 (not stale/edited since),
 * and the file's OWN frontmatter agrees with the asserted category:
 *   - `human-teaching` / `insight` assertions require the file's own
 *     frontmatter `kind` to literally match — an elevated-standing claim
 *     proves nothing on its own.
 *   - `fix` (or an omitted kind — the same default every serializer uses)
 *     only requires the file NOT to be impersonating one of the elevated
 *     kinds — no frontmatter, or any kind other than insight/human-teaching,
 *     is a legitimate fix episode.
 * Resolved against BOTH knowledge roots (resolveEpisodeFile) — workspace
 * first, then `copilotHome/knowledge` — since `collectEpisodes` proposes
 * candidates from either one and the consolidation skill copies the offered
 * path/sha256 verbatim; a global-root episode must verify exactly as
 * readily as a workspace one. Succeeds if EITHER root fully verifies (exists
 * + sha256 match + kind agreement). Fails closed (false) only when every
 * candidate fails — never throws.
 */
function verifyEpisodeKind(workspace, copilotHome, e) {
  if (!e || !e.path || !e.sha256) return false;
  for (const { full, root } of resolveEpisodeFile(workspace, copilotHome, e.path)) {
    // Never follow a symlinked candidate — a symlink's target content must
    // never verify (or hash-match) as this episode's evidence. `root` runs the
    // canonicalize-after-acquire containment verify against the matched root.
    const text = readFileNoFollow(full, { root });
    if (text === null) continue;
    if (crypto.createHash('sha256').update(text).digest('hex') !== e.sha256) continue;
    const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    const kindLine = m ? m[1].split('\n').find((l) => /^kind:\s*/.test(l)) : null;
    const fileKind = kindLine ? kindLine.replace(/^kind:\s*/, '').replace(/^["']|["']$/g, '').trim() : null;
    const asserted = e.kind === 'insight' ? 'insight' : e.kind === 'human-teaching' ? 'human-teaching' : 'fix';
    const kindOk = asserted === 'fix' ? fileKind !== 'insight' && fileKind !== 'human-teaching' : fileKind === asserted;
    if (kindOk) return true;
  }
  return false;
}

/** Thin wrapper over verifyEpisodeKind: true only when the episode BOTH
 * asserts AND disk-verifies human-teaching — every existing call site
 * (the SUPERSEDE re-teach exemption, source/status derivation) needs this
 * specific question answered, not "does this episode verify as whatever it
 * claims", so a non-human-teaching assertion still short-circuits to false
 * without touching disk. */
function verifyHumanTeachingEpisode(workspace, copilotHome, e) {
  return Boolean(e) && e.kind === 'human-teaching' && verifyEpisodeKind(workspace, copilotHome, e);
}

/**
 * Admission-time evidence check (op validation, before anything is written):
 * EVERY episode an op offers — `fix`-kind (or kind-omitted, defaulting to
 * fix), `insight`-kind, AND `human-teaching`-kind — must verify against disk
 * via verifyEpisodeKind (tried against both the workspace and, when given,
 * the global copilotHome knowledge root): contained path, file exists,
 * current content hashes to the asserted sha256, and the file's own
 * frontmatter kind agrees with the asserted kind. A mismatch or
 * nonexistent-in-either-root file is an evidence defect (content-failure
 * class, routed through rejectOp so it strikes toward quarantine like any
 * other malformed episode). Evidence EXISTENCE is deliberately universal:
 * `human-teaching` used to be exempt here (its disk check ran only where
 * elevated standing was granted, with a tolerant fallback), but that let a
 * fabricated human-teaching assertion — a nonexistent file, or a real
 * insight file relabeled — admit a learning that bypassed the insight-only
 * imperative lint and rendered without the advisory fence. The ONLY
 * human-teaching-specific bypass that survives is `humanPresent`'s
 * governance-RECENCY bypass (overridesGovernanceRecency): the live human
 * acting now outranks a stored decision's timestamp, but never the
 * requirement that cited evidence actually exists on disk. The legitimate
 * `remember` lane is unaffected — runInsightCompound writes the
 * human-teaching episode to disk BEFORE applyOps runs, so it verifies here
 * like any other genuine episode.
 */
function verifyAdmittedEpisodeKinds(workspace, copilotHome, episodes, opIndex) {
  for (const e of episodes) {
    if (!verifyEpisodeKind(workspace, copilotHome, e)) {
      const asserted = e.kind === 'insight' ? 'insight' : e.kind === 'human-teaching' ? 'human-teaching' : 'fix';
      return fail(
        'E_SCHEMA',
        `op ${opIndex}: episode ${e.path} does not verify as kind ${asserted} — file missing, sha256 mismatch, or its own frontmatter kind disagrees`
      );
    }
  }
  return null;
}

/**
 * Disk-verify an episode by EXISTENCE + sha256 only, ignoring kind — the
 * NOOP admission check (P1#3). A NOOP writes no learning, so an asserted kind
 * is moot, but it still CONSUMES the episode (a `learning: null` ledger entry
 * that clears the episode's consolidation debt), so it must never be able to
 * clear debt for a fabricated or mislabeled file. Tried against both
 * knowledge roots (resolveEpisodeFile) and never follows a symlinked
 * candidate — true only when some contained candidate exists and its CURRENT
 * content hashes to the asserted sha256. Fails closed (false); never throws.
 */
function episodeShaVerifies(workspace, copilotHome, e) {
  if (!e || !e.path || !e.sha256) return false;
  for (const { full, root } of resolveEpisodeFile(workspace, copilotHome, e.path)) {
    const text = readFileNoFollow(full, { root });
    if (text === null) continue;
    if (crypto.createHash('sha256').update(text).digest('hex') === e.sha256) return true;
  }
  return false;
}

function verifyNoopEpisodes(workspace, copilotHome, episodes, opIndex) {
  for (const e of episodes) {
    if (!episodeShaVerifies(workspace, copilotHome, e)) {
      return fail(
        'E_SCHEMA',
        `op ${opIndex}: NOOP episode ${e.path} does not exist on disk or its sha256 does not match — cannot clear debt for a fabricated or edited episode`
      );
    }
  }
  return null;
}

/**
 * The `date` recorded in an episode's OWN frontmatter — read the same way
 * `collectEpisodes` (consolidate.mjs) derives it (`fm.date`), from the
 * episode file's CURRENT on-disk content, never from anything the op JSON
 * asserts (an op's episode entries carry no date field of their own). Used
 * only by the recency gate below. Same two-root resolution and fail-closed
 * shape as verifyEpisodeKind (null when every candidate — workspace then
 * copilotHome/knowledge — is escaping/missing/unreadable/unparsable) — a
 * shared reader isn't worth factoring out for two short, independently-
 * failing checks.
 */
function episodeDate(workspace, copilotHome, e) {
  if (!e.path) return null;
  for (const { full, root } of resolveEpisodeFile(workspace, copilotHome, e.path)) {
    // Never follow a symlinked candidate here either — same reasoning as
    // verifyEpisodeKind above; `root` runs the containment verify.
    const text = readFileNoFollow(full, { root });
    if (text === null) continue;
    const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (!m) continue;
    const dateLine = m[1].split('\n').find((l) => /^date:\s*/.test(l));
    const date = dateLine ? dateLine.replace(/^date:\s*/, '').replace(/^["']|["']$/g, '').trim() : null;
    if (date) return date;
  }
  return null;
}

/**
 * Recency gate on the human re-teach override (design correction, M4 whole-
 * milestone review, item 1; tightened again, P1-9): verifying an episode is
 * human-teaching proves AUTHENTICITY, never RECENCY — without this, a STALE
 * human-teaching episode (e.g. a `remember` from before a LATER
 * `learning retire`/`dispute`/`promote`) could resurrect a newer human
 * governance decision on the same id, including fabricating a `confirm`
 * record that makes it look like the human re-affirmed something they never
 * saw. Applied ONLY when a governance record exists for the id — nothing
 * stale to guard against otherwise, so an id with no standing decision is
 * unaffected.
 *
 * Two lanes, deliberately different:
 *   - LIVE human lane (`humanPresent: true`, set only by `runRemember` —
 *     remember.mjs): bypasses this gate ENTIRELY, same trust plane as
 *     `approve`. The human acting right now IS the authority; there is
 *     nothing to prove recent against — they are the live source of the
 *     decision. This does NOT touch the promoted-target block, which stays
 *     absolute regardless (checked unconditionally, before any reteach logic
 *     ever runs).
 *   - MODEL lane (an unattended `consolidate --apply` — a model copying a
 *     candidates-packet episode verbatim, or a human running the CLI
 *     directly against an ops JSON): episode `date` is day-granular
 *     (YYYY-MM-DD, an episode file's own frontmatter), but a governance
 *     record's `at` is now a full ISO-8601 timestamp (see
 *     lifecycle.mjs/apply.mjs/admin.mjs's appendGovernance call sites) — a
 *     day-granular episode can prove it happened on a LATER calendar day
 *     than the record, but can never prove it happened later WITHIN the same
 *     day the record was written (readGovernance also tolerates a legacy
 *     plain-date `at`, in which case the same day-string comparison still
 *     applies). So the model lane requires the episode's day to be STRICTLY
 *     newer than the record's day: `episode day > record day` passes,
 *     `episode day === record day` now FAILS (previously a same-day tie
 *     favored the override — that same-day allowance is what let a
 *     same-day, unattended re-application of stale-but-authentic evidence
 *     silently overturn a same-day veto). An episode with no parseable date
 *     fails closed either way — never counts as recent enough to override a
 *     recorded human decision.
 */
function overridesGovernanceRecency(workspace, copilotHome, episodes, record, { humanPresent = false } = {}) {
  if (humanPresent) return true;
  if (!record) return true;
  const recordAt = String(record.at ?? '');
  // Fail CLOSED on a malformed/missing/empty timestamp (minor #5,
  // adversarial review): governance.jsonl is a plain file outside applyOps'
  // own write path (see the promote-target reapplication's own re-validation
  // above for the same reasoning) — a corrupted or hand-poisoned entry with
  // `at: ''` (or any value that isn't a recognizable date) must never let the
  // override fire. Without this, `d > recordDay` for an empty recordDay is
  // true for virtually ANY real episode date (an empty string is a lexical
  // prefix of, and therefore "less than", almost every non-empty string) —
  // silently failing OPEN and letting stale evidence override a standing
  // decision the record was supposed to protect. The veto holds instead.
  if (!/^\d{4}-\d{2}-\d{2}/.test(recordAt)) return false;
  const recordDay = recordAt.slice(0, 10);
  return episodes.every((e) => {
    const d = episodeDate(workspace, copilotHome, e);
    return d != null && d > recordDay;
  });
}

export function applyOps({
  workspace,
  opsPath,
  dryRun = false,
  home,
  approve = false,
  log = () => {},
  copilotHome = null,
  // Internal only — set by runRemember (remember.mjs) for the LIVE human
  // lane. Never derived from anything in the ops JSON itself: a model can
  // never grant this to itself by asserting a field.
  humanPresent = false,
  // `--layer golden` override (blueprint P4): explicit, logged, and HUMAN-
  // GATED (see the admission check below). Routing is otherwise always
  // derived from write-time git context, never from a flag.
  layer = null,
}) {
  // Kill switch: consolidate is a write path gated to mode 'on' — checked
  // first, before the ops file is even parsed, and before any lock. This is a
  // cheap, no-lock pre-check (unchanged from before); the real (non-dryRun)
  // mutation path below ALSO re-checks mode fresh, under the lock, closing
  // the window where mode could change between this check and lock
  // acquisition. 'suggest' is a conditional exception: it only proceeds when
  // the caller passes approve (set by a human re-running with --yes after
  // reviewing the ops JSON) — every other non-'on' mode rejects regardless of
  // approve.
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

  // LAYER CONTAINMENT (P2 security finding). "Promotion is the only branch →
  // golden route" is a containment claim, so the one flag that bypasses
  // write-time routing has to sit on the SAME trust plane as every other
  // human-authority path in this module: a live human (`humanPresent`, set
  // only by runRemember) or an explicit human approval (`approve`, set only
  // by `--yes` after a person reviewed the ops JSON). Without this, `--layer
  // golden` was a plain flag any unattended agent could pass to write
  // straight into golden from a feature branch — self-granting exactly the
  // authority the promotion lane exists to gate. `--layer branch` is refused
  // outright rather than silently ignored (which is what it was): branch
  // routing is DERIVED from write-time git context and there is nothing for a
  // flag to override.
  if (layer === 'branch') {
    return {
      applied: [],
      governed: [],
      rejected: [fail('E_LAYER', '--layer branch is not an override — branch routing is derived from write-time git context')],
      committed: false,
      exitCode: 2,
    };
  }
  if (layer === 'golden' && !humanPresent && !approve) {
    return {
      applied: [],
      governed: [],
      rejected: [
        fail(
          'E_LAYER',
          '--layer golden is a human-authority override — review the ops JSON and re-run with --yes, or promote the branch bucket: harness knowledge promote'
        ),
      ],
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

  // PROMOTION LANE (blueprint §5): an op-set emitted by `harness knowledge
  // promote` carries a `promotion` envelope naming the source bucket and a
  // digest binding over the ops array. In this mode: writes land GOLDEN
  // regardless of the current branch; candidacy/kind checks are replaced by
  // re-validation against the sha256s recorded at branch-apply time (never
  // working-tree presence); rejections NEVER record quarantine strikes (a
  // distinct rejection class — the underlying episodes are not defective);
  // and every promoted source is tombstoned `promoted_to_golden` with an
  // `absorb-branch` audit entry (which the governance replay never treats as
  // a standing decision — see readGovernance).
  const promotion =
    parsed.promotion && typeof parsed.promotion === 'object' && !Array.isArray(parsed.promotion) ? parsed.promotion : null;
  const promotionMode = Boolean(promotion);
  if (promotionMode) {
    // ADMISSION GATES ARE RE-DERIVED HERE, NOT INHERITED FROM THE EMITTER
    // (P1). `harness knowledge promote` refuses a path-shaped key, a
    // detached-HEAD bucket, a non-ancestor bucket, and a governed or
    // non-active source — but the ops file it writes is a plain JSON file
    // anyone can hand-author and feed straight to `consolidate --apply`, and
    // the digest is computed over the ops array by whoever wrote it. The SOLE
    // WRITER must enforce every gate the emitter enforces; an emitter-only
    // gate is not a gate. The key-shape check now shares ONE definition with
    // the emitter (isSafeBucketKey, overlay.mjs) instead of a looser local
    // copy that admitted `.`, absolute paths, and Windows drive/ADS shapes.
    if (!isSafeBucketKey(promotion.branchKey)) {
      return {
        applied: [],
        governed: [],
        rejected: [fail('E_SCHEMA', 'promotion envelope needs a plain branchKey — a bucket directory name, never a path')],
        committed: false,
        exitCode: 1,
      };
    }
    if (isDetachedKey(promotion.branchKey)) {
      return {
        applied: [],
        governed: [],
        rejected: [
          fail('E_SCHEMA', `promotion source ${promotion.branchKey} is a detached-HEAD bucket — never promotable (derived from the key shape)`),
        ],
        committed: false,
        exitCode: 1,
      };
    }
    const digest = crypto.createHash('sha256').update(JSON.stringify(parsed.ops)).digest('hex');
    if (digest !== promotion.digest) {
      // Digest binding: a hand-edited promote-ops file must be regenerated,
      // never partially applied. Plain rejection — promotion class, no strike.
      return {
        applied: [],
        governed: [],
        rejected: [fail('E_SCHEMA', 'promotion op-set digest mismatch — regenerate with: harness knowledge promote')],
        committed: false,
        exitCode: 1,
      };
    }
  }
  // Non-object entries (null, a bare string, a number, ...) must never reach
  // an `op.op` deref — checked over the WHOLE array up front, before
  // anything else (including the file-touch-count reduce below, which derefs
  // `op.op` on every entry) ever touches an individual op, so a null entry
  // can never throw instead of failing closed with a controlled E_SCHEMA.
  for (let i = 0; i < parsed.ops.length; i++) {
    const op = parsed.ops[i];
    if (!op || typeof op !== 'object' || Array.isArray(op)) {
      return { applied: [], governed: [], rejected: [fail('E_SCHEMA', `op ${i}: op must be an object`)], committed: false, exitCode: 1 };
    }
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

  const origin = repoId(workspace);

  // ONE GIT SNAPSHOT PER RUN, TAKEN INSIDE THE TRANSACTION (P1). Routing and
  // provenance describe the same thing — the HEAD this write belongs to — so
  // they must come from the SAME read. They used to be TWO separate
  // `deriveGitContext` calls, both taken BEFORE the store lock existed: a
  // checkout landing between them could stamp provenance for branch A while
  // routing the write to branch B's layer, and a checkout landing after both
  // could cache golden routing from the default branch and then write it out
  // from a feature branch — bypassing branch isolation outright. Now
  // `resolveWriteLayer`'s own context IS the provenance source (one read), it
  // is derived under the lock, and `assertHeadUnmoved` below re-validates it
  // at write time and fails closed if HEAD moved mid-transaction.
  //
  // STRENGTHEN re-renders preserve the target's ORIGINAL provenance instead
  // (composeStrengthenedLearning), so a claim's recorded origin never silently
  // migrates to the strengthening commit. All fields optional: a non-git
  // workspace stamps nothing.
  //
  // Routing itself follows blueprint P4: feature branch → bucket, default
  // branch → golden, detached HEAD → non-promotable detached bucket,
  // `--layer golden` explicit override (logged), unresolvable default branch
  // fails closed to branch-local. The orient-recorded branch is advisory;
  // resolveWriteLayer logs a warning when write-time HEAD disagrees.
  let routing = null;
  let writeProvenance = null;
  function deriveRouting() {
    routing = resolveWriteLayer({ workspace, home, layerOverride: layer === 'golden' ? 'golden' : null, log });
    writeProvenance = { commit: routing.context.headSha, branch: routing.context.branch, base: routing.context.baseSha };
  }

  /**
   * Fail-closed write-time re-validation of the snapshot above: a `git
   * checkout` in the workspace between routing derivation and the mutation
   * phase would leave this run writing a claim into a layer that no longer
   * matches the HEAD it stamped. The store lock cannot serialize the
   * WORKSPACE's git operations, so the only safe answer is to notice and
   * abort — never to silently write to the stale layer. Returns a rejection
   * (nothing has been written yet at the point it is called) or null.
   */
  function assertHeadUnmoved() {
    const now = deriveGitContext({ workspace, home });
    const before = routing.context;
    if (now.headSha === before.headSha && now.branch === before.branch && now.detached === before.detached) return null;
    const nameOf = (c) => c.branch || (c.detached ? `detached ${String(c.headSha).slice(0, 12)}` : c.headSha || 'unknown');
    return {
      kind: 'reject',
      applied: [],
      governed: [],
      rejected: [
        fail(
          'E_HEAD_MOVED',
          `workspace HEAD moved mid-transaction (${nameOf(before)} → ${nameOf(now)}) — nothing was written; re-run the apply from a settled checkout`
        ),
      ],
      committed: false,
      exitCode: 1,
    };
  }

  /**
   * Everything from the store-state snapshot through the mutation phase,
   * factored into one function so it can run either:
   *  (a) once, read-only, lock-free, against a non-creating ensureStore
   *      preview snapshot, when dryRun — or
   *  (b) once, inside withStoreTransaction's lock, against a freshly-created/
   *      freshly-read store snapshot, for a real apply.
   * Reading `existing`/`governance` HERE (rather than before any lock
   * existed) is what closes the P1-6 race: a real apply's snapshot is always
   * taken AFTER the lock is held, immediately before validating against it —
   * two concurrent applyOps runs can no longer validate against a stale
   * snapshot and cross-commit. Every early return below is tagged
   * `kind: 'reject'` (a clean, deliberate rejection — never a thrown error)
   * so the caller can tell it apart from a genuine mutation-phase failure,
   * which propagates as a thrown exception instead and lets
   * withStoreTransaction perform the rollback.
   */
  function runOnce({ dir, git, recordCheckpoint = () => {} }) {
    // Layer root: every learning read/write, ledger entry, strike, and INDEX
    // rebuild below is anchored here — the store root for golden, the
    // branch bucket for a routed branch write. Governance stays store-rooted
    // (readGovernance below): the single ledger binds BOTH layers (§4).
    let layerRoot = dir;
    if (promotionMode) {
      // Promotion always lands GOLDEN — that is its entire job — regardless
      // of which branch the CLI happens to run from.
      layerRoot = dir;
    } else if (routing.layer === 'branch' && routing.bucketKey) {
      if (dryRun) {
        // Preview must not materialize a bucket — an absent bucket simply
        // reads as an empty layer.
        layerRoot = bucketDirFor(dir, routing.bucketKey);
      } else {
        // Best-effort rename auto-migration (P7) before creating a fresh
        // bucket: a bucket keyed by this branch's PRE-RENAME name (branch now
        // gone, base still ancestral) is moved to the new key instead of
        // being stranded next to an empty twin.
        migrateRenamedBucket(dir, { workspace, context: routing.context });
        layerRoot = ensureBucket(dir, {
          key: routing.bucketKey,
          branch: routing.context.branch,
          baseSha: routing.context.baseSha,
        });
      }
    }
    const existing = new Map(listLearnings(layerRoot).map((l) => [l.id, l]));

    // Promotion source table: the bucket learnings whose recorded evidence
    // backs each promotion op. listLearnings on a missing bucket returns [].
    const promotionSources = promotionMode
      ? new Map(listLearnings(bucketDirFor(dir, promotion.branchKey)).map((l) => [l.id, l]))
      : null;
    if (promotionMode) {
      // Ancestry gate re-derived at WRITE time from the bucket's OWN meta.json
      // on disk — never from `promotion.meta`, which is emitter-recorded data
      // inside the same hand-authorable ops file. A bucket whose recorded base
      // provably shares no history with HEAD is a force-push name-reuse
      // artifact: excluded from the read overlay, refused by the emitter, and
      // now refused by the writer too. Only a verified `false` refuses; `null`
      // (unverifiable) stays allowed, matching the read path.
      const promotionBucketDir = bucketDirFor(dir, promotion.branchKey);
      if (bucketAncestryOk(workspace, readBucketMeta(promotionBucketDir)) === false) {
        return {
          kind: 'reject',
          applied: [],
          governed: [],
          rejected: [
            fail(
              'E_SCHEMA',
              `promotion source bucket ${promotion.branchKey} has unrelated history — its recorded base is not an ancestor of HEAD (branch-name reuse); prune it instead: harness knowledge prune --branch ${promotion.branchKey}`
            ),
          ],
          committed: false,
          exitCode: 1,
        };
      }
    }

    /**
     * Three-strikes bookkeeping (design §3): a content-failure code raised by a
     * SPECIFIC op records one failure entry per episode of that op — never for
     * codes outside CONTENT_FAILURE_CODES, and never on dryRun or when the
     * store has no git (best effort, mirrors the rest of the store's degraded
     * modes). Episodes without a structurally valid path+sha256 are skipped —
     * there is nothing reliable to key a strike on. On an episode's 3rd
     * accumulated failure, the SAME append also writes the quarantine marker.
     * Never throws: a bookkeeping error must never mask the real rejection.
     *
     * Returns a short note string when the strike's OWN sub-commit fails for
     * a real reason (rejectOp folds it into the original rejection's reason)
     * or null otherwise. A failure here must never surface as the ORIGINAL
     * content rejection's code changing to something else: if the failed
     * strike-commit's dirt were left sitting in the tree, the transaction's
     * own later finalize (withStoreTransaction) would inherit it, retry the
     * commit, likely fail again for the same underlying git reason, and mask
     * the real E_SECRET/E_LINT/etc. behind a generic transaction failure —
     * so a real failure here is rolled back on the spot (the tree is
     * otherwise clean at this point: any absorb sub-commit already landed or
     * aborted the whole transaction before runOnce ever started), keeping
     * the ledger append's own partial write from ever reaching finalize. On
     * SUCCESS, recordCheckpoint() advances the transaction's rollback floor
     * past this strike commit — same reasoning as absorbOrAbort's own call.
     */
    function recordContentFailure(code, episodes) {
      // Promotion rejections NEVER record quarantine strikes (blueprint §5):
      // promotion is a distinct rejection class, not a content failure of the
      // underlying episodes — a repeatedly rejected promotion must never
      // march innocent, branch-verified evidence toward quarantine.
      if (dryRun || !git || promotionMode || !CONTENT_FAILURE_CODES.has(code)) return null;
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
      if (!eps.length) return null;
      try {
        // STRIKES AND QUARANTINE MARKERS ARE STORE-GLOBAL, NEVER PER-BUCKET
        // (P2). Three strikes is an anti-collapse control over an EPISODE, and
        // a provenance-less episode is eligible in every branch lane — so
        // counting strikes in the per-bucket ledger meant the control reset
        // simply by switching branches (three more strikes per branch, forever),
        // and `consolidate --status`/doctor K2 reported zero quarantines from
        // any lane but the one that recorded them. The golden ledger is read by
        // every lane's consumption set (see candidateKeys below) and by
        // consolidateStatus unconditionally, so recording here makes both the
        // counting and the reporting branch-independent. Learning OUTCOMES
        // (`learning: <id>`) stay per-layer — those really are the bucket's.
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
        const commitRes = commitStore(dir, `consolidate: record failure ${code}`);
        if (!commitRes.ok) {
          rollbackStore(dir);
          return `strike recording failed to commit: ${commitRes.stderr || 'git commit failed'}`;
        }
        recordCheckpoint();
      } catch {
        // Best effort — failure recording must never mask the original rejection.
      }
      return null;
    }

    function rejectOp(code, reason, episodes) {
      const strikeNote = recordContentFailure(code, episodes);
      return {
        kind: 'reject',
        applied: [],
        governed: [],
        rejected: [fail(code, strikeNote ? `${reason} (${strikeNote})` : reason)],
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

    // Read once, reused by both the validation-time re-teach gate below and
    // the governance reapplication block further down — no governance write
    // happens between here and either read, so a single read is both safe and
    // exactly what keeps the two gates from ever seeing different states.
    const governance = readGovernance(dir);

    // Current unconsolidated candidate set (P1#3), built UNDER THE STORE LOCK
    // — for a real apply this whole function runs inside withStoreTransaction's
    // lock, so the on-disk episodes and the ledger are read as one consistent
    // snapshot. Key = `path@sha256` of every on-disk episode (both knowledge
    // roots, exactly what collectEpisodes scans) MINUS the ledger-consumed
    // ones (splitLedger's `consumed`, which includes NOOP's `learning: null`
    // and quarantines but NOT bare failure strikes). An ADD may only cite
    // episodes IN this set — otherwise a single episode could be re-cited
    // after it was already consolidated and mint a SECOND learning from spent
    // evidence. STRENGTHEN/SUPERSEDE/MERGE legitimately re-cite their target's
    // OWN existing evidence, so those episodes are exempt; only a genuinely-NEW
    // episode such an op introduces must also be a current candidate.
    const candidateKeys = new Set();
    {
      const onDisk = collectEpisodes({ workspace, copilotHome });
      // Consumption is layered: the golden ledger AND the current layer's
      // bucket ledger both consume — an episode consolidated in either place
      // can never mint a second learning from spent evidence in this lane.
      const { consumed } = splitLedger(readLedger(dir));
      if (layerRoot !== dir) {
        for (const key of splitLedger(readLedger(layerRoot)).consumed) consumed.add(key);
      }
      // Per-layer eligibility (blueprint P4 + §5a): once the store HAS
      // buckets, golden candidacy requires `branch:` provenance naming the
      // resolved default branch — an episode from an unpromoted non-default
      // branch, or one with NO provenance, routes to branch-local review and
      // never silently into golden. A bucket-less store keeps pre-layer
      // behavior byte-for-byte.
      const eligibility = {
        layer: routing.layer,
        currentBranch: routing.context?.branch || null,
        defaultBranchName: routing.defaultBranch?.name || null,
        storeHasBuckets: storeHasBuckets(dir),
      };
      for (const e of onDisk) {
        if (!episodeEligibleForLayer(e.branch, eligibility)) continue;
        const key = `${e.path}@${e.sha256}`;
        if (!consumed.has(key)) candidateKeys.add(key);
      }
    }
    // Episodes a FILE_TOUCHING op offers that must be a current candidate: ALL
    // of them for ADD (no target to re-cite from); for STRENGTHEN/SUPERSEDE/
    // MERGE, only the ones NOT already backing the target(s) — the target's own
    // consolidated evidence is exempt (the D1 re-cite invariant).
    function episodesNeedingCandidacy(op) {
      if (op.op === 'ADD') return op.episodes || [];
      const exempt = new Set();
      const targets = op.op === 'MERGE' ? op.targets || [] : op.target ? [op.target] : [];
      for (const t of targets) {
        const l = existing.get(t);
        if (l) for (const e of l.fm.episodes || []) exempt.add(`${e.path}@${e.sha256}`);
      }
      return (op.episodes || []).filter((e) => !exempt.has(`${e.path}@${e.sha256}`));
    }
    function assertCandidacy(op, opIndex) {
      for (const e of episodesNeedingCandidacy(op)) {
        if (!candidateKeys.has(`${e.path}@${e.sha256}`)) {
          return fail(
            'E_SCHEMA',
            `op ${opIndex}: episode ${e.path} is not a current unconsolidated candidate — already consolidated or absent`
          );
        }
      }
      return null;
    }

    // Validate every op before writing anything — all-or-nothing runs.
    const planned = [];
    const disputes = [];
    for (let i = 0; i < parsed.ops.length; i++) {
      // Rebindable: a promotion op's claim CONTENT is replaced below with the
      // verified source learning's own trigger/body, so everything downstream
      // (secret scan, imperative lint, renderLearning) reads what the source
      // actually says rather than what the ops file asserts.
      let op = parsed.ops[i];
      if (promotionMode && !FILE_TOUCHING.has(op.op)) {
        // The emitter only ever produces ADD/STRENGTHEN/SUPERSEDE. A
        // hand-authored promotion envelope carrying a NOOP would otherwise
        // consume its episodes into the GOLDEN ledger from any branch —
        // promotion mode pins layerRoot to golden — clearing debt in a lane the
        // run never had authority over. Same reasoning as the envelope gates
        // above: the writer enforces the emitter's shape, it doesn't assume it.
        return {
          kind: 'reject',
          applied: [],
          governed: [],
          rejected: [fail('E_SCHEMA', `op ${i}: a promotion op-set carries only ADD/STRENGTHEN/SUPERSEDE ops, never ${op.op}`)],
          committed: false,
          exitCode: 1,
        };
      }
      if (op.op === 'NOOP') {
        const bad = validateEpisodes(op.episodes, i);
        if (bad) return rejectOp(bad.code, bad.reason, op.episodes);
        // Disk verification (P1#3): a NOOP consumes every cited episode
        // (clears its debt) but only shape-checked it before — so a NOOP
        // could clear debt for a nonexistent or mislabeled file. Require
        // existence + sha256 match (kind is moot — nothing is stored).
        const badNoop = verifyNoopEpisodes(workspace, copilotHome, op.episodes, i);
        if (badNoop) return rejectOp(badNoop.code, badNoop.reason, op.episodes);
        planned.push({ ...op });
        continue;
      }
      if (!FILE_TOUCHING.has(op.op)) {
        return rejectOp('E_SCHEMA', `op ${i}: unknown op ${op.op}`, op.episodes);
      }
      const bad = validateEpisodes(op.episodes, i);
      if (bad) return rejectOp(bad.code, bad.reason, op.episodes);
      // Promotion episodes are re-derived from the SOURCE learning's own
      // recorded entries (see the promotion branch below) — never the op's
      // asserted kind/plan. Null for every non-promotion op.
      let promotedEpisodes = null;
      if (promotionMode) {
        // PROMOTION EXEMPTION (blueprint §5, normative): promotion ops are
        // exempt from the golden candidacy check and the working-tree kind
        // verification — their evidence was disk-verified (sha256) at
        // BRANCH-APPLY time and is re-validated here from the hashes the
        // bucket learning RECORDED, never from working-tree presence (the
        // source files live on the source branch and may be absent from this
        // checkout). Three bindings, all plain rejections (promotion class,
        // never a strike): the source learning must exist in the named
        // bucket, its file must hash to the sha recorded when the op-set was
        // emitted (nothing changed since review), and every op episode must
        // be one the source actually recorded.
        const src = op.source && typeof op.source === 'object' ? op.source : null;
        const sourceLearning = src && typeof src.id === 'string' ? promotionSources.get(src.id) : null;
        if (!sourceLearning) {
          return {
            kind: 'reject',
            applied: [],
            governed: [],
            rejected: [fail('E_SCHEMA', `op ${i}: promotion source ${src?.id || '(none)'} not found in bucket ${promotion.branchKey}`)],
            committed: false,
            exitCode: 1,
          };
        }
        // A source that is no longer an eligible promotion candidate — already
        // absorbed into golden, superseded, retired, disputed, or promoted to a
        // primitive — must never be promoted by a hand-authored op-set either.
        // renderLearning writes a FRESH golden file with `superseded_by: null`,
        // so without this a superseded branch claim would be laundered into
        // golden with its tombstone stripped en route.
        if (!isActiveFm(sourceLearning.fm)) {
          return {
            kind: 'reject',
            applied: [],
            governed: [],
            rejected: [
              fail(
                'E_SCHEMA',
                `op ${i}: promotion source ${src.id} is not an active, unpromoted bucket learning — only active branch claims promote`
              ),
            ],
            committed: false,
            exitCode: 1,
          };
        }
        const currentSha = crypto.createHash('sha256').update(fs.readFileSync(sourceLearning.file)).digest('hex');
        if (currentSha !== src.sha256) {
          return {
            kind: 'reject',
            applied: [],
            governed: [],
            rejected: [fail('E_SCHEMA', `op ${i}: promotion source ${src.id} changed since the op-set was emitted — regenerate with: harness knowledge promote`)],
            committed: false,
            exitCode: 1,
          };
        }
        // PROMOTION IS A LAYER MOVE, NOT AN AUTHORING OPERATION (P1). Until
        // this gate, only the SOURCE side was bound: `src.id` was looked up
        // and its file hashed, but the op's own DESTINATION (`domain`/`slug`
        // for ADD/SUPERSEDE, `target` for STRENGTHEN) and its `trigger`/`body`
        // were taken verbatim. The digest is computed over the ops array by
        // whoever wrote the file, so it binds nothing an attacker doesn't also
        // control — a hand-authored ADD could cite human-sourced claim `A`,
        // name destination `B`, carry arbitrary content, and mint a golden `B`
        // stamped `source: human` (the promoted claim inherits the SOURCE's
        // derived source/status below), i.e. exactly the authority the normal
        // lane reserves for disk-verified human teaching. A STRENGTHEN could
        // likewise graft `A`'s verified-fix episodes onto an unrelated golden
        // `B`, inflating the protected/promotion-eligibility counts. So the
        // destination MUST equal the source id, and the claim text comes from
        // the verified source learning, never from the op. A genuine
        // rename/re-slug during promotion would have to be its own explicitly
        // gated operation — it is never implicit here. The emitter already
        // only ever produces this shape (promote.mjs derives domain/slug/
        // target from the source), so nothing legitimate changes.
        const destId = op.op === 'STRENGTHEN' ? op.target : newIdFor(op);
        if (destId !== src.id) {
          return {
            kind: 'reject',
            applied: [],
            governed: [],
            rejected: [
              fail(
                'E_SCHEMA',
                `op ${i}: promotion destination ${destId || '(none)'} does not match source ${src.id} — promotion moves a claim between layers, it never renames or re-authors it`
              ),
            ],
            committed: false,
            exitCode: 1,
          };
        }
        if (op.op !== 'STRENGTHEN') {
          op = { ...op, trigger: sourceLearning.fm.trigger || '', body: sourceLearning.body };
        }
        // EVIDENCE IS COPIED FROM THE SOURCE, NEVER TRUSTED FROM THE OP (P1).
        // Only `path@sha256` was ever compared here, so an op could re-label a
        // recorded `insight` episode as `kind: fix` and attach a `plan:` the
        // source never carried — and `episodeLines` (store.mjs) defaults an
        // unknown/missing kind to `fix`, so a bare relabel was enough. The
        // promoted golden claim then read as verified fixes across distinct
        // plans, which is simultaneously the promotion-eligibility signal
        // (verifiedAndPlans) and the PROTECTED-target signal (isDisputedTargetFm /
        // isProtectedFm at ≥3 fix links) — i.e. an insight-only claim could
        // launder itself into permanently protected golden knowledge, defeating
        // the "insight-only learnings never promote" control by name. The op may
        // still SELECT which recorded episodes to carry (that is what a
        // STRENGTHEN promotion does); it may not describe them.
        const recorded = new Map();
        for (const e of sourceLearning.fm.episodes || []) {
          if (e.path) recorded.set(`${e.path}@${e.sha256}`, e);
        }
        promotedEpisodes = [];
        for (const e of op.episodes) {
          const recordedEpisode = recorded.get(`${e.path}@${e.sha256}`);
          if (!recordedEpisode) {
            return {
              kind: 'reject',
              applied: [],
              governed: [],
              rejected: [
                fail('E_SCHEMA', `op ${i}: episode ${e.path} was never recorded on the branch-applied source ${src.id} — promotion evidence re-validates from recorded hashes only`),
              ],
              committed: false,
              exitCode: 1,
            };
          }
          promotedEpisodes.push({
            path: recordedEpisode.path,
            sha256: recordedEpisode.sha256,
            kind: recordedEpisode.kind,
            plan: recordedEpisode.plan || null,
          });
        }
      } else {
        // Evidence-defect gate (see verifyAdmittedEpisodeKinds doc comment):
        // every episode assertion — fix, insight, AND human-teaching — must
        // disk-verify before anything downstream (gainedFix, verifiedFixLinks,
        // promotion math, source/status derivation) ever trusts it.
        const badKind = verifyAdmittedEpisodeKinds(workspace, copilotHome, op.episodes, i);
        if (badKind) return rejectOp(badKind.code, badKind.reason, op.episodes);
        // Candidate-set evidence gate (P1#3): the cited evidence must be a
        // CURRENT unconsolidated candidate — not an episode already consumed by
        // a prior consolidation (which would let an ADD mint a second learning
        // from spent evidence). A STRENGTHEN/SUPERSEDE/MERGE re-citing its
        // target's own already-consolidated evidence is exempt
        // (episodesNeedingCandidacy); only its genuinely-new episodes are gated.
        const notCandidate = assertCandidacy(op, i);
        if (notCandidate) return rejectOp(notCandidate.code, notCandidate.reason, op.episodes);
      }
      // merged_from is only ever a MERGE-derived (op.targets) or ADD/SUPERSEDE-
      // carried-forward field — an op JSON asserting it directly must be an
      // array of strings, or renderLearning's `mergedFrom.join(', ')` throws on
      // a non-array (e.g. a string) instead of failing closed.
      if (op.merged_from !== undefined && (!Array.isArray(op.merged_from) || !op.merged_from.every((v) => typeof v === 'string'))) {
        return rejectOp('E_SCHEMA', `op ${i}: merged_from must be an array of strings`, op.episodes);
      }

      // Shared between the inactive-target exemption (below) and the
      // disputed-demotion exemption (further down, SUPERSEDE-only) — computed
      // once per op so the two gates can never drift on what counts as a
      // verified human re-teach. Stays false for every op that isn't a
      // SUPERSEDE (STRENGTHEN has no re-teach shape — it never introduces or
      // replaces an id).
      let isReteachShape = false;
      let allHumanTeaching = false;

      if (op.op === 'STRENGTHEN' || op.op === 'SUPERSEDE') {
        if (!op.target || !existing.has(op.target)) {
          return rejectOp('E_TARGET', `op ${i}: target ${op.target || '(none)'} does not exist`, op.episodes);
        }
        // Checked before the consumed-target check and before any of
        // SUPERSEDE's own reteach/dispute logic further below — a promoted
        // target is rejected unconditionally, never conditionally exempted —
        // no re-teach exemption exists for a promoted target (see the doc
        // comment on promotedTargetRejection above): a human refining a
        // promoted claim updates the primitive, not the learning.
        const promotedTo = existing.get(op.target).fm.promoted_to;
        if (promotedTo) {
          return promotedTargetRejection(i, op.target, promotedTo);
        }
        // The verified in-place human re-teach shape: new id === target (never
        // a rename) AND every asserted human-teaching episode verifies against
        // disk (verifyHumanTeachingEpisode) — the op's own `kind` field alone
        // is not proof of anything. `op.op === 'SUPERSEDE'` short-circuits
        // before newIdFor(op) runs, so a STRENGTHEN op (which carries no
        // domain/slug) never reaches it.
        isReteachShape = op.op === 'SUPERSEDE' && newIdFor(op) === op.target;
        allHumanTeaching =
          isReteachShape &&
          op.episodes.length > 0 &&
          op.episodes.every((e) => verifyHumanTeachingEpisode(workspace, copilotHome, e)) &&
          // Recency gate (see overridesGovernanceRecency doc comment): the
          // op's own claim of human authorship isn't enough if a governance
          // record already exists for this exact target/id and the evidence
          // offered predates it — a stale teaching episode must never resurrect
          // a NEWER human retire/dispute/promote decision. humanPresent (set
          // only by runRemember) bypasses the day-granularity comparison
          // entirely — the live human lane's trust plane, same as `approve`.
          overridesGovernanceRecency(workspace, copilotHome, op.episodes, governance.get(op.target), { humanPresent });
        // Cross-run target-activeness (MERGE already required this — see the
        // isActiveFm check in its own branch below): a target already
        // superseded/retired/disputed ON DISK from a PRIOR run must never
        // accept a fresh STRENGTHEN/SUPERSEDE — that would let a model silently
        // resurrect or overwrite a demoted learning without a human's
        // dispute -> confirm round trip. EXEMPTION: a verified in-place human
        // re-teach (allHumanTeaching) overrides an inactive target — design
        // precedence rule: a direct, disk-verified human statement outranks
        // stored state, so a human correcting a disputed/retired claim under
        // the SAME trigger/domain must succeed without a separate confirm
        // round trip first. A model can never fabricate this exemption (the
        // evidence is verified against disk, not just asserted in the op
        // JSON). Promoted targets are NOT exempted — rejected unconditionally
        // above, before this point is ever reached. Composition-class plain
        // fail (like the consumedTargets/strengthenedTargets checks below) —
        // an inactive target is not a defect in this op's own episodes, so no
        // strike.
        if (!allHumanTeaching && !isActiveFm(existing.get(op.target).fm)) {
          return {
            kind: 'reject',
            applied: [],
            governed: [],
            rejected: [
              fail(
                'E_TARGET',
                op.op === 'SUPERSEDE'
                  ? `op ${i}: target ${op.target} is not active — SUPERSEDE an active learning or choose a new slug`
                  : `op ${i}: target ${op.target} is not active — STRENGTHEN requires an active target`
              ),
            ],
            committed: false,
            exitCode: 1,
          };
        }
        if (consumedTargets.has(op.target)) {
          // Composition rejection (sibling op raced for this target this same
          // run) — plain fail, never a strike against this op's episodes.
          return {
            kind: 'reject',
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
            kind: 'reject',
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
              kind: 'reject',
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
              kind: 'reject',
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
          // Inactive-target rejection (M4 review, item 2): same never-strike
          // class as the STRENGTHEN/SUPERSEDE inactive-target checks above —
          // the op's own episodes aren't defective, its choice of an already
          // superseded/retired/disputed target is, so this is a plain fail,
          // never rejectOp. Recording a strike here would quarantine innocent
          // episodes on a retry-after-dispute.
          if (!isActiveFm(existing.get(t).fm)) {
            return {
              kind: 'reject',
              applied: [],
              governed: [],
              rejected: [fail('E_TARGET', `op ${i}: target ${t} is not active (already superseded/retired/disputed)`)],
              committed: false,
              exitCode: 1,
            };
          }
        }
      }

      if (op.op === 'ADD' || op.op === 'SUPERSEDE' || op.op === 'MERGE') {
        // Type + presence: these four must be non-empty STRINGS. A truthiness-
        // only check let an object/array `body` (or trigger/domain/slug) sail
        // through to `body.trim()`/regex/render and surface as E_APPLY_FAILED
        // instead of the promised E_SCHEMA — validated here, before any
        // regex/secret-scan/render touches them.
        if (
          typeof op.domain !== 'string' || !op.domain ||
          typeof op.slug !== 'string' || !op.slug ||
          typeof op.trigger !== 'string' || !op.trigger ||
          typeof op.body !== 'string' || !op.body
        ) {
          return rejectOp('E_SCHEMA', `op ${i}: ${op.op} needs domain, slug, trigger, body as non-empty strings`, op.episodes);
        }
        // P1-5: a trigger carrying a raw control char (most importantly a
        // newline) would otherwise round-trip through yamlQuote/unquote
        // (store.mjs) and later interpolate into structured markdown
        // (context pack, listing, INDEX.md) as extra "lines" — fake
        // headings, extra bullets — inside a trusted surface. Rejected
        // outright at admission; `body` legitimately contains newlines (a
        // multi-line claim), so this check is scoped to `trigger` only.
        // inertLine (store.mjs) is the render-side backstop for content that
        // predates this gate (a legacy or hand-edited file).
        if (CONTROL_CHAR_RE.test(op.trigger)) {
          return rejectOp('E_SCHEMA', `op ${i}: trigger must not contain control characters (newlines, tabs, etc.)`, op.episodes);
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
              kind: 'reject',
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
              kind: 'reject',
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
            kind: 'reject',
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
            kind: 'reject',
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
            kind: 'reject',
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
        // itself proof of anything. isReteachShape/allHumanTeaching were
        // already computed above (shared with the inactive-target exemption) —
        // reused here rather than recomputed so the two gates can never drift
        // apart on what counts as a verified re-teach.
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
              kind: 'reject',
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
      // Everything downstream (renderLearning, composeStrengthenedLearning, the
      // ledger entries) reads `op.episodes` — so a promotion op is planned with
      // the SOURCE-derived episode records, not the ones the ops file asserted.
      planned.push({ ...op, ...(promotedEpisodes ? { episodes: promotedEpisodes } : {}), index: i });
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
      // (design §6). Admission (verifyAdmittedEpisodeKinds) already rejected
      // any op citing an unverifiable human-teaching episode with E_SCHEMA,
      // so by this point every human-teaching assertion re-verifies; the
      // re-check here is defense in depth (this derivation never throws or
      // rejects the op, it just withholds the elevated standing).
      let source = op.episodes.length && op.episodes.every((e) => verifyHumanTeachingEpisode(workspace, copilotHome, e)) ? 'human' : 'auto';
      let status = source === 'human' ? 'active' : 'provisional';
      let provenance = writeProvenance;
      if (promotionMode) {
        // The promoted claim carries the BRANCH-APPLIED derivation forward:
        // the bucket write already derived source/status under the full
        // writer rules, and the claim's git provenance names the branch that
        // produced the evidence — promotion is a layer move, not a
        // re-origination at the promoting commit.
        const src = promotionSources.get(op.source.id);
        source = src.fm.source || 'auto';
        status = isActiveFm(src.fm) && src.fm.status === 'active' ? 'active' : src.fm.status || 'provisional';
        provenance = { commit: src.fm.commit, branch: src.fm.branch, base: src.fm.base };
      }
      const content = renderLearning({
        trigger: op.trigger,
        body: op.body,
        episodes: op.episodes,
        anchors: extractAnchors({ workspace, copilotHome, episodes: op.episodes }),
        origin,
        status,
        source,
        supersededBy: null,
        mergedFrom: op.op === 'MERGE' ? op.targets : op.merged_from,
        provenance,
      });
      // Byte-cap decision (Phase 1, recorded in the plan's Implementation
      // Notes): the cap measures the CLAIM, so the provenance frontmatter
      // lines are excluded from the measured size — a near-cap learning
      // gaining commit/branch/base can never hit E_BYTE_CAP (or a quarantine
      // strike) purely from the stamp.
      if (Buffer.byteLength(content, 'utf8') - provenanceBytes(provenance) > LEARNING_BYTE_CAP) {
        return rejectOp('E_BYTE_CAP', `${id} exceeds ${LEARNING_BYTE_CAP} bytes — split into two claims`, op.episodes);
      }
      writes.push({ op, id, domain, slug, content });
    }

    // Compose STRENGTHEN content and enforce the SAME byte cap before writing
    // (P2): unlike ADD/SUPERSEDE/MERGE above, a STRENGTHEN re-renders an
    // EXISTING learning with every new evidence link appended — without this
    // check, repeated strengthening could grow a learning past
    // LEARNING_BYTE_CAP one episode at a time, since the write further below
    // (composeStrengthenedLearning) previously had nothing enforcing it. This
    // runs in the same pre-write validation phase as the ADD/SUPERSEDE/MERGE
    // byte-cap check above — a rejection here means STRENGTHEN never reaches
    // its own write loop and this op's rejectOp records a strike exactly like
    // any other E_BYTE_CAP (same code/shape ADD uses, so it routes through
    // the same content-failure strike recorder). Computed once here and
    // reused verbatim at write time below — no target file changes between
    // this point and that write (a STRENGTHEN's target can never be touched
    // by a sibling op earlier in the same run; see the consumedTargets/
    // strengthenedTargets composition checks above).
    const strengthenWrites = [];
    for (const op of planned) {
      if (op.op !== 'STRENGTHEN') continue;
      const target = existing.get(op.target);
      const content = composeStrengthenedLearning(target, op.episodes, workspace, copilotHome);
      // Same byte-cap decision as the fresh-write check above: the preserved
      // provenance lines are excluded from the measured size, so a near-cap
      // learning that carries commit/branch/base can still be strengthened
      // without tripping E_BYTE_CAP on bookkeeping bytes.
      if (Buffer.byteLength(content, 'utf8') - provenanceBytes(target.fm) > LEARNING_BYTE_CAP) {
        return rejectOp(
          'E_BYTE_CAP',
          `${op.target} exceeds ${LEARNING_BYTE_CAP} bytes after strengthening — split into two claims or supersede`,
          op.episodes
        );
      }
      strengthenWrites.push({ op, target, content });
    }

    if (dryRun) {
      return {
        kind: 'preview',
        applied: planned.map((o) => ({ op: o.op, id: o.target || (o.domain && `${normalizeSlug(o.domain)}/${normalizeSlug(o.slug)}`) || null })),
        rejected: disputes.map((d) => ({ ...fail('E_DISPUTED', 'disputed-pending-human'), reason: 'disputed-pending-human', target: d.target })),
        // A preview never touches the store, so governance reapplication never
        // runs — always empty, same as every other pre-mutation return above.
        governed: [],
      };
    }

    // Write-time HEAD re-validation (see assertHeadUnmoved): the last point
    // before anything is written is the last point a stale routing/provenance
    // snapshot can still be caught for free.
    const moved = assertHeadUnmoved();
    if (moved) return moved;

    // Mutation phase. No manual try/catch + git reset here any more — a
    // throw from anywhere below propagates straight out of runOnce, out of
    // withStoreTransaction's own fn callback, where the SAME rollback
    // (git reset --hard + clean -fd) now happens once, in one place, for
    // every adopter, followed by lock release. This lands on whatever the
    // last commit was — the absorb sub-commit `withStoreTransaction`'s caller
    // already made inside this same lock, never before it.
    const applied = [];
    const rejected = [];
    const ledgerEntries = [];
    const governed = [];
    const at = todayClamped();
    // Governance entries (P1-9) get a full ISO-8601 UTC timestamp, distinct
    // from the day-only `at` above (ledger entries/episode dates stay
    // day-granular) — see overridesGovernanceRecency's doc comment for why
    // day-granularity alone can't support the model-lane strictly-newer rule.
    const governanceAt = new Date().toISOString();

    for (const { op, id, domain, slug, content } of writes) {
      const file = path.join(layerRoot, 'learnings', domain, `${slug}.md`);
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
    // AND is at least as recent as this governance record
    // (overridesGovernanceRecency) is the human retracting their own
    // earlier call by re-teaching the same trigger/domain — the standing
    // decision is overridden instead of enforced, and a fresh `confirm`
    // record (never overwriting the history, always appended) supersedes
    // it via readGovernance's latest-per-id replay. `governance` was
    // already read once above (before validation) — reused here, not
    // re-read, since nothing writes to governance.jsonl between that read
    // and this loop.
    for (const { op, id, domain, slug } of writes) {
      const entry = governance.get(id);
      if (!entry || !['retire', 'dispute', 'promote'].includes(entry.action)) continue;
      const isReteach =
        op.episodes.length > 0 &&
        op.episodes.every((e) => verifyHumanTeachingEpisode(workspace, copilotHome, e)) &&
        overridesGovernanceRecency(workspace, copilotHome, op.episodes, entry, { humanPresent });
      // The override is SCOPED TO THE LAYER ACTUALLY WRITTEN. Governance binds
      // both layers (§4) and lives in one store-root ledger, so a `confirm`
      // appended from a branch lane cancels the standing decision for GOLDEN
      // too — a `harness remember` on a throwaway feature branch could
      // therefore retract a golden retire a human had made, from a write that
      // never touched golden. A branch-lane re-teach still lands its own claim
      // in the bucket; it just doesn't get to speak for the golden layer, so
      // the standing decision is reapplied to the bucket copy instead.
      if (isReteach && layerRoot === dir) {
        appendGovernance(dir, { id, action: 'confirm', reason: 'superseded by re-teach', to: null, at: governanceAt });
        continue;
      }
      if (isReteach) {
        log(
          `consolidate: re-teach of ${id} landed branch-local — the standing ${entry.action} decision still binds both layers; re-teach on the default branch (or promote) to retract it`
        );
      }
      const file = path.join(layerRoot, 'learnings', domain, `${slug}.md`);
      if (entry.action === 'promote') {
        // promoted_to may be entirely absent from the just-written file —
        // the same parse -> mutate fm -> serializeLearning re-render
        // lifecycle.mjs's own promote branch uses, not
        // updateFrontmatterField's regex-insert. Re-validated here with the
        // exact same containment idiom lifecycle.mjs's promote branch
        // enforces at RECORD time — entry.to is read back from
        // governance.jsonl, a file outside applyOps' own write path (a hand
        // edit to it is not absorbed/scanned the way a learning file is),
        // so a poisoned or hand-edited entry must never be trusted verbatim
        // at REPLAY time. A violation skips the reapply for this id
        // entirely (the freshly written file is left exactly as the write
        // loop above produced it, no promoted_to added) and logs it —
        // fail-closed, never a throw.
        const root = path.resolve(workspace);
        const toFull = path.resolve(root, entry.to || '');
        if (!entry.to || (toFull !== root && !toFull.startsWith(root + path.sep))) {
          log(`consolidate: governance record for ${id} has an unsafe promote target (${entry.to}) — skipped reapply`);
          continue;
        }
        const text = fs.readFileSync(file, 'utf8');
        const { fm, body } = parseLearningFrontmatter(text);
        fs.writeFileSync(file, serializeLearning({ ...fm, promoted_to: entry.to }, body), 'utf8');
      } else {
        updateFrontmatterField(file, 'status', entry.action === 'retire' ? 'retired' : 'disputed');
      }
      governed.push({ id, action: entry.action });
    }

    // Writes the content composed (and byte-cap checked) in the validation
    // phase above verbatim — never recomputed here, so there is exactly one
    // place that decides a STRENGTHEN's rendered bytes.
    for (const { op, target, content } of strengthenWrites) {
      fs.writeFileSync(target.file, content, 'utf8');
      applied.push({ op: 'STRENGTHEN', id: op.target });
      for (const e of op.episodes) ledgerEntries.push({ path: e.path, sha256: e.sha256, learning: op.target, at });
    }

    // Promotion tombstones + audit ledger (blueprint §5): every successfully
    // promoted source is stamped `promoted_to_golden:` in its bucket (a
    // retrieval exclusion — the bucket entry stops shadowing the golden claim
    // it just became) and an `absorb-branch` entry lands in the governance
    // ledger for AUDIT ONLY — the replay rule (readGovernance) never lets it
    // become an id's standing decision, so a standing retire recorded before
    // a promotion still lands retired after any later rebuild. Once every
    // source is tombstoned the bucket is prunable (knowledge status/prune).
    if (promotionMode && !dryRun) {
      const bucketRoot = bucketDirFor(dir, promotion.branchKey);
      let touchedBucket = false;
      // THE TOMBSTONE FOLLOWS THE SOURCE, NOT THE DESTINATION (P1). This loop
      // used to look the bucket entry up by the id the op WROTE, so an op
      // naming a destination other than its source left the source untouched
      // — still active, still promotable, reusable for repeat runs. Walking
      // the planned writes gives each one its own `op.source.id` directly;
      // the destination-binding gate above already makes the two equal, so
      // this is the belt to that gate's braces.
      for (const entry of [...writes, ...strengthenWrites]) {
        const src = entry.op.source?.id ? promotionSources.get(entry.op.source.id) : null;
        if (!src) continue;
        // Defense in depth (fs-safe.mjs's own documented discipline): this is
        // the one write in this module that targets a path under
        // `branches/<key>/`, a directory tree a human hand-edits. A symlinked
        // bucket component must never let the tombstone write land outside the
        // store. Fail CLOSED — a throw here propagates out of runOnce and
        // withStoreTransaction rolls the whole promotion back, rather than
        // leaving a golden claim whose source was never tombstoned.
        if (!assertRealpathContained(dir, path.relative(dir, src.file))) {
          throw new Error(`refused to tombstone ${src.id}: bucket learning path escapes the knowledge store`);
        }
        const text = fs.readFileSync(src.file, 'utf8');
        const parsedSource = parseLearningFrontmatter(text);
        fs.writeFileSync(src.file, serializeLearning({ ...parsedSource.fm, promoted_to_golden: src.id }, parsedSource.body), 'utf8');
        appendGovernance(dir, {
          id: src.id,
          action: 'absorb-branch',
          reason: `promoted from ${promotion.branchKey}`,
          to: null,
          at: governanceAt,
        });
        touchedBucket = true;
      }
      if (touchedBucket) rebuildIndex(bucketRoot);
    }

    for (const op of planned) {
      if (op.op === 'NOOP') {
        applied.push({ op: 'NOOP', id: op.reason || null });
        for (const e of op.episodes) ledgerEntries.push({ path: e.path, sha256: e.sha256, learning: null, at });
      }
    }

    for (const d of disputes) {
      const target = existing.get(d.target);
      updateFrontmatterField(target.file, 'status', 'disputed');
      rejected.push({ ...fail('E_DISPUTED', 'disputed-pending-human'), reason: 'disputed-pending-human', target: d.target });
    }

    if (ledgerEntries.length) appendLedger(layerRoot, ledgerEntries);
    rebuildIndex(layerRoot);

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
    // Promotion mode reports the layer it actually WROTE — golden, always —
    // never the write-time routing of the branch the CLI happens to run from,
    // and its commit suffix names the promotion source bucket instead.
    return {
      kind: 'success',
      applied,
      rejected,
      governed,
      layer: promotionMode ? 'golden' : routing.layer,
      bucketKey: !promotionMode && routing.layer === 'branch' ? routing.bucketKey : null,
      commitMessage: `consolidate: ${summary}${
        promotionMode ? ` [promote ${promotion.branchKey}]` : routing.layer === 'branch' ? ` [${routing.bucketKey}]` : ''
      }`,
    };
  }

  if (dryRun) {
    // A preview writes nothing and takes no lock, so one snapshot is all it
    // can meaningfully have; the write-time re-validation above never runs
    // (runOnce returns its preview before reaching it).
    deriveRouting();
    const { dir, git } = ensureStore(workspace, { home, dryRun: true });
    const result = runOnce({ dir, git });
    if (result.kind === 'reject') {
      return { applied: result.applied, governed: result.governed, rejected: result.rejected, committed: false, exitCode: result.exitCode };
    }
    return { applied: result.applied, rejected: result.rejected, committed: false, exitCode: 0, dryRun: true, governed: result.governed };
  }

  // Real apply: absorb + mode re-check + validate + mutate + commit all run
  // inside ONE locked transaction (P1-6) — the lock now wraps everything from
  // before the first read of store state through the final commit, and every
  // other store writer (setLearningStatus, purgeEpisode, purgeAll,
  // rebuildStore's --yes path, writeStoreConfig) takes the SAME lock via the
  // SAME withStoreTransaction, so none of them can bypass it either.
  const tx = withStoreTransaction(
    workspace,
    {
      home,
      label: 'consolidate: apply',
      // Mirror a COMMITTED snapshot (P2): the workspace mirror runs inside this
      // transaction's own lock, right after the commit lands, so the store
      // working tree it re-reads is clean-and-committed and no concurrent
      // writer can expose dirty mutations it would mirror then roll back. Skip
      // on a reject result — a strike/no-op run publishes nothing new.
      afterCommit: ({ result }) => {
        if (result?.kind === 'reject') return;
        mirrorLearnings({ workspace, home, log });
      },
    },
    ({ dir, git, recordCheckpoint }) => {
    // The run's ONE git snapshot (routing + provenance), taken under the store
    // lock rather than before it, and re-validated at write time
    // (assertHeadUnmoved) — see deriveRouting's doc comment above.
    deriveRouting();
    // Absorb any hand edit sitting in the store BEFORE anything else reads or
    // mutates it — still its own self-contained commit (absorbHandEdits calls
    // commitStore itself), now made WHILE the lock is held instead of before
    // it existed. That absorb commit is the transaction's rollback checkpoint
    // (recordCheckpoint, via absorbOrAbort), so a hand edit always survives a
    // mid-mutation throw — including one caused by a LEGITIMATE later
    // mutation re-touching the SAME file the absorb just committed (an
    // in-place human-teaching reteach): the checkpoint reset discards
    // everything after that commit regardless of which path it touched,
    // rather than trying to infer "is this dirty path still protected" from
    // content alone. Advisory: never blocks the run it guards — EXCEPT when
    // the absorb's own sub-commit fails for a real reason (not "nothing to
    // absorb"), which absorbOrAbort turns into a StoreTransactionAbort: that
    // must propagate, not be swallowed here, so withStoreTransaction can skip
    // the standard rollback and leave the uncommitted hand edit intact.
    try {
      absorbOrAbort({ workspace, home, log, recordCheckpoint });
    } catch (err) {
      if (err instanceof StoreTransactionAbort) throw err;
      // best effort — any OTHER hand-edit absorb failure must never block applyOps.
    }
    // Fresh, lock-held re-check of the mode gate: closes the window between
    // the pre-lock check above and lock acquisition where another writer
    // could have flipped the mode.
    const { mode: freshMode } = readStoreConfig(workspace, { home });
    if (freshMode !== 'on' && !(freshMode === 'suggest' && approve)) {
      const reason =
        freshMode === 'suggest'
          ? 'knowledge mode is suggest — review the ops JSON, then re-run apply with --yes'
          : `knowledge mode is ${freshMode} — run: harness knowledge on`;
      return { kind: 'reject', applied: [], governed: [], rejected: [{ code: 'E_MODE', reason }], committed: false, exitCode: 2 };
    }
    return runOnce({ dir, git, recordCheckpoint });
  });

  if (!tx.ok) {
    if (tx.locked) {
      return { applied: [], governed: [], rejected: [fail('E_LOCKED', 'another consolidation holds the store lock')], committed: false, exitCode: 1 };
    }
    return {
      applied: [],
      governed: [],
      rejected: [fail('E_APPLY_FAILED', tx.error?.message || 'store transaction failed')],
      committed: false,
      exitCode: 1,
      ...(tx.staleLockNote ? { staleLockRemoved: tx.staleLockNote } : {}),
    };
  }

  const staleExtra = tx.staleLockNote ? { staleLockRemoved: tx.staleLockNote } : {};
  const inner = tx.result;
  if (inner.kind === 'reject') {
    return { applied: inner.applied, governed: inner.governed, rejected: inner.rejected, committed: false, exitCode: inner.exitCode, ...staleExtra };
  }

  // The workspace mirror already ran inside the transaction's afterCommit hook
  // (above), under the still-held lock on the committed tree — never here,
  // after the lock released, where a concurrent writer's dirty state could
  // leak into it (P2).
  return {
    applied: inner.applied,
    rejected: inner.rejected,
    committed: tx.committed,
    exitCode: 0,
    storeDir: tx.dir,
    indexPath: path.join(tx.dir, 'INDEX.md'),
    governed: inner.governed,
    layer: inner.layer,
    bucketKey: inner.bucketKey ?? null,
    ...(routing?.branchWarning ? { branchWarning: routing.branchWarning } : {}),
    ...staleExtra,
  };
}
export function updateFrontmatterField(file, field, value) {
  const text = fs.readFileSync(file, 'utf8');
  const re = new RegExp(`^${field}:.*$`, 'm');
  // The insertion fallback (field absent from frontmatter) must tolerate a
  // CRLF-terminated leading `---` — an LF-only regex silently no-ops on a
  // CRLF learning file instead of inserting the field, since neither branch
  // matches. Capture the line ending actually used and reuse it so a fresh
  // insertion doesn't mix newline styles.
  const next = re.test(text)
    ? text.replace(re, `${field}: ${value}`)
    : text.replace(/^---(\r?\n)/, (_, nl) => `---${nl}${field}: ${value}${nl}`);
  fs.writeFileSync(file, next, 'utf8');
}

// Composes a STRENGTHEN's rendered content WITHOUT writing it — split out of
// the former strengthenLearning so the validation phase above can byte-cap
// check the result before anything commits to writing it (P2: STRENGTHEN
// previously had no byte cap at all). The sole caller of the write itself is
// the strengthenWrites loop in the mutation phase, which writes this exact
// string back verbatim.
function composeStrengthenedLearning(target, episodes, workspace, copilotHome) {
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
    anchors: extractAnchors({ workspace, copilotHome, episodes: merged }),
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
    // Same carry-forward for the branch→golden tombstone: a STRENGTHEN must
    // never resurrect a bucket entry whose claim already landed golden. In
    // practice the inactive-target gate now rejects such a STRENGTHEN before
    // this runs (isActiveFm counts promoted_to_golden), so this is the
    // defense-in-depth half — the re-render itself can no longer lose it.
    promotedToGolden: fm.promoted_to_golden || null,
    // Preserve the learning's ORIGINAL git provenance across the re-render
    // (blueprint P1): a STRENGTHEN adds evidence to an existing claim, it does
    // not re-originate it. A legacy learning without the fields stays without
    // them — provenanceLines renders nothing for absent values.
    provenance: { commit: fm.commit, branch: fm.branch, base: fm.base },
  });
  return content;
}

export function rebuildIndex(dir) {
  const active = listLearnings(dir).filter((l) => isActiveFm(l.fm));
  const lines = [
    '# Learnings Index',
    '',
    '_Rebuilt by `harness consolidate --apply`. One line per active learning._',
    '',
    // inertLine: a legacy/hand-edited trigger can still carry an embedded
    // control char (store.mjs's doc comment) — collapsed to a space so every
    // INDEX.md row always renders as one line.
    ...active.map((l) => `- [${l.id}] ${inertLine(l.fm.trigger || '')}`),
    '',
  ];
  fs.writeFileSync(path.join(dir, 'INDEX.md'), lines.join('\n'), 'utf8');
}
