import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  branchComplexity,
  lexicalV2,
  loadGrammarsLock,
  grammarStatus,
  makeStructuralExtract,
  createTreesitterExtract,
  MAX_IDENTIFIER_LENGTH,
  DEFAULT_LOCK_PATH,
} from '../lib/repo-map/treesitter-extractor.mjs';

// One shared factory instance: init is the expensive part, extract is sync.
// When the optional grammar packages are absent this resolves to the lexical
// tier and the grammar-dependent tests below skip honestly.
const extractor = await createTreesitterExtract();
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

test('lexicalV2 preserves v1 fields and adds approximate defs, empty refs, and complexity', () => {
  const r = lexicalV2('a.ts', 'export function hi(){ if (x) {} }');
  assert.deepEqual(r.symbols, ['hi']);
  assert.deepEqual(r.defs, [{ name: 'hi', kind: 'symbol', line: 1, exported: false }]);
  assert.deepEqual(r.refs, [], 'the lexical tier never fabricates call facts');
  assert.equal(r.tier, 'lexical');
  assert.equal(r.complexity, 2);
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
  const runtimeSrc = path.resolve(path.dirname(DEFAULT_LOCK_PATH), '..', '..', 'node_modules', lock.runtime.package, lock.runtime.file);
  if (fs.existsSync(runtimeSrc)) {
    const rtDir = path.join(dir, lock.runtime.package);
    fs.mkdirSync(rtDir, { recursive: true });
    fs.copyFileSync(runtimeSrc, path.join(rtDir, lock.runtime.file));
  }
  const ext = await createTreesitterExtract({ grammarRoots: [dir] });
  if (fs.existsSync(runtimeSrc)) {
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

test('identifier length cap bounds extracted names', () => {
  const long = 'x'.repeat(400);
  const r = lexicalV2('a.ts', `export const ${long} = 1;`);
  assert.ok(r.symbols[0].length <= MAX_IDENTIFIER_LENGTH);
});
