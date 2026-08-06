// `structural-expectations` verify check — compares the structural diff of
// the change against the plan. Advisory by default (policy.yaml v2 `checks:`
// can escalate to warn/enforce); a missing or stale structural index skips
// rather than guessing, so this check can never invent a failure.

import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { extract, SOURCE_EXTENSIONS } from '../repo-map/lexical-extractor.mjs';
import { readFileSafe } from '../repo-map/scan.mjs';
import { matchesScope, parseImpactedFiles } from '../plan-scope.mjs';
import { readStructuralIndex } from './shape.mjs';

export const STRUCTURAL_CHECK_ID = 'structural-expectations';

const EXPECTATION_CHANGES = new Set(['added', 'removed', 'modified']);

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
 * Returns `{ diffs, tierSkipped }`: `tierSkipped` maps files whose baseline
 * entry was built by a non-lexical extractor tier — the current side of the
 * diff is ALWAYS the lexical extractor, so comparing against a treesitter
 * baseline would disagree on unchanged code and fabricate added/removed
 * findings. Those files are skipped honestly (reported as informational
 * `tier-mismatch-skipped`), never diffed. */
function diffChangedFiles({ workspace, index, changedFiles }) {
  const rowsByFile = new Map();
  for (const row of index.symbols) {
    if (!row || typeof row.file !== 'string' || typeof row.name !== 'string') continue;
    if (!rowsByFile.has(row.file)) rowsByFile.set(row.file, []);
    rowsByFile.get(row.file).push(row);
  }

  const diffs = new Map();
  const tierSkipped = new Map();
  for (const file of changedFiles) {
    const ext = path.extname(file).toLowerCase();
    const rows = rowsByFile.get(file) || [];
    const fileEntry = index.files[file];
    if (!SOURCE_EXTENSIONS.has(ext) && !fileEntry && rows.length === 0) continue;
    // Per-file tier gate: only a lexical-tier (or untiered legacy/fixture)
    // baseline entry diffs soundly against the lexical current side.
    const tier = typeof fileEntry?.tier === 'string' ? fileEntry.tier : null;
    if (tier && tier !== 'lexical') {
      tierSkipped.set(file, tier);
      continue;
    }

    // readFileSafe: symlink-safe (ancestor walk + no-follow leaf, contained in
    // the workspace) and size-capped — a committed symlink or oversized file
    // reads as empty, exactly like a deleted file.
    let current = [];
    const content = readFileSafe(workspace, file);
    if (content) {
      try {
        current = extract(file, content).symbols;
      } catch {
        current = [];
      }
    }
    const currentSet = new Set(current);
    const baselineNames = new Set([
      ...(Array.isArray(fileEntry?.symbols) ? fileEntry.symbols : []),
      ...rows.map((row) => row.name),
    ]);
    const exportedRows = rows.filter((row) => row.exported === true);

    diffs.set(file, {
      added: current.filter((name) => !baselineNames.has(name)).sort(),
      removed: [...baselineNames].filter((name) => !currentSet.has(name)).sort(),
      removedExported: [...new Set(exportedRows.map((row) => row.name))].filter((name) => !currentSet.has(name)).sort(),
      baselineNames,
      currentSet,
    });
  }
  return { diffs, tierSkipped };
}

function survivingCallers({ index, file, symbol, changedSet }) {
  const target = `${file}#${symbol}`;
  const callers = new Set();
  for (const edge of index.graph.calls) {
    if (edge?.to === target) callers.add(symbolFile(edge.from));
  }
  for (const row of index.symbols) {
    if (row?.file !== file || row?.name !== symbol) continue;
    for (const ref of Array.isArray(row.refs) ? row.refs : []) {
      if (ref && typeof ref.file === 'string') callers.add(ref.file);
    }
  }
  callers.delete(file);
  return [...callers].filter((caller) => caller && !changedSet.has(caller)).sort();
}

function expectationObserved(expectation, diffs) {
  const diff = diffs.get(expectation.file);
  if (!diff) return false;
  if (expectation.change === 'added') return diff.added.includes(expectation.symbol);
  if (expectation.change === 'removed') return diff.removed.includes(expectation.symbol);
  // modified: the file changed and the symbol survived on both sides.
  return diff.baselineNames.has(expectation.symbol) && diff.currentSet.has(expectation.symbol);
}

function evaluateExpectations(plan, diffs, tierSkipped = new Map()) {
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
    const { diffs, tierSkipped } = diffChangedFiles({ workspace, index, changedFiles: changed });
    // Per-file tier mismatches surface as informational notes, never findings:
    // the skip is honest ("could not compare"), not evidence of a problem.
    const tierNotes = [...tierSkipped].map(([file, tier]) => ({
      type: 'tier-mismatch-skipped',
      file,
      tier,
      message: `baseline entry for ${file} was built by the '${tier}' extractor tier; the current side is lexical — symbol diff skipped as unsound`,
    }));

    const findings = [];
    for (const [file, diff] of diffs) {
      const symbolChanges = [...diff.added, ...diff.removedExported];
      if (symbolChanges.length && !matchesScope(file, allowed)) {
        findings.push({ type: 'unplanned-symbol-change', file, added: diff.added, removed: diff.removedExported });
      }
      for (const symbol of diff.removedExported) {
        const callers = survivingCallers({ index, file, symbol, changedSet });
        if (callers.length) findings.push({ type: 'removed-symbol-with-callers', file, symbol, callers });
      }
    }

    const expectations = evaluateExpectations(plan, diffs, tierSkipped);
    findings.push(...expectations.findings);
    const informational = [...tierNotes, ...expectations.informational];

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
