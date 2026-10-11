import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { initGit, writeVersionedPlan } from './helpers/cli-fixtures.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const baseline = ['architecture-strategist', 'security-sentinel', 'performance-oracle', 'code-simplicity-reviewer', 'pattern-recognition-specialist'];
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-review-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const ws = path.join(dir, 'product');
  fs.mkdirSync(ws);
  fs.writeFileSync(path.join(ws, '.gitignore'), '.harness/\n');
  const plan = writeVersionedPlan(ws);
  fs.writeFileSync(path.join(ws, plan), fs.readFileSync(path.join(ws, plan), 'utf8').replace('required: []', 'required: [code-review]'));
  initGit(ws);
  fs.writeFileSync(path.join(ws, 'src/example.js'), Array.from({ length: 12 }, (_, i) => `export const value${i} = ${i};`).join('\n') + '\n');
  const cli = (...args) => spawnSync(process.execPath, [path.join(root, 'bin/harness.mjs'), 'review', ...args, '--workspace', ws, '--copilot-home', path.join(dir, 'copilot'), '--harness-home', path.join(dir, 'home'), '--json'], { cwd: ws, env: { ...process.env, HARNESS_NO_EVENTS: '1' }, encoding: 'utf8', timeout: 15000 });
  const prepare = (...args) => { const r = cli('prepare', '--plan', plan, '--base', 'HEAD', ...args); assert.equal(r.status, 0, r.stderr + r.stdout); return JSON.parse(r.stdout); };
  const assemble = (packet, results, extra = {}) => {
    const file = path.join(ws, '.harness/results.json');
    fs.writeFileSync(file, JSON.stringify({ packet: packet.id, results, ...extra }));
    const r = cli('assemble', '--plan', plan, '--packet', packet.id, '--file', file);
    return { ...r, value: r.stdout.trim() ? JSON.parse(r.stdout) : null };
  };
  return { ws, plan, cli, prepare, assemble };
}
const clean = reviewer => ({ reviewer, status: 'completed', findings: [], residual_risks: [], testing_gaps: [] });
const finding = (fields = {}) => ({ file: './src/example.js', line: 3, title: 'Missing guard', description: 'The input is unchecked.', suggested_fix: 'Validate the input.', severity: 'P2', confidence: 0.7, autofix_class: 'manual', evidence: ['src/example.js:3'], ...fields });

test('prepare owns mandatory coverage and brace/comma/glob discovery', t => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.ws, '.github/checks'), { recursive: true });
  fs.writeFileSync(path.join(f.ws, '.github/checks/api.md'), '---\nname: api-contract\nglobs: "{src,lib}/**/*.js,api/**"\nseverity-default: P2\n---\nRead public contracts.\n');
  fs.writeFileSync(path.join(f.ws, '.github/checks/sql.md'), '---\nname: sql-contract\nglobs: "**/*.sql"\n---\nRead SQL.\n');
  const packet = f.prepare();
  assert.equal(packet.version, 2);
  for (const name of baseline) assert.ok(packet.required.includes(name), name);
  assert.ok(packet.required.includes('api-contract'));
  assert.ok(!packet.required.includes('sql-contract'));
  assert.equal(packet.preparation.checks.find(c => c.name === 'api-contract').matched, true);
  assert.equal(packet.preparation.coverage.totalFiles, packet.scope.changedFiles.length);
  assert.equal(f.prepare().id, packet.id);
});

test('a checks README without frontmatter is documentation; malformed declared checks still block', t => {
  const f = fixture(t);
  const directory = path.join(f.ws, '.github/checks');
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'README.md'), '# Review checks\n\nHow to author product checks.\n');
  const packet = f.prepare();
  assert.deepEqual(packet.preparation.failures, []);
  assert.equal(f.assemble(packet, packet.required.map(clean)).status, 0);
  fs.writeFileSync(path.join(directory, 'README.md'), '---\nname: invalid name\n---\nDeclared check.\n');
  const malformed = f.prepare();
  assert.ok(malformed.preparation.failures.some(message => /valid name/.test(message)));
  assert.equal(f.assemble(malformed, malformed.required.map(clean)).status, 1);
});

