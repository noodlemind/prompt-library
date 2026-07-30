import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { harnessGlobalHome } from '../paths.mjs';

/**
 * The local knowledge store: a CLI-managed git repo OUTSIDE the working tree
 * at <harness home>/knowledge/<repo-id>/ — survives `git clean`, re-clones,
 * and is shared by every worktree/clone of the same remote. Never pushed.
 */

const INDEX_STUB = `# Learnings Index

_Rebuilt by \`harness consolidate --apply\`. One line per active learning._
`;

function gitOut(cwd, args) {
  const res = spawnSync('git', args, { cwd, encoding: 'utf8' });
  return res.status === 0 ? res.stdout.trim() : null;
}

/**
 * Normalize any origin-remote form (ssh/https/scp) to one stable id. The
 * human-readable slug alone is lossy — `github.com/org-a/repo-b` and
 * `github.com/org-a-repo/b` both collapse to the same slug once `/` and `-`
 * are folded together — so a short hash of the pre-lossy canonical string is
 * appended to disambiguate. Equivalent ssh/https/scp forms of the same
 * remote still share one canonical string, so they still share one id.
 */
export function repoId(workspace) {
  const remote = gitOut(workspace, ['remote', 'get-url', 'origin']);
  if (remote) {
    const canonical = remote
      .trim()
      .replace(/\.git$/, '')
      .replace(/^[a-z+]+:\/\//i, '') // https://, ssh://, git://
      .replace(/^[^@/]+@/, '') // user@
      .replace(/:/g, '/') // scp form host:path
      .toLowerCase();
    const slug = canonical.replace(/[^a-z0-9.]+/g, '-').replace(/^-+|-+$/g, '');
    if (slug) {
      const suffix = crypto.createHash('sha256').update(canonical).digest('hex').slice(0, 8);
      return `${slug}-${suffix}`;
    }
  }
  // No remote: stable path-keyed fallback (documented limitation — memory is
  // per-path until a remote is added).
  let real = workspace;
  try {
    real = fs.realpathSync(workspace);
  } catch {
    // keep the given path
  }
  return `local-${crypto.createHash('sha256').update(real).digest('hex').slice(0, 12)}`;
}

export function storeDir(workspace, { home } = {}) {
  return path.join(home || harnessGlobalHome(), 'knowledge', repoId(workspace));
}

export function ensureStore(workspace, { home, dryRun = false } = {}) {
  const dir = storeDir(workspace, { home });
  const created = !fs.existsSync(path.join(dir, 'consolidated.jsonl'));
  if (dryRun) return { dir, created, git: fs.existsSync(path.join(dir, '.git')) };
  fs.mkdirSync(path.join(dir, 'learnings'), { recursive: true });
  let gitOk = fs.existsSync(path.join(dir, '.git'));
  if (!gitOk) {
    gitOk = spawnSync('git', ['init', '-q'], { cwd: dir, encoding: 'utf8' }).status === 0;
  }
  const indexPath = path.join(dir, 'INDEX.md');
  if (!fs.existsSync(indexPath)) fs.writeFileSync(indexPath, INDEX_STUB, 'utf8');
  const ledgerPath = path.join(dir, 'consolidated.jsonl');
  if (!fs.existsSync(ledgerPath)) fs.writeFileSync(ledgerPath, '', 'utf8');
  return { dir, created, git: gitOk };
}

export const KNOWLEDGE_MODES = new Set(['on', 'suggest', 'off', 'freeze', 'capture-only']);

/**
 * Opt-in commit mode (Milestone 3 Task 6): 'none' (default — no mirroring)
 * or 'repo' (mirror ACTIVE learnings verbatim into
 * <workspace>/docs/knowledge/learnings/, see admin.mjs's mirrorLearnings).
 * Independent of KNOWLEDGE_MODES — the two fields persist side by side in
 * config.json, each read-modify-write preserving the other (writeStoreConfig
 * below): `knowledge freeze` must not reset commit, `knowledge commit repo`
 * must not reset mode.
 */
export const KNOWLEDGE_COMMIT_MODES = new Set(['none', 'repo']);

/**
 * Kill-switch mode (and opt-in commit mode) for the knowledge layer, read
 * from <store>/config.json. Read-only — never creates the store. Tolerant of
 * an absent or corrupt config (missing file, unreadable JSON, unrecognized
 * mode/commit): default mode is 'on' and default commit is 'none', so a
 * fresh or damaged store never silently blocks the whole layer nor silently
 * starts mirroring into the product repo.
 */
export function readStoreConfig(workspace, { home } = {}) {
  const dir = storeDir(workspace, { home });
  let mode = 'on';
  let commit = 'none';
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
    if (parsed && KNOWLEDGE_MODES.has(parsed.mode)) mode = parsed.mode;
    if (parsed && KNOWLEDGE_COMMIT_MODES.has(parsed.commit)) commit = parsed.commit;
  } catch {
    // absent, unreadable, or corrupt — defaults above hold
  }
  return { mode, commit };
}

