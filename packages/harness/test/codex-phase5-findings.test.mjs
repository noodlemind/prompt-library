/**
 * The Codex phase-5 review: one test per finding, each written to fail against
 * the pre-fix code.
 *
 * Same convention as `codex-review-findings.test.mjs` for phase 3. The value is
 * not that the bugs are fixed — it is that the specific WRONG BEHAVIOR is
 * named, so a later refactor that reintroduces it fails here rather than in
 * someone's `~/.copilot`.
 *
 * Three of these were reporting-untruths rather than plain bugs, which is the
 * worse class: F2 deleted a file while reporting a successful withdrawal, F10
 * reported a withdrawal that never happened, and F13 was a comment asserting a
 * property the code did not have, guarded by a test that skipped the file.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import YAML from 'yaml';
import { approvedBundleNames, isContainedPlacement, readPlacements, syncBundles } from '../lib/bundle-sync.mjs';
import { bundleDigest } from '../lib/resources.mjs';
import { readPrimitiveOnce, validatePrimitive } from '../lib/local-primitives.mjs';
import { startPlugin } from '../lib/plugin-host.mjs';
import { agentJournalArgv, agentResultOf, taskFromArgv } from '../lib/agent-cmd.mjs';
import { AGENT_VALUE_FLAGS } from '../lib/agent-loop.mjs';
import { GLOBAL_FLAGS, getCommand } from '../lib/registry.mjs';
import { parseFlags } from '../lib/flags.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tempDir = (p) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p)));
const digestOf = (b) => `sha256-${crypto.createHash('sha256').update(b).digest('hex')}`;

/** A copilot home with one enabled bundle contributing one skill. */
function bundleHome(prefix, { contents = 'bundle bytes\n', rel = 'demo/SKILL.md' } = {}) {
  const home = tempDir(prefix);
  const dir = path.join(home, 'resources', 'demo-bundle');
  fs.mkdirSync(path.join(dir, 'skills', path.dirname(rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, 'skills', rel), contents);
  fs.writeFileSync(path.join(dir, 'harness-resource.yaml'), YAML.stringify({
    schema: 1, name: 'demo-bundle', version: '1.0.0', contributes: { skills: [rel] },
  }));
  fs.writeFileSync(path.join(dir, '.enabled'), '');
  // Exactly how `cmdInstallOrUpgrade` calls it: approval IS the trust input, so
  // removing `.enabled` genuinely disables the bundle here. Hardcoding the name
  // instead would leave the withdrawal tests below asserting nothing.
  const sync = (extra = {}) => syncBundles({ copilotHome: home, trustedNames: approvedBundleNames(home), ...extra });
  return { home, dir, sync, target: `skills/${rel}` };
}

// --- F1: a recorded placement path cannot escape ~/.copilot ---------------

test('F1: a placement record naming a path outside the home deletes nothing', () => {
  const home = tempDir('f1-home-');
  const outside = path.join(home, '..', `f1-victim-${process.pid}.txt`);
  fs.writeFileSync(outside, 'do not delete me');
  try {
    fs.mkdirSync(path.join(home, 'harness'), { recursive: true });
    fs.writeFileSync(path.join(home, 'harness', 'bundles.yaml'), YAML.stringify({
      version: 1,
      bundles: { evil: { version: '1.0.0', files: [`../${path.basename(outside)}`] } },
    }));

    const result = syncBundles({ copilotHome: home });
    assert.equal(result.unreadable, true, 'a record with an escaping path is damaged, not authoritative');
    assert.equal(fs.existsSync(outside), true, 'withdrawal resolved and removed a file outside ~/.copilot');
    assert.deepEqual(result.withdrawn, []);
  } finally {
    fs.rmSync(outside, { force: true });
  }
});

test('F1: containment is decided lexically, before anything is opened', () => {
  for (const bad of ['../x', 'a/../../x', '/etc/passwd', 'C:\\Windows\\x', '', 'a\0b', '..']) {
    assert.equal(isContainedPlacement(bad), false, `${JSON.stringify(bad)} must be refused`);
  }
  for (const good of ['skills/demo/SKILL.md', 'agents/x.agent.md', 'a/b/c.md']) {
    assert.equal(isContainedPlacement(good), true, good);
  }
});

// --- F2: withdrawal removes only what this bundle still owns --------------

test('F2: a path the harness now ships is never withdrawn as a bundle leftover', () => {
  const { home, dir, sync, target } = bundleHome('f2a-home-');
  sync();
  assert.equal(fs.existsSync(path.join(home, target)), true);

  // The next release ships that path. Hydration writes the package's copy,
  // placement refuses the bundle — and withdrawal used to delete the package
  // file it had just written.
  fs.writeFileSync(path.join(home, target), 'package bytes\n');
  const result = sync({ shippedFiles: new Set([target]) });

  assert.equal(fs.readFileSync(path.join(home, target), 'utf8'), 'package bytes\n',
    'the package file was deleted by a bundle withdrawal');
  assert.ok(result.retained.some((r) => r.target === target), 'and the operator is told why it stayed');
  assert.equal(result.withdrawn.includes(target), false);
  assert.ok(fs.existsSync(dir));
});

test('F2: a file the operator edited after placement is retained, not deleted', () => {
  const { home, dir, sync, target } = bundleHome('f2b-home-');
  sync();
  fs.writeFileSync(path.join(home, target), 'my own edits\n');

  // Disable the bundle: everything it placed is due for withdrawal.
  fs.rmSync(path.join(dir, '.enabled'));
  const result = sync();

  assert.equal(fs.readFileSync(path.join(home, target), 'utf8'), 'my own edits\n',
    'a path is not ownership — the bytes are');
  assert.ok(result.retained.some((r) => /changed/.test(r.reason)));
});

test('F2: an untouched file the bundle placed IS withdrawn — the fix must not disable retirement', () => {
  const { home, dir, sync, target } = bundleHome('f2c-home-');
  sync();
  fs.rmSync(path.join(dir, '.enabled'));

  const result = sync();
  assert.equal(fs.existsSync(path.join(home, target)), false, 'retirement is the half nobody notices until it breaks');
  assert.deepEqual(result.withdrawn, [target]);
});

// --- F3: integrity covers the bytes that get installed --------------------

test('F3: a symlink in a bundle is refused rather than followed at placement', () => {
  const { home, dir, sync, target } = bundleHome('f3-home-');
  const secret = path.join(home, 'secret.txt');
  fs.writeFileSync(secret, 'elsewhere on the filesystem');
  const source = path.join(dir, 'skills', 'demo', 'SKILL.md');
  fs.rmSync(source);
  fs.symlinkSync(secret, source);

  const result = sync();
  assert.equal(fs.existsSync(path.join(home, target)), false, 'readFileSync followed it where the digest never looked');
  assert.ok(result.refused.some((r) => /symlink/.test(r.reason)));
});

test('F3: the integrity digest covers a symlink, so repointing it breaks the pin', () => {
  const { dir } = bundleHome('f3b-home-');
  const link = path.join(dir, 'skills', 'demo', 'other.md');
  fs.symlinkSync('/tmp/a', link);
  const before = bundleDigest(dir);
  fs.rmSync(link);
  fs.symlinkSync('/tmp/b', link);
  assert.notEqual(bundleDigest(dir), before,
    'a symlink excluded from the digest is an entry the pin does not authorize');
});

test('F3: the bytes written are the bytes hashed — one read, not two', () => {
  const { home, sync, target } = bundleHome('f3c-home-', { contents: 'reviewed\n' });
  sync();
  const record = readPlacements(home).bundles['demo-bundle'];
  const entry = record.files.find((f) => f.path === target);
  assert.equal(entry.digest, digestOf(fs.readFileSync(path.join(home, target))),
    'the recorded digest must describe what actually landed');
});

// --- F4: the module path is percent-decoded ------------------------------

test('F4: the provider root is decoded, so an install under a path with a space works', () => {
  const encoded = 'file:///Users/Jane%20Doe/harness/lib/provider.mjs';
  assert.equal(path.dirname(new URL(encoded).pathname), '/Users/Jane%20Doe/harness/lib',
    'this is the value the old code used');
  assert.equal(path.dirname(fileURLToPath(encoded)), '/Users/Jane Doe/harness/lib');

  const source = fs.readFileSync(path.join(packageRoot, 'lib', 'provider.mjs'), 'utf8');
  assert.equal(/new URL\(import\.meta\.url\)\.pathname/.test(source), false,
    'every `harness agent` run failed with "provider adapter missing" under such a path');
});

// --- F5: validation and the pin describe the same bytes -------------------

test('F5: registration pins the digest of the bytes that were validated', () => {
  const home = tempDir('f5-home-');
  const rel = 'skills/demo/SKILL.md';
  fs.mkdirSync(path.join(home, 'skills', 'demo'), { recursive: true });
  fs.writeFileSync(path.join(home, rel), '---\nname: demo\ndescription: a demo\n---\n\nbody\n');

  const snapshot = readPrimitiveOnce(home, rel);
  const validation = validatePrimitive(home, rel, snapshot);
  assert.equal(validation.valid, true);
  assert.equal(validation.digest, snapshot.digest,
    'validating one read and hashing another is how content swapped between them gets registered as approved');

  // A swap after the snapshot cannot change what was pinned.
  fs.writeFileSync(path.join(home, rel), '---\nname: demo\ndescription: swapped\n---\n\nother\n');
  assert.equal(validatePrimitive(home, rel, snapshot).digest, snapshot.digest);
});

test('F5: a symlinked primitive is refused, not followed', () => {
  const home = tempDir('f5b-home-');
  const rel = 'skills/demo/SKILL.md';
  fs.mkdirSync(path.join(home, 'skills', 'demo'), { recursive: true });
  const elsewhere = path.join(home, 'elsewhere.md');
  fs.writeFileSync(elsewhere, '---\nname: demo\ndescription: d\n---\n');
  fs.symlinkSync(elsewhere, path.join(home, rel));
  assert.throws(() => readPrimitiveOnce(home, rel), (e) => /symlink/.test(e.message));
});

// --- F6: the frame cap applies to the frame ------------------------------

test('F6: an oversized line is discarded even though it ends in a newline', async () => {
  const dir = tempDir('f6-');
  const file = path.join(dir, 'p.mjs');
  // A complete, well-formed, enormous frame — the shape the old guard let past,
  // because it only rejected buffers with NO newline in them.
  fs.writeFileSync(file, `
    process.stdin.on('data', () => {});
    process.stdout.write(JSON.stringify({ type: 'log', level: 'info', text: 'x'.repeat(50000) }) + '\\n');
    setTimeout(() => {}, 1000);
  `);
  const plugin = startPlugin({ command: process.execPath, args: [file], env: { PATH: process.env.PATH }, maxLineBytes: 4096 });
  await new Promise((r) => setTimeout(r, 400));
  plugin.close();
  assert.ok(plugin.logs.some((l) => /discarded a \d+-byte frame/.test(l.text)),
    'a 200MB frame ending in a newline was extracted and parsed');
  assert.equal(plugin.logs.some((l) => l.text.length > 20000), false);
});

// --- F7: Ctrl-C reaches the longest-running command in the CLI ------------

test('F7: `agent` is in the SIGINT bridge, so cancellation runs its cleanup', () => {
  const source = fs.readFileSync(path.join(packageRoot, 'bin', 'harness.mjs'), 'utf8');
  const match = /\[([^\]]*)\]\.includes\(command\)/.exec(source);
  assert.ok(match, 'the signal bridge should still be a declared list');
  assert.match(match[1], /'agent'/,
    'without it Ctrl-C skips the `finally` that closes the provider, orphaning its HTTP request');
});

