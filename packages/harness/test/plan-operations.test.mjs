import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import YAML from 'yaml';
import { initGit, writeVersionedPlan, writeChecks } from './helpers/cli-fixtures.mjs';
import { approveProject } from '../lib/trust.mjs';

const bin = path.resolve(import.meta.dirname, '../bin/harness.mjs');
const hash = value => createHash('sha256').update(value).digest('hex');
for (const status of ['open', 'needs-info']) test(`resolved ${status} full drafts start with the initial execution phase`, t => {
  const f = fixture(t), file = path.join(f.ws, '.harness/draft.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ version: 1, format: 'full', slug: `resolved-${status}`, status, goal: 'Return two.', acceptance: ['Returns two.'], scope: ['src/example.js'], check: 'unit-tests' }));
  const created = f.cli('plan-new', '--file', file);
  assert.equal(created.status, 0, created.stderr);
  const plan = JSON.parse(created.stdout).path;
  fs.writeFileSync(file, JSON.stringify({ version: 1, id: 'resolved-draft', action: 'start', expect: hash(fs.readFileSync(plan)) }));
  const started = f.cli('plan-update', '--plan', plan, '--file', file);
  assert.equal(started.status, 0, started.stdout + started.stderr);
  const fm = YAML.parse(fs.readFileSync(plan, 'utf8').split('---')[1]);
  assert.equal(fm.status, 'in-progress');
  assert.equal(fm.phase, 1);
});

test('closing a hard gap preserves prior progress and does not check unfinished tasks', t => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.ws, '.harness'), { recursive: true });
  fs.writeFileSync(path.join(f.ws, '.harness/proof.md'), 'Capability proof.\n');
  fs.writeFileSync(f.full, f.text().replace('status: planned', 'status: blocked-capability').replace('- [ ] **AC1**', '- [x] **AC1**').replace('capability_gaps: []', 'capability_gaps: [{id: dependency, class: hard, fulfillment: pending}]'));
  const closed = f.op(f.decision('gap', { rationale: 'Capability supplied.', gap: { id: 'dependency', fulfillment: 'done', evidence: '.harness/proof.md' } }));
  assert.equal(closed.status, 0, closed.stderr + closed.stdout);
  assert.equal(YAML.parse(f.text().split('---')[1]).status, 'in-progress');
  assert.match(f.text(), /- \[ \] .+/);
  assert.equal(f.op(f.decision('start')).status, 0);
});

test('legacy gap observations retain their meaning without pretending to be file bindings', t => {
  const f = fixture(t);
  fs.writeFileSync(f.full, f.text().replace('capability_gaps: []', 'capability_gaps: [{id: dependency, class: soft, fulfillment: done, evidence: ["docs inspected", "reviewer supplied"]}]'));
  const started = f.op(f.decision('start'));
  assert.equal(started.status, 0, started.stderr + started.stdout);
  assert.ok(JSON.parse(f.cli('status', '--contract-digest', '--plan', f.plan).stdout).digest);
});

test('encountered capability gaps are declared through revision-bound amendments and block proof', t => {
  const f = fixture(t);
  const input = f.decision('amend', { rationale: 'A required perspective is unavailable.', changes: { gaps: [{ id: 'schema-review', class: 'hard', scope: 'criterion', required_for: 'AC1', evidence: ['The current specialist inventory lacks this perspective.'] }] } });
  const declared = f.op(input);
  assert.equal(declared.status, 0, declared.stdout + declared.stderr);
  const gaps = YAML.parse(f.text().split('---')[1]).capability_gaps;
  assert.equal(gaps.length, 1);
  assert.equal(gaps[0].fulfillment, 'pending');
  assert.equal(gaps[0].required_for, 'AC1');
  assert.equal(YAML.parse(f.text().split('---')[1]).status, 'planned', 'a criterion gap does not fabricate a plan-wide blocked status');
  const after = f.text();
  assert.equal(f.op(input).value.replayed, true);
  assert.equal(f.text(), after);
  fs.writeFileSync(path.join(f.ws, 'src/example.js'), 'export const value = 2;\n');
  const verify = JSON.parse(f.cli('verify', '--plan', f.plan, '--base', 'HEAD').stdout);
  assert.notEqual(verify.outcome, 'passed');
  assert.equal(verify.checks.find(check => check.id === 'hard-gaps').status, 'failed');
});

