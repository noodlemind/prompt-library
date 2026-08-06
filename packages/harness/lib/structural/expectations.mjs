// `structural-expectations` verify check — compares the structural diff of
// the change against the plan. Advisory by default (policy.yaml v2 `checks:`
// can escalate to warn/enforce); a missing or stale structural index skips
// rather than guessing, so this check can never invent a failure.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { extract, SOURCE_EXTENSIONS } from '../repo-map/lexical-extractor.mjs';
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

/** Per-changed-file structural diff against the baseline index. */
function diffChangedFiles({ workspace, index, changedFiles }) {
  const rowsByFile = new Map();
  for (const row of index.symbols) {
    if (!row || typeof row.file !== 'string' || typeof row.name !== 'string') continue;
    if (!rowsByFile.has(row.file)) rowsByFile.set(row.file, []);
    rowsByFile.get(row.file).push(row);
  }

  const diffs = new Map();
  for (const file of changedFiles) {
    const ext = path.extname(file).toLowerCase();
    const rows = rowsByFile.get(file) || [];
    const fileEntry = index.files[file];
    if (!SOURCE_EXTENSIONS.has(ext) && !fileEntry && rows.length === 0) continue;

    const full = path.join(workspace, file);
    let current = [];
    if (fs.existsSync(full)) {
      try {
        current = extract(file, fs.readFileSync(full, 'utf8')).symbols;
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
  return diffs;
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

function evaluateExpectations(plan, diffs) {
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
    const diffs = diffChangedFiles({ workspace, index, changedFiles: changed });

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

    const expectations = evaluateExpectations(plan, diffs);
    findings.push(...expectations.findings);

    if (findings.length) {
      const kinds = [...new Set(findings.map((finding) => finding.type))].join(', ');
      return {
        status: 'failed',
        message: `${findings.length} structural finding${findings.length === 1 ? '' : 's'} (${kinds})`,
        findings,
        informational: expectations.informational,
        baseline,
      };
    }
    return {
      status: 'passed',
      message: `Structural diff matches the plan (${diffs.size} file${diffs.size === 1 ? '' : 's'} examined)`,
      findings,
      informational: expectations.informational,
      baseline,
    };
  } catch (error) {
    // The advisory machinery must never be the reason a verify run breaks.
    return { status: 'skipped', message: `Advisory structural check skipped: ${error.message}`, findings: [], informational: [], baseline: null };
  }
}
