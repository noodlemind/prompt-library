// `structural-expectations` verify check — compares the structural diff of
// the change against the plan. Advisory by default (policy.yaml v2 `checks:`
// can escalate to warn/enforce); a missing or stale structural index skips
// rather than guessing, so this check can never invent a failure.
//
// ONE RULE THROUGHOUT: never assert what was not compared. A file whose
// baseline came from another extractor tier, a file in a language this check
// cannot read, and a finding computed from a table the index build truncated
// all stay INFORMATIONAL; and a run that compared nothing reports `skipped`,
// never `passed` — a green gate over an empty comparison is worse than no
// gate, because an `enforce` opt-in would read it as evidence.

import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { extract, SOURCE_EXTENSIONS } from '../repo-map/lexical-extractor.mjs';
import { readFileSafe } from '../repo-map/scan.mjs';
import { matchesScope, parseImpactedFiles } from '../plan-scope.mjs';
import { readStructuralIndex } from './shape.mjs';

export const STRUCTURAL_CHECK_ID = 'structural-expectations';

const EXPECTATION_CHANGES = new Set(['added', 'removed', 'modified']);
// Findings are rendered and stored (evidence, ledger, JSON): the name lists
// inside them are bounded like every other retrieved-text surface. A capped
// list carries its own total so the count is never silently lost.
const MAX_FINDING_NAMES = 50;

function capList(list) {
  return list.length > MAX_FINDING_NAMES ? list.slice(0, MAX_FINDING_NAMES) : list;
}

/** `{ added: [...] }` → `{ addedTotal: n }` for each list the cap shortened. */
function overflow(lists) {
  const extra = {};
  for (const [field, list] of Object.entries(lists)) {
    if (list.length > MAX_FINDING_NAMES) extra[`${field}Total`] = list.length;
  }
  return extra;
}

function shortSha(sha) {
  return String(sha || '').slice(0, 12);
}

function baselineIsAncestor(workspace, sha) {
  const result = spawnSync('git', ['merge-base', '--is-ancestor', sha, 'HEAD'], {
    cwd: workspace,
    encoding: 'utf8',
    timeout: 15_000,
  });
  return result.status === 0;
}

function symbolFile(qualified) {
  const at = String(qualified || '').indexOf('#');
  return at === -1 ? String(qualified || '') : String(qualified).slice(0, at);
}

/** Per-changed-file structural diff against the baseline index.
 * Returns `{ diffs, tierSkipped, notEvaluated }`:
 * - `tierSkipped` maps files whose baseline entry was built by a non-lexical
 *   extractor tier — the current side of the diff is ALWAYS the lexical
 *   extractor, so comparing against a treesitter baseline would disagree on
 *   unchanged code and fabricate added/removed findings. Those files are
 *   skipped honestly (reported as informational `tier-mismatch-skipped`).
 * - `notEvaluated` maps changed files this check simply cannot speak about
 *   (a language the lexical extractor does not read, with no baseline entry).
 *   They are NOT diffed and, like tier skips, can never produce a finding —
 *   including an `unmet-required-expectation`, which would otherwise fire for
 *   every `.go`/`.rs`/`.rb` file regardless of what the change did. */
function diffChangedFiles({ workspace, index, changedFiles }) {
  const rowsByFile = new Map();
  for (const row of index.symbols) {
    if (!row || typeof row.file !== 'string' || typeof row.name !== 'string') continue;
    if (!rowsByFile.has(row.file)) rowsByFile.set(row.file, []);
    rowsByFile.get(row.file).push(row);
  }

  const diffs = new Map();
  const tierSkipped = new Map();
  const notEvaluated = new Map();
  for (const file of changedFiles) {
    const ext = path.extname(file).toLowerCase();
    const rows = rowsByFile.get(file) || [];
    const fileEntry = index.files[file];
    if (!SOURCE_EXTENSIONS.has(ext) && !fileEntry && rows.length === 0) {
      notEvaluated.set(file, `no baseline entry and ${ext || 'no extension'} is not a language this check reads`);
      continue;
    }
    // Per-file tier gate: only a lexical-tier baseline entry diffs soundly
    // against the lexical current side. An untiered entry inherits the
    // index-wide meta.extractorTier — a legacy/fixture index with no tier
    // anywhere still diffs, but an untiered file inside a treesitter-tier
    // index must not be compared against lexical output.
    const tier =
      typeof fileEntry?.tier === 'string'
        ? fileEntry.tier
        : typeof index.meta?.extractorTier === 'string'
          ? index.meta.extractorTier
          : null;
    if (tier && tier !== 'lexical') {
      tierSkipped.set(file, tier);
      continue;
    }

    // readFileSafe: symlink-safe (ancestor walk + no-follow leaf, contained in
    // the workspace) and size-capped — a committed symlink or oversized file
    // reads as empty, exactly like a deleted file.
    let current = [];
    let currentExported = [];
    const content = readFileSafe(workspace, file);
    if (content) {
      try {
        const extracted = extract(file, content);
        current = extracted.symbols;
        currentExported = extracted.exported || [];
      } catch {
        current = [];
      }
    }
    const currentSet = new Set(current);
    const currentExportedSet = new Set(currentExported);
    const baselineNames = new Set([
      ...(Array.isArray(fileEntry?.symbols) ? fileEntry.symbols : []),
      ...rows.map((row) => row.name),
    ]);
    const exportedRows = rows.filter((row) => row.exported === true);
    const added = current.filter((name) => !baselineNames.has(name)).sort();

    diffs.set(file, {
      added,
      // The contract speaks about EXPORTED symbols: an added local helper is
      // not a change to what other modules can see.
      addedExported: added.filter((name) => currentExportedSet.has(name)),
      removed: [...baselineNames].filter((name) => !currentSet.has(name)).sort(),
      removedExported: [...new Set(exportedRows.map((row) => row.name))].filter((name) => !currentSet.has(name)).sort(),
      baselineNames,
      currentSet,
    });
  }
  return { diffs, tierSkipped, notEvaluated };
}

