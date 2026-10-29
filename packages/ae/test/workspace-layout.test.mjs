import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import YAML from 'yaml';
import { readDomain } from '../lib/domain-contract.mjs';
import { readOrientSlice } from '../lib/orient-read.mjs';
import { runOrient } from '../lib/orient.mjs';
import { estimateTokens } from '../lib/token-meter.mjs';
import {
  classifyRepo,
  detectWorkspace,
  gradleIncludeCount,
  mavenModuleCount,
  parseJsonc,
  resolveWorkspacePath,
} from '../lib/workspace-layout.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(packageRoot, '..', '..');

function git(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  return result.stdout.trim();
}

function tempRoot(t) {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'layout-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function initRepo(dir, origin) {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, ['init', '-q']);
  if (origin) git(dir, ['remote', 'add', 'origin', origin]);
  return fs.realpathSync.native(dir);
}

test('monorepo markers are file presence, package workspaces, repeated gradle includes, and maven modules', (t) => {
  const root = tempRoot(t);
  assert.equal(classifyRepo(root).kind, 'product-repo');
  assert.deepEqual(classifyRepo(root).markers, []);

  fs.writeFileSync(path.join(root, 'package.json'), '{ "workspaces": [] }\n');
  assert.equal(classifyRepo(root).kind, 'product-repo');
  fs.writeFileSync(path.join(root, 'package.json'), '{ "workspaces": ["packages/*"] }\n');
  assert.deepEqual(classifyRepo(root).markers, ['package.json']);
  fs.writeFileSync(path.join(root, 'package.json'), '{ "workspaces": { "packages": ["packages/*"] } }\n');
  assert.ok(classifyRepo(root).markers.includes('package.json'));
  fs.writeFileSync(path.join(root, 'package.json'), '{');
  assert.equal(classifyRepo(root).kind, 'product-repo');

  for (const name of ['pnpm-workspace.yaml', 'lerna.json', 'nx.json', 'turbo.json', 'MODULE.bazel', 'WORKSPACE', 'WORKSPACE.bazel']) {
    const dir = path.join(root, name.replace(/[^a-z.]/gi, '-'));
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, name), '');
    assert.deepEqual(classifyRepo(dir).markers, [name], name);
    assert.equal(classifyRepo(dir).kind, 'monorepo');
  }

  const gradle = path.join(root, 'gradle-app');
  fs.mkdirSync(gradle);
  fs.writeFileSync(path.join(gradle, 'settings.gradle'), "include ':app'\nincludeBuild '../shared'\n");
  assert.equal(gradleIncludeCount(fs.readFileSync(path.join(gradle, 'settings.gradle'), 'utf8')), 1);
  assert.equal(classifyRepo(gradle).kind, 'product-repo');
  fs.writeFileSync(path.join(gradle, 'settings.gradle'), "// include ':hidden'\ninclude ':app', ':core'\n");
  assert.equal(classifyRepo(gradle).markers.includes('settings.gradle'), true);
  const kts = path.join(root, 'gradle-kts');
  fs.mkdirSync(kts);
  fs.writeFileSync(path.join(kts, 'settings.gradle.kts'), 'include(":app")\ninclude(":core")\n');
  assert.equal(classifyRepo(kts).kind, 'monorepo');

  const maven = path.join(root, 'maven-app');
  fs.mkdirSync(maven);
  fs.writeFileSync(path.join(maven, 'pom.xml'), '<project><!-- <modules><module>x</module></modules> --></project>\n');
  assert.equal(mavenModuleCount(fs.readFileSync(path.join(maven, 'pom.xml'), 'utf8')), 0);
  assert.equal(classifyRepo(maven).kind, 'product-repo');
  fs.writeFileSync(path.join(maven, 'pom.xml'), '<project><modules><module>child</module></modules></project>\n');
  assert.deepEqual(classifyRepo(maven).markers, ['pom.xml']);

  const linked = path.join(root, 'linked');
  fs.mkdirSync(linked);
  fs.writeFileSync(path.join(root, 'real-marker.yaml'), '');
  fs.symlinkSync(path.join(root, 'real-marker.yaml'), path.join(linked, 'pnpm-workspace.yaml'));
  assert.equal(classifyRepo(linked).kind, 'product-repo');
});

test('parseJsonc keeps strings and drops comments and trailing commas', () => {
  const parsed = parseJsonc(`{
    // saved window
    "folders": [
      { "path": "keep // inside", },
      { "path": "../other" /* second */ },
    ],
  }`);
  assert.equal(parsed.folders[0].path, 'keep // inside');
  assert.equal(parsed.folders[1].path, '../other');
  assert.equal(parseJsonc('{ "folders": [ }'), null);
});

