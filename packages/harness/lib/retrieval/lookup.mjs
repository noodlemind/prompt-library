/**
 * `lookup <kind> <identifier>` — exact entity retrieval (P2.2, P2AC4).
 *
 * The kind list is settled upstream in
 * `docs/architecture/harness-cli-workbench.md` §lookup and is NOT re-decided
 * here. Identifiers reuse the keys each store already has rather than minting a
 * parallel id scheme: a learning is `<domain>/<slug>` (`knowledge/store.mjs`),
 * an episode is `path@sha256` (`knowledge/consolidate.mjs`, already how
 * consolidation keys them). Neither corpus has an id index, so resolution is a
 * bounded scan — a cost to measure, not an addressability gap, and a second id
 * scheme would fork identity between the store and the retrieval layer.
 *
 * Read-path invariant (P2AC6): every resolver here reads. None creates the
 * knowledge store, and none writes. `storeDir` is only ever probed for
 * existence — `listLearnings` on a missing directory returns empty rather than
 * seeding one.
 */
import fs from 'node:fs';
import path from 'node:path';
import { EXIT } from '../style.mjs';
import { redactSecrets } from '../secret-scan.mjs';
import { readFileNoFollow } from '../fs-safe.mjs';
import { safeResolveUnderRoot } from '../path-safe.mjs';
import { findEntryByDocid, resolveDocPath } from '../recall-rank.mjs';
import { storeDir, listLearnings } from '../knowledge/store.mjs';
import { collectEpisodes } from '../knowledge/consolidate.mjs';
import { readStructuralIndex } from '../structural/shape.mjs';

/** The settled kind list, in the order the architecture doc states it. */
export const LOOKUP_KINDS = Object.freeze([
  'file',
  'symbol',
  'document',
  'plan',
  'skill',
  'check',
  'run',
  'event',
  'resource',
  'learning',
  'episode',
]);

/**
 * One line per kind, for the palette row and `harness help lookup`. Kept beside
 * the kind list so a kind added there without a summary is obvious at a glance
 * rather than rendering a blank row.
 */
export const LOOKUP_KIND_SUMMARIES = Object.freeze({
  file: 'a tracked workspace file by relative path',
  symbol: 'a declaration by name, from the structural index',
  document: 'a knowledge doc by manifest docid',
  plan: 'a plan under docs/plans by filename',
  skill: 'a skill by its directory name under .github/skills',
  check: 'a named check from the trusted check config',
  run: 'a recorded run (Phase 4a)',
  event: 'the events of one session id',
  resource: 'an installed resource bundle (Phase 5)',
  learning: 'a learning by <domain>/<slug>',
  episode: 'an episode by path, or path@sha256',
});

/**
 * Kinds whose entities do not exist yet, mapped to the phase that creates them.
 * They stay in the kind list deliberately: dropping them would make
 * `lookup run` an unknown-kind usage error, which tells a caller the kind is
 * wrong rather than that the store is empty until Phase 4a. Same honesty rule
 * the AC3 and AC7 amendments follow — deliver less than the contract, and say
 * precisely how much less.
 */
export const PENDING_KINDS = Object.freeze({
  run: 'Phase 4a (durable runs) creates the run journal',
  resource: 'Phase 5 (resources and plugins) creates the resource model',
});

const PREVIEW_MAX_BYTES = 2048;
const PREVIEW_MAX_LINES = 40;

export function notFound({ kind, identifier, hint = null, related = [] }) {
  return Object.assign(new Error(`no ${kind} matching ${JSON.stringify(identifier)}`), {
    code: 'E_NOT_FOUND',
    exit: EXIT.notFound,
    hint,
    kind,
    identifier,
    related,
  });
}

function usageError(message, hint) {
  return Object.assign(new Error(message), { code: 'E_USAGE', exit: EXIT.usage, hint });
}

/** Truncate on a UTF-8 boundary, then on a line boundary, then redact. */
function preview(raw) {
  if (typeof raw !== 'string') return null;
  let text = raw.split(/\r?\n/).slice(0, PREVIEW_MAX_LINES).join('\n');
  if (Buffer.byteLength(text, 'utf8') > PREVIEW_MAX_BYTES) {
    const buf = Buffer.from(text, 'utf8').subarray(0, PREVIEW_MAX_BYTES);
    text = buf.toString('utf8').replace(/�+$/, '');
  }
  return redactSecrets(text);
}

