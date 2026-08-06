import path from 'node:path';
import { tokenize } from '../tokenize.mjs';
import { estimateTokens } from '../token-meter.mjs';
import { extract as lexicalExtract } from './lexical-extractor.mjs';
import { writeFileContained } from '../fs-safe.mjs';
import { trackedSourceFiles, readFileSafe } from './scan.mjs';
import { readStructuralIndexIfCurrent } from './structural-index.mjs';

const DEFAULT_MAX_TOKENS = 1000;

/**
 * Build a budgeted lexical repo map. Deterministic: no model, no network.
 * Files are ranked by import-degree (how many files reference them) plus symbol
 * density, and — when a query is given — boosted by normalized-token overlap
 * with the path and symbols, so orientation is code-relevant to the task.
 */
export function buildRepoMap({ workspace, query = '', maxTokens = DEFAULT_MAX_TOKENS, extract = lexicalExtract, title = 'Repo Map', preferStructural = true } = {}) {
  const { files, total } = trackedSourceFiles(workspace);
  if (!files.length) return { files: [], body: '', tokens: 0, empty: true };

  // Structural preference (blueprint P3): when the prebuilt structural index
  // exists AND its generation sha matches the current HEAD, its per-file
  // symbol/import tables feed the ranking directly — no per-file reads, and
  // symbol precision comes from the AST tier that built the index. Absent or
  // stale index → the unchanged lexical path, byte-identical output. This
  // stays a SYNCHRONOUS read of prebuilt files; parsing itself only ever
  // happens inside `harness index --structural`.
  let structural = null;
  if (preferStructural) {
    try {
      structural = readStructuralIndexIfCurrent(workspace);
    } catch {
      structural = null;
    }
  }

  const info = new Map();
  for (const rel of files) {
    const pre = structural?.files?.[rel];
    const { symbols, imports } = pre || extract(rel, readFileSafe(workspace, rel));
    info.set(rel, { rel, symbols, imports, importedBy: 0 });
  }

  // Approximate import-degree: a file is "imported by" another whose import
  // targets end with this file's module name (basename without extension).
  const byStem = new Map();
  for (const rel of files) {
    const stem = path.basename(rel).replace(/\.\w+$/, '');
    if (!byStem.has(stem)) byStem.set(stem, []);
    byStem.get(stem).push(rel);
  }
  for (const { imports } of info.values()) {
    for (const imp of imports) {
      const last = imp.replace(/['"]/g, '').split(/[./\\]/).filter(Boolean).pop();
      for (const target of byStem.get(last) || []) info.get(target).importedBy += 1;
    }
  }

  const queryTokens = new Set(tokenize(query));
  const scored = [...info.values()].map((f) => {
    let queryScore = 0;
    if (queryTokens.size) {
      const hay = new Set(tokenize(`${f.rel} ${f.symbols.join(' ')}`));
      for (const t of queryTokens) if (hay.has(t)) queryScore += 1;
    }
    const structural = f.importedBy * 2 + Math.min(f.symbols.length, 12);
    return { ...f, score: queryScore * 5 + structural };
  });
  // Locale-independent tie-break: the committed map must be byte-identical
  // across hosts for the same tree.
  scored.sort((a, b) => b.score - a.score || (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));

  const lines = [
    `# ${title}`,
    '',
    `> Deterministic ${structural ? 'structural' : 'lexical'} map of ${total} tracked source files${total > files.length ? ` (top ${files.length} scanned)` : ''}.${query ? ` Ranked for: "${query}".` : ''}`,
    '',
  ];
  const selected = [];
  for (const f of scored) {
    const symbolList = f.symbols.slice(0, 6).join(', ');
    const entry = `- \`${f.rel}\`${f.importedBy ? ` (imported by ${f.importedBy})` : ''}${symbolList ? ` — ${symbolList}` : ''}`;
    if (estimateTokens([...lines, entry].join('\n')) > maxTokens) break;
    lines.push(entry);
    selected.push(f.rel);
  }

  const body = lines.join('\n');
  return { files: selected, body, tokens: estimateTokens(body), empty: false, totalFiles: total, structural: Boolean(structural) };
}

/**
 * Write the committed, query-less codebase map to docs/codebase-map.md.
 * Deterministic and timestamp-free so the committed file only changes when
 * the code structure changes — a durable cold-start orientation for agents.
 */
export function writeCodebaseMap({ workspace, dryRun = false, maxTokens = 2500 }) {
  // The COMMITTED map stays lexical-only (preferStructural: false): it must
  // be byte-identical across hosts for the same tree, and whether a given
  // host has built a structural index is host-local state that must never
  // leak into a committed artifact.
  const map = buildRepoMap({ workspace, query: '', maxTokens, title: 'Codebase Map', preferStructural: false });
  if (map.empty) return null;
  const rel = path.join('docs', 'codebase-map.md');
  if (!dryRun) {
    // Refuse to write through a symlinked `docs/` (or a pre-planted symlink
    // at the target itself) — a naive mkdir+write would otherwise follow
    // either straight out of the workspace. writeFileContained also writes
    // atomically (tmp + rename), so a concurrent reader never observes a
    // partial map.
    const full = writeFileContained(workspace, rel, map.body + '\n');
    if (!full) return null;
  }
  return { path: rel.split(path.sep).join('/'), tokens: map.tokens, files: map.files.length };
}