// --- F8: nothing starts after the deadline -------------------------------

test('F8: the wall clock stops a batch of tool calls partway through', async () => {
  const ws = tempDir('f8-ws-');
  const home = tempDir('f8-home-');
  const calls = ['a', 'b', 'c'].map((id) => ({ id, name: 'bash', input: { script: 'sleep 2' } }));
  const provider = () => ({
    provider: 'scripted', model: 's', alive: true, logs: [],
    async complete() {
      return { text: '', toolCalls: calls, blocks: [], usage: { inputTokens: 1, outputTokens: 1 } };
    },
    close() {},
  });
  const result = await agentResultOf(
    ['a', 'task', '--workspace', ws, '--copilot-home', home, '--no-events', '--max-seconds', '1'],
    {},
    { startProviderFn: provider },
  );
  assert.equal(result.stopReason, 'time-budget');
  const dispatched = result.turns.flatMap((t) => t.tools).filter((t) => t.dispatched);
  assert.equal(dispatched.length, 1,
    'the first call consumed the budget; the other two were still spawned with negative remaining time');
});

test('F8: a completion that arrives after the deadline is time-budget, not done', async () => {
  const ws = tempDir('f8b-ws-');
  const home = tempDir('f8b-home-');
  const provider = () => ({
    provider: 'scripted', model: 's', alive: true, logs: [],
    async complete() {
      await new Promise((r) => setTimeout(r, 1200));
      return { text: 'finished', toolCalls: [], blocks: [], usage: { inputTokens: 1, outputTokens: 1 } };
    },
    close() {},
  });
  const result = await agentResultOf(
    ['a', 'task', '--workspace', ws, '--copilot-home', home, '--no-events', '--max-seconds', '1'],
    {},
    { startProviderFn: provider },
  );
  assert.equal(result.stopReason, 'time-budget',
    'a run that ran out of time reported itself as one that finished');
  assert.notEqual(result.exitCode, 0);
});

