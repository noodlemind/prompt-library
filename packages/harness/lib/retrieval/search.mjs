/**
 * `search <query>` — five match modes over four corpora (P2.1, P2AC1).
 *
 * Every mode lands in the SAME federation: each corpus reports one
 * `{ source, status, results, generation, reason }` entry and `federate`
 * (kernel.mjs) owns normalization, dedup, ordering and paging. Nothing here
 * re-scores or re-sorts after it. A second ordering pass is precisely how the
 * byte-identity guarantee (P2AC3) rots — two sorts that agree today drift the
 * first time one of them gains a tie-break — so the only sorting below is
 * candidate SELECTION inside a corpus, before federation, and it uses the same
 * `(score desc, id asc)` shape the kernel does.
 *
 * Scores stay NATIVE per corpus and are deliberately not comparable across
 * corpora: a BM25-derived 0..1, a token-hit ratio, a matched-line count, a
 * symbol exactness rank. `normalizeSourceScores` inside `federate` is the one
 * place that makes them comparable, which is why nothing here pre-normalizes.
 *
 * Read-path invariant (P2AC6): every corpus is PROBED before it is read — the
 * knowledge store directory, the manifest, `docs/plans`, the structural index —
 * and nothing on this path calls `ensureStore` or any other seeding routine. A
 * corpus that is not there reports `status: 'skipped'` with the reason, never an
 * empty `ok`: "nothing matched" and "there was nothing to match against" mean
 * opposite things to the caller, and the kernel exists partly to keep them
 * distinguishable.
 *
 * Bounds are stated rather than incidental. `trackedSourceFiles` caps the file
 * enumeration, `readFileSafe` caps every read, `SOURCE_CANDIDATE_CAP` caps how
 * many rows one corpus may push into the federation, and `regex` is bounded
 * twice — pattern length and per-line evaluation.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { EXIT } from '../style.mjs';
import { redactSecrets } from '../secret-scan.mjs';
import { assertNoSymlinkAncestors } from '../fs-safe.mjs';
import { tokenize, FIELD_BOOSTS } from '../tokenize.mjs';
import { loadPostingsIndex, isIndexStale } from '../postings-index.mjs';
import { loadManifest, rankRecall, findMatchingPlans } from '../recall-rank.mjs';
import { loadCollections, entryMatchesCollection, resolveIndexDir } from '../recall-config.mjs';
import { storeDir, inertLine, readStaleExclusions } from '../knowledge/store.mjs';
import { rankLearnings, retrievalExclusion } from '../knowledge/retrieve.mjs';
import { loadLayeredLearnings } from '../knowledge/overlay.mjs';
import { trackedSourceFiles, readFileSafe } from '../repo-map/scan.mjs';
import { readStructuralIndex } from '../structural/shape.mjs';
import { SOURCES, createRetrievalResult, federate } from './kernel.mjs';

/** The settled mode list, in the order the architecture doc states it. */
export const MATCH_MODES = Object.freeze(['ranked', 'literal', 'regex', 'path', 'symbol']);
export const DEFAULT_MATCH_MODE = 'ranked';

/**
 * A regex is the one caller-supplied program this command runs, so it is bounded
 * on both axes an adversarial pattern can exploit. Pattern length caps how much
 * nesting can be expressed at all; the per-line cap bounds the input any single
 * evaluation sees, which is what actually defuses catastrophic backtracking —
 * the blow-up is superlinear in SUBJECT length, so matching a 200 KB file as one
 * string is the hazard and matching it line by line is not.
 */
export const REGEX_MAX_PATTERN = 200;
export const REGEX_MAX_LINE = 2000;

/**
 * How many rows one corpus may contribute. Federation pages the merged set, but
 * an unbounded per-source list still has to be built, scored and held first — a
 * single-letter `literal` query against a large tree would otherwise materialize
 * one row per tracked file before `limit` ever applied.
 */
const SOURCE_CANDIDATE_CAP = 200;

/** Counting stops here per file: the count is a relevance signal, not a census,
 * and a generated file with 100k hits does not deserve 100k iterations. */
