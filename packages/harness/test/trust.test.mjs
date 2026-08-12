import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import {
  PINNED_FILES,
  approveProject,
  isProjectTrusted,
  policyDigest,
  revokeProject,
  trustStatus,
  trustStorePath,
} from '../lib/trust.mjs';
import { loadPolicy } from '../lib/policy.mjs';
import { resolveConfig } from '../lib/config.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const binPath = path.join(packageRoot, 'bin', 'harness.mjs');

function tempDir(prefix) {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function scopes() {
  return { workspace: tempDir('trust-ws-'), copilotHome: tempDir('trust-home-') };
}

function writeProjectFile({ workspace }, rel, body) {
  const full = path.join(workspace, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, body);
}

function run(argv, { workspace, copilotHome }) {
  return spawnSync(process.execPath, [binPath, ...argv, '--workspace', workspace, '--copilot-home', copilotHome, '--no-events'], {
    cwd: packageRoot,
    encoding: 'utf8',
  });
}

test('a fresh project is untrusted, and says why', () => {
  const s = scopes();
  const status = trustStatus(s);
  assert.equal(status.state, 'untrusted');
  assert.equal(status.trusted, false);
  assert.match(status.reason, /never been approved/);
});

test('the trust record lives in the user scope, never in the workspace', () => {
  const s = scopes();
  approveProject(s);
  assert.ok(fs.existsSync(trustStorePath(s.copilotHome)), 'the approval belongs to the user home');
  const strayInWorkspace = fs.existsSync(path.join(s.workspace, '.harness', 'trust.yaml'))
    || fs.existsSync(path.join(s.workspace, '.github', 'harness', 'trust.yaml'));
  assert.equal(strayInWorkspace, false, 'a project that can ship its own approval is self-certifying');
});

test('a project cannot grant itself trust by writing a trust file', () => {
  const s = scopes();
  writeProjectFile(s, path.join('.github', 'harness', 'trust.yaml'), 'projects:\n  "/": {status: trusted}\n');
  writeProjectFile(s, path.join('.harness', 'trust.yaml'), 'projects:\n  "/": {status: trusted}\n');
  assert.equal(isProjectTrusted(s), false, 'only the user-scope store may grant trust');
});

test('approval is pinned to content — editing a pinned file makes trust stale', () => {
  const s = scopes();
  writeProjectFile(s, PINNED_FILES[1], 'version: 1\nenforcement: warn\n');
  approveProject(s);
  assert.equal(trustStatus(s).state, 'trusted');

  writeProjectFile(s, PINNED_FILES[1], 'version: 1\nenforcement: observe\n');
  const after = trustStatus(s);
  assert.equal(after.state, 'stale', 'a pull that changes policy must not ride an old approval');
  assert.equal(after.trusted, false, 'stale grants nothing — that is the point of pinning');
  assert.match(after.reason, /changed since/);
});

// Skipping absent files would let a repository gain authority after approval.
test('ADDING a policy file to an approved project invalidates the approval', () => {
  const s = scopes();
  approveProject(s);
  assert.equal(trustStatus(s).state, 'trusted');
  writeProjectFile(s, PINNED_FILES[1], 'version: 1\nenforcement: observe\n');
  assert.equal(trustStatus(s).state, 'stale', 'a file that did not exist at approval time is new authority');
});

test('re-approving after a change restores trust', () => {
  const s = scopes();
  writeProjectFile(s, PINNED_FILES[0], 'version: 1\nexec.bash_enabled: false\n');
  approveProject(s);
  writeProjectFile(s, PINNED_FILES[0], 'version: 1\nexec.bash_enabled: true\n');
  assert.equal(trustStatus(s).state, 'stale');
  approveProject(s);
  assert.equal(trustStatus(s).state, 'trusted');
});

test('revoke is recorded as a decision, not as an absence', () => {
  const s = scopes();
  approveProject(s);
  revokeProject(s);
  const status = trustStatus(s);
  assert.equal(status.state, 'revoked');
  assert.equal(status.trusted, false);
  assert.match(status.reason, /explicitly revoked/,
    'a deliberate revocation must not read back later as "never decided"');
});

// Damaging the file must not become a way around every approval it held.
test('an unreadable trust store denies rather than grants', () => {
  const s = scopes();
  approveProject(s);
  fs.writeFileSync(trustStorePath(s.copilotHome), 'projects: [this: is: not: a: mapping\n');
  assert.equal(isProjectTrusted(s), false);
  assert.throws(() => approveProject(s), (e) => e.code === 'E_TARGET',
    'overwriting it would silently discard every approval it holds');
});

test('two spellings of the same directory are one project', () => {
  const s = scopes();
  approveProject(s);
  const viaDot = { workspace: path.join(s.workspace, '.'), copilotHome: s.copilotHome };
  assert.equal(isProjectTrusted(viaDot), true, 'identity is the realpath, not the spelling');
});

test('the digest changes with content and is stable without it', () => {
  const s = scopes();
  const first = policyDigest(s.workspace);
  assert.equal(policyDigest(s.workspace), first, 'nothing changed, so nothing may change');
  writeProjectFile(s, PINNED_FILES[0], 'version: 1\n');
  assert.notEqual(policyDigest(s.workspace), first);
});

// --- what trust actually gates ---

test('project configuration takes effect only once the project is trusted', () => {
  const s = scopes();
  writeProjectFile(s, PINNED_FILES[0], 'version: 1\nexec.timeout_seconds: 5\n');

  assert.equal(resolveConfig({ ...s, projectTrusted: isProjectTrusted(s) }).values['exec.timeout_seconds'], 600);
  approveProject(s);
  assert.equal(resolveConfig({ ...s, projectTrusted: isProjectTrusted(s) }).values['exec.timeout_seconds'], 5);
});

test('project policy is ignored until trusted, and the fallback is the STRICTER direction', () => {
  const s = scopes();
  writeProjectFile(s, PINNED_FILES[1], 'version: 1\nenforcement: observe\n');

  const untrusted = loadPolicy(s.workspace, null, { copilotHome: s.copilotHome });
  assert.equal(untrusted.enforcement, 'enforce', 'an unapproved repo must not turn its own gates down');
  assert.equal(untrusted.projectPolicyIgnored, true, 'a flipped enforcement mode must be explainable');

  approveProject(s);
  const trusted = loadPolicy(s.workspace, null, { copilotHome: s.copilotHome });
  assert.equal(trusted.enforcement, 'observe');
  assert.equal(trusted.projectPolicyIgnored, false);
});

test('an explicit --enforcement override still wins over the trust fallback', () => {
  const s = scopes();
  writeProjectFile(s, PINNED_FILES[1], 'version: 1\nenforcement: observe\n');
  const policy = loadPolicy(s.workspace, 'warn', { copilotHome: s.copilotHome });
  assert.equal(policy.enforcement, 'warn', 'the operator on the command line is not the untrusted party');
});

test('every loadPolicy call under lib/ passes copilotHome', () => {
  const libDir = path.join(packageRoot, 'lib');
  const offenders = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!entry.name.endsWith('.mjs') || entry.name === 'policy.mjs') continue;
      const body = fs.readFileSync(full, 'utf8');
            for (const line of body.split('\n')) {
        if (!line.includes('loadPolicy(')) continue;
        if (line.trimStart().startsWith('*') || line.trimStart().startsWith('//')) continue;
        if (line.includes('import ')) continue;
        if (!line.includes('copilotHome')) offenders.push(`${path.relative(packageRoot, full)}: ${line.trim()}`);
      }
    }
  };
  walk(libDir);
  assert.deepEqual(offenders, [], 'a loadPolicy call without copilotHome silently skips the trust gate');
});

