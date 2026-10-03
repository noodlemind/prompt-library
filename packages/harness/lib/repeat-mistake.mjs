import { tokenize } from './tokenize.mjs';
import { rankLearnings } from './knowledge/retrieve.mjs';

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

export function repeatedFromServed({ workspace, home, session, delivered }) {
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
    return false;
  }
  return served.some((learning) => judgeRepeat({
    testsPassed: true,
    delivered,
    rejected: learning.authority === 'correction' ? learning.shows : '',
    applies: learning.applies,
    doesNotApply: learning.does_not_apply,
  }).reason === 'repeated-mistake');
}
