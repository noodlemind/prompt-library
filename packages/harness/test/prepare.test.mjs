import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import YAML from 'yaml';
import { binPath, runHarness, tempDir } from './helpers/index.mjs';
import { initGit, writeChecks } from './helpers/cli-fixtures.mjs';
import { TEST_GIT_ENV } from './helpers/store.mjs';
import { buildContextPack } from '../lib/context-pack.mjs';

const GIT_ENV = { ...process.env, ...TEST_GIT_ENV, CI: '', HARNESS_ALLOW_INPLACE: '' };
const SPEC_REL = 'docs/specs/overview.md';
const ADR_REL = 'docs/adr/0000-architecture.md';

function parseJson(result, label) {
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new Error(`${label} stdout was not JSON: ${result.stdout}\n${result.stderr}`);
  }
}

function prepareWorkspace() {
  const ws = tempDir('prepare-');
  initGit(ws);
  return ws;
}

function git(cwd, args) {
  return spawnSync('git', args, { cwd, encoding: 'utf8', env: GIT_ENV });
}

function track(ws, rel, body) {
  const full = path.join(ws, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, body);
  assert.equal(git(ws, ['add', '--', rel]).status, 0, git(ws, ['add', '--', rel]).stderr);
  assert.equal(git(ws, ['commit', '-qm', `add ${rel}`]).status, 0);
}

function runPrepare(ws, extra = []) {
  const result = runHarness(['prepare', '--workspace', ws, '--json', ...extra], { env: GIT_ENV });
  assert.equal(result.status, 0, result.stderr + result.stdout);
  return parseJson(result, 'prepare');
}

test('prepare writes classified spec and adr templates', () => {
  const ws = prepareWorkspace();
  const result = runHarness(['prepare', '--workspace', ws, '--json'], { env: GIT_ENV });
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const body = parseJson(result, 'prepare');
  assert.equal(body.created, 2);
  assert.equal(body.skipped, 0);
  assert.deepEqual(
    body.files.map((f) => `${f.path}:${f.kind}:${f.status}`).sort(),
    [`${ADR_REL}:adr:created`, `${SPEC_REL}:spec:created`]
  );
  const spec = fs.readFileSync(path.join(ws, SPEC_REL), 'utf8');
  const adr = fs.readFileSync(path.join(ws, ADR_REL), 'utf8');
  assert.match(spec, /TODO/);
  assert.match(adr, /TODO/);
  assert.match(spec, /src/);
  assert.match(spec, /harness prepare/);
  assert.match(adr, /harness prepare/);
});

test('orient discovers prepared files as intentSources', () => {
  const ws = prepareWorkspace();
  assert.equal(runHarness(['prepare', '--workspace', ws, '--json'], { env: GIT_ENV }).status, 0);
  const result = runHarness(['orient', '--query', 'architecture', '--workspace', ws, '--json'], { env: GIT_ENV });
  assert.equal(result.status, 0, result.stderr);
  const body = parseJson(result, 'orient');
  const paths = (body.intentSources || []).map((s) => s.path).sort();
  assert.deepEqual(paths, [ADR_REL, SPEC_REL]);
  assert.equal(body.intentSources.find((s) => s.path === SPEC_REL).kind, 'spec');
  assert.equal(body.intentSources.find((s) => s.path === ADR_REL).kind, 'adr');
});

test('second prepare skips existing files and keeps human edits', () => {
  const ws = prepareWorkspace();
  assert.equal(runHarness(['prepare', '--workspace', ws, '--json'], { env: GIT_ENV }).status, 0);
  const edited = '# Edited overview\n\nPO owns this file now.\n';
  fs.writeFileSync(path.join(ws, SPEC_REL), edited);
  const result = runHarness(['prepare', '--workspace', ws, '--json'], { env: GIT_ENV });
  assert.equal(result.status, 0, result.stderr);
  const body = parseJson(result, 'prepare-skip');
  assert.equal(body.created, 0);
  assert.equal(body.skipped, 2);
  assert.equal(
    body.files.find((f) => f.path === SPEC_REL).status,
    'skipped'
  );
  assert.equal(fs.readFileSync(path.join(ws, SPEC_REL), 'utf8'), edited);
});

test('prepare --dry-run writes nothing', () => {
  const ws = prepareWorkspace();
  const result = runHarness(['prepare', '--workspace', ws, '--dry-run', '--json'], { env: GIT_ENV });
  assert.equal(result.status, 0, result.stderr);
  const body = parseJson(result, 'prepare-dry-run');
  assert.equal(body.created, 0);
  assert.ok(body.files.every((f) => f.status === 'would-create'));
  assert.equal(fs.existsSync(path.join(ws, SPEC_REL)), false);
  assert.equal(fs.existsSync(path.join(ws, ADR_REL)), false);
});

