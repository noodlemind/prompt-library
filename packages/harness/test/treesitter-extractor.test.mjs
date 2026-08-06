import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import {
  branchComplexity,
  lexicalV2,
  loadGrammarsLock,
  grammarStatus,
  makeStructuralExtract,
  createTreesitterExtract,
  packageGrammarRoots,
  MAX_IDENTIFIER_LENGTH,
  MAX_DEFS_PER_FILE,
  DEFAULT_LOCK_PATH,
} from '../lib/repo-map/treesitter-extractor.mjs';

// One shared factory instance: init is the expensive part, extract is sync.
// Roots are pinned to the harness package's OWN node_modules so the suite
// never depends on what happens to live in a parent directory; when the
// optional grammar packages are absent this resolves to the lexical tier and
// the grammar-dependent tests below skip honestly.
const extractor = await createTreesitterExtract({ grammarRoots: packageGrammarRoots() });
const grammars = extractor.tier === 'treesitter';
const skipNote = 'optional tree-sitter grammars not installed — lexical absence mode';

test('grammars.lock ships, parses, and pins sha256 for runtime and all grammars', () => {
  const lock = loadGrammarsLock();
  assert.ok(lock, 'grammars.lock must ship with the package');
  assert.equal(lock.version, 1);
  assert.match(lock.runtime.sha256, /^[0-9a-f]{64}$/);
  for (const language of ['javascript', 'typescript', 'tsx', 'python', 'java']) {
    assert.ok(lock.grammars[language], `lock missing ${language}`);
    assert.match(lock.grammars[language].sha256, /^[0-9a-f]{64}$/, `${language} sha256`);
    assert.match(lock.grammars[language].version, /^\d+\.\d+\.\d+$/, `${language} version pinned`);
  }
});

test('branchComplexity is a cheap deterministic branch count with floor 1', () => {
  assert.equal(branchComplexity(''), 1);
  assert.equal(branchComplexity('const a = 1;'), 1);
  assert.equal(branchComplexity('if (a) {} else if (b) {} while (c) { }'), 4);
  assert.equal(branchComplexity('a && b || c ?? d'), 4);
});

test('lexicalV2 preserves v1 fields and adds approximate defs, real export flags, and complexity', () => {
  const r = lexicalV2('a.ts', 'export function hi(){ if (x) {} }\nfunction Local(){}\n');
  assert.deepEqual(r.symbols, ['hi', 'Local']);
  assert.deepEqual(r.defs, [
    { name: 'hi', kind: 'symbol', line: 1, exported: true },
    { name: 'Local', kind: 'symbol', line: 2, exported: false },
  ]);
  assert.deepEqual(r.refs, [], 'no imports means no references — never a guessed call');
  assert.equal(r.tier, 'lexical');
  assert.equal(r.complexity, 2);
});

