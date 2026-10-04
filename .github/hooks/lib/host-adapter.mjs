import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const SLICE_KEYS = ['neighborhood', 'learnings', 'skills', 'instructions', 'contacts', 'index', 'gateStatus', 'activePlan'];

function emptySlice() {
  return {
    neighborhood: null,
    learnings: [],
    skills: [],
    instructions: [],
    contacts: [],
    index: { knowledge: 'missing', structural: 'missing' },
    gateStatus: 'blocked',
    activePlan: null,
  };
}

function harnessCommand() {
  const bin = process.env.HARNESS_BIN;
  return { command: bin ? process.execPath : 'harness', prefix: bin ? [bin] : [] };
}

function takeFlag(argv, name) {
  const values = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === name && i + 1 < argv.length) values.push(argv[++i]);
    else if (arg.startsWith(`${name}=`)) values.push(arg.slice(name.length + 1));
  }
  return values;
}

function sliceFrom(parsed) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return emptySlice();
  const slice = {};
  for (const key of SLICE_KEYS) {
    if (!Object.hasOwn(parsed, key)) return emptySlice();
    slice[key] = parsed[key];
  }
  return slice;
}

function orientSlice(workspace, { query = '', files = [], readOnly = true } = {}) {
  const { command, prefix } = harnessCommand();
  const args = [...prefix, 'orient', ...(readOnly ? ['--read'] : []), '--json', '--no-events', '--workspace', workspace];
  if (query) args.push('--query', query);
  for (const file of files) args.push('--file', file);
  if (process.env.COPILOT_HOME) args.push('--copilot-home', process.env.COPILOT_HOME);
  if (process.env.HARNESS_HOME) args.push('--harness-home', process.env.HARNESS_HOME);
  const res = spawnSync(command, args, {
    cwd: workspace,
    encoding: 'utf8',
    timeout: 8000,
    env: process.env,
  });
  if (!res || res.error || res.status !== 0 || !res.stdout) return emptySlice();
  try {
    return sliceFrom(JSON.parse(res.stdout));
  } catch {
    return emptySlice();
  }
}

function readStdin() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

function parseLastJson(text) {
  const line = String(text || '').trim().split(/\r?\n/).filter(Boolean).at(-1);
  if (!line) return null;
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

export function runHostAdapter() {
  const event = process.argv[2];
  const workspace = process.cwd();
  const query = takeFlag(process.argv.slice(3), '--query')[0] || '';
  const files = takeFlag(process.argv.slice(3), '--file');
  const ranked = Boolean(query || files.length);
  const slice = orientSlice(workspace, {
    query: event === 'start' ? '' : query,
    files: event === 'start' ? [] : files,
    readOnly: event === 'start' || event === 'edit' || !ranked,
  });
  if (event === 'start') {
    process.stdout.write(`${JSON.stringify(slice)}\n`);
    process.exit(0);
  }
  if (event === 'edit') {
    const gate = spawnSync(process.execPath, [path.join(here, '..', 'require-plan-gate.mjs')], {
      cwd: workspace,
      input: readStdin(),
      encoding: 'utf8',
      timeout: 8000,
      env: process.env,
    });
    const decision = parseLastJson(gate.stdout) || {};
    process.stdout.write(`${JSON.stringify({ ...slice, ...decision })}\n`);
    process.exit(gate.status ?? 1);
  }
  if (event === 'stop') {
    const { command, prefix } = harnessCommand();
    const args = [...prefix, 'verify', '--json', '--no-events', '--workspace', workspace];
    if (process.env.COPILOT_HOME) args.push('--copilot-home', process.env.COPILOT_HOME);
    if (process.env.HARNESS_HOME) args.push('--harness-home', process.env.HARNESS_HOME);
    const verified = spawnSync(command, args, {
      cwd: workspace,
      encoding: 'utf8',
      timeout: 80000,
      env: process.env,
    });
    const body = parseLastJson(verified.stdout) || {};
    process.stdout.write(`${JSON.stringify({ ...slice, outcome: body.outcome ?? null })}\n`);
    process.exit(verified.status ?? 1);
  }
  process.stderr.write('host adapter event must be start, edit, or stop\n');
  process.exit(2);
}