const MATCHED_LINE_CAP = 1000;

const SNIPPET_MAX = 160;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const PLANS_DIR_REL = 'docs/plans';

/**
 * `findMatchingPlans` scores the first 4000 characters of a plan and nothing
 * else. `--explain` therefore tokenizes exactly that head: explaining over the
 * whole file would list terms that never contributed to the score it is
 * explaining, which is worse than no explanation.
 */
const PLAN_RANK_HEAD = 4000;

/**
 * Scopes the architecture doc names that no kernel corpus backs yet. They are
 * refused BY NAME with the reason rather than silently accepted and returned
 * empty — the same rule lookup.mjs's PENDING_KINDS follows, for the same reason:
 * an empty result and an unbacked scope mean opposite things, and a caller who
 * cannot tell them apart will conclude the corpus is clean.
 */
const PENDING_SOURCES = Object.freeze({
  skills: 'skills have no kernel corpus yet — reach them with --match path',
  checks: 'checks have no kernel corpus yet — reach one with: harness lookup check <name>',
  events: 'events have no kernel corpus yet — reach them with: harness lookup event <session>',
  runs: 'the Phase 4a run journal creates the run corpus',
});

/**
 * Which corpora each mode can actually serve, stated as the REASON a mode
 * cannot serve one. Holding it in one table is what makes an unsupported
 * (mode, source) pair a reported skip instead of a silent drop: a mode that
 * simply omitted a corpus from its fan-out would report nothing at all about it.
 */
const MODE_UNSUPPORTED = Object.freeze({
  ranked: {
    code: 'ranked match needs a content index and code has none — use --match literal, regex, path, or symbol',
  },
  literal: {},
  regex: {},
  path: {
    learnings: 'learnings are addressed by <domain>/<slug>, not by path — use --match ranked or literal',
  },
  symbol: {
    knowledge: 'the structural index covers code only',
    learnings: 'the structural index covers code only',
    plans: 'the structural index covers code only',
  },
});

function usageError(message, hint) {
  return Object.assign(new Error(message), { code: 'E_USAGE', exit: EXIT.usage, hint });
}

/** A corpus entry federate accepts, in the one shape every helper below returns. */
const sourceEntry = (source, status, { reason = null, generation = null, results = [] } = {}) => ({
  source,
  status,
  reason,
  generation,
  results,
});

const skipped = (source, reason) => sourceEntry(source, 'skipped', { reason });
const failed = (source, reason) => sourceEntry(source, 'failed', { reason });

/**
 * REDACT BEFORE THE CAP. Slicing first can cut a credential in half and leave
 * the surviving fragment unmatched — and therefore unredacted — by the pattern
 * that would have caught it whole. `createRetrievalResult` redacts again at the
 * data boundary; that second pass is a backstop, not this one's substitute.
 * `inertLine` collapses C0/DEL so an untrusted line cannot break a single-row
 * render into fabricated rows.
 */
function snippetOf(text) {
  if (typeof text !== 'string' || !text) return null;
  const flat = inertLine(redactSecrets(text)).trim();
  return flat ? flat.slice(0, SNIPPET_MAX) : null;
}

function digestOf(parts) {
  return `sha256:${crypto.createHash('sha256').update(parts.join('\n')).digest('hex').slice(0, 16)}`;
}

/**
 * The generation for corpora that live in the working tree (code, plans): the
 * commit the workspace is on. Its known limitation — an uncommitted edit does
 * not move it — is the same one `meta.sha` carries in the structural index, so
 * the two agree rather than each being wrong in its own direction. Null outside
 * a git repository, which is honest: there is no generation to report.
 */
function workspaceGeneration(workspace) {
  const res = spawnSync('git', ['-C', workspace, 'rev-parse', 'HEAD'], { encoding: 'utf8', timeout: 10_000 });
  return res.status === 0 && res.stdout.trim() ? res.stdout.trim() : null;
}

/** Query tokens through the SHARED tokenizer. A private one here would explain
 * matches in terms the ranker never saw. */