test('lexical export detection: the DEFAULT tier reports a real module surface', () => {
  const ts = lexicalV2(
    'mod.ts',
    [
      'const hidden = 1;',
      'export const shown = 2;',
      'export let mutable = 3;',
      'function helper() {}',
      'class Widget {}',
      'export { helper, Widget as Gadget };',
      'export * as ns from "./other";',
      'export default hidden;',
    ].join('\n')
  );
  const exported = new Set(ts.defs.filter((d) => d.exported).map((d) => d.name));
  for (const name of ['shown', 'mutable', 'helper', 'Gadget', 'ns', 'hidden']) {
    assert.ok(exported.has(name), `${name} must read as exported: ${JSON.stringify(ts.defs)}`);
  }

  const cjs = lexicalV2('legacy.cjs', 'function run() {}\nmodule.exports.run = run;\nexports.other = 1;\n');
  const cjsExported = new Set(cjs.defs.filter((d) => d.exported).map((d) => d.name));
  assert.ok(cjsExported.has('run') && cjsExported.has('other'), JSON.stringify(cjs.defs));

  // Python has no export keyword: __all__ wins when present, otherwise
  // module-level non-underscore defs — the same rule the AST tier applies.
  const withAll = lexicalV2('svc.py', '__all__ = ["public_one"]\ndef public_one():\n    pass\ndef also_public():\n    pass\n');
  const pyAll = new Map(withAll.defs.map((d) => [d.name, d.exported]));
  assert.equal(pyAll.get('public_one'), true);
  assert.equal(pyAll.get('also_public'), false, '__all__ is authoritative when present');
  const noAll = lexicalV2('svc2.py', 'def public_one():\n    pass\ndef _private():\n    pass\nclass Inner:\n    def method(self):\n        pass\n');
  const py = new Map(noAll.defs.map((d) => [d.name, d.exported]));
  assert.equal(py.get('public_one'), true);
  assert.equal(py.get('_private'), false);
  assert.equal(py.get('method'), false, 'a nested method is not a module-level export');

  const java = lexicalV2('A.java', 'public class A {\n  public void open() {}\n  private void shut() {}\n}\n');
  const jv = new Map(java.defs.map((d) => [d.name, d.exported]));
  assert.equal(jv.get('A'), true);
  assert.equal(jv.get('open'), true);
  assert.equal(jv.get('shut'), false);

  // SQL/HCL have no module boundary — nothing is claimed as exported.
  const sql = lexicalV2('schema.sql', 'CREATE TABLE payments (id int);');
  assert.deepEqual(sql.defs.map((d) => d.exported), [false]);
});

test('lexical references are stated named imports, never inferred call sites', () => {
  const js = lexicalV2('caller.mjs', "import { beta, gamma as g } from './a.mjs';\nexport const use = () => beta() + delta();\n");
  assert.deepEqual(js.refs.map((r) => r.name).sort(), ['beta', 'gamma'], 'the imported names, not the local alias');
  assert.ok(!js.refs.some((r) => r.name === 'delta'), 'a bare call is never invented as a reference');
  const py = lexicalV2('svc.py', 'from billing.core import Charge\ndef run():\n    return Charge()\n');
  assert.deepEqual(py.refs.map((r) => r.name), ['Charge']);
  const java = lexicalV2('A.java', 'import com.acme.Role;\npublic class A {}\n');
  assert.deepEqual(java.refs.map((r) => r.name), ['Role']);
});

test('lexicalV2 is linear in file size — the default tier must not rescan per name', () => {
  // A crafted file: 20k long near-matching lines, then 512 declarations. The
  // old shape ran one `lines.findIndex(l => l.includes(name))` PER NAME, so
  // every declaration rescanned the whole prefix — ~1.3s here, on the DEFAULT
  // tier, for one file of a full index. A single tokenizing pass is ~20ms.
  const pad = `// ${'a'.repeat(200)}`;
  const lines = [];
  for (let i = 0; i < 20_000; i++) lines.push(pad);
  for (let i = 0; i < 512; i++) lines.push(`export const ${'a'.repeat(40)}b${i} = ${i};`);
  const content = lines.join('\n');
  const started = Date.now();
  const r = lexicalV2('big.ts', content);
  const elapsed = Date.now() - started;
  assert.equal(r.defs.length, 512);
  assert.equal(r.defs[0].line, 20_001, 'declaration lines are still resolved exactly');
  assert.ok(elapsed < 300, `lexicalV2 took ${elapsed}ms on one ${Math.round(content.length / 1024)}KB file — the per-name rescan is back`);
});

test('the lexical path caps symbols and imports like the AST path does', () => {
  const symbols = Array.from({ length: MAX_DEFS_PER_FILE + 50 }, (_, i) => `export const s${i} = ${i};`).join('\n');
  const capped = lexicalV2('many.ts', symbols);
  assert.equal(capped.symbols.length, MAX_DEFS_PER_FILE, 'unbounded symbol lists would grow files.json without limit');
  assert.equal(capped.defs.length, MAX_DEFS_PER_FILE);
  const imports = Array.from({ length: 400 }, (_, i) => `import { n${i} } from './m${i}';`).join('\n');
  assert.ok(lexicalV2('imports.ts', imports).imports.length <= 256);
});