// --- the command surface ---

test('trust approve then revoke round-trips through the CLI', () => {
  const s = scopes();
  assert.match(run(['trust', 'status'], s).stdout, /untrusted/);

  const approved = run(['trust', 'approve'], s);
  assert.equal(approved.status, 0, approved.stderr);
  assert.match(run(['trust', 'status'], s).stdout, /trusted/);

  const revoked = run(['trust', 'revoke'], s);
  assert.equal(revoked.status, 0, revoked.stderr);
  assert.match(run(['trust', 'status'], s).stdout, /revoked/);
});

test('a bare `harness trust` reports status rather than changing anything', () => {
  const s = scopes();
  const res = run(['trust'], s);
  assert.equal(res.status, 0);
  assert.match(res.stdout, /untrusted/);
  assert.equal(isProjectTrusted(s), false, 'the default verb must not grant anything');
});

test('trust status exits 0 whatever the answer is', () => {
  const s = scopes();
  assert.equal(run(['trust', 'status'], s).status, 0);
  approveProject(s);
  assert.equal(run(['trust', 'status'], s).status, 0);
});

// P3AC6: "trust changes are recorded".
test('a trust change is recorded as an event; a status read is not', () => {
  const s = scopes();
  const eventsFile = path.join(s.workspace, '.harness', 'events.jsonl');
  const trustEvents = () => (fs.existsSync(eventsFile)
    ? fs.readFileSync(eventsFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.type === 'trust')
    : []);

  spawnSync(process.execPath, [binPath, 'trust', 'status', '--workspace', s.workspace, '--copilot-home', s.copilotHome], { cwd: packageRoot, encoding: 'utf8' });
  assert.equal(trustEvents().length, 0, 'reading the state is not a change');

  spawnSync(process.execPath, [binPath, 'trust', 'approve', '--workspace', s.workspace, '--copilot-home', s.copilotHome], { cwd: packageRoot, encoding: 'utf8' });
  const [event] = trustEvents();
  assert.ok(event, 'granting authority must leave a record');
  assert.equal(event.trust.verb, 'approve');
  assert.equal(event.trust.from, 'untrusted');
  assert.equal(event.trust.to, 'trusted');
});

test('a trust change is recorded on the envelope lane too', () => {
  const s = scopes();
  spawnSync(process.execPath, [binPath, 'trust', 'approve', '--output', 'json-envelope', '--workspace', s.workspace, '--copilot-home', s.copilotHome], { cwd: packageRoot, encoding: 'utf8' });
  const events = fs.readFileSync(path.join(s.workspace, '.harness', 'events.jsonl'), 'utf8')
    .split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.type === 'trust');
  assert.equal(events.length, 1, 'an audit a caller can skip by choosing an output format is not an audit');
});