function queryTokensOf(query) {
  return tokenize(query);
}

/** `field: term, term` fragments for `--explain`, computed with the same
 * tokenizer that produced the score. */
function fieldHits(queryTokens, fields) {
  const out = [];
  for (const { name, text } of fields) {
    if (!text) continue;
    const tokens = new Set(tokenize(text));
    const matched = queryTokens.filter((t) => tokens.has(t));
    if (matched.length) out.push(`${name}: ${matched.join(', ')}`);
  }
  return out;
}

function compileRegex(pattern) {
  if (pattern.length > REGEX_MAX_PATTERN) {
    throw usageError(
      `regex pattern is ${pattern.length} characters, over the ${REGEX_MAX_PATTERN}-character bound`,
      'narrow the pattern, or use --match literal for a fixed string',
    );
  }
  try {
    // Flags are fixed, never caller-supplied: `g` would make `test` stateful
    // across lines via lastIndex and silently skip every other match.
    return new RegExp(pattern, 'i');
  } catch (error) {
    throw usageError(`invalid regex: ${error.message}`, 'escape regex metacharacters, or use --match literal');
  }
}

/**
 * Glob when the query carries a wildcard, plain substring otherwise. Compiled
 * from an escaped literal so only `*` and `?` are ever metacharacters — a path
 * containing `(` or `+` must not become a pattern, and a caller writing
 * `src/(a|b).ts` should get no results rather than a surprise alternation.
 */
function globToRegExp(pattern) {
  let out = '';
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i];
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        out += '.*';
        i += 1;
      } else {
        out += '[^/]*';
      }
    } else if (ch === '?') {
      out += '[^/]';
    } else {
      out += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${out}$`, 'i');
}

/**
 * Path relevance as a small ordinal, not a ratio: 3 an exact basename or full
 * glob match, 2 a basename substring, 1 anywhere in the path, 0 no match.
 * Ordinal because there is no meaningful continuum between "this is the file"
 * and "the string appears in a directory name".
 */
function pathMatcher(query) {
  if (query.length > REGEX_MAX_PATTERN) {
    throw usageError(
      `path pattern is ${query.length} characters, over the ${REGEX_MAX_PATTERN}-character bound`,
      'narrow the pattern',
    );
  }
  const needle = query.toLowerCase();
  const glob = /[*?]/.test(query) ? globToRegExp(query) : null;
  return (rel) => {
    const lower = String(rel).toLowerCase();
    if (glob) return glob.test(rel) ? 3 : 0;
    const base = lower.slice(lower.lastIndexOf('/') + 1);
    if (base === needle) return 3;
    if (base.includes(needle)) return 2;
    return lower.includes(needle) ? 1 : 0;
  };
}

function lineMatcher(mode, query) {
  if (mode === 'literal') {
    const needle = query.toLowerCase();
    return (line) => line.toLowerCase().includes(needle);
  }
  const re = compileRegex(query);
  // Truncate rather than skip an over-long line: skipping loses every match on
  // it, truncating loses only the ones past the bound.
  return (line) => re.test(line.length > REGEX_MAX_LINE ? line.slice(0, REGEX_MAX_LINE) : line);
}

/** Matched-line count plus the first hit, which is all any content mode needs:
 * one row per document, count as the score, first line as location + snippet. */
function scanText(text, match) {
  const lines = String(text).split(/\r?\n/);
  let hits = 0;
  let firstLine = 0;
  let firstText = '';
  for (let i = 0; i < lines.length && hits < MATCHED_LINE_CAP; i += 1) {
    if (!match(lines[i])) continue;
    hits += 1;
    if (hits === 1) {
      firstLine = i + 1;
      firstText = lines[i];
    }
  }
  return { hits, firstLine, firstText };
}

/** Deterministic candidate selection inside one corpus: same shape as the
 * kernel's total order, so trimming here can never reorder what survives. */
function topCandidates(results) {
  return results
    .sort((a, b) => b.sourceScore - a.sourceScore || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .slice(0, SOURCE_CANDIDATE_CAP);
}

// ---------------------------------------------------------------- code

function codeSymbols({ query, workspace, home, explain }) {
  const index = readStructuralIndex(workspace, { home });
  // The reader's own `reason` is carried through verbatim: it distinguishes
  // "never built" from "built by a newer writer" from "unreadable", and
  // re-wording it here would flatten three different fixes into one message.
  if (!index.present) return skipped('code', `${index.reason} — build one with: harness index --structural`);
  const generation = typeof index.meta?.sha === 'string' ? index.meta.sha : null;
  const needle = query.toLowerCase();
  const results = [];
  for (const symbol of index.symbols || []) {
    if (typeof symbol.name !== 'string' || !symbol.name || typeof symbol.file !== 'string' || !symbol.file) continue;
    const lower = symbol.name.toLowerCase();
    const exact = lower === needle;
    if (!exact && !lower.startsWith(needle)) continue;
    const line = Number.isFinite(symbol.def?.line) ? symbol.def.line : null;
    results.push(
      createRetrievalResult({
        source: 'code',
        id: `${symbol.file}#${symbol.name}`,
        location: line ? `${symbol.file}:${line}` : symbol.file,
        title: symbol.name,
        kind: symbol.kind || 'symbol',
        score: exact ? 2 : 1,
        generation,
        reason: explain ? `symbol name ${exact ? 'exact' : 'prefix'} match in ${symbol.file}` : null,
      }),
    );
  }
  return sourceEntry('code', 'ok', { generation, results: topCandidates(results) });
}