test('extraction matrix: typescript defs, imports, refs, exported flags', (t) => {
  if (!grammars) return t.skip(skipNote);
  const src = [
    "import { helper } from './util';",
    'export interface PayReq { id: string }',
    'type Alias = 1;',
    'export class PaymentService {',
    '  charge(req: PayReq) { return validate(req) && this.audit(req); }',
    '  private audit(r: PayReq) {}',
    '}',
    'const localFn = () => {};',
  ].join('\n');
  const r = extractor.extract('src/pay.ts', src);
  assert.equal(r.tier, 'treesitter');
  assert.ok(r.symbols.includes('PaymentService'));
  assert.ok(r.symbols.includes('PayReq'));
  assert.ok(r.symbols.includes('Alias'));
  assert.ok(r.symbols.includes('charge'));
  assert.ok(r.symbols.includes('localFn'), 'arrow-function const is a def');
  assert.ok(r.imports.includes('./util'));
  const payReq = r.defs.find((d) => d.name === 'PayReq');
  assert.equal(payReq.exported, true);
  assert.equal(payReq.kind, 'interface');
  const alias = r.defs.find((d) => d.name === 'Alias');
  assert.equal(alias.exported, false);
  assert.ok(r.refs.some((x) => x.name === 'validate'), 'call refs captured');
  assert.ok(r.refs.some((x) => x.name === 'audit'), 'member call refs captured');
  assert.ok(r.complexity >= 2);
});

test('extraction matrix: javascript and tsx', (t) => {
  if (!grammars) return t.skip(skipNote);
  const js = extractor.extract('a.mjs', "const x = require('./legacy');\nexport function run() { return new Runner(); }");
  assert.equal(js.tier, 'treesitter');
  assert.ok(js.symbols.includes('run'));
  assert.ok(js.imports.includes('./legacy'), 'require() counted as an import');
  assert.ok(js.refs.some((r) => r.name === 'Runner'), 'new-expression counted as a ref');
  const tsx = extractor.extract('App.tsx', 'export function App(){ return <div onClick={() => go()} />; }');
  assert.equal(tsx.tier, 'treesitter');
  assert.ok(tsx.symbols.includes('App'));
  assert.ok(tsx.refs.some((r) => r.name === 'go'));
});

test('extraction matrix: python defs/imports/refs with module-level export approximation', (t) => {
  if (!grammars) return t.skip(skipNote);
  const src = [
    'from billing.core import Charge',
    'import audit.log',
    'class PaymentService:',
    '    def charge(self, req):',
    '        return Charge(req).run()',
    'def _private_helper():',
    '    pass',
  ].join('\n');
  const r = extractor.extract('svc.py', src);
  assert.equal(r.tier, 'treesitter');
  assert.ok(r.symbols.includes('PaymentService'));
  assert.ok(r.symbols.includes('charge'));
  assert.ok(r.imports.includes('billing.core'));
  assert.ok(r.imports.includes('audit.log'));
  const cls = r.defs.find((d) => d.name === 'PaymentService');
  assert.equal(cls.exported, true);
  const priv = r.defs.find((d) => d.name === '_private_helper');
  assert.equal(priv.exported, false);
  assert.ok(r.refs.some((x) => x.name === 'Charge'));
  assert.ok(r.refs.some((x) => x.name === 'run'));
});

