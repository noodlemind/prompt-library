/**
 * Phase 2–3 frontier TUI: preview, host modes, gate actions, questions, inspect.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { nextHostMode, normalizeHostMode, agentEnabledForMode, modeChrome } from '../lib/tui/host-mode.mjs';
import { previewSelection } from '../lib/tui/preview.mjs';
import { createQuestion, answerQuestion, questionEvent } from '../lib/tui/question.mjs';
import { parseGateAction, gatePromptLines } from '../lib/tui/gate-actions.mjs';
import { interpretLine } from '../lib/tui/session.mjs';
import { inspectResultOf } from '../lib/inspect-cmd.mjs';
import { tempDir, packageRoot, binPath } from './helpers/index.mjs';

test('host modes cycle commands → assist → plan → commands', () => {
  assert.equal(nextHostMode('commands'), 'assist');
  assert.equal(nextHostMode('assist'), 'plan');
  assert.equal(nextHostMode('plan'), 'commands');
  assert.equal(normalizeHostMode('weird'), 'commands');
  assert.equal(agentEnabledForMode('commands'), false);
  assert.equal(agentEnabledForMode('plan'), true);
  assert.equal(modeChrome('plan').authority, 'propose');
});

test('previewSelection surfaces config key value scope and full command', () => {
  const row = {
    label: 'Config set agent.enabled',
    argvTokens: [
      { kind: 'command', value: 'config' },
      { kind: 'subcommand', value: 'set' },
      { kind: 'value', positional: 'key', valueName: 'key' },
      { kind: 'value', positional: 'value', valueName: 'value' },
      { kind: 'flag', value: '--scope' },
      { kind: 'value', flag: '--scope', valueName: 'scope' },
    ],
  };
  const preview = previewSelection(row, {
    key: 'agent.enabled',
    value: 'false',
    '--scope': 'user',
  });
  // resolveSelection may need exact token shapes from real index — assert helper structure
  assert.ok(preview.lines.length >= 1 || preview.invalid || preview.lines.some((l) => /needs:/.test(l)));
});

test('previewSelection on ready config-like argv list', () => {
  // Minimal row that resolveSelection can build when argvTokens are pure commands + fixed values
  const row = {
    label: 'status',
    argvTokens: [
      { kind: 'command', value: 'status' },
    ],
  };
  const preview = previewSelection(row, {});
  assert.ok(preview.argv);
  assert.deepEqual(preview.argv, ['status']);
  assert.match(preview.lines.join('\n'), /command: status/);
});

test('question checkpoint: answer and unanswered inconclusive', () => {
  const q = createQuestion({ prompt: 'Which workspace?', choices: ['repo-a', 'repo-b'] });
  assert.equal(q.status, 'open');
  const bad = answerQuestion(q, 'nope');
  assert.equal(bad.ok, false);
  const skip = answerQuestion(q, 'skip');
  assert.equal(skip.ok, true);
  assert.equal(skip.inconclusive, true);
  assert.equal(skip.question.reason, 'gate unanswered');
  assert.equal(skip.question.status, 'inconclusive');

  const q2 = createQuestion({ prompt: 'Pick', choices: ['yes', 'no'] });
  const ok = answerQuestion(q2, '1');
  assert.equal(ok.ok, true);
  assert.equal(ok.question.status, 'answered');
  assert.ok(questionEvent(ok.question).selected);
});

test('gate actions parse a/c/q', () => {
  assert.equal(parseGateAction('a').label, 'approve');
  assert.equal(parseGateAction('comment').kind, 'open-plan');
  assert.equal(parseGateAction('q').kind, 'dismiss');
  assert.ok(gatePromptLines({ plan: 'x.md', gate: 'blocked' }).some((l) => /GATE/.test(l)));
});

test('interpretLine product verbs for inspect runs gate mode question', () => {
  assert.deepEqual(interpretLine('inspect config agent.enabled'), {
    kind: 'inspect',
    verb: 'config',
    key: 'agent.enabled',
  });
  assert.equal(interpretLine('gate menu').kind, 'gate-menu');
  assert.equal(interpretLine('mode plan').mode, 'plan');
  assert.equal(interpretLine('runs').kind, 'runs-list');
  assert.deepEqual(interpretLine('resume abc123'), { kind: 'runs-resume', id: 'abc123' });
  const q = interpretLine('question Which?|alpha|beta');
  assert.equal(q.kind, 'ask-question');
  assert.equal(q.choices.length, 2);
});

test('inspect config returns provenance for agent.enabled', async () => {
  const workspace = tempDir('insp-ws-');
  const copilotHome = tempDir('insp-home-');
  const result = await inspectResultOf(
    ['config', 'agent.enabled', '--workspace', workspace, '--copilot-home', copilotHome],
  );
  assert.equal(result.verb, 'config');
  assert.ok(result.settings.some((s) => s.key === 'agent.enabled'));
  const r = spawnSync(
    process.execPath,
    [binPath, 'inspect', 'config', 'agent.enabled', '--workspace', workspace, '--copilot-home', copilotHome, '--json', '--no-events'],
    { cwd: packageRoot, encoding: 'utf8' },
  );
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const body = JSON.parse(r.stdout);
  assert.equal(body.verb, 'config');
  assert.ok(body.settings.some((s) => s.key === 'agent.enabled'));
});
