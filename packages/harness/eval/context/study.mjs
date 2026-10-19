import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { buildTaskContext } from '../../lib/context-policy.mjs';
import { buildStructuralIndex } from '../../lib/repo-map/structural-index.mjs';
import { lexicalV2 } from '../../lib/repo-map/treesitter-extractor.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const here = import.meta.dirname;
const protocolFile = path.join(here, 'protocol.json');
const checker = path.join(here, 'check.mjs');
const GENERATED_METADATA = new Set(['.harness/context-pack.md', '.harness/repo-map.md', '.harness/session.json', '.harness/todo.json']);
export const PROTOCOL = Object.freeze(JSON.parse(fs.readFileSync(protocolFile, 'utf8')));

function safePath(file) {
  if (typeof file !== 'string' || !file || file.includes('\\') || path.posix.isAbsolute(file) || file.split('/').some(part => ['.', '..', '.git', '.harness', ''].includes(part))) {
    throw new TypeError(`invalid fixture path: ${file}`);
  }
  return file;
}

function writeFiles(workspace, files = {}) {
  for (const [file, content] of Object.entries(files)) {
    const target = path.join(workspace, safePath(file));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
}

function snapshot(workspace) {
  const files = {};
  const walk = dir => {
    for (const entry of fs.readdirSync(path.join(workspace, dir), { withFileTypes: true })) {
      if (!dir && entry.name === '.git') continue;
      const file = path.posix.join(dir, entry.name);
      if (GENERATED_METADATA.has(file) && entry.isFile()) continue;
      if (Object.keys(files).length > 1000) throw new Error('fixture file limit exceeded');
      if (entry.isDirectory()) walk(file);
      else files[file] = entry.isFile() ? hash(fs.readFileSync(path.join(workspace, file))) : 'unsupported';
    }
  };
  walk('');
  return files;
}

export async function prepareCase({ task, root, id }) {
  if (!/^[a-z0-9-]+$/.test(id)) throw new TypeError('invalid trial id');
  if (!task.checks?.length) throw new TypeError('case needs independent checks');
  for (const file of [...task.editable, ...task.seeds, ...task.requiredEvidence, ...task.checks.map(check => check.module)]) safePath(file);
  const trial = path.join(root, id);
  fs.mkdirSync(trial, { recursive: false });
  const workspace = path.join(trial, 'workspace');
  const copilotHome = path.join(trial, 'copilot');
  const harnessHome = path.join(trial, 'control');
  for (const dir of [workspace, copilotHome, harnessHome]) fs.mkdirSync(dir);
  writeFiles(workspace, task.files);
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 'Context Eval', GIT_AUTHOR_EMAIL: 'context@example.test', GIT_COMMITTER_NAME: 'Context Eval', GIT_COMMITTER_EMAIL: 'context@example.test' };
  const git = args => execFileSync('git', args, { cwd: workspace, env, stdio: 'pipe' });
  git(['init', '-q']); git(['add', '.']); git(['commit', '-qm', 'Frozen case baseline']);
  if (task.indexBeforeEdits) await buildStructuralIndex({ workspace, home: harnessHome, extractor: { tier: 'lexical', extract: lexicalV2 } });
  writeFiles(workspace, task.workingEdits);
  writeFiles(workspace, task.newFiles);
  const checkFile = path.join(trial, 'checks.json');
  const checkText = JSON.stringify({ checks: task.checks });
  fs.writeFileSync(checkFile, checkText, { mode: 0o444 });
  return { task, workspace, copilotHome, harnessHome, checkFile, checkHash: hash(checkText), checkerHash: hash(fs.readFileSync(checker)), before: snapshot(workspace), trial };
}

function integrity(fixture) {
  try { return hash(fs.readFileSync(fixture.checkFile)) === fixture.checkHash && hash(fs.readFileSync(checker)) === fixture.checkerHash; }
  catch { return false; }
}

export async function runChecks(fixture) {
  if (!integrity(fixture)) return { pass: false, integrity: false, reason: 'check content changed' };
  const result = spawnSync(process.execPath, [checker, fixture.workspace, fixture.checkFile], { encoding: 'utf8', timeout: PROTOCOL.checkerTimeoutMs, maxBuffer: 64_000 });
  const intact = integrity(fixture);
  return { pass: intact && result.status === 0, integrity: intact, exitCode: result.status, signal: result.signal, error: result.error?.code ?? null, diagnostic: result.stderr?.slice(0, 2000) || null };
}

