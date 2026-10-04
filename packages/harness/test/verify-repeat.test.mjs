import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { listLearnings, storeDir } from '../lib/knowledge/store.mjs';
import { binPath, runHarness } from './helpers/cli.mjs';
import { initGit, recordSuccessfulEdit, writeChecks, writeVersionedPlan } from './helpers/cli-fixtures.mjs';
import { trackWorkspaceSolutions } from './helpers/workspace.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const hookPath = path.resolve(packageRoot, '../../.github/hooks/require-verification.mjs');
const CLAIM = 'raw concatenation';
const TRIGGER = 'raw concatenation';
const APPLIES = 'The handler builds sql.';
const DOES_NOT = 'A billing pdf stays plain.';
const WHY = 'a joined string builds the query';
const BAD = 'export const value = 1;\n// handler uses Raw Concatenation today\n';
const CLEAR = 'export const value = 1;\n// uses parameterized queries\n';

function ctx() {
  const ws = trackWorkspaceSolutions(fs.mkdtempSync(path.join(os.tmpdir(), 'verify-repeat-ws-')));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-repeat-home-'));
  const harnessHome = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-repeat-hh-'));
  writeChecks(ws, { 'unit-tests': { command: [process.execPath, '-e', 'process.exit(0)'] } });
  const plan = writeVersionedPlan(ws);
  initGit(ws);
  return { ws, home, harnessHome, plan };
}

function harness(c, args) {
  return runHarness(
    [...args, '--workspace', c.ws, '--copilot-home', c.home, '--harness-home', c.harnessHome, '--json', '--no-events'],
    { env: { HARNESS_HOME: c.harnessHome, COPILOT_HOME: c.home, HARNESS_NO_EVENTS: '1' } },
  );
}

function teach(c) {
  const enabled = harness(c, ['knowledge', 'on']);
  assert.equal(enabled.status, 0, enabled.stderr + enabled.stdout);
  const taught = harness(c, [
    'correct', CLAIM,
    '--trigger', TRIGGER,
    '--why', WHY,
    '--applies', APPLIES,
    '--does-not-apply', DOES_NOT,
    '--shows', 'Raw Concatenation',
    '--authority', 'correction',
    '--domain', 'sql',
  ]);
  assert.equal(taught.status, 0, taught.stderr + taught.stdout);
  const learning = listLearnings(storeDir(c.ws, { home: c.harnessHome })).find((row) => row.id === 'sql/raw-concatenation');
  assert.ok(learning, taught.stdout);
  return fs.readFileSync(learning.file);
}

function orient(c) {
  const res = harness(c, ['orient', '--query', TRIGGER]);
  assert.equal(res.status, 0, res.stderr + res.stdout);
}

function verify(c) {
  return harness(c, ['verify', '--plan', c.plan, '--base', 'HEAD']);
}

function git(cwd, args) {
  return spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
  });
}

function teachAudit(c, shows) {
  const claim = 'save skips the audit stamp';
  const enabled = harness(c, ['knowledge', 'on']);
  assert.equal(enabled.status, 0, enabled.stderr + enabled.stdout);
  const taught = harness(c, [
    'correct', claim,
    '--trigger', claim,
    '--why', 'the row lands without the stamp',
    '--applies', 'A save writes the audit stamp on the stored row.',
    '--does-not-apply', 'A task asks to remove the audit stamp.',
    '--shows', shows,
    '--authority', 'correction',
    '--domain', 'sql',
  ]);
  assert.equal(taught.status, 0, taught.stderr + taught.stdout);
  const gate = harness(c, ['gate', '--plan', c.plan, '--phase', 'implement']);
  assert.equal(gate.status, 0, gate.stderr + gate.stdout);
  const found = harness(c, ['orient', '--query', claim]);
  assert.equal(found.status, 0, found.stderr + found.stdout);
}

function stop(c, enforcement) {
  return spawnSync(process.execPath, [hookPath], {
    cwd: c.ws,
    input: JSON.stringify({ cwd: c.ws, workspace: c.ws, hook_event_name: 'Stop', stop_hook_active: false }),
    encoding: 'utf8',
    env: {
      ...process.env,
      HARNESS_BIN: binPath,
      HARNESS_HOME: c.harnessHome,
      COPILOT_HOME: c.home,
      HARNESS_ENFORCEMENT: enforcement,
      HARNESS_NO_EVENTS: '1',
    },
  });
}

function stopJson(result) {
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const line = result.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1);
  return JSON.parse(line);
}

