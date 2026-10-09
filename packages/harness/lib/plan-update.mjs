import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { randomUUID } from 'node:crypto';
import { createStyle, EXIT } from './style.mjs';
import { redactedJson } from './redact.mjs';
import { externalPlansDir, planReadDirs } from './project-layout.mjs';
import { harnessGlobalHome, resolveCopilotHome } from './paths.mjs';
import { parseFlags } from './flags.mjs';
import { loadPlan, parsePlanFrontmatter, planFromText } from './plan-parse.mjs';
import { completeWork, completionPrerequisites } from './completion.mjs';
import { bindLockedIntentSources, lockIntentSources, sourcePath, hashIntentFile, intentSourcesCheck } from './intent-sources.mjs';
import { readFileNoFollow } from './fs-safe.mjs';
import { applyPlanDecision, validatePlanDecision, planRevision, planState } from './plan-decisions.mjs';
import { runGate, publishGateSession } from './gate.mjs';
import { loadPolicy } from './policy.mjs';
import { validatePlanSchema } from './plan-schema.mjs';
import { validatePlanReadiness, gapEvidenceCheck } from './plan-readiness.mjs';
import { validatePlanScope } from './plan-scope.mjs';
import { readReviewRecord, publishReviewRecord, recordHash } from './review.mjs';
import { reviewHash } from './review-preparation.mjs';
import { readEvidence, planDigest } from './evidence.mjs';

const PLAN_STATUSES = ['open', 'planned', 'in-progress', 'review', 'done', 'blocked-capability', 'needs-info'];
const REVIEW_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const GAP_FULFILLMENTS = ['done', 'bridge', 'waived'];
const LEGACY_PLAN_RELS = ['docs/plans', '.harness/plans'];
const LOCK_WAIT_MS = 5000;
const LOCK_STALE_MS = 30000;

function usage(message) {
  return Object.assign(new Error(message), { code: 'E_USAGE', exit: EXIT.usage, hint: 'harness help plan-update' });
}

function contained(root, candidate) {
  return candidate === root || candidate.startsWith(root + path.sep);
}