// --- F9: the journal keeps metadata, not the task ------------------------

test('F9: the run journal records the task by size and digest, never its words', () => {
  const projected = agentJournalArgv([
    'summarize', 'the', 'BLUEBIRD', 'acquisition',
    '--provider', 'openrouter', '--max-turns', '5', '--dry-run',
  ]);
  const joined = projected.join(' ');
  assert.equal(/BLUEBIRD/.test(joined), false,
    'redaction recognizes secret SHAPES; it cannot know a sentence is confidential');
  assert.match(joined, /<task:\d+b:[0-9a-f]{12}>/, 'two runs still have to be tellable apart');
  assert.match(joined, /--provider openrouter/, 'configuration is not conversation and stays readable');
  assert.match(joined, /--max-turns 5/);
  assert.match(joined, /--dry-run/);
});

test('F9: the projection is wired to the registry entry, not left for a caller to remember', () => {
  assert.equal(typeof getCommand('agent').journalArgv, 'function');
});

// --- F10: a failed deletion is reported and remembered -------------------

test('F10: a deletion that fails is not reported as withdrawn, and keeps its record', () => {
  const { home, dir, sync, target } = bundleHome('f10-home-');
  sync();
  fs.rmSync(path.join(dir, '.enabled'));

  // Make the containing directory unwritable so unlink fails with EACCES —
  // the EBUSY/EACCES class the old `catch {}` swallowed as "already gone".
  const parent = path.dirname(path.join(home, target));
  const mode = fs.statSync(parent).mode;
  fs.chmodSync(parent, 0o500);
  try {
    const result = sync();
    // The escape hatch is "the file really is gone" (running as root, where the
    // unwritable directory cannot stop unlink) — NOT "it was reported
    // withdrawn", which is exactly the false report this finding is about.
    if (!fs.existsSync(path.join(home, target))) return;
    assert.equal(result.withdrawn.includes(target), false,
      'the file is still on disk and the run said it had been withdrawn');
    assert.ok(result.retained.some((r) => r.target === target), 'the operator must learn the file is still there');
    const record = readPlacements(home).bundles['demo-bundle'];
    assert.ok(record?.files?.some((f) => (typeof f === 'string' ? f : f.path) === target),
      'dropping it from the record leaves a stale file nothing claims ownership of');
  } finally {
    fs.chmodSync(parent, mode);
  }
});

