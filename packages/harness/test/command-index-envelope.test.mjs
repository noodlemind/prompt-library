import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { ENVELOPE_SCHEMA_VERSION, STATUS, STATUS_VALUES } from '../lib/envelope.mjs';
import { SKILLS_REL, buildCommandIndex, commandIndexEnvelope } from '../lib/command-index.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const binPath = path.join(packageRoot, 'bin', 'harness.mjs');
const tempDir = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));

function seedSkills(home, dirs) {
  for (const dir of dirs) {
    const full = path.join(home, SKILLS_REL, dir);
    fs.mkdirSync(full, { recursive: true });
    fs.writeFileSync(path.join(full, 'SKILL.md'), `---\nname: ${dir}\ndescription: does ${dir}\n---\n\nBody.\n`, 'utf8');
  }
  return home;
}

const CORPUS_INVOCABLE = ['engineer', 'harness-doctor', 'project-readme', 'triage-issues'];

function expectedSkillIds(homeDirs) {
  const ids = new Set([...homeDirs, ...CORPUS_INVOCABLE]);
  return [...ids].sort().map((id) => `skill:${id}`);
}

function runHarness(args, { cwd = packageRoot, home } = {}) {
  return spawnSync(process.execPath, [binPath, ...args], {
    cwd,
    encoding: 'utf8',
    env: home ? { ...process.env, HARNESS_HOME: home } : process.env,
  });
}

/** Every path under `root`, relative and sorted — a filesystem fingerprint. */
function listTree(root) {
  const out = [];
  const walk = (dir, prefix) => {
    for (const d of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const rel = prefix ? `${prefix}/${d.name}` : d.name;
      out.push(rel);
      if (d.isDirectory()) walk(path.join(dir, d.name), rel);
    }
  };
  walk(root, '');
  return out;
}

// --- AC10: the envelope shape --------------------------------------------

test('AC10: the index is emitted as a versioned envelope, summary scalars before detail', () => {
  const envelope = commandIndexEnvelope({ workspace: packageRoot, copilotHome: tempDir('cmdindex-env-shape-') });
    assert.deepEqual(Object.keys(envelope), [
    'schema',
    'command',
    'status',
    'surface',
    'count',
    'commands',
    'verbs',
    'skills',
    'skillsRoot',
    'collisions',
    'rows',
  ]);
  assert.equal(envelope.schema, ENVELOPE_SCHEMA_VERSION);
  assert.equal(envelope.command, 'palette');
  assert.equal(envelope.status, STATUS.OK);
  assert.ok(STATUS_VALUES.includes(envelope.status));
  assert.equal(envelope.surface, 'tui', 'the palette is the surface this index exists for');
});

test('AC10: the envelope scalars are a faithful summary of its own rows', () => {
  const workspace = tempDir('cmdindex-env-ws-');
  const copilotHome = seedSkills(tempDir('cmdindex-env-'), ['brainstorming', 'triage-issues']);
  const envelope = commandIndexEnvelope({ workspace, copilotHome });
  const index = buildCommandIndex({ surface: 'tui', workspace, copilotHome });

  assert.equal(envelope.count, envelope.rows.length);
  assert.equal(envelope.count, index.rows.length);
  assert.equal(envelope.commands + envelope.verbs + envelope.skills, envelope.count, 'every row is counted exactly once');
  for (const [kind, expected] of [['command', envelope.commands], ['verb', envelope.verbs], ['skill', envelope.skills]]) {
    assert.equal(envelope.rows.filter((r) => r.kind === kind).length, expected, `${kind} count`);
  }
  assert.deepEqual(envelope.rows.filter((row) => row.kind === 'skill').map((row) => row.id).sort(), expectedSkillIds(['brainstorming', 'triage-issues']));
  assert.equal(envelope.skills, expectedSkillIds(['brainstorming', 'triage-issues']).length);
  assert.equal(envelope.skillsRoot, SKILLS_REL);
  assert.deepEqual(envelope.collisions, index.collisions);
  assert.deepEqual(envelope.rows, index.rows);
});

test('AC10: the envelope is pure data — JSON round-trips it losslessly', () => {
  const workspace = tempDir('cmdindex-json-ws-');
  const copilotHome = seedSkills(tempDir('cmdindex-json-'), ['consolidate']);
  const envelope = commandIndexEnvelope({ workspace, copilotHome });
  const serialized = JSON.stringify(envelope);
    assert.deepEqual(JSON.parse(serialized), envelope);
  assert.equal(JSON.stringify(commandIndexEnvelope({ workspace, copilotHome })), serialized, 'byte-identical across calls');
  assert.deepEqual(envelope.collisions, ['consolidate']);
});