function codeSource({ mode, query, workspace, home, explain, headSha }) {
  if (mode === 'symbol') return codeSymbols({ query, workspace, home, explain });

  const { files } = trackedSourceFiles(workspace);
  // `trackedSourceFiles` returns the same empty set for "not a git repository"
  // and "nothing tracked"; the reason names both rather than picking one.
  if (!files.length) return skipped('code', 'no tracked source files (not a git repository, or nothing tracked)');

  if (mode === 'path') {
    const rank = pathMatcher(query);
    const results = [];
    for (const rel of files) {
      const score = rank(rel);
      if (!score) continue;
      results.push(
        createRetrievalResult({
          source: 'code',
          id: rel,
          location: rel,
          title: path.posix.basename(rel),
          kind: 'file',
          score,
          generation: headSha,
          reason: explain ? `path matched ${query} (${['', 'in path', 'in filename', 'exact'][score]})` : null,
        }),
      );
    }
    return sourceEntry('code', 'ok', { generation: headSha, results: topCandidates(results) });
  }

  const match = lineMatcher(mode, query);
  const results = [];
  for (const rel of files) {
    const text = readFileSafe(workspace, rel);
    if (!text) continue;
    const { hits, firstLine, firstText } = scanText(text, match);
    if (!hits) continue;
    results.push(
      createRetrievalResult({
        source: 'code',
        id: rel,
        location: `${rel}:${firstLine}`,
        title: path.posix.basename(rel),
        snippet: snippetOf(firstText),
        kind: 'file',
        score: hits,
        generation: headSha,
        reason: explain ? `${mode} match on ${hits} line(s), first at ${rel}:${firstLine}` : null,
      }),
    );
  }
  return sourceEntry('code', 'ok', { generation: headSha, results: topCandidates(results) });
}

// ----------------------------------------------------------- knowledge

/**
 * The RANKER is part of the knowledge generation, not just the manifest
 * timestamp. Deleting the postings index leaves `updated` untouched but switches
 * `rankRecall` to its overlap fallback, which scores differently — a generation
 * that could not tell those apart would make "same query + same generation ⇒
 * byte-identical" a promise this command cannot keep. Non-ranked modes never
 * touch a ranker, so they report the manifest generation unqualified rather than
 * claiming a ranker ran.
 */