test('orient hints harness prepare when no intent sources exist', () => {
  const ws = prepareWorkspace();
  const result = runHarness(['orient', '--query', 'brownfield', '--workspace', ws, '--json'], { env: GIT_ENV });
  assert.equal(result.status, 0, result.stderr);
  const body = parseJson(result, 'orient-empty');
  assert.deepEqual(body.intentSources || [], []);
  assert.ok(
    (body.nextTools || []).some((t) => t === 'harness prepare'),
    `nextTools should name prepare, got ${JSON.stringify(body.nextTools)}`
  );
});

test('prepare refuses a symlinked ancestor and publishes nothing outside', () => {
  const ws = prepareWorkspace();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'prepare-outside-'));
  fs.rmSync(path.join(ws, 'docs'), { recursive: true, force: true });
  fs.symlinkSync(outside, path.join(ws, 'docs'));
  const result = runHarness(['prepare', '--workspace', ws, '--json'], { env: GIT_ENV });
  assert.equal(result.status, 0, result.stderr);
  const body = parseJson(result, 'prepare-symlink');
  assert.ok(body.files.every((f) => f.status === 'refused'));
  assert.equal(body.created, 0);
  assert.ok(!fs.existsSync(path.join(outside, 'specs', 'overview.md')));
  assert.ok(!fs.existsSync(path.join(outside, 'adr', '0000-architecture.md')));
});

test('harness help lists prepare after init-repo', () => {
  const result = spawnSync(process.execPath, [binPath, 'help'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /\bprepare\b/);
  assert.match(result.stdout, /init-repo · prepare · migrate/);
});

test('prepare creates only the missing starter and keeps a partial human file', () => {
  const ws = prepareWorkspace();
  fs.mkdirSync(path.join(ws, 'docs/specs'), { recursive: true });
  fs.writeFileSync(path.join(ws, SPEC_REL), 'keep\n');
  const body = runPrepare(ws);
  assert.equal(body.files.find((file) => file.path === SPEC_REL).status, 'skipped');
  assert.equal(body.files.find((file) => file.path === ADR_REL).status, 'created');
  assert.equal(fs.readFileSync(path.join(ws, SPEC_REL), 'utf8'), 'keep\n');
  assert.equal(fs.readFileSync(path.join(ws, SPEC_REL), 'utf8').includes('TODO'), false);
});

test('prepare keeps an empty file and a symlink, and recreates a deleted starter only', () => {
  const ws = prepareWorkspace();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'prepare-link-'));
  fs.writeFileSync(path.join(outside, 'secret.md'), 'SECRET\n');
  fs.mkdirSync(path.join(ws, 'docs/specs'), { recursive: true });
  fs.writeFileSync(path.join(ws, SPEC_REL), '');
  fs.mkdirSync(path.join(ws, 'docs/adr'), { recursive: true });
  fs.symlinkSync(path.join(outside, 'secret.md'), path.join(ws, ADR_REL));
  const first = runPrepare(ws);
  assert.equal(first.files.find((file) => file.path === SPEC_REL).status, 'skipped');
  assert.equal(first.files.find((file) => file.path === ADR_REL).status, 'skipped');
  assert.equal(fs.readFileSync(path.join(ws, SPEC_REL), 'utf8'), '');
  assert.equal(fs.readFileSync(path.join(outside, 'secret.md'), 'utf8'), 'SECRET\n');
  fs.unlinkSync(path.join(ws, SPEC_REL));
  const second = runPrepare(ws);
  assert.equal(second.files.find((file) => file.path === SPEC_REL).status, 'created');
  assert.equal(second.files.find((file) => file.path === ADR_REL).status, 'skipped');
  assert.equal(fs.readFileSync(path.join(outside, 'secret.md'), 'utf8'), 'SECRET\n');
});

test('prepare leaves a broken symlink and refuses a directory or a file blocking docs/', () => {
  const broken = prepareWorkspace();
  fs.mkdirSync(path.join(broken, 'docs/specs'), { recursive: true });
  fs.symlinkSync(path.join(broken, 'missing-target'), path.join(broken, SPEC_REL));
  const brokenBody = runPrepare(broken);
  assert.equal(brokenBody.files.find((file) => file.path === SPEC_REL).status, 'skipped');
  assert.equal(fs.lstatSync(path.join(broken, SPEC_REL)).isSymbolicLink(), true);

  const dir = prepareWorkspace();
  fs.mkdirSync(path.join(dir, 'docs/specs/overview.md'), { recursive: true });
  const dirBody = runPrepare(dir);
  assert.equal(dirBody.files.find((file) => file.path === SPEC_REL).status, 'refused');
  assert.equal(dirBody.files.find((file) => file.path === ADR_REL).status, 'created');
  assert.equal(fs.lstatSync(path.join(dir, SPEC_REL)).isDirectory(), true);

  const blocked = prepareWorkspace();
  fs.writeFileSync(path.join(blocked, 'docs'), 'not-a-directory\n');
  const blockedBody = runPrepare(blocked);
  assert.ok(blockedBody.files.every((file) => file.status === 'refused'));
  assert.equal(fs.readFileSync(path.join(blocked, 'docs'), 'utf8'), 'not-a-directory\n');
});

