import { tokenize } from '../../../packages/harness/lib/tokenize.mjs';

// Capability: retrieval is stable under phrasing. Several different phrasings of
// the same intent must all rank the on-target document above an unrelated one —
// deterministically, with no model in the loop. This guards the exact
// non-determinism risk in the design: the LLM (and the user) never phrase a
// request identically twice.
export const meta = {
  id: 'retrieval-phrasing-stability',
  capability: 'Lexical retrieval ranks the target above noise across phrasings',
  kind: 'deterministic',
  runtime: 'active',
  success: 'every phrasing scores the target doc above the unrelated doc',
};

// Overlap of a query against a doc, using the shared normalized tokenizer.
function overlap(query, docTokens) {
  const q = new Set(tokenize(query));
  let hits = 0;
  for (const t of q) if (docTokens.has(t)) hits += 1;
  return hits;
}

export async function run() {
  const target = new Set(
    tokenize('PaymentController parses the override header and checks the SYSTEM-OVERRIDE role on the request token')
  );
  const distractor = new Set(
    tokenize('NotificationRetryHandler deduplicates SQS notifications and marks them processed')
  );
  const phrasings = [
    'add an override flag header to the payment endpoint with SYSTEM-OVERRIDE role',
    'support SYSTEM_OVERRIDE on payments via a new request header',
    'the payment controller should accept a systemOverride token role',
    'let payment requests carry an override header for the system override role',
    'fix payments to read an override header and verify the SYSTEM-OVERRIDE authority',
  ];
  const results = phrasings.map((p) => ({
    phrasing: p,
    target: overlap(p, target),
    distractor: overlap(p, distractor),
  }));
  return {
    allTargetWins: results.every((r) => r.target > r.distractor),
    minMargin: Math.min(...results.map((r) => r.target - r.distractor)),
    results,
  };
}

export async function grade(result) {
  return {
    verdict: result.allTargetWins && result.minMargin >= 1 ? 'pass' : 'fail',
    reason: result.allTargetWins
      ? `every phrasing ranked the target above noise (min margin ${result.minMargin})`
      : 'a phrasing failed to rank the target above the unrelated doc',
    evidence: { minMargin: result.minMargin, phrasings: result.results.length },
  };
}

export const fixtures = {
  pass: { allTargetWins: true, minMargin: 2, results: [] },
  fail: { allTargetWins: false, minMargin: -1, results: [] },
};
