import { tokenize } from './tokenize.mjs';
import { rankLearnings } from './knowledge/retrieve.mjs';
import { reviewHash } from './review-preparation.mjs';

function text(value) {
  if (value == null) return '';
  return String(value);
}

function blank(value) {
  return text(value).trim() === '';
}

function tokenOverlap(left, right) {
  const rightTokens = new Set(tokenize(right));
  let count = 0;
  for (const token of tokenize(left)) {
    if (rightTokens.has(token)) count += 1;
  }
  return count;
}

export function judgeRepeat({ testsPassed, delivered, rejected, applies, doesNotApply } = {}) {
  if (blank(delivered) || blank(rejected)) return { ok: false, reason: 'missing' };
  if (testsPassed !== true) return { ok: false, reason: 'tests-failed' };

  const outside = tokenOverlap(delivered, doesNotApply);
  const inside = tokenOverlap(delivered, applies);
  if (outside > 0 && outside >= inside) return { ok: true, reason: 'out-of-scope' };

  const rejectedTokens = tokenize(rejected);
  const deliveredTokens = new Set(tokenize(delivered));
  const repeated = rejectedTokens.length > 0 && rejectedTokens.every((token) => deliveredTokens.has(token));
  if (!blank(applies) && repeated) return { ok: false, reason: 'repeated-mistake' };
  return { ok: true, reason: 'clear' };
}

function addedDiffText(diff) {
  return String(diff || '')
    .split('\n')
    .filter((line) => line.startsWith('+') && !line.startsWith('+++ '))
    .map((line) => line.slice(1))
    .join('\n');
}

function showsLiterally(shows, added) {
  if (/^[A-Za-z0-9_]+$/.test(shows)) {
    return new RegExp(`(?<![A-Za-z0-9_])${shows}(?![A-Za-z0-9_])`).test(added);
  }
  return added.includes(shows);
}

export function repeatEvidenceFromServed({ workspace, home, session, delivered }) {
  let served = [];
  try {
    const files = Array.isArray(session?.files) ? session.files : [];
    served = rankLearnings({
      workspace,
      query: session?.lastQuery || '',
      home,
      ...(files.length ? { signals: files } : {}),
    });
  } catch {
    return [];
  }
  const added = addedDiffText(delivered);
  return served.flatMap((learning) => {
    const shows = learning.authority === 'correction' ? text(learning.shows) : '';
    const verdict = judgeRepeat({
      testsPassed: true,
      delivered: added,
      rejected: shows,
      applies: learning.applies,
      doesNotApply: learning.does_not_apply,
    });
    const method = verdict.reason === 'repeated-mistake' ? 'token-containment' : verdict.reason === 'clear' && !blank(learning.applies) && tokenize(shows).length === 0 && showsLiterally(shows, added) ? 'literal-containment' : null;
    if (!method) return [];
    const claim = { learning: learning.id, shows, applies: learning.applies, doesNotApply: learning.does_not_apply };
    return [{ identity: reviewHash(claim), ...claim, method, applicability: 'heuristic; agent must assess scope' }];
  });
}

export function repeatedFromServed(options) {
  return repeatEvidenceFromServed(options).length > 0;
}
