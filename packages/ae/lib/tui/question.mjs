/**
 * Structured multi-choice question checkpoint (Grok Build–style).
 * Unanswered → inconclusive with reason; never silent success.
 */

import { newBlockId } from './block.mjs';

/**
 * @param {{
 *   prompt: string,
 *   choices: Array<string|{ id?: string, label: string }>,
 *   id?: string,
 *   scope?: string,
 * }} opts
 */
export function createQuestion({ prompt, choices = [], id = null, scope = 'session' } = {}) {
  const normalized = choices.map((c, i) => {
    if (typeof c === 'string') return { id: String(i + 1), label: c };
    return { id: String(c.id ?? i + 1), label: String(c.label ?? c.id ?? i + 1) };
  });
  return {
    id: id || newBlockId(),
    prompt: String(prompt ?? '').trim() || 'Choose an option',
    choices: normalized,
    scope,
    status: 'open',
    selected: null,
    reason: null,
  };
}

/**
 * @param {ReturnType<typeof createQuestion>} question
 * @param {string} answer raw user input (number, id, or label prefix)
 */
export function answerQuestion(question, answer) {
  if (!question || question.status !== 'open') {
    return { ok: false, question, reason: 'no open question' };
  }
  const raw = String(answer ?? '').trim();
  if (!raw) {
    return { ok: false, question, reason: 'empty answer' };
  }
  if (/^(esc|cancel|quit|skip)$/i.test(raw)) {
    const q = {
      ...question,
      status: 'inconclusive',
      selected: null,
      reason: 'gate unanswered',
    };
    return { ok: true, question: q, inconclusive: true };
  }

  const byId = question.choices.find((c) => c.id === raw || c.id === String(Number(raw)));
  if (byId) {
    const q = { ...question, status: 'answered', selected: byId, reason: null };
    return { ok: true, question: q, inconclusive: false };
  }
  const lower = raw.toLowerCase();
  const byLabel = question.choices.find((c) => c.label.toLowerCase() === lower
    || c.label.toLowerCase().startsWith(lower));
  if (byLabel) {
    const q = { ...question, status: 'answered', selected: byLabel, reason: null };
    return { ok: true, question: q, inconclusive: false };
  }
  return { ok: false, question, reason: `not a choice: ${raw}` };
}

/**
 * Ledger-friendly lines for display.
 * @param {ReturnType<typeof createQuestion>} question
 */
export function questionLines(question) {
  if (!question) return [];
  const lines = [`GATE QUESTION: ${question.prompt}`];
  for (const c of question.choices) {
    lines.push(`  [${c.id}] ${c.label}`);
  }
  lines.push('  Enter number · esc/skip → inconclusive');
  return lines;
}

/**
 * Event payload for journal / ledger (additive).
 * @param {ReturnType<typeof createQuestion>} question
 */
export function questionEvent(question) {
  if (!question) return null;
  return {
    type: 'tui.question',
    id: question.id,
    prompt: question.prompt,
    status: question.status,
    selected: question.selected,
    reason: question.reason,
    scope: question.scope,
  };
}
