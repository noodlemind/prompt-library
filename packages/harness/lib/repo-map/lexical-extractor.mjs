// Lexical symbol/import extractor — the default tier behind the repo-map's
// extractor seam. Deterministic, dependency-free regex per language. A
// tree-sitter tier (AC62) can implement the same `extract` shape later for
// languages where precision is worth the dependency (Java/Python/TS/JS);
// SQL and HCL stay lexical because their grammars add little here.

import path from 'node:path';

const IMPORT_PATTERNS = [
  /^\s*import\s+(?:static\s+)?([\w.]+)/gm, // java
  /^\s*import\s+[\s\S]*?\bfrom\s+['"]([^'"]+)['"]/gm, // js/ts
  /\brequire\(\s*['"]([^'"]+)['"]\s*\)/g, // js/ts require
  /^\s*from\s+([\w.]+)\s+import\b/gm, // python from-import
  /^\s*import\s+([\w.]+)/gm, // python import
];

const SYMBOL_PATTERNS = {
  java: [
    /\b(?:public|private|protected|abstract|final|static|\s)*(?:class|interface|enum|record)\s+([A-Z]\w+)/g,
    /\b(?:public|protected|private)\s+(?:static\s+)?(?:final\s+)?[\w<>\[\],?\s]+\s+([a-z]\w+)\s*\(/g,
  ],
  py: [/^\s*(?:class|def)\s+(\w+)/gm],
  ts: [
    /\bexport\s+(?:default\s+)?(?:abstract\s+)?(?:class|interface|type|enum|function)\s+(\w+)/g,
    /\bexport\s+const\s+(\w+)/g,
    /\b(?:class|interface|function)\s+([A-Z]\w+)/g,
  ],
  sql: [/\bCREATE\s+(?:OR\s+REPLACE\s+)?(?:TABLE|VIEW|FUNCTION|PROCEDURE)\s+(?:IF\s+NOT\s+EXISTS\s+)?["`]?(\w+)/gi],
  tf: [/^\s*(resource|module|variable|output|data)\s+"([^"]+)"(?:\s+"([^"]+)")?/gm],
};

export const SOURCE_EXTENSIONS = new Set(['.java', '.py', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.sql', '.tf']);

function languageOf(rel) {
  const ext = path.extname(rel).toLowerCase();
  if (ext === '.java') return 'java';
  if (ext === '.py') return 'py';
  if (['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'].includes(ext)) return 'ts';
  if (ext === '.sql') return 'sql';
  if (ext === '.tf') return 'tf';
  return null;
}

/** extract(rel, content) -> { symbols: string[], imports: string[] } — the seam. */
export function extract(rel, content) {
  const lang = languageOf(rel);
  if (!lang) return { symbols: [], imports: [] };
  const text = String(content || '');

  const symbols = new Set();
  for (const pattern of SYMBOL_PATTERNS[lang] || []) {
    for (const m of text.matchAll(pattern)) {
      // tf uses "type" "name" — prefer the name (group 3 or 2).
      const name = m[3] || m[2] || m[1];
      if (name && !/^(if|for|while|return|new|switch|catch|get|set)$/i.test(name)) symbols.add(name);
    }
  }

  const imports = new Set();
  // Imports only apply to code languages, not SQL/HCL.
  if (lang !== 'sql' && lang !== 'tf') {
    for (const pattern of IMPORT_PATTERNS) {
      for (const m of text.matchAll(pattern)) if (m[1]) imports.add(m[1]);
    }
  }

  return { symbols: [...symbols], imports: [...imports] };
}