test('gap declarations cannot overwrite accepted gaps or grant completion and waiver authority', t => {
  const f = fixture(t), base = { id: 'expert', class: 'soft', scope: 'operation', required_for: 'design decision', evidence: ['Sources inspected.'] };
  for (const gap of [{ ...base, fulfillment: 'done' }, { ...base, approved: true }, { ...base, class: 'unsupported' }, { ...base, scope: 'criterion', required_for: 'AC999' }]) {
    const before = f.text();
    assert.notEqual(f.op(f.decision('amend', { rationale: 'Record the encountered gap.', changes: { gaps: [gap] } })).status, 0);
    assert.equal(f.text(), before);
  }
  assert.equal(f.op(f.decision('amend', { rationale: 'Record the encountered gap.', changes: { gaps: [base] } })).status, 0);
  const accepted = f.text();
  assert.notEqual(f.op({ ...f.decision('amend', { rationale: 'Replace the gap.', changes: { gaps: [{ ...base, class: 'hard' }] } }), id: 'replace-gap' }).status, 0);
  assert.equal(f.text(), accepted);
});

for (const kind of ['operation', 'finding', 'gap', 'criterion']) {
  test(`${kind} identifiers reject non-string coercion without publishing accepted work`, t => {
    const f = fixture(t);
    for (const id of [true, [kind === 'criterion' ? 'AC2' : 'coerced-id'], null, '']) {
      const input = kind === 'operation' ? { ...f.decision('amend', { rationale: 'Record accepted context.', changes: { notes: { context: 'Authored context.' } } }), id }
        : kind === 'finding' ? f.decision('finding', { finding: { id, text: 'Authored finding.' } })
          : kind === 'criterion' ? f.decision('amend', { rationale: 'Amend accepted criteria.', changes: { criteria: [{ id, text: 'Updated behavior.', checks: ['unit-tests'] }] } })
          : f.decision('amend', { rationale: 'Declare the encountered gap.', changes: { gaps: [{ id, class: 'soft', scope: 'operation', required_for: 'Design decision', evidence: ['Sources inspected.'] }] } });
      const before = f.text();
      const result = f.op(input);
      assert.notEqual(result.status, 0, `${kind} accepted coerced ID ${JSON.stringify(id)}`);
      assert.equal(f.text(), before);
    }
  });
}

for (const required of ['AC2', 'AC1']) {
  test(`joint criterion and gap amendments validate ${required} against the amended contract`, t => {
    const f = fixture(t);
    const before = f.text();
    const input = f.decision('amend', { rationale: 'The accepted scope now has a different criterion and required perspective.', changes: {
      criteria: [{ id: 'AC2', text: 'The updated behavior works.', checks: ['unit-tests'] }],
      gaps: [{ id: 'new-perspective', class: 'hard', scope: 'criterion', required_for: required, evidence: ['The current inventory lacks the required perspective.'] }],
    } });
    const result = f.op(input);
    if (required === 'AC2') {
      assert.equal(result.status, 0, result.stdout + result.stderr);
      const fm = YAML.parse(f.text().split('---')[1]);
      assert.equal(fm.capability_gaps[0].required_for, 'AC2');
      assert.deepEqual(Object.keys(fm.verification.criteria), ['AC2']);
    } else {
      assert.notEqual(result.status, 0, 'a removed criterion cannot receive a new gap');
      assert.equal(f.text(), before);
    }
  });
}

