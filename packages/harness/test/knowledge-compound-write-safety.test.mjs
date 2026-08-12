import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { runInsightCompound } from '../lib/compound.mjs';
import { runRemember } from '../lib/knowledge/remember.mjs';

const tempDir = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));

test('probe C: runInsightCompound (compound --insight) refuses to write through a symlinked docs/solutions directory, and reports a clear blocked result', () => {
  const ws = tempDir('probeC-ws-');
  const copilotHome = tempDir('probeC-ch-');
  const outside = tempDir('probeC-outside-');

  fs.mkdirSync(path.join(ws, 'docs'), { recursive: true });
  fs.symlinkSync(outside, path.join(ws, 'docs', 'solutions'));

  const result = runInsightCompound({
    workspace: ws,
    copilotHome,
    flags: { title: 'probe insight', body: 'PROBE_C_WRITE_CONTENT should never land outside the workspace', category: 'insights' },
    log: () => {},
    kind: 'insight',
  });

  assert.equal(result.pass, false);
  assert.equal(result.exitCode, 1);
  assert.equal(result.path, null);
  assert.match(result.blockedReason, /escapes the workspace/);

  assert.ok(!fs.existsSync(path.join(outside, 'insights')), 'nothing was written through the symlinked docs/solutions directory');
  assert.ok(fs.lstatSync(path.join(ws, 'docs', 'solutions')).isSymbolicLink(), 'the symlink itself is untouched');
});

test('probe C: runInsightCompound still writes normally when docs/solutions is a plain directory (no false-positive refusal)', () => {
  const ws = tempDir('probeC-ok-ws-');
  const copilotHome = tempDir('probeC-ok-ch-');

  const result = runInsightCompound({
    workspace: ws,
    copilotHome,
    flags: { title: 'a normal insight', body: 'a normal insight body', category: 'insights' },
    log: () => {},
    kind: 'insight',
  });

  assert.equal(result.pass, true, JSON.stringify(result));
  assert.equal(result.exitCode, 0);
  assert.ok(result.path.startsWith('docs/solutions/insights/'));
  assert.ok(fs.existsSync(path.join(ws, result.path)), 'the episode file was actually written');
});

test('probe C (remember): harness remember refuses to write its episode through a symlinked docs/solutions directory, and surfaces the same blocked reason', () => {
  const ws = tempDir('probeC-remember-ws-');
  const copilotHome = tempDir('probeC-remember-ch-');
  const harnessHome = tempDir('probeC-remember-hh-');
  const outside = tempDir('probeC-remember-outside-');

  fs.mkdirSync(path.join(ws, 'docs'), { recursive: true });
  fs.symlinkSync(outside, path.join(ws, 'docs', 'solutions'));

  const result = runRemember({
    workspace: ws,
    copilotHome,
    home: harnessHome,
    flags: { trigger: 'a probe trigger for the symlinked remember case' },
    argv: ['a probe claim that must never land outside the workspace'],
    log: () => {},
  });

  assert.equal(result.pass, false);
  assert.equal(result.episodePath, null);
  assert.equal(result.learningId, null);
  assert.match(result.blockedReason, /escapes the workspace/);
  assert.ok(fs.readdirSync(outside).length === 0, 'nothing was written through the symlinked docs/solutions directory');
});