/**
 * Read a workspace-relative file through the containment-verified path, the
 * same discipline `get` uses: resolve under the root, then open with O_NOFOLLOW
 * and re-verify the opened inode's realpath sits under that same root, so an
 * ancestor swapped to an outside symlink between the walk and the open is
 * caught rather than trusted from a moment earlier.
 */
function readUnderWorkspace(workspace, rel) {
  const root = path.resolve(workspace);
  const full = safeResolveUnderRoot(root, rel);
  if (!full) return { escaped: true, raw: null, full: null };
  const raw = readFileNoFollow(full, { root });
  return { escaped: false, raw, full };
}

function fileEntity({ workspace, identifier }) {
  const { escaped, raw, full } = readUnderWorkspace(workspace, identifier);
  if (escaped) {
    throw usageError(`path escapes the workspace: ${identifier}`, 'lookup file <workspace-relative-path>');
  }
  if (raw === null) throw notFound({ kind: 'file', identifier, hint: 'lookup file <workspace-relative-path>' });
  return {
    kind: 'file',
    id: identifier,
    location: identifier,
    title: path.basename(identifier),
    provenance: { source: 'workspace', root: path.resolve(workspace) },
    metadata: { bytes: Buffer.byteLength(raw, 'utf8'), lines: raw.split(/\r?\n/).length, absent: !full },
    preview: preview(raw),
    related: [],
  };
}

function symbolEntity({ workspace, identifier, home }) {
  const index = readStructuralIndex(workspace, { home });
  if (!index.present) {
    throw notFound({
      kind: 'symbol',
      identifier,
      hint: `no structural index (${index.reason}) — build one with: harness index --structural`,
    });
  }
  const matches = (index.symbols || []).filter((s) => s.name === identifier);
  if (!matches.length) {
    // Near-miss related entries make a typo recoverable without a second
    // command; capped so a one-character query cannot dump the symbol table.
    const near = (index.symbols || [])
      .filter((s) => typeof s.name === 'string' && s.name.toLowerCase().includes(identifier.toLowerCase()))
      .slice(0, 5)
      .map((s) => ({ kind: 'symbol', id: s.name, location: s.file }));
    throw notFound({ kind: 'symbol', identifier, hint: 'exact symbol name; see related', related: near });
  }
  const first = matches[0];
  return {
    kind: 'symbol',
    id: identifier,
    location: first.file ? `${first.file}:${first.def?.line ?? ''}`.replace(/:$/, '') : null,
    title: identifier,
    provenance: { source: 'structural-index', generation: index.meta?.sha ?? null },
    metadata: {
      definitions: matches.length,
      exported: Boolean(first.exported),
      symbolKind: first.kind ?? null,
      references: Array.isArray(first.refs) ? first.refs.length : 0,
    },
    preview: null,
    related: matches.slice(1, 6).map((s) => ({ kind: 'symbol', id: s.name, location: s.file })),
  };
}

function documentEntity({ workspace, copilotHome, identifier }) {
  const entry = findEntryByDocid(copilotHome, workspace, identifier);
  if (!entry) throw notFound({ kind: 'document', identifier, hint: 'a docid from the knowledge manifest' });
  const resolved = resolveDocPath(copilotHome, workspace, entry);
  const raw = resolved?.full ? readFileNoFollow(resolved.full, { root: resolved.root }) : null;
  return {
    kind: 'document',
    id: entry.docid || entry.id || identifier,
    location: entry.path ?? null,
    title: entry.title ?? null,
    provenance: { source: 'knowledge-manifest', scope: entry.scope ?? null, docKind: entry.kind ?? null },
    metadata: { tags: entry.tags ?? [], module: entry.module ?? null, updated: entry.updated ?? entry.date ?? null },
    preview: preview(raw),
    related: [],
  };
}