test('assembly is invariant to result order, gates before boosting and only merges exact identities', t => {
  const f = fixture(t), packet = f.prepare();
  const results = packet.required.map(clean);
  results[0].findings = [finding(), finding({ line: 5 }), finding({ title: 'Weak', confidence: 0.55 }), finding({ title: 'Critical uncertainty', severity: 'P1', confidence: 0.5 })];
  results[1].findings = [finding({ file: 'src\\example.js', confidence: 0.8, evidence: ['Second observation'] }), finding({ title: 'Weak', confidence: 0.55 })];
  const first = f.assemble(packet, results);
  assert.equal(first.status, 0, first.stderr + first.stdout);
  const shuffled = f.assemble(packet, results.toReversed().map(r => ({ ...r, findings: r.findings.toReversed() })));
  assert.equal(shuffled.status, 0, shuffled.stderr + shuffled.stdout);
  assert.equal(first.value.id, shuffled.value.id);
  assert.equal(first.value.report, shuffled.value.report);
  assert.equal(first.value.findings.length, 3);
  assert.equal(first.value.suppressed.length, 2);
  const merged = first.value.findings.find(f => f.title === 'Missing guard' && f.line === 3);
  assert.equal(merged.confidence, 0.9);
  assert.deepEqual(merged.originalConfidences, [0.7, 0.8]);
  assert.equal(merged.provenance.kind, 'unknown');
  assert.equal(first.value.overlaps.length, 1);
  assert.equal(first.value.coverage.complete, true);
  assert.equal(first.value.counts.P1, 1);
});

test('missing, timed-out and malformed results remain failed coverage with retrievable raw evidence', t => {
  const f = fixture(t), packet = f.prepare();
  const results = packet.required.map(clean);
  results[0].status = 'timed-out';
  results[1].findings = [finding({ line: 1000 })];
  results.pop();
  const assembled = f.assemble(packet, results);
  assert.equal(assembled.status, 1);
  assert.equal(assembled.value.coverage.complete, false);
  assert.ok(assembled.value.failures.some(f => f.errors.some(e => /outside the file/.test(e))));
  assert.ok(assembled.value.report.includes('Incomplete'));
  const raw = JSON.parse(fs.readFileSync(path.join(f.ws, assembled.value.recordPath), 'utf8'));
  assert.equal(raw.results.find(r => r.raw.status === 'timed-out').raw.status, 'timed-out');
});

test('check definition drift invalidates captured review obligations', t => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.ws, '.github/checks'), { recursive: true });
  const file = path.join(f.ws, '.github/checks/all.md');
  fs.writeFileSync(file, '---\nname: product-review\n---\nReview inputs.\n');
  const packet = f.prepare();
  fs.appendFileSync(file, 'Review new behavior.\n');
  const output = f.assemble(packet, packet.required.map(clean));
  assert.notEqual(output.status, 0);
  assert.match(output.stderr + output.stdout, /stale|changed/);
});

test('standalone document review uses the same collection and factual report contracts', t => {
  const f = fixture(t);
  const prepared = f.cli('prepare', '--domain', 'document', '--file', f.plan, '--base', 'HEAD');
  assert.equal(prepared.status, 0, prepared.stderr + prepared.stdout);
  const packet = JSON.parse(prepared.stdout);
  assert.deepEqual(packet.required, ['coherence', 'design', 'feasibility', 'scope']);
  const file = path.join(f.ws, '.harness/document-results.json');
  fs.writeFileSync(file, JSON.stringify({ packet: packet.id, results: packet.required.map(clean) }));
  const result = f.cli('assemble', '--packet', packet.id, '--file', file);
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.equal(JSON.parse(result.stdout).coverage.complete, true);
});

test('ambiguous overlaps change only through explicit, recorded adjudication', t => {
  const f = fixture(t), packet = f.prepare(), results = packet.required.map(clean);
  results[0].findings = [finding(), finding({ line: 5 })];
  const original = f.assemble(packet, results).value;
  const members = original.overlaps[0].members;
  const retained = f.assemble(packet, results, { adjudications: [{ action: 'retain', members, rationale: 'These are distinct guard boundaries.' }] }).value;
  assert.equal(retained.findings.length, 2);
  const merged = f.assemble(packet, results, { adjudications: [{ action: 'merge', members, rationale: 'Both report one unchecked input.' }] }).value;
  assert.equal(merged.findings.length, 1);
  assert.equal(merged.adjudications[0].rationale, 'Both report one unchecked input.');
  assert.equal(f.assemble(packet, results, { adjudications: [{ action: 'merge', members: [...members, 'missing'], rationale: 'Invalid input' }] }).status, 1);
});

