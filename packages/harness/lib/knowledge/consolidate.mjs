import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { storeDir, readLedger, listLearnings, readStoreConfig } from './store.mjs';

export const CONSOLIDATION_THRESHOLD = 5;
export const MAX_OPS_PER_RUN = 5;
export const LEARNING_BYTE_CAP = 1200;
// Three strikes: a content-failure code raised by the same op episode
// (path@sha256) three times quarantines it (apply.mjs) — surfaced here and
// excluded from future debt/candidates (design §3).
export const QUARANTINE_THRESHOLD = 3;
const LEARNING_BODY_BUDGET_BYTES = 30_000;
export const PROMOTION_FIX_THRESHOLD = 3;
export const PROMOTION_PLAN_THRESHOLD = 2;

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
          date: fm.date || null,
        });
      }
    }
  }
  return episodes;
}

/**
 * Split the ledger into: entries that fully consume an episode (it was
 * either given a learning outcome — including NOOP's explicit `learning:
 * null` — or quarantined after three strikes) and the quarantined subset,
 * surfaced separately for `--status`/`--candidates`/doctor K2. A pure failure
 * entry (`{ path, sha256, failure, at }` — no `learning` key, not yet
 * quarantined) must NOT consume the episode: the point of recording strikes
 * is that the episode keeps counting as debt until either it's fixed
 * (consolidated normally) or it hits the 3rd strike and gets quarantined.
 */
function splitLedger(ledger) {
  const consumed = new Set();
  const quarantined = [];
  for (const e of ledger) {
    if (e.quarantined) {
      quarantined.push(e);
      consumed.add(`${e.path}@${e.sha256}`);
    } else if ('learning' in e) {
      consumed.add(`${e.path}@${e.sha256}`);
    }
  }
  return { consumed, quarantined };
}

function activeLearnings(learnings) {
  return learnings.filter(
    (l) => !l.fm.superseded_by && !['retired', 'disputed'].includes(l.fm.status)
  );
}

/**
 * ≥3 fix-kind episode links across ≥2 distinct plans — the single source of
 * truth for the promotion signal, shared by promotionCandidates below and the
 * learnings listing (listing.mjs) so the thresholds are defined once.
 */
export function verifiedAndPlans(fm) {
  const fixes = (fm.episodes || []).filter((e) => e.kind === 'fix');
  const plans = new Set(fixes.map((e) => e.plan).filter(Boolean));
  return { verified: fixes.length, plans: plans.size };
}

export function isPromotionEligible(verified, plans) {
  return verified >= PROMOTION_FIX_THRESHOLD && plans >= PROMOTION_PLAN_THRESHOLD;
}

/** Computed, never stored: ≥3 fix links across ≥2 distinct plans. */
export function promotionCandidates(learnings) {
  const out = [];
  for (const l of activeLearnings(learnings)) {
    const { verified, plans } = verifiedAndPlans(l.fm);
    if (isPromotionEligible(verified, plans)) {
      out.push({ id: l.id, verified, plans });
    }
  }
  return out;
}

export function consolidateStatus({ workspace, copilotHome, home }) {
  // Non-creating read: --status must never materialize a store that isn't
  // there yet — an absent store just reports empty ledger/learnings.
  const dir = storeDir(workspace, { home });
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

  // Non-creating read: --candidates must never materialize a store either —
  // an absent store just means no active learnings to report.
  const dir = storeDir(workspace, { home });
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
