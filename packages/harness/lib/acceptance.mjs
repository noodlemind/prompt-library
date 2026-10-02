const STAGES = new Set(['discovery', 'context', 'implementation', 'review']);

function hasText(value) {
  return typeof value === 'string' && value !== '';
}

const FIELD_OK = {
  task: hasText,
  rejected: hasText,
  accepted: hasText,
  why: hasText,
  stage: (value) => STAGES.has(value),
};

const REQUIRED_FIELDS = Object.keys(FIELD_OK);

export function validateCase(entry) {
  const record = entry != null && typeof entry === 'object' ? entry : {};
  const missing = REQUIRED_FIELDS.filter((field) => !Object.hasOwn(record, field) || !FIELD_OK[field](record[field]));
  if (missing.length === 0) return { ok: true };
  return { ok: false, missing };
}

export function runCases(cases) {
  const list = Array.isArray(cases) ? cases : [];
  return list.map(validateCase);
}