test('dry runs leave stored review coverage untouched', t => {
  const f = fixture(t);
  const output = f.cli('prepare', '--plan', f.plan, '--base', 'HEAD', '--dry-run');
  assert.equal(output.status, 0, output.stderr);
  const proposed = JSON.parse(output.stdout);
  assert.equal(proposed.persisted, false);
  assert.equal(fs.existsSync(path.join(f.ws, proposed.packetPath)), false);
  const packet = f.prepare(), file = path.join(f.ws, '.harness/dry-results.json');
  fs.writeFileSync(file, JSON.stringify({ packet: packet.id, results: packet.required.map(clean) }));
  const assembled = f.cli('assemble', '--plan', f.plan, '--packet', packet.id, '--file', file, '--dry-run');
  assert.equal(assembled.status, 0, assembled.stderr);
  assert.equal(JSON.parse(assembled.stdout).persisted, false);
  assert.equal(fs.existsSync(path.join(f.ws, '.harness/reviews/latest')), false);
});

test('packet excerpts and report rows are bounded with full evidence references', t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.ws, 'src/example.js'), 'export const longValue = 1;\n'.repeat(300));
  const packet = f.prepare('--max-bytes', '1024');
  assert.ok(packet.preparation.coverage.excerptBytes <= 1024);
  assert.ok(packet.preparation.files.some(file => file.truncated));
  const results = packet.required.map(clean);
  results[0].findings = Array.from({ length: 150 }, (_, i) => finding({ line: i + 1, title: `Guard ${i} ${'x'.repeat(100)}` }));
  const record = f.assemble(packet, results).value;
  assert.ok(Buffer.byteLength(record.report) <= 16384);
  assert.ok(record.reportOmittedRows > 0);
  const full = JSON.parse(fs.readFileSync(path.join(f.ws, record.recordPath), 'utf8'));
  assert.equal(full.findings.length, 150);
});

test('a product check cannot replace a mandatory perspective by reusing its name', t => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.ws, '.github/checks'), { recursive: true });
  fs.writeFileSync(path.join(f.ws, '.github/checks/shadow.md'), '---\nname: security-sentinel\n---\nCheck one token.\n');
  const packet = f.prepare();
  const output = f.assemble(packet, packet.required.map(clean));
  assert.equal(output.status, 1);
  assert.ok(output.value.failures.some(f => f.errors.some(e => /collid/i.test(e))));
});

test('a newly applicable check makes the frozen packet stale', t => {
  const f = fixture(t);
  fs.appendFileSync(path.join(f.ws, '.gitignore'), '.github/checks/\n');
  const packet = f.prepare();
  fs.mkdirSync(path.join(f.ws, '.github/checks'), { recursive: true });
  fs.writeFileSync(path.join(f.ws, '.github/checks/new.md'), '---\nname: new-coverage\n---\nReview the new obligation.\n');
  const result = f.assemble(packet, packet.required.map(clean));
  assert.equal(result.status, 2);
  assert.match(result.stderr + result.stdout, /stale|changed/);
});

test('document review cannot fulfill a plan requiring code review', t => {
  const f = fixture(t);
  const output = f.cli('prepare', '--plan', f.plan, '--domain', 'document', '--base', 'HEAD');
  assert.equal(output.status, 2);
  assert.match(output.stderr + output.stdout, /code.review|document/i);
});

test('selecting packet excerpts cannot omit checks for the delivery scope', t => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.ws, '.github/checks'), { recursive: true });
  fs.writeFileSync(path.join(f.ws, '.github/checks/sql.md'), '---\nname: sql-contract\nglobs: "**/*.sql"\n---\nReview SQL.\n');
  fs.writeFileSync(path.join(f.ws, 'migration.sql'), 'DELETE FROM accounts;\n');
  const packet = f.prepare('--file', 'src/example.js');
  assert.ok(packet.required.includes('sql-contract'));
  assert.ok(packet.preparation.refs.some(ref => ref.path === 'migration.sql'));
  const assembled = f.assemble(packet, packet.required.filter(id => id !== 'sql-contract').map(clean));
  assert.equal(assembled.status, 1);
  assert.deepEqual(assembled.value.coverage.missing, ['sql-contract']);
});

test('ignored documents above the excerpt read limit still bind their actual bytes', t => {
  const f = fixture(t);
  fs.appendFileSync(path.join(f.ws, '.gitignore'), 'large.md\n');
  fs.writeFileSync(path.join(f.ws, 'large.md'), 'a'.repeat(1024 * 1024 + 1));
  const output = f.cli('prepare', '--domain', 'document', '--file', 'large.md', '--base', 'HEAD');
  assert.equal(output.status, 0, output.stderr + output.stdout);
  const packet = JSON.parse(output.stdout);
  fs.writeFileSync(path.join(f.ws, 'large.md'), 'b'.repeat(1024 * 1024 + 1));
  const input = path.join(f.ws, '.harness/large-results.json');
  fs.writeFileSync(input, JSON.stringify({ packet: packet.id, results: packet.required.map(clean) }));
  const assembled = f.cli('assemble', '--packet', packet.id, '--file', input);
  assert.equal(assembled.status, 2);
  assert.match(assembled.stderr + assembled.stdout, /stale|changed/);
});

