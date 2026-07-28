import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { materializeFixture, finalizeWorkspace } from '../../lib/fixture.mjs';
import { applyOps } from '../../../packages/harness/lib/knowledge/apply.mjs';
import { evalKnowledge } from '../../../packages/harness/lib/knowledge/eval.mjs';

const fixturesRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'fixtures');

// Capability: `harness eval-knowledge` computes a deterministic retrieval PROXY
// (hit / false-surface / token cost per arm) on a temporal train/held-out split
// of a real consolidated store — no model, no benefit claim, just measurement.
// This is a proxy for the deferred model-graded net-benefit number (design
// §12): a lexical-overlap hit only proves a relevant learning was surfaced.
export const meta = {
  id: 'eval-knowledge',
  capability: 'eval-knowledge computes a deterministic retrieval proxy on a real held-out split',
  kind: 'deterministic',
  runtime: 'node',
  success: 'bm25 finds the relevant learning on held-out queries with zero false surfaces',
};

function writeEpisode(ws, category, slug, { title, tags = [], date }) {
  const dir = path.join(ws, 'docs', 'solutions', category);
  fs.mkdirSync(dir, { recursive: true });
  const lines = ['---', `title: "${title}"`];
  if (tags.length) lines.push(`tags: ${tags.join(', ')}`);
  if (date) lines.push(`date: ${date}`);
  lines.push('---', '', '## Problem', '', `${title} details.`, '');
  const text = lines.join('\n');
  fs.writeFileSync(path.join(dir, `${slug}.md`), text, 'utf8');
  return {
    path: `docs/solutions/${category}/${slug}.md`,
    sha256: crypto.createHash('sha256').update(text).digest('hex'),
  };
}

export async function run() {
  const ws = materializeFixture('payment-service');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-eval-knowledge-home-'));
  try {
    // 6 dated episodes across two categories: 4 before the cutoff (train), 2
    // after (held-out) — matches evalKnowledge's median-date split for n=6.
    const auth1 = writeEpisode(ws, 'auth', 'auth-1', {
      title: 'Auth token refresh race condition',
      tags: ['auth', 'token', 'refresh'],
      date: '2026-01-01',
    });
    writeEpisode(ws, 'auth', 'auth-2', {
      title: 'Auth session expiry bug',
      tags: ['auth', 'session'],
      date: '2026-01-02',
    });
    const billing1 = writeEpisode(ws, 'billing', 'billing-1', {
      title: 'Billing invoice rounding error',
      tags: ['billing', 'invoice', 'rounding'],
      date: '2026-01-03',
    });
    writeEpisode(ws, 'billing', 'billing-2', {
      title: 'Billing webhook retry duplicate',
      tags: ['billing', 'webhook'],
      date: '2026-01-04',
    });
    writeEpisode(ws, 'auth', 'auth-3', {
      title: 'Auth token refresh regression',
      tags: ['auth', 'token'],
      date: '2026-03-01',
    });
    writeEpisode(ws, 'billing', 'billing-3', {
      title: 'Billing invoice rounding regression',
      tags: ['billing', 'invoice'],
      date: '2026-03-02',
    });

    // 2 learnings via the real sole-writer (applyOps is exactly what
    // `harness consolidate --apply` runs), each linked to one train episode.
    const opsPath = path.join(ws, 'ops.json');
    fs.writeFileSync(
      opsPath,
      JSON.stringify({
        schema: 1,
        ops: [
          {
            op: 'ADD',
            domain: 'auth',
            slug: 'token-refresh-race',
            trigger: 'auth token refresh race condition',
            body: 'Serialize refresh calls behind a per-session lock so concurrent requests do not double-refresh the token.',
            episodes: [{ path: auth1.path, sha256: auth1.sha256, kind: 'fix', plan: 'docs/plans/2026-07-20-feat-payment-override-role.md' }],
          },
          {
            op: 'ADD',
            domain: 'billing',
            slug: 'invoice-rounding',
            trigger: 'billing invoice rounding error',
            body: 'Round at the cent boundary once, at the final total — not per line item — to avoid drift.',
            episodes: [{ path: billing1.path, sha256: billing1.sha256, kind: 'fix', plan: 'docs/plans/2026-07-20-feat-payment-override-role.md' }],
          },
        ],
      })
    );
    const applied = applyOps({ workspace: ws, opsPath, home });
    if (applied.exitCode !== 0) {
      throw new Error(`consolidate --apply failed in fixture setup: ${JSON.stringify(applied.rejected)}`);
    }

    const negativeQueries = JSON.parse(fs.readFileSync(path.join(fixturesRoot, 'knowledge-negative-queries.json'), 'utf8'));
    return evalKnowledge({ workspace: ws, copilotHome: ws, home, negativeQueries });
  } finally {
    finalizeWorkspace(ws, 'eval-knowledge');
    fs.rmSync(home, { recursive: true, force: true });
  }
}

export async function grade(result) {
  const bm25 = result?.arms?.bm25;
  const recommendationValid = result?.recommendation === 'whole-index' || result?.recommendation === 'bm25-top3';
  const pass = Boolean(result?.pass) && Boolean(bm25) && bm25.hitRate >= 0.5 && bm25.falseSurfaceRate === 0 && recommendationValid;
  return {
    verdict: pass ? 'pass' : 'fail',
    reason: pass
      ? `bm25 hitRate ${bm25.hitRate} with 0 false surfaces; recommendation ${result.recommendation}`
      : `bm25 arm below threshold or recommendation invalid: ${JSON.stringify({ pass: result?.pass, bm25, recommendation: result?.recommendation })}`,
    evidence: result,
  };
}

// Verifier self-test fixtures per the runner contract (evals/lib/runner.mjs:53).
export const fixtures = {
  pass: {
    pass: true,
    split: { train: 4, heldOut: 2, cutoff: '2026-01-04', undated: 0, unscorable: 1 },
    arms: {
      none: { hitRate: 0, falseSurfaceRate: 0, injectedTokens: 0 },
      frontmatter: { hitRate: 1, falseSurfaceRate: 0, injectedTokens: 14 },
      wholeIndex: { hitRate: 1, falseSurfaceRate: 0, injectedTokens: 12 },
      bm25: { hitRate: 1, falseSurfaceRate: 0, injectedTokens: 9 },
    },
    recommendation: 'whole-index',
  },
  fail: {
    pass: true,
    split: { train: 4, heldOut: 2, cutoff: '2026-01-04', undated: 0, unscorable: 1 },
    arms: {
      none: { hitRate: 0, falseSurfaceRate: 0, injectedTokens: 0 },
      frontmatter: { hitRate: 0, falseSurfaceRate: 0.17, injectedTokens: 14 },
      wholeIndex: { hitRate: 1, falseSurfaceRate: 0, injectedTokens: 12 },
      bm25: { hitRate: 0, falseSurfaceRate: 0.17, injectedTokens: 9 },
    },
    recommendation: 'whole-index',
  },
};
