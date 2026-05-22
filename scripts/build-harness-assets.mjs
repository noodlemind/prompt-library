#!/usr/bin/env node
/**
 * Copy prompt-library primitives into packages/harness/assets for npm publish.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const outRoot = path.join(repoRoot, 'packages', 'harness', 'assets');

const copies = [
  { from: '.github/skills', to: 'skills' },
  { from: '.github/agents', to: 'agents' },
  { from: '.github/instructions', to: 'instructions' },
  { from: '.github/prompts', to: 'prompts' },
  { from: 'knowledge', to: 'knowledge' },
  { from: 'enterprise', to: 'enterprise' },
];

function rmrf(dir) {
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
}

function cpRecursive(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.cpSync(src, dest, { recursive: true });
}

rmrf(outRoot);
fs.mkdirSync(outRoot, { recursive: true });

for (const { from, to } of copies) {
  const src = path.join(repoRoot, from);
  const dst = path.join(outRoot, to);
  if (!fs.existsSync(src)) {
    console.warn(`skip missing: ${from}`);
    continue;
  }
  cpRecursive(src, dst);
  console.log(`copied ${from} → assets/${to}`);
}

const version = JSON.parse(
  fs.readFileSync(path.join(repoRoot, 'packages', 'harness', 'package.json'), 'utf8')
).version;

fs.writeFileSync(
  path.join(outRoot, 'harness-version.txt'),
  `${version}\n`,
  'utf8'
);

console.log(`assets ready at ${outRoot}`);
