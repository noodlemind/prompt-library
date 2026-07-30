import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { materializeFixture, finalizeWorkspace } from '../../lib/fixture.mjs';
import { applyOps } from '../../../packages/harness/lib/knowledge/apply.mjs';
import { rankLearnings } from '../../../packages/harness/lib/knowledge/retrieve.mjs';
import { EvalInfraError } from '../../lib/judge.mjs';

// Capability: a MODEL-GRADED companion to `eval-knowledge`'s lexical-overlap
// proxy. eval-knowledge's "hit" only proves a category-matching learning was
// surfaced — never that the learning is actually useful for the held-out
// problem. This task asks a judge model, per held-out episode, whether the
// bm25 top-1 learning is genuinely applicable to that episode's problem, and
// reports the fraction judged "yes" as a JUDGED-PRECISION number.
//
// Explicitly NOT a net-benefit measurement (design §12, still deferred): this
// judges retrieval applicability in isolation, not whether an agent's
// behavior actually improved from reading the injected learning. Never
// publish this number as a benefit/savings claim.
export const meta = {
  id: 'knowledge-judged-precision',
  capability: 'judge whether bm25 top-1 retrieval is genuinely applicable per held-out episode',
  kind: 'semantic',
  runtime: 'node',
  success: 'judged precision (bm25 top-1 applicability) >= 0.5 over >=1 judged held-out case',
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

function episodeQuery(e) {
  return `${e.title} ${(e.tags || []).join(' ')}`.trim();
}

export async function run(ctx) {
  if (!ctx.provider) throw new EvalInfraError('semantic task requires a provider');

  const ws = materializeFixture('payment-service');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-eval-knowledge-judged-home-'));
  try {
    // Same 6-episode, two-category temporal fixture as eval-knowledge: 4
    // dated on/before 2026-01-04 (train), 2 dated after (held-out).
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
    const heldOutEpisodes = [
      { title: 'Auth token refresh regression', tags: ['auth', 'token'] },
      { title: 'Billing invoice rounding regression', tags: ['billing', 'invoice'] },
    ];
    writeEpisode(ws, 'auth', 'auth-3', { ...heldOutEpisodes[0], date: '2026-03-01' });
    writeEpisode(ws, 'billing', 'billing-3', { ...heldOutEpisodes[1], date: '2026-03-02' });

    // 2 learnings via the real sole-writer, each linked to one pre-cutoff
    // (train) episode — identical to eval-knowledge's fixture setup.
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

    // For each held-out episode: bm25 top-1 (the store's real retrieval
    // path), then ask the judge whether that single retrieved learning is
    // genuinely applicable to the episode's problem. An episode with no
    // bm25 candidate at all contributes nothing to judge — there is nothing
    // to judge, so it is not counted in either the numerator or denominator.
    const cases = [];
    for (const ho of heldOutEpisodes) {
      const top1 = rankLearnings({ workspace: ws, query: episodeQuery(ho), limit: 1, home })[0];
      if (!top1) continue;
      const text = await ctx.provider.complete({
        system:
          'You judge retrieval applicability for a knowledge base. Given a HELD-OUT PROBLEM and a single ' +
          'RETRIEVED LEARNING, decide whether the learning would genuinely help someone fixing that problem. ' +
          'Respond with exactly one word: yes or no.',
        user: [
          `HELD-OUT PROBLEM: "${ho.title}" (tags: ${ho.tags.join(', ')})`,
          `RETRIEVED LEARNING (id ${top1.id}):`,
          `- trigger: ${top1.trigger}`,
          `- claim: ${top1.claimLine}`,
        ].join('\n'),
        maxTokens: 5,
      });
      const applicable = /^\s*yes\b/i.test(text);
      cases.push({ episode: ho.title, learningId: top1.id, applicable });
    }

    const judgedCases = cases.length;
    const applicableCases = cases.filter((c) => c.applicable).length;
    const precision = judgedCases ? Number((applicableCases / judgedCases).toFixed(3)) : 0;

    return { precision, judgedCases, applicableCases, cases };
  } finally {
    finalizeWorkspace(ws, 'knowledge-judged-precision');
    fs.rmSync(home, { recursive: true, force: true });
  }
}

export async function grade(result) {
  const judgedCases = result?.judgedCases || 0;
  const precision = result?.precision ?? 0;
  const pass = judgedCases >= 1 && precision >= 0.5;
  return {
    verdict: pass ? 'pass' : 'fail',
    reason: pass
      ? `judged precision ${precision} over ${judgedCases} judged case(s) — NOT a net-benefit measurement`
      : `judged precision ${precision} over ${judgedCases} judged case(s), below the 0.5 threshold or no judged cases`,
    evidence: result,
  };
}

// Verifier self-test fixtures per the runner contract (evals/lib/runner.mjs:53).
// Pure result shapes — grade() never calls the provider, only run() does.
export const fixtures = {
  pass: {
    precision: 1,
    judgedCases: 2,
    applicableCases: 2,
    cases: [
      { episode: 'Auth token refresh regression', learningId: 'auth/token-refresh-race', applicable: true },
      { episode: 'Billing invoice rounding regression', learningId: 'billing/invoice-rounding', applicable: true },
    ],
  },
  fail: {
    precision: 0,
    judgedCases: 2,
    applicableCases: 0,
    cases: [
      { episode: 'Auth token refresh regression', learningId: 'auth/token-refresh-race', applicable: false },
      { episode: 'Billing invoice rounding regression', learningId: 'billing/invoice-rounding', applicable: false },
    ],
  },
};