// --- F11: only an answer settles a request -------------------------------

test('F11: a `hello` frame carrying a pending id cannot resolve that request', async () => {
  const dir = tempDir('f11-');
  const file = path.join(dir, 'p.mjs');
  fs.writeFileSync(file, `
    let buf = '';
    process.stdin.on('data', (c) => {
      buf += c.toString();
      let i = buf.indexOf('\\n');
      while (i !== -1) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1); i = buf.indexOf('\\n');
        if (!line.trim()) continue;
        const msg = JSON.parse(line);
        if (msg.type === 'request') {
          // The forged frame: a handshake wearing the request's id.
          process.stdout.write(JSON.stringify({ type: 'hello', id: msg.id, protocol: 999 }) + '\\n');
          setTimeout(() => process.stdout.write(JSON.stringify({ type: 'result', id: msg.id, result: { real: true } }) + '\\n'), 150);
        }
      }
    });
  `);
  const plugin = startPlugin({ command: process.execPath, args: [file], env: { PATH: process.env.PATH } });
  const result = await plugin.request('complete', {}, { timeout: 5000 });
  plugin.close();
  assert.deepEqual(result, { real: true },
    'the forged handshake resolved the request with `undefined`, and the agent reported a turn it never received');
});

// --- F12: a dead protocol is not a dead process --------------------------