function knowledgeGeneration({ mode, copilotHome, workspace, updated }) {
  if (!updated) return null;
  if (mode !== 'ranked') return updated;
  const indexDir = resolveIndexDir(copilotHome, workspace);
  const index = loadPostingsIndex(indexDir);
  const fresh = Boolean(index) && !isIndexStale(indexDir, updated) && index.N > 0;
  return `${fresh ? 'bm25' : 'overlap'}@${updated}`;
}

const KNOWLEDGE_TEXT_FIELDS = ['symptom', 'title', 'summary', 'excerpt', 'module'];

/** The manifest is generated but hand-editable, so neither the id nor `tags`
 * is trusted to have its declared shape. An entry with no usable id is skipped
 * rather than thrown on: one malformed row must not fail the whole corpus. */
const knowledgeId = (entry) => {
  const id = entry.docid || entry.id;
  return typeof id === 'string' && id ? id : null;
};

const knowledgeFields = (entry) => [
  ...KNOWLEDGE_TEXT_FIELDS.map((name) => ({ name, text: entry[name] })),
  { name: 'tags', text: Array.isArray(entry.tags) ? entry.tags.join(' ') : '' },
];

function knowledgeSource({ mode, query, workspace, copilotHome, explain, collection, collections, queryTokens }) {
  const manifest = loadManifest(copilotHome, workspace);
  // An unreadable manifest is a FAILURE, not an absence: `loadManifest` reports
  // the parse error while still returning an empty entry list, and passing that
  // through as `ok` would present a broken corpus as a clean one.
  if (manifest.error) return failed('knowledge', `knowledge manifest unreadable: ${manifest.error}`);
  if (!manifest.path) return skipped('knowledge', 'no knowledge manifest — build one with: harness index');

  const generation = knowledgeGeneration({ mode, copilotHome, workspace, updated: manifest.updated });

  if (mode === 'ranked') {
    const ranked = rankRecall(query, { copilotHome, workspace, limit: SOURCE_CANDIDATE_CAP, collection });
    const results = [];
    for (const entry of ranked) {
      const id = knowledgeId(entry);
      if (!id) continue;
      const hits = explain ? fieldHits(queryTokens, knowledgeFields(entry)) : [];
      results.push(
        createRetrievalResult({
          source: 'knowledge',
          scope: entry.scope ?? null,
          id,
          location: entry.path ?? null,
          title: entry.title ?? null,
          snippet: snippetOf(entry.snippet),
          kind: entry.kind ?? null,
          score: entry.score,
          generation,
          reason: explain
            ? hits.length
              ? `${entry.ranker} ranked on ${hits.join('; ')}`
              : `${entry.ranker} ranked on synonym expansion or recency, with no direct field hit`
            : null,
        }),
      );
    }
    return sourceEntry('knowledge', 'ok', { generation, results });
  }

  const entries = manifest.entries.filter((entry) => entryMatchesCollection(entry, collection, collections));

  if (mode === 'path') {
    const rank = pathMatcher(query);
    const results = [];
    for (const entry of entries) {
      const id = knowledgeId(entry);
      const score = id && entry.path ? rank(entry.path) : 0;
      if (!score) continue;
      results.push(
        createRetrievalResult({
          source: 'knowledge',
          scope: entry.scope ?? null,
          id,
          location: entry.path,
          title: entry.title ?? null,
          kind: entry.kind ?? null,
          score,
          generation,
          reason: explain ? `document path matched ${query}` : null,
        }),
      );
    }
    return sourceEntry('knowledge', 'ok', { generation, results: topCandidates(results) });
  }

  const match = lineMatcher(mode, query);
  const results = [];
  for (const entry of entries) {
    const id = knowledgeId(entry);
    if (!id) continue;
    // Weighted by the SHARED field boosts rather than a private per-field
    // weight: a manifest title is worth more than an excerpt in exactly the
    // proportion the ranked path already uses, and one weighting cannot drift
    // from itself.
    let score = 0;
    let firstField = null;
    let firstText = '';
    for (const { name, text } of knowledgeFields(entry)) {
      if (!text) continue;
      const { hits, firstText: line } = scanText(text, match);
      if (!hits) continue;
      score += FIELD_BOOSTS[name] ?? 1;
      if (!firstField) {
        firstField = name;
        firstText = line;
      }
    }
    if (!score) continue;
    results.push(
      createRetrievalResult({
        source: 'knowledge',
        scope: entry.scope ?? null,
        id,
        location: entry.path ?? null,
        title: entry.title ?? null,
        snippet: snippetOf(firstText),
        kind: entry.kind ?? null,
        score,
        generation,
        reason: explain ? `${mode} match in field ${firstField}` : null,
      }),
    );
  }
  return sourceEntry('knowledge', 'ok', { generation, results: topCandidates(results) });
}