function scopeResult(fixture) {
  const after = snapshot(fixture.workspace);
  const changed = [...new Set([...Object.keys(fixture.before), ...Object.keys(after)])].filter(file => fixture.before[file] !== after[file]);
  const unexpected = changed.filter(file => !fixture.task.editable.includes(file));
  return { pass: unexpected.length === 0, changed, unexpected, metadataExcluded: [...GENERATED_METADATA] };
}

function evidenceResult(task, result) {
  if (!Array.isArray(result.turns) || !result.turns.length) return null;
  const seen = new Set();
  for (const turn of result.turns) {
    for (const source of turn.contextEvidence || []) seen.add(source.location);
    if ((turn.tools || []).some(tool => ['edit', 'write', 'apply', 'exec', 'bash'].includes(tool.tool) && tool.dispatched)) {
      return { missing: task.requiredEvidence.filter(file => !seen.has(file)), measuredBy: 'source-snapshot-and-read-tools', limits: 'Search, exec and external host reads are not observed as file evidence. Same-batch reads are excluded.' };
    }
    for (const tool of turn.tools || []) {
      if (tool.source?.path && tool.status === 'ok') seen.add(tool.source.path);
    }
  }
  return null;
}

export async function runStudy({ root, cases, repeats = PROTOCOL.repeats, policies = PROTOCOL.policies, retentionPolicy = PROTOCOL.retentionPolicy, dryRun = false, execute, model = null, host = null }) {
  if (!Number.isInteger(repeats) || repeats < 1 || repeats > 20) throw new TypeError('repeats must be 1..20');
  if (!policies.length || new Set(policies).size !== policies.length || policies.some(policy => !PROTOCOL.policies.includes(policy))) throw new TypeError('invalid policies');
  if (!['legacy', 'structured'].includes(retentionPolicy)) throw new TypeError('invalid retention policy');
  fs.mkdirSync(root, { recursive: true });
  const provenance = {
    corpusHash: hash(JSON.stringify(cases)), checkerHash: hash(fs.readFileSync(checker)), protocolHash: hash(fs.readFileSync(protocolFile)),
    runtime: process.version, platform: process.platform, arch: process.arch, host, model,
    revision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: here, encoding: 'utf8' }).trim(),
    sourceDirty: Boolean(execFileSync('git', ['status', '--porcelain'], { cwd: here, encoding: 'utf8' }).trim()),
    retentionPolicy, maxTurns: PROTOCOL.maxTurns, maxSeconds: PROTOCOL.maxSeconds, repeats, policies,
  };
  provenance.configHash = hash(JSON.stringify(provenance));
  provenance.sourceHash = hash(execFileSync('git', ['ls-files', '-z', 'packages/harness/lib', 'packages/harness/bin', 'packages/harness/corpus', 'packages/harness/eval/context'], { cwd: path.resolve(here, '../../../..') }).toString().split('\0').filter(Boolean).map(file => `${file}:${hash(fs.readFileSync(path.resolve(here, '../../../..', file)))}`).join('\n'));
  fs.writeFileSync(path.join(root, 'provenance.json'), JSON.stringify(provenance, null, 2), { flag: 'wx' });
  const attempts = [];
  for (const [caseIndex, task] of cases.entries()) {
    for (let repeat = 0; repeat < repeats; repeat++) {
      const offset = (caseIndex + repeat) % policies.length;
      const ordered = [...policies.slice(offset), ...policies.slice(0, offset)];
      for (const policy of ordered) {
        const id = `${task.id}-${repeat + 1}-${policy}`;
        const fixture = await prepareCase({ task, root, id });
        const baseline = await runChecks(fixture);
        if (baseline.pass || !baseline.integrity) throw new Error(`invalid broken baseline: ${id}`);
        const startedAt = Date.now();
        let result = {}, error = null;
        try {
          result = dryRun ? { dryRun: true, context: buildTaskContext({ workspace: fixture.workspace, copilotHome: fixture.copilotHome, home: fixture.harnessHome, task: task.prompt, files: task.seeds, policy }) } : await execute({ ...fixture, policy, model, protocol: { ...PROTOCOL, retentionPolicy } });
        } catch (caught) { error = String(caught.message).slice(0, 2000); }
        const checks = await runChecks(fixture);
        const scope = scopeResult(fixture);
        const kind = dryRun || result.dryRun ? 'dry-run' : error ? 'runtime-error' : host === 'scripted-test' ? 'scripted' : 'live';
        const requests = (result.contextAccounting || []).filter(record => record.boundary === 'headless-request');
        const models = [...new Set(requests.map(record => record.model).filter(Boolean))];
        const attempt = {
          id, case: task.id, split: task.split, family: task.family, repeat: repeat + 1, policy, kind,
          pass: ['live', 'scripted'].includes(kind) && result.status === 'ok' && checks.pass && scope.pass,
          baseline, checks, scope, error, durationMs: Date.now() - startedAt, stopReason: result.stopReason ?? null,
          requestedModel: result.model ?? model, observedModels: models,
          actualModel: requests.length && requests.every(record => record.model) && models.length === 1 ? models[0] : null,
          provider: result.provider ?? null,
          accounting: result.contextAccounting || [], evidenceBeforeEdit: evidenceResult(task, result),
          context: result.context ? { files: result.context.files, coverage: result.context.coverage } : null,
        };
        fs.writeFileSync(path.join(fixture.trial, 'attempt.json'), JSON.stringify(attempt, null, 2));
        attempts.push(attempt);
      }
    }
  }
  const result = { schema: 1, provenance, attempts, summary: summarizeStudy(attempts, provenance) };
  fs.writeFileSync(path.join(root, 'results.json'), JSON.stringify(result, null, 2));
  return result;
}