test('extraction matrix: java defs/imports/refs with public visibility', (t) => {
  if (!grammars) return t.skip(skipNote);
  const src = [
    'import com.acme.Role;',
    'public class PaymentController {',
    '  public void handle(Role r) { audit(r); new Session(); }',
    '  void internalOnly() {}',
    '}',
  ].join('\n');
  const r = extractor.extract('src/PaymentController.java', src);
  assert.equal(r.tier, 'treesitter');
  assert.ok(r.symbols.includes('PaymentController'));
  assert.ok(r.symbols.includes('handle'));
  assert.ok(r.imports.includes('com.acme.Role'));
  const handle = r.defs.find((d) => d.name === 'handle');
  assert.equal(handle.exported, true);
  const internal = r.defs.find((d) => d.name === 'internalOnly');
  assert.equal(internal.exported, false);
  assert.ok(r.refs.some((x) => x.name === 'audit'));
  assert.ok(r.refs.some((x) => x.name === 'Session'));
});

test('silent per-file fallback: SQL and unknown extensions stay lexical', () => {
  const sql = extractor.extract('schema.sql', 'CREATE TABLE payments (id int);');
  assert.equal(sql.tier, 'lexical');
  assert.ok(sql.symbols.includes('payments'), 'lexical SQL extraction still works');
  const rb = extractor.extract('tool.rb', 'def hello; end');
  assert.equal(rb.tier, 'lexical');
  assert.deepEqual(rb.defs, []);
});

test('a malformed source file still extracts partially and is counted, never thrown', (t) => {
  if (!grammars) return t.skip(skipNote);
  const before = extractor.counters.errorFiles;
  const r = extractor.extract('broken.java', 'public class Broken { void ok() {} }\n%%%% garbage {{{');
  assert.equal(r.tier, 'treesitter', 'error-bearing trees still yield structural facts');
  assert.ok(r.symbols.includes('Broken'));
  assert.equal(r.hasErrors, true);
  assert.equal(extractor.counters.errorFiles, before + 1);
});

test('per-file parse failure (parser throw) falls back to lexical and is counted', () => {
  const { extract, counters } = makeStructuralExtract({
    parseForLanguage: () => {
      throw new Error('boom');
    },
  });
  const r = extract('a.ts', 'export function stillFound() {}');
  assert.equal(r.tier, 'lexical');
  assert.ok(r.symbols.includes('stillFound'), 'lexical fallback still extracts');
  assert.equal(counters.parseFailures, 1);
});

test('integrity mismatch: corrupted grammar wasm is a LOUD lexical fallback, absence is silent', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-grammar-'));
  // A fixture root carrying a CORRUPT javascript wasm and NO other grammars.
  const lock = JSON.parse(fs.readFileSync(DEFAULT_LOCK_PATH, 'utf8'));
  const jsDir = path.join(dir, lock.grammars.javascript.package);
  fs.mkdirSync(jsDir, { recursive: true });
  fs.writeFileSync(path.join(jsDir, lock.grammars.javascript.file), 'not the pinned wasm bytes');
  // Runtime present and genuine when installed, else absent → absence mode.
  // Resolve through the module resolver (not a hard-coded node_modules path)
  // so hoisted installs still exercise the integrity assertions.
  let runtimeSrc = null;
  try {
    runtimeSrc = createRequire(import.meta.url).resolve(`${lock.runtime.package}/${lock.runtime.file}`);
  } catch {
    runtimeSrc = null; // not installed anywhere the resolver can see — absence mode
  }
  if (runtimeSrc) {
    const rtDir = path.join(dir, lock.runtime.package);
    fs.mkdirSync(rtDir, { recursive: true });
    fs.copyFileSync(runtimeSrc, path.join(rtDir, lock.runtime.file));
  }
  const ext = await createTreesitterExtract({ grammarRoots: [dir] });
  if (runtimeSrc) {
    assert.ok(
      ext.integrityFailures.some((f) => f.language === 'javascript' && /sha256 mismatch/.test(f.reason)),
      'corrupt wasm must be recorded as an integrity failure'
    );
    assert.ok(!ext.available.includes('javascript'), 'corrupt grammar must not instantiate');
  } else {
    assert.equal(ext.tier, 'lexical');
  }
  const r = ext.extract('x.mjs', 'export function fromLexical() {}');
  assert.equal(r.tier, 'lexical', 'the corrupted grammar language falls back to lexical');
  assert.ok(r.symbols.includes('fromLexical'));

  // grammarStatus (the sync doctor probe) reports the same mismatch.
  const status = grammarStatus({ grammarRoots: [dir] });
  assert.ok(status.integrityFailures.some((f) => f.language === 'javascript'));
  assert.equal(status.grammars.python.present, false, 'absent grammar is not an integrity failure');
  assert.ok(!status.integrityFailures.some((f) => f.language === 'python'));

  fs.rmSync(dir, { recursive: true, force: true });
});

