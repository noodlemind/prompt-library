import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { runHarness, tempDir } from './helpers/index.mjs';
import { initGit, writeChecks, writeVersionedPlan } from './helpers/cli-fixtures.mjs';
import { TEST_GIT_ENV } from './helpers/store.mjs';

const GIT_ENV = { ...process.env, ...TEST_GIT_ENV, CI: '', HARNESS_ALLOW_INPLACE: '' };

function git(cwd, args) {
  return spawnSync('git', args, { cwd, encoding: 'utf8', env: GIT_ENV });
}

function currentBranch(ws) {
  return git(ws, ['symbolic-ref', '--quiet', '--short', 'HEAD']).stdout.trim();
}

function withOrigin(ws) {
  const branch = currentBranch(ws) || 'master';
  const sha = git(ws, ['rev-parse', 'HEAD']).stdout.trim();
  git(ws, ['update-ref', `refs/remotes/origin/${branch}`, sha]);
  git(ws, ['symbolic-ref', 'refs/remotes/origin/HEAD', `refs/remotes/origin/${branch}`]);
  return branch;
}

function addTracked(ws, rel, body) {
  const full = path.join(ws, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, body);
  assert.equal(git(ws, ['add', '--', rel]).status, 0, git(ws, ['add', '--', rel]).stderr);
  assert.equal(git(ws, ['commit', '-qm', `add ${rel}`]).status, 0);
}

function planWorkspace(specRel) {
  const ws = tempDir('issue-intake-');
  initGit(ws);
  writeChecks(ws, { 'unit-tests': { command: [process.execPath, '-e', 'process.exit(0)'] } });
  if (specRel) addTracked(ws, specRel, '# Checkout retry\n\nRefunds share the payment retry budget.\n');
  return ws;
}

function gateJson(ws, extra = [], env = {}) {
  const plan = writeVersionedPlan(ws, extra.planOpts || {});
  const args = ['gate', '--phase', 'implement', '--plan', plan, '--workspace', ws, '--json', ...(extra.args || [])];
  const result = runHarness(args, { env: { ...GIT_ENV, ...env } });
  let body = null;
  try {
    body = JSON.parse(result.stdout);
  } catch {
    body = { raw: result.stdout };
  }
  return { result, body, plan };
}

test('discoverIntentSources lists tracked spec, adr, and intent files and ignores noise', async () => {
  const { discoverIntentSources } = await import('../lib/intent-sources.mjs');
  const ws = planWorkspace();
  addTracked(ws, 'docs/specs/checkout.md', '# Checkout\n');
  addTracked(ws, 'docs/adr/0001-payments.md', '# ADR 1\n');
  addTracked(ws, 'docs/intents/billing.intent.md', '# Billing intent\n');
  addTracked(ws, 'docs/notes/readme.md', '# Notes\n');
  const sources = discoverIntentSources(ws);
  assert.deepEqual(
    sources.map((s) => s.path).sort(),
    ['docs/adr/0001-payments.md', 'docs/intents/billing.intent.md', 'docs/specs/checkout.md']
  );
  assert.equal(sources.find((s) => s.path.endsWith('checkout.md')).kind, 'spec');
  assert.equal(sources.find((s) => s.path.includes('adr')).kind, 'adr');
  assert.equal(sources.find((s) => s.path.includes('intent')).kind, 'intent');
});

test('orient --json names intent sources and tells the agent to read them', () => {
  const ws = planWorkspace('docs/specs/checkout.md');
  writeVersionedPlan(ws);
  const result = runHarness(['orient', '--query', 'checkout retry', '--workspace', ws, '--json'], { env: GIT_ENV });
  assert.equal(result.status, 0, result.stderr);
  const body = JSON.parse(result.stdout);
  assert.ok(Array.isArray(body.intentSources), 'orient JSON includes intentSources');
  assert.equal(body.intentSources[0].path, 'docs/specs/checkout.md');
  assert.equal(body.intentSources[0].kind, 'spec');
  assert.ok(
    (body.nextTools || []).some((t) => t.includes('docs/specs/checkout.md')),
    `nextTools should name the spec, got ${JSON.stringify(body.nextTools)}`
  );
  const pack = fs.readFileSync(path.join(ws, body.contextPack), 'utf8');
  assert.match(pack, /docs\/specs\/checkout\.md/);
});

test('implement gate fails when a discovered spec is missing from intent_sources', () => {
  const ws = planWorkspace('docs/specs/checkout.md');
  const { result, body } = gateJson(ws);
  assert.equal(result.status, 1, result.stderr + result.stdout);
  const check = (body.checks || []).find((c) => c.id === 'C-intent-sources');
  assert.ok(check, `missing C-intent-sources in ${JSON.stringify(body.checks)}`);
  assert.equal(check.pass, false);
  assert.match(check.message, /docs\/specs\/checkout\.md/);
});

test('implement gate passes when intent_sources lists every discovered spec', () => {
  const ws = planWorkspace('docs/specs/checkout.md');
  const { result, body } = gateJson(ws, {
    planOpts: { extraFrontmatter: 'intent_sources:\n  - docs/specs/checkout.md\n' },
  });
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const check = (body.checks || []).find((c) => c.id === 'C-intent-sources');
  assert.ok(check);
  assert.equal(check.pass, true);
});