/**
 * Read-modify-write: only the field(s) actually passed (`mode` and/or
 * `commit`) change — whichever one this call omits is preserved from the
 * current config exactly as-is, so `knowledge freeze` and `knowledge commit
 * repo` can never stomp on each other. The commit message names whichever
 * field this call changed.
 */
export function writeStoreConfig(workspace, { home, mode, commit } = {}) {
  const tx = withStoreTransaction(workspace, { home }, ({ dir }) => {
    const current = readStoreConfig(workspace, { home });
    const nextMode = mode !== undefined ? mode : current.mode;
    const nextCommit = commit !== undefined ? commit : current.commit;
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ mode: nextMode, commit: nextCommit }) + '\n', 'utf8');
    const message = mode !== undefined ? `knowledge: mode ${nextMode}` : `knowledge: commit ${nextCommit}`;
    return { nextMode, nextCommit, commitMessage: message };
  });
  if (!tx.ok) {
    return {
      mode: mode !== undefined ? mode : null,
      commit: commit !== undefined ? commit : null,
      committed: false,
      pass: false,
      code: tx.locked ? 'E_LOCKED' : 'E_STORE_TRANSACTION_FAILED',
      blockedReason: tx.locked ? 'E_LOCKED: another operation holds the store lock' : `store transaction failed: ${tx.error?.message || 'unknown error'}`,
      ...(tx.staleLockNote ? { staleLockRemoved: tx.staleLockNote } : {}),
    };
  }
  return {
    mode: tx.result.nextMode,
    commit: tx.result.nextCommit,
    committed: tx.committed,
    pass: true,
    blockedReason: null,
    ...(tx.staleLockNote ? { staleLockRemoved: tx.staleLockNote } : {}),
  };
}

/** Append-only episode-consumption ledger. Torn tail lines are tolerated. */
export function readLedger(dir) {
  const ledgerPath = path.join(dir, 'consolidated.jsonl');
  if (!fs.existsSync(ledgerPath)) return [];
  const entries = [];
  for (const line of fs.readFileSync(ledgerPath, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line));
    } catch {
      // torn/corrupt line — skip, never fail reads on it
    }
  }
  return entries;
}

export function appendLedger(dir, entries) {
  if (!entries || !entries.length) return;
  const ledgerPath = path.join(dir, 'consolidated.jsonl');
  const existing = fs.existsSync(ledgerPath) ? fs.readFileSync(ledgerPath, 'utf8') : '';
  const prefix = existing && !existing.endsWith('\n') ? '\n' : '';
  fs.appendFileSync(ledgerPath, prefix + entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
}

/**
 * Raw, in-order governance entries — every line, one per human lifecycle
 * decision, torn/corrupt lines skipped (same tolerance as readLedger). This
 * is the shared parse used by both readGovernance (replayed into a
 * latest-per-id Map) and rewriteGovernance (filtered and rewritten as-is,
 * still one line per historical decision) — so the two never drift apart on
 * what counts as a well-formed line.
 */
function readGovernanceEntries(dir) {
  const govPath = path.join(dir, 'governance.jsonl');
  if (!fs.existsSync(govPath)) return [];
  const entries = [];
  for (const line of fs.readFileSync(govPath, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line));
    } catch {
      // torn/corrupt line — skip, never fail reads on it
    }
  }
  return entries;
}

