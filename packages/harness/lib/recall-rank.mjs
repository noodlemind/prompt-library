import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

function tokenize(s) {
  return (s || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 2);
}

function scoreEntry(queryTokens, entry) {
  const fields = [
    entry.title,
    entry.summary,
    entry.symptom,
    entry.module,
    ...(entry.tags || []),
  ]
    .filter(Boolean)
    .join(' ');
  const fieldTokens = new Set(tokenize(fields));
  if (!fieldTokens.size) return 0;
  let hit = 0;
  for (const t of queryTokens) {
    if (fieldTokens.has(t)) hit++;
  }
  const overlap = hit / Math.max(queryTokens.length, 1);
  const dateStr = entry.date || entry.updated;
  const recency =
    dateStr && /^\d{4}-\d{2}-\d{2}$/.test(dateStr)
      ? Math.max(0, 1 - (Date.now() - new Date(dateStr).getTime()) / (365 * 86400000))
      : 0;
  return overlap * 0.85 + recency * 0.15;
}

export function loadManifest(copilotHome, workspace) {
  const paths = [
    path.join(copilotHome, 'knowledge', 'manifest.yaml'),
    path.join(workspace, 'knowledge', 'manifest.yaml'),
  ];
  for (const p of paths) {
    if (!fs.existsSync(p)) continue;
    try {
      const yaml = require('yaml');
      const doc = yaml.parse(fs.readFileSync(p, 'utf8'));
      return { entries: doc.entries || [], path: p };
    } catch {
      /* try next */
    }
  }
  return { entries: [], path: null };
}

export function rankRecall(query, { copilotHome, workspace, limit = 3 }) {
  const { entries } = loadManifest(copilotHome, workspace);
  const queryTokens = tokenize(query);
  if (!queryTokens.length) return [];

  const scored = entries
    .map((e) => ({ ...e, score: scoreEntry(queryTokens, e) }))
    .filter((e) => e.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  return scored;
}

export function findMatchingPlans(workspace, query, limit = 3) {
  const plansDir = path.join(workspace, 'docs', 'plans');
  if (!fs.existsSync(plansDir)) return [];
  const queryTokens = new Set(tokenize(query));
  const results = [];

  for (const f of fs.readdirSync(plansDir)) {
    if (!f.endsWith('.md')) continue;
    const full = path.join(plansDir, f);
    const text = fs.readFileSync(full, 'utf8').slice(0, 4000);
    const fm = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    let status = 'unknown';
    let plan_lock = false;
    if (fm) {
      const sl = fm[1].match(/status:\s*(\S+)/);
      const pl = fm[1].match(/plan_lock:\s*(\S+)/);
      if (sl) status = sl[1];
      if (pl) plan_lock = pl[1] === 'true';
    }
    const tokens = new Set(tokenize(text));
    let hit = 0;
    for (const t of queryTokens) if (tokens.has(t)) hit++;
    const score = hit / Math.max(queryTokens.size, 1);
    if (score > 0.1) {
      results.push({
        path: `docs/plans/${f}`,
        score,
        status,
        plan_lock,
      });
    }
  }
  return results.sort((a, b) => b.score - a.score).slice(0, limit);
}