// ----------------------------------------------------------- learnings

function learningsSource({ mode, query, workspace, home, explain, queryTokens }) {
  const dir = storeDir(workspace, { home });
  // Existence probe only — never create (P2AC6). `loadLayeredLearnings` is
  // tolerant of a missing store on its own, but probing first is what lets this
  // report `skipped` instead of an indistinguishable empty `ok`.
  if (!fs.existsSync(dir)) return skipped('learnings', 'no knowledge store for this workspace');

  const { learnings } = loadLayeredLearnings({ workspace, home });
  // The store is out of tree and has no manifest timestamp, so its generation is
  // derived from its content. Cheap (ids and byte counts, already in hand) and
  // it moves whenever any learning does, which a store-repo HEAD would not for
  // an uncommitted edit.
  const generation = learnings.length ? digestOf(learnings.map((l) => `${l.id}:${l.bytes}`)) : null;

  if (mode === 'ranked') {
    const ranked = rankLearnings({ workspace, query, limit: SOURCE_CANDIDATE_CAP, home });
    const fileById = new Map(learnings.map((l) => [l.id, l.file ?? null]));
    const results = ranked.map((entry) =>
      createRetrievalResult({
        source: 'learnings',
        id: entry.id,
        location: fileById.get(entry.id) ?? null,
        title: entry.trigger ?? null,
        snippet: snippetOf(entry.claimLine),
        kind: 'learning',
        score: entry.score,
        generation,
        reason: explain
          ? fieldHits(queryTokens, [
              { name: 'trigger', text: entry.trigger },
              { name: 'claim', text: entry.claimLine },
            ]).join('; ') || `status ${entry.status} matched with no single-field hit`
          : null,
      }),
    );
    return sourceEntry('learnings', 'ok', { generation, results });
  }

  const match = lineMatcher(mode, query);
  // Same exclusion inputs `rankLearnings` uses, stale anchors included: dropping
  // them here would make the literal path looser than the ranked one.
  const { excluded } = readStaleExclusions(dir);
  const results = [];
  for (const learning of learnings) {
    // The retrieval gate is a property of the CORPUS, not of the ranker: a
    // retired, superseded, or promoted claim that ranked search hides must not
    // reappear through literal or regex search.
    if (retrievalExclusion(learning, excluded)) continue;
    const text = `${learning.fm?.trigger || ''}\n${learning.body || ''}`;
    const { hits, firstText } = scanText(text, match);
    if (!hits) continue;
    results.push(
      createRetrievalResult({
        source: 'learnings',
        id: learning.id,
        location: learning.file ?? null,
        title: learning.fm?.trigger ?? null,
        snippet: snippetOf(firstText),
        kind: 'learning',
        score: hits,
        generation,
        reason: explain ? `${mode} match on ${hits} line(s) of trigger or claim` : null,
      }),
    );
  }
  return sourceEntry('learnings', 'ok', { generation, results: topCandidates(results) });
}

// --------------------------------------------------------------- plans

