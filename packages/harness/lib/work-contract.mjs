import YAML from 'yaml';

export const WORK_CONTRACT_VERSION = 1;

function canonical(value, ancestors = new Set()) {
  if (!value || typeof value !== 'object') return [typeof value, typeof value === 'bigint' || typeof value === 'number' ? String(value) : value];
  if (ancestors.has(value)) throw new Error('Cyclic work contract YAML is unsupported');
  const next = new Set(ancestors).add(value);
  if (Array.isArray(value)) return ['array', value.map(item => canonical(item, next))];
  return ['object', Object.keys(value).sort().map(key => [key, canonical(value[key], next)])];
}

export function planContractText(text) {
  const source = String(text || '');
  const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const fm = match ? YAML.parse(match[1], { maxAliasCount: 50, intAsBigInt: true }) : {};
  if (!fm || typeof fm !== 'object' || Array.isArray(fm)) throw new Error('Invalid work contract frontmatter');
  for (const field of ['status', 'phase', 'learning', 'learning_records', 'completion_record', 'review_records']) delete fm[field];
  if (fm.intent_source_policy === 'content-v1') delete fm.progress;
  if (fm.reviews && typeof fm.reviews === 'object') delete fm.reviews.completed;
  const body = (match ? source.slice(match[0].length) : source)
    .replace(/\r\n/g, '\n')
    .replace(/\n## Activity\s*\n[\s\S]*?(?=\n## |$)/gi, '')
    .replace(/^(-\s*\[)[xX](\]\s)/gm, '$1 $2').trim();
  return JSON.stringify({ version: fm.intent_source_policy === 'content-v1' ? 2 : WORK_CONTRACT_VERSION, frontmatter: canonical(fm), body });
}