test('verify marks repeated-mistake from the diff tokens and leaves the lesson file untouched', () => {
  const c = ctx();
  const before = teach(c);
  fs.writeFileSync(path.join(c.ws, 'src', 'example.js'), BAD);
  const gate = harness(c, ['gate', '--plan', c.plan, '--phase', 'implement']);
  assert.equal(gate.status, 0, gate.stderr + gate.stdout);
  orient(c);
  const repeated = verify(c);
  assert.equal(repeated.status, 2, repeated.stderr + repeated.stdout);
  assert.equal(JSON.parse(repeated.stdout).outcome, 'repeated-mistake');
  const learning = listLearnings(storeDir(c.ws, { home: c.harnessHome })).find((row) => row.id === 'sql/raw-concatenation');
  assert.equal(fs.readFileSync(learning.file).equals(before), true);

  fs.writeFileSync(path.join(c.ws, 'src', 'example.js'), CLEAR);
  const passed = verify(c);
  assert.equal(passed.status, 0, passed.stderr + passed.stdout);
  assert.equal(JSON.parse(passed.stdout).outcome, 'passed');
  assert.equal(fs.readFileSync(learning.file).equals(before), true);
});

test('stop blocks repeated-mistake under enforce and names harness correct', () => {
  const c = ctx();
  teach(c);
  fs.writeFileSync(path.join(c.ws, 'src', 'example.js'), BAD);
  const gate = harness(c, ['gate', '--plan', c.plan, '--phase', 'implement']);
  assert.equal(gate.status, 0, gate.stderr + gate.stdout);
  recordSuccessfulEdit(c.ws, { file_path: 'src/example.js' });
  orient(c);
  const blocked = stopJson(stop(c, 'enforce'));
  assert.equal(blocked.hookSpecificOutput.decision, 'block');
  assert.match(blocked.hookSpecificOutput.reason, /harness correct/);
  assert.match(blocked.hookSpecificOutput.reason, /repeated-mistake/);
});

test('stop warns and continues when repeated-mistake meets warn enforcement', () => {
  const c = ctx();
  teach(c);
  fs.writeFileSync(path.join(c.ws, 'src', 'example.js'), BAD);
  const gate = harness(c, ['gate', '--plan', c.plan, '--phase', 'implement']);
  assert.equal(gate.status, 0, gate.stderr + gate.stdout);
  recordSuccessfulEdit(c.ws, { file_path: 'src/example.js' });
  orient(c);
  const warned = stopJson(stop(c, 'warn'));
  assert.equal(warned.continue, true);
  assert.match(warned.systemMessage, /repeated-mistake/);
});

test('a served lesson the diff did not use still stops cleanly', () => {
  const c = ctx();
  teach(c);
  fs.writeFileSync(path.join(c.ws, 'src', 'example.js'), CLEAR);
  const gate = harness(c, ['gate', '--plan', c.plan, '--phase', 'implement']);
  assert.equal(gate.status, 0, gate.stderr + gate.stdout);
  recordSuccessfulEdit(c.ws, { file_path: 'src/example.js' });
  orient(c);
  const allowed = stopJson(stop(c, 'enforce'));
  assert.equal(allowed.continue, true);
});

test('verify repeats the stored shows phrase when the diff never quotes the claim', () => {
  const c = ctx();
  const claim = 'save skips the audit stamp';
  const applies = 'A save writes the audit stamp on the stored row.';
  const doesNot = 'A task asks to remove the audit stamp.';
  const enabled = harness(c, ['knowledge', 'on']);
  assert.equal(enabled.status, 0, enabled.stderr + enabled.stdout);
  const taught = harness(c, [
    'correct', claim,
    '--trigger', claim,
    '--why', 'the row lands without the stamp',
    '--applies', applies,
    '--does-not-apply', doesNot,
    '--shows', 'replaceRow',
    '--authority', 'correction',
    '--domain', 'sql',
  ]);
  assert.equal(taught.status, 0, taught.stderr + taught.stdout);
  const learning = listLearnings(storeDir(c.ws, { home: c.harnessHome })).find((row) => row.id === 'sql/save-skips-the-audit-stamp');
  assert.ok(learning, taught.stdout);
  const before = fs.readFileSync(learning.file);
  const gate = harness(c, ['gate', '--plan', c.plan, '--phase', 'implement']);
  assert.equal(gate.status, 0, gate.stderr + gate.stdout);
  const found = harness(c, ['orient', '--query', claim]);
  assert.equal(found.status, 0, found.stderr + found.stdout);

  fs.writeFileSync(path.join(c.ws, 'src', 'example.js'), 'function replaceRow(row) { store.write(row); return row; }\n');
  const repeated = verify(c);
  assert.equal(repeated.status, 2, repeated.stderr + repeated.stdout);
  assert.equal(JSON.parse(repeated.stdout).outcome, 'repeated-mistake');
  assert.equal(fs.readFileSync(learning.file).equals(before), true);

  fs.writeFileSync(path.join(c.ws, 'src', 'example.js'), 'function replaceRow(row) { store.write(row); return row; }\nA task asks to remove the audit stamp.\n');
  const scopedOut = verify(c);
  assert.equal(scopedOut.status, 0, scopedOut.stderr + scopedOut.stdout);
  assert.equal(JSON.parse(scopedOut.stdout).outcome, 'passed');
  assert.equal(fs.readFileSync(learning.file).equals(before), true);

  fs.writeFileSync(path.join(c.ws, 'src', 'example.js'), 'function save(row) { row.auditStamp = clock.now(); store.write(row); return row; }\n');
  const stamped = verify(c);
  assert.equal(stamped.status, 0, stamped.stderr + stamped.stdout);
  assert.equal(JSON.parse(stamped.stdout).outcome, 'passed');
  assert.equal(fs.readFileSync(learning.file).equals(before), true);
});

