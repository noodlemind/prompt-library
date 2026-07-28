import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { ensureStore, readLedger, listLearnings, readStoreConfig } from './store.mjs';

export const CONSOLIDATION_THRESHOLD = 5;
export const MAX_OPS_PER_RUN = 5;
export const LEARNING_BYTE_CAP = 1200;
const LEARNING_BODY_BUDGET_BYTES = 30_000;

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

function excerpt(text) {
  const body = text.replace(/^---[\s\S]*?---\n/, '').trim();
  return body.replace(/\s+/g, ' ').slice(0, 240);
}

/** Collect episodes from the same roots the knowledge index scans. */
export function collectEpisodes({ workspace, copilotHome }) {
  const roots = [];
  const globalSol = copilotHome ? path.join(copilotHome, 'knowledge', 'solutions') : null;
  if (globalSol && fs.existsSync(globalSol)) {
    roots.push({ dir: globalSol, base: path.join(copilotHome, 'knowledge') });
  }
  const productSol = path.join(workspace, 'docs', 'solutions');
  if (fs.existsSync(productSol)) roots.push({ dir: productSol, base: workspace });

  const episodes = [];
  for (const { dir, base } of roots) {
    for (const cat of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!cat.isDirectory()) continue;
      const catPath = path.join(dir, cat.name);
      for (const f of fs.readdirSync(catPath)) {
        if (!f.endsWith('.md') || f === 'README.md') continue;
        const full = path.join(catPath, f);
        const text = fs.readFileSync(full, 'utf8');
        const fm = parseFrontmatter(text);
        episodes.push({
          path: path.relative(base, full).split(path.sep).join('/'),
          sha256: crypto.createHash('sha256').update(text).digest('hex'),
          kind: fm.kind === 'insight' ? 'insight' : 'fix',
          category: cat.name,
          title: fm.title || f.replace(/\.md$/, ''),
          tags: fm.tags ? fm.tags.split(',').map((t) => t.trim()) : [],
          excerpt: excerpt(text),
        });
      }
    }
  }
  return episodes;
}

function splitLedger(ledger) {
  const consumed = new Set();
  const quarantined = [];
  for (const e of ledger) {
    if (e.quarantined) quarantined.push(e);
    consumed.add(`${e.path}@${e.sha256}`);
  }
  return { consumed, quarantined };
}

function activeLearnings(learnings) {
  return learnings.filter(
    (l) => !l.fm.superseded_by && !['retired', 'disputed'].includes(l.fm.status)
  );
}

/** Computed, never stored: ≥3 fix links across ≥2 distinct plans. */
export function promotionCandidates(learnings) {
  const out = [];
  for (const l of activeLearnings(learnings)) {
    const fixes = (l.fm.episodes || []).filter((e) => e.kind === 'fix');
    const plans = new Set(fixes.map((e) => e.plan).filter(Boolean));
    if (fixes.length >= 3 && plans.size >= 2) {
      out.push({ id: l.id, verified: fixes.length, plans: plans.size });
    }
  }
  return out;
}

export function consolidateStatus({ workspace, copilotHome, home }) {
  const { dir } = ensureStore(workspace, { home });
  const { mode } = readStoreConfig(workspace, { home });
  const episodes = collectEpisodes({ workspace, copilotHome });
  const { consumed, quarantined } = splitLedger(readLedger(dir));
  const unconsolidated = episodes
    .filter((e) => !consumed.has(`${e.path}@${e.sha256}`))
    .map(({ path: p, sha256, kind, title }) => ({ path: p, sha256, kind, title }));
  const learnings = listLearnings(dir);
  const active = activeLearnings(learnings);
  const debt = unconsolidated.length;
  // Consolidation writes (hints toward --apply) are gated to mode 'on' — a
  // non-on mode never reports due, however large the debt has grown.
  const due = mode === 'on' && debt >= CONSOLIDATION_THRESHOLD;
  return {
    mode,
    debt,
    threshold: CONSOLIDATION_THRESHOLD,
    due,
    unconsolidated,
    quarantined,
    learnings: { active: active.length, total: learnings.length },
    promotionCandidates: promotionCandidates(learnings),
    storeDir: dir,
    nextTools: due ? ['harness consolidate --candidates'] : [],
  };
}

/**
 * The deterministic work packet for the consolidation skill: episode clusters
 * plus the full active-learning index (bodies while the corpus is small), and
 * the write contract the ops JSON must satisfy.
 */
export function consolidateCandidates({ workspace, copilotHome, home }) {
  const status = consolidateStatus({ workspace, copilotHome, home });
  const episodes = collectEpisodes({ workspace, copilotHome });
  const bySha = new Map(episodes.map((e) => [`${e.path}@${e.sha256}`, e]));
  const clusters = new Map();
  for (const u of status.unconsolidated) {
    const full = bySha.get(`${u.path}@${u.sha256}`);
    if (!full) continue;
    if (!clusters.has(full.category)) clusters.set(full.category, []);
    clusters.get(full.category).push({
      path: full.path,
      sha256: full.sha256,
      kind: full.kind,
      title: full.title,
      tags: full.tags,
      excerpt: full.excerpt,
    });
  }

  const { dir } = ensureStore(workspace, { home });
  const active = activeLearnings(listLearnings(dir));
  const totalBytes = active.reduce((n, l) => n + l.bytes, 0);
  const includeBodies = totalBytes <= LEARNING_BODY_BUDGET_BYTES;
  const learnings = active.map((l) => ({
    id: l.id,
    trigger: l.fm.trigger || '',
    status: l.fm.status || 'active',
    bytes: l.bytes,
    ...(includeBodies ? { body: l.body } : {}),
  }));

  return {
    schema: 1,
    contract: { maxOps: MAX_OPS_PER_RUN, byteCap: LEARNING_BYTE_CAP, threshold: CONSOLIDATION_THRESHOLD },
    clusters: [...clusters.entries()].map(([id, eps]) => ({ id, episodes: eps })),
    learnings,
    storeDir: dir,
  };
}