test('prepare --dry-run reports skip, refuse, and would-create without writing', () => {
  const ws = prepareWorkspace();
  fs.mkdirSync(path.join(ws, 'docs/specs'), { recursive: true });
  fs.writeFileSync(path.join(ws, SPEC_REL), 'keep\n');
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'prepare-dry-'));
  fs.symlinkSync(outside, path.join(ws, 'docs/adr'));
  const body = runPrepare(ws, ['--dry-run']);
  assert.equal(body.files.find((file) => file.path === SPEC_REL).status, 'skipped');
  assert.equal(body.files.find((file) => file.path === ADR_REL).status, 'refused');
  assert.equal(fs.readFileSync(path.join(ws, SPEC_REL), 'utf8'), 'keep\n');
  assert.equal(fs.existsSync(path.join(outside, '0000-architecture.md')), false);
});

test('prepare does not write gitignored starters and orient says to un-ignore them', () => {
  const ws = prepareWorkspace();
  track(ws, '.gitignore', 'docs/\n');
  const body = runPrepare(ws);
  assert.equal(body.git, true);
  assert.ok(body.files.every((file) => file.status === 'ignored' && file.ignored === true));
  assert.equal(fs.existsSync(path.join(ws, SPEC_REL)), false);
  const oriented = runHarness(['orient', '--query', 'architecture', '--workspace', ws, '--json'], { env: GIT_ENV });
  assert.equal(oriented.status, 0, oriented.stderr);
  const orientBody = parseJson(oriented, 'orient-ignored');
  assert.deepEqual(orientBody.intentSources, []);
  assert.ok(
    (orientBody.nextTools || []).includes('un-ignore docs/specs and docs/adr, then harness prepare'),
    JSON.stringify(orientBody.nextTools)
  );
  fs.writeFileSync(path.join(ws, '.gitignore'), '');
  assert.equal(git(ws, ['add', '--', '.gitignore']).status, 0);
  assert.equal(git(ws, ['commit', '-qm', 'stop ignoring docs']).status, 0);
  const created = runPrepare(ws);
  assert.equal(created.created, 2);
  const seen = runHarness(['orient', '--query', 'architecture', '--workspace', ws, '--json'], { env: GIT_ENV });
  const seenBody = parseJson(seen, 'orient-after-unignore');
  assert.deepEqual((seenBody.intentSources || []).map((source) => source.path).sort(), [ADR_REL, SPEC_REL]);
});

test('prepare outside git writes files, hides dotfiles, and orient cannot discover them', () => {
  const ws = tempDir('prepare-nogit-');
  fs.mkdirSync(path.join(ws, 'src'), { recursive: true });
  fs.writeFileSync(path.join(ws, 'src/app.js'), 'export {}\n');
  fs.writeFileSync(path.join(ws, '.env'), 'SECRET=1\n');
  const body = runPrepare(ws);
  assert.equal(body.git, false);
  assert.equal(body.created, 2);
  const spec = fs.readFileSync(path.join(ws, SPEC_REL), 'utf8');
  assert.match(spec, /src/);
  assert.doesNotMatch(spec, /\.env/);
  const oriented = runHarness(['orient', '--query', 'architecture', '--workspace', ws, '--json'], { env: GIT_ENV });
  assert.equal(oriented.status, 0, oriented.stderr);
  const orientBody = parseJson(oriented, 'orient-nogit');
  assert.deepEqual(orientBody.intentSources || [], []);
  assert.ok((orientBody.nextTools || []).includes('harness prepare'));
});

