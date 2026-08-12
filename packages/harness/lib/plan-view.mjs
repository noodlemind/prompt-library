import { estimateTokens } from './token-meter.mjs';

const DEFAULT_MAX_TOKENS = 220;

function currentPhaseTasks(planSection, phase) {
  if (!planSection) return { heading: null, openTasks: [] };
  const lines = planSection.split(/\r?\n/);
  const headings = [];
  lines.forEach((line, index) => {
    const heading = line.match(/^###\s+(.*\bPhase\s+(\d+)\b.*)$/i);
    if (heading) headings.push({ index, title: heading[1].trim(), phase: Number(heading[2]) });
  });
  if (headings.length === 0) {
    const openTasks = [...planSection.matchAll(/^-\s*\[ \]\s+(.+)$/gm)].map((m) => m[1].trim());
    return { heading: null, openTasks };
  }
  const match = headings.find((h) => h.phase === Number(phase));
  // No heading matches the current phase — do not show another phase's tasks.
  if (!match) return { heading: null, openTasks: [] };
  const start = match.index;
  const nextHeading = headings.find((h) => h.index > start);
  const body = lines.slice(start + 1, nextHeading ? nextHeading.index : lines.length).join('\n');
  const openTasks = [...body.matchAll(/^-\s*\[ \]\s+(.+)$/gm)].map((m) => m[1].trim());
  return { heading: match.title, openTasks };
}

/** Latest dated entry from ## Review Findings (or the whole short section). */
function latestReviewFinding(findingsSection) {
  if (!findingsSection) return '';
  const entries = findingsSection.split(/\n(?=###\s)/).map((s) => s.trim()).filter(Boolean);
  const latest = entries.length ? entries[entries.length - 1] : findingsSection.trim();
  return latest;
}

export function buildPlanView(plan, { maxTokens = DEFAULT_MAX_TOKENS } = {}) {
  if (!plan) return null;
  const { heading, openTasks } = currentPhaseTasks(plan.sections?.plan || '', plan.phase);
  const finding = latestReviewFinding(plan.sections?.reviewFindings || '');

  const lines = [`- phase ${plan.phase}${heading ? ` — ${heading}` : ''}`];
  if (openTasks.length) {
    lines.push('- open tasks:');
    for (const task of openTasks.slice(0, 8)) lines.push(`  - ${task}`);
    if (openTasks.length > 8) lines.push(`  - …(+${openTasks.length - 8} more; read the plan Plan section)`);
  } else {
    lines.push('- open tasks: none in current phase');
  }
  if (finding) {
    const firstLine = finding.split(/\r?\n/).find((l) => l.trim()) || '';
    lines.push(`- latest review: ${firstLine.replace(/^#+\s*/, '').slice(0, 140)}`);
  }

  let body = lines.join('\n');
    while (estimateTokens(body) > maxTokens && lines.length > 1) {
    lines.pop();
    body = [...lines, '  …(plan view truncated to budget)'].join('\n');
  }
  // A single oversized line still needs a hard character cap to stay in budget.
  if (estimateTokens(body) > maxTokens) {
    body = body.slice(0, Math.max(0, maxTokens * 4 - 3)) + '…';
  }
  return {
    phase: plan.phase,
    heading,
    openTasks,
    latestFinding: finding ? finding.slice(0, 400) : '',
    body,
    tokens: estimateTokens(body),
  };
}
