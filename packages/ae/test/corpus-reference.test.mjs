import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { getCorpusRoot } from '../lib/assets.mjs';
import { resolveInstalledReference } from '../lib/corpus-reference.mjs';
import { syncAssetsToTarget } from '../lib/sync.mjs';
import { tempDir } from './helpers/temp.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bin = path.join(packageRoot, 'bin', 'ae.mjs');
const corpus = getCorpusRoot();

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

function installedRel(full) {
  return path.relative(corpus, full).replace(/\\/g, '/');
}

test('every reference, playbook, and schema installs for vscode, cli, and intellij', () => {
  const root = tempDir('ae-ref-homes-');
  const homes = {
    vscode: path.join(root, 'vscode'),
    cli: path.join(root, 'cli'),
    intellij: path.join(root, 'intellij'),
  };
  for (const home of Object.values(homes)) {
    fs.mkdirSync(home, { recursive: true });
    syncAssetsToTarget(corpus, home, { dryRun: false, verbose: false }, () => {});
  }
  const wanted = walk(corpus).map(installedRel).filter((rel) => (
    rel.includes('/references/') || rel.includes('/playbooks/') || rel.endsWith('findings-schema.md') || rel.endsWith('review-personas.md')
  ));
  assert.ok(wanted.includes('skills/code-review/references/findings-schema.md'));
  assert.ok(wanted.includes('skills/code-review/references/review-personas.md'));
  assert.ok(wanted.includes('skills/references/playbooks/bug-fix.md'));
  for (const host of Object.keys(homes)) {
    for (const rel of wanted) {
      const found = resolveInstalledReference(rel, [homes[host]]);
      assert.ok(found, `${host} is missing ${rel}`);
      assert.equal(found.rel, rel);
      assert.equal(fs.readFileSync(found.fullPath, 'utf8'), fs.readFileSync(path.join(corpus, rel), 'utf8'));
    }
  }
});

test('ae get --reference prints review files from a home outside an empty workspace', () => {
  const root = tempDir('ae-ref-cli-');
  const workspace = path.join(root, 'product');
  const copilot = path.join(root, 'copilot');
  const intellij = path.join(root, 'intellij');
  fs.mkdirSync(workspace);
  fs.mkdirSync(path.join(workspace, 'src'));
  fs.writeFileSync(path.join(workspace, 'src', 'findings-schema.md'), 'workspace decoy\n');
  syncAssetsToTarget(corpus, copilot, { dryRun: false, verbose: false }, () => {});
  syncAssetsToTarget(corpus, intellij, { dryRun: false, verbose: false }, () => {});
  const read = (args, env = {}) => spawnSync(process.execPath, [bin, ...args, '--json', '--workspace', workspace, '--no-events'], {
    cwd: workspace,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  for (const spec of [
    'skills/code-review/references/findings-schema.md',
    'code-review/references/review-personas.md',
    'skills/references/playbooks/feature.md',
  ]) {
    const result = read(['get', '--reference', spec, '--copilot-home', copilot]);
    assert.equal(result.status, 0, result.stderr + result.stdout);
    const body = JSON.parse(result.stdout);
    assert.equal(body.truncated, false, spec);
    assert.doesNotMatch(body.excerpt, /workspace decoy/);
    assert.match(body.excerpt, /^# /);
  }
  const fromIntellij = read(
    ['get', '--reference', 'skills/code-review/references/findings-schema.md', '--copilot-home', path.join(root, 'empty-copilot')],
    { AE_INTELLIJ_HOME: intellij },
  );
  assert.equal(fromIntellij.status, 0, fromIntellij.stderr + fromIntellij.stdout);
  assert.match(JSON.parse(fromIntellij.stdout).excerpt, /Findings Schema/);
  assert.equal(fs.existsSync(path.join(workspace, 'skills')), false);
});

test('corpus instructions name ae get instead of a workspace search', () => {
  const roots = ['skills', 'agents', 'instructions'].map((name) => path.join(corpus, name));
  const problems = [];
  for (const file of roots.flatMap((dir) => walk(dir)).filter((full) => full.endsWith('.md'))) {
    const text = fs.readFileSync(file, 'utf8');
    const rel = path.relative(corpus, file);
    if (/search the (product )?workspace for (AE|corpus|findings-schema|review-personas)/i.test(text)
      && !/do not search/i.test(text)) {
      problems.push(`${rel} tells the engineer to search the workspace`);
    }
    for (const match of text.matchAll(/`([^`\n]+)`/g)) {
      const inner = match[1];
      if (inner.startsWith('ae get --reference ')) {
        const spec = inner.slice('ae get --reference '.length).split(/\s+/)[0];
        if (spec.includes('<')) continue;
        const target = path.join(corpus, spec);
        if (!fs.existsSync(target) || !fs.statSync(target).isFile()) problems.push(`${rel} references missing ${spec}`);
        continue;
      }
      if (/^(?:\.\.\/)*references\/[\w./-]+\.md/.test(inner)
        || /^~\/\.copilot\/skills\/[\w./-]+\.md/.test(inner)
        || /^(?:skills|agents|instructions|knowledge|enterprise|hooks)\/[\w./-]+\.md$/.test(inner)) {
        problems.push(`${rel} still names a bare corpus path: ${inner}`);
      }
    }
  }
  assert.deepEqual(problems, []);
  const review = fs.readFileSync(path.join(corpus, 'skills/code-review/SKILL.md'), 'utf8');
  assert.match(review, /ae get --reference skills\/code-review\/references\/findings-schema\.md --json/);
  assert.match(review, /ae get --reference skills\/code-review\/references\/review-personas\.md --json/);
  assert.match(review, /Do not search the product workspace/);
});