/**
 * Human governance ledger (Milestone 4): append-only record of retire/
 * dispute/confirm/promote decisions a person made on a learning — the half
 * of a learning's state a `consolidate --rebuild` wipe must never resurrect.
 * Replayed in file order, latest entry per id wins, so a dispute followed by
 * a confirm on the same id resolves to the confirm. Missing file → empty Map,
 * same as a fresh store with no decisions yet.
 */
export function readGovernance(dir) {
  const map = new Map();
  for (const entry of readGovernanceEntries(dir)) {
    if (entry && entry.id) map.set(entry.id, entry);
  }
  return map;
}

/** Append one governance decision. Same newline-guard idiom as appendLedger. */
export function appendGovernance(dir, entry) {
  const govPath = path.join(dir, 'governance.jsonl');
  const existing = fs.existsSync(govPath) ? fs.readFileSync(govPath, 'utf8') : '';
  const prefix = existing && !existing.endsWith('\n') ? '\n' : '';
  fs.appendFileSync(govPath, prefix + JSON.stringify(entry) + '\n');
}

/**
 * Rewrite governance.jsonl keeping only entries where `keepPredicate(entry)`
 * is true — used by purgeEpisode (admin.mjs) to drop every historical record
 * for an id whose learning was just fully cascade-deleted. No-op when the
 * file is absent: a purge on a store that never recorded a governance
 * decision must never materialize the file.
 */
export function rewriteGovernance(dir, keepPredicate) {
  const govPath = path.join(dir, 'governance.jsonl');
  if (!fs.existsSync(govPath)) return;
  const kept = readGovernanceEntries(dir).filter(keepPredicate);
  fs.writeFileSync(govPath, kept.length ? kept.map((e) => JSON.stringify(e)).join('\n') + '\n' : '', 'utf8');
}

/**
 * Parse learning frontmatter including the structured episodes block and the
 * flat anchors list. Only one list can be "open" at a time — episodes and
 * anchors items look similar (both start `  - `) so we track which block
 * we're inside and only apply that block's item shape.
 */
export function parseLearningFrontmatter(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return { fm: {}, body: text.trim() };
  const fm = { episodes: [], anchors: [] };
  let openList = null; // 'episodes' | 'anchors' | null
  let current = null;
  for (const line of m[1].split('\n')) {
    if (/^episodes:\s*$/.test(line)) {
      openList = 'episodes';
      current = null;
      continue;
    }
    if (/^anchors:\s*\[\]\s*$/.test(line)) {
      openList = null;
      current = null;
      fm.anchors = [];
      continue;
    }
    if (/^anchors:\s*$/.test(line)) {
      openList = 'anchors';
      current = null;
      continue;
    }
    if (openList === 'episodes') {
      const item = line.match(/^\s{2}- (\w+):\s*(.*)$/);
      const sub = line.match(/^\s{4}(\w+):\s*(.*)$/);
      if (item) {
        current = { [item[1]]: unquote(item[2]) };
        fm.episodes.push(current);
        continue;
      }
      if (sub && current) {
        current[sub[1]] = unquote(sub[2]);
        continue;
      }
    }
    if (openList === 'anchors') {
      const anchorItem = line.match(/^\s{2}- (.+)$/);
      if (anchorItem) {
        fm.anchors.push(unquote(anchorItem[1]));
        continue;
      }
    }
    const kv = line.match(/^([\w-]+):\s*(.*)$/);
    if (kv) {
      openList = null;
      current = null;
      const value = unquote(kv[2]);
      fm[kv[1]] = value === 'null' || value === '' ? (value === '' ? '' : null) : value;
    }
  }
  const body = text.slice(m[0].length).trim();
  return { fm, body };
}

const ESCAPE_MAP = { n: '\n', r: '\r', t: '\t', '"': '"', '\\': '\\' };

