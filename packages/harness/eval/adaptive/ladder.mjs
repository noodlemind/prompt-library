/**
 * Adaptive ladder. Each rung spawns bin/harness.mjs in its own temp homes.
 * The TUI is out. No model runs. Two rungs record the current verify contract
 * for an omitted symbol and an instruction that is not a diff predicate.
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  createFixture,
  exists,
  expectExit,
  git,
  harness,
  head,
  hook,
  hookBody,
  initRepo,
  parseBody,
  readSession,
  writeChecks,
  writePlan,
  writePolicy,
  writeRouting,
} from './fixture.mjs';

const SLICE_KEYS = [
  'neighborhood',
  'learnings',
  'skills',
  'instructions',
  'contacts',
  'index',
  'gateStatus',
  'activePlan',
];

const CLAIM = 'save skips the audit stamp';
const APPLIES = 'A save writes the audit stamp on the stored row.';
const DOES_NOT = 'A task asks to remove the audit stamp.';
const WHY = 'the row lands without the stamp';
const PASSING_CHECK = { command: [process.execPath, '-e', 'process.exit(0)'] };
const BAD = 'function replaceRow(row) { store.write(row); return row; }\n';
const CLEAR = 'export const value = 2;\n';

function fail(message, evidence) {
  const error = new Error(message);
  error.evidence = evidence;
  throw error;
}

function assert(condition, message, evidence) {
  if (!condition) fail(message, evidence);
}

function passingChecks(proof) {
  const check = { ...PASSING_CHECK };
  if (proof) check.proof = proof;
  return { 'unit-tests': check };
}

function prepare(fx, { impacted = ['src/example.js'], proof, files } = {}) {
  const checks = passingChecks(proof);
  writeChecks(fx, checks);
  const plan = writePlan(fx, { required: ['unit-tests'], impacted });
  initRepo(fx, files);
  expectExit(harness(fx, ['trust', 'approve']), 0, 'trust approve');
  return plan;
}

function passGate(fx, plan) {
  expectExit(harness(fx, ['gate', '--phase', 'implement', '--plan', plan]), 0, 'gate');
  const session = readSession(fx);
  assert(session?.gateStatus === 'pass' && session.gatedPlan && session.lastGateAt, 'implement gate was not stamped', session);
  return session;
}

function teach(fx, { authority, shows, claim = CLAIM }) {
  expectExit(harness(fx, ['knowledge', 'on']), 0, 'knowledge on');
  const args = [
    'correct', claim,
    '--trigger', claim,
    '--why', WHY,
    '--applies', APPLIES,
    '--does-not-apply', DOES_NOT,
    '--authority', authority,
    '--domain', 'sql',
  ];
  if (shows != null) args.push('--shows', shows);
  return expectExit(harness(fx, args), 0, `correct ${authority}`);
}

function arm(fx, files = ['src/example.js']) {
  const body = expectExit(harness(fx, [
    'orient', '--read', '--query', CLAIM, ...files.flatMap((file) => ['--file', file]),
  ]), 0, 'orient --read');
  assert(exists(fx, '.harness/repo-map.md') === false, 'orient --read wrote a repo map');
  assert(exists(fx, '.harness/context-pack.md') === false, 'orient --read wrote a context pack');
  return body;
}

function verify(fx, plan) {
  return harness(fx, ['verify', '--plan', plan, '--base', 'HEAD']);
}

function writeSource(fx, rel, body) {
  fs.writeFileSync(path.join(fx.workspace, rel), body);
}

function recordEdit(fx, rel) {
  return hookBody(hook(fx, 'record-successful-edit.mjs', {
    tool_name: 'replace_string_in_file',
    tool_input: { file_path: rel, filePath: rel },
  }));
}

function stop(fx) {
  return hookBody(hook(fx, 'require-verification.mjs', {
    hook_event_name: 'Stop',
    stop_hook_active: false,
  }));
}

function editHook(fx, rel) {
  return hookBody(hook(fx, 'require-plan-gate.mjs', {
    tool_name: 'replace_string_in_file',
    tool_input: { file_path: rel, filePath: rel },
  }));
}

function hookDecision(body) {
  return body.hookSpecificOutput || body;
}

function trustState(fx) {
  const body = expectExit(harness(fx, ['trust', 'status']), 0, 'trust status');
  return body;
}

const RUNGS = [
  {
    id: 'trust-untrusted',
    ladder: 'trust',
    run(fx) {
      const bare = expectExit(harness(fx, ['trust']), 0, 'bare trust');
      const status = trustState(fx);
      assert(bare.state === 'untrusted', 'bare trust changed the state', bare);
      assert(status.state === 'untrusted' && status.trusted === false, 'status is not untrusted', status);
      assert(/never been approved/.test(status.reason || ''), 'untrusted reason missing', status);
      return { state: status.state };
    },
  },
  {
    id: 'trust-checks-denied',
    ladder: 'trust',
    run(fx) {
      writeChecks(fx, passingChecks());
      const denied = harness(fx, ['checks', 'run', 'unit-tests']);
      const body = parseBody(denied);
      assert(denied.status === 4, 'untrusted checks run should exit 4', { status: denied.status, body, stderr: denied.stderr });
      assert(/not trusted/.test(`${denied.stdout}\n${denied.stderr}`), 'denial did not say the project is not trusted', body);
      return { exit: denied.status };
    },
  },
  {
    id: 'trust-approve',
    ladder: 'trust',
    run(fx) {
      expectExit(harness(fx, ['trust', 'approve']), 0, 'trust approve');
      const status = trustState(fx);
      assert(status.state === 'trusted' && status.trusted === true, 'approve did not trust the project', status);
      return { state: status.state };
    },
  },
  {
    id: 'trust-checks-run',
    ladder: 'trust',
    run(fx) {
      writeChecks(fx, passingChecks());
      expectExit(harness(fx, ['trust', 'approve']), 0, 'trust approve');
      const ran = expectExit(harness(fx, ['checks', 'run', 'unit-tests']), 0, 'checks run');
      assert(ran.status === 'ok' || ran.outcome?.status === 'passed', 'named check did not pass', ran);
      return { status: ran.status || ran.outcome?.status };
    },
  },
  {
    id: 'trust-stale-refuses',
    ladder: 'trust',
    run(fx) {
      writeChecks(fx, passingChecks());
      expectExit(harness(fx, ['trust', 'approve']), 0, 'trust approve');
      fs.appendFileSync(path.join(fx.workspace, '.github', 'harness', 'checks.yaml'), '\n# edited after approval\n');
      const status = trustState(fx);
      assert(status.state === 'stale' && status.trusted === false, 'edited pin did not go stale', status);
      const denied = harness(fx, ['checks', 'run', 'unit-tests']);
      assert(denied.status === 4, 'stale project still ran a named check', { status: denied.status, stderr: denied.stderr });
      return { state: status.state, exit: denied.status };
    },
  },
  {
    id: 'trust-revoked-refuses',
    ladder: 'trust',
    run(fx) {
      writeChecks(fx, passingChecks());
      expectExit(harness(fx, ['trust', 'approve']), 0, 'trust approve');
      expectExit(harness(fx, ['trust', 'revoke']), 0, 'trust revoke');
      const status = trustState(fx);
      assert(status.state === 'revoked' && status.trusted === false, 'revoke did not stick', status);
      const denied = harness(fx, ['checks', 'run', 'unit-tests']);
      assert(denied.status === 4, 'revoked project still ran a named check', { status: denied.status, stderr: denied.stderr });
      return { state: status.state };
    },
  },
  {
    id: 'trust-policy-ignored',
    ladder: 'trust',
    run(fx) {
      writePolicy(fx, 'observe');
      writeChecks(fx, passingChecks());
      const plan = writePlan(fx);
      initRepo(fx);
      const body = parseBody(verify(fx, plan));
      assert(body?.enforcement === 'enforce', 'untrusted policy was applied', body);
      assert(body?.projectPolicyIgnored === true, 'untrusted policy was not marked ignored', body);
      return { enforcement: body.enforcement, projectPolicyIgnored: true };
    },
  },
  {
    id: 'trust-route-skipped',
    ladder: 'trust',
    run(fx) {
      writeRouting(fx);
      const plan = writePlan(fx);
      const body = expectExit(harness(fx, ['route', '--plan', plan]), 0, 'route');
      assert(body.live?.skipped === true, 'untrusted route was evaluated', body);
      assert(body.live?.reason === 'project is not trusted', 'route skip reason changed', body);
      return { reason: body.live.reason };
    },
  },
  {
    id: 'orient-cold',
    ladder: 'orient',
    run(fx) {
      const body = expectExit(harness(fx, ['orient', '--read']), 0, 'cold orient --read');
      assert(JSON.stringify(Object.keys(body)) === JSON.stringify(SLICE_KEYS), 'cold slice keys changed', body);
      assert(body.neighborhood === null, 'cold neighborhood was filled', body);
      assert(body.gateStatus === 'blocked', 'cold gate was not blocked', body);
      assert(body.activePlan === null, 'cold read selected a plan', body);
      assert(Array.isArray(body.learnings) && body.learnings.length === 0, 'cold read served learnings', body);
      assert(body.index?.knowledge === 'missing' && body.index?.structural === 'missing', 'cold index was not missing', body);
      assert(readSession(fx) === null, 'cold read wrote a session', readSession(fx));
      assert(exists(fx, '.harness/repo-map.md') === false, 'cold read wrote a repo map');
      assert(exists(fx, '.harness/context-pack.md') === false, 'cold read wrote a context pack');
      return { keys: SLICE_KEYS };
    },
  },
  {
    id: 'orient-read-stores',
    ladder: 'orient',
    run(fx) {
      fs.mkdirSync(path.join(fx.workspace, '.harness'), { recursive: true });
      fs.writeFileSync(path.join(fx.workspace, '.harness', 'session.json'), `${JSON.stringify({ version: 1, activePlan: 'docs/plans/keep.md' })}\n`);
      const body = expectExit(harness(fx, [
        'orient', '--read', '--query', 'compile the weekly report', '--file', 'src/example.js',
      ]), 0, 'ranked orient --read');
      assert(JSON.stringify(Object.keys(body)) === JSON.stringify(SLICE_KEYS), 'ranked slice keys changed', body);
      const session = readSession(fx);
      assert(session.lastQuery === 'compile the weekly report', 'lastQuery was not stored', session);
      assert(JSON.stringify(session.files) === JSON.stringify(['src/example.js']), 'file list was not stored', session);
      assert(session.activePlan === 'docs/plans/keep.md', 'orient --read dropped the active plan', session);
      assert(exists(fx, '.harness/repo-map.md') === false, 'ranked read wrote a repo map');
      assert(exists(fx, '.harness/context-pack.md') === false, 'ranked read wrote a context pack');
      return { lastQuery: session.lastQuery, files: session.files };
    },
  },
  {
    id: 'authority-inference-provisional',
    ladder: 'authority',
    run(fx) {
      const taught = teach(fx, { authority: 'inference' });
      const why = expectExit(harness(fx, ['learnings', '--why', taught.learningId]), 0, 'learnings --why');
      assert(why.status === 'provisional', 'inference became active', why);
      return { id: taught.learningId, status: why.status };
    },
  },
  {
    id: 'authority-correction-needs-shows',
    ladder: 'authority',
    run(fx) {
      expectExit(harness(fx, ['knowledge', 'on']), 0, 'knowledge on');
      const refused = harness(fx, [
        'correct', CLAIM,
        '--trigger', CLAIM,
        '--why', WHY,
        '--applies', APPLIES,
        '--does-not-apply', DOES_NOT,
        '--authority', 'correction',
        '--domain', 'sql',
      ]);
      const body = parseBody(refused);
      assert(refused.status === 2, 'correction without --shows should exit 2', { status: refused.status, body });
      assert(/needs --shows/.test(`${refused.stdout}\n${refused.stderr}`), 'refusal did not ask for --shows', body);
      return { exit: refused.status };
    },
  },
  {
    id: 'verify-shows-on-added-line',
    ladder: 'verify',
    run(fx) {
      const plan = prepare(fx);
      teach(fx, { authority: 'correction', shows: 'replaceRow' });
      passGate(fx, plan);
      arm(fx);
      writeSource(fx, 'src/example.js', BAD);
      const repeated = verify(fx, plan);
      const body = parseBody(repeated);
      assert(repeated.status === 2, 'added replaceRow should exit 2', { status: repeated.status, body });
      assert(body?.outcome === 'repeated-mistake', 'added replaceRow was not a repeated mistake', body);
      return { outcome: body.outcome, exit: repeated.status };
    },
  },
  {
    id: 'verify-deleted-symbol-passes',
    ladder: 'verify',
    run(fx) {
      const plan = prepare(fx);
      teach(fx, { authority: 'correction', shows: 'replaceRow' });
      writeSource(fx, 'src/example.js', BAD);
      assert(git(fx, ['add', 'src/example.js']).status === 0, 'git add failed');
      assert(git(fx, ['commit', '-qm', 'plant the refused call']).status === 0, 'git commit failed');
      writeSource(fx, 'src/example.js', CLEAR);
      passGate(fx, plan);
      arm(fx);
      const cleared = verify(fx, plan);
      const body = expectExit(cleared, 0, 'deleted-only verify');
      assert(body.outcome === 'passed', 'a deleted symbol was treated as a repeat', body);
      return { outcome: body.outcome };
    },
  },
  {
    id: 'verify-omission-stays-passed',
    ladder: 'verify',
    run(fx) {
      const plan = prepare(fx);
      teach(fx, { authority: 'correction', shows: 'RequiredToken' });
      passGate(fx, plan);
      arm(fx);
      writeSource(fx, 'src/example.js', CLEAR);
      const body = expectExit(verify(fx, plan), 0, 'omission verify');
      assert(body.outcome === 'passed', 'omission contract changed', body);
      return { outcome: body.outcome, gap: 'omission-stays-passed' };
    },
  },
  {
    id: 'verify-instruction-stays-passed',
    ladder: 'verify',
    run(fx) {
      const plan = prepare(fx);
      teach(fx, { authority: 'instruction' });
      passGate(fx, plan);
      arm(fx);
      writeSource(fx, 'src/example.js', `${CLEAR}${CLAIM}\n`);
      const body = expectExit(verify(fx, plan), 0, 'instruction verify');
      assert(body.outcome === 'passed', 'instruction contract changed', body);
      return { outcome: body.outcome, gap: 'instruction-is-not-a-diff-predicate' };
    },
  },
  {
    id: 'verify-evidence-binds-head',
    ladder: 'verify',
    run(fx) {
      const plan = prepare(fx);
      const body = expectExit(verify(fx, plan), 0, 'verify');
      assert(body.outcome === 'passed', 'clean verify did not pass', body);
      const evidence = JSON.parse(fs.readFileSync(path.join(fx.workspace, body.evidencePath), 'utf8'));
      const current = head(fx);
      assert(evidence.version === 3, 'evidence version is not 3', evidence);
      assert(evidence.binding?.head === current, 'evidence head does not match git HEAD', { bound: evidence.binding?.head, current });
      return { version: evidence.version, head: current };
    },
  },
  {
    id: 'verify-type-check-only',
    ladder: 'verify',
    run(fx) {
      const plan = prepare(fx, { proof: 'type-check' });
      const checked = verify(fx, plan);
      const body = parseBody(checked);
      assert(checked.status === 2, 'type-check-only should exit 2', { status: checked.status, body });
      assert(body?.outcome === 'type-check-only', 'type-check proof was treated as passed', body);
      passGate(fx, plan);
      recordEdit(fx, 'src/example.js');
      const blocked = stop(fx);
      const decision = hookDecision(blocked);
      assert(decision.decision === 'block', 'type-check-only stop continued', blocked);
      assert(/type-check-only/.test(decision.reason || ''), 'stop did not name type-check-only', blocked);
      return { outcome: body.outcome, stop: decision.decision };
    },
  },
  {
    id: 'parallel-workspaces',
    ladder: 'parallel',
    run(fx) {
      const other = createFixture('writer-b');
      try {
        expectExit(harness(fx, ['orient', '--read', '--query', 'edit the left file', '--file', 'src/left.js']), 0, 'left orient');
        expectExit(harness(other, ['orient', '--read', '--query', 'edit the right file', '--file', 'src/right.js']), 0, 'right orient');
        const left = readSession(fx);
        const right = readSession(other);
        assert(JSON.stringify(left.files) === JSON.stringify(['src/left.js']), 'left writer lost its file', left);
        assert(JSON.stringify(right.files) === JSON.stringify(['src/right.js']), 'right writer lost its file', right);
        assert(left.lastQuery !== right.lastQuery, 'writers share a query', { left, right });
        assert(fx.workspace !== other.workspace, 'writers share a workspace');
        assert(fx.harnessHome !== other.harnessHome, 'writers share a harness home');
        return { left: left.files, right: right.files };
      } finally {
        other.cleanup();
      }
    },
  },
  {
    id: 'parallel-exclusive-file',
    ladder: 'parallel',
    run(fx) {
      const plan = prepare(fx, {
        impacted: ['src/left.js', 'src/right.js'],
        files: {
          'src/left.js': 'export const left = 1;\n',
          'src/right.js': 'export const right = 1;\n',
        },
      });
      passGate(fx, plan);
      arm(fx, ['src/left.js']);
      const allowed = editHook(fx, 'src/left.js');
      assert(hookDecision(allowed).permissionDecision !== 'deny', 'listed file was denied', allowed);
      const denied = editHook(fx, 'src/right.js');
      const decision = hookDecision(denied);
      assert(decision.permissionDecision === 'deny', 'the other impacted file was allowed', denied);
      assert(/outside-exclusive-files/.test(decision.permissionDecisionReason || ''), 'denial was not the exclusive file list', denied);
      return { denied: 'src/right.js' };
    },
  },
  {
    id: 'stop-between-units',
    ladder: 'parallel',
    run(fx) {
      const plan = prepare(fx);
      teach(fx, { authority: 'correction', shows: 'replaceRow' });
      writeSource(fx, 'src/example.js', BAD);
      passGate(fx, plan);
      recordEdit(fx, 'src/example.js');
      arm(fx);
      const blocked = stop(fx);
      const denial = hookDecision(blocked);
      assert(denial.decision === 'block', 'stop continued after the refused symbol', blocked);
      assert(/repeated-mistake/.test(denial.reason || ''), 'stop did not name repeated-mistake', blocked);
      assert(/harness correct/.test(denial.reason || ''), 'stop did not name harness correct', blocked);
      writeSource(fx, 'src/example.js', CLEAR);
      const passed = expectExit(verify(fx, plan), 0, 'cleared verify');
      assert(passed.outcome === 'passed', 'cleared diff did not pass', passed);
      const continued = stop(fx);
      assert(continued.continue === true, 'stop blocked a passed unit', continued);
      assert(hookDecision(continued).decision !== 'block', 'passed stop still blocked', continued);
      return { blocked: 'repeated-mistake', continued: true };
    },
  },
];

export const RUNG_IDS = RUNGS.map((rung) => rung.id);

export function runLadder() {
  const results = [];
  for (const rung of RUNGS) {
    const fx = createFixture(rung.id);
    try {
      const evidence = rung.run(fx);
      results.push({ id: rung.id, ladder: rung.ladder, ok: true, evidence });
    } catch (error) {
      results.push({
        id: rung.id,
        ladder: rung.ladder,
        ok: false,
        evidence: { error: error.message, ...(error.evidence || {}) },
      });
    } finally {
      fx.cleanup();
    }
  }
  return { ok: results.every((row) => row.ok), results };
}
