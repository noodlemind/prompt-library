// Lexical symbol/import extractor — the default tier behind the repo-map's
// extractor seam. Deterministic, dependency-free regex per language. A
// tree-sitter tier (AC62) can implement the same `extract` shape later for
// languages where precision is worth the dependency (Java/Python/TS/JS);
// SQL and HCL stay lexical because their grammars add little here.
//
// EXPORT SURFACE: the result carries `exported` — the subset of `symbols` this
// file publishes to other modules. It is what makes the structural checks
// (removed-symbol-with-callers, unplanned-symbol-change) meaningful in the
// DEFAULT tier: grammars are optional, so without lexical export detection
// nothing is ever marked exported and those checks can never fire. Detection
// is deliberately conservative — an export marker that names an identifier the
// file also declares. Per language:
//   js/ts  `export`ed declarations (function/class/const/let/var/type/
//          interface/enum, incl. `export default`), `export { a, b as c }`
//          lists and re-exports, `export * as ns from`, and the CommonJS
//          `module.exports.x = ` / `exports.x = ` / `module.exports = { x }`.
//   py     Python has no export keyword. CONVENTION: an explicit `__all__`
//          list is authoritative when present; otherwise every module-level
//          (column-0) `class`/`def` whose name does not start with `_` — the
//          same approximation the tree-sitter tier applies, so both tiers
//          agree on what "exported" means.
//   java   `public` types, methods, and fields.
//   sql/tf no module boundary, so nothing is reported as exported.
//
// REFERENCE SURFACE: the result also carries `references` — the names this
// file EXPLICITLY imports by name from another module. Those are facts the
// source states outright, not guessed call sites (the lexical tier still never
// infers a call from a bare identifier), and they are what lets the caller-side
// structural checks work in the default tier: without them a lexical index has
// no edges at all, so "removed symbol still has callers" could never fire
// outside an AST install.
//
// BOUNDED: `symbols`, `imports`, and `references` are capped here (not just in
// consumers) so one hostile or generated file cannot balloon files.json — and
// so the baseline side and the current side of a structural diff cap
// identically.

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

const EXPORT_PATTERNS = {
  ts: [
    // export [default] [declare] [async] [abstract] <decl> <name>
    /\bexport\s+(?:default\s+)?(?:declare\s+)?(?:async\s+)?(?:abstract\s+)?(?:class|interface|type|enum|function\s*\*?|const|let|var)\s+(\w+)/g,
    /\bexport\s+default\s+(\w+)\s*[;\n]/g, // export default Existing;
    /\bexport\s+\*\s+as\s+(\w+)\s+from\b/g,
    /\b(?:module\.)?exports\.(\w+)\s*=/g, // CommonJS named export
  ],
  java: [
    /\bpublic\s+(?:static\s+|final\s+|abstract\s+|sealed\s+|strictfp\s+)*(?:class|interface|enum|record)\s+(\w+)/g,
    /\bpublic\s+(?:static\s+|final\s+|synchronized\s+|native\s+|abstract\s+|default\s+)*[\w<>\[\],?.]+(?:\s*\[\])?\s+(\w+)\s*\(/g,
    /\bpublic\s+(?:static\s+|final\s+|volatile\s+|transient\s+)*[\w<>\[\],?.]+(?:\s*\[\])?\s+(\w+)\s*[=;]/g,
  ],
};

// `export { a, b as c }` (including `... } from './x'`) and
// `module.exports = { a, b: local }` — both need the brace body split apart.
const TS_EXPORT_LIST = /\bexport\s*\{([^}]*)\}/g;
const TS_MODULE_EXPORTS_OBJECT = /\bmodule\.exports\s*=\s*\{([^}]*)\}/g;

const PY_ALL = /^__all__\s*(?::[^=\n]*)?=\s*[[(]([\s\S]*?)[)\]]/m;
const PY_MODULE_LEVEL_DEF = /^(?:async\s+)?(?:class|def)\s+(\w+)/gm;

