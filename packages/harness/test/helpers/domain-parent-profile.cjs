const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const { performance } = require('node:perf_hooks');
const { syncBuiltinESMExports } = require('node:module');

const scoped = process.argv.some(value => /(?:^|[\\/])domain-(?:commands|context)\.test\.mjs$/.test(value) || /(?:^|[\\/])domain-command-journey-[^\\/]+(?:[\\/]|$)/.test(value)) || /(?:^|[\\/])experiment-cli-[^\\/]+(?:[\\/]|$)/.test(process.cwd());
const directory = process.env.HARNESS_PARENT_PROFILE_LOG;
const MAX_BYTES = 1024 * 1024, MAX_ROWS = 4096, RESERVE = 32 * 1024;
const verbs = ['rev-parse', 'config', 'diff', 'status', 'symbolic-ref', 'ls-files', 'worktree', 'rev-list'];
const actions = ['start', 'progress', 'complete', 'amend', 'convert'];
const started = performance.now(), groups = new Map();
let fd = null, rows = 0, bytes = 0, capped = false, sealed = false, lastSummary = started, gitCalls = 0, gitMs = 0;
const milliseconds = value => +value.toFixed(3);
const summary = () => ({ type: 'summary', pid: process.pid, elapsedMs: milliseconds(performance.now() - started), gitCalls, gitMs: milliseconds(gitMs), capped, groups: [...groups.values()].map(value => ({ ...value, elapsedMs: milliseconds(value.elapsedMs), maxMs: milliseconds(value.maxMs) })) });
const append = (value, final = false) => {
  if (fd === null || sealed) return;
  try {
    const text = JSON.stringify(value) + '\n', size = Buffer.byteLength(text);
    if (!final && (rows >= MAX_ROWS - 1 || bytes + size > MAX_BYTES - RESERVE)) {
      capped = true;
      append(summary(), true);
      sealed = true;
      return;
    }
    if (rows < MAX_ROWS && bytes + size <= MAX_BYTES) { fs.writeSync(fd, text); rows++; bytes += size; }
  } catch { sealed = true; }
};

if (directory && scoped) {
  try {
    fs.mkdirSync(directory, { recursive: true });
    const stat = fs.lstatSync(directory);
    if (stat.isDirectory() && !stat.isSymbolicLink()) fd = fs.openSync(path.join(directory, `${process.pid}-${Date.now()}.jsonl`), 'wx');
  } catch {}
}

const label = process.argv.slice(2, 4).filter(value => /^[a-z-]{1,64}$/.test(value));
let action = null;
const decisionIndex = process.argv.indexOf('--file');
if (fd !== null && label.join(':') === 'domain:plan-update' && decisionIndex >= 0) {
  try {
    const file = process.argv[decisionIndex + 1], stat = fs.lstatSync(file);
    if (stat.isFile() && !stat.isSymbolicLink() && stat.size <= 64 * 1024) {
      const value = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (actions.includes(value.action)) action = value.action;
    }
  } catch {}
}
append({ type: 'start', pid: process.pid, ppid: process.ppid, platform: process.platform, label, action, validateCompletion: process.argv.includes('--validate-completion') });

if (fd !== null) {
  const original = cp.spawnSync;
  cp.spawnSync = function(command, args, options) {
    const begin = performance.now();
    const caller = new Error().stack.match(/packages[\\/]harness[\\/](.*?\.mjs:\d+:\d+)/)?.[1]?.replace(/\\/g, '/').slice(0, 160) || null;
    const result = original.apply(this, arguments);
    const name = path.basename(String(command)).replace(/\.exe$/i, '').toLowerCase();
    const kind = ['git', 'node'].includes(name) ? name : 'other';
    const verb = Array.isArray(args) ? args.find(value => verbs.includes(value)) || null : null;
    const elapsedMs = performance.now() - begin, errorCode = /^[A-Z_]{1,32}$/.test(result.error?.code || '') ? result.error.code : null;
    let key = JSON.stringify([kind, verb, caller]);
    if (!groups.has(key) && groups.size >= 31) key = 'other';
    const group = groups.get(key) || { kind: key === 'other' ? 'other' : kind, verb: key === 'other' ? null : verb, caller: key === 'other' ? null : caller, count: 0, elapsedMs: 0, maxMs: 0, timedOut: 0 };
    group.count++; group.elapsedMs += elapsedMs; group.maxMs = Math.max(group.maxMs, elapsedMs); if (errorCode === 'ETIMEDOUT') group.timedOut++;
    groups.set(key, group);
    if (kind === 'git') { gitCalls++; gitMs += elapsedMs; }
    append({ type: 'spawn', pid: process.pid, kind, verb, caller, elapsedMs: milliseconds(elapsedMs), timeoutMs: options?.timeout ?? null, status: result.status, signal: result.signal, errorCode });
    if (gitCalls === 1 || gitCalls % 16 === 0 || performance.now() - lastSummary >= 250) { append(summary()); lastSummary = performance.now(); }
    return result;
  };
  syncBuiltinESMExports();
  process.on('exit', code => {
    append(summary()); append({ type: 'exit', pid: process.pid, code, elapsedMs: milliseconds(performance.now() - started) });
    try { fs.closeSync(fd); } catch {}
  });
}

module.exports = {
  record(stage, details = {}) {
    if (!['fixture-cli', 'production-completion', 'checkpoint'].includes(stage)) return;
    const value = { type: 'checkpoint', pid: process.pid, stage };
    for (const field of ['elapsedMs', 'timeoutMs', 'status', 'childPid']) if (details[field] === null || typeof details[field] === 'number' && Number.isFinite(details[field])) value[field] = details[field];
    if (typeof details.pass === 'boolean') value.pass = details.pass;
    if (actions.includes(details.action)) value.action = details.action;
    if (details.signal === null || /^SIG[A-Z]{1,16}$/.test(details.signal || '')) value.signal = details.signal;
    if (details.errorCode === null || /^[A-Z_]{1,32}$/.test(details.errorCode || '')) value.errorCode = details.errorCode;
    append(value); append(summary());
  },
};
