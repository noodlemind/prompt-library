import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { getCorpusRoot } from '../lib/assets.mjs';
import { syncAssetsToTarget } from '../lib/sync.mjs';
import { tempDir } from './helpers/temp.mjs';

const SLASH = /(?:^|[\s([`"'])\/([a-z][a-z0-9-]*)\b/g;
const PROJECT_BLURB = /Skill-driven prompt library for software development using GitHub Copilot/;

function walk(dir, acc = []) {
  if (!fs.existsSync(dir)) return acc;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, acc);
    else if (entry.isFile() && (entry.name.endsWith('.md') || entry.name.endsWith('.mjs'))) acc.push(full);
  }
  return acc;
}

function slashRefs(text) {
  return [...text.matchAll(SLASH)].map((match) => match[1]);
}

function invocableSkill(corpus, name) {
  const file = path.join(corpus, 'skills', name, 'SKILL.md');
  if (!fs.existsSync(file)) return false;
  const frontmatter = fs.readFileSync(file, 'utf8').match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1] || '';
  return !/^user-invocable:\s*false\s*$/m.test(frontmatter);
}

function alwaysOnFiles(root) {
  const files = [];
  const instructions = path.join(root, 'instructions');
  if (fs.existsSync(instructions)) files.push(...walk(instructions).filter((file) => file.endsWith('.md')));
  const shared = path.join(root, 'copilot-instructions.md');
  if (fs.existsSync(shared)) files.push(shared);
  const agents = path.join(root, 'agents');
  if (fs.existsSync(agents)) files.push(...walk(agents).filter((file) => file.endsWith('.agent.md')));
  return files;
}

test('always-on slash references resolve to an invocable skill', () => {
  const corpus = getCorpusRoot();
  const unresolved = [];
  for (const file of alwaysOnFiles(corpus)) {
    const text = fs.readFileSync(file, 'utf8');
    for (const name of slashRefs(text)) {
      if (!invocableSkill(corpus, name)) unresolved.push(`${path.relative(corpus, file)}: /${name}`);
    }
  }
  assert.deepEqual(unresolved, []);
});

test('the concurrency confirmation rule lives only in the engineer agent', () => {
  const corpus = getCorpusRoot();
  const confirmation = [];
  const reproduction = [];
  const presumed = [];
  for (const file of walk(corpus)) {
    const text = fs.readFileSync(file, 'utf8');
    const rel = path.relative(corpus, file);
    if (text.includes('confirmed only when evidence demonstrates')) confirmation.push(rel);
    if (text.includes('failing concurrent reproduction')) reproduction.push(rel);
    if (text.includes('confirmed race/retry defect')) presumed.push(rel);
  }
  assert.deepEqual(confirmation, ['agents/engineer.agent.md']);
  assert.deepEqual(reproduction, ['agents/engineer.agent.md']);
  assert.deepEqual(presumed, []);
});

test('installed copilot instructions do not carry this repository project description', () => {
  const corpus = getCorpusRoot();
  const target = tempDir('corpus-install-');
  syncAssetsToTarget(corpus, target, { dryRun: false, preserveKnowledge: true, verbose: false }, () => {});
  const installed = fs.readFileSync(path.join(target, 'copilot-instructions.md'), 'utf8');
  assert.doesNotMatch(installed, PROJECT_BLURB);
  assert.doesNotMatch(installed, /^## Project$/m);
  const unresolved = [];
  for (const file of alwaysOnFiles(target)) {
    for (const name of slashRefs(fs.readFileSync(file, 'utf8'))) {
      if (!invocableSkill(corpus, name)) unresolved.push(`${path.relative(target, file)}: /${name}`);
    }
  }
  assert.deepEqual(unresolved, []);
});