/** Caller lookup tables, built ONCE per run. Building them per removed symbol
 * re-walked the whole call-edge and symbol-row tables for every candidate. */
function callerIndex(index) {
  const byTarget = new Map();
  const add = (key, file) => {
    if (!file) return;
    if (!byTarget.has(key)) byTarget.set(key, new Set());
    byTarget.get(key).add(file);
  };
  for (const edge of index.graph.calls) {
    if (edge && typeof edge.to === 'string') add(edge.to, symbolFile(edge.from));
  }
  for (const row of index.symbols) {
    if (typeof row?.file !== 'string' || typeof row?.name !== 'string') continue;
    for (const ref of Array.isArray(row.refs) ? row.refs : []) {
      if (ref && typeof ref.file === 'string') add(`${row.file}#${row.name}`, ref.file);
    }
  }
  return byTarget;
}

function survivingCallers({ callers, file, symbol, changedSet }) {
  const found = callers.get(`${file}#${symbol}`);
  if (!found) return [];
  return [...found].filter((caller) => caller && caller !== file && !changedSet.has(caller)).sort();
}

function expectationObserved(expectation, diffs) {
  const diff = diffs.get(expectation.file);
  if (!diff) return false;
  if (expectation.change === 'added') return diff.added.includes(expectation.symbol);
  if (expectation.change === 'removed') return diff.removed.includes(expectation.symbol);
  // modified: the file changed and the symbol survived on both sides.
  return diff.baselineNames.has(expectation.symbol) && diff.currentSet.has(expectation.symbol);
}

function evaluateExpectations(plan, diffs, tierSkipped = new Map(), notEvaluated = new Map()) {
  const raw = plan.fm?.structural_expectations;
  const findings = [];
  const informational = [];
  if (raw === undefined || raw === null) return { findings, informational };
  if (!Array.isArray(raw)) {
    informational.push({ type: 'malformed-expectations', message: 'structural_expectations must be a list; block ignored' });
    return { findings, informational };
  }
  for (const entry of raw) {
    const valid =
      entry &&
      typeof entry === 'object' &&
      typeof entry.file === 'string' &&
      typeof entry.symbol === 'string' &&
      EXPECTATION_CHANGES.has(entry.change);
    if (!valid) {
      informational.push({ type: 'malformed-expectation', entry, message: 'expected {file, symbol, change: added|removed|modified}' });
      continue;
    }
    // A tier-skipped file has no diff to evaluate against — the expectation is
    // unverifiable here, never a fabricated failure.
    if (tierSkipped.has(entry.file)) {
      informational.push({
        type: 'tier-mismatch-skipped',
        file: entry.file,
        symbol: entry.symbol,
        change: entry.change,
        message: `expectation on ${entry.file} not evaluated: baseline entry tier '${tierSkipped.get(entry.file)}' does not match the lexical current side`,
      });
      continue;
    }
    // Same discipline for a file the check cannot read at all: "could not
    // compare" is informational, never a required-expectation failure.
    if (notEvaluated.has(entry.file)) {
      informational.push({
        type: 'expectation-not-evaluated',
        file: entry.file,
        symbol: entry.symbol,
        change: entry.change,
        message: `expectation on ${entry.file} not evaluated: ${notEvaluated.get(entry.file)}`,
      });
      continue;
    }
    if (expectationObserved(entry, diffs)) continue;
    const description = { type: 'unmet-expectation', file: entry.file, symbol: entry.symbol, change: entry.change };
    // Only expectations explicitly marked required can fail the check; the
    // rest are informational even when policy escalates the severity.
    if (entry.required === true) findings.push({ ...description, type: 'unmet-required-expectation' });
    else informational.push(description);
  }
  return { findings, informational };
}

/**
 * Run the structural-expectations check.
 * Returns `{ status: 'passed'|'failed'|'skipped', message, findings,
 * informational, baseline }` — a normal verify check body. Never throws.
 */
