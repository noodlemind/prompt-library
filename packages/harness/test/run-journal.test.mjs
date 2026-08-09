/**
 * Phase 4a — the run journal.
 *
 * The properties worth pinning are the ones a journal is FOR: that an entry is
 * never modified, that a run can be joined to the work it caused, that an
 * interrupted command is never replayed, and that a journal which loses
 * entries says so. Everything else here is ordinary querying.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { EXIT } from '../lib/style.mjs';
import {
  RUN_STATUSES,
  finishRun,
  foldRuns,
  newRunId,
  queryRuns,
  readJournal,
  runsPath,
  startRun,
} from '../lib/run-journal.mjs';
import { resumePlanFor } from '../lib/run-cmd.mjs';
import { pruneJournalFile, resetRetentionState } from '../lib/retention.mjs';
import { approveProject } from '../lib/trust.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const binPath = path.join(packageRoot, 'bin', 'harness.mjs');
const tempDir = (p) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p)));
const scopes = () => ({ workspace: tempDir('rj-ws-'), copilotHome: tempDir('rj-home-') });

function run(argv, { workspace, copilotHome }) {
  return spawnSync(process.execPath, [binPath, ...argv, '--workspace', workspace, '--copilot-home', copilotHome], {
    cwd: packageRoot, encoding: 'utf8',
  });
}

test('P4aAC1: every run carries a stable id, and ids do not collide', () => {
  const ids = new Set(Array.from({ length: 500 }, () => newRunId()));
  assert.equal(ids.size, 500, 'two runs starting in the same millisecond must not share an id');
});

// The property an audit depends on. Narrower than "the file only grows" — see
// the module doc — but this is the half that must never break.
test('P4aAC1: a terminal record never overwrites an earlier one', () => {
  const { workspace } = scopes();
  const id = newRunId();
  startRun(workspace, { run: id, command: 'verify' });
  finishRun(workspace, { run: id, status: 'succeeded', exitCode: 0 });
  finishRun(workspace, { run: id, status: 'failed', exitCode: 1 });

  const raw = readJournal(workspace);
  assert.equal(raw.length, 3, 'every record is still on disk — nothing was rewritten');
  const [folded] = foldRuns(raw);
  assert.equal(folded.status, 'succeeded', 'the first outcome is the truth; a later one cannot revise it');
});

test('P4aAC3: finishRun refuses a status outside the contract vocabulary', () => {
  const { workspace } = scopes();
  const id = newRunId();
  startRun(workspace, { run: id, command: 'verify' });
  assert.throws(() => finishRun(workspace, { run: id, status: 'interrupted' }), TypeError,
    'a status no filter matches and no reader can classify must not reach an append-only file');
  for (const status of RUN_STATUSES.filter((s) => s !== 'running')) {
    assert.doesNotThrow(() => finishRun(workspace, { run: newRunId(), status }));
  }
});

// `interrupted` is not in the vocabulary, so liveness is reported separately
// rather than invented as a status.
test('P4aAC3: a run with no outcome is `running`, with `live` telling you whether that is true', () => {
  const { workspace } = scopes();
  const mine = newRunId();
  const dead = newRunId();
  startRun(workspace, { run: mine, command: 'verify', pid: process.pid });
  startRun(workspace, { run: dead, command: 'verify', pid: 999_999 });

  const folded = foldRuns(readJournal(workspace));
  const byId = Object.fromEntries(folded.map((r) => [r.run, r]));
  assert.equal(byId[mine].status, 'running');
  assert.equal(byId[mine].live, true, 'this process is alive');
  assert.equal(byId[dead].status, 'running');
  assert.equal(byId[dead].live, false, 'a run whose process is gone is still `running` — the contract has no other word');
});

test('P4aAC5: runs are queryable by status, command, host, plan, and date', () => {
  const runs = [
    { run: 'a', command: 'verify', host: 'harness-cli', plan: 'docs/plans/x.md', status: 'succeeded', startedAt: '2026-08-01T10:00:00.000Z' },
    { run: 'b', command: 'compound', host: 'vscode', plan: null, status: 'failed', startedAt: '2026-08-05T10:00:00.000Z' },
    { run: 'c', command: 'verify', host: 'vscode', plan: 'docs/plans/y.md', status: 'failed', startedAt: '2026-08-09T10:00:00.000Z' },
  ];
  assert.deepEqual(queryRuns(runs, { status: 'failed' }).map((r) => r.run), ['b', 'c']);
  assert.deepEqual(queryRuns(runs, { command: 'verify' }).map((r) => r.run), ['a', 'c']);
  assert.deepEqual(queryRuns(runs, { host: 'vscode' }).map((r) => r.run), ['b', 'c']);
  assert.deepEqual(queryRuns(runs, { plan: 'docs/plans/y.md' }).map((r) => r.run), ['c']);
  // A bare date is what a person types; rejecting it would be a papercut on the
  // filter people reach for most.
  assert.deepEqual(queryRuns(runs, { since: '2026-08-05' }).map((r) => r.run), ['b', 'c']);
  assert.deepEqual(queryRuns(runs, { until: '2026-08-05' }).map((r) => r.run), ['a', 'b']);
  assert.deepEqual(queryRuns(runs, { since: '2026-08-02', until: '2026-08-06' }).map((r) => r.run), ['b']);
});

// P4aAC4 — the whole design of `resume` is refusing to.
test('P4aAC4: an interrupted run is never replayed', () => {
  const plan = resumePlanFor({ run: 'x', command: 'compound', status: 'running', live: false, argv: [] }, { sideEffect: 'mutate' });
  assert.equal(plan.resumable, false);
  assert.match(plan.reason, /never recorded an outcome/);
  assert.match(plan.guidance, /inspect the workspace/);
});

test('P4aAC4: a mutate- or execute-class run is not a safe boundary; a read-class one is', () => {
  assert.equal(resumePlanFor({ run: 'x', command: 'compound', status: 'failed', argv: [] }, { sideEffect: 'mutate' }).resumable, false);
  assert.equal(resumePlanFor({ run: 'x', command: 'verify', status: 'failed', argv: [] }, { sideEffect: 'execute' }).resumable, false);

  const safe = resumePlanFor({ run: 'x', command: 'status', status: 'succeeded', argv: [] }, { sideEffect: 'read' });
  assert.equal(safe.resumable, true);
  assert.equal(safe.boundary, 'command-start');
  assert.deepEqual(safe.argv, ['status']);
});

test('P4aAC4: a live run is refused with different guidance from a dead one', () => {
  const live = resumePlanFor({ run: 'x', command: 'verify', status: 'running', live: true, argv: [] }, { sideEffect: 'execute' });
  assert.equal(live.resumable, false);
  assert.match(live.reason, /still going/);
  assert.match(live.guidance, /wait for it/);
});

// --- P4aAC6: every event carries its run and actor ---

test('P4aAC6: legacy writeEvent call sites carry run and actor too', () => {
  const s = scopes();
  run(['orient', '--query', 'anything'], s);
  const events = fs.readFileSync(path.join(s.workspace, '.harness', 'events.jsonl'), 'utf8')
    .split('\n').filter(Boolean).map((l) => JSON.parse(l));

  assert.ok(events.length >= 3, 'the lifecycle pair plus the domain event');
  for (const event of events) {
    assert.ok(event.run, `${event.type} must carry its run — otherwise \`run show\` cannot find it`);
    assert.ok(event.actor, `${event.type} must carry the actor that drove it`);
  }
  // …and they all belong to the SAME run, which is the point.
  assert.equal(new Set(events.map((e) => e.run)).size, 1);
});

test('P4aAC2/P4aAC5: run show joins a command to the work it caused', () => {
  const s = scopes();
  fs.mkdirSync(path.join(s.workspace, '.github', 'harness'), { recursive: true });
  fs.writeFileSync(path.join(s.workspace, '.github', 'harness', 'checks.yaml'),
    `version: 1\nchecks:\n  probe:\n    command: ${JSON.stringify([process.execPath, '-e', '0'])}\n`);
  approveProject(s);
  run(['checks', 'run', 'probe'], s);

  const listed = JSON.parse(run(['run', 'list', '--command', 'checks', '--json'], s).stdout);
  assert.equal(listed.runs.length, 1);
  const tree = JSON.parse(run(['run', 'tree', listed.runs[0].run, '--json'], s).stdout);
  assert.ok(tree.caused.some((e) => e.type === 'exec'),
    'the execution the run caused must appear under it — the reason run ids exist');
});

// --- P4aAC7: retention, and the failures filter ---

test('P4aAC7: --failures surfaces cancelled and timed-out, not just failed', () => {
  const s = scopes();
  fs.mkdirSync(path.join(s.workspace, '.github', 'harness'), { recursive: true });
  fs.writeFileSync(path.join(s.workspace, '.github', 'harness', 'checks.yaml'),
    `version: 1\nchecks:\n  slow:\n    command: ${JSON.stringify([process.execPath, '-e', 'setTimeout(() => {}, 60000)'])}\n    timeout_seconds: 1\n`);
  approveProject(s);
  run(['checks', 'run', 'slow'], s);

  const failures = JSON.parse(run(['events', '--failures', '--json'], s).stdout);
  const statuses = failures.events.map((e) => e.status);
  assert.ok(statuses.includes('timed-out'),
    'a timed-out run maps to the legacy `warn` result — filtering on `fail` alone hid exactly the runs an operator wants most');
});

test('P4aAC7: pruning removes aged entries and records that it did', () => {
  resetRetentionState();
  const { workspace } = scopes();
  fs.mkdirSync(path.join(workspace, '.harness'), { recursive: true });
  const file = runsPath(workspace);
  const old = { schema: 1, type: 'run.start', run: 'old', ts: '2020-01-01T00:00:00.000Z', pad: 'x'.repeat(200) };
  const fresh = { schema: 1, type: 'run.start', run: 'fresh', ts: new Date().toISOString(), pad: 'x'.repeat(200) };
  const lines = [...Array.from({ length: 6000 }, () => JSON.stringify(old)), JSON.stringify(fresh)];
  fs.writeFileSync(file, `${lines.join('\n')}\n`);

  const result = pruneJournalFile(file, {
    retentionDays: 30,
    markerFor: ({ removed, cutoff }) => ({ schema: 1, type: 'journal.pruned', ts: new Date().toISOString(), removed, reason: `older than ${cutoff}` }),
  });
  assert.equal(result.removed, 6000);

  const after = readJournal(workspace);
  assert.ok(after.some((r) => r.run === 'fresh'), 'anything inside the window survives');
  const marker = after.find((r) => r.type === 'journal.pruned');
  assert.ok(marker, 'a journal that silently shrinks is worse than one that admits it');
  assert.equal(marker.removed, 6000);
});

test('P4aAC7: a small journal is never rewritten, and an undatable entry is kept', () => {
  resetRetentionState();
  const { workspace } = scopes();
  fs.mkdirSync(path.join(workspace, '.harness'), { recursive: true });
  const file = runsPath(workspace);
  fs.writeFileSync(file, `${JSON.stringify({ schema: 1, type: 'run.start', run: 'a', ts: '2020-01-01T00:00:00.000Z' })}\n`);
  const before = fs.readFileSync(file, 'utf8');
  assert.equal(pruneJournalFile(file, { retentionDays: 1 }).skipped, true,
    'rewriting a small file costs more than it saves');
  assert.equal(fs.readFileSync(file, 'utf8'), before);

  resetRetentionState();
  const big = path.join(workspace, '.harness', 'big.jsonl');
  fs.writeFileSync(big, `${'{"not":"json"'}\n${Array.from({ length: 6000 }, () => JSON.stringify({ ts: '2020-01-01T00:00:00.000Z', pad: 'x'.repeat(200) })).join('\n')}\n`);
  pruneJournalFile(big, { retentionDays: 30 });
  assert.match(fs.readFileSync(big, 'utf8'), /not":"json/,
    'an entry whose date cannot be read is kept — dropping it costs evidence, keeping it costs bytes');
});

test('a refused invocation opens no run and touches nothing', () => {
  const s = scopes();
  const res = run(['index', '--since', 'ref'], s);
  assert.equal(res.status, EXIT.usage);
  assert.equal(fs.existsSync(runsPath(s.workspace)), false, 'a command that never started has no run');
});
