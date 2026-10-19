import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import YAML from 'yaml';

const root = new URL('../../../', import.meta.url);
const workflow = name => YAML.parse(fs.readFileSync(new URL(`.github/workflows/${name}.yml`, root), 'utf8'));
const suite = job => job.steps.find(step => step.name === 'Harness test suite' || step.name === 'Harness test suite (Windows)');
const upload = job => job.steps.find(step => step.uses?.startsWith('actions/upload-artifact@'));

test('Windows runs once automatically per PR revision and remains manually runnable', () => {
  const windows = workflow('harness-windows');
  assert.deepEqual(Object.keys(windows.on).sort(), ['pull_request', 'workflow_dispatch']);
  assert.equal(windows.concurrency['cancel-in-progress'], true);
  assert.match(windows.concurrency.group, /github\.workflow/);
  assert.match(windows.concurrency.group, /github\.ref/);
});

test('full suites retain discovery and replace the repeated delivery and adaptive jobs', () => {
  const linux = workflow('harness-tests');
  const windows = workflow('harness-windows');
  assert.deepEqual(Object.keys(linux.jobs), ['test']);
  assert.equal(linux.on.pull_request?.paths, undefined);
  assert.equal(windows.on.pull_request?.paths, undefined);
  assert.match(suite(linux.jobs.test).run, /npm --prefix packages\/ae test/);
  assert.equal(linux.jobs.test.steps.some(step => /\bnode --test\b/.test(step.run || '')), false);
  assert.deepEqual(windows.jobs.tests.strategy.matrix.shard, [1, 2, 3, 4]);
  assert.equal(windows.jobs.tests.strategy['fail-fast'], false);
  assert.match(suite(windows.jobs.tests).run, /node scripts\/ci-tests\.mjs --shard \$\{\{ matrix.shard \}\} --shards 4/);
  assert.equal(windows.jobs.windows.needs, 'tests');
  assert.equal(windows.jobs.windows.if, 'always()');
  const manifest = JSON.parse(fs.readFileSync(new URL('packages/ae/package.json', root), 'utf8'));
  assert.match(manifest.scripts.test, /--test \.\/test\/\*\.test\.mjs$/);
  for (const file of ['deterministic-delivery', 'insight-compound', 'domain-commands', 'windows-authority', 'ci-workflows']) {
    assert.ok(fs.existsSync(new URL(`packages/ae/test/${file}.test.mjs`, root)), file);
  }
});

test('both full suites preserve installed-delivery transcripts and captured output after failure', () => {
  for (const [name, key, log] of [['harness-tests', 'test', 'harness-tests.log'], ['harness-windows', 'tests', 'windows-tests.log']]) {
    const job = workflow(name).jobs[key];
    assert.equal(suite(job).env.HARNESS_PROOF_LOG, '${{ github.workspace }}/delivery-transcripts.jsonl');
    assert.match(suite(job).run, new RegExp(log.replaceAll('.', '\\.')));
    assert.equal(upload(job).if, 'always()');
    assert.ok(upload(job).with.path.includes(log));
    assert.ok(upload(job).with.path.includes('delivery-transcripts.jsonl'));
  }
});

test('Linux log capture preserves the real suite exit code', { skip: process.platform === 'win32' }, t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ae-ci-pipeline-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const npm = path.join(directory, 'npm');
  const command = suite(workflow('harness-tests').jobs.test);
  assert.equal(command.shell, 'bash');
  for (const code of [0, 7]) {
    fs.writeFileSync(npm, `#!/bin/sh\nprintf 'suite-marker\\n'\nexit ${code}\n`, { mode: 0o755 });
    const result = spawnSync('bash', ['--noprofile', '--norc', '-e', '-o', 'pipefail', '-c', command.run], {
      cwd: directory, encoding: 'utf8', timeout: 5000,
      env: { ...process.env, PATH: `${directory}${path.delimiter}${process.env.PATH}` },
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, code, result.stdout + result.stderr);
    assert.match(fs.readFileSync(path.join(directory, 'harness-tests.log'), 'utf8'), /suite-marker/);
  }
});