export function runStructuralExpectations({ workspace, plan, changedFiles, home }) {
  try {
    const index = readStructuralIndex(workspace, { home });
    if (!index.present) {
      return { status: 'skipped', message: `Advisory structural check skipped: ${index.reason}`, findings: [], informational: [], baseline: null };
    }
    const baseline = {
      sha: index.meta.sha,
      generatedAt: index.meta.generatedAt ?? null,
      extractorTier: index.meta.extractorTier ?? null,
    };
    if (!baselineIsAncestor(workspace, index.meta.sha)) {
      return {
        status: 'skipped',
        message: `Structural baseline ${shortSha(index.meta.sha)} is not an ancestor of HEAD; rerun harness index --structural`,
        findings: [],
        informational: [],
        baseline,
      };
    }

    const changed = [...new Set(changedFiles || [])];
    const changedSet = new Set(changed);
    const allowed = parseImpactedFiles(plan);
    const { diffs, tierSkipped, notEvaluated } = diffChangedFiles({ workspace, index, changedFiles: changed });
    // Per-file tier mismatches surface as informational notes, never findings:
    // the skip is honest ("could not compare"), not evidence of a problem.
    const tierNotes = [...tierSkipped].map(([file, tier]) => ({
      type: 'tier-mismatch-skipped',
      file,
      tier,
      message: `baseline entry for ${file} was built by the '${tier}' extractor tier; the current side is lexical — symbol diff skipped as unsound`,
    }));
    const notEvaluatedNotes = [...notEvaluated].map(([file, reason]) => ({
      type: 'file-not-evaluated',
      file,
      message: `${file} not compared: ${reason}`,
    }));

    // A truncated baseline table cannot support an assertion: past the cap a
    // removed symbol simply has no recorded callers and the symbol table is
    // incomplete, so these findings degrade to informational instead of
    // claiming something the data cannot show.
    const truncated = [
      index.meta?.symbolsTruncated ? 'symbol table' : null,
      index.meta?.callEdgesTruncated ? 'call edges' : null,
    ].filter(Boolean);
    const findings = [];
    const degraded = [];
    const record = (finding) => {
      if (truncated.length) {
        degraded.push({
          ...finding,
          type: `${finding.type}-informational`,
          message: `${finding.type} not asserted: the baseline ${truncated.join(' and ')} hit the index build cap, so this comparison is incomplete`,
        });
      } else {
        findings.push(finding);
      }
    };
    // Built on first use only: a run with no removed exports never walks the
    // symbol/edge tables at all.
    let callers = null;
    for (const [file, diff] of diffs) {
      const symbolChanges = [...diff.addedExported, ...diff.removedExported];
      if (symbolChanges.length && !matchesScope(file, allowed)) {
        record({
          type: 'unplanned-symbol-change',
          file,
          added: capList(diff.addedExported),
          removed: capList(diff.removedExported),
          ...overflow({ added: diff.addedExported, removed: diff.removedExported }),
        });
      }
      for (const symbol of diff.removedExported) {
        callers ??= callerIndex(index);
        const surviving = survivingCallers({ callers, file, symbol, changedSet });
        if (surviving.length) {
          record({
            type: 'removed-symbol-with-callers',
            file,
            symbol,
            callers: capList(surviving),
            ...overflow({ callers: surviving }),
          });
        }
      }
    }

    const expectations = evaluateExpectations(plan, diffs, tierSkipped, notEvaluated);
    findings.push(...expectations.findings);
    const informational = [...tierNotes, ...notEvaluatedNotes, ...degraded, ...expectations.informational];

    if (findings.length) {
      const kinds = [...new Set(findings.map((finding) => finding.type))].join(', ');
      return {
        status: 'failed',
        message: `${findings.length} structural finding${findings.length === 1 ? '' : 's'} (${kinds})`,
        findings,
        informational,
        baseline,
      };
    }
    // Zero comparisons is not a pass. A run where every changed file was
    // skipped (tier mismatch, unreadable language) or where nothing comparable
    // changed examined NOTHING — reporting `passed` would be a green gate over
    // an empty comparison, including under an `enforce` opt-in.
    const skippedFiles = tierSkipped.size + notEvaluated.size;
    if (diffs.size === 0) {
      return {
        status: 'skipped',
        message: `Structural check compared nothing (0 files examined${skippedFiles ? `, ${skippedFiles} skipped` : ''})`,
        findings,
        informational,
        baseline,
      };
    }
    return {
      status: 'passed',
      message: `Structural diff matches the plan (${diffs.size} file${diffs.size === 1 ? '' : 's'} examined${tierSkipped.size ? `, ${tierSkipped.size} tier-mismatch-skipped` : ''})`,
      findings,
      informational,
      baseline,
    };
  } catch (error) {
    // The advisory machinery must never be the reason a verify run breaks.
    return { status: 'skipped', message: `Advisory structural check skipped: ${error.message}`, findings: [], informational: [], baseline: null };
  }
}