test('runtime integrity mismatch disables the whole tier loudly', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-grammar-rt-'));
  const lock = JSON.parse(fs.readFileSync(DEFAULT_LOCK_PATH, 'utf8'));
  const rtDir = path.join(dir, lock.runtime.package);
  fs.mkdirSync(rtDir, { recursive: true });
  fs.writeFileSync(path.join(rtDir, lock.runtime.file), 'corrupt runtime');
  const ext = await createTreesitterExtract({ grammarRoots: [dir] });
  assert.equal(ext.tier, 'lexical');
  assert.ok(ext.integrityFailures.some((f) => f.language === 'runtime'));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the JS loader entry point is hash-pinned, not just the wasm', async (t) => {
  const lock = loadGrammarsLock();
  assert.ok(lock.runtime.loader, 'grammars.lock must pin the loader entry point');
  assert.match(lock.runtime.loader.sha256, /^[0-9a-f]{64}$/);
  assert.match(lock.runtime.loader.file, /\.(?:js|cjs|mjs)$/, 'the pinned loader is the JS entry the import executes');

  // A tampered loader is the cheaper attack than a tampered wasm: it runs with
  // full Node privileges. Point the factory at a forged entry point and the
  // tier must refuse LOUDLY, never import it.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-loader-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const forged = path.join(dir, lock.runtime.loader.file);
  fs.writeFileSync(forged, 'module.exports = { Parser: {}, Language: {} }; // not the pinned loader\n');
  const ext = await createTreesitterExtract({ grammarRoots: packageGrammarRoots(), loaderPath: forged });
  assert.equal(ext.tier, 'lexical', 'a loader mismatch disables the tier');
  assert.ok(
    ext.integrityFailures.some((f) => f.language === 'loader' && /sha256 mismatch/.test(f.reason)),
    `loader mismatch must be recorded: ${JSON.stringify(ext.integrityFailures)}`
  );
  assert.deepEqual(ext.available, []);
});

test('a missing or truncated grammars.lock is a LOUD refusal, never a silent disable', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-nolock-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const missing = path.join(dir, 'absent.lock');
  const truncated = path.join(dir, 'truncated.lock');
  // A lock without the runtime block cannot verify anything either.
  fs.writeFileSync(truncated, JSON.stringify({ version: 1, grammars: {} }));

  for (const lockPath of [missing, truncated]) {
    assert.equal(loadGrammarsLock({ lockPath }), null, `${lockPath} must not parse as a usable lock`);
    const ext = await createTreesitterExtract({ lockPath });
    assert.equal(ext.tier, 'lexical');
    assert.ok(
      ext.integrityFailures.some((f) => f.language === 'lock'),
      `an unverifiable lock must be recorded, not silently ignored: ${JSON.stringify(ext.integrityFailures)}`
    );
    const status = grammarStatus({ lockPath, grammarRoots: [dir] });
    assert.equal(status.lock, false);
    assert.ok(status.integrityFailures.some((f) => f.language === 'lock'), JSON.stringify(status.integrityFailures));
  }
});

test('identifier length cap bounds extracted names', () => {
  const long = 'x'.repeat(400);
  const r = lexicalV2('a.ts', `export const ${long} = 1;`);
  assert.ok(r.symbols[0].length <= MAX_IDENTIFIER_LENGTH);
});
