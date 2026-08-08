/**
 * `tree <subject>` — structural navigation (P2.3).
 *
 * `search` answers "what matches" and `lookup` answers "what is this exactly".
 * Neither answers "what is there", which is the question an operator asks
 * first and the one the architecture doc's §tree assigns to a single
 * navigation verb rather than to a per-family `<x> tree` subcommand.
 *
 * Two decisions in here are load-bearing and are the reason this is not a
 * `readdirSync` walk:
 *
 * 1. The workspace tree enumerates through `trackedSourceFiles` (`git
 *    ls-files`, bounded at MAX_FILES_SCANNED, extension-filtered). A raw
 *    filesystem walk would render `node_modules/`, `dist/` and `.harness/`
 *    into the same tree as the source — burying the answer under build
 *    output — and would descend through a symlinked directory straight out
 *    of the workspace. git's index carries neither problem: it lists only
 *    what the repo actually tracks, and a symlink is one entry, not a door.
 *    The cost is that the tree shows tracked SOURCE files only (the
 *    extensions in `SOURCE_EXTENSIONS`), which is stated in the result via
 *    `limits.filesUnscanned` rather than left for a caller to discover.
 *
 * 2. Read-path invariant (P2AC6): navigation NEVER creates. The learnings
 *    group is reached by probing `storeDir` with `fs.existsSync` and calling
 *    `listLearnings` only on a hit — never `ensureStore`, never anything on
 *    the seeding path. A `tree` that materialized a knowledge store as a side
 *    effect of being run would make the store's own existence untrustworthy
 *    as a signal, which is exactly what `harness status` reads it as.
 *
 * Determinism (P2AC3) is a property of the builder, not of the caller:
 * children sort by (type, name) with directories first, using code-unit
 * comparison rather than `localeCompare` — an ICU/locale-sensitive collation
 * would order the same tree differently on two machines and break the
 * byte-identity guarantee the retrieval layer publishes.
 */
import fs from 'node:fs';
import path from 'node:path';
import { EXIT } from '../style.mjs';
import { redactSecrets } from '../secret-scan.mjs';
import { safeResolveUnderRoot } from '../path-safe.mjs';
import { trackedSourceFiles } from '../repo-map/scan.mjs';
import { loadManifest } from '../recall-rank.mjs';
import { loadCollections, entryMatchesCollection } from '../recall-config.mjs';
import { storeDir, listLearnings } from '../knowledge/store.mjs';

export const TREE_SCHEMA = 1;

/** The subjects this phase implements, in the order the architecture doc lists them. */
export const TREE_SUBJECTS = Object.freeze(['workspace', 'knowledge']);

/**
 * Subjects the doc names whose corpora do not exist yet. Carried in the usage
 * hint rather than silently absent: a caller who types `tree run` needs to
 * learn the subject is unbuilt, not that they misspelled something.
 */
export const PENDING_SUBJECTS = Object.freeze({
  run: 'Phase 4a (durable runs)',
  resources: 'Phase 5 (resources and plugins)',
});

export const DEFAULT_DEPTH = 3;

/**
 * Depth is bounded because it is the one knob that turns a cheap navigation
 * call into an unbounded render: every extra level multiplies the node count
 * a renderer and a TUI pane must hold. Ten levels is deeper than any tracked
 * source tree this harness has met, so the bound refuses nonsense without
 * refusing real trees.
 */
export const MAX_DEPTH = 10;

/**
 * Hard node ceiling. Depth alone does not bound output — one directory with
 * 40,000 tracked files is three levels deep and still unrenderable. The cap
 * is enforced over the SORTED tree in pre-order, so what survives is exactly
 * the first N rows of the rendered tree and the same input always drops the
 * same nodes.
 */
export const MAX_NODES = 2000;

function usageError(message, hint) {
  return Object.assign(new Error(message), { code: 'E_USAGE', exit: EXIT.usage, hint });
}

function notFoundError(message, hint) {
  return Object.assign(new Error(message), { code: 'E_NOT_FOUND', exit: EXIT.notFound, hint });
}

