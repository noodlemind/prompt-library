import { createHash } from 'node:crypto';
import { extract as lexicalExtract } from './lexical-extractor.mjs';
import { readSourceFile } from './scan.mjs';

export const FILE_FACTS_VERSION = 2;

export function contentHash(content) {
  return createHash('sha256').update(content).digest('hex');
}

export function readSourceHashes(workspace, rels) {
  return new Map(rels.map(rel => {
    const content = readSourceFile(workspace, rel);
    return [rel, content === null ? null : contentHash(content)];
  }));
}

export function readFileFacts(workspace, rels, { extract = lexicalExtract, cachedFiles = null } = {}) {
  const facts = new Map();
  let reused = 0;
  for (const rel of rels) {
    const content = readSourceFile(workspace, rel);
    const hash = content === null ? null : contentHash(content);
    const cached = cachedFiles?.[rel];
    const strings = value => Array.isArray(value) && value.every(item => typeof item === 'string');
    const reusable = content !== null && cached && strings(cached.symbols) && strings(cached.imports) && cached.hash === hash;
    const extracted = content === null ? {} : reusable ? cached : extract(rel, content);
    if (reusable) reused += 1;
    facts.set(rel, {
      rel,
      hash,
      symbols: Array.isArray(extracted.symbols) ? extracted.symbols : [],
      imports: Array.isArray(extracted.imports) ? extracted.imports : [],
      defs: Array.isArray(extracted.defs) ? extracted.defs : [],
      refs: Array.isArray(extracted.refs) ? extracted.refs : [],
      complexity: Number.isFinite(extracted.complexity) ? extracted.complexity : 1,
      tier: content === null ? 'unreadable' : extracted.tier === 'treesitter' ? 'treesitter' : 'lexical',
      errors: Boolean(extracted.errors || extracted.hasErrors),
      limitsReached: extracted.limitsReached || {},
      coverageUnknown: Boolean(reusable && !cached.limitsReached),
    });
  }
  return { facts, reused };
}
