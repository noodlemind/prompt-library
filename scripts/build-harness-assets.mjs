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

const singleFiles = [{ from: '.github/copilot-instructions.md', to: 'copilot-instructions.md' }];

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

for (const { from, to } of singleFiles) {
  const src = path.join(repoRoot, from);
  const dst = path.join(outRoot, to);
  if (!fs.existsSync(src)) {
    console.warn(`skip missing: ${from}`);
    continue;
  }
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
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

/** Normalize agent-facing docs: binary is `harness`, not `npx @dev-kit/harness`. */
function normalizeHarnessInvocation(dir) {
  const skip = new Set(['.git', 'node_modules', '.harness-index']);
  const reScoped = /npx\s+@dev-kit\/harness(?:@[\d.]+)?/g;
  const reBare = /npx\s+harness(?:@[\d.]+)?/g;
  let files = 0;
  function walk(current) {
    for (const name of fs.readdirSync(current)) {
      if (skip.has(name)) continue;
      const full = path.join(current, name);
      const st = fs.statSync(full);
      if (st.isDirectory()) {
        walk(full);
        continue;
      }
      if (!/\.(md|yaml|yml|json|txt)$/i.test(name)) continue;
      let text = fs.readFileSync(full, 'utf8');
      const next = text.replace(reScoped, 'harness').replace(reBare, 'harness');
      if (next !== text) {
        fs.writeFileSync(full, next, 'utf8');
        files++;
      }
    }
  }
  walk(dir);
  return files;
}

const normalized = normalizeHarnessInvocation(outRoot);
if (normalized > 0) {
  console.log(`normalized harness invocation in ${normalized} asset file(s)`);
}

console.log(`assets ready at ${outRoot}`);
