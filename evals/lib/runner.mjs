import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { getProvider, EvalInfraError } from './judge.mjs';

const evalsRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_TASKS_DIR = path.join(evalsRoot, 'tasks');
const JOBS_DIR = path.join(evalsRoot, 'jobs');

function readMaybe(file) {
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
}

export function discoverTasks(tasksDir = DEFAULT_TASKS_DIR) {
  if (!fs.existsSync(tasksDir)) return [];
  return fs
    .readdirSync(tasksDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && fs.existsSync(path.join(tasksDir, e.name, 'task.mjs')))
    .map((e) => path.join(tasksDir, e.name))
    .sort();
}

function infra(id, reason) {
  return { id, status: 'infrastructure_error', reason };
}

export async function runTask(taskDir, { provider } = {}) {
  const id = path.basename(taskDir);
  const mod = await import(pathToFileURL(path.join(taskDir, 'task.mjs')).href);
  const meta = mod.meta || {};
  const ctx = {
    instruction: readMaybe(path.join(taskDir, 'instruction.md')).trim(),
    rubric: readMaybe(path.join(taskDir, 'rubric.md')).trim(),
    provider,
  };

  // Semantic reconstructions cannot run without a provider — skip cleanly.
  if (meta.kind === 'semantic' && !provider) {
    return {
      id,
      status: 'skipped',
      reconstruction: true,
      reason: 'semantic reconstruction requires a provider key (set HARNESS_EVAL_JUDGE_KEY or ANTHROPIC_API_KEY)',
    };
  }

  if (!mod.fixtures || !('pass' in mod.fixtures) || !('fail' in mod.fixtures)) {
    return infra(id, 'task is missing pass/fail verifier fixtures');
  }

  // Verifier self-test: the verifier must pass the good fixture and fail the bad
  // one before the real target runs, or the task is an infrastructure error.
  try {
    const passCheck = await mod.grade(mod.fixtures.pass, ctx);
    const failCheck = await mod.grade(mod.fixtures.fail, ctx);
    if (passCheck.verdict !== 'pass' || failCheck.verdict !== 'fail') {
      return infra(id, `verifier self-test failed (pass fixture → ${passCheck.verdict}, fail fixture → ${failCheck.verdict})`);
    }
  } catch (error) {
    return infra(id, `verifier self-test error: ${error.message}`);
  }

  // Run the target and grade its result.
  let result;
  let verdict;
  try {
    result = await mod.run(ctx);
    verdict = await mod.grade(result, ctx);
  } catch (error) {
    // Wrong target work is graded (reward 0); only infra failures land here.
    return infra(id, error instanceof EvalInfraError ? error.message : `target/verifier crashed: ${error.message}`);
  }

  return {
    id,
    status: 'completed',
    kind: meta.kind || 'deterministic',
    runtime: meta.runtime || 'active',
    reconstruction: meta.runtime === 'reconstruction',
    verdict: verdict.verdict,
    reward: verdict.verdict === 'pass' ? 1 : 0,
    reason: verdict.reason || '',
    evidence: verdict.evidence || null,
  };
}

export async function runEvals({ tasksDir = DEFAULT_TASKS_DIR, filter = null, provider = getProvider(), writeJobs = true } = {}) {
  const dirs = discoverTasks(tasksDir).filter((d) => !filter || path.basename(d).includes(filter));
  const results = [];
  for (const dir of dirs) {
    results.push(await runTask(dir, { provider }));
  }
  if (writeJobs && results.length) {
    fs.mkdirSync(JOBS_DIR, { recursive: true });
    for (const r of results) {
      fs.writeFileSync(path.join(JOBS_DIR, `${r.id}.json`), `${JSON.stringify(r, null, 2)}\n`, 'utf8');
    }
  }
  return results;
}

export function summarize(results) {
  const completed = results.filter((r) => r.status === 'completed');
  return {
    total: results.length,
    passed: completed.filter((r) => r.verdict === 'pass').length,
    failed: completed.filter((r) => r.verdict === 'fail').length,
    skipped: results.filter((r) => r.status === 'skipped').length,
    infrastructureErrors: results.filter((r) => r.status === 'infrastructure_error').length,
  };
}
