import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { storeDir, readLedger, listLearnings, readStoreConfig, readGovernance, inertLine } from './store.mjs';
import { readFileNoFollow, assertNoSymlinkAncestors } from '../fs-safe.mjs';

export const CONSOLIDATION_THRESHOLD = 5;
export const MAX_OPS_PER_RUN = 5;
export const LEARNING_BYTE_CAP = 1200;
// Three strikes: a content-failure code raised by the same op episode
// (path@sha256) three times quarantines it (apply.mjs) — surfaced here and
// excluded from future debt/candidates (design §3).
export const QUARANTINE_THRESHOLD = 3;
// Per-domain write cap (design §9, milestone 3): a domain at or over this many
// active learnings blocks a plain ADD/SUPERSEDE(-new-id) — the model must
// MERGE existing learnings (re-deriving from their episodes) or a human must
// retire one first. Enforced in apply.mjs; surfaced here for --status/
// --candidates so the skill can see cap pressure before proposing ops.
export const DOMAIN_ACTIVE_CAP = 25;
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
  // inertLine (store.mjs) runs AFTER the \s+ collapse: \s only covers
  // whitespace control chars (tab/newline/CR/FF/VT) — a NUL byte or another
  // non-whitespace C0 control char embedded in the body would otherwise
  // survive this collapse verbatim (Important #2, adversarial review).
  return inertLine(body.replace(/\s+/g, ' ').slice(0, 240));
}