test('a declared hard plan-scope gap blocks start until evidence-bound fulfillment', t => {
  const f = fixture(t);
  const gap = { id: 'required-tool', class: 'hard', scope: 'plan', required_for: 'All implementation requires the unavailable tool.', evidence: ['Required executable capability is absent.'] };
  assert.equal(f.op(f.decision('amend', { rationale: 'No safe planned work can proceed.', changes: { gaps: [gap] } })).status, 0);
  assert.equal(YAML.parse(f.text().split('---')[1]).status, 'blocked-capability');
  assert.notEqual(f.op(f.decision('start')).status, 0);
  fs.writeFileSync(path.join(f.ws, '.harness/tool-evidence.md'), 'The accepted tool is available.');
  assert.equal(f.op(f.decision('gap', { rationale: 'The required tool was supplied.', gap: { id: gap.id, fulfillment: 'done', evidence: '.harness/tool-evidence.md' } })).status, 0);
  assert.equal(YAML.parse(f.text().split('---')[1]).status, 'planned');
});
test('structured creation refuses absent criteria and fields it cannot preserve', t => {
  const f = fixture(t), file = path.join(f.ws, '.harness/create-invalid.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const base = { version: 1, format: 'full', slug: 'invalid', goal: 'Return two.', check: 'unit-tests' };
  for (const input of [base, { ...base, acceptance: ['Returns two.'], outputs: [] }, { ...base, format: 'short', acceptance: ['Returns two.'], constraints: ['Preserve API.'], outputs: ['src/example.js'] }, { ...base, format: 'short', acceptance: ['Returns two.'], constraints: ['Preserve API.'], risk: 'red' }]) {
    fs.writeFileSync(file, JSON.stringify(input));
    const result = f.cli('plan-new', '--file', file);
    assert.notEqual(result.status, 0, 'invalid creation must not be reported as preserved');
  }
});
function fixture(t, { checkCommand } = {}) {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-plan-op-'));
  t.after(() => fs.rmSync(ws, { recursive: true, force: true }));
  fs.writeFileSync(path.join(ws, '.gitignore'), '.harness/\ndocs/specs/\n');
  const plan = writeVersionedPlan(ws, { taskChecked: false });
  const full = path.join(ws, plan);
  fs.writeFileSync(full, fs.readFileSync(full, 'utf8').replace('status: in-progress', 'status: planned').replace('- [x] **AC1**', '- [ ] **AC1**'));
  fs.mkdirSync(path.join(ws, 'docs/specs'), { recursive: true });
  const source = 'docs/specs/overview.md';
  fs.writeFileSync(path.join(ws, source), '# Example\nReturn two.\n');
  fs.writeFileSync(full, fs.readFileSync(full, 'utf8').replace('plan_schema: 1', `plan_schema: 2\nintent_source_policy: content-v1\nintent_sources:\n  - {path: ${source}, sha256: ${hash(fs.readFileSync(path.join(ws, source)))}}`));
  if (checkCommand) writeChecks(ws, { 'unit-tests': { command: checkCommand } });
  initGit(ws);
  assert.equal(spawnSync('git', ['checkout', '-b', 'feature/proof'], { cwd: ws }).status, 0);
  const cli = (...args) => spawnSync(process.execPath, [bin, ...args, '--workspace', ws, '--harness-home', path.join(ws, '.harness/home'), '--copilot-home', path.join(ws, '.harness/copilot'), '--json'], { cwd: ws, env: { ...process.env, HARNESS_NO_EVENTS: '1', HARNESS_ENFORCEMENT: 'enforce' }, encoding: 'utf8', timeout: 15000 });
  const text = () => fs.readFileSync(full, 'utf8');
  const op = input => {
    const file = path.join(ws, '.harness/operation.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(input));
    const r = cli('plan-update', '--plan', plan, '--file', file);
    return { ...r, value: r.stdout.trim() ? JSON.parse(r.stdout) : null };
  };
  const decision = (action, fields = {}) => ({ version: 1, id: `${action}-decision`, action, expect: hash(text()), ...fields });
  return { ws, full, plan, source, text, cli, op, decision };
}

test('start owns readiness, state and gate, with replay and interrupted gate recovery', t => {
  const f = fixture(t), input = f.decision('start');
  const first = f.op(input);
  assert.equal(first.status, 0, first.stderr + first.stdout);
  assert.equal(YAML.parse(f.text().split('---')[1]).status, 'in-progress');
  const sessionFile = path.join(f.ws, '.harness/session.json');
  const session = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
  assert.equal(session.gateStatus, 'pass');
  assert.equal(session.gatedPlan, f.plan);
  const after = f.text();
  assert.equal(f.op(input).value.operation, first.value.operation);
  assert.equal(f.text(), after);
  const receiptFile = path.join(f.ws, first.value.operationPath);
  const receipt = JSON.parse(fs.readFileSync(receiptFile, 'utf8'));
  fs.writeFileSync(receiptFile, JSON.stringify({ ...receipt, state: 'pending' }));
  fs.rmSync(sessionFile);
  const recovered = f.op(input);
  assert.equal(recovered.status, 0, recovered.stderr);
  assert.equal(JSON.parse(fs.readFileSync(sessionFile)).gateStatus, 'pass');
  assert.equal(f.text(), after);
});

test('stale decisions and reused operation identity cannot overwrite accepted work', t => {
  const f = fixture(t), initial = f.text();
  const first = f.decision('finding', { finding: { id: 'observed-1', text: 'Inspect the boundary.' } });
  const stale = { ...first, id: 'second', finding: { id: 'observed-2', text: 'Old state.' } };
  assert.equal(f.op(first).status, 0);
  assert.notEqual(f.text(), initial);
  const accepted = f.text();
  assert.equal(f.op(stale).status, 2);
  assert.equal(f.op({ ...first, finding: { id: 'observed-1', text: 'Changed payload.' } }).status, 2);
  assert.equal(f.text(), accepted);
});

test('blocked start returns prerequisites without publishing a transition or passing gate', t => {
  const f = fixture(t);
  fs.writeFileSync(f.full, f.text().replace('required: ["unit-tests"]', 'required: []'));
  const before = f.text(), result = f.op(f.decision('start'));
  assert.equal(result.status, 1);
  assert.equal(result.value.status, 'blocked');
  assert.ok(result.value.missing.length > 0);
  assert.equal(f.text(), before);
  assert.equal(fs.existsSync(path.join(f.ws, '.harness/session.json')), false);
});

for (const format of ['full', 'short']) test(`new ${format} plans block selected source drift until a scoped amendment`, t => {
  const f = fixture(t);
  const args = format === 'short' ? ['--goal', 'Return two', '--acceptance', 'Returns two', '--constraint', 'Keep the API'] : ['--type', 'feat', '--intent', 'Return two', '--impacted', 'src/example.js'];
  const created = f.cli('plan-new', ...args, '--slug', `${format}-drift`, '--verification-check', 'unit-tests', '--intent-source', f.source);
  assert.equal(created.status, 0, created.stderr);
  const plan = JSON.parse(created.stdout).path;
  const before = fs.readFileSync(plan, 'utf8');
  const fm = YAML.parse(before.split('---')[1]);
  assert.equal(fm.intent_source_policy, 'content-v1');
  const binding = fm.intent_sources.find(s => s.path === f.source);
  fs.appendFileSync(path.join(f.ws, f.source), 'Preserve the public shape.\n');
  const gate = JSON.parse(f.cli('gate', '--plan', plan).stdout);
  assert.equal(gate.pass, false);
  assert.match(gate.blockedReason, /intent source.*changed|amend/i);
  const digest = JSON.parse(f.cli('status', '--contract-digest', '--plan', plan).stdout);
  assert.equal(digest.digest, null);
  const input = { version: 1, id: 'spec-amendment', action: 'amend', expect: hash(before), rationale: 'The accepted spec now requires a stable API.', authority: { scope: 'plan-intent', basis: 'user-request' }, intentSources: [{ path: f.source, oldHash: binding.sha256, newHash: hash(fs.readFileSync(path.join(f.ws, f.source))) }] };
  const file = path.join(f.ws, '.harness/amend.json');
  fs.writeFileSync(file, JSON.stringify(input));
  const amended = f.cli('plan-update', '--plan', plan, '--file', file);
  assert.equal(amended.status, 0, amended.stderr + amended.stdout);
  const after = YAML.parse(fs.readFileSync(plan, 'utf8').split('---')[1]);
  assert.deepEqual(after.intent_sources.map(s => s.path), fm.intent_sources.map(s => s.path));
  assert.equal(after.intent_sources[0].sha256, input.intentSources[0].newHash);
  assert.ok(JSON.parse(f.cli('status', '--contract-digest', '--plan', plan).stdout).digest);
});

test('amendments reject forged hashes and legacy source policy is reported explicitly', t => {
  const f = fixture(t), started = f.op(f.decision('start'));
  assert.equal(started.status, 0, started.stderr);
  const fm = YAML.parse(f.text().split('---')[1]);
  fs.appendFileSync(path.join(f.ws, f.source), 'More details.\n');
  const bad = f.op(f.decision('amend', { rationale: 'Accepted change.', authority: { scope: 'plan-intent', basis: 'user-request' }, intentSources: [{ path: f.source, oldHash: '0'.repeat(64), newHash: hash(fs.readFileSync(path.join(f.ws, f.source))) }] }));
  assert.equal(bad.status, 2);
  assert.equal(YAML.parse(f.text().split('---')[1]).intent_sources[0].sha256, fm.intent_sources[0].sha256);
  fs.writeFileSync(f.full, f.text().replace('plan_schema: 2', 'plan_schema: 1').replace('intent_source_policy: content-v1\n', ''));
  const legacy = JSON.parse(f.cli('gate', '--plan', f.plan).stdout);
  assert.equal(legacy.pass, true);
  assert.equal(legacy.checks.find(c => c.id === 'C-intent-sources').guarantee, 'legacy-paths-only');
});

test('ordinary relock cannot silently amend bytes or rerank a frozen source selection', t => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.ws, 'specs'));
  fs.writeFileSync(path.join(f.ws, 'specs/new.md'), '# New source\nNew constraints.\n');
  const relocked = f.cli('plan-update', '--plan', f.plan, '--lock');
  assert.equal(relocked.status, 0, relocked.stderr);
  assert.deepEqual(YAML.parse(f.text().split('---')[1]).intent_sources.map(s => s.path), [f.source]);
  fs.appendFileSync(path.join(f.ws, f.source), 'Changed requirement.\n');
  const before = f.text();
  const refused = f.cli('plan-update', '--plan', f.plan, '--lock');
  assert.equal(refused.status, 2);
  assert.match(refused.stderr, /amend/);
  assert.equal(f.text(), before);
});