function loadPlans(workspace) {
  // Refuse the WALK, not just each read: a symlinked `docs/plans` would let this
  // enumerate names outside the workspace even though every individual read
  // below is already inert against it.
  const root = assertNoSymlinkAncestors(workspace, PLANS_DIR_REL);
  if (!root) return { ok: false, reason: `${PLANS_DIR_REL} resolves through a symlink — refusing to enumerate it`, plans: [] };
  if (!fs.existsSync(root)) return { ok: false, reason: `no ${PLANS_DIR_REL} directory in this workspace`, plans: [] };
  const plans = [];
  // Sorted: readdir order is filesystem-dependent, and an unsorted scan would
  // make candidate truncation (and therefore output) machine-dependent.
  for (const name of fs.readdirSync(root).sort()) {
    if (!name.endsWith('.md')) continue;
    const rel = `${PLANS_DIR_REL}/${name}`;
    const text = readFileSafe(workspace, rel);
    if (!text) continue;
    plans.push({ rel, name, text });
  }
  return { ok: true, reason: null, plans };
}

function plansSource({ mode, query, workspace, explain, headSha, queryTokens }) {
  const loaded = loadPlans(workspace);
  if (!loaded.ok) return skipped('plans', loaded.reason);

  if (mode === 'ranked') {
    const textByRel = new Map(loaded.plans.map((p) => [p.rel, p.text]));
    const matches = findMatchingPlans(workspace, query, SOURCE_CANDIDATE_CAP);
    const results = matches.map((entry) =>
      createRetrievalResult({
        source: 'plans',
        id: entry.path,
        location: entry.path,
        title: path.posix.basename(entry.path),
        kind: 'plan',
        score: entry.score,
        generation: headSha,
        reason: explain
          ? [
              fieldHits(queryTokens, [{ name: 'plan', text: (textByRel.get(entry.path) || '').slice(0, PLAN_RANK_HEAD) }]).join('; ') ||
                'matched on plan frontmatter or body tokens',
              `status ${entry.status}`,
              `plan_lock ${entry.plan_lock}`,
            ].join(' — ')
          : null,
      }),
    );
    return sourceEntry('plans', 'ok', { generation: headSha, results });
  }

  if (mode === 'path') {
    const rank = pathMatcher(query);
    const results = [];
    for (const plan of loaded.plans) {
      const score = rank(plan.rel);
      if (!score) continue;
      results.push(
        createRetrievalResult({
          source: 'plans',
          id: plan.rel,
          location: plan.rel,
          title: plan.name,
          kind: 'plan',
          score,
          generation: headSha,
          reason: explain ? `plan path matched ${query}` : null,
        }),
      );
    }
    return sourceEntry('plans', 'ok', { generation: headSha, results: topCandidates(results) });
  }

  const match = lineMatcher(mode, query);
  const results = [];
  for (const plan of loaded.plans) {
    const { hits, firstLine, firstText } = scanText(plan.text, match);
    if (!hits) continue;
    results.push(
      createRetrievalResult({
        source: 'plans',
        id: plan.rel,
        location: `${plan.rel}:${firstLine}`,
        title: plan.name,
        snippet: snippetOf(firstText),
        kind: 'plan',
        score: hits,
        generation: headSha,
        reason: explain ? `${mode} match on ${hits} line(s), first at ${plan.rel}:${firstLine}` : null,
      }),
    );
  }
  return sourceEntry('plans', 'ok', { generation: headSha, results: topCandidates(results) });
}

// ------------------------------------------------------------ dispatch

const SOURCE_HANDLERS = {
  code: codeSource,
  knowledge: knowledgeSource,
  learnings: learningsSource,
  plans: plansSource,
};

function resolveMode(mode, modes) {
  // Both spellings are accepted deliberately. The CLI flag is the singular
  // `--match`, while the phase contract enumerates the plural set, and a caller
  // that passes the other spelling must not silently fall back to `ranked`: a
  // wrong mode returns plausible results, which is the failure nobody notices.
  const selected = mode ?? modes ?? DEFAULT_MATCH_MODE;
  const normalized = String(Array.isArray(selected) ? selected[0] : selected).trim().toLowerCase();
  if (!MATCH_MODES.includes(normalized)) {
    throw usageError(`unknown match mode: ${normalized}`, `one of ${MATCH_MODES.join(', ')}`);
  }
  return normalized;
}

