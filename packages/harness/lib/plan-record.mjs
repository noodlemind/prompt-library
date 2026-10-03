function nonEmptyStrings(value) {
  return Array.isArray(value)
    && value.length > 0
    && value.every((item) => typeof item === 'string' && item.trim());
}

export function readPlanRecord(text) {
  if (typeof text !== 'string' || !text.trim()) return null;
  const line = text.split(/\r?\n/).find((entry) => entry.startsWith('{') && entry.endsWith('}'));
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

export function shortPlanDocument({ goal, acceptance, constraints }) {
  const record = readPlanRecord(JSON.stringify({ goal, acceptance, constraints }));
  if (!record) throw new Error('plan-new: --goal requires at least one --acceptance and one --constraint');
  return `---\nstatus: in-progress\nplan_lock: true\n---\n${JSON.stringify(record)}\n`;
}