test('plan-new records discovered intent sources on the scaffold', () => {
  const ws = planWorkspace('docs/specs/checkout.md');
  const result = runHarness(
    [
      'plan-new',
      '--type',
      'feat',
      '--slug',
      'checkout-retry',
      '--intent',
      'Honor the checkout spec',
      '--date',
      '2026-10-05',
      '--verification-check',
      'unit-tests',
      '--workspace',
      ws,
      '--json',
    ],
    { env: GIT_ENV }
  );
  assert.equal(result.status, 0, result.stderr);
  const created = JSON.parse(result.stdout);
  const text = fs.readFileSync(created.path, 'utf8');
  assert.match(text, /intent_sources:/);
  assert.match(text, /docs\/specs\/checkout\.md/);
});

test('plan-update --intent-source appends a path', () => {
  const ws = planWorkspace();
  const plan = writeVersionedPlan(ws);
  const result = runHarness(
    ['plan-update', '--plan', plan, '--intent-source', 'docs/specs/checkout.md', '--workspace', ws, '--json'],
    { env: GIT_ENV }
  );
  assert.equal(result.status, 0, result.stderr);
  const text = fs.readFileSync(path.join(ws, plan), 'utf8');
  assert.match(text, /intent_sources:/);
  assert.match(text, /docs\/specs\/checkout\.md/);
});

test('implement gate fails on the default branch of the primary checkout', () => {
  const ws = planWorkspace();
  const branch = withOrigin(ws);
  const { result, body } = gateJson(ws, {
    planOpts: { extraFrontmatter: 'intent_sources: []\n' },
  });
  assert.equal(result.status, 1, `branch=${branch} ${result.stderr} ${result.stdout}`);
  const check = (body.checks || []).find((c) => c.id === 'C-worktree');
  assert.ok(check, `missing C-worktree in ${JSON.stringify(body.checks)}`);
  assert.equal(check.pass, false);
  assert.match(check.message, /harness worktree/);
});

test('implement gate skips C-worktree when CI=true or --allow-inplace', () => {
  const ws = planWorkspace();
  withOrigin(ws);
  const ci = gateJson(ws, { planOpts: { extraFrontmatter: 'intent_sources: []\n' } }, { CI: 'true' });
  assert.equal(ci.result.status, 0, ci.result.stderr);
  assert.equal((ci.body.checks || []).find((c) => c.id === 'C-worktree')?.pass, true);

  const ws2 = planWorkspace();
  withOrigin(ws2);
  const inplace = gateJson(ws2, {
    planOpts: { extraFrontmatter: 'intent_sources: []\n' },
    args: ['--allow-inplace'],
  });
  assert.equal(inplace.result.status, 0, inplace.result.stderr);
  assert.equal((inplace.body.checks || []).find((c) => c.id === 'C-worktree')?.pass, true);
});

test('harness worktree --slug creates a linked worktree on harness/<slug> and gate accepts it', () => {
  const ws = planWorkspace();
  withOrigin(ws);
  const created = runHarness(['worktree', '--slug', 'checkout-retry', '--workspace', ws, '--json'], { env: GIT_ENV });
  assert.equal(created.status, 0, created.stderr);
  const body = JSON.parse(created.stdout);
  assert.equal(body.branch, 'harness/checkout-retry');
  assert.equal(body.created, true);
  assert.equal(body.isolated, true);
  assert.ok(body.path && fs.existsSync(body.path), 'worktree path exists');
  assert.equal(fs.lstatSync(path.join(body.path, '.git')).isFile(), true, 'linked worktree uses a .git file');
  assert.match(fs.readFileSync(path.join(ws, '.gitignore'), 'utf8'), /^\.worktrees\/?$/m);

  for (const rel of ['docs', '.github']) {
    const src = path.join(ws, rel);
    if (fs.existsSync(src)) fs.cpSync(src, path.join(body.path, rel), { recursive: true });
  }
  const isolated = gateJson(body.path, { planOpts: { extraFrontmatter: 'intent_sources: []\n' } });
  assert.equal(isolated.result.status, 0, isolated.result.stderr + isolated.result.stdout);
  assert.equal((isolated.body.checks || []).find((c) => c.id === 'C-worktree')?.pass, true);

  const again = runHarness(['worktree', '--slug', 'checkout-retry', '--workspace', ws, '--json'], { env: GIT_ENV });
  assert.equal(again.status, 0, again.stderr);
  assert.equal(JSON.parse(again.stdout).created, false);
});

test('orient --json reports a blocked primary checkout without leaking the absolute worktree path', () => {
  const ws = planWorkspace();
  withOrigin(ws);
  writeVersionedPlan(ws, { extraFrontmatter: 'intent_sources: []\n' });
  const result = runHarness(['orient', '--query', 'checkout', '--workspace', ws, '--json'], { env: GIT_ENV });
  assert.equal(result.status, 0, result.stderr);
  const body = JSON.parse(result.stdout);
  assert.equal(body.worktree?.blocked, true);
  assert.equal(body.gitContext?.worktree, undefined);
  assert.ok(
    (body.nextTools || []).some((t) => t.startsWith('harness worktree --slug ')),
    `nextTools should start worktree add, got ${JSON.stringify(body.nextTools)}`
  );
});

test('worktree --slug rejects a bad slug', () => {
  const ws = planWorkspace();
  const result = runHarness(['worktree', '--slug', 'Not A Slug', '--workspace', ws, '--json'], { env: GIT_ENV });
  assert.equal(result.status, 2);
});