function resolveDepth(depth) {
  if (depth === undefined || depth === null || depth === '') return DEFAULT_DEPTH;
  const n = Number(depth);
  // `Number.isInteger` rejects NaN, 3.5 and Infinity in one test, so `--depth
  // deep` and `--depth 2.5` fail as usage errors instead of silently becoming
  // a default or a fractional level comparison.
  if (!Number.isInteger(n) || n < 1) {
    throw usageError(`--depth must be a whole number of levels, got ${JSON.stringify(depth)}`, `1..${MAX_DEPTH}`);
  }
  if (n > MAX_DEPTH) {
    throw usageError(`--depth ${n} exceeds the maximum of ${MAX_DEPTH}`, `use --depth ${MAX_DEPTH} or less`);
  }
  return n;
}

/**
 * Normalize a caller-supplied subtree path to a workspace-relative POSIX path.
 * Returns `''` for "the whole workspace" and `null` for a path that escapes it.
 * Backslashes are folded first because the primary hosts are Windows, where a
 * caller types `lib\retrieval` and node's POSIX resolver would otherwise treat
 * the whole thing as one segment name.
 */
function normalizeRelative(raw) {
  const posixish = String(raw).replace(/\\/g, '/');
  if (posixish.startsWith('/') || /^[A-Za-z]:/.test(posixish)) return null;
  const norm = path.posix.normalize(posixish).replace(/\/+$/, '');
  if (norm === '.' || norm === '') return '';
  if (norm === '..' || norm.startsWith('../')) return null;
  return norm;
}

function makeNode({ name, type, kind = null, title = null, location = null, status = null, counts = null }) {
  // Keys are assigned in one fixed order on every path so `JSON.stringify` of
  // two structurally identical trees is byte-identical; an optional field
  // assigned conditionally after `children` would reorder the object.
  const node = { name, type };
  if (kind) node.kind = kind;
  if (title) node.title = title;
  if (location) node.location = location;
  if (status) node.status = status;
  node.children = [];
  node.counts = counts || { files: 0, dirs: 0 };
  return node;
}

