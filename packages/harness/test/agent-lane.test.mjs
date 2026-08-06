import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRedactor } from '../lib/redact.mjs';
import { renderAgentLane, recordAgentLaneBytes, DEFAULT_AGENT_BUDGET_BYTES } from '../lib/agent-lane.mjs';

// Deterministic redactor with an empty env — same fixture convention as
// test/redact.test.mjs, so these tests never depend on (or get polluted by)
// whatever secret-shaped variables happen to be set in the real process env.
function realRedactor() {
  return createRedactor({ env: {} });
}

// Wraps the REAL redactor (never reimplements it) but counts calls, so the
// "inject a fake redactor and assert it ran" requirement can be verified
// against the actual pass-through wiring, not a hand-rolled stand-in.
function spyRedactor() {
  const real = realRedactor();
  let redactValueCalls = 0;
  return {
    redactText: real.redactText,
    redactValue(value) {
      redactValueCalls += 1;
      return real.redactValue(value);
    },
    get redactValueCalls() {
      return redactValueCalls;
    },
  };
}

// --- shape / determinism ------------------------------------------------------

test('renderAgentLane returns {text, bytes, truncated} with bytes matching the text', () => {
  const { text, bytes, truncated } = renderAgentLane(
    { contextPack: '.harness/context-pack.md', gateStatus: 'blocked', recall: [] },
    { redactor: realRedactor() }
  );
  assert.equal(typeof text, 'string');
  assert.equal(bytes, Buffer.byteLength(text, 'utf8'));
  assert.equal(truncated, false);
});