test('F12: a child that closes stdin but stays alive is still killed on close', async () => {
  const dir = tempDir('f12-');
  const file = path.join(dir, 'p.mjs');
  const marker = path.join(dir, 'alive.txt');
  // ESM, with a real import — an earlier version of this test used `require`
  // in an .mjs child, so the heartbeat threw, the marker was never written, and
  // the assertion compared '0' to '0' and passed against the broken code.
  fs.writeFileSync(file, `
    import fs from 'node:fs';
    // Closing fd 0 AFTER the handshake lands is what makes the host's next
    // write fail with EPIPE — the condition that used to mark the handle closed.
    setTimeout(() => { try { fs.closeSync(0); } catch {} }, 100);
    setInterval(() => { fs.writeFileSync(${JSON.stringify(marker)}, String(Date.now())); }, 40);
    // Self-destruct so a FAILING run reports a failure instead of hanging the
    // runner forever on the orphan this test exists to catch.
    setTimeout(() => process.exit(0), 5000);
  `);
  const plugin = startPlugin({ command: process.execPath, args: [file], env: { PATH: process.env.PATH } });
  await new Promise((r) => setTimeout(r, 400));
  assert.ok(fs.existsSync(marker), 'the child must actually be alive, or this test proves nothing');

  await plugin.request('ping', {}, { timeout: 300 }).catch(() => {});
  plugin.close({ graceMs: 100 });
  await new Promise((r) => setTimeout(r, 600));
  const afterClose = fs.readFileSync(marker, 'utf8');
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(fs.readFileSync(marker, 'utf8'), afterClose,
    'EPIPE marked the handle closed, so close() returned before kill() and the child kept running');
});

// --- F14: a boolean flag consumes nothing --------------------------------

test('F14: a boolean flag before the task does not eat its first word', () => {
  assert.equal(taskFromArgv(['--dry-run', 'fix', 'the', 'bug']), 'fix the bug');
  assert.equal(taskFromArgv(['--no-events', 'fix', 'the', 'bug']), 'fix the bug');
  assert.equal(taskFromArgv(['--json', '--verbose', 'fix', 'it']), 'fix it');
  // …while a value-taking flag still does.
  assert.equal(taskFromArgv(['--provider', 'ollama', 'fix', 'it']), 'fix it');
  assert.equal(taskFromArgv(['--max-turns', '3', 'fix', 'it']), 'fix it');
});

test('F14: every declared value-taking flag is one the task parser knows about', () => {
  const declared = [...GLOBAL_FLAGS, ...(getCommand('agent').args?.flags || [])]
    .filter((f) => f.type !== 'boolean')
    .map((f) => f.name);
  const missing = declared.filter((name) => !AGENT_VALUE_FLAGS.includes(name));
  assert.deepEqual(missing, [],
    'a value-taking flag missing from the set silently eats the first word of the task');
});

test('F14: nothing in the set is actually a boolean, which would skip a word of the task', () => {
  // Two legitimate authorities, because the agent's own flags are parsed by
  // `agent-cmd.mjs` and never reach `parseFlags`, while several value-taking
  // globals (--plan, --host, --query) are parsed by `parseFlags` without ever
  // appearing in the registry's help surface. A flag is fine if EITHER says so.
  const declared = new Map(
    [...GLOBAL_FLAGS, ...(getCommand('agent').args?.flags || [])].map((f) => [f.name, f.type]),
  );
  // Probed with a word AND a number: `--limit` is numeric, so a string sentinel
  // parses to NaN and vanishes from the result — a probe that only tried words
  // would call a real value-taking flag a boolean.
  const consumesAValue = (name) => ['SENTINEL', '7'].some((value) => {
    try {
      return JSON.stringify(parseFlags([name, value]) ?? {}).includes(value);
    } catch {
      // Rejecting the value is still reading it.
      return true;
    }
  });
  const notValueTaking = AGENT_VALUE_FLAGS.filter((name) => {
    if (name === '--output') return false; // consumed by extractOutputLane before dispatch
    if (declared.get(name) && declared.get(name) !== 'boolean') return false;
    return !consumesAValue(name);
  });
  assert.deepEqual(notValueTaking, [],
    'listing a boolean here makes the parser skip a word that belonged to the task');
});