test('resolveWorkspacePath expands USERPROFILE, backslashes, and drive letters', () => {
  const previous = process.env.USERPROFILE;
  const profile = path.join(os.tmpdir(), 'Profile Name');
  process.env.USERPROFILE = profile;
  try {
    assert.equal(resolveWorkspacePath('/work/app.code-workspace', '%USERPROFILE%/child'), path.resolve(profile, 'child'));
    assert.equal(resolveWorkspacePath('C:\\work\\app.code-workspace', '..\\lib'), 'C:\\lib');
    assert.equal(resolveWorkspacePath('C:\\work\\app.code-workspace', 'D:\\repos\\lib'), 'D:\\repos\\lib');
    process.env.USERPROFILE = 'C:\\Users\\krish';
    assert.equal(resolveWorkspacePath('C:\\work\\app.code-workspace', '%USERPROFILE%\\src'), 'C:\\Users\\krish\\src');
  } finally {
    if (previous === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previous;
  }
});

test('a code-workspace with JSONC lists the other git root and prefers vscode', (t) => {
  const parent = tempRoot(t);
  const home = path.join(parent, 'harness-home');
  const alpha = initRepo(path.join(parent, 'repo-a'), 'https://example.invalid/team/alpha.git');
  const beta = initRepo(path.join(parent, 'repo-b'));
  fs.writeFileSync(path.join(alpha, 'pnpm-workspace.yaml'), 'packages:\n  - packages/*\n');
  fs.writeFileSync(path.join(beta, '.harness-secret'), 'SECRET_PLAN_TOKEN\n');
  fs.mkdirSync(path.join(parent, '.idea'), { recursive: true });
  fs.writeFileSync(path.join(parent, '.idea', 'vcs.xml'), `<project><component name="VcsDirectoryMappings">
    <mapping directory="$PROJECT_DIR$/repo-a" vcs="Git" />
    <mapping directory="$PROJECT_DIR$/repo-b" vcs="Git" />
  </component></project>`);
  fs.writeFileSync(path.join(parent, 'dev.code-workspace'), `{
    // multi-root
    "folders": [
      { "path": "./repo-a", },
      { "path": "./repo-b", },
      { "path": "D:\\\\absent\\\\lib" },
    ],
    "settings": { "note": "keep // inside", },
  }\n`);
  fs.mkdirSync(path.join(home, 'domains'), { recursive: true });
  fs.writeFileSync(path.join(home, 'domains', 'broken.yaml'), ':\n');

  const layout = detectWorkspace(alpha, { home });
  assert.equal(layout.boundRoot, alpha);
  assert.equal(layout.kind, 'monorepo');
  assert.deepEqual(layout.markers, ['pnpm-workspace.yaml']);
  assert.equal(layout.workspaceType, 'vscode');
  assert.equal(layout.workspaceFile, path.join(parent, 'dev.code-workspace'));
  assert.equal(layout.roots.length, 1);
  assert.equal(layout.roots[0].root, beta);
  assert.equal(layout.roots[0].kind, 'product-repo');
  assert.equal(fs.existsSync(layout.domainSuggestion.path), false);
  assert.equal(path.dirname(layout.domainSuggestion.path), path.join(home, 'domains'));
  assert.doesNotMatch(layout.domainSuggestion.yaml, /SECRET_PLAN_TOKEN/);
  assert.match(layout.domainSuggestion.yaml, /https:\/\/example\.invalid\/team\/alpha$/m);
  assert.match(layout.domainSuggestion.yaml, /local_identity:/);
  assert.match(layout.domainSuggestion.yaml, /approved: true/);

  fs.mkdirSync(path.dirname(layout.domainSuggestion.path), { recursive: true });
  fs.writeFileSync(layout.domainSuggestion.path, layout.domainSuggestion.yaml);
  const saved = readDomain(path.basename(layout.domainSuggestion.path, '.yaml'), { home });
  assert.equal(saved.config.domain_version, 2);
  assert.equal(saved.config.repos.length, 2);
  assert.equal(detectWorkspace(alpha, { home }).domainSuggestion, null);
});

test('vcs.xml expands PROJECT_DIR and reports intellij when no code-workspace matches', (t) => {
  const parent = tempRoot(t);
  const home = path.join(parent, 'home');
  fs.mkdirSync(home);
  const alpha = initRepo(path.join(parent, 'repo-a'), 'https://user:pass@example.invalid/team/alpha.git');
  const beta = initRepo(path.join(parent, 'repo-b'), 'https://example.invalid/team/beta.git');
  fs.writeFileSync(path.join(beta, 'nx.json'), '{}\n');
  fs.mkdirSync(path.join(parent, '.idea'));
  fs.writeFileSync(path.join(parent, '.idea', 'vcs.xml'), `<?xml version="1.0"?>
    <project version="4">
      <component name="VcsDirectoryMappings">
        <mapping directory="$PROJECT_DIR$\\repo-a" vcs="Git" />
        <mapping directory="$PROJECT_DIR$/repo-b" vcs="Git" />
        <mapping directory="D:\\repos\\missing" vcs="Git" />
      </component>
    </project>`);
  const layout = detectWorkspace(alpha, { home });
  assert.equal(layout.workspaceType, 'intellij');
  assert.equal(layout.workspaceFile, path.join(parent, '.idea', 'vcs.xml'));
  assert.equal(layout.roots.length, 1);
  assert.equal(layout.roots[0].root, beta);
  assert.deepEqual(layout.roots[0].markers, ['nx.json']);
  assert.equal(layout.roots[0].kind, 'monorepo');
  assert.doesNotMatch(layout.domainSuggestion.yaml, /user:pass/);
  assert.match(layout.domainSuggestion.yaml, /local_identity:/);
  assert.equal(fs.existsSync(path.join(home, 'domains')), false);
});

test('a one-folder saved workspace is vscode and does not suggest a domain', (t) => {
  const parent = tempRoot(t);
  const home = path.join(parent, 'home');
  const alpha = initRepo(path.join(parent, 'repo-a'));
  fs.writeFileSync(path.join(parent, 'solo.code-workspace'), JSON.stringify({ folders: [{ path: './repo-a' }] }));
  const layout = detectWorkspace(alpha, { home });
  assert.equal(layout.workspaceType, 'vscode');
  assert.equal(layout.boundRoot, alpha);
  assert.deepEqual(layout.roots, []);
  assert.equal(layout.domainSuggestion, null);
});

test('no saved workspace reports none and does not suggest a domain', (t) => {
  const parent = tempRoot(t);
  const home = path.join(parent, 'home');
  const alpha = initRepo(path.join(parent, 'repo-a'));
  const layout = detectWorkspace(alpha, { home });
  assert.equal(layout.workspaceType, 'none');
  assert.equal(layout.workspaceFile, null);
  assert.deepEqual(layout.roots, []);
  assert.equal(layout.domainSuggestion, null);
  assert.equal(layout.kind, 'product-repo');
  assert.equal(detectWorkspace(path.join(parent, 'missing'), { home }).kind, 'unknown');
});

test('orient json reports layout and does not write the domain file', (t) => {
  const parent = tempRoot(t);
  const home = path.join(parent, 'home');
  const copilot = path.join(parent, 'copilot');
  fs.mkdirSync(home);
  fs.mkdirSync(copilot);
  const alpha = initRepo(path.join(parent, 'repo-a'), 'https://example.invalid/team/alpha.git');
  const beta = initRepo(path.join(parent, 'repo-b'));
  fs.writeFileSync(path.join(parent, 'dev.code-workspace'), JSON.stringify({
    folders: [{ path: './repo-a' }, { path: './repo-b' }],
  }));
  const flags = { workspace: alpha, harnessHome: home, copilotHome: copilot, dryRun: true };
  const full = runOrient({ workspace: alpha, copilotHome: copilot, flags, query: 'layout' });
  const read = readOrientSlice({ workspace: alpha, copilotHome: copilot, flags, query: 'layout' });
  const record = readOrientSlice({ workspace: alpha, copilotHome: copilot, flags: { ...flags, contextVersion: 2 }, query: 'layout' });
  for (const layout of [full.layout, read.layout, record.slice.layout]) {
    assert.equal(layout.boundRoot, alpha);
    assert.equal(layout.kind, 'product-repo');
    assert.equal(layout.workspaceType, 'vscode');
    assert.equal(layout.roots[0].root, beta);
    assert.equal(layout.roots[0].kind, 'product-repo');
    assert.equal(fs.existsSync(layout.domainSuggestion.path), false);
  }
  const doc = YAML.parse(full.layout.domainSuggestion.yaml);
  assert.equal(doc.domain_version, 2);
  assert.equal(doc.name, path.basename(full.layout.domainSuggestion.path, '.yaml'));
  assert.equal(fs.existsSync(path.join(home, 'domains')), false);
});

test('engineer and the investigation playbook name the bound repo and other roots', () => {
  const engineer = fs.readFileSync(path.join(packageRoot, 'corpus/agents/engineer.agent.md'), 'utf8');
  const playbook = fs.readFileSync(path.join(packageRoot, 'corpus/skills/references/playbooks/investigation.md'), 'utf8');
  assert.match(engineer, /State the bound repo and layout kind from `ae orient` first/);
  assert.ok(estimateTokens(engineer) <= 900, `engineer is ${estimateTokens(engineer)} tokens`);
  assert.ok(Math.ceil(Buffer.byteLength(engineer) / 4) <= 900);
  assert.match(playbook, /other Git roots[\s\S]*one researcher per repo/);
  assert.match(playbook, /Plans stay on the bound repo/);
  const global = fs.readFileSync(path.join(packageRoot, 'corpus/instructions/harness-global.instructions.md'), 'utf8');
  assert.match(global, /do not write the domain file/i);
  const doc = fs.readFileSync(path.join(repoRoot, 'docs/workspace-layout-detection.md'), 'utf8');
  assert.match(doc, /Krish chose option 3/);
  assert.doesNotMatch(doc, /Nothing here is selected/);
});
