const PAST = /\b(?:was|were|had|did|been)\b/i;
const PASSIVE = /\b(?:is|are|was|were|be|been|being)\s+\w+ed\b/;

export function checkServeSentence(text, field) {
  const value = typeof text === 'string' ? text.trim() : '';
  const count = value ? value.split(/\s+/).length : 0;
  if (count > 25) return { ok: false, blockedReason: `${field} is longer than 25 words` };
  const marks = value.match(/[.?!;]/g);
  if (marks && marks.length > 1) return { ok: false, blockedReason: `${field} must be one statement` };
  if (PAST.test(value)) return { ok: false, blockedReason: `${field} must be present tense` };
  if (PASSIVE.test(value)) return { ok: false, blockedReason: `${field} must be active voice` };
  return { ok: true, blockedReason: null };
}