test('different claims at the same location remain distinct pending judgment', t => {
  const f = fixture(t), packet = f.prepare(), results = packet.required.map(clean);
  results[0].findings = [finding()];
  results[1].findings = [finding({ description: 'The caller can bypass account authorization.', suggested_fix: 'Check account ownership.' })];
  const record = f.assemble(packet, results).value;
  assert.equal(record.findings.length, 2);
  assert.deepEqual(record.findings.map(f => f.description).sort(), ['The caller can bypass account authorization.', 'The input is unchecked.']);
  assert.equal(record.overlaps.length, 1);
});

test('compatible overlapping retain decisions work in either order', t => {
  const f = fixture(t), packet = f.prepare(), results = packet.required.map(clean);
  results[0].findings = [finding({ line: 1 }), finding({ line: 3 }), finding({ line: 5 })];
  const original = f.assemble(packet, results).value;
  const adjudications = original.overlaps.map(candidate => ({ action: 'retain', members: candidate.members, rationale: 'Each is a separate input boundary.' }));
  const a = f.assemble(packet, results, { adjudications });
  const b = f.assemble(packet, results, { adjudications: adjudications.toReversed() });
  assert.equal(a.status, 0, a.stderr + a.stdout);
  assert.equal(b.status, 0, b.stderr + b.stdout);
  assert.equal(a.value.id, b.value.id);
  assert.equal(a.value.findings.length, 3);
  assert.equal(a.value.overlaps.length, 0);
});

test('actionable overlaps refer to surviving findings after a merge', t => {
  const f = fixture(t), packet = f.prepare(), results = packet.required.map(clean);
  results[0].findings = [finding(), finding({ line: 5 })];
  const original = f.assemble(packet, results).value;
  const merged = f.assemble(packet, results, { adjudications: [{ action: 'merge', members: original.overlaps[0].members, rationale: 'Both describe one guard.' }] }).value;
  const ids = new Set(merged.findings.map(f => f.id));
  assert.ok(merged.overlaps.every(candidate => candidate.members.every(id => ids.has(id))));
  assert.equal(merged.overlaps.length, 0);
});

test('a surviving overlap accepts a follow-up judgment referencing a prior merge', t => {
  const f = fixture(t), packet = f.prepare(), results = packet.required.map(clean);
  results[0].findings = [finding({ line: 1 }), finding({ line: 3 }), finding({ line: 5 })];
  const original = f.assemble(packet, results).value;
  const first = { action: 'merge', members: original.overlaps[0].members, rationale: 'One guard is reported twice.' };
  const merged = f.assemble(packet, results, { adjudications: [first] }).value;
  assert.equal(merged.findings.length, 2);
  assert.equal(merged.overlaps.length, 1);
  const second = { action: 'retain', members: merged.overlaps[0].members, rationale: 'The remaining guard is independent.' };
  const a = f.assemble(packet, results, { adjudications: [first, second] });
  const b = f.assemble(packet, results, { adjudications: [second, first] });
  assert.equal(a.status, 0, a.stderr + a.stdout);
  assert.equal(a.value.id, b.value.id);
  assert.equal(a.value.findings.length, 2);
  assert.equal(a.value.overlaps.length, 0);
});

test('contradictory adjudications block coverage without silently deleting findings', t => {
  const f = fixture(t), packet = f.prepare(), results = packet.required.map(clean);
  results[0].findings = [finding(), finding({ line: 5 })];
  const members = f.assemble(packet, results).value.overlaps[0].members;
  const adjudications = ['merge', 'retain'].map(action => ({ action, members, rationale: 'Conflicting judgments.' }));
  const a = f.assemble(packet, results, { adjudications });
  const b = f.assemble(packet, results, { adjudications: adjudications.toReversed() });
  assert.equal(a.status, 1);
  assert.equal(a.value.id, b.value.id);
  assert.equal(a.value.findings.length, 2);
  assert.ok(a.value.failures.some(f => f.errors.includes('Conflicting merge and retain adjudications')));
});
