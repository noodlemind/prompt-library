import path from 'node:path';
import { parseFlags } from '../flags.mjs';
import { parseQueryFromArgv } from '../argv.mjs';
import { resolveCopilotHome } from '../paths.mjs';
import { createStyle, keyWidthFor } from '../style.mjs';
import { redactedJson } from '../redact.mjs';
import { inertLine } from '../knowledge/store.mjs';
import { runSearch, MATCH_MODES, DEFAULT_MATCH_MODE } from './search.mjs';
import { runTree, TREE_SUBJECTS } from './tree.mjs';
import { SOURCES } from './kernel.mjs';

const ui = createStyle({ argv: process.argv.slice(2) });

function readValueFlag(argv, name) {
  const eq = argv.find((a) => a.startsWith(`${name}=`));
  if (eq) return eq.slice(name.length + 1);
  const i = argv.indexOf(name);
  if (i === -1) return null;
  const next = argv[i + 1];
  return next === undefined || next.startsWith('--') ? '' : next;
}

function searchContext(argv) {
  const flags = parseFlags(argv);
  return {
    flags,
    query: parseQueryFromArgv(argv, flags),
    mode: readValueFlag(argv, '--match') ?? undefined,
    sources: readValueFlag(argv, '--source'),
    cursor: readValueFlag(argv, '--cursor'),
    explain: flags.explain,
    collection: flags.collection,
    limit: flags.limit ?? undefined,
    workspace: path.resolve(flags.workspace),
    copilotHome: resolveCopilotHome(flags.copilotHome),
  };
}

function searchResult(argv) {
  const ctx = searchContext(argv);
  return runSearch({
    query: ctx.query,
    workspace: ctx.workspace,
    copilotHome: ctx.copilotHome,
    mode: ctx.mode || undefined,
    sources: ctx.sources ? ctx.sources.split(',').map((s) => s.trim()).filter(Boolean) : undefined,
    limit: ctx.limit,
    cursor: ctx.cursor || null,
    explain: ctx.explain,
    collection: ctx.collection,
  });
}

export async function searchResultOf(argv) {
  return searchResult(argv);
}

function openArgvFor(row) {
  if (row.source === 'knowledge' && row.id) return ['get', '--docid', String(row.id)];
  const location = typeof row.location === 'string' ? row.location : '';
  const file = location.replace(/:\d+(?::\d+)?$/, '').trim();
  if (file) return ['get', '--path', file];
  if (row.id) return ['get', '--docid', String(row.id)];
  return null;
}

export async function cmdSearch(argv, ctx = {}) {
  const { flags } = searchContext(argv);
  const result = searchResult(argv);

    ctx.reportSelection?.({
    kind: 'results',
    title: `${result.total} result(s)`,
    items: result.results
      .map((row) => ({
        label: String(row.location || row.id || ''),
        note: [row.source, row.title].filter(Boolean).join(' · '),
        argv: openArgvFor(row),
      }))
      .filter((item) => item.label && item.argv),
  });

  if (flags.json) {
    console.log(redactedJson(result, { pretty: flags.verbose }));
    return 0;
  }

  const keyWidth = keyWidthFor(['results', 'sources', 'more']);
  console.log(ui.line({ key: 'search', value: `${result.total} result(s)`, note: `match ${result.match}`, keyWidth }));

    for (const s of result.sources.filter((x) => x.status !== 'ok')) {
    console.log(ui.line({ state: s.status === 'failed' ? 'error' : 'warn', key: s.source, value: s.status, note: s.reason ?? undefined, keyWidth }));
  }

  for (const row of result.results) {
    const where = row.location || row.id;
    console.log(ui.line({ key: row.source, value: inertLine(String(where)), note: row.title ? inertLine(row.title) : undefined, keyWidth }));
    if (flags.explain && row.reason) console.log(ui.paint('muted', `    ${inertLine(row.reason)}`));
  }

  if (result.truncated) {
    console.log(ui.line({ key: 'more', value: `--cursor ${result.nextCursor}`, keyWidth }));
  }
  return 0;
}

function treeContext(argv) {
  const flags = parseFlags(argv);
  const positionals = argv.filter((a, i) => {
    if (a.startsWith('--')) return false;
    const prev = argv[i - 1];
    return !(typeof prev === 'string' && prev.startsWith('--') && !prev.includes('='));
  });
  const depthRaw = readValueFlag(argv, '--depth');
  return {
    flags,
    subject: positionals[0] ?? null,
    target: positionals[1] ?? null,
    depth: depthRaw ? Number(depthRaw) : undefined,
    workspace: path.resolve(flags.workspace),
    copilotHome: resolveCopilotHome(flags.copilotHome),
  };
}

function treeResult(argv) {
  const ctx = treeContext(argv);
  return runTree({
    subject: ctx.subject,
    target: ctx.target,
    depth: ctx.depth,
    workspace: ctx.workspace,
    copilotHome: ctx.copilotHome,
  });
}

export async function treeResultOf(argv) {
  return treeResult(argv);
}

function printNode(node, prefix, keyWidth) {
  const label = node.type === 'dir' ? `${node.name}/` : node.name;
  console.log(ui.line({ key: '', value: `${prefix}${inertLine(label)}`, note: node.title ? inertLine(node.title) : undefined, keyWidth }));
  for (const child of node.children || []) printNode(child, `${prefix}  `, keyWidth);
}

export async function cmdTree(argv) {
  const { flags } = treeContext(argv);
  const result = treeResult(argv);

  if (flags.json) {
    console.log(redactedJson(result, { pretty: flags.verbose }));
    return 0;
  }

  const keyWidth = keyWidthFor(['tree', 'totals', 'limits']);
  console.log(ui.line({ key: 'tree', value: result.subject, note: result.target ?? undefined, keyWidth }));
  for (const child of result.root?.children || []) printNode(child, '', keyWidth);

  if (result.emptyReason) {
    console.log(ui.line({ state: 'warn', key: '', value: result.emptyReason, keyWidth }));
  }

  const totals = Object.entries(result.totals ?? {})
    .map(([k, v]) => `${k}=${v}`)
    .join(' · ');
  if (totals) console.log(ui.line({ key: 'totals', value: totals, keyWidth }));
  if (result.truncated) {
    const dropped = Object.entries(result.limits ?? {})
      .filter(([, v]) => typeof v === 'number' && v > 0)
      .map(([k, v]) => `${k}=${v}`)
      .join(' · ');
    console.log(ui.line({ state: 'warn', key: 'limits', value: 'output truncated', note: dropped || undefined, keyWidth }));
  }
  return 0;
}

export const SEARCH_MATCH_MODES = MATCH_MODES;
export const SEARCH_DEFAULT_MODE = DEFAULT_MATCH_MODE;
export const SEARCH_SOURCE_NAMES = SOURCES;
export const TREE_SUBJECT_NAMES = TREE_SUBJECTS;
