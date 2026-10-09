import YAML from 'yaml';

function nonEmptyStrings(value) {
  return Array.isArray(value)
    && value.length > 0
    && value.every((item) => typeof item === 'string' && item.trim());
}

export function readPlanRecord(text) {
  if (typeof text !== 'string' || !text.trim()) return null;
  // A short record starts the document body. JSON examples inside full plans
  // are authored content, never an alternative schema selector.
  const body = text.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, '').trimStart();
  const line = body.split(/\r?\n/)[0];
  if (!line.startsWith('{') || !line.endsWith('}')) return null;
  if (!line) return null;
  let value;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (typeof value.goal !== 'string' || !value.goal.trim()) return null;
  if (!nonEmptyStrings(value.acceptance) || !nonEmptyStrings(value.constraints)) return null;
  return {
    goal: value.goal,
    acceptance: value.acceptance.slice(),
    constraints: value.constraints.slice(),
  };
}

export function shortPlanDocument({ goal, acceptance, constraints, check = null, intentSources = [], scope = [], status = null }) {
  const record = readPlanRecord(JSON.stringify({ goal, acceptance, constraints }));
  if (!record) throw new Error('plan-new: --goal requires at least one --acceptance and one --constraint');
  const ids = acceptance.map((_, i) => `AC${i + 1}`);
  const fm = {
    plan_format: 'short-v2',
    intent_source_policy: 'content-v1',
    intent_sources: intentSources,
    status: status || (check ? 'in-progress' : 'open'),
    plan_lock: Boolean(check) && !['open', 'needs-info'].includes(status),
    acceptance_ids: ids,
    acceptance_text: Object.fromEntries(ids.map((id, i) => [id, acceptance[i]])),
    verification: { required: check ? [check] : [], criteria: Object.fromEntries(ids.map(id => [id, check ? [check] : []])) },
    reviews: { required: ['code-review'], completed: [], critical_open: [] },
  };
  return `---\n${YAML.stringify(fm)}---\n${JSON.stringify(record)}\n${scope.length ? `\n## Impacted Files\n\n${scope.map(file => `- \`${file}\``).join('\n')}\n` : ''}`;
}
