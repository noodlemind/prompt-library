import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { findStaleOrphans } from '../lib/sync.mjs';
import { runDoctor } from '../lib/doctor.mjs';

function write(root, rel, body = 'x') {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, body);
}

function scaffold() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-orphan-'));
  const assets = path.join(dir, 'assets');
  const home = path.join(dir, 'home');
  const pkg = path.join(dir, 'pkg');
  // Current assets ship the engineer agent + one skill.
  write(assets, 'agents/engineer.agent.md');
  write(assets, 'skills/engineer/SKILL.md');
  // The hydrated home has: the current ones, a retired one, and a true orphan.
  write(home, 'agents/engineer.agent.md');
  write(home, 'skills/engineer/SKILL.md');
  write(home, 'skills/btw/SKILL.md'); // retired (covered by "skills/btw")
  write(home, 'prompts/old.prompt.md'); // retired (covered by "prompts")
  write(home, 'agents/ghost-reviewer.agent.md'); // ORPHAN: gone from assets, not retired
  write(home, 'knowledge/solutions/user.md'); // user-owned, never an orphan
  fs.mkdirSync(pkg, { recursive: true });
  fs.writeFileSync(path.join(pkg, 'retired.json'), JSON.stringify({ retired: ['skills/btw', 'prompts'] }));
  return { dir, assets, home, pkg };
}

test('findStaleOrphans flags only hydrated files that are neither shipped nor retired', () => {
  const { dir, assets, home } = scaffold();
  const orphans = findStaleOrphans(home, assets, ['skills/btw', 'prompts']);
  assert.deepEqual(orphans, ['agents/ghost-reviewer.agent.md']);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('findStaleOrphans returns nothing for a clean home', () => {
  const { dir, assets, home } = scaffold();
  fs.rmSync(path.join(home, 'agents', 'ghost-reviewer.agent.md'));
  assert.deepEqual(findStaleOrphans(home, assets, ['skills/btw', 'prompts']), []);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('doctor H17 fails (optional) and lists the orphan', async () => {
  const { dir, assets, home, pkg } = scaffold();
  fs.mkdirSync(path.join(dir, 'ws', 'docs', 'plans'), { recursive: true });
  const { checks } = await runDoctor({ copilotHome: home, assetsRoot: assets, pkgRoot: pkg, flags: { workspace: path.join(dir, 'ws') } });
  const h17 = checks.find((c) => c.id === 'H17');
  assert.ok(h17, 'H17 check present');
  assert.equal(h17.pass, false);
  assert.equal(h17.optional, true, 'advisory: does not fail the overall install');
  assert.match(h17.hint, /ghost-reviewer\.agent\.md/);
  assert.doesNotMatch(h17.hint, /btw|prompts|user\.md/, 'retired and user-owned files are not orphans');
  fs.rmSync(dir, { recursive: true, force: true });
});