function resolveSources(sources) {
  if (sources == null) return [...SOURCES];
  const raw = Array.isArray(sources) ? sources : String(sources).split(',');
  const wanted = raw.map((s) => String(s).trim().toLowerCase()).filter(Boolean);
  if (!wanted.length || wanted.includes('all')) return [...SOURCES];
  for (const name of wanted) {
    if (SOURCES.includes(name)) continue;
    const pending = PENDING_SOURCES[name];
    throw usageError(
      pending ? `source not available yet: ${name}` : `unknown source: ${name}`,
      pending || `one of ${SOURCES.join(', ')}, or all`,
    );
  }
  // Reported in SOURCES order, never argv order: the kernel's tie-break order is
  // the published contract, and an envelope whose `sources` array depended on
  // how the flag was spelled would not be byte-identical across equivalent calls.
  return SOURCES.filter((s) => wanted.includes(s));
}

function resolveLimit(limit) {
  const n = Number(limit);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIMIT;
  return Math.min(Math.trunc(n), MAX_LIMIT);
}

/**
 * Run one search. Throws `E_USAGE` (exit 2) for a malformed request — a blank
 * query, an unknown mode or source, an over-long or uncompilable pattern, an
 * undefined collection — and NEVER for an empty result set, which is a success
 * with zero results (P2AC1).
 *
 * Returns `federate`'s envelope plus `match`: the resolved mode is otherwise
 * invisible in the output, and "no results" reads very differently once you know
 * whether it came from `symbol` or `literal`.
 */
export function runSearch({
  query,
  workspace,
  copilotHome,
  home,
  mode,
  modes,
  sources,
  limit,
  cursor = null,
  explain = false,
  collection = null,
} = {}) {
  const text = typeof query === 'string' ? query.trim() : '';
  if (!text) throw usageError('search requires a query', 'harness search <query> [--match ranked|literal|regex|path|symbol]');

  const selectedMode = resolveMode(mode, modes);
  const selectedSources = resolveSources(sources);

  // Every caller-supplied pattern is compiled ONCE, up front, so a bad pattern
  // is a usage error before any corpus is touched rather than four identical
  // failures inside the fan-out.
  if (selectedMode === 'regex') compileRegex(text);
  if (selectedMode === 'path') pathMatcher(text);

  // Only read when a collection was actually asked for: `entryMatchesCollection`
  // short-circuits on a null name, so loading the file otherwise would be a
  // knowledge-root probe on every single search.
  const collections = collection ? loadCollections(copilotHome, workspace) : {};
  if (collection && !collections[collection]) {
    const known = Object.keys(collections);
    // An undefined collection filters EVERYTHING out, so accepting it would
    // return a confident empty set for a typo. Named as a usage error instead.
    throw usageError(
      `unknown collection: ${collection}`,
      known.length ? `one of ${known.join(', ')}` : 'no collections are defined in knowledge/collections.yaml',
    );
  }

  const queryTokens = queryTokensOf(text);
  // One spawn, shared by every workspace-backed corpus. Skipped entirely when
  // no such corpus was selected, so a `--scope learnings` search does no git.
  const headSha =
    selectedSources.includes('code') || selectedSources.includes('plans') ? workspaceGeneration(workspace) : null;

  const entries = [];
  for (const source of selectedSources) {
    const unsupported = MODE_UNSUPPORTED[selectedMode][source];
    if (unsupported) {
      entries.push(skipped(source, unsupported));
      continue;
    }
    try {
      entries.push(
        SOURCE_HANDLERS[source]({
          mode: selectedMode,
          query: text,
          workspace,
          copilotHome,
          home,
          explain,
          collection,
          collections,
          queryTokens,
          headSha,
        }),
      );
    } catch (error) {
      // A corpus that threw is REPORTED, never dropped: a silently missing
      // source is indistinguishable from one with no matches, and the two mean
      // opposite things. Usage errors cannot land here — they are all raised
      // above, before the fan-out starts.
      entries.push(failed(source, error?.message || String(error)));
    }
  }

  return { ...federate({ sources: entries, limit: resolveLimit(limit), cursor }), match: selectedMode };
}