// Named-import clauses: the bindings a file states it takes from elsewhere.
const TS_IMPORT_CLAUSE = /\bimport\s+([^;'"]+?)\s+from\s*['"][^'"]+['"]/g;
const TS_REQUIRE_DESTRUCTURE = /\b(?:const|let|var)\s*\{([^}]*)\}\s*=\s*require\(/g;
const PY_FROM_IMPORT = /^\s*from\s+[\w.]+\s+import\s+([^\n#]+)/gm;
const JAVA_IMPORT = /^\s*import\s+(?:static\s+)?([\w.]+)\s*;/gm;

// Names a keyword-shaped regex capture must never contribute.
const NOT_A_SYMBOL = /^(?:if|for|while|return|new|switch|catch|get|set)$/i;
const NOT_AN_EXPORT = /^(?:default|function|class|const|let|var|async|await|from|as|new|return|void|null|undefined|true|false)$/;

/** One bound per file for BOTH tiers: the caps the treesitter tier applies to
 * its own output, applied to the lexical output too (blueprint P3 bounded
 * tables). Exported so consumers can pin the same numbers. */
export const MAX_LEXICAL_SYMBOLS = 512;
export const MAX_LEXICAL_IMPORTS = 256;

export const SOURCE_EXTENSIONS = new Set([
  '.java',
  '.py',
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.sql',
  '.tf',
]);

function languageOf(rel) {
  const ext = path.extname(rel).toLowerCase();
  if (ext === '.java') return 'java';
  if (ext === '.py') return 'py';
  if (['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'].includes(ext)) return 'ts';
  if (ext === '.sql') return 'sql';
  if (ext === '.tf') return 'tf';
  return null;
}

/** `a, b as c, default as d` → the names OTHER modules can import (`b as c`
 * publishes `c`). A bare `default` is the default slot, not a named export. */
function exportListNames(body, into) {
  for (const raw of String(body).split(',')) {
    const item = raw.replace(/\/\*[\s\S]*?\*\//g, '').trim();
    if (!item) continue;
    const m = /^(?:type\s+)?([\w$]+)(?:\s+as\s+([\w$]+))?$/.exec(item);
    const name = m && (m[2] || m[1]);
    if (name && !NOT_AN_EXPORT.test(name)) into.add(name);
  }
}

/** `{ a, b: local, "c": 1 }` → the published keys. */
function objectLiteralKeys(body, into) {
  for (const raw of String(body).split(',')) {
    const item = raw.trim();
    if (!item) continue;
    const m = /^["']?([\w$]+)["']?\s*(?::|$)/.exec(item);
    if (m && !NOT_AN_EXPORT.test(m[1])) into.add(m[1]);
  }
}

function exportedNames(lang, text) {
  const exported = new Set();
  for (const pattern of EXPORT_PATTERNS[lang] || []) {
    for (const m of text.matchAll(pattern)) {
      if (m[1] && !NOT_AN_EXPORT.test(m[1])) exported.add(m[1]);
    }
  }
  if (lang === 'ts') {
    for (const m of text.matchAll(TS_EXPORT_LIST)) exportListNames(m[1], exported);
    for (const m of text.matchAll(TS_MODULE_EXPORTS_OBJECT)) objectLiteralKeys(m[1], exported);
  }
  if (lang === 'py') {
    const all = PY_ALL.exec(text);
    if (all) {
      // An explicit __all__ is the module's declared surface — authoritative.
      for (const m of all[1].matchAll(/["']([\w.]+)["']/g)) exported.add(m[1]);
    } else {
      for (const m of text.matchAll(PY_MODULE_LEVEL_DEF)) {
        if (!m[1].startsWith('_')) exported.add(m[1]);
      }
    }
  }
  return exported;
}

/**
 * Names this file imports BY NAME from another module — `import { a, b as c }`
 * (the exported name `a`/`b`, not the local alias), a default/namespace-free
 * default binding, `from mod import a`, `const { a } = require(...)`, and the
 * Java class of an `import com.acme.Role;`. Only what the source states.
 */
function importedNames(lang, text) {
  const names = new Set();
  const addList = (body, { aliasWins = false } = {}) => {
    for (const raw of String(body).split(',')) {
      const item = raw.trim();
      if (!item || item.startsWith('*')) continue;
      const m = /^([\w$]+)(?:\s+as\s+([\w$]+))?$/.exec(item);
      if (!m) continue;
      const name = aliasWins ? m[2] || m[1] : m[1];
      if (!NOT_AN_EXPORT.test(name)) names.add(name);
    }
  };
  if (lang === 'ts') {
    for (const m of text.matchAll(TS_IMPORT_CLAUSE)) {
      const clause = m[1].replace(/^type\s+/, '');
      const braces = /\{([^}]*)\}/.exec(clause);
      if (braces) addList(braces[1]);
      const bare = clause.replace(/\{[^}]*\}/g, '').replace(/\*\s+as\s+[\w$]+/g, '');
      addList(bare);
    }
    for (const m of text.matchAll(TS_REQUIRE_DESTRUCTURE)) addList(m[1]);
  } else if (lang === 'py') {
    for (const m of text.matchAll(PY_FROM_IMPORT)) addList(m[1].replace(/[()]/g, ''));
  } else if (lang === 'java') {
    for (const m of text.matchAll(JAVA_IMPORT)) {
      const last = m[1].split('.').pop();
      if (last && last !== '*') names.add(last);
    }
  }
  return names;
}

/** extract(rel, content) -> { symbols, imports, exported, references } — the seam.
 * `exported` is always a subset of `symbols`: an export marker naming an
 * identifier this file does not otherwise declare still counts (it is part of
 * the module surface), but nothing is reported as exported that is not also
 * reported as a symbol. */
export function extract(rel, content) {
  const lang = languageOf(rel);
  if (!lang) return { symbols: [], imports: [], exported: [], references: [] };
  const text = String(content || '');

  const symbols = new Set();
  for (const pattern of SYMBOL_PATTERNS[lang] || []) {
    for (const m of text.matchAll(pattern)) {
      // tf uses "type" "name" — prefer the name (group 3 or 2).
      const name = m[3] || m[2] || m[1];
      if (name && !NOT_A_SYMBOL.test(name)) symbols.add(name);
    }
  }

  // Export markers also DECLARE symbols the per-language patterns above miss
  // (`export let`, `export { helper }`, `exports.run = ...`) — the module
  // surface is exactly what the structural checks reason about.
  const exported = exportedNames(lang, text);
  for (const name of exported) symbols.add(name);

  const imports = new Set();
  // Imports only apply to code languages, not SQL/HCL.
  if (lang !== 'sql' && lang !== 'tf') {
    for (const pattern of IMPORT_PATTERNS) {
      for (const m of text.matchAll(pattern)) if (m[1]) imports.add(m[1]);
    }
  }

  const symbolList = [...symbols].slice(0, MAX_LEXICAL_SYMBOLS);
  const kept = new Set(symbolList);
  return {
    symbols: symbolList,
    imports: [...imports].slice(0, MAX_LEXICAL_IMPORTS),
    exported: [...exported].filter((name) => kept.has(name)),
    references: [...importedNames(lang, text)].slice(0, MAX_LEXICAL_IMPORTS),
  };
}
