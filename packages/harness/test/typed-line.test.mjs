import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { runLedger } from '../lib/tui-cmd.mjs';
import { routeTypedLine } from '../lib/tui/typed-line.mjs';
import { selectionPlan } from '../lib/tui/palette.mjs';
import { buildCommandIndex } from '../lib/command-index.mjs';
import { getCommand, validateArgs } from '../lib/registry.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const index = buildCommandIndex({ surface: 'tui', workspace: packageRoot });
const route = (argv) => routeTypedLine(argv, { workspace: packageRoot, index });
const asks = (routed) => routed.plan.queue.map((q) => q.label);

/** Drive the whole loop over strings. An isolated copilot home per call, so
 * every key comes from its declared default rather than from whatever this
 * machine happens to hold. */
async function ledger(lines, { workspace = packageRoot, copilotHome } = {}) {
  const input = new PassThrough();
  const output = new PassThrough();
  let text = '';
  output.on('data', (c) => { text += c.toString(); });
  const done = runLedger({ input, output, workspace, copilotHome, argv: ['--no-color', '--no-events'] });
  for (const line of lines) input.write(`${line}\n`);
  input.end();
  await done;
  return text;
}

// --- the reported divergence ----------------------------------------------

test('a typed line asks for exactly what the palette asks for', () => {
  const typed = route(['config', 'set']);
  assert.ok(typed, 'typing the command the palette offers must not dead-end in a usage error');

  const row = index.rows.find((r) => r.label === 'config set');
  const chosen = selectionPlan(row, {});
  assert.deepEqual(asks(typed), chosen.queue.map((q) => q.label),
    'the two paths must answer "what does this still need" identically — that they did not is the whole defect');
});

test('words already typed are carried into the queue, not thrown away', () => {
  const routed = route(['config', 'set', 'tui.scheme']);
  assert.ok(routed);
  assert.deepEqual(routed.values, { key: 'tui.scheme' });
  assert.equal(asks(routed).includes('key'), false, 'it must not ask again for something already typed');
  assert.ok(asks(routed).includes('value'));
});

test('a command whose required values are flags routes too', () => {
  const routed = route(['edit']);
  assert.ok(routed, 'edit declares --path/--old/--new as required; typing it bare must offer them');
  assert.deepEqual(asks(routed), ['path', 'old', 'new']);
});

test('a folded picker command opens its picker rather than listing thirteen ids', () => {
  const routed = route(['model', 'set']);
  assert.equal(routed?.picker, 'model',
    'typed `model set` answered with a usage error naming every provider — the wall of enum the picker replaces');
  assert.equal(route(['model']), null, 'a bare `model` prints the catalogue, which is a real answer and not a dead end');
});

test('a flag the palette renders as a word is reachable by that word', () => {
  const routed = route(['consolidate', 'apply']);
  assert.ok(routed, 'the palette row is labelled `consolidate apply`, so that is what an operator types');
  assert.ok(asks(routed).includes('ops'));
});

// --- what must still fail --------------------------------------------------

test('a line that runs is never rerouted', () => {
  for (const argv of [['status'], ['config', 'show'], ['orient'], ['undo']]) {
    assert.equal(route(argv), null, `${argv.join(' ')} runs as typed and must dispatch`);
  }
});

test('a mistake stays a mistake — a picker over it would hide it', () => {
  assert.equal(route(['get', '--nope']), null, 'an unknown flag has a precise answer; a value picker is not it');
  assert.equal(route(['config', 'bogusverb']), null, 'a value the registry states outright and the operator got wrong');
  assert.equal(route(['bash', '--', 'echo hi']), null, 'everything past `--` is payload, not a gap');
  assert.equal(route(['config', 'set', 'a', 'b', 'c']), null, 'more words than the command has places to put them');
  assert.equal(route(['definitely-not-a-command']), null);
  assert.equal(route([]), null);
});

test('hand-typed flag syntax is left to the CLI parser', () => {
  assert.equal(route(['config', 'set', '--scope', 'user']), null,
    'someone writing flags is speaking CLI, and validateArgs answers them precisely');
});

// --- the general claim -----------------------------------------------------

/** The words an operator reads off a palette row and types back. A flag row is
 * labelled `consolidate apply`, so its word is `apply`. */
function paletteWords(row) {
  const words = [];
  for (const token of row.argvTokens || []) {
    if (token.kind === 'command' || token.kind === 'subcommand') words.push(token.value);
    else if (token.kind === 'flag') words.push(String(token.value).replace(/^-+/, ''));
    else break;
  }
  return words;
}

/** Would dispatch accept the bare form, before any handler runs? */
function validates(argv) {
  const [name, ...rest] = argv;
  const entry = getCommand(name);
  if (!entry) return false;
  try {
    validateArgs(entry, rest);
    if (typeof entry.requireArgs === 'function' && entry.requireArgs(rest, {})) return false;
  } catch {
    return false;
  }
  return true;
}

test('no palette row dead-ends when typed', () => {
  const dead = [];
  let runnable = 0;
  let routed = 0;
  for (const row of index.rows) {
    if (row.kind === 'skill') continue;
    const words = paletteWords(row);
    if (!words.length) continue;
    const argvWords = (row.argvTokens || [])
      .filter((t) => t.kind === 'command' || t.kind === 'subcommand')
      .map((t) => t.value);
    const needsValues = (row.argvTokens || []).some((t) => t.kind === 'value' && t.required !== false)
      || (row.prompts || []).some((p) => p.required);
    if (validates(argvWords) && !needsValues) { runnable += 1; continue; }
    if (route(words)) { routed += 1; continue; }
    dead.push(row.label);
  }
  assert.deepEqual(dead, [], 'every one of these prints a usage error where the palette would have asked a question');
  assert.ok(runnable > 20 && routed > 20, `the split must be real, not an empty sweep (${runnable} run, ${routed} routed)`);
});

// --- the other half of "both modes work" ----------------------------------

test('with the agent off, a sentence is answered with the gesture that enables it', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'typed-line-home-'));
  const text = await ledger(['what does this repo do'], { copilotHome: home });

  assert.match(text, /agent mode is off/);
  assert.match(text, /shift\+tab/, 'a refusal that does not say how to proceed is a dead end with better manners');
  assert.doesNotMatch(text, /unknown command: what/);
});

test('a single unknown word is still a typo, not a question', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'typed-line-home-b-'));
  const text = await ledger(['frobnicate'], { copilotHome: home });

  assert.doesNotMatch(text, /agent mode is off/, 'nobody typos one word into a sentence they meant to ask');
  assert.match(text, /unknown/);
});

test('the ledger builds the routing index once, not per typed line', () => {
  const source = fs.readFileSync(path.join(packageRoot, 'lib', 'tui-cmd.mjs'), 'utf8');
  assert.match(source, /routeTypedLine\(parsed\.argv, \{ workspace, index: indexForRouting\(\) \}\)/);
  assert.match(source, /routingIndex \?\?= buildCommandIndex/, 'built lazily and kept for the session');
});

test('the ledger calls the router — the audit above is not checking a dead module', () => {
  const source = fs.readFileSync(path.join(packageRoot, 'lib', 'tui-cmd.mjs'), 'utf8');
  assert.match(source, /routeTypedLine\(parsed\.argv/, 'a routing rule nothing calls is a rule that does not exist');
});
