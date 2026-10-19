import { createHash } from 'node:crypto';
import path from 'node:path';
import { lexicalV2 } from '../repo-map/treesitter-extractor.mjs';
import { SOURCE_EXTENSIONS } from '../repo-map/lexical-extractor.mjs';
import { redactSecrets } from '../secret-scan.mjs';

export const sourceHash = value => createHash('sha256').update(value).digest('hex');

export function parseSourceReference(value) {
  const match = /^(.*)@sha256:([a-f0-9]{64})$/i.exec(String(value));
  return match ? { path: match[1], sha256: match[2].toLowerCase() } : { path: value, sha256: null };
}

export function assertSourceCurrent(expected, actual) {
  if (expected && expected !== actual) throw Object.assign(new Error('source changed; request fresh evidence before reading this reference'), { code: 'E_SOURCE_CHANGED', exit: 3 });
}

export function sourceContext(location, text, offset) {
  const lines = text.split(/\r?\n/);
  let remaining = 900;
  let omitted = 0;
  const row = line => {
    if (!line) return null;
    const value = redactSecrets(lines[line - 1]);
    const bytes = Buffer.byteLength(value);
    if (bytes > remaining || bytes > 300) { omitted++; return null; }
    remaining -= bytes;
    return { line, text: value };
  };
  const defs = SOURCE_EXTENSIONS.has(path.extname(location).toLowerCase()) ? lexicalV2(location, text).defs || [] : [];
  const declaration = defs.filter(def => def.line <= offset).sort((a, b) => b.line - a.line)[0];
  const heading = /\.md$/i.test(location) ? lines.slice(0, offset).findLastIndex(line => /^#{1,6}\s/.test(line)) + 1 : 0;
  const version = lines.slice(0, 40).findIndex(line => /^version:\s*\S/.test(line)) + 1;
  const imports = [], types = [];
  for (let index = 0; index < lines.length; index++) {
    if (/^\s*(?:import\s|from\s.*\simport\s)/.test(lines[index])) imports.push(index + 1);
    if (/^\s*(?:export\s+)?(?:interface|type|class|enum)\s/.test(lines[index])) types.push(index + 1);
  }
  return {
    method: 'lexical-candidates',
    declaration: declaration ? row(declaration.line) : null,
    heading: row(heading),
    declaredVersion: row(version),
    imports: imports.slice(0, 8).map(row).filter(Boolean),
    types: types.slice(0, 4).map(row).filter(Boolean),
    omitted: omitted + Math.max(0, imports.length - 8) + Math.max(0, types.length - 4),
  };
}
