#!/usr/bin/env node
/**
 * Rebuild knowledge/manifest.yaml from solution files.
 * Usage: node scripts/index-knowledge.mjs [solutionsRoot]
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

function parseFrontmatter(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return {};
  const out = {};
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^([\w-]+):\s*(.*)$/);
    if (kv) out[kv[1]] = kv[2].replace(/^["']|["']$/g, '').trim();
  }
  return out;
}

function summaryFromBody(text) {
  const prob = text.match(/## Problem\s*\n+([^\n#]+)/i);
  if (prob) return prob[1].trim().slice(0, 200);
  return text.replace(/^---[\s\S]*?---\n/, '').trim().split('\n').find((l) => l.trim())?.slice(0, 200) || '';
}

function collectSolutions(dir, scope) {
  const entries = [];
  if (!fs.existsSync(dir)) return entries;
  for (const cat of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!cat.isDirectory()) continue;
    const catPath = path.join(dir, cat.name);
    for (const f of fs.readdirSync(catPath)) {
      if (!f.endsWith('.md') || f === 'README.md') continue;
      const full = path.join(catPath, f);
      const text = fs.readFileSync(full, 'utf8');
      const fm = parseFrontmatter(text);
      const rel = path.relative(repoRoot, full).replace(/\\/g, '/');
      const slug = f.replace(/\.md$/, '');
      entries.push({
        id: `${cat.name}-${slug}`,
        kind: 'solution',
        scope,
        path: rel,
        title: fm.title || slug,
        category: fm.category || cat.name,
        tags: fm.tags ? fm.tags.split(',').map((t) => t.trim()) : [],
        module: fm.module || '',
        symptom: fm.symptom || '',
        summary: summaryFromBody(text),
        updated: fm.date || '',
      });
    }
  }
  return entries;
}

const roots = [
  { dir: path.join(repoRoot, 'knowledge', 'solutions'), scope: 'global' },
  { dir: path.join(repoRoot, 'docs', 'solutions'), scope: 'product' },
];

const argRoot = process.argv[2];
if (argRoot) {
  roots.length = 0;
  roots.push({ dir: path.resolve(argRoot), scope: 'global' });
}

let entries = [];
for (const { dir, scope } of roots) {
  entries = entries.concat(collectSolutions(dir, scope));
}

entries.sort((a, b) => a.id.localeCompare(b.id));

const manifestPath = path.join(repoRoot, 'knowledge', 'manifest.yaml');
const today = new Date().toISOString().slice(0, 10);

const lines = [
  '# Team knowledge index — rebuilt by scripts/index-knowledge.mjs',
  'version: 1',
  `updated: ${today}`,
  'entries:',
];

for (const e of entries) {
  lines.push(`  - id: ${e.id}`);
  lines.push(`    kind: ${e.kind}`);
  lines.push(`    scope: ${e.scope}`);
  lines.push(`    path: ${e.path}`);
  lines.push(`    title: "${(e.title || '').replace(/"/g, '\\"')}"`);
  lines.push(`    category: ${e.category}`);
  if (e.tags.length) lines.push(`    tags: [${e.tags.map((t) => `"${t}"`).join(', ')}]`);
  if (e.module) lines.push(`    module: "${e.module.replace(/"/g, '\\"')}"`);
  if (e.symptom) lines.push(`    symptom: "${e.symptom.replace(/"/g, '\\"')}"`);
  if (e.summary) lines.push(`    summary: "${e.summary.replace(/"/g, '\\"')}"`);
  if (e.updated) lines.push(`    date: ${e.updated}`);
}

fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
fs.writeFileSync(manifestPath, lines.join('\n') + '\n', 'utf8');
console.log(`Wrote ${entries.length} entries to ${manifestPath}`);
