import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import YAML from 'yaml';
import { cliHarnessHome, runHarness, tempDir } from './helpers/index.mjs';
import { initGit, writeChecks, writeVersionedPlan } from './helpers/cli-fixtures.mjs';
import { TEST_GIT_ENV } from './helpers/store.mjs';

const SPEC_BODY = '# Checkout retry\n\nRefunds share the payment retry budget.\n';
const SPEC_SHA = crypto.createHash('sha256').update(SPEC_BODY).digest('hex');

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
  if (specRel) addTracked(ws, specRel, SPEC_BODY);
  return ws;
}

function parseFrontmatter(text) {
  const match = String(text).match(/^---\r?\n([\s\S]*?)\r?\n---/);
  assert.ok(match, 'plan has frontmatter');
  return YAML.parse(match[1]);
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
  const fm = parseFrontmatter(text);
  assert.equal(fm.intent_sources[0].path, 'docs/specs/checkout.md');
  assert.equal(fm.intent_sources[0].sha256, SPEC_SHA);
});

test('implement gate still passes after a locked spec file changes', () => {
  const ws = planWorkspace('docs/specs/checkout.md');
  const created = runHarness(
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
  assert.equal(created.status, 0, created.stderr);
  const plan = JSON.parse(created.stdout).path;
  fs.writeFileSync(path.join(ws, 'docs/specs/checkout.md'), '# Drifted after lock\n');
  const gated = runHarness(['gate', '--phase', 'implement', '--plan', plan, '--workspace', ws, '--json'], {
    env: GIT_ENV,
  });
  assert.equal(gated.status, 0, gated.stderr + gated.stdout);
  const check = JSON.parse(gated.stdout).checks.find((c) => c.id === 'C-intent-sources');
  assert.equal(check.pass, true);
  assert.doesNotMatch(check.message || '', /drift|hash mismatch|needs-info/i);
});

test('plan-update --lock stamps sha256 onto string intent_sources', () => {
  const ws = planWorkspace('docs/specs/checkout.md');
  const plan = writeVersionedPlan(ws, { extraFrontmatter: 'intent_sources:\n  - docs/specs/checkout.md\n' });
  const result = runHarness(['plan-update', '--plan', plan, '--lock', '--workspace', ws, '--json'], { env: GIT_ENV });
  assert.equal(result.status, 0, result.stderr);
  const fm = parseFrontmatter(fs.readFileSync(path.join(ws, plan), 'utf8'));
  assert.equal(fm.intent_sources[0].path, 'docs/specs/checkout.md');
  assert.equal(fm.intent_sources[0].sha256, SPEC_SHA);
});

test('plan-update --activity does not rehash locked intent sources after the spec file changes', () => {
  const ws = planWorkspace('docs/specs/checkout.md');
  const created = runHarness(
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
  assert.equal(created.status, 0, created.stderr);
  const plan = JSON.parse(created.stdout).path;
  fs.writeFileSync(path.join(ws, 'docs/specs/checkout.md'), '# Drifted after lock\n');
  const result = runHarness(
    ['plan-update', '--plan', plan, '--activity', 'continue after spec edit', '--workspace', ws, '--json'],
    { env: GIT_ENV }
  );
  assert.equal(result.status, 0, result.stderr);
  const fm = parseFrontmatter(fs.readFileSync(plan, 'utf8'));
  assert.equal(fm.intent_sources[0].sha256, SPEC_SHA);
});

test('plan-update --intent-source appends a readable path and its hash', () => {
  const ws = planWorkspace();
  addTracked(ws, 'docs/specs/checkout.md', SPEC_BODY);
  const plan = writeVersionedPlan(ws);
  const result = runHarness(
    ['plan-update', '--plan', plan, '--intent-source', 'docs/specs/checkout.md', '--workspace', ws, '--json'],
    { env: GIT_ENV }
  );
  assert.equal(result.status, 0, result.stderr);
  const fm = parseFrontmatter(fs.readFileSync(path.join(ws, plan), 'utf8'));
  assert.equal(fm.intent_sources[0].path, 'docs/specs/checkout.md');
  assert.equal(fm.intent_sources[0].sha256, SPEC_SHA);
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

test('knowledge defaultBranch does not fail C-worktree without origin/HEAD', async () => {
  const { resolveDefaultBranch } = await import('../lib/git-context.mjs');
  const { storeDir } = await import('../lib/knowledge/store.mjs');
  const ws = planWorkspace();
  const branch = currentBranch(ws);
  const home = cliHarnessHome();
  const dir = storeDir(ws, { home });
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'config.json'), `${JSON.stringify({ mode: 'on', commit: 'none', defaultBranch: branch })}\n`);
  const seen = resolveDefaultBranch(ws, { home });
  assert.equal(seen?.name, branch);
  assert.equal(seen?.source, 'config');
  const { result, body } = gateJson(ws, { planOpts: { extraFrontmatter: 'intent_sources: []\n' } });
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.equal((body.checks || []).find((c) => c.id === 'C-worktree')?.pass, true);
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

function addWorktree(ws, slug) {
  const created = runHarness(['worktree', '--slug', slug, '--workspace', ws, '--json'], { env: GIT_ENV });
  assert.equal(created.status, 0, created.stderr);
  const body = JSON.parse(created.stdout);
  const github = path.join(ws, '.github');
  if (fs.existsSync(github)) fs.cpSync(github, path.join(body.path, '.github'), { recursive: true });
  return body;
}

test('worktree appends .worktrees to a regular .gitignore and does not follow a symlink', () => {
  const ws = planWorkspace();
  withOrigin(ws);
  fs.writeFileSync(path.join(ws, '.gitignore'), 'node_modules');
  const created = addWorktree(ws, 'ignore-regular');
  assert.equal(fs.readFileSync(path.join(ws, '.gitignore'), 'utf8'), 'node_modules\n.worktrees\n');
  git(ws, ['worktree', 'remove', '--force', created.path]);

  const outsideDir = tempDir('outside-ignore-');
  const outside = path.join(outsideDir, 'secret-ignore');
  fs.writeFileSync(outside, 'keep\n');
  const linked = planWorkspace();
  withOrigin(linked);
  fs.symlinkSync(outside, path.join(linked, '.gitignore'));
  const escaped = addWorktree(linked, 'ignore-symlink');
  assert.equal(fs.readFileSync(outside, 'utf8'), 'keep\n');
  assert.equal(fs.lstatSync(path.join(linked, '.gitignore')).isSymbolicLink(), true);
  git(linked, ['worktree', 'remove', '--force', escaped.path]);
});

test('an uncommitted docs/plans file stays addressable from the new worktree', () => {
  const ws = planWorkspace();
  withOrigin(ws);
  const rel = writeVersionedPlan(ws, { extraFrontmatter: 'intent_sources: []\n' });
  const tree = addWorktree(ws, 'carry-docs');
  assert.equal(fs.existsSync(path.join(tree.path, rel)), false);
  const isolated = runHarness(['gate', '--phase', 'implement', '--plan', rel, '--workspace', tree.path, '--json'], { env: GIT_ENV });
  const body = JSON.parse(isolated.stdout);
  assert.ok(body.plan, isolated.stderr + isolated.stdout);
  assert.equal(path.basename(body.plan.path), path.basename(rel));
  assert.equal((body.checks || []).find((c) => c.id === 'C-worktree')?.pass, true);
  assert.equal(isolated.status, 0, isolated.stderr + isolated.stdout);
  git(ws, ['worktree', 'remove', '--force', tree.path]);
});

test('a gitignored .harness/plans file stays addressable from the new worktree', () => {
  const ws = planWorkspace();
  withOrigin(ws);
  fs.mkdirSync(path.join(ws, '.harness', 'plans'), { recursive: true });
  fs.writeFileSync(path.join(ws, '.gitignore'), '.harness/\n');
  const docsRel = writeVersionedPlan(ws, {
    name: '2026-10-05-feat-session-plan.md',
    extraFrontmatter: 'intent_sources: []\n',
  });
  const rel = '.harness/plans/2026-10-05-feat-session-plan.md';
  fs.renameSync(path.join(ws, docsRel), path.join(ws, rel));
  const tree = addWorktree(ws, 'carry-session');
  assert.equal(fs.existsSync(path.join(tree.path, rel)), false);
  const isolated = runHarness(['gate', '--phase', 'implement', '--plan', rel, '--workspace', tree.path, '--json'], { env: GIT_ENV });
  const body = JSON.parse(isolated.stdout);
  assert.ok(body.plan, isolated.stderr + isolated.stdout);
  assert.equal(path.basename(body.plan.path), '2026-10-05-feat-session-plan.md');
  assert.equal(isolated.status, 0, isolated.stderr + isolated.stdout);
  git(ws, ['worktree', 'remove', '--force', tree.path]);
});

test('plan-new without an origin remote stays visible from the linked worktree', () => {
  const ws = planWorkspace();
  const createdPlan = runHarness(
    ['plan-new', '--type', 'feat', '--slug', 'store-plan', '--intent', 'Keep the plan in the project store', '--date', '2026-10-05', '--verification-check', 'unit-tests', '--workspace', ws, '--json'],
    { env: GIT_ENV },
  );
  assert.equal(createdPlan.status, 0, createdPlan.stderr + createdPlan.stdout);
  const planPath = JSON.parse(createdPlan.stdout).path;
  const tree = addWorktree(ws, 'store-plan');
  const isolated = runHarness(['gate', '--phase', 'implement', '--plan', planPath, '--workspace', tree.path, '--json'], { env: GIT_ENV });
  const body = JSON.parse(isolated.stdout);
  assert.ok(body.plan, isolated.stderr + isolated.stdout);
  assert.equal(path.basename(body.plan.path), path.basename(planPath));
  git(ws, ['worktree', 'remove', '--force', tree.path]);
});

test('orient, plan-new, and gate cap intent sources with the same query ranking', async () => {
  const { discoverIntentSources } = await import('../lib/intent-sources.mjs');
  const ws = planWorkspace();
  for (let i = 1; i <= 12; i += 1) {
    addTracked(ws, `docs/specs/n${String(i).padStart(2, '0')}.md`, `# n${i}\n`);
  }
  addTracked(ws, 'docs/specs/zebra-billing.md', '# Zebra billing\n');
  const query = 'zebra billing';
  const ranked = discoverIntentSources(ws, { query }).map((s) => s.path).sort();
  const alpha = discoverIntentSources(ws).map((s) => s.path).sort();
  assert.ok(ranked.includes('docs/specs/zebra-billing.md'));
  assert.equal(alpha.includes('docs/specs/zebra-billing.md'), false);

  const orient = runHarness(['orient', '--query', query, '--workspace', ws, '--json'], { env: GIT_ENV });
  assert.equal(orient.status, 0, orient.stderr);
  const orientPaths = JSON.parse(orient.stdout).intentSources.map((s) => s.path).sort();
  assert.deepEqual(orientPaths, ranked);

  const created = runHarness(
    ['plan-new', '--type', 'feat', '--slug', 'zebra-billing', '--intent', query, '--date', '2026-10-05', '--verification-check', 'unit-tests', '--workspace', ws, '--json'],
    { env: GIT_ENV },
  );
  assert.equal(created.status, 0, created.stderr + created.stdout);
  const planPath = JSON.parse(created.stdout).path;
  const locked = parseFrontmatter(fs.readFileSync(planPath, 'utf8')).intent_sources.map((s) => s.path).sort();
  assert.deepEqual(locked, ranked);

  const gate = runHarness(['gate', '--phase', 'implement', '--plan', planPath, '--workspace', ws, '--json'], { env: GIT_ENV });
  const check = JSON.parse(gate.stdout).checks.find((c) => c.id === 'C-intent-sources');
  assert.equal(check?.pass, true, check?.message || gate.stderr);
});

test('a spec ranks by words in the file body when the path does not contain them', async () => {
  const { discoverIntentSources } = await import('../lib/intent-sources.mjs');
  const ws = planWorkspace();
  for (let i = 1; i <= 12; i += 1) {
    addTracked(ws, `docs/specs/a${String(i).padStart(2, '0')}.md`, `# a${i}\n`);
  }
  const withWord = `# n\n\nRefund the buyer when the capture fails.\n${'x'.repeat(9000)}\n`;
  addTracked(ws, 'docs/specs/n13.md', withWord);
  addTracked(ws, 'docs/specs/late.md', `${'x'.repeat(8192)}refund buyer\n`);
  const ranked = discoverIntentSources(ws, { query: 'refund buyer' }).map((s) => s.path);
  assert.equal(ranked[0], 'docs/specs/n13.md');
  assert.equal(ranked.includes('docs/specs/late.md'), false);
});

test('a SpecKit constitution is an intent source and other .specify files are not', async () => {
  const { discoverIntentSources } = await import('../lib/intent-sources.mjs');
  const ws = planWorkspace();
  addTracked(ws, '.specify/memory/constitution.md', '# Constitution\n\nBusiness owners require an audit trail.\n');
  addTracked(ws, '.specify/scripts/setup.sh', 'echo not a spec\n');
  const paths = discoverIntentSources(ws, { query: 'audit trail' }).map((s) => s.path);
  assert.deepEqual(paths, ['.specify/memory/constitution.md']);
});

test('spec ranking does not read a symlink body', async () => {
  const { discoverIntentSources } = await import('../lib/intent-sources.mjs');
  const ws = planWorkspace();
  const outside = path.join(tempDir('secret-rank-'), 'local.md');
  fs.writeFileSync(outside, 'Refund the buyer from outside the checkout.\n');
  fs.mkdirSync(path.join(ws, 'docs', 'specs'), { recursive: true });
  fs.symlinkSync(outside, path.join(ws, 'docs', 'specs', 'link.md'));
  assert.equal(git(ws, ['add', '--', 'docs/specs/link.md']).status, 0);
  assert.equal(git(ws, ['commit', '-qm', 'link spec']).status, 0);
  addTracked(ws, 'docs/specs/aaa.md', '# empty\n');
  addTracked(ws, 'docs/specs/real.md', '# Real\n\nRefund the buyer inside the checkout.\n');
  const ranked = discoverIntentSources(ws, { query: 'refund buyer' }).map((s) => s.path);
  assert.equal(ranked[0], 'docs/specs/real.md');
});

test('plan-new does not hash a spec symlink that leaves the checkout', async () => {
  const { hashIntentFile } = await import('../lib/intent-sources.mjs');
  const ws = planWorkspace();
  const secret = 'secret token value\n';
  const secretHash = crypto.createHash('sha256').update(secret).digest('hex');
  const outside = path.join(tempDir('secret-spec-'), 'local.md');
  fs.writeFileSync(outside, secret);
  fs.mkdirSync(path.join(ws, 'docs', 'specs'), { recursive: true });
  fs.symlinkSync(outside, path.join(ws, 'docs', 'specs', 'local.md'));
  assert.equal(git(ws, ['add', '--', 'docs/specs/local.md']).status, 0);
  assert.equal(git(ws, ['commit', '-qm', 'link spec']).status, 0);
  assert.equal(hashIntentFile(ws, 'docs/specs/local.md'), null);
  const created = runHarness(
    ['plan-new', '--type', 'feat', '--slug', 'secret-spec', '--intent', 'Do not hash the symlink', '--date', '2026-10-05', '--verification-check', 'unit-tests', '--workspace', ws, '--json'],
    { env: GIT_ENV },
  );
  assert.notEqual(created.status, 0);
  assert.match(`${created.stderr}\n${created.stdout}`, /docs\/specs\/local\.md/);
  assert.equal(`${created.stderr}\n${created.stdout}`.includes(secretHash), false);
  assert.equal(`${created.stderr}\n${created.stdout}`.includes(secret.trim()), false);
});

test('a newer checkout plan replaces the carried store copy and a newer store copy stays', () => {
  const ws = planWorkspace();
  withOrigin(ws);
  const rel = writeVersionedPlan(ws, { extraFrontmatter: 'intent_sources: []\n' });
  const tree = addWorktree(ws, 'carry-refresh');
  const first = runHarness(['gate', '--phase', 'implement', '--plan', rel, '--workspace', tree.path, '--json'], { env: GIT_ENV });
  assert.equal(first.status, 0, first.stderr + first.stdout);
  const storePath = JSON.parse(first.stdout).plan.path;
  const checkoutFile = path.join(ws, rel);

  fs.appendFileSync(checkoutFile, '\nEdited after carry.\n');
  const checkoutNewer = new Date(Date.now() + 10_000);
  fs.utimesSync(checkoutFile, checkoutNewer, checkoutNewer);
  addWorktree(ws, 'carry-refresh');
  assert.match(fs.readFileSync(storePath, 'utf8'), /Edited after carry/);

  fs.appendFileSync(storePath, '\nStore moved on.\n');
  const storeNewer = new Date(Date.now() + 20_000);
  fs.utimesSync(storePath, storeNewer, storeNewer);
  addWorktree(ws, 'carry-refresh');
  const kept = fs.readFileSync(storePath, 'utf8');
  assert.match(kept, /Store moved on/);
  assert.equal(fs.readFileSync(checkoutFile, 'utf8').includes('Store moved on.'), false);
  git(ws, ['worktree', 'remove', '--force', tree.path]);
});

test('carry leaves a store plan alone while plan-update holds its lock', async () => {
  const { planUpdateLockDir } = await import('../lib/plan-update.mjs');
  const ws = planWorkspace();
  withOrigin(ws);
  const rel = writeVersionedPlan(ws, { extraFrontmatter: 'intent_sources: []\n' });
  const tree = addWorktree(ws, 'carry-lock');
  const first = runHarness(['gate', '--phase', 'implement', '--plan', rel, '--workspace', tree.path, '--json'], { env: GIT_ENV });
  assert.equal(first.status, 0, first.stderr + first.stdout);
  const storePath = JSON.parse(first.stdout).plan.path;
  const checkoutFile = path.join(ws, rel);
  fs.appendFileSync(checkoutFile, '\nEdited after carry.\n');
  const checkoutNewer = new Date(Date.now() + 10_000);
  fs.utimesSync(checkoutFile, checkoutNewer, checkoutNewer);
  fs.mkdirSync(planUpdateLockDir(storePath));
  const held = runHarness(['worktree', '--slug', 'carry-lock', '--workspace', ws, '--json'], { env: GIT_ENV });
  assert.equal(held.status, 0, held.stderr + held.stdout);
  assert.equal(fs.readFileSync(storePath, 'utf8').includes('Edited after carry.'), false);
  fs.rmdirSync(planUpdateLockDir(storePath));
  addWorktree(ws, 'carry-lock');
  assert.match(fs.readFileSync(storePath, 'utf8'), /Edited after carry/);
  git(ws, ['worktree', 'remove', '--force', tree.path]);
});

test('hashIntentFile hashes the raw file bytes', async () => {
  const { hashIntentFile } = await import('../lib/intent-sources.mjs');
  const ws = planWorkspace();
  const bytes = Buffer.from([0xff, 0xfe, 0x00, 0x61]);
  const rel = 'docs/specs/bytes.md';
  fs.mkdirSync(path.join(ws, 'docs', 'specs'), { recursive: true });
  fs.writeFileSync(path.join(ws, rel), bytes);
  const raw = crypto.createHash('sha256').update(bytes).digest('hex');
  const decoded = crypto.createHash('sha256').update(bytes.toString('utf8')).digest('hex');
  assert.notEqual(raw, decoded);
  assert.equal(hashIntentFile(ws, rel), raw);
});

test('separate git directories do not share a store and a linked worktree still does', async () => {
  const { localRepoId } = await import('../lib/knowledge/store.mjs');
  const { inspectIsolation } = await import('../lib/worktree.mjs');
  const parent = tempDir('split-git-');
  const gitParent = path.join(parent, 'git');
  fs.mkdirSync(gitParent);
  const make = (name) => {
    const dir = path.join(parent, name);
    fs.mkdirSync(dir);
    const init = git(dir, ['init', '-q', '--separate-git-dir', path.join(gitParent, `${name}.git`)]);
    assert.equal(init.status, 0, init.stderr);
    git(dir, ['config', 'user.email', 'harness@example.test']);
    git(dir, ['config', 'user.name', 'Harness Test']);
    fs.writeFileSync(path.join(dir, 'README.md'), `${name}\n`);
    assert.equal(git(dir, ['add', '.']).status, 0);
    assert.equal(git(dir, ['commit', '-qm', 'baseline']).status, 0);
    return dir;
  };
  const a = make('a');
  const b = make('b');
  assert.notEqual(localRepoId(a), localRepoId(b));
  withOrigin(a);
  const isolation = inspectIsolation({ workspace: a, env: GIT_ENV });
  assert.equal(isolation.linked, false);
  assert.equal(isolation.blocked, true);
  const created = addWorktree(a, 'inside');
  assert.equal(created.path, path.join(a, '.worktrees', 'inside'));
  assert.equal(fs.existsSync(path.join(parent, '.worktrees')), false);
  git(a, ['worktree', 'remove', '--force', created.path]);

  const normal = planWorkspace();
  const tree = addWorktree(normal, 'share-id');
  assert.equal(localRepoId(tree.path), localRepoId(normal));
  git(normal, ['worktree', 'remove', '--force', tree.path]);
});

test('plan-new fails when a discovered spec is missing on disk', () => {
  const ws = planWorkspace();
  addTracked(ws, 'docs/specs/gone.md', '# gone\n');
  fs.rmSync(path.join(ws, 'docs', 'specs', 'gone.md'));
  const created = runHarness(
    ['plan-new', '--type', 'feat', '--slug', 'gone-spec', '--intent', 'Require a readable spec', '--date', '2026-10-05', '--verification-check', 'unit-tests', '--workspace', ws, '--json'],
    { env: GIT_ENV },
  );
  assert.notEqual(created.status, 0);
  assert.match(`${created.stderr}\n${created.stdout}`, /intent source unreadable: docs\/specs\/gone\.md/);
});