test('verify passes when the refused symbol survives only on a deleted line', () => {
  const c = ctx();
  teachAudit(c, 'replaceRow');
  const file = path.join(c.ws, 'src', 'example.js');
  fs.writeFileSync(file, 'function replaceRow(row) { store.write(row); return row; }\n');
  const added = git(c.ws, ['add', 'src/example.js']);
  assert.equal(added.status, 0, added.stderr);
  const committed = git(c.ws, ['commit', '-qm', 'plant the refused call']);
  assert.equal(committed.status, 0, committed.stderr);
  fs.writeFileSync(file, 'function save(row) { row.auditStamp = clock.now(); store.write(row); return row; }\n');
  const cleared = verify(c);
  assert.equal(cleared.status, 0, cleared.stderr + cleared.stdout);
  assert.equal(JSON.parse(cleared.stdout).outcome, 'passed');
});

test('verify repeats a short symbol the tokenizer drops and ignores a longer name', () => {
  const c = ctx();
  teachAudit(c, 'id');
  const file = path.join(c.ws, 'src', 'example.js');
  fs.writeFileSync(file, 'const id = 1;\n');
  const repeated = verify(c);
  assert.equal(repeated.status, 2, repeated.stderr + repeated.stdout);
  assert.equal(JSON.parse(repeated.stdout).outcome, 'repeated-mistake');

  fs.writeFileSync(file, 'const identity = 1;\n');
  const longer = verify(c);
  assert.equal(longer.status, 0, longer.stderr + longer.stdout);
  assert.equal(JSON.parse(longer.stdout).outcome, 'passed');

  fs.writeFileSync(file, 'const id = 1;\nA task asks to remove the audit stamp.\n');
  const scopedOut = verify(c);
  assert.equal(scopedOut.status, 0, scopedOut.stderr + scopedOut.stdout);
  assert.equal(JSON.parse(scopedOut.stdout).outcome, 'passed');
});

test('verify repeats an operator symbol the tokenizer drops', () => {
  const c = ctx();
  teachAudit(c, '++');
  fs.writeFileSync(path.join(c.ws, 'src', 'example.js'), 'function bump(i) { return i++; }\n');
  const repeated = verify(c);
  assert.equal(repeated.status, 2, repeated.stderr + repeated.stdout);
  assert.equal(JSON.parse(repeated.stdout).outcome, 'repeated-mistake');
});

test('verify repeats a dotted call stored as shows', () => {
  const c = ctx();
  teachAudit(c, 'store.rows.replace(row)');
  fs.writeFileSync(path.join(c.ws, 'src', 'example.js'), 'store.rows.replace(row);\n');
  const repeated = verify(c);
  assert.equal(repeated.status, 2, repeated.stderr + repeated.stdout);
  assert.equal(JSON.parse(repeated.stdout).outcome, 'repeated-mistake');
});

