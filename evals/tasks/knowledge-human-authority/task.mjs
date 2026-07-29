import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { applyOps } from '../../../packages/harness/lib/knowledge/apply.mjs';
import { setLearningStatus } from '../../../packages/harness/lib/knowledge/lifecycle.mjs';
import { runRemember } from '../../../packages/harness/lib/knowledge/remember.mjs';
import { rankLearnings } from '../../../packages/harness/lib/knowledge/retrieve.mjs';
import { storeDir, listLearnings, normalizeSlug } from '../../../packages/harness/lib/knowledge/store.mjs';

// Capability: authority is derived from VERIFIED evidence, never asserted by
// an op's own claim. A human `remember` lands active/human. A model-lane ADD
// that ASSERTS kind: human-teaching for evidence that does not verify against
// disk (a nonexistent file) fails toward LESS authority (auto/provisional),
// never toward more. A promoted learning is immutable: it drops out of
// retrieval and rejects even a fresh, genuinely-verified human SUPERSEDE.
export const meta = {
  id: 'knowledge-human-authority',
  capability: 'authority derives from verified evidence; fabrication demotes; promotion is immutable',
  kind: 'deterministic',
  runtime: 'node',
  success: 'remember lands human/active, a fabricated human-teaching claim is demoted to auto/provisional, and a promoted learning is excluded from retrieval and protected from any further SUPERSEDE',
};

const DOMAIN = 'payments';
const TRIGGER = 'payment retry backoff policy';