export function summarizeStudy(attempts, provenance) {
  const arms = {};
  for (const policy of provenance.policies) {
    const rows = attempts.filter(row => row.policy === policy);
    const requests = rows.flatMap(row => row.accounting || []).filter(row => row.boundary === 'headless-request');
    const known = field => requests.filter(row => row.modelUsage?.measurement === 'observed' && Number.isFinite(row.modelUsage[field])).reduce((sum, row) => sum + row.modelUsage[field], 0);
    const complete = field => requests.length > 0 && rows.every(row => row.accounting?.length) && requests.every(row => row.modelUsage?.measurement === 'observed' && Number.isFinite(row.modelUsage[field]));
    const observed = requests.filter(row => row.modelUsage?.measurement === 'observed').length;
    const evidence = rows.filter(row => row.evidenceBeforeEdit);
    arms[policy] = {
      attempts: rows.length, passed: rows.filter(row => row.pass).length, failed: rows.filter(row => !row.pass).length,
      heldOutAttempts: rows.filter(row => row.split === 'held-out').length,
      heldOutFailed: rows.filter(row => row.split === 'held-out' && !row.pass).length,
      inputTokens: complete('inputTokens') ? known('inputTokens') : null,
      outputTokens: complete('outputTokens') ? known('outputTokens') : null,
      cachedInputTokens: complete('cachedInputTokens') ? known('cachedInputTokens') : null,
      knownInputTokens: observed ? known('inputTokens') : null,
      usageCoverage: complete('inputTokens') && complete('outputTokens') ? 'complete' : observed ? 'partial' : 'unavailable',
      evidenceCoverage: evidence.length === rows.length && rows.length ? 'complete' : evidence.length ? 'partial' : 'unavailable',
      observedMissingEvidence: evidence.reduce((sum, row) => sum + row.evidenceBeforeEdit.missing.length, 0),
      durationMs: rows.reduce((sum, row) => sum + (row.durationMs || 0), 0), cost: null,
      inputTokensPerAcceptedTask: complete('inputTokens') && rows.some(row => row.pass) ? known('inputTokens') / rows.filter(row => row.pass).length : null,
    };
  }
  const limits = PROTOCOL.promotion;
  const eligible = attempts.length && attempts.every(row => row.kind === 'live' && row.actualModel === provenance.model)
    && ['legacy', 'selective', 'subsystem'].every(policy => arms[policy]?.heldOutAttempts >= limits.minimumHeldOutAttemptsPerArm && arms[policy].usageCoverage === 'complete')
    && arms.legacy.passed / arms.legacy.attempts >= limits.minimumBaselinePassRate;
  const candidates = eligible ? ['selective', 'subsystem'].filter(policy => arms[policy].failed <= arms.legacy.failed + limits.maximumAdditionalFailures
    && arms[policy].heldOutFailed <= arms.legacy.heldOutFailed + limits.maximumAdditionalFailures
    && arms[policy].inputTokens <= arms.legacy.inputTokens * (1 - limits.minimumInputTokenReduction)) : [];
  return { arms, comparison: eligible ? candidates.length ? 'candidate-requires-review' : 'no-candidate' : 'inconclusive', candidates,
    cost: null, costReason: 'No versioned price schedule supplied. Unknown usage is never zero cost.',
    limits: PROTOCOL.limits,
  };
}
