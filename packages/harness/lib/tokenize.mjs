export function tokenize(s) {
  return String(s ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 2);
}

export const FIELD_BOOSTS = {
  symptom: 3.0,
  title: 2.5,
  tags: 2.0,
  module: 1.5,
  summary: 1.2,
  excerpt: 1.0,
};