function planEntity({ workspace, identifier }) {
  // Plans are addressed by filename or by the full repo-relative path; both
  // resolve to the same file, and neither may escape docs/plans.
  const rel = identifier.startsWith('docs/plans/') ? identifier : path.posix.join('docs/plans', identifier);
  const { escaped, raw } = readUnderWorkspace(workspace, rel);
  if (escaped || raw === null) {
    const dir = path.join(path.resolve(workspace), 'docs', 'plans');
    const near = fs.existsSync(dir)
      ? fs.readdirSync(dir).filter((f) => f.endsWith('.md')).slice(0, 5).map((f) => ({ kind: 'plan', id: f, location: `docs/plans/${f}` }))
      : [];
    throw notFound({ kind: 'plan', identifier, hint: 'a plan filename under docs/plans/', related: near });
  }
  const fm = raw.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? '';
  const field = (name) => fm.match(new RegExp(`^${name}:\\s*(.+)$`, 'm'))?.[1]?.trim().replace(/^["']|["']$/g, '') ?? null;
  return {
    kind: 'plan',
    id: path.posix.basename(rel),
    location: rel,
    title: field('title'),
    provenance: { source: 'workspace', root: path.resolve(workspace) },
    metadata: { status: field('status'), planLock: field('plan_lock'), phase: field('phase'), risk: field('risk') },
    preview: preview(raw),
    related: [],
  };
}

function skillEntity({ workspace, identifier }) {
  const rel = path.posix.join('.github/skills', identifier, 'SKILL.md');
  const { escaped, raw } = readUnderWorkspace(workspace, rel);
  if (escaped || raw === null) {
    throw notFound({ kind: 'skill', identifier, hint: 'a directory name under .github/skills/' });
  }
  const fm = raw.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? '';
  const field = (name) => fm.match(new RegExp(`^${name}:\\s*(.+)$`, 'm'))?.[1]?.trim().replace(/^["']|["']$/g, '') ?? null;
  return {
    kind: 'skill',
    id: identifier,
    location: rel,
    title: field('name') ?? identifier,
    provenance: { source: 'workspace', root: path.resolve(workspace) },
    metadata: { description: field('description'), userInvocable: field('user-invocable') },
    preview: preview(raw),
    related: [],
  };
}

function checkEntity({ workspace, identifier }) {
  const rel = '.github/harness/checks.yaml';
  const { raw } = readUnderWorkspace(workspace, rel);
  if (raw === null) throw notFound({ kind: 'check', identifier, hint: `no ${rel} in this workspace` });
  // Deliberately a line scan rather than a YAML parse: lookup is a read-only
  // navigation command and must not fail because an unrelated part of the file
  // is malformed. Named checks are top-level keys under `checks:`.
  const names = [...raw.matchAll(/^ {2}([A-Za-z0-9._-]+):/gm)].map((m) => m[1]);
  if (!names.includes(identifier)) {
    throw notFound({
      kind: 'check',
      identifier,
      hint: `a named check in ${rel}`,
      related: names.slice(0, 5).map((n) => ({ kind: 'check', id: n, location: rel })),
    });
  }
  const block = raw.split(new RegExp(`^ {2}${identifier}:`, 'm'))[1]?.split(/^ {2}\S/m)[0] ?? '';
  return {
    kind: 'check',
    id: identifier,
    location: rel,
    title: identifier,
    provenance: { source: 'trusted-check-config', root: path.resolve(workspace) },
    metadata: { timeoutSeconds: Number(block.match(/timeout_seconds:\s*(\d+)/)?.[1] ?? 0) || null },
    preview: preview(block.trim()),
    related: [],
  };
}

function learningEntity({ workspace, identifier, home }) {
  const dir = storeDir(workspace, { home });
  // Existence probe only — never create. listLearnings on an absent directory
  // returns empty, which keeps the read-path invariant (P2AC6) intact.
  const all = fs.existsSync(dir) ? listLearnings(dir) : [];
  const hit = all.find((l) => l.id === identifier);
  if (!hit) {
    const near = all
      .filter((l) => l.id.includes(identifier))
      .slice(0, 5)
      .map((l) => ({ kind: 'learning', id: l.id, location: l.file }));
    throw notFound({ kind: 'learning', identifier, hint: 'a learning id in the form <domain>/<slug>', related: near });
  }
  return {
    kind: 'learning',
    id: hit.id,
    location: hit.file ?? null,
    title: hit.fm?.trigger ?? null,
    provenance: {
      source: 'knowledge-store',
      status: hit.fm?.status ?? null,
      origin: hit.fm?.origin ?? null,
      commit: hit.fm?.commit ?? null,
      branch: hit.fm?.branch ?? null,
    },
    metadata: { domain: hit.domain ?? null, slug: hit.slug ?? null, bytes: hit.bytes ?? null },
    preview: preview(hit.body ?? null),
    related: [],
  };
}

function episodeEntity({ workspace, copilotHome, identifier }) {
  const episodes = collectEpisodes({ workspace, copilotHome });
  // `path@sha256` is the whole key, but addressing by bare path is the common
  // case and unambiguous whenever one episode holds that path.
  const byKey = episodes.find((e) => `${e.path}@${e.sha256}` === identifier);
  const byPath = byKey ? null : episodes.filter((e) => e.path === identifier);
  const hit = byKey || (byPath && byPath.length === 1 ? byPath[0] : null);
  if (!hit) {
    const ambiguous = byPath && byPath.length > 1;
    throw notFound({
      kind: 'episode',
      identifier,
      hint: ambiguous
        ? 'that path has several recorded revisions — address one as path@sha256'
        : 'an episode path, or path@sha256',
      related: (ambiguous ? byPath : episodes.slice(0, 5)).slice(0, 5).map((e) => ({
        kind: 'episode',
        id: `${e.path}@${e.sha256}`,
        location: e.path,
      })),
    });
  }
  return {
    kind: 'episode',
    id: `${hit.path}@${hit.sha256}`,
    location: hit.path,
    title: hit.title ?? null,
    provenance: { source: 'episodes', episodeKind: hit.kind ?? null, branch: hit.branch ?? null, date: hit.date ?? null },
    metadata: { sha256: hit.sha256, category: hit.category ?? null, tags: hit.tags ?? [], quarantined: Boolean(hit.quarantined) },
    preview: preview(hit.excerpt ?? null),
    related: [],
  };
}

function eventEntity({ workspace, identifier }) {
  const rel = '.harness/events.jsonl';
  const { raw } = readUnderWorkspace(workspace, rel);
  if (raw === null) throw notFound({ kind: 'event', identifier, hint: `no ${rel} in this workspace` });
  const rows = raw.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  // Events carry no id of their own until the Phase 4a journal, so they are
  // addressed by session id — the only stable handle that exists today. Stated
  // rather than silently reinterpreting the identifier as something else.
  const matches = rows.filter((e) => e.session === identifier || e.sessionId === identifier);
  if (!matches.length) {
    throw notFound({
      kind: 'event',
      identifier,
      hint: 'events are addressed by session id until the Phase 4a run journal gives them stable ids',
    });
  }
  return {
    kind: 'event',
    id: identifier,
    location: rel,
    title: `${matches.length} event(s) for session ${identifier}`,
    provenance: { source: 'events', root: path.resolve(workspace) },
    metadata: { count: matches.length, types: [...new Set(matches.map((e) => e.type).filter(Boolean))].slice(0, 10) },
    preview: preview(matches.slice(0, 10).map((e) => JSON.stringify(e)).join('\n')),
    related: [],
  };
}

const RESOLVERS = {
  file: fileEntity,
  symbol: symbolEntity,
  document: documentEntity,
  plan: planEntity,
  skill: skillEntity,
  check: checkEntity,
  event: eventEntity,
  learning: learningEntity,
  episode: episodeEntity,
};

/**
 * Resolve one entity. Throws `E_USAGE` for a bad kind or missing identifier and
 * `E_NOT_FOUND` (exit 9) when the kind is valid but the entity is absent — the
 * distinction a caller scripting against lookup needs, and the reason
 * not-found does not collapse into either usage or an internal fault.
 */
export function lookupEntity({ kind, identifier, workspace, copilotHome, home }) {
  if (!kind) throw usageError('lookup requires a kind', `harness lookup <${LOOKUP_KINDS.join('|')}> <identifier>`);
  if (!LOOKUP_KINDS.includes(kind)) {
    throw usageError(`unknown lookup kind: ${kind}`, `one of ${LOOKUP_KINDS.join(', ')}`);
  }
  if (!identifier) throw usageError(`lookup ${kind} requires an identifier`, `harness lookup ${kind} <identifier>`);
  if (PENDING_KINDS[kind]) {
    throw notFound({ kind, identifier, hint: `${PENDING_KINDS[kind]}; nothing of this kind exists yet` });
  }
  const entity = RESOLVERS[kind]({ kind, identifier, workspace, copilotHome, home });
  return { schema: 1, ...entity };
}