test('amending scope and criteria preserves reasoning and validates configured proof', t => {
  const f = fixture(t);
  const changed = f.op(f.decision('amend', { rationale: 'Add the API flow.', changes: { scope: ['src/**'], criteria: [{ id: 'AC7', text: 'The API flow works.', checks: ['unit-tests'] }] } }));
  assert.equal(changed.status, 0, changed.stderr);
  assert.match(f.text(), /No additional technical notes\./);
  assert.match(f.text(), /\*\*AC7\*\* The API flow works\./);
  assert.deepEqual(YAML.parse(f.text().split('---')[1]).verification.criteria.AC7, ['unit-tests']);
  const before = f.text();
  const missing = f.op(f.decision('amend', { id: 'missing-check', rationale: 'Probe missing proof.', changes: { criteria: [{ text: 'New flow.', checks: ['unknown-check'] }] } }));
  assert.equal(missing.status, 1);
  assert.equal(missing.value.status, 'blocked');
  assert.equal(f.text(), before);
  assert.equal(f.op(f.decision('amend', { id: 'escape', rationale: 'Probe scope.', changes: { scope: ['../other-product'] } })).status, 2);
});

test('a nonregular selected source blocks authority without hanging', t => {
  const f = fixture(t);
  fs.rmSync(path.join(f.ws, f.source));
  fs.mkdirSync(path.join(f.ws, f.source));
  const result = JSON.parse(f.cli('status', '--contract-digest', '--plan', f.plan).stdout);
  assert.equal(result.digest, null);
  assert.match(result.intent.message, /unreadable/);
  assert.equal(f.op(f.decision('start')).value.status, 'blocked');
});