test('prepare snapshots tracked dot paths, fences backticks, and caps the layout', () => {
  const ws = prepareWorkspace();
  track(ws, '.github/workflows/ci.yml', 'name: ci\n');
  track(ws, 'tick`name/f.txt', 'x\n');
  runPrepare(ws);
  const written = fs.readFileSync(path.join(ws, SPEC_REL), 'utf8');
  assert.match(written, /\.github/);
  assert.match(written, /tick'name/);
  assert.doesNotMatch(written, /tick`name/);

  const capped = prepareWorkspace();
  for (let i = 0; i < 30; i += 1) {
    const rel = `n${String(i).padStart(2, '0')}/f.txt`;
    const full = path.join(capped, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, 'x\n');
  }
  assert.equal(git(capped, ['add', '--all']).status, 0);
  assert.equal(git(capped, ['commit', '-qm', 'many tops']).status, 0);
  runPrepare(capped);
  const layout = fs.readFileSync(path.join(capped, SPEC_REL), 'utf8');
  assert.match(layout, /- `n00`/);
  assert.match(layout, /- `n23`/);
  assert.doesNotMatch(layout, /- `n24`/);
  assert.doesNotMatch(layout, /- `src`/);
  assert.doesNotMatch(layout, /- `\.harness`/);
});

test('a second prepare does not refresh the observed layout into an existing spec', () => {
  const ws = prepareWorkspace();
  runPrepare(ws);
  const before = fs.readFileSync(path.join(ws, SPEC_REL), 'utf8');
  track(ws, 'extra/a.txt', 'x\n');
  runPrepare(ws);
  assert.equal(fs.readFileSync(path.join(ws, SPEC_REL), 'utf8'), before);
  assert.doesNotMatch(before, /extra/);
});

test('orient does not hint prepare when a spec is already discoverable', () => {
  const ws = prepareWorkspace();
  track(ws, 'docs/specs/checkout.md', '# Checkout\n');
  const result = runHarness(['orient', '--query', 'checkout', '--workspace', ws, '--json'], { env: GIT_ENV });
  assert.equal(result.status, 0, result.stderr);
  const body = parseJson(result, 'orient-has-spec');
  assert.equal(body.intentSources[0].path, 'docs/specs/checkout.md');
  assert.equal(
    (body.nextTools || []).some((tool) => tool === 'harness prepare' || tool.startsWith('un-ignore ')),
    false,
    JSON.stringify(body.nextTools)
  );
});

test('context pack mentions prepare only when intentSources is an empty array', () => {
  const base = { query: 'x', learnings: [], recall: [], plans: [] };
  assert.doesNotMatch(buildContextPack(base), /None yet/);
  assert.match(buildContextPack({ ...base, intentSources: [] }), /harness prepare/);
  const named = buildContextPack({
    ...base,
    intentSources: [{ path: SPEC_REL, kind: 'spec' }],
  });
  assert.match(named, /docs\/specs\/overview\.md/);
  assert.doesNotMatch(named, /None yet/);
});

test('plan-new hashes the prepared spec and ADR', () => {
  const ws = prepareWorkspace();
  writeChecks(ws, { 'unit-tests': { command: [process.execPath, '-e', 'process.exit(0)'] } });
  runPrepare(ws);
  const created = runHarness(
    [
      'plan-new',
      '--type',
      'feat',
      '--slug',
      'brownfield',
      '--intent',
      'Honor the starter spec',
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
  assert.equal(created.status, 0, created.stderr + created.stdout);
  const planPath = parseJson(created, 'plan-new').path;
  const text = fs.readFileSync(planPath, 'utf8');
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  assert.ok(match, text);
  const frontmatter = YAML.parse(match[1]);
  for (const rel of [ADR_REL, SPEC_REL]) {
    const entry = frontmatter.intent_sources.find((source) => source.path === rel);
    const digest = crypto.createHash('sha256').update(fs.readFileSync(path.join(ws, rel))).digest('hex');
    assert.equal(entry.sha256, digest, rel);
  }
});

test('exclusive prepare publish does not replace a spec that already exists', async () => {
  const { writeFileContainedExclusive } = await import('../lib/fs-safe.mjs');
  const { prepareIntentSources } = await import('../lib/prepare.mjs');
  const ws = prepareWorkspace();
  const human = '# human spec\n';
  fs.mkdirSync(path.join(ws, 'docs', 'specs'), { recursive: true });
  const published = writeFileContainedExclusive(ws, SPEC_REL, 'template\n');
  assert.equal(typeof published, 'string');
  fs.writeFileSync(published, human);
  assert.equal(writeFileContainedExclusive(ws, SPEC_REL, 'template\n'), null);
  assert.equal(fs.readFileSync(published, 'utf8'), human);
  const result = prepareIntentSources({ workspace: ws });
  assert.equal(result.files.find((file) => file.path === SPEC_REL).status, 'skipped');
  assert.equal(fs.readFileSync(path.join(ws, SPEC_REL), 'utf8'), human);
});

test('init-repo points at prepare when the repo has no intent sources', () => {
  const ws = prepareWorkspace();
  const result = runHarness(['init-repo', '--workspace', ws], { env: GIT_ENV });
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.match(result.stdout, /harness prepare/);
});
