import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import YAML from 'yaml';
import { recordSkillUsage } from '../lib/telemetry.mjs';

function fixture(t) {
  const copilotHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ae-telemetry-lock-'));
  t.after(() => fs.rmSync(copilotHome, { recursive: true, force: true }));
  const file = path.join(copilotHome, 'knowledge/skill-usage.yaml');
  return { copilotHome, file, plan: { path: 'accepted.md', fm: { skills_used: ['engineer'] } }, evidence: { outcome: 'passed' } };
}

function denyLockOpen(file, code, failures, action) {
  const original = fs.openSync;
  let attempts = 0;
  fs.openSync = (target, flags, ...args) => {
    if (target === `${file}.lock` && flags === 'wx' && ++attempts <= failures) {
      throw Object.assign(new Error(`${code}: lock access denied`), { code });
    }
    return original(target, flags, ...args);
  };
  try { return action(); }
  finally { fs.openSync = original; }
}

for (const code of ['EPERM', 'EACCES']) {
  test(`telemetry preserves the update after transient ${code} lock contention`, t => {
    const f = fixture(t);
    const result = denyLockOpen(f.file, code, 2, () => recordSkillUsage(f));
    assert.equal(result.error, null);
    const usage = YAML.parse(fs.readFileSync(f.file, 'utf8'));
    assert.equal(usage.skills.engineer.usage_count, 1);
    assert.equal(usage.skills.engineer.outcomes.passed, 1);
    assert.equal(fs.existsSync(`${f.file}.lock`), false);
  });

  test(`telemetry retains a permanent ${code} error without changing history`, t => {
    const f = fixture(t), original = 'version: 2\nskills: {}\n';
    fs.mkdirSync(path.dirname(f.file), { recursive: true });
    fs.writeFileSync(f.file, original);
    const result = denyLockOpen(f.file, code, Infinity, () => recordSkillUsage(f));
    assert.deepEqual(result.updated, []);
    assert.match(result.error, new RegExp(code));
    assert.equal(fs.readFileSync(f.file, 'utf8'), original);
    assert.equal(fs.existsSync(`${f.file}.lock`), false);
  });
}
