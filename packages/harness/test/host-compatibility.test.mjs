import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import YAML from 'yaml';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

function read(rel) {
  return fs.readFileSync(path.join(repoRoot, rel), 'utf8');
}

function exists(rel) {
  return fs.existsSync(path.join(repoRoot, rel));
}

test('host matrix covers full and degraded target operation', () => {
  const matrix = YAML.parse(read('evals/host-compatibility.yaml'));
  const expected = [
    'github-copilot-vscode',
    'github-copilot-cli',
    'github-copilot-intellij',
    'portable-agent-skills',
  ];
  assert.deepEqual(Object.keys(matrix.hosts), expected);
  for (const host of expected) {
    assert.ok(matrix.hosts[host].full?.assertions?.length > 0, `${host} full mode`);
    assert.ok(matrix.hosts[host].degraded?.assertions?.length > 0, `${host} degraded mode`);
  }
  assert.match(read('docs/architecture/engineer-harness.md'), /automated evidence/i);
});

test('host-telemetry seam covers every supported host and degrades safely', async () => {
  const { collectHostUsage } = await import('../lib/host-telemetry/index.mjs');
  // Every supported host resolves to an adapter that returns a safe array.
  for (const host of ['github-copilot-vscode', 'github-copilot-intellij', 'github-copilot-cli']) {
    const result = collectHostUsage({ workspace: repoRoot, host });
    assert.ok(Array.isArray(result), `${host} adapter returns an array`);
  }
  // Adapter files exist for the multi-platform structure.
  for (const rel of [
    'packages/harness/lib/host-telemetry/index.mjs',
    'packages/harness/lib/host-telemetry/vscode.mjs',
    'packages/harness/lib/host-telemetry/intellij.mjs',
    'packages/harness/lib/host-telemetry/copilot-cli.mjs',
  ]) {
    assert.ok(exists(rel), `missing ${rel}`);
  }
});

test('portable sources and built assets preserve the thin runtime contract', () => {
  const build = spawnSync(process.execPath, ['scripts/build-harness-assets.mjs'], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  assert.equal(build.status, 0, build.stderr);

  const skillDirs = fs
    .readdirSync(path.join(repoRoot, '.github', 'skills'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && exists(`.github/skills/${entry.name}/SKILL.md`));
  for (const entry of skillDirs) {
    const text = read(`.github/skills/${entry.name}/SKILL.md`);
    const frontmatter = text.match(/^---\n([\s\S]*?)\n---/)?.[1];
    assert.ok(frontmatter, `${entry.name} frontmatter`);
    const parsed = YAML.parse(frontmatter);
    assert.equal(parsed.name, entry.name);
    assert.match(parsed.description || '', /\S/, `${entry.name} description`);
  }

  const assetEngineer = read('packages/harness/assets/agents/engineer.agent.md');
  assert.match(assetEngineer, /9\. Report/i);
  assert.doesNotMatch(assetEngineer, /Skill-first contract \(mandatory\)/i);
  assert.equal(exists('packages/harness/assets/skills/engineer-autopilot/SKILL.md'), false);
  assert.match(read('packages/harness/assets/skills/work-on-task/SKILL.md'), /harness verify --plan/i);
  assert.match(read('packages/harness/assets/hooks/hooks.json'), /require-verification\.mjs/);
});