test('renderAgentLane produces compact key/value lines, never a markdown table or a raw JSON dump', () => {
  const { text } = renderAgentLane(
    { contextPack: '.harness/context-pack.md', gateStatus: 'blocked', plans: [{ path: 'docs/plans/a.md', status: 'planned' }] },
    { redactor: realRedactor() }
  );
  assert.match(text, /contextPack \.harness\/context-pack\.md/);
  assert.match(text, /gateStatus blocked/);
  assert.match(text, /plans\[0\] path=docs\/plans\/a\.md · status=planned/);
  assert.doesNotMatch(text, /^\s*\{/, 'must not be a raw JSON object dump');
  assert.doesNotMatch(text, /^\s*\[/, 'must not be a raw JSON array dump');
  assert.doesNotMatch(text, /\|[^\n]*\|[^\n]*\|/, 'must not render a markdown table row');
  assert.doesNotMatch(text, /```/, 'must not render a markdown code fence');
});

test('renderAgentLane also accepts an envelope-shaped object (schema/command/status included)', () => {
  const envelope = { schema: 1, command: 'orient', status: 'ok', contextPack: 'x', recall: [] };
  const { text } = renderAgentLane(envelope, { redactor: realRedactor() });
  assert.match(text, /^schema 1/);
  assert.match(text, /command orient/);
  assert.match(text, /status ok/);
});

test('renderAgentLane renders empty arrays/objects/null without throwing', () => {
  const { text } = renderAgentLane({ recall: [], activePlan: null, planGoal: {} }, { redactor: realRedactor() });
  assert.match(text, /recall \(0 items\)/);
  assert.match(text, /activePlan null/);
  assert.match(text, /planGoal \{\}/);
});

test('renderAgentLane works with the default redactor/inert when nothing is injected', () => {
  assert.doesNotThrow(() => {
    const { text, bytes } = renderAgentLane({ note: 'hello world' });
    assert.equal(typeof text, 'string');
    assert.equal(typeof bytes, 'number');
  });
});

test('renderAgentLane is deterministic: same input and options produce identical text and byte count', () => {
  const input = { contextPack: '.harness/context-pack.md', recall: [{ id: 'a', score: 0.4 }], gateStatus: 'blocked' };
  const opts = { redactor: realRedactor(), budgetBytes: 500 };
  const first = renderAgentLane(input, opts);
  const second = renderAgentLane(input, opts);
  assert.equal(first.text, second.text);
  assert.equal(first.bytes, second.bytes);
  assert.equal(first.truncated, second.truncated);
});

// --- budget enforcement --------------------------------------------------------

test('renderAgentLane defaults to DEFAULT_AGENT_BUDGET_BYTES (2048) when no budgetBytes is given', () => {
  assert.equal(DEFAULT_AGENT_BUDGET_BYTES, 2048);
  const { truncated, bytes } = renderAgentLane({ a: 'small' }, { redactor: realRedactor() });
  assert.equal(truncated, false);
  assert.ok(bytes <= DEFAULT_AGENT_BUDGET_BYTES);
});

test('renderAgentLane truncates at item boundaries and never exceeds the byte budget', () => {
  const result = { recall: Array.from({ length: 50 }, (_, i) => ({ id: `item-${i}` })) };
  const budgetBytes = 200;
  const { text, bytes, truncated } = renderAgentLane(result, { redactor: realRedactor(), budgetBytes });

  assert.ok(bytes <= budgetBytes, `bytes (${bytes}) must never exceed budget (${budgetBytes})`);
  assert.equal(truncated, true);

  const lines = text.split('\n');
  const last = lines[lines.length - 1];
  const kept = last.startsWith('…') ? lines.slice(0, -1) : lines;
  // Every kept line must be a WHOLE original item — never a mid-item slice.
  for (const line of kept) {
    assert.match(line, /^recall\[\d+\] id=item-\d+$/);
  }
  assert.ok(kept.length > 0 && kept.length < 50, 'some but not all items should survive at this budget');
});

test('renderAgentLane degrades to an empty string rather than ever exceeding a budget smaller than the marker', () => {
  const result = { recall: Array.from({ length: 10 }, (_, i) => ({ id: `x${i}` })) };
  const { text, bytes, truncated } = renderAgentLane(result, { redactor: realRedactor(), budgetBytes: 3 });
  assert.ok(bytes <= 3);
  assert.equal(truncated, true);
  assert.equal(text, '');
});

test('renderAgentLane fits everything with no truncation when the budget is generous', () => {
  const result = { a: '1', b: '2', recall: [{ id: 'x' }] };
  const { truncated, bytes } = renderAgentLane(result, { redactor: realRedactor(), budgetBytes: 10_000 });
  assert.equal(truncated, false);
  assert.ok(bytes < 10_000);
});

// --- hardening: redaction pass-through -----------------------------------------

test('renderAgentLane redacts secret-shaped content via the injected redactor (pass-through, not reimplemented)', () => {
  const spy = spyRedactor();
  const secret = 'ghp_' + 'a'.repeat(36);
  const { text } = renderAgentLane({ note: `token: ${secret}` }, { redactor: spy });

  assert.equal(spy.redactValueCalls, 1, 'redactor.redactValue must run exactly once over the whole result');
  assert.ok(!text.includes(secret), 'the raw secret must never reach agent-lane output');
  assert.match(text, /«redacted:github-token»/);
});

test('renderAgentLane runs the injected redactor even when there is nothing to redact', () => {
  const spy = spyRedactor();
  renderAgentLane({ ok: true }, { redactor: spy });
  assert.equal(spy.redactValueCalls, 1);
});

// --- hardening: inert (control-character) pass-through --------------------------

test('renderAgentLane runs the injected inert function on every string leaf that reaches the text', () => {
  const calls = [];
  const inert = (s) => {
    calls.push(s);
    return s.replace(/x/g, 'X');
  };
  const { text } = renderAgentLane({ note: 'xyz' }, { redactor: realRedactor(), inert });
  assert.ok(calls.includes('xyz'));
  assert.match(text, /note Xyz/);
});

test('renderAgentLane defaults to inertLine, neutralizing control characters', () => {
  const { text } = renderAgentLane({ note: 'a\x1bb' }, { redactor: realRedactor() });
  assert.doesNotMatch(text, /\x1b/);
});

// --- metering -------------------------------------------------------------------

test('recordAgentLaneBytes returns a {type, command, bytes} record and forwards it when eventsApi.writeEvent exists', () => {
  const written = [];
  const eventsApi = { writeEvent: (payload) => written.push(payload) };
  const record = recordAgentLaneBytes(eventsApi, 'orient', 512);
  assert.deepEqual(record, { type: 'agent_lane', command: 'orient', bytes: 512 });
  assert.deepEqual(written, [record]);
});

test('recordAgentLaneBytes is safe with no eventsApi — pure computation only, never throws', () => {
  assert.deepEqual(recordAgentLaneBytes(undefined, 'status', 10), { type: 'agent_lane', command: 'status', bytes: 10 });
  assert.doesNotThrow(() => recordAgentLaneBytes(null, 'status', 0));
  assert.doesNotThrow(() => recordAgentLaneBytes({}, 'status', 0)); // no writeEvent method
});