/**
 * Reverse what `yamlQuote` does at write time: wrap in double quotes, then
 * escape `\`, `"`, and control chars. Only a value surrounded by
 * double quotes on both ends went through that escaping, so only that shape
 * gets unescaped — a single-pass regex so a real backslash (encoded as
 * `\\`) is never re-interpreted as the start of a second escape sequence.
 * Anything else (bare scalars, single-quoted legacy values) is only
 * quote-stripped, exactly as before.
 */
function unquote(v) {
  const s = String(v ?? '').trim();
  const m = /^"([\s\S]*)"$/.exec(s);
  if (m) {
    return m[1].replace(/\\(.)/g, (_, ch) => ESCAPE_MAP[ch] ?? ch);
  }
  return s.replace(/^["']|["']$/g, '');
}

function yamlQuote(v) {
  return `"${String(v)
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t')}"`;
}

/**
 * Render one learning's `episodes:` block lines. Shared by this module's own
 * `serializeLearning` (a parse → mutate → re-render round trip) AND
 * apply.mjs's `renderLearning` (a from-scratch ADD/SUPERSEDE/STRENGTHEN/MERGE
 * write) — the two sole writers of a learning file — so a malformed episode
 * entry (missing `path` or an unrecognized/missing `kind`, the shape a
 * hand-edited file or a stale on-disk record can carry) is normalized
 * IDENTICALLY by both instead of one of them drifting back to emitting a
 * literal `path: undefined` / `kind: undefined`. A pathless entry is dropped
 * outright — a link with nothing to link to is meaningless, not valid YAML
 * worth keeping. A missing/unrecognized kind defaults to 'fix'.
 */
export function episodeLines(episodes) {
  const lines = [];
  for (const e of episodes || []) {
    if (!e.path) continue;
    lines.push(`  - path: ${e.path}`);
    lines.push(`    sha256: ${yamlQuote(e.sha256)}`);
    lines.push(`    kind: ${e.kind === 'insight' ? 'insight' : e.kind === 'human-teaching' ? 'human-teaching' : 'fix'}`);
    lines.push(`    plan: ${e.plan || ''}`);
  }
  return lines;
}

/**
 * Render a parsed `{ fm, body }` pair (as `parseLearningFrontmatter` above
 * hands back) to the canonical on-disk learning text — same field order and
 * escaping the sole writer's `renderLearning` (apply.mjs) uses for a fresh
 * ADD/SUPERSEDE/STRENGTHEN write, so a parse → mutate fm → serializeLearning
 * round trip stays byte-shape-compatible with a from-scratch write. Every
 * scalar is written straight from `fm` as parsed, with no re-interpretation —
 * e.g. `fm.merged_from` is already the raw bracketed string this module's own
 * parser hands back, not an array, so it's written verbatim rather than
 * re-joined. `renderLearning` itself builds from discrete op arguments (an
 * array `mergedFrom`, a freshly-stamped `last_confirmed`) rather than a
 * parsed `fm`, so it is intentionally NOT rebased on this function — that
 * would require normalizing shapes it doesn't own; see apply.mjs.
 */
export function serializeLearning(fm, body) {
  const lines = [
    '---',
    'schema: 1',
    `trigger: ${yamlQuote(fm.trigger || '')}`,
    `status: ${fm.status || 'active'}`,
    `source: ${fm.source || 'auto'}`,
    'episodes:',
    ...episodeLines(fm.episodes),
  ];
  const anchors = fm.anchors || [];
  if (anchors.length) {
    lines.push('anchors:');
    for (const a of anchors) lines.push(`  - ${a}`);
  } else {
    lines.push('anchors: []');
  }
  lines.push(`superseded_by: ${fm.superseded_by || 'null'}`);
  lines.push(`last_confirmed: ${fm.last_confirmed || 'null'}`);
  if (fm.merged_from) lines.push(`merged_from: ${fm.merged_from}`);
  if (fm.promoted_to) lines.push(`promoted_to: ${fm.promoted_to}`);
  lines.push(`origin: ${fm.origin || 'unknown'}`);
  lines.push('---', '', body.trim(), '');
  return lines.join('\n');
}

export function listLearnings(dir) {
  const root = path.join(dir, 'learnings');
  const out = [];
  if (!fs.existsSync(root)) return out;
  for (const domain of fs.readdirSync(root, { withFileTypes: true })) {
    if (!domain.isDirectory()) continue;
    const dPath = path.join(root, domain.name);
    for (const f of fs.readdirSync(dPath)) {
      if (!f.endsWith('.md')) continue;
      const file = path.join(dPath, f);
      const text = fs.readFileSync(file, 'utf8');
      const { fm, body } = parseLearningFrontmatter(text);
      const slug = f.replace(/\.md$/, '');
      out.push({
        id: `${domain.name}/${slug}`,
        domain: domain.name,
        slug,
        file,
        fm,
        body,
        bytes: Buffer.byteLength(text, 'utf8'),
      });
    }
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Stage and commit everything in the store. `committed` is the long-standing
 * boolean contract every caller destructures (true on a real commit, false on
 * a clean tree) — unchanged. `ok`/`stderr` are additive: a REAL git failure
 * (as opposed to "nothing to commit") now surfaces distinctly instead of
 * being silently folded into `committed: false` (P1-7 — a failed `git add`
 * or `git commit` used to be indistinguishable from a legitimate no-op, so
 * callers reported success on a git failure and left dirty CLI-authored
 * state a later absorb could misclassify as a human edit).
 *
 * The clean-tree signal is `git status --porcelain` emptiness, never a git
 * exit code or message string: `git commit` also exits nonzero for a clean
 * tree, and its "nothing to commit" text is locale-dependent — porcelain
 * output is neither.
 */
export function commitStore(dir, message) {
  const addRes = spawnSync('git', ['add', '-A'], { cwd: dir, encoding: 'utf8' });
  if (addRes.status !== 0) {
    return { committed: false, ok: false, stderr: addRes.stderr || `git add exited ${addRes.status}` };
  }
  const statusRes = spawnSync('git', ['status', '--porcelain'], { cwd: dir, encoding: 'utf8' });
  if (statusRes.status !== 0) {
    return { committed: false, ok: false, stderr: statusRes.stderr || `git status exited ${statusRes.status}` };
  }
  if (!statusRes.stdout.trim()) {
    return { committed: false, ok: true };
  }
  const commitRes = spawnSync(
    'git',
    ['-c', 'user.name=harness', '-c', 'user.email=harness@local', 'commit', '-q', '-m', message],
    { cwd: dir, encoding: 'utf8', timeout: 15000 }
  );
  if (commitRes.status !== 0) {
    return { committed: false, ok: false, stderr: commitRes.stderr || `git commit exited ${commitRes.status}` };
  }
  return { committed: true, ok: true };
}

// A killed transaction holder leaves `.lock` behind forever — nothing ever
// removes it on a crash. Past this age, assume its owner is dead rather than
// wedging the store for every future writer.
const STALE_LOCK_MS = 10 * 60 * 1000;

/** Roll back the store's working tree to its last commit: `git reset --hard`
 * undoes tracked changes, `git clean -fd` sweeps untracked files/dirs. Used
 * on any transaction failure (fn threw, or the final stage+commit itself
 * failed) — one implementation, shared by every adopter via
 * withStoreTransaction, replacing what used to be duplicated inline in
 * apply.mjs. Exported so a `fn` body that itself makes an intermediate
 * sub-commit (e.g. apply.mjs's recordContentFailure) can discard JUST that
 * partial write on its own sub-commit failure, keeping the tree clean before
 * returning — otherwise withStoreTransaction's own finalize step would
 * inherit the dirt and risk masking the real rejection behind a generic
 * commit-failure error. */
export function rollbackStore(dir) {
  spawnSync('git', ['reset', '--hard'], { cwd: dir, encoding: 'utf8' });
  spawnSync('git', ['clean', '-fd'], { cwd: dir, encoding: 'utf8' });
}

/**
 * The exact shape absorbHandEdits (admin.mjs) treats as an absorbable hand
 * edit: a `learnings/<domain>/<slug>.md` path. Exported so admin.mjs's own
 * porcelain scan and withStoreTransaction's rollback guard (below) share ONE
 * definition of "this dirty path is protectable content, not incidental
 * debris" — the two must never drift apart, since the guard's whole job is
 * to protect exactly what absorb would have protected.
 */
export const LEARNING_FILE_RE = /^learnings\/([^/]+)\/([^/]+)\.md$/;

/** Parse one `git status --porcelain` line into its status code and path —
 * shared by admin.mjs's absorbHandEdits scan and dirtyLearningFilePaths
 * below (same rename-arrow and git-quoting handling either way). */
export function parsePorcelainLine(line) {
  const status = line.slice(0, 2);
  let rest = line.slice(3);
  const arrow = rest.indexOf(' -> ');
  if (arrow !== -1) rest = rest.slice(arrow + 4); // rename/copy: use the new path
  if (rest.startsWith('"') && rest.endsWith('"')) {
    rest = rest.slice(1, -1).replace(/\\(.)/g, '$1'); // git-quoted path (rare)
  }
  return { status, path: rest };
}

/**
 * The set of currently-dirty paths that LOOK like a learning file
 * absorbHandEdits would treat as an absorbable hand edit — used by
 * withStoreTransaction's rollback guard (below) to tell "content a
 * StoreTransactionAbort is protecting" apart from ordinary dirt (this
 * transaction's own fresh mutation writes, or unrelated debris like a test
 * fixture) that a rollback is always safe to discard. Deliberately narrow:
 * matching the SAME shape absorb itself would absorb, nothing broader —
 * a plain "was the tree dirty at all" check would also protect things that
 * were never at risk (a colliding non-.md file, an unrelated stray write),
 * which is exactly precise enough to be wrong.
 */
function dirtyLearningFilePaths(dir) {
  const res = spawnSync('git', ['status', '--porcelain'], { cwd: dir, encoding: 'utf8' });
  if (res.status !== 0 || !res.stdout.trim()) return new Set();
  const paths = new Set();
  for (const line of res.stdout.split('\n')) {
    if (!line.trim()) continue;
    const { path: rel } = parsePorcelainLine(line);
    if (LEARNING_FILE_RE.test(rel)) paths.add(rel);
  }
  return paths;
}

/**
 * Thrown by a withStoreTransaction `fn` to signal a failure that must NOT
 * trigger the standard rollback (git reset --hard + clean -fd). Reserved for
 * exactly one situation today: absorbHandEdits' own sub-commit failed for a
 * REAL reason (see admin.mjs's absorbOrAbort) — at that point the working
 * tree holds a legitimate, uncommitted human edit that absorbHandEdits
 * itself already wrote. The standard rollback would destroy it outright,
 * with nothing left recording the edit ever happened. withStoreTransaction's
 * catch recognizes this type and skips both the stage/commit attempt AND the
 * rollback: the lock is still released, the failure still reported with
 * `ok: false`, but the tree is left exactly as `fn` last touched it.
 */
export class StoreTransactionAbort extends Error {
  constructor(message, { stderr } = {}) {
    super(message);
    this.name = 'StoreTransactionAbort';
    this.stderr = stderr || null;
  }
}

/**
 * The single-writer transaction every store mutator (applyOps,
 * setLearningStatus, purgeEpisode, purgeAll, rebuildStore's --yes path,
 * writeStoreConfig — six primary adopters, each with exactly one call site)
 * runs inside. remember.mjs adds a 7th call site — its own best-effort
 * post-failure ledger-cleanup transaction — which is not a new mutating
 * capability of its own (remember's real write goes through applyOps like
 * every other caller) but still follows the SAME absorb-first invariant
 * (via absorbOrAbort, admin.mjs) as the six primary adopters, for exactly
 * the reason every adopter needs it: it can inherit a dirty, uncommitted
 * hand edit left behind by an EARLIER transaction's aborted absorb, and
 * must not silently ignore it.
 *
 * Closes three race windows a security review found in the pre-transaction
 * design: the lock started too late (state was read and validated before
 * the lock existed), ended too early (released before the final commit, so
 * a losing writer could interleave with an in-flight commit), and several
 * writers never took it at all.
 *
 * Deliberately OUTSIDE this transaction (by design, not oversight):
 *   - orient/consolidate --status/--candidates/learnings reads: pure reads
 *     never need the lock — a stale read is harmless (the caller doesn't act
 *     on it under an assumption of freshness the way a writer's validation
 *     does), and locking every read would serialize the CLI's most common,
 *     latency-sensitive path against every writer for no safety benefit.
 *   - index's stale.json write: recomputed CLI-local cache state, not
 *     store-of-record content — safe to race, self-heals on the next index run.
 *   - mirrorLearnings: runs AFTER a transaction's own commit succeeds, never
 *     inside it — it writes into the WORKSPACE (docs/knowledge/learnings/),
 *     not the store, so it was never store state the lock needed to cover.
 *
 * Acquires `.lock` (mkdir + stale-takeover-via-rename — moved here from
 * apply.mjs so there is exactly one implementation) BEFORE calling
 * `fn({ dir, git })`. `fn` is expected to mutate the store directly and
 * return a plain result value describing what happened; it may perform its
 * OWN sub-commits when it needs more than one checkpoint inside this same
 * lock (e.g. absorbHandEdits's self-contained "human edit: <ids>" commit,
 * simply invoked from inside `fn` now instead of before the lock existed —
 * that earlier sub-commit is what a later rollback in this same transaction
 * lands on, never before it).
 *
 * On `fn` returning normally: stage + commit whatever `fn` left uncommitted,
 * using `(result && result.commitMessage) || label` as the message. A real
 * git failure at either step triggers rollback and is reported as
 * `ok: false, rolledBack: true`. A store with no git (`ensureStore` degraded)
 * skips staging entirely and reports `committed: false` — the same tolerant
 * default the rest of the store's degraded modes use.
 *
 * On `fn` throwing: rollback, then report `ok: false, rolledBack: true,
 * error` — UNLESS the thrown value is a StoreTransactionAbort, in which case
 * rollback is skipped entirely and `rolledBack: false` (see the class doc
 * comment above).
 *
 * The lock is released in `finally`, AFTER the commit or rollback above
 * completes — never before.
 *
 * Non-reentrant by design: `fn` must never call withStoreTransaction again
 * (it would simply E_LOCKED against its own held lock).
 */
export function withStoreTransaction(workspace, { home, label } = {}, fn) {
  const { dir, git } = ensureStore(workspace, { home });
  const lockPath = path.join(dir, '.lock');
  let staleLockNote = null;
  try {
    fs.mkdirSync(lockPath);
  } catch {
    let stat;
    try {
      stat = fs.statSync(lockPath);
    } catch {
      stat = null;
    }
    const ageMs = stat ? Date.now() - stat.mtimeMs : 0;
    let recovered = false;
    if (stat && ageMs > STALE_LOCK_MS) {
      const tombstone = `${lockPath}.stale-${process.pid}-${Date.now()}`;
      let claimed = false;
      try {
        fs.renameSync(lockPath, tombstone);
        claimed = true;
      } catch {
        claimed = false; // another process already won the takeover race
      }
      if (claimed) {
        try {
          fs.mkdirSync(lockPath);
          staleLockNote = `stale lock (${Math.round(ageMs / 60000)}m old) removed`;
          recovered = true;
        } catch {
          recovered = false;
        }
        try {
          fs.rmSync(tombstone, { recursive: true, force: true });
        } catch {
          // ignored — an orphaned tombstone is harmless disk debris either way
        }
      }
    }
    if (!recovered) {
      return { ok: false, locked: true, rolledBack: false, error: null, committed: false, result: null, dir, git, staleLockNote: null };
    }
  }

  // Snapshot BEFORE calling fn: which dirty paths already looked like an
  // absorbable hand edit? Both the fn-throw catch AND the finalize-commit-
  // failure branch below funnel through guardedRollback, which uses this
  // snapshot to decide whether a rollback is even safe. This is not only
  // about a REAL absorb-commit failure inside THIS SAME transaction (a
  // StoreTransactionAbort, already handled by its own short-circuit below) —
  // a SEPARATE, LATER transaction (e.g. remember.mjs's post-failure ledger
  // cleanup) can start with that same pre-existing, still-uncommitted hand
  // edit sitting in the tree, inherited from an EARLIER transaction's
  // aborted absorb, without its own `fn` ever touching it.
  const entryProtectedPaths = git ? dirtyLearningFilePaths(dir) : new Set();

  /**
   * Roll back UNLESS doing so would discard content this transaction did
   * not itself author or safely capture. `git reset --hard` always discards
   * every uncommitted change regardless of which ref it targets — there is
   * no "safer target" that resets history while also preserving dirty
   * working-tree content — so the only way to protect pre-existing dirt is
   * to skip the reset (and the paired `clean -fd`) entirely.
   *
   * Protection applies precisely when at least one path that was ALREADY
   * dirty-and-learning-file-shaped before `fn` ran is STILL dirty right now.
   * Deliberately path-scoped, not a blanket "was the tree dirty at entry":
   * that broader check would also protect content that was never actually
   * at risk — e.g. a fixture's unrelated stray file sitting in the store dir
   * — which is imprecise in exactly the wrong direction. "Still dirty" is
   * what tells success from danger for a path that WAS in this set: if `fn`
   * (or the finalize commit) captured it in a commit (e.g. absorb
   * succeeded), it no longer shows up as dirty and a normal
   * `git reset --hard` is safe — it lands on that commit, not before it (the
   * batch-A "lands on the absorb commit" invariant, unchanged). Only a path
   * that's STILL dirty was never captured by any commit at all, and must be
   * left exactly where it is.
   */
  function guardedRollback() {
    if (!git) return false;
    if (entryProtectedPaths.size > 0) {
      const stillDirty = dirtyLearningFilePaths(dir);
      const stillProtected = [...entryProtectedPaths].some((p) => stillDirty.has(p));
      if (stillProtected) return false;
    }
    rollbackStore(dir);
    return true;
  }

  try {
    let result;
    try {
      result = fn({ dir, git });
    } catch (err) {
      const isAbort = err instanceof StoreTransactionAbort;
      const rolledBack = isAbort ? false : guardedRollback();
      return { ok: false, locked: false, rolledBack, error: err, committed: false, result: null, dir, git, staleLockNote };
    }
    let commitRes = { committed: false, ok: true };
    if (git) {
      commitRes = commitStore(dir, (result && result.commitMessage) || label || 'harness: update store');
    }
    if (!commitRes.ok) {
      const rolledBack = guardedRollback();
      return {
        ok: false,
        locked: false,
        rolledBack,
        error: new Error(commitRes.stderr || 'git commit failed'),
        committed: false,
        result: null,
        dir,
        git,
        staleLockNote,
      };
    }
    return { ok: true, locked: false, rolledBack: false, error: null, committed: commitRes.committed, result, dir, git, staleLockNote };
  } finally {
    // The rollback above may have already removed the untracked .lock
    // directory via `git clean -fd` — tolerate that instead of throwing.
    fs.rmSync(lockPath, { recursive: true, force: true });
  }
}

/** Lowercase, diacritic-stripped, [a-z0-9-] slugs — case-insensitive-FS safe. */
export function normalizeSlug(text) {
  return (
    String(text)
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'learning'
  );
}

/**
 * Stale-anchor exclusions: CLI state recomputed by `harness index`, not a
 * learning write. Tolerant of an absent or corrupt file — a fresh or damaged
 * store never blocks retrieval.
 */
export function readStaleExclusions(dir) {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(dir, 'stale.json'), 'utf8'));
    if (parsed && parsed.excluded && typeof parsed.excluded === 'object') {
      return { excluded: parsed.excluded };
    }
  } catch {
    // absent, unreadable, or corrupt — tolerant default
  }
  return { excluded: {} };
}

export function writeStaleExclusions(dir, data) {
  fs.writeFileSync(path.join(dir, 'stale.json'), JSON.stringify(data) + '\n', 'utf8');
}