test('explicit legacy migration freezes existing selection and records authority and hashes', t => {
  const f = fixture(t);
  fs.writeFileSync(f.full, f.text().replace('plan_schema: 2', 'plan_schema: 1').replace('intent_source_policy: content-v1\n', ''));
  fs.mkdirSync(path.join(f.ws, 'specs'));
  fs.writeFileSync(path.join(f.ws, 'specs/new.md'), '# Another source\nUnselected.\n');
  const oldHash = YAML.parse(f.text().split('---')[1]).intent_sources[0].sha256;
  fs.appendFileSync(path.join(f.ws, f.source), 'Accepted spec change.\n');
  const result = f.op(f.decision('amend', { migrateIntent: true, rationale: 'Accept the current selected spec and upgrade drift protection.', authority: { scope: 'plan-intent', basis: 'user-request' } }));
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.value.amendments[0].oldHash, oldHash);
  assert.equal(result.value.amendments[0].newHash, hash(fs.readFileSync(path.join(f.ws, f.source))));
  assert.deepEqual(YAML.parse(f.text().split('---')[1]).intent_sources.map(s => s.path), [f.source]);
});

for (const format of ['full', 'short']) test(`structured plan-new owns ${format} representation and returns its revision`, t => {
  const f = fixture(t), file = path.join(f.ws, '.harness/create.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ version: 1, format, slug: `structured-${format}`, goal: 'Return two.', acceptance: ['The value is two.'], constraints: ['Preserve the API.'], scope: ['src/example.js'], check: 'unit-tests', intentSources: [f.source] }));
  const created = f.cli('plan-new', '--file', file);
  assert.equal(created.status, 0, created.stderr);
  const value = JSON.parse(created.stdout), bytes = fs.readFileSync(value.path, 'utf8');
  assert.equal(value.revision, hash(bytes));
  assert.match(bytes, /src\/example.js/);
  const fm = YAML.parse(bytes.split('---')[1]);
  assert.equal(fm.intent_source_policy, 'content-v1');
  assert.deepEqual(fm.verification.criteria.AC1, ['unit-tests']);
  assert.equal(fm.intent_sources[0].path, f.source);
});

test('capture can create an unlocked structured full draft without invented checks', t => {
  const f = fixture(t), file = path.join(f.ws, '.harness/capture.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ version: 1, format: 'full', slug: 'capture-only', goal: 'Investigate the reproducible failure.', acceptance: ['The reproduced failure is recorded.'], status: 'open' }));
  fs.rmSync(path.join(f.ws, '.github/harness/checks.yaml'));
  const created = f.cli('plan-new', '--file', file);
  assert.equal(created.status, 0, created.stderr);
  const value = JSON.parse(created.stdout), fm = YAML.parse(fs.readFileSync(value.path, 'utf8').split('---')[1]);
  assert.equal(fm.status, 'open');
  assert.equal(fm.plan_lock, false);
  assert.deepEqual(fm.verification.required, []);
  assert.ok(value.missing.length > 0);
});

test('source acceptance can name paths while Harness records and binds the actual hashes', t => {
  const f = fixture(t);
  const oldHash = YAML.parse(f.text().split('---')[1]).intent_sources[0].sha256;
  fs.appendFileSync(path.join(f.ws, f.source), 'Accepted constraint.\n');
  const changed = f.op(f.decision('amend', { rationale: 'Accept the reviewed constraint.', authority: { scope: 'plan-intent', basis: 'user-request' }, intentSources: [{ path: f.source }] }));
  assert.equal(changed.status, 0, changed.stderr);
  assert.equal(changed.value.amendments[0].oldHash, oldHash);
  assert.equal(changed.value.amendments[0].newHash, hash(fs.readFileSync(path.join(f.ws, f.source))));
});

test('accepted finding identities survive repeated observations and reject conflicting replacement', t => {
  const f = fixture(t), finding = { id: 'boundary', text: 'The parser needs a guard.' };
  assert.equal(f.op(f.decision('finding', { finding })).status, 0);
  assert.equal(f.op(f.decision('finding', { id: 'observe-again', finding })).status, 0);
  assert.equal((f.text().match(/- boundary: The parser needs a guard\./g) || []).length, 1);
  const before = f.text();
  assert.equal(f.op(f.decision('finding', { id: 'replace-finding', finding: { ...finding, text: 'The parser is safe.' } })).status, 2);
  assert.equal(f.text(), before);
});

test('malformed or duplicate strict source bindings never supply authority', t => {
  const f = fixture(t), original = f.text(), source = YAML.parse(original.split('---')[1]).intent_sources[0];
  for (const intent_sources of [f.source, [source, source]]) {
    const fm = YAML.parse(original.split('---')[1]);
    fm.intent_sources = intent_sources;
    fs.writeFileSync(f.full, original.replace(/^---\n[\s\S]*?\n---\n/, `---\n${YAML.stringify(fm)}---\n`));
    const result = JSON.parse(f.cli('status', '--contract-digest', '--plan', f.plan).stdout);
    assert.equal(result.digest, null);
  }
});

test('completed operation replay discloses changed selected bytes as noncurrent', t => {
  const f = fixture(t), input = f.decision('start');
  assert.equal(f.op(input).status, 0);
  fs.appendFileSync(path.join(f.ws, f.source), 'Changed after the start.\n');
  assert.equal(f.op(input).value.current, false);
});

test('structured planning owns headings, task IDs, counts and progress representation', t => {
  const f = fixture(t);
  const amended = f.op(f.decision('amend', { rationale: 'Accept the implementation approach.', changes: { phases: [{ title: 'Parser', tasks: ['Add the guard.'] }, { title: 'Proof', tasks: ['Exercise invalid input.', 'Check the public API.'] }], notes: { context: 'Keep the existing parser entry point.', research: 'The caller supplies untrusted input.' } } }));
  assert.equal(amended.status, 0, amended.stderr + amended.stdout);
  assert.match(f.text(), /## Context\n\nKeep the existing parser entry point\./);
  assert.match(f.text(), /### Phase 2: Proof/);
  assert.match(f.text(), /\*\*P2T2\*\* Check the public API\./);
  assert.deepEqual(amended.value.planState, { phases: 2, tasks: 3, completedTasks: 0 });
  assert.equal(f.op(f.decision('start')).status, 0);
  const digest = JSON.parse(f.cli('status', '--contract-digest', '--plan', f.plan).stdout).digest;
  const progress = f.op(f.decision('progress', { progress: { criteria: ['AC1'], tasks: ['P1T1'] } }));
  assert.equal(progress.status, 0, progress.stderr + progress.stdout);
  assert.match(f.text(), /- \[x\] \*\*P1T1\*\*/);
  assert.match(f.text(), /- \[x\] \*\*AC1\*\*/);
  assert.equal(progress.value.planState.completedTasks, 1);
  assert.equal(JSON.parse(f.cli('status', '--contract-digest', '--plan', f.plan).stdout).digest, digest);
  const before = f.text();
  assert.equal(f.op(f.decision('progress', { id: 'unknown-task', progress: { tasks: ['P8T9'] } })).status, 2);
  assert.equal(f.text(), before);
});

test('long frozen source lists with Windows separators retain every selected binding', t => {
  const f = fixture(t), fm = YAML.parse(f.text().split('---')[1]);
  fm.intent_sources = Array.from({ length: 24 }, (_, i) => {
    const rel = `docs/specs/${i}-${'x'.repeat(85)}.md`;
    fs.writeFileSync(path.join(f.ws, rel), `Source ${i}`);
    return { path: rel.replaceAll('/', '\\'), sha256: hash(`Source ${i}`) };
  });
  fs.writeFileSync(f.full, f.text().replace(/^---\n[\s\S]*?\n---\n/, `---\n${YAML.stringify(fm)}---\n`));
  const result = JSON.parse(f.cli('status', '--contract-digest', '--plan', f.plan).stdout);
  assert.ok(result.digest);
  fs.rmSync(path.join(f.ws, fm.intent_sources.at(-1).path.replaceAll('\\', '/')));
  assert.equal(JSON.parse(f.cli('status', '--contract-digest', '--plan', f.plan).stdout).digest, null);
});

test('structured creation accepts authored reasoning and phases without an agent-built template', t => {
  const f = fixture(t), file = path.join(f.ws, '.harness/authored.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ version: 1, format: 'full', slug: 'authored-plan', goal: 'Return two.', acceptance: ['Returns two.'], scope: ['src/example.js'], check: 'unit-tests', notes: { research: 'The existing API must remain compatible.' }, phases: [{ title: 'Guard', tasks: ['Fix the parser.'] }], outputs: ['src/example.js'] }));
  const output = f.cli('plan-new', '--file', file);
  assert.equal(output.status, 0, output.stderr + output.stdout);
  const value = JSON.parse(output.stdout), body = fs.readFileSync(value.path, 'utf8');
  assert.match(body, /## Research Notes\n\nThe existing API must remain compatible\./);
  assert.match(body, /- \[ \] \*\*P1T1\*\* Fix the parser\./);
  assert.deepEqual(YAML.parse(body.split('---')[1]).expected_outputs, ['src/example.js']);
  assert.deepEqual(value.planState, { phases: 1, tasks: 1, completedTasks: 0 });
});

test('structured completion preserves the proof chain and refuses unfinished later phases', t => {
  const f = fixture(t, { checkCommand: [process.execPath, '-e', "import('./src/example.js').then(m => { if (m.value !== 2) process.exit(1); })"] });
  approveProject({ workspace: f.ws, home: path.join(f.ws, '.harness/home'), copilotHome: path.join(f.ws, '.harness/copilot') });
  const planned = f.op(f.decision('amend', { rationale: 'Accept phased proof.', changes: { phases: [{ title: 'Implementation', tasks: ['Fix the value.'] }, { title: 'Compatibility', tasks: ['Check the public API.'] }] } }));
  assert.equal(planned.status, 0, planned.stderr);
  assert.equal(f.op(f.decision('start')).status, 0);
  fs.writeFileSync(path.join(f.ws, 'src/example.js'), 'export const value = 2;\n');
  assert.equal(f.op(f.decision('progress', { progress: { tasks: ['P1T1'], criteria: ['AC1'] } })).status, 0);
  const verified = f.cli('verify', '--plan', f.plan, '--base', 'HEAD');
  assert.equal(verified.status, 0, verified.stderr + verified.stdout);
  const file = path.join(f.ws, '.harness/learning.json');
  fs.writeFileSync(file, JSON.stringify({ operation: 'no-durable-lesson', decision: 'no-learning', rationale: 'Disposable lifecycle fixture.' }));
  const learning = f.cli('compound', '--plan', f.plan, '--learning-decision', file);
  assert.equal(learning.status, 0, learning.stderr + learning.stdout);
  const before = f.text(), blocked = f.op(f.decision('complete'));
  assert.equal(blocked.status, 1);
  assert.equal(blocked.value.status, 'blocked');
  assert.equal(f.text(), before);
  assert.equal(f.op(f.decision('progress', { id: 'compatibility-accepted', progress: { tasks: ['P2T1'] } })).status, 0);
  const input = f.decision('complete', { id: 'finish-after-compatibility' });
  const completed = f.op(input);
  assert.equal(completed.status, 0, completed.stderr + completed.stdout);
  assert.ok(completed.value.completion);
  assert.equal(JSON.parse(f.cli('status', '--validate-completion', '--plan', f.plan).stdout).pass, true);
  assert.equal(f.op(input).value.completion, completed.value.completion);
  fs.appendFileSync(path.join(f.ws, f.source), 'New requirement.\n');
  assert.equal(JSON.parse(f.cli('status', '--validate-completion', '--plan', f.plan).stdout).pass, false);
});

test('concurrent stale decisions serialize to one accepted effect', async t => {
  const f = fixture(t), initial = hash(f.text());
  const run = id => new Promise((resolve, reject) => {
    const file = path.join(f.ws, `.harness/${id}.json`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ version: 1, id, action: 'finding', expect: initial, finding: { id, text: `Accepted ${id}.` } }));
    const child = spawn(process.execPath, [bin, 'plan-update', '--workspace', f.ws, '--plan', f.plan, '--file', file, '--harness-home', path.join(f.ws, '.harness/home'), '--copilot-home', path.join(f.ws, '.harness/copilot'), '--json'], { env: { ...process.env, HARNESS_NO_EVENTS: '1' }, cwd: f.ws });
    let output = '';
    child.stdout.on('data', data => { output += data; });
    child.stderr.on('data', data => { output += data; });
    child.on('error', reject);
    child.on('exit', code => resolve({ code, output }));
  });
  const results = await Promise.all([run('first'), run('second')]);
  assert.deepEqual(results.map(r => r.code).sort(), [0, 2]);
  assert.match(results.find(r => r.code === 2).output, /stale/);
  assert.equal((f.text().match(/- (?:first|second): Accepted/g) || []).length, 1);
});

test('dry-run start publishes no plan, receipt, or gate transition', t => {
  const f = fixture(t), before = f.text(), file = path.join(f.ws, '.harness/dry-start.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(f.decision('start')));
  const result = f.cli('plan-update', '--plan', f.plan, '--file', file, '--dry-run');
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.equal(f.text(), before);
  assert.equal(fs.existsSync(path.join(f.ws, '.harness/session.json')), false);
  assert.equal(fs.existsSync(path.join(f.ws, JSON.parse(result.stdout).operationPath)), false);
});

test('gap fulfillment binds current evidence and stale evidence blocks readiness', t => {
  const f = fixture(t), fm = YAML.parse(f.text().split('---')[1]);
  fm.capability_gaps = [{ id: 'parser-proof', class: 'hard', fulfillment: 'proposed' }];
  fm.status = 'blocked-capability';
  fs.writeFileSync(f.full, f.text().replace(/^---\n[\s\S]*?\n---\n/, `---\n${YAML.stringify(fm)}---\n`));
  const evidence = '.harness/accepted-gap.txt';
  fs.mkdirSync(path.join(f.ws, '.harness'), { recursive: true });
  fs.writeFileSync(path.join(f.ws, evidence), 'Accepted capability proof.');
  const resolved = f.op(f.decision('gap', { rationale: 'The accepted proof resolves the required capability.', gap: { id: 'parser-proof', fulfillment: 'done', evidence } }));
  assert.equal(resolved.status, 0, resolved.stderr + resolved.stdout);
  assert.equal(YAML.parse(f.text().split('---')[1]).capability_gaps[0].evidence_binding.sha256, hash('Accepted capability proof.'));
  fs.writeFileSync(path.join(f.ws, evidence), 'Different proof.');
  const gate = JSON.parse(f.cli('gate', '--plan', f.plan).stdout);
  assert.equal(gate.pass, false);
  assert.match(gate.blockedReason, /gap.*evidence|evidence.*gap/i);
  assert.equal(JSON.parse(f.cli('status', '--contract-digest', '--plan', f.plan).stdout).digest, null);
});

test('accepted findings are distinct from similarly named contextual notes', t => {
  const f = fixture(t);
  assert.equal(f.op(f.decision('amend', { rationale: 'Record context.', changes: { notes: { context: '- boundary: This is a contextual label.' } } })).status, 0);
  const observed = f.op(f.decision('finding', { finding: { id: 'boundary', text: 'Validate the parser input.' } }));
  assert.equal(observed.status, 0, observed.stderr + observed.stdout);
  assert.match(f.text(), /## Accepted Findings\n\n- boundary: Validate the parser input\./);
  assert.match(f.text(), /## Context\n\n- boundary: This is a contextual label\./);
});

test('unsupported declared schemas cannot grant a gate or contract authority', t => {
  const f = fixture(t);
  fs.writeFileSync(f.full, f.text().replace('plan_schema: 2', 'plan_schema: 99'));
  const gate = JSON.parse(f.cli('gate', '--plan', f.plan).stdout);
  assert.equal(gate.pass, false);
  assert.match(gate.blockedReason, /schema/i);
  assert.equal(JSON.parse(f.cli('status', '--contract-digest', '--plan', f.plan).stdout).digest, null);
});
