import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import YAML from 'yaml';
import { recordSkillUsage } from '../lib/telemetry.mjs';

function fixture(t) {
  const copilotHome = fs.mkdtempSync(path.join(os.tmpdir(), 'telemetry-lock-'));
  t.after(() => fs.rmSync(copilotHome, { recursive: true, force: true }));
  const record = () => recordSkillUsage({
    copilotHome,
    plan: { path: 'accepted.md', fm: { skills_used: ['engineer'] } },
    evidence: { outcome: 'passed' },
  });
  assert.equal(record().error, null);
  const file = path.join(copilotHome, 'knowledge', 'skill-usage.yaml');
  return { record, file, before: fs.readFileSync(file, 'utf8') };
}

function acquisitionFault(file, code, failures, run) {
  const open = fs.openSync;
  let attempts = 0;
  fs.openSync = (target, flags, ...args) => {
    if (target === `${file}.lock` && flags === 'wx' && ++attempts <= failures) {
      throw Object.assign(new Error(`${code}: telemetry lock acquisition refused`), { code });
    }
    return open(target, flags, ...args);
  };
  try { return run(() => attempts); }
  finally { fs.openSync = open; }
}

for (const code of ['EPERM', 'EACCES']) {
  test(`telemetry recovers from a transient ${code} acquiring its lock`, t => {
    const f = fixture(t);
    acquisitionFault(f.file, code, 1, attempts => {
      const result = f.record();
      assert.equal(result.error, null);
      assert.deepEqual(result.updated, ['engineer']);
      assert.equal(attempts(), 2);
    });
    const usage = YAML.parse(fs.readFileSync(f.file, 'utf8'));
    assert.equal(usage.skills.engineer.usage_count, 2);
    assert.equal(usage.skills.engineer.outcomes.passed, 2);
    assert.equal(fs.existsSync(`${f.file}.lock`), false);
  });

  test(`telemetry bounds persistent ${code} retries and preserves the original failure`, t => {
    const f = fixture(t);
    acquisitionFault(f.file, code, Infinity, attempts => {
      const result = f.record();
      assert.equal(result.error, `${code}: telemetry lock acquisition refused`);
      assert.deepEqual(result.updated, []);
      assert.ok(attempts() > 1 && attempts() <= 50);
    });
    assert.equal(fs.readFileSync(f.file, 'utf8'), f.before);
    assert.equal(fs.existsSync(`${f.file}.lock`), false);
  });
}

test('telemetry does not retry an unrelated lock acquisition error', t => {
  const f = fixture(t);
  acquisitionFault(f.file, 'EIO', Infinity, attempts => {
    const result = f.record();
    assert.equal(result.error, 'EIO: telemetry lock acquisition refused');
    assert.deepEqual(result.updated, []);
    assert.equal(attempts(), 1);
  });
  assert.equal(fs.readFileSync(f.file, 'utf8'), f.before);
});
