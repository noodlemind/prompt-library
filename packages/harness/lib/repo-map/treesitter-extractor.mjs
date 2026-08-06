// Tree-sitter tier (blueprint P3, D2) behind the repo-map extractor seam.
// Implements the same `extract(rel, content)` shape as the lexical extractor
// with an extended v2 result `{ symbols, imports, defs, refs, complexity }`
// (v1 `symbols`/`imports` preserved, so every existing consumer keeps
// working). Languages: TypeScript/JavaScript (+TSX), Python, Java via
// web-tree-sitter WASM grammars shipped as OPTIONAL dependencies — any other
// language, a missing grammar, a parse failure, or an init failure falls back
// silently PER FILE to the lexical extractor, so the harness works fully with
// the grammars absent.
//
// ASYNC LIFECYCLE: web-tree-sitter requires async init, and `buildRepoMap`/
// orient are (and must stay) synchronous. Resolution: parsing happens ONLY
// inside the async `harness index --structural` command path via the
// `createTreesitterExtract()` factory below; orient and every other consumer
// read the PREBUILT structural index files synchronously.
//
// GRAMMAR INTEGRITY (binding): `grammars.lock` (JSON, shipped alongside this
// module) pins a sha256 digest for every wasm — runtime and grammars. Each
// wasm's bytes are hashed BEFORE instantiation and the verified bytes
// themselves are what gets instantiated (no hash-then-reopen TOCTOU). Any
// mismatch is a LOUD lexical fallback: recorded on the factory result,
// stamped into the index meta, and surfaced by doctor S1 as a failure — never
// a warning. A merely ABSENT grammar stays a silent fallback by design.
//
// No network, no model: wasm bytes come from local disk only; parsing is pure
// computation. (The pinned no-model regex in prompt-library-contracts applies
// to the orient read path; this module honors the same discipline.)

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { extract as lexicalExtract } from './lexical-extractor.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const DEFAULT_LOCK_PATH = path.join(__dirname, 'grammars.lock');

// Bounded output: extracted names are untrusted repo text — cap identifier
// lengths and per-file counts so a crafted file cannot balloon the index.
export const MAX_IDENTIFIER_LENGTH = 160;
export const MAX_DEFS_PER_FILE = 512;
export const MAX_REFS_PER_FILE = 1024;
export const MAX_IMPORTS_PER_FILE = 256;

/** File extension → grammars.lock language key. Everything else is lexical. */
export const STRUCTURAL_LANGUAGES = {
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.ts': 'typescript',
  '.tsx': 'tsx',
  '.py': 'python',
  '.java': 'java',
};

/**
 * Cheap deterministic branch count — one language-agnostic approximation used
 * by BOTH tiers so `complexity` is comparable across parsed and fallback
 * files. Counts branch keywords and short-circuit operators, floor 1.
 */
export function branchComplexity(content) {
  const m = String(content || '').match(/\b(?:if|for|while|case|catch|elif|except|when)\b|&&|\|\||\?\?/g);
  return (m ? m.length : 0) + 1;
}

function capName(name) {
  const s = String(name || '');
  return s.length > MAX_IDENTIFIER_LENGTH ? s.slice(0, MAX_IDENTIFIER_LENGTH) : s;
}

/**
 * Lexical extraction lifted to the v2 result shape — the permanent fallback
 * tier. Each lexical symbol becomes a `kind: 'symbol'` def located at its
 * first occurrence line (an approximation, honestly labeled by the lexical
 * tier — the AST tier records real declaration sites). `refs` stay empty:
 * the lexical tier has no call facts to offer and never fabricates any.
 */
export function lexicalV2(rel, content) {
  const { symbols, imports } = lexicalExtract(rel, content);
  const lines = String(content || '').split('\n');
  const defs = symbols.slice(0, MAX_DEFS_PER_FILE).map((name) => {
    const at = lines.findIndex((l) => l.includes(name));
    return { name: capName(name), kind: 'symbol', line: at === -1 ? 0 : at + 1, exported: false };
  });
  return {
    symbols: symbols.map(capName),
    imports: imports.map(capName),
    defs,
    refs: [],
    complexity: branchComplexity(content),
    tier: 'lexical',
  };
}