test('a correction with no shows stays clear when the diff quotes the claim', () => {
  const c = ctx();
  const claim = 'save skips the audit stamp';
  const enabled = harness(c, ['knowledge', 'on']);
  assert.equal(enabled.status, 0, enabled.stderr + enabled.stdout);
  const dir = storeDir(c.ws, { home: c.harnessHome });
  const file = path.join(dir, 'learnings', 'sql', 'save-skips-the-audit-stamp.md');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const body = [
    '---',
    'schema: 1',
    `trigger: "${claim}"`,
    'status: active',
    'source: human',
    'authority: correction',
    'why: "the row lands without the stamp"',
    'applies: "A save writes the audit stamp on the stored row."',
    'does_not_apply: "A task asks to remove the audit stamp."',
    'anchors: []',
    'superseded_by: null',
    'last_confirmed: null',
    'origin: unknown',
    '---',
    '',
    claim,
    '',
  ].join('\n');
  fs.writeFileSync(file, body);
  const before = fs.readFileSync(file);
  fs.writeFileSync(path.join(c.ws, 'src', 'example.js'), `// ${claim}\n`);
  const gate = harness(c, ['gate', '--plan', c.plan, '--phase', 'implement']);
  assert.equal(gate.status, 0, gate.stderr + gate.stdout);
  const found = harness(c, ['orient', '--query', claim]);
  assert.equal(found.status, 0, found.stderr + found.stdout);
  assert.equal(JSON.parse(found.stdout).learnings.some((row) => row.id === 'sql/save-skips-the-audit-stamp'), true, found.stdout);
  const passed = verify(c);
  assert.equal(passed.status, 0, passed.stderr + passed.stdout);
  assert.equal(JSON.parse(passed.stdout).outcome, 'passed');
  assert.equal(fs.readFileSync(file).equals(before), true);
});

test('an instruction is not a diff predicate', () => {
  const c = ctx();
  const claim = 'Handlers keep the ledger intact.';
  const enabled = harness(c, ['knowledge', 'on']);
  assert.equal(enabled.status, 0, enabled.stderr + enabled.stdout);
  const taught = harness(c, [
    'correct', claim,
    '--trigger', claim,
    '--why', 'the ledger stays the source',
    '--applies', 'Handlers keep the ledger row.',
    '--does-not-apply', 'Handlers skip a cold ledger.',
    '--authority', 'instruction',
    '--domain', 'sql',
  ]);
  assert.equal(taught.status, 0, taught.stderr + taught.stdout);
  fs.writeFileSync(path.join(c.ws, 'src', 'example.js'), `${claim}\n`);
  const gate = harness(c, ['gate', '--plan', c.plan, '--phase', 'implement']);
  assert.equal(gate.status, 0, gate.stderr + gate.stdout);
  const found = harness(c, ['orient', '--query', claim]);
  assert.equal(found.status, 0, found.stderr + found.stdout);
  const passed = verify(c);
  assert.equal(passed.status, 0, passed.stderr + passed.stdout);
  assert.equal(JSON.parse(passed.stdout).outcome, 'passed');
});

test('orient --read arms verify with the stored file list when the query misses', () => {
  const c = ctx();
  const enabled = harness(c, ['knowledge', 'on']);
  assert.equal(enabled.status, 0, enabled.stderr + enabled.stdout);
  const taught = harness(c, [
    'correct', 'save skips the audit stamp',
    '--trigger', 'example',
    '--why', 'the row lands without the stamp',
    '--applies', 'A save writes the audit stamp on the stored row.',
    '--does-not-apply', 'A task asks to remove the audit stamp.',
    '--shows', 'replaceRow',
    '--authority', 'correction',
    '--domain', 'sql',
  ]);
  assert.equal(taught.status, 0, taught.stderr + taught.stdout);
  fs.writeFileSync(path.join(c.ws, 'src', 'example.js'), 'function replaceRow(row) { store.write(row); return row; }\n');
  const gate = harness(c, ['gate', '--plan', c.plan, '--phase', 'implement']);
  assert.equal(gate.status, 0, gate.stderr + gate.stdout);
  const ranked = harness(c, ['orient', '--read', '--query', 'compile the weekly report', '--file', 'src/example.js']);
  assert.equal(ranked.status, 0, ranked.stderr + ranked.stdout);
  assert.equal(fs.existsSync(path.join(c.ws, '.harness', 'repo-map.md')), false);
  assert.equal(fs.existsSync(path.join(c.ws, '.harness', 'context-pack.md')), false);
  const repeated = verify(c);
  assert.equal(repeated.status, 2, repeated.stderr + repeated.stdout);
  assert.equal(JSON.parse(repeated.stdout).outcome, 'repeated-mistake');
});

test('a stop with no fresh passing evidence does not complete', () => {
  const c = ctx();
  fs.rmSync(path.join(c.ws, '.github', 'harness', 'checks.yaml'));
  fs.writeFileSync(path.join(c.ws, 'src', 'example.js'), CLEAR);
  const gate = harness(c, ['gate', '--plan', c.plan, '--phase', 'implement']);
  assert.equal(gate.status, 0, gate.stderr + gate.stdout);
  recordSuccessfulEdit(c.ws, { file_path: 'src/example.js' });
  const blocked = stopJson(stop(c, 'enforce'));
  assert.equal(blocked.hookSpecificOutput.decision, 'block');
  const evidenceDir = path.join(c.ws, '.harness', 'evidence');
  assert.equal(fs.existsSync(evidenceDir), true);
});