test('Windows consolidation retains the native probes and the final fail-closed gate', () => {
  const windows = workflow('harness-windows');
  const job = windows.jobs.windows;
  assert.match(suite(windows.jobs.tests).run, /Tee-Object -FilePath windows-tests\.log/);
  assert.match(suite(windows.jobs.tests).run, /exit \$LASTEXITCODE/);
  assert.equal(suite(windows.jobs.tests)['continue-on-error'], undefined);
  for (const name of ['CLI scenarios', 'Redaction on Windows', 'Runner descendant termination via taskkill', 'Environment fingerprint']) {
    assert.ok(job.steps.some(step => step.name === name), name);
  }
  const gate = job.steps.at(-1);
  assert.equal(gate.name, 'Windows probe gate');
  assert.equal(gate.if, 'always()');
  assert.equal(gate.env.SUITE_OUTCOME, '${{ needs.tests.result }}');
  assert.equal(gate.env.INVENTORY_OUTCOME, '${{ steps.inventory.outcome }}');
  assert.equal(gate.env.REDACTION_RESULT, '${{ steps.redaction.outputs.result }}');
  assert.equal(gate.env.CANCELLATION_RESULT, '${{ steps.cancellation.outputs.result }}');
  assert.ok(upload(windows.jobs.tests).with.path.includes('.harness/diagnostics/windows-parent-full/'));
  assert.ok(upload(windows.jobs.tests).with.path.includes('ci-test-results/'));
  assert.ok(job.steps.some(step => step.id === 'inventory' && step.run === 'node scripts/ci-tests.mjs --verify-manifests windows-shards'));
});

test('native Windows log capture preserves the real suite exit code', { skip: process.platform !== 'win32' }, t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ae-ci-pipeline-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const command = suite(workflow('harness-windows').jobs.tests).run.trim().split('\n').slice(-2).join('\n');
  const probe = command.replace('node scripts/ci-tests.mjs --shard ${{ matrix.shard }} --shards 4',
    '& $env:AE_CI_TEST_NODE -e \'console.log("suite-marker"); process.exit(Number(process.env.AE_CI_TEST_EXIT));\'');
  assert.notEqual(probe, command);
  for (const code of [0, 7]) {
    const result = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', probe], {
      cwd: directory, encoding: 'utf8', timeout: 20000,
      env: { ...process.env, AE_CI_TEST_NODE: process.execPath, AE_CI_TEST_EXIT: String(code) },
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, code, result.stdout + result.stderr);
    assert.match(fs.readFileSync(path.join(directory, 'windows-tests.log'), 'utf8'), /suite-marker/);
  }
});

test('documentation triggers cover every canonical build input and retain manual publishing', () => {
  const docs = workflow('docs');
  const paths = docs.on.pull_request.paths;
  const builder = fs.readFileSync(new URL('scripts/build-docs.mjs', root), 'utf8');
  const inputs = [...builder.matchAll(/\['([^']+\.md)',/g)].map(match => match[1]);
  assert.ok(inputs.length >= 3);
  for (const input of [...inputs, 'docs/site/**', 'scripts/build-docs.mjs', '.github/workflows/docs.yml']) {
    assert.ok(paths.includes(input), input);
  }
  assert.equal(docs.on.workflow_dispatch.inputs.publish.default, false);
  assert.equal(docs.jobs.deploy.if, "github.event_name == 'workflow_dispatch' && inputs.publish");
});

test('package qualification filters its inputs, cancels stale runs and keeps both exact archive installs', () => {
  const candidate = workflow('package-candidate');
  for (const input of ['packages/ae/**', '.github/workflows/package-candidate.yml', '.npmrc', 'LICENSE*']) {
    assert.ok(candidate.on.pull_request.paths.includes(input), input);
  }
  assert.ok(Object.hasOwn(candidate.on, 'workflow_dispatch'));
  assert.equal(candidate.concurrency['cancel-in-progress'], true);
  assert.match(candidate.concurrency.group, /github\.workflow/);
  assert.match(candidate.concurrency.group, /github\.ref/);
  const job = candidate.jobs.package;
  assert.deepEqual(job.strategy.matrix.os, ['ubuntu-latest', 'windows-latest']);
  const install = job.steps.find(step => step.name === 'Install the exact archive and drive its runtime');
  assert.match(install.run, /--offline/);
  assert.match(install.run, /artifacts\/\$AE_ARCHIVE/);
  assert.match(install.run, /\.ae-bin\/bin\/ae\.mjs/);
});
