/** Context budget constants — mirror `.github/skills/references/context-budget.md` */

export const MEMORY_CARDS_MAX_BULLETS = 15;
export const MEMORY_CARDS_MAX_CHARS = 1200;
export const MEMORY_CARDS_ORIENT_MAX_LINES = 12;
export const ACTIVITY_TAIL_MAX_LINES = 2;
export const ACTIVITY_TAIL_MAX_CHARS = 800;
export const EDIT_SCOPE_EXCERPT_MAX_CHARS = 400;
export const CONTEXT_PACK_MAX_PLANS = 2;

export function countMemoryBullets(text) {
  if (!text?.trim()) return 0;
  return text.split('\n').filter((l) => /^\s*[-*]/.test(l)).length;
}

export function validateMemoryCards(text) {
  if (!text?.trim()) {
    return { pass: true, bullets: 0, chars: 0, message: 'Memory Cards empty (ok)' };
  }
  const bullets = countMemoryBullets(text);
  const chars = text.length;
  const issues = [];
  if (bullets > MEMORY_CARDS_MAX_BULLETS) {
    issues.push(`${bullets} bullets (max ${MEMORY_CARDS_MAX_BULLETS})`);
  }
  if (chars > MEMORY_CARDS_MAX_CHARS) {
    issues.push(`${chars} chars (max ${MEMORY_CARDS_MAX_CHARS})`);
  }
  return {
    pass: issues.length === 0,
    bullets,
    chars,
    message: issues.length ? issues.join('; ') : `within budget (${bullets} bullets, ${chars} chars)`,
  };
}

export function excerptActivityTail(text) {
  if (!text?.trim()) return '';
  const blocks = text.split(/\n(?=###\s)/);
  const tail = blocks.slice(-ACTIVITY_TAIL_MAX_LINES).join('\n').trim();
  if (tail.length <= ACTIVITY_TAIL_MAX_CHARS) return tail;
  return tail.slice(-ACTIVITY_TAIL_MAX_CHARS) + '\n…(activity truncated)\n';
}

export function excerptEditScope(text) {
  if (!text?.trim()) return '';
  const t = text.trim();
  if (t.length <= EDIT_SCOPE_EXCERPT_MAX_CHARS) return t;
  return t.slice(0, EDIT_SCOPE_EXCERPT_MAX_CHARS) + '\n…';
}
