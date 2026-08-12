/**
 * Kernel worklist (`harness todo`) — durable per-workspace under `.harness/todo.json`.
 * Agent tool maps here; no LLM in this module.
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseFlags } from './flags.mjs';
import { positionalsOf } from './positionals.mjs';
import { createStyle, keyWidthFor, EXIT } from './style.mjs';
import { redactedJson } from './redact.mjs';
import { inertLine } from './knowledge/store.mjs';
import { writeFileContained, readFileNoFollow } from './fs-safe.mjs';
import { ensureHarnessDir } from './session.mjs';
import { safeResolveUnderRoot } from './path-safe.mjs';

const ui = createStyle({ argv: process.argv.slice(2) });

export const TODO_SCHEMA = 1;
export const TODO_REL = '.harness/todo.json';
export const TODO_VERBS = Object.freeze(['list', 'add', 'complete', 'clear']);

function usageError(message, hint) {
  return Object.assign(new Error(message), { code: 'E_USAGE', exit: EXIT.usage, hint });
}

function emptyStore() {
  return { schema: TODO_SCHEMA, items: [], updatedAt: null };
}

function resolveTodoPath(workspace) {
  return safeResolveUnderRoot(path.resolve(workspace), TODO_REL);
}

export function readTodoStore(workspace) {
  const full = resolveTodoPath(workspace);
  if (!full || !fs.existsSync(full)) return emptyStore();
  const raw = readFileNoFollow(full, { root: path.resolve(workspace) });
  if (raw === null) return emptyStore();
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.items)) return emptyStore();
    return {
      schema: TODO_SCHEMA,
      items: parsed.items.filter((i) => i && typeof i.id === 'string' && typeof i.text === 'string'),
      updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : null,
    };
  } catch {
    return emptyStore();
  }
}

function writeTodoStore(workspace, store, { dryRun = false } = {}) {
  if (ensureHarnessDir(workspace, dryRun) === null) {
    return {
      ok: false,
      reason: '.harness is not a real directory',
    };
  }
  const payload = {
    schema: TODO_SCHEMA,
    items: store.items,
    updatedAt: new Date().toISOString(),
  };
  if (dryRun) return { ok: true, dryRun: true, store: payload };
  if (writeFileContained(workspace, TODO_REL, `${JSON.stringify(payload, null, 2)}\n`) === null) {
    return { ok: false, reason: 'could not write todo store' };
  }
  return { ok: true, dryRun: false, store: payload };
}

function nextId(items) {
  let max = 0;
  for (const item of items) {
    const n = Number(String(item.id).replace(/^t/, ''));
    if (Number.isFinite(n) && n > max) max = n;
  }
  return `t${max + 1}`;
}

function stringFlag(argv, name) {
  let raw = null;
  let seen = 0;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--') break;
    if (a === name) {
      seen += 1;
      raw = argv[i + 1] === undefined || argv[i + 1].startsWith('--') ? '' : argv[i += 1];
    } else if (a.startsWith(`${name}=`)) {
      seen += 1;
      raw = a.slice(name.length + 1);
    }
  }
  if (seen === 0) return null;
  if (seen > 1) throw usageError(`${name} was given more than once`, `pass ${name} at most once`);
  if (raw === null || raw === '') throw usageError(`${name} needs a value`, `${name} <value>`);
  return raw;
}

export function runTodo({ workspace, verb = 'list', text = null, id = null, dryRun = false } = {}) {
  const store = readTodoStore(workspace);
  const v = (verb || 'list').toLowerCase();

  if (v === 'list') {
    const open = store.items.filter((i) => i.status !== 'done');
    const done = store.items.filter((i) => i.status === 'done');
    return {
      schema: TODO_SCHEMA,
      mode: 'todo',
      verb: 'list',
      status: 'ok',
      exitCode: 0,
      items: store.items,
      openCount: open.length,
      doneCount: done.length,
      output: store.items.length
        ? store.items.map((i) => ({ line: `[${i.status === 'done' ? 'x' : ' '}] ${i.id}  ${i.text}` }))
        : [{ line: 'todo list empty' }],
    };
  }

  if (v === 'add') {
    const body = typeof text === 'string' ? text.trim() : '';
    if (!body) {
      return {
        schema: TODO_SCHEMA,
        mode: 'todo',
        verb: 'add',
        status: 'failed',
        exitCode: 1,
        reason: 'empty-text',
        items: store.items,
        output: [{ line: 'todo add needs --text <work item>' }],
      };
    }
    const item = {
      id: nextId(store.items),
      text: body.slice(0, 500),
      status: 'open',
      createdAt: new Date().toISOString(),
    };
    const next = { ...store, items: [...store.items, item] };
    const written = writeTodoStore(workspace, next, { dryRun });
    if (!written.ok) {
      return {
        schema: TODO_SCHEMA,
        mode: 'todo',
        verb: 'add',
        status: 'failed',
        exitCode: 1,
        reason: written.reason,
        items: store.items,
        output: [{ line: written.reason }],
      };
    }
    return {
      schema: TODO_SCHEMA,
      mode: 'todo',
      verb: 'add',
      status: 'ok',
      exitCode: 0,
      dryRun: Boolean(written.dryRun),
      item,
      items: written.store.items,
      output: [{ line: `added ${item.id}: ${item.text}` }],
    };
  }

  if (v === 'complete') {
    const target = typeof id === 'string' ? id.trim() : '';
    if (!target) {
      return {
        schema: TODO_SCHEMA,
        mode: 'todo',
        verb: 'complete',
        status: 'failed',
        exitCode: 1,
        reason: 'missing-id',
        items: store.items,
        output: [{ line: 'todo complete needs --id <id>' }],
      };
    }
    const idx = store.items.findIndex((i) => i.id === target);
    if (idx === -1) {
      return {
        schema: TODO_SCHEMA,
        mode: 'todo',
        verb: 'complete',
        status: 'failed',
        exitCode: 1,
        reason: 'not-found',
        items: store.items,
        output: [{ line: `no todo item ${target}` }],
      };
    }
    const items = store.items.map((i, n) => (
      n === idx ? { ...i, status: 'done', completedAt: new Date().toISOString() } : i
    ));
    const written = writeTodoStore(workspace, { ...store, items }, { dryRun });
    if (!written.ok) {
      return {
        schema: TODO_SCHEMA,
        mode: 'todo',
        verb: 'complete',
        status: 'failed',
        exitCode: 1,
        reason: written.reason,
        items: store.items,
        output: [{ line: written.reason }],
      };
    }
    return {
      schema: TODO_SCHEMA,
      mode: 'todo',
      verb: 'complete',
      status: 'ok',
      exitCode: 0,
      dryRun: Boolean(written.dryRun),
      item: items[idx],
      items: written.store.items,
      output: [{ line: `completed ${target}` }],
    };
  }

  if (v === 'clear') {
    const written = writeTodoStore(workspace, emptyStore(), { dryRun });
    if (!written.ok) {
      return {
        schema: TODO_SCHEMA,
        mode: 'todo',
        verb: 'clear',
        status: 'failed',
        exitCode: 1,
        reason: written.reason,
        items: store.items,
        output: [{ line: written.reason }],
      };
    }
    return {
      schema: TODO_SCHEMA,
      mode: 'todo',
      verb: 'clear',
      status: 'ok',
      exitCode: 0,
      dryRun: Boolean(written.dryRun),
      items: [],
      cleared: store.items.length,
      output: [{ line: `cleared ${store.items.length} item(s)` }],
    };
  }

  return {
    schema: TODO_SCHEMA,
    mode: 'todo',
    verb: v,
    status: 'failed',
    exitCode: EXIT.usage,
    reason: 'unknown-verb',
    items: store.items,
    output: [{ line: `unknown todo verb: ${v}` }, { line: `known: ${TODO_VERBS.join(', ')}` }],
  };
}

export function todoResultOf(argv, ctx = {}) {
  const flags = parseFlags(argv);
  const pos = positionalsOf(argv);
  const verb = pos[0] || 'list';
  const text = stringFlag(argv, '--text') ?? (pos[1] && verb === 'add' ? pos.slice(1).join(' ') : null);
  const id = stringFlag(argv, '--id') ?? (verb === 'complete' ? pos[1] : null);
  return runTodo({
    workspace: path.resolve(flags.workspace),
    verb,
    text,
    id,
    dryRun: flags.dryRun,
  });
}

function render(result, flags) {
  if (flags.json) {
    console.log(redactedJson(result, { pretty: flags.verbose }));
    return;
  }
  const keyWidth = keyWidthFor(['todo', 'status']);
  console.log(ui.line({
    state: result.status === 'ok' ? 'ok' : 'error',
    key: 'todo',
    value: result.verb,
    note: result.openCount !== undefined ? `${result.openCount} open` : undefined,
    keyWidth,
  }));
  for (const row of result.output || []) console.log(`  ${inertLine(row.line)}`);
}

export function todoExitFor(result) {
  return result?.status === 'ok' ? EXIT.ok : (result?.exitCode ?? 1);
}

export async function cmdTodo(argv, ctx = {}) {
  const result = todoResultOf(argv, ctx);
  render(result, parseFlags(argv));
  ctx.reportStatus?.(result.status);
  return todoExitFor(result);
}