function realDirectory(dir) {
  try {
    const stat = fs.lstatSync(dir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return null;
    return fs.realpathSync(dir);
  } catch {
    return null;
  }
}

/** Directories a plan-update may write. The external store, plus legacy in-repo plans. */
export function planUpdateRoots(workspace, { home } = {}) {
  return [
    externalPlansDir(workspace, { home }),
    ...LEGACY_PLAN_RELS.map((rel) => path.join(workspace, rel)),
  ];
}

/** Directory created while a plan-update holds the file. Empty, and removed when the update finishes. */
export function planUpdateLockDir(full) {
  return path.join(path.dirname(full), `.${path.basename(full)}.lock`);
}

function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function acquirePlanLock(full) {
  const lockDir = planUpdateLockDir(full);
  const start = Date.now();
  while (true) {
    try {
      fs.mkdirSync(lockDir);
      return lockDir;
    } catch (error) {
      if (!['EEXIST', 'EPERM', 'EACCES'].includes(error.code)) throw error;
      if (Date.now() - start > LOCK_WAIT_MS) {
        if (error.code !== 'EEXIST') throw error;
        throw usage('plan-update: plan is locked by another update');
      }
      if (error.code === 'EEXIST') try {
        if (Date.now() - fs.statSync(lockDir).mtimeMs > LOCK_STALE_MS) {
          fs.rmdirSync(lockDir);
          continue;
        }
      } catch {
        // A competing releaser may already have removed the lock; retry within the same budget.
      }
      sleepMs(25);
    }
  }
}

function releasePlanLock(lockDir) {
  try { fs.rmdirSync(lockDir); } catch { /* the lock is already gone */ }
}

export function withPlanUpdateLock(full, fn) {
  const lockDir = acquirePlanLock(full);
  try {
    return fn();
  } finally {
    releasePlanLock(lockDir);
  }
}

/**
 * Resolve `--plan` to a real plan file inside a plan root.
 * A bare name may match one plan. An explicit path is used as given.
 * Symlinks are refused before any path is resolved through them.
 */
export function resolvePlanUpdateFile(workspace, planArg, { home } = {}) {
  if (typeof planArg !== 'string' || !planArg.trim()) throw usage('plan-update: --plan is required');
  const raw = planArg.trim();
  const bare = !raw.includes('/') && !raw.includes('\\');
  let listedPath;
  if (bare) {
    const matches = planReadDirs(workspace, { home })
      .map((entry) => path.join(entry.dir, raw))
      .filter((candidate) => fs.existsSync(candidate));
    if (matches.length === 0) throw usage('plan-update: path is outside the plan store');
    listedPath = matches[0];
  } else {
    listedPath = path.resolve(workspace, raw);
  }
  let listed;
  try {
    listed = fs.lstatSync(listedPath);
  } catch {
    throw usage('plan-update: path is outside the plan store');
  }
  if (!listed.isFile() || listed.isSymbolicLink()) throw usage('plan-update: path is outside the plan store');
  const real = fs.realpathSync(listedPath);
  const base = path.basename(real);
  if (!real.endsWith('.md') || base === 'README.md' || base.startsWith('_')) {
    throw usage('plan-update: path is outside the plan store');
  }
  const roots = planUpdateRoots(workspace, { home }).map(realDirectory).filter(Boolean);
  if (!roots.some((root) => contained(root, real))) throw usage('plan-update: path is outside the plan store');
  return real;
}

function appendLines(current, incoming, flag) {
  const next = Array.isArray(current) ? current.map(String) : [];
  for (const item of incoming) {
    const text = oneLine(item, flag);
    if (!next.includes(text)) next.push(text);
  }
  return next;
}

function appendIntentSources(current, incoming) {
  const next = Array.isArray(current) ? current.slice() : [];
  const seen = new Set(next.map(sourcePath).filter(Boolean));
  for (const item of incoming) {
    const rel = oneLine(item, '--intent-source').replace(/\\/g, '/');
    if (!rel || seen.has(rel)) continue;
    seen.add(rel);
    next.push(rel);
  }
  return next;
}

function appendChecks(verification, incoming) {
  const record = verification && typeof verification === 'object' && !Array.isArray(verification) ? verification : {};
  const required = Array.isArray(record.required) ? record.required.map(String) : [];
  for (const name of incoming) {
    const id = oneLine(name, '--verification-check');
    if (!REVIEW_ID.test(id)) throw usage('plan-update: --verification-check must be a lowercase id');
    if (!required.includes(id)) required.push(id);
  }
  return { ...record, required };
}

function fulfillGaps(current, incoming) {
  const gaps = Array.isArray(current) ? current : [];
  for (const spec of incoming) {
    const text = oneLine(spec, '--gap-fulfillment');
    const split = text.indexOf(':');
    const id = split > 0 ? text.slice(0, split) : '';
    const fulfillment = split > 0 ? text.slice(split + 1) : '';
    if (!REVIEW_ID.test(id) || !GAP_FULFILLMENTS.includes(fulfillment)) {
      throw usage('plan-update: --gap-fulfillment must be id:done|bridge|waived');
    }
    const gap = gaps.find((item) => item && item.id === id);
    if (!gap) throw usage(`plan-update: no capability gap ${id}`);
    gap.fulfillment = fulfillment;
  }
  return gaps;
}

function oneLine(value, flag) {
  if (typeof value !== 'string' || !value.trim() || /[\r\n]/.test(value)) {
    throw usage(`plan-update: ${flag} must be a single non-empty line`);
  }
  return value.trim();
}

function appendActivity(body, line) {
  const bullet = line.startsWith('- ') ? line : `- ${line}`;
  const start = body.search(/^## Activity[ \t]*$/m);
  if (start < 0) {
    const sep = body.endsWith('\n') ? '' : '\n';
    return `${body}${sep}\n## Activity\n\n${bullet}\n`;
  }
  const rest = body.slice(start + 1);
  const nextHeading = rest.search(/^## /m);
  const sectionEnd = nextHeading === -1 ? body.length : start + 1 + nextHeading;
  const section = body.slice(start, sectionEnd);
  if (section.split('\n').some((entry) => entry.trim() === bullet)) return body;
  const head = body.slice(0, sectionEnd).replace(/\s*$/, '\n');
  const tail = body.slice(sectionEnd);
  return `${head}${bullet}\n${tail}`;
}

/** Apply a structured plan change. Frontmatter moves only through the named fields. `--old` matches the body once. */
export function applyPlanUpdate(text, change) {
  const match = String(text).match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) throw usage('plan-update: plan has no frontmatter');
  let fm;
  try {
    fm = YAML.parse(match[1], { maxAliasCount: 50 });
  } catch (error) {
    throw usage(`plan-update: frontmatter is invalid (${error.message})`);
  }
  if (!fm || typeof fm !== 'object' || Array.isArray(fm)) throw usage('plan-update: frontmatter is invalid');

  if (change.status !== undefined) {
    if (!PLAN_STATUSES.includes(change.status)) {
      throw usage(`plan-update: --status must be one of ${PLAN_STATUSES.join('|')}`);
    }
    fm.status = change.status;
  }
  if (change.lock) fm.plan_lock = true;
  if (change.intent !== undefined) fm.intent = oneLine(change.intent, '--intent');
  if (change.intentSources?.length) fm.intent_sources = appendIntentSources(fm.intent_sources, change.intentSources);
  if (change.expectedOutputs?.length) fm.expected_outputs = appendLines(fm.expected_outputs, change.expectedOutputs, '--expected-output');
  if (change.successCriteria?.length) fm.success_criteria = appendLines(fm.success_criteria, change.successCriteria, '--success-criterion');
  if (change.verificationChecks?.length) fm.verification = appendChecks(fm.verification, change.verificationChecks);
  if (change.gapFulfillment?.length) fm.capability_gaps = fulfillGaps(fm.capability_gaps, change.gapFulfillment);

  const reviews = fm.reviews && typeof fm.reviews === 'object' && !Array.isArray(fm.reviews) ? fm.reviews : {};
  fm.reviews = {
    ...reviews,
    required: Array.isArray(reviews.required) ? reviews.required : [],
    completed: Array.isArray(reviews.completed) ? reviews.completed.slice() : [],
    critical_open: Array.isArray(reviews.critical_open) ? reviews.critical_open.slice() : [],
  };

  if (change.clearCritical && change.criticalOpen) {
    throw usage('plan-update: --clear-critical cannot be combined with --critical-open');
  }
  if (change.clearCritical) fm.reviews.critical_open = [];
  if (change.criticalOpen) {
    fm.reviews.critical_open = change.criticalOpen.map((item) => {
      const text = oneLine(item, '--critical-open');
      if (text.length > 200) throw usage('plan-update: --critical-open must be at most 200 characters');
      return text;
    });
  }
  for (const id of change.completed || []) {
    const review = oneLine(id, '--review-completed');
    if (!REVIEW_ID.test(review)) throw usage('plan-update: --review-completed must be a lowercase id');
    if (!fm.reviews.completed.includes(review)) fm.reviews.completed.push(review);
  }

  let body = text.slice(match[0].length).replace(/^(?:\r?\n)/, '');
  if (change.old !== undefined || change.next !== undefined) {
    if (typeof change.old !== 'string' || typeof change.next !== 'string') {
      throw usage('plan-update: --old and --new are required together');
    }
    if (change.old.length === 0) throw usage('plan-update: --old must not be empty');
    let count = 0;
    let from = 0;
    let at = -1;
    while (from <= body.length) {
      const found = body.indexOf(change.old, from);
      if (found === -1) break;
      if (count === 0) at = found;
      count += 1;
      from = found + change.old.length;
    }
    if (count !== 1) throw usage(`plan-update: --old matched ${count} times in the plan body`);
    body = body.slice(0, at) + change.next + body.slice(at + change.old.length);
  }
  for (const line of change.activity || []) {
    const text = oneLine(line, '--activity');
    if (text.length > 400) throw usage('plan-update: --activity must be at most 400 characters');
    body = appendActivity(body, text);
  }

  return `---\n${YAML.stringify(fm, { lineWidth: 0 })}---\n${body}`;
}

function stampLockedIntentSources(workspace, text, { rehash, mergeDiscovered }) {
  const match = String(text).match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return text;
  let fm;
  try {
    fm = YAML.parse(match[1], { maxAliasCount: 50 });
  } catch {
    return text;
  }
  if (!fm || typeof fm !== 'object' || Array.isArray(fm) || !fm.plan_lock) return text;
  const listed = Array.isArray(fm.intent_sources) ? fm.intent_sources : [];
  const locked = mergeDiscovered
    ? bindLockedIntentSources(workspace, listed, { query: typeof fm.intent === 'string' ? fm.intent : '' })
    : lockIntentSources(workspace, listed, { rehash });
  if (!locked.length) {
    if (!listed.length) return text;
    delete fm.intent_sources;
  } else {
    fm.intent_sources = locked;
  }
  const body = text.slice(match[0].length).replace(/^(?:\r?\n)/, '');
  return `---\n${YAML.stringify(fm, { lineWidth: 0 })}---\n${body}`;
}

function take(scan, index) {
  const value = scan[index + 1];
  if (value === undefined) throw usage(`plan-update: ${scan[index]} requires a value`);
  return { value, index: index + 1 };
}

function publishPlanFile(full, text) {
  const temporary = path.join(path.dirname(full), `.${path.basename(full)}.${randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temporary, text, { encoding: 'utf8', flag: 'wx', mode: fs.statSync(full).mode & 0o777 });
    fs.renameSync(temporary, full);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

function structuredPlanUpdate({ workspace, full, input, flags, dryRun }) {
  validatePlanDecision(input);
  const copilotHome = resolveCopilotHome(flags.copilotHome);
  return withPlanUpdateLock(full, () => {
    const plan = loadPlan(workspace, full);
    if (!plan) throw usage('plan is unreadable');
    const rel = `.harness/operations/plans/${reviewHash({ plan: plan.path, operation: input.id })}.json`;
    const inputDigest = reviewHash(input);
    const existing = readReviewRecord(workspace, rel);
    const operation = reviewHash({ plan: plan.path, inputDigest });
    if (existing && (existing.version !== 1 || existing.operation !== operation || existing.inputDigest !== inputDigest || existing.plan !== plan.path || existing.value?.plan !== plan.path || existing.value?.before !== input.expect || existing.value?.action !== input.action || typeof existing.value?.text !== 'string' || planRevision(existing.value.text) !== existing.value.after || reviewHash(existing.value) !== existing.integrity)) throw usage('operation identity has different or corrupt payload');
    if (existing?.state === 'completed') return { ...existing.result, replayed: true, currentRevision: planRevision(plan.text), current: planRevision(plan.text) === existing.value.after && intentSourcesCheck(plan, workspace).pass && gapEvidenceCheck(workspace, plan).pass && validatePlanSchema(plan).pass, allowedNextActions: ['Inspect current state; a replay does not renew an expired gate'] };
    if (existing && existing.state !== 'pending') throw usage('operation state is invalid');
    const current = planRevision(plan.text);
    if (existing ? ![existing.value.before, existing.value.after].includes(current) : input.expect !== current) throw usage('stale plan revision; reread before accepting a new decision');
    const recordedAt = existing?.value.recordedAt || new Date().toISOString();
    const decision = existing ? { text: existing.value.text, amendments: existing.value.amendments, authority: existing.value.authority } : applyPlanDecision(workspace, plan, input, { applyUpdate: applyPlanUpdate, recordedAt });
    const proposed = planFromText(decision.text, { path: plan.path, fullPath: full });
    const schema = validatePlanSchema(proposed);
    const missing = schema.checks.filter(check => !check.pass).map(check => check.message);
    let gate = null;
    if (input.action === 'start') {
      if (!existing) missing.push(...validatePlanReadiness(workspace, plan).checks.filter(check => !check.pass).map(check => check.message));
      gate = runGate({ workspace, flags: { ...flags, plan: plan.path, phase: 'implement' }, planOverride: proposed });
      missing.push(...gate.checks.filter(check => !check.pass).map(check => check.message));
      const scope = validatePlanScope({ workspace, plan: proposed });
      if (scope.status !== 'passed') missing.push(scope.message);
    }
    if (input.changes?.criteria) missing.push(...validatePlanReadiness(workspace, proposed).checks.filter(check => !check.pass).map(check => check.message));
    if (input.action === 'complete') {
      const prerequisites = completionPrerequisites({ workspace, plan: proposed, copilotHome });
      if (!prerequisites.pass) missing.push(prerequisites.message);
    }
    if (missing.length || gate && (!gate.pass || gate.exitCode !== 0)) return { status: 'blocked', path: full, missing: [...new Set(missing)], allowedNextActions: ['Repair the named prerequisites, then retry the same decision if the revision is unchanged'], updated: false };
    if (!decision.amendments.every(source => hashIntentFile(workspace, source.path) === source.newHash)) throw usage('intent source changed while applying the amendment');
    if (gate && !intentSourcesCheck(proposed, workspace).pass) throw usage('selected intent source changed before start publication');
    const completion = input.action === 'complete' ? completeWork({ workspace, plan: proposed, copilotHome, dryRun }) : null;
    const affectedEvidence = planDigest(plan.text) === planDigest(proposed.text) ? null : {
      verification: readEvidence(workspace, plan.path)?.evidencePath || null,
      review: readReviewRecord(workspace, `.harness/reviews/latest/${recordHash(plan.path)}.json`)?.id || null,
      completion: readReviewRecord(workspace, `.harness/completions/${recordHash(plan.path)}.json`)?.id || null,
    };
    const value = existing?.value || { plan: plan.path, action: input.action, recordedAt, before: current, after: planRevision(decision.text), text: decision.text, amendments: decision.amendments, authority: decision.authority, affectedEvidence };
    const result = { version: 1, status: 'ok', path: full, operation, operationPath: rel, action: input.action, revision: value.after, planState: planState(proposed), amendments: value.amendments, authority: value.authority, affectedEvidence: value.affectedEvidence, completion: completion?.id || null, missing: [], allowedNextActions: input.action === 'start' ? ['Edit within the accepted scope', 'Run required review and verification'] : ['Inspect the updated contract', 'Start or refresh the implement gate before edits'], dryRun, updated: !dryRun && current !== value.after };
    const record = { version: 1, state: 'pending', plan: plan.path, inputDigest, operation, integrity: reviewHash(value), value, result };
    if (!dryRun) {
      publishReviewRecord(workspace, rel, record);
      if (readFileNoFollow(full) !== plan.text) throw usage('plan changed during the operation; reread before retry');
      if (current !== value.after) publishPlanFile(full, value.text);
      if (gate) publishGateSession({ workspace, result: gate, policy: loadPolicy(workspace, flags.enforcement, { copilotHome }) });
      publishReviewRecord(workspace, rel, { ...record, state: 'completed' });
    }
    return result;
  });
}

export async function cmdPlanUpdate(argv) {
  const boundary = argv.indexOf('--');
  const scan = boundary === -1 ? argv : argv.slice(0, boundary);
  let workspace = process.cwd();
  let json = false;
  let dryRun = false;
  let planArg;
  let fileArg;
  const change = {
    activity: [],
    completed: [],
    expectedOutputs: [],
    successCriteria: [],
    verificationChecks: [],
    gapFulfillment: [],
    intentSources: [],
  };

  for (let i = 0; i < scan.length; i++) {
    const token = scan[i];
    if (token === '--file') {
      ({ value: fileArg, index: i } = take(scan, i));
    } else if (token === '--plan') {
      ({ value: planArg, index: i } = take(scan, i));
    } else if (token === '--status') {
      ({ value: change.status, index: i } = take(scan, i));
    } else if (token === '--activity') {
      const next = take(scan, i);
      change.activity.push(next.value);
      i = next.index;
    } else if (token === '--review-completed') {
      const next = take(scan, i);
      change.completed.push(next.value);
      i = next.index;
    } else if (token === '--critical-open') {
      const next = take(scan, i);
      change.criticalOpen = change.criticalOpen || [];
      change.criticalOpen.push(next.value);
      i = next.index;
    } else if (token === '--clear-critical') {
      change.clearCritical = true;
    } else if (token === '--lock') {
      change.lock = true;
    } else if (token === '--intent') {
      ({ value: change.intent, index: i } = take(scan, i));
    } else if (token === '--intent-source') {
      const next = take(scan, i);
      change.intentSources.push(next.value);
      i = next.index;
    } else if (token === '--expected-output') {
      const next = take(scan, i);
      change.expectedOutputs.push(next.value);
      i = next.index;
    } else if (token === '--success-criterion') {
      const next = take(scan, i);
      change.successCriteria.push(next.value);
      i = next.index;
    } else if (token === '--verification-check') {
      const next = take(scan, i);
      change.verificationChecks.push(next.value);
      i = next.index;
    } else if (token === '--gap-fulfillment') {
      const next = take(scan, i);
      change.gapFulfillment.push(next.value);
      i = next.index;
    } else if (token === '--old') {
      ({ value: change.old, index: i } = take(scan, i));
    } else if (token === '--new') {
      ({ value: change.next, index: i } = take(scan, i));
    } else if (token === '--workspace') {
      ({ value: workspace, index: i } = take(scan, i));
      workspace = path.resolve(workspace);
    } else if (token === '--json') json = true;
    else if (token === '--dry-run') dryRun = true;
    else if (token === '--harness-home' || token === '--copilot-home' || token === '--no-events' || token === '--verbose' || token === '--no-color') {
      if (token !== '--no-events' && token !== '--verbose' && token !== '--no-color') i += 1;
    } else if (token.startsWith('-')) throw usage(`plan-update: unknown flag ${token}`);
    else throw usage(`plan-update: unexpected argument ${token}`);
  }

  const hasChange = change.status !== undefined
    || change.lock
    || change.intent !== undefined
    || change.intentSources.length > 0
    || change.activity.length > 0
    || change.completed.length > 0
    || change.expectedOutputs.length > 0
    || change.successCriteria.length > 0
    || change.verificationChecks.length > 0
    || change.gapFulfillment.length > 0
    || change.criticalOpen
    || change.clearCritical
    || change.old !== undefined
    || change.next !== undefined;
  if (!hasChange && !fileArg) throw usage('plan-update: provide a structured decision or a status, activity, review, or body change');

  const home = harnessGlobalHome();
  const full = resolvePlanUpdateFile(workspace, planArg, { home });
  if (fileArg) {
    if (hasChange) throw usage('--file cannot be combined with legacy mutation flags');
    const content = readFileNoFollow(path.resolve(workspace, fileArg), { maxBytes: 1024 * 1024 });
    if (content === null) throw usage('decision file is missing, unsafe or over 1 MiB');
    let input;
    try { input = JSON.parse(content); } catch { throw usage('decision file must contain JSON'); }
    const result = structuredPlanUpdate({ workspace, full, input, flags: parseFlags(argv), dryRun });
    console.log(redactedJson(result));
    return result.status === 'blocked' ? 1 : 0;
  }
  const lockDir = acquirePlanLock(full);
  let written;
  let original = '';
  let next = '';
  let completion = null;
  try {
    original = fs.readFileSync(full, 'utf8');
    const currentPlan = loadPlan(workspace, full);
    if (currentPlan?.fm.intent_source_policy === 'content-v1' && currentPlan.plan_lock) {
      if (change.intentSources.length) throw usage('selected sources are frozen; use an explicit amendment');
      if (change.lock && !intentSourcesCheck(currentPlan, workspace).pass) throw usage('selected intent source changed; use an explicit amendment instead of rehashing --lock');
    }
    next = applyPlanUpdate(original, change);
    if (change.lock || change.intentSources.length) {
      next = stampLockedIntentSources(workspace, next, {
        rehash: Boolean(change.lock) && !(currentPlan?.fm.intent_source_policy === 'content-v1' && currentPlan.plan_lock),
        mergeDiscovered: Boolean(change.lock) && !(currentPlan?.fm.intent_source_policy === 'content-v1' && currentPlan.plan_lock),
      });
    }
    if (change.status === 'done') {
      const plan = loadPlan(workspace, full);
      const fm = parsePlanFrontmatter(next);
      completion = completeWork({ workspace, plan: { ...plan, text: next, fm, status: fm.status }, copilotHome: resolveCopilotHome(parseFlags(argv).copilotHome), dryRun });
    }
    if (!dryRun && next !== original) {
      publishPlanFile(full, next);
    }
    written = dryRun ? next : fs.readFileSync(full, 'utf8');
  } finally {
    releasePlanLock(lockDir);
  }
  const fm = YAML.parse(written.match(/^---\r?\n([\s\S]*?)\r?\n---/)[1]);
  if (json) {
    console.log(redactedJson({
      path: full,
      updated: !dryRun && next !== original,
      dryRun,
      status: fm.status,
      reviews: fm.reviews,
      completion: completion?.id || null,
      revision: planRevision(written),
    }));
  } else {
    const ui = createStyle();
    console.log(ui.line({
      state: 'ok',
      key: 'plan-update',
      value: dryRun ? `would update ${full}` : full,
    }));
  }
  return 0;
}