/** Read and parse grammars.lock. Returns null when missing/unreadable. */
export function loadGrammarsLock({ lockPath = DEFAULT_LOCK_PATH } = {}) {
  try {
    const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    if (!lock || typeof lock !== 'object' || !lock.grammars) return null;
    // Consumers dereference lock.runtime.package/.file directly — validate the
    // runtime block here so a truncated lock reads as absent, never as a throw.
    const rt = lock.runtime;
    if (!rt || typeof rt !== 'object' || typeof rt.package !== 'string' || typeof rt.file !== 'string') return null;
    return lock;
  } catch {
    return null;
  }
}

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

/** Default roots searched for `<package>/<file>` grammar wasm files. */
function defaultGrammarRoots() {
  // The harness package's own node_modules first (optionalDependencies land
  // there), then any parent node_modules the resolver would consult.
  const pkgRoot = path.resolve(__dirname, '..', '..');
  const roots = [path.join(pkgRoot, 'node_modules')];
  let cur = path.dirname(pkgRoot);
  for (let i = 0; i < 6; i++) {
    roots.push(path.join(cur, 'node_modules'));
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return roots;
}

function findWasm(roots, pkg, file) {
  for (const root of roots) {
    const full = path.join(root, pkg, file);
    try {
      if (fs.statSync(full).isFile()) return full;
    } catch {
      // keep looking
    }
  }
  return null;
}

/**
 * Synchronous availability + integrity report — no instantiation, no async.
 * Doctor S1 uses this to check the CURRENT on-disk grammar state (an index
 * meta records what was true at build time; this records what is true now).
 * Shape: { lock, runtime: {present, ok, path?}, grammars: {lang: {present,
 * ok, version, path?}}, integrityFailures: [{language, file, reason}] }.
 */
export function grammarStatus({ grammarRoots, lockPath } = {}) {
  const lock = loadGrammarsLock({ lockPath });
  const roots = grammarRoots || defaultGrammarRoots();
  const status = { lock: Boolean(lock), runtime: { present: false, ok: false }, grammars: {}, integrityFailures: [] };
  if (!lock) return status;
  const check = (language, spec) => {
    const full = findWasm(roots, spec.package, spec.file);
    if (!full) return { present: false, ok: false, version: spec.version };
    let bytes;
    try {
      bytes = fs.readFileSync(full);
    } catch {
      return { present: false, ok: false, version: spec.version };
    }
    const ok = sha256(bytes) === spec.sha256;
    if (!ok) status.integrityFailures.push({ language, file: spec.file, reason: 'sha256 mismatch vs grammars.lock' });
    return { present: true, ok, version: spec.version, path: full };
  };
  status.runtime = check('runtime', lock.runtime);
  for (const [language, spec] of Object.entries(lock.grammars)) {
    status.grammars[language] = check(language, spec);
  }
  return status;
}

// ---------------------------------------------------------------------------
// Per-language AST walking tables. Node types are stable tree-sitter grammar
// facts for the pinned versions in grammars.lock.
// ---------------------------------------------------------------------------

const JS_DEF_TYPES = [
  'function_declaration',
  'generator_function_declaration',
  'class_declaration',
  'abstract_class_declaration',
  'method_definition',
  'interface_declaration',
  'type_alias_declaration',
  'enum_declaration',
  'variable_declarator',
];

function hasAncestorOfType(node, type, maxUp = 4) {
  let cur = node.parent;
  for (let i = 0; i < maxUp && cur; i++) {
    if (cur.type === type) return true;
    cur = cur.parent;
  }
  return false;
}

function defKind(type) {
  if (type.includes('class')) return 'class';
  if (type.includes('interface')) return 'interface';
  if (type.includes('enum')) return 'enum';
  if (type.includes('type_alias')) return 'type';
  if (type.includes('method') || type === 'constructor_declaration') return 'method';
  if (type.includes('record')) return 'record';
  if (type === 'variable_declarator') return 'const';
  if (type === 'annotation_type_declaration') return 'annotation';
  return 'function';
}

function walkJs(root) {
  const defs = [];
  for (const node of root.descendantsOfType(JS_DEF_TYPES)) {
    if (defs.length >= MAX_DEFS_PER_FILE) break;
    const nameNode = node.childForFieldName('name');
    if (!nameNode) continue;
    if (node.type === 'variable_declarator') {
      const value = node.childForFieldName('value');
      const fnValue = value && (value.type === 'arrow_function' || value.type === 'function_expression' || value.type === 'generator_function');
      const exported = hasAncestorOfType(node, 'export_statement');
      if (!fnValue && !exported) continue;
      defs.push({ name: nameNode.text, kind: fnValue ? 'function' : 'const', line: node.startPosition.row + 1, exported });
      continue;
    }
    defs.push({
      name: nameNode.text,
      kind: defKind(node.type),
      line: node.startPosition.row + 1,
      exported: hasAncestorOfType(node, 'export_statement'),
    });
  }
  const imports = [];
  for (const node of root.descendantsOfType(['import_statement', 'export_statement'])) {
    if (imports.length >= MAX_IMPORTS_PER_FILE) break;
    const source = node.childForFieldName('source');
    if (source) imports.push(source.text.replace(/^['"`]|['"`]$/g, ''));
  }
  const refs = [];
  for (const node of root.descendantsOfType(['call_expression', 'new_expression'])) {
    if (refs.length >= MAX_REFS_PER_FILE) break;
    const target = node.childForFieldName(node.type === 'new_expression' ? 'constructor' : 'function');
    if (!target) continue;
    if (target.type === 'identifier') {
      if (target.text === 'require') {
        const args = node.childForFieldName('arguments');
        const arg = args?.namedChildren?.[0];
        if (arg && arg.type === 'string' && imports.length < MAX_IMPORTS_PER_FILE) {
          imports.push(arg.text.replace(/^['"`]|['"`]$/g, ''));
        }
        continue;
      }
      refs.push({ name: target.text, line: node.startPosition.row + 1 });
    } else if (target.type === 'member_expression') {
      const prop = target.childForFieldName('property');
      if (prop) refs.push({ name: prop.text, line: node.startPosition.row + 1 });
    }
  }
  return { defs, imports, refs };
}

function walkPython(root) {
  const defs = [];
  for (const node of root.descendantsOfType(['class_definition', 'function_definition'])) {
    if (defs.length >= MAX_DEFS_PER_FILE) break;
    const nameNode = node.childForFieldName('name');
    if (!nameNode) continue;
    // "Exported" approximation: module-level and not underscore-private.
    const parent = node.parent?.type === 'decorated_definition' ? node.parent : node;
    const topLevel = parent.parent?.type === 'module';
    defs.push({
      name: nameNode.text,
      kind: node.type === 'class_definition' ? 'class' : 'function',
      line: node.startPosition.row + 1,
      exported: topLevel && !nameNode.text.startsWith('_'),
    });
  }
  const imports = [];
  for (const node of root.descendantsOfType(['import_from_statement', 'import_statement'])) {
    if (imports.length >= MAX_IMPORTS_PER_FILE) break;
    if (node.type === 'import_from_statement') {
      const mod = node.childForFieldName('module_name');
      if (mod) imports.push(mod.text);
    } else {
      for (const name of node.namedChildren) {
        if (name.type === 'dotted_name' || name.type === 'aliased_import') {
          imports.push(name.type === 'aliased_import' ? name.childForFieldName('name')?.text || name.text : name.text);
        }
      }
    }
  }
  const refs = [];
  for (const node of root.descendantsOfType('call')) {
    if (refs.length >= MAX_REFS_PER_FILE) break;
    const fn = node.childForFieldName('function');
    if (!fn) continue;
    if (fn.type === 'identifier') refs.push({ name: fn.text, line: node.startPosition.row + 1 });
    else if (fn.type === 'attribute') {
      const attr = fn.childForFieldName('attribute');
      if (attr) refs.push({ name: attr.text, line: node.startPosition.row + 1 });
    }
  }
  return { defs, imports, refs };
}

const JAVA_DEF_TYPES = [
  'class_declaration',
  'interface_declaration',
  'enum_declaration',
  'record_declaration',
  'annotation_type_declaration',
  'method_declaration',
  'constructor_declaration',
];

function walkJava(root) {
  const defs = [];
  for (const node of root.descendantsOfType(JAVA_DEF_TYPES)) {
    if (defs.length >= MAX_DEFS_PER_FILE) break;
    const nameNode = node.childForFieldName('name');
    if (!nameNode) continue;
    const modifiers = node.namedChildren.find((c) => c.type === 'modifiers');
    defs.push({
      name: nameNode.text,
      kind: defKind(node.type),
      line: node.startPosition.row + 1,
      exported: Boolean(modifiers && /\bpublic\b/.test(modifiers.text)),
    });
  }
  const imports = [];
  for (const node of root.descendantsOfType('import_declaration')) {
    if (imports.length >= MAX_IMPORTS_PER_FILE) break;
    imports.push(node.text.replace(/^import\s+(static\s+)?/, '').replace(/;?\s*$/, ''));
  }
  const refs = [];
  for (const node of root.descendantsOfType(['method_invocation', 'object_creation_expression'])) {
    if (refs.length >= MAX_REFS_PER_FILE) break;
    const target = node.childForFieldName(node.type === 'method_invocation' ? 'name' : 'type');
    if (target) refs.push({ name: target.text, line: node.startPosition.row + 1 });
  }
  return { defs, imports, refs };
}

const WALKERS = {
  javascript: walkJs,
  typescript: walkJs,
  tsx: walkJs,
  python: walkPython,
  java: walkJava,
};

function capResult(walked) {
  const defs = walked.defs.slice(0, MAX_DEFS_PER_FILE).map((d) => ({ ...d, name: capName(d.name) }));
  const imports = [...new Set(walked.imports.map(capName))].slice(0, MAX_IMPORTS_PER_FILE);
  const refs = walked.refs.slice(0, MAX_REFS_PER_FILE).map((r) => ({ ...r, name: capName(r.name) }));
  const symbols = [...new Set(defs.map((d) => d.name))];
  return { symbols, imports, defs, refs };
}

/**
 * Build a v2 `extract(rel, content)` from an injectable `parseForLanguage`
 * seam — exported so tests can prove the per-file fallback discipline
 * (parse throw → lexical) without any grammar installed. `parseForLanguage
 * (language, content)` returns a tree with `.rootNode` or throws; a null
 * return means "no parser for this language" (silent lexical fallback).
 */
export function makeStructuralExtract({ parseForLanguage, counters = { parseFailures: 0, parsed: 0, errorFiles: 0 } }) {
  const extract = (rel, content) => {
    const language = STRUCTURAL_LANGUAGES[path.extname(rel).toLowerCase()];
    if (!language) return lexicalV2(rel, content);
    const text = String(content || '');
    let tree = null;
    try {
      tree = parseForLanguage(language, text);
    } catch {
      counters.parseFailures += 1;
      return lexicalV2(rel, content);
    }
    if (!tree || !tree.rootNode) return lexicalV2(rel, content);
    try {
      const walked = WALKERS[language](tree.rootNode);
      const hasErrors = Boolean(tree.rootNode.hasError);
      counters.parsed += 1;
      if (hasErrors) counters.errorFiles += 1;
      return { ...capResult(walked), complexity: branchComplexity(text), tier: 'treesitter', hasErrors };
    } catch {
      counters.parseFailures += 1;
      return lexicalV2(rel, content);
    } finally {
      try {
        tree.delete?.();
      } catch {
        // freeing the wasm-side tree is best-effort
      }
    }
  };
  return { extract, counters };
}

/**
 * Async factory used ONLY by the `harness index --structural` command path.
 * Loads web-tree-sitter plus every lock-pinned grammar wasm whose sha256
 * verifies, and returns:
 *   { extract, tier, available, missingGrammars, integrityFailures,
 *     webTreeSitter, grammarVersions, counters }
 * Absence at ANY level (module not installed, lock unreadable, wasm missing)
 * degrades to a fully-lexical extract with `tier: 'lexical'`. An integrity
 * mismatch ALSO degrades that grammar to lexical, but loudly: it is recorded
 * in `integrityFailures` for the index meta and doctor S1.
 */
export async function createTreesitterExtract({ grammarRoots, lockPath } = {}) {
  const counters = { parseFailures: 0, parsed: 0, errorFiles: 0 };
  const lexicalOnly = (reason, integrityFailures = []) => ({
    ...makeStructuralExtract({ parseForLanguage: () => null, counters }),
    tier: 'lexical',
    reason,
    available: [],
    missingGrammars: Object.keys(loadGrammarsLock({ lockPath })?.grammars || {}),
    integrityFailures,
    webTreeSitter: null,
    grammarVersions: {},
  });

  const lock = loadGrammarsLock({ lockPath });
  if (!lock) return lexicalOnly('grammars.lock missing or unreadable');

  const roots = grammarRoots || defaultGrammarRoots();
  const integrityFailures = [];

  // Runtime wasm: verified bytes are handed to init as `wasmBinary`, so the
  // exact object hashed is the exact object instantiated.
  const runtimePath = findWasm(roots, lock.runtime.package, lock.runtime.file);
  if (!runtimePath) return lexicalOnly('web-tree-sitter runtime not installed (optional)');
  let runtimeBytes;
  try {
    runtimeBytes = fs.readFileSync(runtimePath);
  } catch {
    return lexicalOnly('web-tree-sitter runtime unreadable');
  }
  if (sha256(runtimeBytes) !== lock.runtime.sha256) {
    const failure = { language: 'runtime', file: lock.runtime.file, reason: 'sha256 mismatch vs grammars.lock' };
    return lexicalOnly('runtime integrity mismatch', [failure]);
  }

  let Parser;
  let Language;
  try {
    ({ Parser, Language } = await import('web-tree-sitter'));
    await Parser.init({ wasmBinary: runtimeBytes });
  } catch {
    return lexicalOnly('web-tree-sitter init failed');
  }

  const languages = new Map();
  const grammarVersions = {};
  const missingGrammars = [];
  for (const [language, spec] of Object.entries(lock.grammars)) {
    const wasmPath = findWasm(roots, spec.package, spec.file);
    if (!wasmPath) {
      missingGrammars.push(language);
      continue;
    }
    let bytes;
    try {
      bytes = fs.readFileSync(wasmPath);
    } catch {
      missingGrammars.push(language);
      continue;
    }
    if (sha256(bytes) !== spec.sha256) {
      integrityFailures.push({ language, file: spec.file, reason: 'sha256 mismatch vs grammars.lock' });
      continue; // loud lexical fallback for this grammar — recorded, surfaced by doctor S1
    }
    try {
      languages.set(language, await Language.load(bytes));
      grammarVersions[language] = spec.version;
    } catch {
      integrityFailures.push({ language, file: spec.file, reason: 'wasm failed to instantiate' });
    }
  }

  if (!languages.size) {
    const out = lexicalOnly(missingGrammars.length ? 'no grammar wasm installed (optional)' : 'no grammar verified', integrityFailures);
    out.missingGrammars = missingGrammars;
    return out;
  }

  const parser = new Parser();
  let current = null;
  const parseForLanguage = (language, text) => {
    const lang = languages.get(language);
    if (!lang) return null;
    if (current !== language) {
      parser.setLanguage(lang);
      current = language;
    }
    return parser.parse(text);
  };

  return {
    ...makeStructuralExtract({ parseForLanguage, counters }),
    tier: 'treesitter',
    available: [...languages.keys()],
    missingGrammars,
    integrityFailures,
    webTreeSitter: lock.runtime.version,
    grammarVersions,
  };
}