export async function run() {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-eval-human-authority-ws-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-eval-human-authority-home-'));
  try {
    const domain = normalizeSlug(DOMAIN);
    const slug = normalizeSlug(TRIGGER);
    const learningId = `${domain}/${slug}`;
    const dir = storeDir(ws, { home });

    // (a) A direct human claim via `remember` lands active/human.
    const remembered = runRemember({
      workspace: ws,
      copilotHome: ws,
      flags: { trigger: TRIGGER, domain: DOMAIN },
      argv: ['Retry payment webhooks with exponential backoff and a jitter window.'],
      home,
    });
    const learningAfterRemember = listLearnings(dir).find((l) => l.id === learningId);

    // (b) A model-lane ADD asserting kind: human-teaching for a file that
    // does not exist — verifyHumanTeachingEpisode fails closed (can't read
    // the file), so authority derivation falls back to auto/provisional
    // rather than trusting the op's own unverifiable claim.
    const fabricatedPath = 'docs/solutions/fake/does-not-exist.md';
    const fabricatedSha = crypto.createHash('sha256').update('fabricated-content-never-written').digest('hex');
    const fabId = `${domain}/fabricated-claim`;
    const fabOpsPath = path.join(ws, 'ops-fabricated.json');
    fs.writeFileSync(
      fabOpsPath,
      JSON.stringify({
        schema: 1,
        ops: [
          {
            op: 'ADD',
            domain: DOMAIN,
            slug: 'fabricated-claim',
            trigger: 'fabricated human teaching claim',
            body: 'A claim asserted as human-taught but backed by a nonexistent episode file.',
            episodes: [{ path: fabricatedPath, sha256: fabricatedSha, kind: 'human-teaching', plan: null }],
          },
        ],
      })
    );
    const fabricated = applyOps({ workspace: ws, opsPath: fabOpsPath, home });
    const learningFabricated = listLearnings(dir).find((l) => l.id === fabId);

    // (c) Promote the remembered learning to an existing repo file.
    const primitiveRel = 'src/PaymentRetryPolicy.md';
    fs.mkdirSync(path.join(ws, 'src'), { recursive: true });
    fs.writeFileSync(path.join(ws, primitiveRel), '# Payment retry policy\n\nCanonical retry/backoff rules.\n', 'utf8');
    const promoted = setLearningStatus({ workspace: ws, id: learningId, action: 'promote', to: primitiveRel, home });
    const learningAfterPromote = listLearnings(dir).find((l) => l.id === learningId);

    // Promoted learnings must never surface in retrieval.
    const rankedAfterPromote = rankLearnings({ workspace: ws, query: TRIGGER, limit: 10, home });

    // A subsequent in-place SUPERSEDE on the promoted id — even with a
    // genuinely fresh, verified human-teaching episode — must be rejected
    // unconditionally (no re-teach exemption for a promoted target).
    const freshDir = path.join(ws, 'docs', 'solutions', 'teachings');
    fs.mkdirSync(freshDir, { recursive: true });
    const freshText = [
      '---',
      'title: "Fresh reteach attempt"',
      'kind: human-teaching',
      `date: ${new Date().toISOString().slice(0, 10)}`,
      `trigger: "${TRIGGER}"`,
      '---',
      '',
      'A brand new, correctly verified human-teaching episode.',
      '',
    ].join('\n');
    const freshRel = 'docs/solutions/teachings/fresh-reteach.md';
    fs.writeFileSync(path.join(ws, freshRel), freshText, 'utf8');
    const freshSha = crypto.createHash('sha256').update(freshText).digest('hex');
    const supersedeOpsPath = path.join(ws, 'ops-supersede.json');
    fs.writeFileSync(
      supersedeOpsPath,
      JSON.stringify({
        schema: 1,
        ops: [
          {
            op: 'SUPERSEDE',
            target: learningId,
            domain: DOMAIN,
            slug: TRIGGER,
            trigger: TRIGGER,
            body: 'A revised retry policy claim.',
            episodes: [{ path: freshRel, sha256: freshSha, kind: 'human-teaching', plan: null }],
          },
        ],
      })
    );
    const supersedeAttempt = applyOps({ workspace: ws, opsPath: supersedeOpsPath, home });

    return {
      learningId,
      rememberedPass: remembered.pass,
      learningAfterRememberSource: learningAfterRemember ? learningAfterRemember.fm.source : null,
      learningAfterRememberStatus: learningAfterRemember ? learningAfterRemember.fm.status : null,
      fabricatedExitCode: fabricated.exitCode,
      learningFabricatedSource: learningFabricated ? learningFabricated.fm.source : null,
      learningFabricatedStatus: learningFabricated ? learningFabricated.fm.status : null,
      promotedPass: promoted.pass,
      learningAfterPromoteTo: learningAfterPromote ? learningAfterPromote.fm.promoted_to : null,
      rankedIds: rankedAfterPromote.map((r) => r.id),
      supersedeExitCode: supersedeAttempt.exitCode,
      supersedeRejectedCode: supersedeAttempt.rejected?.[0]?.code || null,
      supersedeRejectedReason: supersedeAttempt.rejected?.[0]?.reason || '',
    };
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
}

const CHECKS = ['rememberHuman', 'fabricationDemoted', 'promotedExcluded', 'promotedProtected'];

function evaluateChecks(result) {
  return {
    rememberHuman: result.rememberedPass === true && result.learningAfterRememberSource === 'human' && result.learningAfterRememberStatus === 'active',
    fabricationDemoted: result.fabricatedExitCode === 0 && result.learningFabricatedSource === 'auto' && result.learningFabricatedStatus === 'provisional',
    promotedExcluded: result.promotedPass === true && !!result.learningAfterPromoteTo && !result.rankedIds.includes(result.learningId),
    promotedProtected:
      result.supersedeExitCode !== 0 && result.supersedeRejectedCode === 'E_TARGET' && /promoted/.test(result.supersedeRejectedReason),
  };
}

export async function grade(result) {
  const checks = evaluateChecks(result);
  const failed = CHECKS.filter((k) => checks[k] !== true);
  return {
    verdict: failed.length === 0 ? 'pass' : 'fail',
    reason:
      failed.length === 0
        ? 'remember landed human/active, the fabricated human-teaching claim was demoted to auto/provisional, and the promoted learning was excluded from retrieval and protected from SUPERSEDE'
        : `failed checks: ${failed.join(', ')}`,
    evidence: { result, checks },
  };
}

// Verifier fixtures: pre-shaped result objects whose derived checks pass/fail
// per evaluateChecks above — matches the runner contract (evals/lib/runner.mjs:53).
export const fixtures = {
  pass: {
    learningId: 'payments/payment-retry-backoff-policy',
    rememberedPass: true,
    learningAfterRememberSource: 'human',
    learningAfterRememberStatus: 'active',
    fabricatedExitCode: 0,
    learningFabricatedSource: 'auto',
    learningFabricatedStatus: 'provisional',
    promotedPass: true,
    learningAfterPromoteTo: 'src/PaymentRetryPolicy.md',
    rankedIds: [],
    supersedeExitCode: 1,
    supersedeRejectedCode: 'E_TARGET',
    supersedeRejectedReason: 'op 0: target payments/payment-retry-backoff-policy is promoted — behavior supersedes knowledge; update the primitive (src/PaymentRetryPolicy.md) or choose a new slug',
  },
  fail: {
    learningId: 'payments/payment-retry-backoff-policy',
    rememberedPass: true,
    learningAfterRememberSource: 'human',
    learningAfterRememberStatus: 'active',
    fabricatedExitCode: 0,
    learningFabricatedSource: 'human',
    learningFabricatedStatus: 'active',
    promotedPass: true,
    learningAfterPromoteTo: 'src/PaymentRetryPolicy.md',
    rankedIds: ['payments/payment-retry-backoff-policy'],
    supersedeExitCode: 0,
    supersedeRejectedCode: null,
    supersedeRejectedReason: '',
  },
};
