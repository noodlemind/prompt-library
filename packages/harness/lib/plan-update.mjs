import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { createStyle, EXIT } from './style.mjs';
import { redactedJson } from './redact.mjs';
import { externalPlansDir } from './project-layout.mjs';
import { harnessGlobalHome } from './paths.mjs';
import { normalizePlanRel } from './plan-parse.mjs';

const PLAN_STATUSES = ['open', 'planned', 'in-progress', 'review', 'done', 'blocked-capability', 'needs-info'];
const REVIEW_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const LEGACY_PLAN_RELS = ['docs/plans', '.harness/plans'];

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

/**
 * Resolve `--plan` to a real plan file inside a plan root.
 * Symlinks are refused, including a link whose target sits inside the store.
 */
export function resolvePlanUpdateFile(workspace, planArg, { home } = {}) {
  if (typeof planArg !== 'string' || !planArg.trim()) throw usage('plan-update: --plan is required');
  const normalized = normalizePlanRel(workspace, planArg, { home });
  if (!normalized) throw usage('plan-update: path is outside the plan store');
  const full = path.isAbsolute(normalized) ? normalized : path.resolve(workspace, normalized);
  let listed;
  try {
    listed = fs.lstatSync(full);
  } catch {
    throw usage('plan-update: path is outside the plan store');
  }
  if (!listed.isFile() || listed.isSymbolicLink()) throw usage('plan-update: path is outside the plan store');
  const real = fs.realpathSync(full);
  const base = path.basename(real);
  if (!real.endsWith('.md') || base === 'README.md' || base.startsWith('_')) {
    throw usage('plan-update: path is outside the plan store');
  }
  const roots = planUpdateRoots(workspace, { home }).map(realDirectory).filter(Boolean);
  if (!roots.some((root) => contained(root, real))) throw usage('plan-update: path is outside the plan store');
  return real;
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

function take(scan, index) {
  const value = scan[index + 1];
  if (value === undefined) throw usage(`plan-update: ${scan[index]} requires a value`);
  return { value, index: index + 1 };
}

export async function cmdPlanUpdate(argv) {
  const boundary = argv.indexOf('--');
  const scan = boundary === -1 ? argv : argv.slice(0, boundary);
  let workspace = process.cwd();
  let json = false;
  let dryRun = false;
  let planArg;
  const change = { activity: [], completed: [] };

  for (let i = 0; i < scan.length; i++) {
    const token = scan[i];
    if (token === '--plan') {
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
    || change.activity.length > 0
    || change.completed.length > 0
    || change.criticalOpen
    || change.clearCritical
    || change.old !== undefined
    || change.next !== undefined;
  if (!hasChange) throw usage('plan-update: provide a status, activity, review, or body change');

  const home = harnessGlobalHome();
  const full = resolvePlanUpdateFile(workspace, planArg, { home });
  const original = fs.readFileSync(full, 'utf8');
  const next = applyPlanUpdate(original, change);
  if (!dryRun && next !== original) {
    const tmp = path.join(path.dirname(full), `.${path.basename(full)}.${process.pid}.tmp`);
    try {
      fs.writeFileSync(tmp, next, 'utf8');
      fs.renameSync(tmp, full);
    } catch (error) {
      try { fs.rmSync(tmp, { force: true }); } catch { /* the original plan is unchanged */ }
      throw error;
    }
  }
  const written = dryRun ? next : fs.readFileSync(full, 'utf8');
  const fm = YAML.parse(written.match(/^---\r?\n([\s\S]*?)\r?\n---/)[1]);
  if (json) {
    console.log(redactedJson({
      path: full,
      updated: !dryRun && next !== original,
      dryRun,
      status: fm.status,
      reviews: fm.reviews,
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