test('AC10: a non-tui surface envelope reports that surface and carries no skills', () => {
  const workspace = tempDir('cmdindex-envcli-ws-');
  const copilotHome = seedSkills(tempDir('cmdindex-envcli-'), ['brainstorming']);
  const envelope = commandIndexEnvelope({ surface: 'cli', workspace, copilotHome });
  assert.equal(envelope.surface, 'cli');
  assert.equal(envelope.status, STATUS.OK);
  assert.equal(envelope.skills, 0);
  assert.equal(envelope.skillsRoot, null);
  assert.ok(envelope.commands > 0 && envelope.verbs > 0);
});

// --- AC10: the CLI palette branch ----------------------------------------

test('AC10: the CLI palette branch emits parseable JSON on stdout and exits 0', () => {
  const workspace = tempDir('cmdindex-cli-ws-');
  const copilotHome = seedSkills(tempDir('cmdindex-cli-'), ['brainstorming', 'consolidate', 'recall']);
  const home = tempDir('cmdindex-cli-home-');
  const run = runHarness(['palette', '--workspace', workspace, '--copilot-home', copilotHome], { home });

  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stderr, '', 'the palette lane writes nothing to stderr');
  const payload = JSON.parse(run.stdout);

    assert.deepEqual(payload, JSON.parse(JSON.stringify(commandIndexEnvelope({ workspace, copilotHome }))));
  assert.equal(payload.command, 'palette');
  assert.equal(payload.status, 'ok');
  assert.equal(payload.schema, ENVELOPE_SCHEMA_VERSION);
  assert.deepEqual(payload.collisions, ['consolidate', 'recall']);
  assert.ok(payload.rows.some((r) => r.id === 'skill:brainstorming'));
  // Multi-verb families fold on the TUI palette into one sheet row.
  const knowledge = payload.rows.find((r) => r.id === 'command:knowledge');
  assert.ok(knowledge, 'knowledge stays on the palette');
  assert.equal(knowledge.picker, 'verbs', 'its verbs open via the action sheet, not as top-level rows');
  assert.equal(payload.rows.some((r) => r.id === 'verb:knowledge:promote'), false);

    assert.deepEqual(fs.readdirSync(workspace), []);
  assert.deepEqual(listTree(home), []);
  assert.ok(fs.existsSync(path.join(copilotHome, 'skills', 'brainstorming', 'SKILL.md')));
});

test('AC10: the CLI palette branch reads corpus skills when the Copilot home has none', () => {
  const workspace = tempDir('cmdindex-cli-bare-');
  const copilotHome = tempDir('cmdindex-cli-bare-copilot-');
  const home = tempDir('cmdindex-cli-bare-home-');
  const run = runHarness(['palette', '--workspace', workspace, '--copilot-home', copilotHome], { home });

  assert.equal(run.status, 0, run.stderr);
  const payload = JSON.parse(run.stdout);
  assert.deepEqual(payload.rows.filter((row) => row.kind === 'skill').map((row) => row.id).sort(), expectedSkillIds([]));
  assert.equal(payload.skills, CORPUS_INVOCABLE.length);
  assert.equal(payload.skillsRoot, SKILLS_REL);
  assert.deepEqual(payload.collisions, []);
  assert.ok(payload.commands > 0, 'commands are still enumerated');
  assert.deepEqual(fs.readdirSync(workspace), [], 'nothing was created in the workspace');
  assert.deepEqual(fs.readdirSync(copilotHome), [], 'nothing was created in the Copilot home');
  assert.deepEqual(listTree(home), [], 'nothing was created under the harness home');
});

test('AC10: palette output is stable across invocations', () => {
  const workspace = tempDir('cmdindex-cli-stable-ws-');
  const copilotHome = seedSkills(tempDir('cmdindex-cli-stable-'), ['alpha', 'beta']);
  const first = runHarness(['palette', '--workspace', workspace, '--copilot-home', copilotHome]);
  const second = runHarness(['palette', '--workspace', workspace, '--copilot-home', copilotHome]);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(second.status, 0, second.stderr);
  assert.equal(first.stdout, second.stdout, 'same registry + same skills ⇒ byte-identical bytes on the wire');
});