/**
 * Collect episodes from the same roots the knowledge index scans. Every
 * candidate path — the scanned root directory itself, each category
 * directory, and each file — is validated with `assertNoSymlinkAncestors`
 * (fs-safe.mjs) against the WORKSPACE or `copilotHome/knowledge` BASE, the
 * exact same base purge already resolves against — never against a
 * realpath of the scanned subdir itself. An earlier version of this
 * function computed containment against `realpathSync(dir)` (the scanned
 * docs/solutions directory) — but when `dir` itself is a symlink, its
 * realpath IS the resolved-through target, so every file underneath passed
 * containment against itself trivially (adversarial review, probe A): a
 * symlinked `docs/solutions` leaked outside content straight into a
 * candidate's excerpt, pre-hashed, with zero attacker foreknowledge needed.
 * Checking from the BASE down (docs -> solutions -> category -> file) is
 * what actually catches a symlink at ANY of those levels. A rejected
 * component (or the whole scan root) is simply skipped — for a symlinked
 * root, skipped BEFORE any directory listing is ever read, so not even a
 * category/filename can leak through it.
 */
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
    const dirRel = path.relative(base, dir);
    // The scan root itself must be physically contained — checked BEFORE
    // ever reading its directory listing, so a symlinked docs/solutions (or
    // solutions/ under copilotHome/knowledge) is skipped with zero
    // filesystem reads through it, not just its file contents.
    if (!assertNoSymlinkAncestors(base, dirRel)) continue;
    for (const cat of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!cat.isDirectory()) continue;
      const catRel = path.join(dirRel, cat.name);
      if (!assertNoSymlinkAncestors(base, catRel)) continue; // symlinked category directory
      const catPath = path.join(dir, cat.name);
      for (const f of fs.readdirSync(catPath)) {
        if (!f.endsWith('.md') || f === 'README.md') continue;
        const fileRel = path.join(catRel, f);
        const full = assertNoSymlinkAncestors(base, fileRel);
        if (!full) continue; // symlinked leaf (or any ancestor) — never follow
        const text = readFileNoFollow(full);
        if (text === null) continue;
        const fm = parseFrontmatter(text);
        episodes.push({
          path: fileRel.split(path.sep).join('/'),
          sha256: crypto.createHash('sha256').update(text).digest('hex'),
          kind: fm.kind === 'insight' ? 'insight' : fm.kind === 'human-teaching' ? 'human-teaching' : 'fix',
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
 *
 * Exported so init-repo.mjs's dry-run debt preview can reuse the exact same
 * consumed-semantics instead of keeping its own (looser) copy that treats
 * every ledger entry as consumed — a failure entry alone must never count an
 * episode as debt-free.
 */
export function splitLedger(ledger) {
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

// A learning with `promoted_to` set has been recorded as promoted — it drops
// out of every active-learning surface (cap counts, promotion candidates,
// ranking, rebuild) exactly like retired/disputed/superseded, even though
// `promote` leaves its own `status` field untouched.
export function isActiveFm(fm) {
  return !fm.superseded_by && !fm.promoted_to && !['retired', 'disputed'].includes(fm.status);
}

export function activeLearnings(learnings) {
  return learnings.filter((l) => isActiveFm(l.fm));
}

/**
 * Per-domain active-learning count against DOMAIN_ACTIVE_CAP. Shared by
 * `--status` (compact cap-pressure note) and `--candidates` (full packet) so
 * the skill and the human-facing CLI agree on which domains are at cap.
 */
function domainPressure(learnings) {
  const counts = new Map();
  for (const l of activeLearnings(learnings)) {
    counts.set(l.domain, (counts.get(l.domain) || 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([domain, active]) => ({ domain, active, cap: DOMAIN_ACTIVE_CAP, atCap: active >= DOMAIN_ACTIVE_CAP }));
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
  // Consolidation writes (hints toward --apply) are gated to 'on'/'suggest' —
  // any other mode never reports due, however large the debt has grown.
  const due = ['on', 'suggest'].includes(mode) && debt >= CONSOLIDATION_THRESHOLD;
  return {
    mode,
    debt,
    threshold: CONSOLIDATION_THRESHOLD,
    due,
    unconsolidated,
    quarantined,
    learnings: { active: active.length, total: learnings.length },
    domains: domainPressure(learnings),
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
      // inertLine (round 2, adversarial review): title/tags are episode
      // frontmatter assertions, same untrusted-content class as trigger —
      // never normalized before, even though excerpt already was.
      title: inertLine(full.title),
      tags: (full.tags || []).map(inertLine),
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
    // inertLine (Important #2, adversarial review): the candidates packet is
    // read by the consolidation skill and can end up quoted back into
    // structured output — a legacy/hand-edited trigger carrying an embedded
    // control char must render as one line here too, same as every other
    // trigger-interpolating surface (context pack, listing, INDEX.md).
    trigger: inertLine(l.fm.trigger || ''),
    status: l.fm.status || 'active',
    bytes: l.bytes,
    // body is multi-line BY DESIGN (a learning's markdown claim) — unlike
    // trigger, it is never flattened to one line; inertLine runs PER LINE
    // (split -> map -> join) so a legacy/hand-edited body's embedded control
    // char (a NUL, an ESC, ...) is neutralized without collapsing the
    // legitimate line structure.
    ...(includeBodies ? { body: l.body.split('\n').map(inertLine).join('\n') } : {}),
  }));

  // Every id a human already decided retire/dispute/promote on (Milestone 4
  // Task 2) — surfaced so the skill never proposes an ADD/SUPERSEDE/MERGE
  // into one of these ids without knowing apply will immediately re-govern
  // it back to the recorded state. `confirm` is excluded — it isn't a
  // standing decision applyOps reapplies, so it carries no such warning.
  // Non-creating read, same as everything else in this function.
  const governed = [...readGovernance(dir).values()]
    .filter((e) => ['retire', 'dispute', 'promote'].includes(e.action))
    .map((e) => ({ id: e.id, action: e.action }));

  return {
    schema: 1,
    contract: {
      maxOps: MAX_OPS_PER_RUN,
      byteCap: LEARNING_BYTE_CAP,
      threshold: CONSOLIDATION_THRESHOLD,
      domainCap: DOMAIN_ACTIVE_CAP,
    },
    clusters: [...clusters.entries()].map(([id, eps]) => ({ id, episodes: eps })),
    learnings,
    domains: status.domains,
    governed,
    storeDir: dir,
  };
}