function compareNodes(a, b) {
  if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

function sortTree(node) {
  node.children.sort(compareNodes);
  for (const child of node.children) sortTree(child);
  return node;
}

function subtreeSize(node) {
  let n = 1;
  for (const child of node.children) n += subtreeSize(child);
  return n;
}

/** Pre-order budgeted clone: keep the first `remaining` nodes, drop the rest. */
function applyNodeCap(node, state) {
  if (state.remaining <= 0) {
    state.dropped += subtreeSize(node);
    return null;
  }
  state.remaining -= 1;
  const out = { ...node, children: [] };
  for (const child of node.children) {
    const kept = applyNodeCap(child, state);
    if (kept) out.children.push(kept);
  }
  return out;
}

/**
 * Build a node tree from flat rows. A row is `{ parts: [...] }` where every
 * part is a `makeNode` descriptor and the LAST part is the leaf — one uniform
 * shape so the workspace subject (path segments) and the knowledge subject
 * (scope → category → document, and learnings → domain → learning) share one
 * builder and therefore one determinism and bounding story.
 *
 * Counts are computed over EVERY row, including rows the depth bound elides,
 * so a directory rendered with no children still reports how much sits beneath
 * it. Reporting only what survived the cut would make a pruned tree read as an
 * empty one — the difference between "nothing here" and "more here than you
 * asked to see".
 */
function buildTree({ rootName, rows, depth, maxNodes }) {
  // First-wins dedup over a sorted key list: a manifest can legitimately
  // repeat a docid, and a duplicate leaf would both double the counts and
  // make the output depend on row order.
  const byKey = new Map();
  for (const row of rows) {
    const key = row.parts.map((p) => p.name).join('/');
    if (!byKey.has(key)) byKey.set(key, row);
  }
  const unique = [...byKey.keys()].sort().map((k) => byKey.get(k));

  const counts = new Map();
  const bump = (key) => {
    let c = counts.get(key);
    if (!c) {
      c = { files: 0, dirs: 0 };
      counts.set(key, c);
    }
    return c;
  };
  const dirPrefixes = new Set();

  for (const row of unique) {
    let prefix = '';
    bump(prefix).files += 1;
    for (const part of row.parts.slice(0, -1)) {
      prefix = prefix ? `${prefix}/${part.name}` : part.name;
      bump(prefix).files += 1;
      dirPrefixes.add(prefix);
    }
  }
  for (const dir of dirPrefixes) {
    let prefix = '';
    bump(prefix).dirs += 1;
    for (const seg of dir.split('/').slice(0, -1)) {
      prefix = prefix ? `${prefix}/${seg}` : seg;
      bump(prefix).dirs += 1;
    }
  }

  const rootCounts = counts.get('') || { files: 0, dirs: 0 };
  const root = makeNode({ name: rootName, type: 'dir', counts: rootCounts });
  const index = new Map([['', root]]);

  for (const row of unique) {
    const dirs = row.parts.slice(0, -1);
    let prefix = '';
    let parent = root;
    let level = 0;
    for (const part of dirs) {
      level += 1;
      // Directories materialize up to `depth` even when everything inside
      // them is deeper, so `--depth 3` still SHOWS the level-3 directory (with
      // its full counts) instead of erasing it along with its contents.
      if (level > depth) break;
      prefix = prefix ? `${prefix}/${part.name}` : part.name;
      let node = index.get(prefix);
      if (!node) {
        node = makeNode({ ...part, type: 'dir', counts: counts.get(prefix) });
        index.set(prefix, node);
        parent.children.push(node);
      }
      parent = node;
    }
    // A leaf sits one level below its deepest directory; below the bound it is
    // elided, but its contribution to every ancestor's counts already stands.
    if (dirs.length + 1 <= depth) {
      parent.children.push(makeNode({ ...row.parts[row.parts.length - 1], type: 'file' }));
    }
  }

  sortTree(root);
  const total = subtreeSize(root);
  // Clamped, never raised: an override may only tighten the ceiling, so a
  // caller cannot turn the bound off by passing a large number.
  const cap = Math.max(1, Math.min(Number(maxNodes) || MAX_NODES, MAX_NODES));
  const state = { remaining: cap, dropped: 0 };
  const capped = applyNodeCap(root, state);

  return {
    root: capped,
    files: rootCounts.files,
    dirs: rootCounts.dirs,
    nodes: total - state.dropped,
    nodesDropped: state.dropped,
  };
}

function workspaceTree({ workspace, target, depth, maxNodes }) {
  const root = path.resolve(workspace);
  const { files, total } = trackedSourceFiles(root);

  let scope = '';
  if (target) {
    const rel = normalizeRelative(target);
    // An escaping path is refused, never quietly answered with an empty tree:
    // an empty tree reads as "nothing tracked there", which would tell a
    // caller their `../../etc` probe found nothing rather than that it was
    // rejected. `safeResolveUnderRoot` additionally refuses a path that
    // traverses a symlinked ancestor, so a scope cannot be steered outside.
    if (rel === null || (rel !== '' && !safeResolveUnderRoot(root, rel))) {
      throw usageError(`path escapes the workspace: ${target}`, 'tree workspace <workspace-relative-path>');
    }
    scope = rel;
  }

  // A scope naming a tracked FILE resolves to that file under its own parent,
  // rather than to an empty tree, so `tree workspace lib/a.mjs` is answerable.
  const scopedFile = scope && files.includes(scope);
  const prefix = scope ? `${scope}/` : '';
  const rels = scopedFile
    ? [path.posix.basename(scope)]
    : files.filter((f) => !scope || f.startsWith(prefix)).map((f) => (scope ? f.slice(prefix.length) : f));

  const rootName = scopedFile ? path.posix.dirname(scope) : scope || '.';
  const built = buildTree({
    rootName,
    rows: rels.map((rel) => ({ parts: rel.split('/').map((name) => ({ name })) })),
    depth,
    maxNodes,
  });

  // The enumerator itself is capped at MAX_FILES_SCANNED, so a repo larger
  // than that yields a tree that is complete-looking but partial. That is the
  // same class of omission as the node cap and is reported as truncation.
  const filesUnscanned = Math.max(0, total - files.length);
  return {
    schema: TREE_SCHEMA,
    subject: 'workspace',
    target: scope || null,
    depth,
    root: built.root,
    totals: { files: built.files, dirs: built.dirs, nodes: built.nodes, tracked: total },
    truncated: built.nodesDropped > 0 || filesUnscanned > 0,
    limits: { depth, maxNodes: MAX_NODES, nodesDropped: built.nodesDropped, filesUnscanned },
  };
}

/** Manifest free text can carry a pasted credential; a null stays null. */
function clean(value) {
  if (value === undefined || value === null || value === '') return null;
  return redactSecrets(String(value));
}

function knowledgeTree({ workspace, copilotHome, home, target, depth, maxNodes }) {
  const collections = loadCollections(copilotHome, workspace) || {};
  const names = Object.keys(collections).sort();
  if (target && !collections[target]) {
    // Naming the collections that DO exist turns a typo into a one-step fix;
    // `entryMatchesCollection` would otherwise filter every entry away and the
    // caller would read an empty corpus instead of a wrong name.
    throw notFoundError(
      `unknown knowledge collection: ${target}`,
      names.length
        ? `collections defined here: ${names.join(', ')}`
        : 'no collections are defined — add a collections.yaml under the knowledge root',
    );
  }

  const manifest = loadManifest(copilotHome, workspace);
  const rows = [];
  for (const entry of manifest.entries || []) {
    if (!entry || typeof entry !== 'object') continue;
    if (!entryMatchesCollection(entry, target || null, collections)) continue;
    const id = clean(entry.docid || entry.id || entry.path);
    if (!id) continue;
    rows.push({
      parts: [
        // `scope` is the code-set 'global' | 'product' qualifier, not free
        // text, so it is left unredacted for the same reason the kernel leaves
        // it alone. `category` comes from document frontmatter and is not.
        { name: String(entry.scope || 'unscoped'), kind: 'scope' },
        { name: clean(entry.category) || 'uncategorized', kind: 'category' },
        { name: id, kind: 'document', title: clean(entry.title), location: clean(entry.path) },
      ],
    });
  }

  const dir = storeDir(workspace, { home });
  // Existence probe ONLY (P2AC6). `listLearnings` on a missing directory
  // returns empty, but calling it unconditionally would still be a claim that
  // navigation may touch the store's layout; probing first keeps the read path
  // provably inert on a workspace that has never compounded anything.
  const hasStore = fs.existsSync(dir);
  // A collection filter selects MANIFEST entries. Learnings are not manifest
  // entries and no collection spec can address them, so including them under a
  // filtered view would present rows the collection did not select.
  if (hasStore && !target) {
    for (const learning of listLearnings(dir)) {
      rows.push({
        parts: [
          { name: 'learnings', kind: 'learnings' },
          { name: clean(learning.domain) || 'uncategorized', kind: 'domain' },
          {
            name: clean(learning.slug || learning.id) || 'unnamed',
            kind: 'learning',
            title: clean(learning.fm?.trigger),
            location: null,
            // Governance state rides along so a quarantined learning is
            // visible where an operator is already looking, rather than only
            // through a separate admin command.
            status: clean(learning.fm?.status) || 'active',
          },
        ],
      });
    }
  }

  const built = buildTree({ rootName: 'knowledge', rows, depth, maxNodes });
  return {
    schema: TREE_SCHEMA,
    subject: 'knowledge',
    target: target || null,
    depth,
    root: built.root,
    totals: { files: built.files, dirs: built.dirs, nodes: built.nodes },
    truncated: built.nodesDropped > 0,
    limits: { depth, maxNodes: MAX_NODES, nodesDropped: built.nodesDropped, filesUnscanned: 0 },
    collections: names,
    manifest: manifest.path ? { path: manifest.path, updated: manifest.updated ?? null, error: manifest.error ?? null } : null,
    learningsStore: hasStore,
  };
}

/**
 * Navigate one corpus structurally. Throws `E_USAGE` (exit 2) for an unknown
 * subject, an out-of-range depth or an escaping path, and `E_NOT_FOUND`
 * (exit 9) for a named collection that does not exist — the same split
 * `lookup` publishes, so a caller scripting against either command reads one
 * error model rather than two.
 */
export function runTree({ subject, target = null, depth, workspace, copilotHome, home, maxNodes } = {}) {
  if (!subject) {
    throw usageError('tree requires a subject', `harness tree <${TREE_SUBJECTS.join('|')}>`);
  }
  if (!TREE_SUBJECTS.includes(subject)) {
    const pending = PENDING_SUBJECTS[subject];
    throw usageError(
      `unknown tree subject: ${subject}`,
      pending
        ? `${subject} arrives with ${pending}; today: ${TREE_SUBJECTS.join(', ')}`
        : `one of ${TREE_SUBJECTS.join(', ')}`,
    );
  }
  const levels = resolveDepth(depth);
  if (subject === 'workspace') return workspaceTree({ workspace, target, depth: levels, maxNodes });
  return knowledgeTree({ workspace, copilotHome, home, target, depth: levels, maxNodes });
}
