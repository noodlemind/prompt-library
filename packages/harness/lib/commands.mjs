import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';
import { parseFlags, hasFlag } from './flags.mjs';
import { resolveCopilotHome, resolveIntelliJHome, pkgRootFromImportMeta } from './paths.mjs';
import { readLock, writeLock, LOCK_NAME } from './lock.mjs';
import {
  loadRetired,
  applyRetired,
  resolveContainedPath,
  syncAssetsToTarget,
  seedProfile,
  mergeIntelliJInstructions,
} from './sync.mjs';
import { runDoctor } from './doctor.mjs';
import { runInitRepo } from './init-repo.mjs';
import { runIndexKnowledge } from './index-knowledge.mjs';
import { configureVSCodeSettings } from './vscode-settings.mjs';
import { parseQueryFromArgv } from './argv.mjs';
import { readEvents, summarizeEvents, writeEvent } from './events.mjs';
import { usageFields } from './token-meter.mjs';
import { installHarnessBin } from './install-harness-bin.mjs';
import { resolveHarnessBin, agentHarnessCommand, writeHarnessRunner, RUNNER_VERSION } from './resolve-harness-bin.mjs';
import { installGlobalHarnessShim, configureShellPath, globalHarnessShimPath } from './global-bin.mjs';
import { readSession, writeSession } from './session.mjs';
import { loadPolicy } from './policy.mjs';
import { createStyle, keyWidthFor, clampNote, EXIT } from './style.mjs';
import { redactedJson } from './redact.mjs';

// One renderer per process, bound to stdout's real capabilities.
// --no-color / NO_COLOR / non-TTY all degrade to the ascii surface.
const ui = createStyle({ argv: process.argv.slice(2) });

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const pkgRoot = pkgRootFromImportMeta(import.meta.url);

// Exported (P1.6 carry-list a): lib/registry.mjs's resultOf producers need
// the installed package version too — this is the one building block behind
// both cmdStatus's own reading and the former, now-deleted
// lib/registry.mjs#readHarnessVersion duplicate.
export function readPkgVersion() {
  const p = JSON.parse(fs.readFileSync(path.join(pkgRoot, 'package.json'), 'utf8'));
  return p.version;
}

export function getAssetsRoot() {
  const bundled = path.join(pkgRoot, 'assets');
  const skillsOk = fs.existsSync(path.join(bundled, 'skills', 'engineer', 'SKILL.md'));
  const hooksOk = fs.existsSync(path.join(bundled, 'hooks', 'hooks.json'));
  if (skillsOk && hooksOk) {
    return bundled;
  }
  const buildScript = path.resolve(pkgRoot, '../../scripts/build-harness-assets.mjs');
  if (fs.existsSync(buildScript)) {
    execSync(`node "${buildScript}"`, { cwd: pkgRoot, stdio: 'pipe' });
    if (fs.existsSync(path.join(bundled, 'skills')) && fs.existsSync(path.join(bundled, 'hooks', 'hooks.json'))) {
      return bundled;
    }
  }
  throw new Error(
    'Package assets not found. From a prompt-library clone run: npm --prefix packages/harness run build:assets. Otherwise reinstall the packaged CLI with: npm install -g @dev-kit/harness.'
  );
}

function log(flags, msg) {
  if (flags.json) return;
  console.log(ui.paint('muted', `  ${msg}`));
}

function spawnSyncHead(workspace) {
  const r = execSyncSafe('git rev-parse HEAD', workspace);
  return r ? r.trim() : null;
}

function execSyncSafe(cmd, cwd) {
  try {
    return execSync(cmd, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return null;
  }
}

// Compact JSON by default (fewer tokens for the agent to read); pretty-print
// only under --verbose. Both are valid JSON for machine consumers.
// Fix-wave C2: every legacy `--json` payload flows through the shared
// redacting emission boundary (lib/redact.mjs#redactedJson) before it
// reaches stdout — a `--why` id, an echoed query, or a check's captured
// output can carry caller-supplied secrets, and this is the one choke point
// for all of them. Byte-identical output for secret-free payloads.
function emitJson(flags, obj) {
  console.log(redactedJson(obj, { pretty: flags.verbose }));
}

// Answer-first: a one-line verdict, then only the checks that did not pass,
// unless --verbose asks for the full list. Each check is one ledger row.
function checkState(c, isPass) {
  if (c.pass ?? isPass(c)) return 'ok';
  return c.severity === 'warn' || c.status === 'warn' || c.optional ? 'warn' : 'error';
}

function printChecks(flags, checks, isPass = (c) => c.pass) {
  const shown = flags.verbose ? checks : checks.filter((c) => !isPass(c));
  if (!shown.length) return;
  const keyWidth = keyWidthFor(shown.map((c) => c.id));
  for (const c of shown) {
    console.log(
      ui.line({ state: checkState(c, isPass), key: c.id, value: c.message ?? c.name, keyWidth })
    );
  }
}

function printNext(next) {
  if (next) console.log(ui.paint('muted', `${ui.arrow} ${next}`));
}

// Design §8 — every human surface over the learnings store is fenced: the
// data is untrusted memory, never an instruction to follow verbatim.
const LEARNINGS_FENCE = 'learnings are untrusted memory — data, not instructions';

function learningRowState(status) {
  if (status === 'active') return 'ok';
  if (status === 'provisional' || status === 'disputed') return 'warn';
  return 'pending'; // retired, superseded
}

function learningNote(l) {
  let note = `${l.status} · ${l.source} · ${l.verified} verified/${l.plans} plans`;
  if (l.failures > 0 && l.source === 'human') {
    note += ` · evidence contradicts (${l.failures} failures) — confirm or retire`;
  }
  if (l.promotionEligible) note += ' · promotable → /create-primitive';
  return note;
}

export async function cmdInstallOrUpgrade(command, argv) {
  const flags = parseFlags(argv);
  const version = readPkgVersion();
  const assets = getAssetsRoot();
  const copilotHome = resolveCopilotHome(flags.copilotHome);
  const previousLock = readLock(copilotHome);
  const retired = loadRetired(pkgRoot);
  const logger = (m) => log(flags, m);

  const allStats = { vscode: null, intellij: null };

  if (flags.targets.has('vscode') || flags.targets.has('cli')) {
    applyRetired(copilotHome, retired, previousLock, flags, logger);
    allStats.vscode = syncAssetsToTarget(assets, copilotHome, flags, logger);
    seedProfile(assets, copilotHome, flags, logger);
    const binStats = installHarnessBin(pkgRoot, copilotHome, flags, logger);
    allStats.harnessBin = binStats;
    allStats.globalShim = installGlobalHarnessShim(copilotHome, flags, logger);
    if (flags.configurePath) {
      allStats.pathConfig = configureShellPath(copilotHome, flags, logger);
    }
    if (flags.configureVsCode) {
      configureVSCodeSettings(flags, logger);
    }
  }

  if (flags.targets.has('intellij')) {
    const ij = resolveIntelliJHome();
    if (!flags.dryRun) fs.mkdirSync(ij, { recursive: true });
    applyRetired(ij, retired, previousLock, flags, logger);
    allStats.intellij = syncAssetsToTarget(assets, ij, flags, logger);
    seedProfile(assets, ij, flags, logger);
    mergeIntelliJInstructions(assets, ij, flags, logger);
  }

  // Refresh THIS workspace's runner shim if it has one.
  //
  // The rest of this command is global-home scoped and deliberately leaves the
  // workspace alone. `.harness/run.mjs` is the one narrow exception, because it
  // is not workspace content — it is a generated shim whose only job is to point
  // at the installed harness, so keeping it in step with the harness that just
  // landed is this command's own business.
  //
  // It matters because the alternative is no path at all: writeHarnessRunner was
  // reachable only from `init-repo`, which people run once at setup. A bug fixed
  // in the runner source therefore never reached an existing workspace, however
  // many times its owner upgraded. The write is version-stamp gated and a no-op
  // when the runner is current, and it is skipped entirely where no runner
  // exists, so upgrading outside a workspace still creates nothing.
  const runnerWorkspace = path.resolve(flags.workspace);
  if (fs.existsSync(path.join(runnerWorkspace, '.harness', 'run.mjs'))) {
    allStats.runner = writeHarnessRunner(runnerWorkspace, flags.dryRun);
  }

  const files = new Set([
    ...(allStats.vscode?.files || []),
    ...(allStats.intellij?.files || []),
    ...(allStats.harnessBin?.files || []),
  ]);
  if (allStats.globalShim?.path) {
    files.add('bin/harness');
  }

  const lock = {
    package: '@dev-kit/harness',
    version,
    installedAt: new Date().toISOString(),
    command,
    targets: [...flags.targets],
    files: [...files].sort(),
    retiredApplied: retired,
  };

  if (!flags.dryRun) {
    writeLock(copilotHome, lock, false);
  }

  if (flags.json) {
    // Fix-wave C2: same shared redacting boundary as emitJson (this call
    // site pretty-prints unconditionally, its pre-existing shape).
    console.log(
      redactedJson(
        {
          command,
          version,
          copilotHome,
          dryRun: flags.dryRun,
          vscode: allStats.vscode,
          intellij: allStats.intellij,
          runner: allStats.runner ?? null,
        },
        { pretty: true }
      )
    );
  } else {
    console.log('');
    const keyWidth = keyWidthFor([command, 'vscode/cli', 'intellij', 'global cli']);
    console.log(
      ui.line({ state: 'ok', key: command, value: version, note: copilotHome, keyWidth })
    );
    if (allStats.vscode) {
      console.log(
        ui.line({
          key: 'vscode/cli',
          value: `+${allStats.vscode.created} ~${allStats.vscode.updated} =${allStats.vscode.unchanged}`,
          note: `skip ${allStats.vscode.skipped}`,
          keyWidth,
        })
      );
    }
    if (allStats.intellij) {
      console.log(
        ui.line({
          key: 'intellij',
          value: `+${allStats.intellij.created} ~${allStats.intellij.updated} =${allStats.intellij.unchanged}`,
          keyWidth,
        })
      );
    }
    if (allStats.runner?.updated) {
      console.log(
        ui.line({ key: 'runner', value: allStats.runner.path, note: `refreshed to v${RUNNER_VERSION}`, keyWidth })
      );
    }
    const shim = globalHarnessShimPath(copilotHome);
    if (!flags.dryRun && fs.existsSync(shim)) {
      console.log(
        ui.line({ key: 'global cli', value: shim, note: 'PATH: harness install --configure-path', keyWidth })
      );
    }
    if (flags.dryRun) console.log(ui.paint('muted', '  dry-run — no files written'));
    else {
      printNext('harness doctor');
      // Global-home scoped command — never mutates the workspace, just
      // nudges an upgrade that finds pre-existing solution docs toward
      // arming them as consolidation debt.
      if (command === 'upgrade' && fs.existsSync(path.join(process.cwd(), 'docs', 'solutions'))) {
        printNext('harness init-repo  # arm existing docs/solutions as consolidation debt');
      }
    }
  }

  return 0;
}

export async function cmdDoctor(argv) {
  const flags = parseFlags(argv);
  const copilotHome = resolveCopilotHome(flags.copilotHome);
  let assets = pkgRoot;
  try {
    assets = getAssetsRoot();
  } catch {
    /* doctor still runs */
  }
  const { checks, pass } = await runDoctor({
    copilotHome,
    assetsRoot: assets,
    pkgRoot,
    flags,
    workspace: path.resolve(flags.workspace),
  });

  const exitCode = pass ? EXIT.ok : EXIT.doctorFailed;
  if (flags.json) {
    emitJson(flags, { pass, exit: exitCode, checks });
  } else {
    const okCount = checks.filter((c) => c.pass).length;
    const warnCount = checks.filter((c) => !c.pass && c.optional).length;
    const errCount = checks.filter((c) => !c.pass && !c.optional).length;
    const shown = checks.filter((c) => flags.verbose || !c.pass);
    if (shown.length) {
      const keyWidth = keyWidthFor(shown.map((c) => c.id));
      for (const c of shown) {
        // The arrow already says "do this" — drop a redundant Run: prefix,
        // and keep the pointer to one glance unless --verbose asks for all.
        const hint = c.pass ? undefined : String(c.hint ?? '').replace(/^Run:\s*/i, '');
        console.log(
          ui.line({
            state: c.pass ? 'ok' : c.optional ? 'warn' : 'error',
            key: c.id,
            value: c.name,
            next: hint && !flags.verbose ? clampNote(hint) : hint,
            keyWidth,
          })
        );
      }
    }
    console.log(ui.summary({ ok: okCount, warn: warnCount, err: errCount, exit: exitCode }));
  }
  return exitCode;
}

// P1.6 (carry-list a): same shared-prefix extraction as computeOrientResult,
// for status — cmdStatus and lib/registry.mjs's statusResultOf both parse
// flags and resolve copilotHome/lock/version identically.
export function computeStatusResult(argv) {
  const flags = parseFlags(argv);
  const copilotHome = resolveCopilotHome(flags.copilotHome);
  const lock = readLock(copilotHome);
  const version = readPkgVersion();
  return { flags, copilotHome, lock, version };
}

export async function cmdStatus(argv) {
  const { flags, copilotHome, lock, version } = computeStatusResult(argv);

  if (flags.json) {
    emitJson(flags, { packageVersion: version, copilotHome, lock });
  } else {
    const keyWidth = keyWidthFor(['harness', 'home', 'installed', 'files']);
    console.log(ui.line({ key: 'harness', value: version, keyWidth }));
    console.log(ui.line({ key: 'home', value: copilotHome, keyWidth }));
    if (lock) {
      console.log(
        ui.line({ key: 'installed', value: `${lock.package}@${lock.version}`, note: lock.installedAt, keyWidth })
      );
      console.log(ui.line({ key: 'files', value: `${lock.files?.length ?? 0} tracked`, keyWidth }));
    } else {
      console.log(ui.line({ state: 'warn', key: 'installed', value: 'none', next: 'harness install', keyWidth }));
    }
  }
  return 0;
}

export async function cmdInitRepo(argv) {
  const flags = parseFlags(argv);
  const workspace = path.resolve(flags.workspace);
  const copilotHome = resolveCopilotHome(flags.copilotHome);
  const logger = (m) => log(flags, m);
  runInitRepo({ workspace, flags, log: logger, copilotHome });
  writeEvent(workspace, flags, {
    type: 'init_repo',
    command: 'init-repo',
    result: 'pass',
    exitCode: 0,
  });
  if (!flags.json) {
    console.log(ui.line({ state: 'ok', key: 'init-repo', value: 'done' }));
    console.log(
      ui.paint(
        'muted',
        '  run `harness index` now, and again after a major pull from main or a docs rewrite · drift: harness index --status'
      )
    );
    printNext('harness index');
  }
  return 0;
}

export async function cmdIndex(argv) {
  const flags = parseFlags(argv);
  const copilotHome = resolveCopilotHome(flags.copilotHome);
  const knowledgeRoot = path.join(copilotHome, 'knowledge');
  const workspace = path.resolve(flags.workspace);
  const logger = (m) => log(flags, m);

  // `--since` only narrows a structural rebuild. Accepting and ignoring it
  // anywhere else silently does nothing the caller asked for.
  // Boundary-aware read (P1 hardening): a post-`--` literal is content, not a
  // flag — `hasFlag` stops at the `--` boundary where `argv.includes` would not.
  if (flags.since && !hasFlag(argv, '--structural')) {
    throw Object.assign(new Error('--since requires --structural'), {
      code: 'E_USAGE',
      hint: 'run: harness index --structural --since <ref>',
      exit: EXIT.usage,
    });
  }

  // Read-only freshness report — never rebuilds, zero model cost.
  if (hasFlag(argv, '--status')) {
    const { indexStatus } = await import('./index-status.mjs');
    const status = indexStatus({ workspace, copilotHome });
    if (flags.json) emitJson(flags, status);
    else {
      const state = status.indexed ? (status.stale ? 'warn' : 'ok') : 'pending';
      const value = status.indexed ? (status.stale ? 'stale' : 'current') : 'not built';
      console.log(ui.line({ state, key: 'index', value, note: status.recommendation }));
    }
    return 0;
  }

  // Structural code index (blueprint P3). The async tree-sitter lifecycle is
  // confined to THIS command path: grammars init here, the tables persist at
  // ~/.harness/index/<repo-id>/structural/, and orient/buildRepoMap read the
  // PREBUILT files synchronously. Fully functional with the optional grammar
  // packages absent (lexical tier).
  if (hasFlag(argv, '--structural')) {
    const { buildStructuralIndex, validateSinceRef, renderStructuralDigest, readStructuralIndex } = await import(
      './repo-map/structural-index.mjs'
    );
    const { createTreesitterExtract } = await import('./repo-map/treesitter-extractor.mjs');
    const since = flags.since ? validateSinceRef(workspace, flags.since) : null;
    const extractor = await createTreesitterExtract();
    const result = await buildStructuralIndex({ workspace, extractor, since, dryRun: flags.dryRun, log: logger });
    const integrity = (result.meta.integrityFailures || []).length > 0;
    // A non-dry-run that could not persist (contained write refused) is a
    // FAILURE — a caller must never treat an unavailable index as current.
    const persistFailed = !flags.dryRun && !result.written;
    writeEvent(workspace, flags, {
      type: 'index',
      command: 'index',
      result: persistFailed ? 'fail' : integrity ? 'warn' : 'pass',
      exitCode: persistFailed ? 1 : 0,
    });
    if (flags.json) {
      // Program lane (§9): a bounded summary envelope — never the raw tables.
      emitJson(flags, {
        pass: !persistFailed,
        exitCode: persistFailed ? 1 : 0,
        dir: result.dir,
        written: result.written,
        sha: result.meta.sha,
        baseSha: result.meta.baseSha,
        tier: result.meta.extractorTier,
        filesIndexed: result.meta.filesIndexed,
        reparsed: result.reparsed,
        reused: result.reused,
        removedFiles: result.removedFiles,
        parseFailures: result.meta.parseFailures,
        grammarVersions: result.meta.grammarVersions,
        missingGrammars: result.meta.missingGrammars,
        integrityFailures: result.meta.integrityFailures,
        // Cap hits are part of the contract: a consumer must be able to tell a
        // complete table from one the build truncated.
        truncated: {
          files: result.meta.truncated,
          symbols: result.meta.symbolsTruncated,
          symbolDetail: result.meta.symbolDetailTruncated,
          moduleEdges: result.meta.moduleEdgesTruncated,
          callEdges: result.meta.callEdgesTruncated,
          unresolved: result.meta.unresolvedTruncated,
        },
        sinceIgnored: result.sinceIgnored,
        priorUnreadable: result.priorUnreadable,
        delta: result.delta,
      });
    } else {
      const truncatedTables = [
        result.meta.symbolsTruncated ? 'symbols' : null,
        result.meta.symbolDetailTruncated ? 'per-symbol lists' : null,
        result.meta.moduleEdgesTruncated ? 'module edges' : null,
        result.meta.callEdgesTruncated ? 'call edges' : null,
        result.meta.unresolvedTruncated ? 'unresolved' : null,
      ].filter(Boolean);
      // The delta is ALWAYS measured against the prior index, not only under
      // --since; say so whenever there was one.
      const deltaNote =
        `symbols +${result.delta.added.count} −${result.delta.removed.count} ~${result.delta.changed.count}` +
        (result.basedOn ? ' vs prior index' : ' (no prior index)') +
        (truncatedTables.length ? ` · TRUNCATED at build caps (${truncatedTables.join(', ')})` : '') +
        (result.sinceIgnored ? ` · ${result.sinceIgnored} — full pass` : '') +
        (result.priorUnreadable?.length ? ` · prior index unreadable (${result.priorUnreadable.length})` : '');
      console.log(
        ui.line({
          state: persistFailed ? 'error' : integrity ? 'warn' : 'ok',
          key: 'structural',
          value: `${result.meta.filesIndexed} files · ${result.reparsed} parsed · ${result.reused} reused · tier ${result.meta.extractorTier}`,
          note: persistFailed
            ? 'index could not be persisted — structural data is NOT current'
            : integrity
              ? `grammar integrity mismatch (${result.meta.integrityFailures.length}) — loud lexical fallback; run harness doctor`
              : deltaNote,
        })
      );
      // Agent lane (§9): the budgeted inert digest, never raw index JSON.
      if (result.written) {
        const index = readStructuralIndex(workspace);
        if (index) {
          for (const line of renderStructuralDigest(index).body.split('\n')) {
            console.log(ui.paint('muted', `  ${line}`));
          }
        }
      }
    }
    return persistFailed ? 1 : 0;
  }

  // Stamp the current git HEAD so `index --status` can measure drift later.
  const head = spawnSyncHead(workspace);
  const result = runIndexKnowledge({
    knowledgeRoot: fs.existsSync(knowledgeRoot) ? knowledgeRoot : null,
    workspace,
    copilotHome,
    flags: { ...flags, headSha: head },
    log: logger,
  });
  // Refresh the committed codebase map alongside the knowledge index.
  try {
    const { writeCodebaseMap } = await import('./repo-map/index.mjs');
    const map = writeCodebaseMap({ workspace, dryRun: flags.dryRun });
    if (map) {
      result.codebaseMap = map;
      logger(`wrote ${map.path} (~${map.tokens} tokens)`);
    }
  } catch {
    // Advisory: never fail index on map generation.
  }
  // Recompute stale-anchor exclusions: anchors are file paths cited by a
  // learning's evidence at write time; if one no longer exists on disk, the
  // learning is excluded from retrieval until the anchor resolves again.
  // Mechanical CLI state, not mode-gated — never on --status (returned
  // above), never on dry-run, and never allowed to fail `index` itself.
  // Store-read-only when no store exists yet: a non-creating storeDir lookup
  // gates the pass so a plain `harness index` never materializes a knowledge
  // store (and its git repo) under HARNESS_HOME for a workspace that has
  // never run consolidate/remember.
  if (!flags.dryRun) {
    try {
      const { storeDir, listLearnings, writeStaleExclusions } = await import('./knowledge/store.mjs');
      const { assertNoSymlinkAncestors } = await import('./fs-safe.mjs');
      const dir = storeDir(workspace);
      if (fs.existsSync(dir)) {
        const excluded = {};
        for (const l of listLearnings(dir)) {
          const anchors = l.fm.anchors || [];
          if (!anchors.length) continue;
          // An anchor is only ever a workspace-relative pointer written by
          // extractAnchors (apply.mjs) — but learning files can be
          // hand-edited, so an anchor carrying `..` (or an absolute path, or
          // a symlinked ancestor) must be rejected BEFORE existsSync: an
          // escaping anchor is unresolvable, treated as missing (stale),
          // and the scan never stats anything outside the workspace.
          const missing = anchors.filter((a) => {
            const full = assertNoSymlinkAncestors(workspace, a);
            return !full || !fs.existsSync(full);
          });
          if (missing.length) excluded[l.id] = missing;
        }
        writeStaleExclusions(dir, { excluded });
        result.staleLearnings = Object.keys(excluded).length;
      }
    } catch {
      // Advisory: never fail index because the knowledge store is unreadable.
    }
  }
  writeEvent(workspace, flags, {
    type: 'index',
    command: 'index',
    result: 'pass',
    exitCode: 0,
  });
  if (flags.json) {
    emitJson(flags, result);
  } else {
    const empty = result.entries === 0;
    const noteParts = [];
    if (empty) noteParts.push('no solution docs under knowledge/solutions or docs/solutions yet');
    if (result.staleLearnings) noteParts.push(`learnings excluded ${result.staleLearnings} (stale anchors)`);
    console.log(
      ui.line({
        state: 'ok',
        key: 'index',
        value: `${result.entries} entries · ${result.indexEntries ?? result.entries} postings`,
        note: noteParts.length ? noteParts.join(' · ') : undefined,
        next: empty ? 'harness compound records the first learning' : undefined,
      })
    );
  }
  return 0;
}

// P1.6 (carry-list a): the shared prefix cmdOrient and lib/registry.mjs's
// orientResultOf both need — parse flags, resolve workspace/copilotHome/
// query, run orient — extracted once so resultOf calls this instead of
// duplicating it (task-2's original, acknowledged, file-ownership-forced
// duplication). Returns everything either caller needs: cmdOrient uses
// `flags`/`workspace`/`query` for its own writeEvent/render tail;
// orientResultOf only needs `result`.
export async function computeOrientResult(argv) {
  const { runOrient } = await import('./orient.mjs');
  const flags = parseFlags(argv);
  const workspace = path.resolve(flags.workspace);
  const copilotHome = resolveCopilotHome(flags.copilotHome);
  const query = parseQueryFromArgv(argv, flags);
  const result = runOrient({ workspace, copilotHome, flags, query });
  return { flags, workspace, copilotHome, query, result };
}

export async function cmdOrient(argv) {
  const { flags, workspace, query, result } = await computeOrientResult(argv);
  const orientPack = (() => {
    try {
      return fs.readFileSync(path.join(workspace, result.contextPack), 'utf8');
    } catch {
      return '';
    }
  })();
  writeEvent(workspace, flags, {
    type: 'orient',
    command: 'orient',
    plan: result.activePlan?.path || null,
    result: result.gateStatus === 'pass' ? 'pass' : 'fail',
    exitCode: 0,
    blockedReason: result.blockedReason,
    usage: usageFields({ input: query, output: orientPack }),
    // Only the ids that actually SURVIVED into the 2KB pack (some/all bullets
    // can be truncated away) — never the full ranked set — so SLO utilization
    // credits only delivered learnings.
    learnings: result.deliveredLearnings || (result.learnings || []).map((l) => l.id),
    learningsBytes: result.learningsBytes,
    // Layer attribution (blueprint P6/report split): recorded only when a
    // branch-bucket learning actually surfaced, so pre-bucket event shapes
    // are unchanged. Per-OCCURRENCE entries, not an id-keyed map: the
    // protected-shadow overlay can deliver golden and branch entries with
    // the SAME id, and a map would silently drop one side's attribution.
    ...((result.learnings || []).some((l) => l.layer)
      ? { learningLayers: (result.learnings || []).map((l) => ({ id: l.id, layer: l.layer === 'branch' ? 'branch' : 'golden' })) }
      : {}),
  });

  if (flags.json) {
    emitJson(flags, result);
  } else {
    console.log(
      ui.line({
        state: result.gateStatus === 'pass' ? 'ok' : 'warn',
        key: 'orient',
        value: result.contextPack,
        note: `recall ${result.recall.length} · learnings ${result.learnings?.length ?? 0} · plans ${result.plans.length} · gate ${result.gateStatus}`,
      })
    );
    if (result.explain) {
      const qt = result.explain.queryTokens.length;
      for (const c of result.explain.candidates) {
        const decomposition = c.excluded
          ? `excluded: ${c.excluded}`
          : `hits ${c.hits}/${qt} × damping ${c.damping} = ${c.score}`;
        console.log(ui.paint('muted', `  ${c.id} ${decomposition}`));
      }
    }
    if (result.blockedReason) {
      console.log(ui.line({ state: 'error', key: 'blocked', value: result.blockedReason }));
    }
    printNext(result.nextTools?.[0]);
  }
  return 0;
}

export async function cmdGate(argv) {
  const { runGate } = await import('./gate.mjs');
  const flags = parseFlags(argv);
  const workspace = path.resolve(flags.workspace);
  const query = parseQueryFromArgv(argv, flags);
  const result = runGate({ workspace, flags, query });
  const policy = loadPolicy(workspace, flags.enforcement);
  const policyExitCode = policy.enforcement === 'enforce' ? result.exitCode : 0;
  result.enforcement = policy.enforcement;
  result.policyExitCode = policyExitCode;
  const previous = readSession(workspace) || {};
  writeSession(
    workspace,
    {
      ...previous,
      activePlan: result.plan?.path || previous.activePlan || null,
      gatedPlan: result.plan?.path || null,
      gatedPlanDigest: result.pass && result.exitCode === 0 ? result.plan?.digest || null : null,
      lastGateAt: new Date().toISOString(),
      gateStatus: result.pass && result.exitCode === 0 ? 'pass' : policy.enforcement === 'enforce' && !result.pass ? 'blocked' : 'warn',
      blockedReason: result.blockedReason,
    },
    flags.dryRun
  );
  writeEvent(workspace, flags, {
    type: 'gate',
    command: 'gate',
    plan: result.plan?.path || null,
    phase: result.phase,
    exitCode: policyExitCode,
    checks: result.checks,
    blockedReason: result.blockedReason,
    usage: usageFields({ input: query, output: result.checks.map((c) => c.message).join('\n') }),
  });

  if (flags.json) {
    emitJson(flags, result);
  } else {
    const failed = result.checks.filter((c) => !c.pass).length;
    console.log(
      ui.line({
        state: result.pass ? 'ok' : 'error',
        key: 'gate',
        value: result.pass
          ? `pass · ${result.checks.length} checks`
          : `blocked · ${failed} of ${result.checks.length} checks`,
        note: result.pass ? result.phase : 'stop before editFiles',
      })
    );
    printChecks(flags, result.checks);
    printNext(result.nextTools?.[0]);
  }
  return policyExitCode;
}

// P1.6: verify is the one command wired onto lib/runner.mjs for its named
// check execution (AC8) — `ctx.signal` (bin/harness.mjs's SIGINT->AbortSignal
// bridge, wired only for this command) lets a check-in-flight actually be
// cancelled, and `ctx.output === 'jsonl'` opts into row-per-event streaming
// via lib/envelope.mjs's createJsonlStream. Every other lane (the default
// ledger render, and legacy --json) is byte-identical to before except that
// `runVerify` itself is now async — see lib/verify.mjs's own doc comment for
// the runner-wiring detail and the cancellation-skips-evidence contract.
export async function cmdVerify(argv, ctx = {}) {
  const { runVerify, exitCodeForOutcome, statusForVerifyResult, unifiedStatusForCheck, isGatingCheck } =
    await import('./verify.mjs');
  const flags = parseFlags(argv);
  const workspace = path.resolve(flags.workspace);
  const signal = ctx.signal;
  const streaming = ctx.output === 'jsonl';

  let jsonl = null;
  let onEvent;
  if (streaming) {
    const { createJsonlStream } = await import('./envelope.mjs');
    jsonl = createJsonlStream(process.stdout);
    jsonl.start({ command: 'verify', plan: flags.plan || null });
    onEvent = (event, fields = {}) => {
      if (event === 'progress') jsonl.progress(fields);
      else if (event === 'row') jsonl.row(fields);
      else jsonl.write(event, fields);
    };
  }

  // A JSONL stream that has emitted `start` MUST also emit a terminal
  // `result` row (lib/envelope.mjs's documented contract) — otherwise a
  // throwing runVerify leaves the error envelope on stderr and a stdout
  // consumer blocked on a stream that never terminates. The row carries the
  // failure, then the error rethrows untouched so bin/harness.mjs's own
  // rendering, exit code, and telemetry are unchanged.
  let result;
  try {
    result = await runVerify({ workspace, flags, signal, onEvent });
  } catch (error) {
    if (streaming) {
      jsonl.result({ status: 'failed', outcome: 'inconclusive', message: error?.message || String(error) });
      await jsonl.drained();
    }
    throw error;
  }
  const cancelled = result.outcome === 'cancelled';
  // Fix-wave Important #5: explicit run-outcome precedence for the exit
  // code — cancelled (130) > timed-out (8) > the enforcement mapping.
  // Pre-fix, a run whose checks timed out fell through to
  // `outcome: inconclusive` -> exit 2, while the SAME run's jsonl terminal
  // row said `status: timed-out` — EXIT.timedOut and its command.result
  // telemetry were unreachable. `timed-out` maps BEFORE the enforcement
  // mapping on purpose: enforcement modes (observe/warn) downgrade policy
  // VERDICTS, but a timeout means verification never completed — there is
  // no verdict to downgrade, and masking it as exit 0/2 loses the one
  // signal that distinguishes "ran out of time" from "checked and found
  // inconclusive". The unified status comes from statusForVerifyResult
  // (lib/verify.mjs) so the exit code, the jsonl terminal row, and
  // command.result telemetry can never disagree.
  const runStatus = statusForVerifyResult(result);
  const exitCode = cancelled
    ? EXIT.cancelled
    : runStatus === 'timed-out'
      ? EXIT.timedOut
      : exitCodeForOutcome(result.outcome, result.enforcement);

  const previous = readSession(workspace) || {};
  writeSession(
    workspace,
    {
      ...previous,
      activePlan: result.plan || previous.activePlan || null,
      lastVerifyAt: new Date().toISOString(),
      lastVerifyOutcome: result.outcome,
      lastEvidencePath: result.evidencePath,
    },
    flags.dryRun
  );
  writeEvent(workspace, flags, {
    type: 'verify',
    command: 'verify',
    plan: result.plan,
    exitCode,
    result: cancelled ? 'warn' : result.outcome === 'passed' ? 'pass' : result.outcome === 'failed' ? 'fail' : 'warn',
    checks: result.checks,
    blockedReason: cancelled ? 'verification cancelled (SIGINT)' : result.outcome === 'passed' ? null : `${result.outcome} verification`,
    usage: usageFields({ input: result.plan || '', output: result.checks.map((c) => c.message).join('\n') }),
    learnings: flags.learnings ? flags.learnings.split(',').map((s) => s.trim()).filter(Boolean) : undefined,
  });

  if (streaming) {
    jsonl.result({
      status: runStatus,
      outcome: result.outcome,
      exitCode,
      evidencePath: result.evidencePath,
      checks: result.checks.map((c) => ({ id: c.id, status: c.status, unifiedStatus: unifiedStatusForCheck(c) })),
    });
    // Fix-wave P2 (JSONL backpressure): await the stream draining the terminal
    // result row before returning — the CLI's hard process.exit must not race
    // ahead of a row buffered under backpressure (bin/harness.mjs also flushes
    // stdout before exit as a second guarantee).
    await jsonl.drained();
    return exitCode;
  }

  if (flags.json) emitJson(flags, result);
  else {
    // `skipped` is neutral (e.g. the advisory structural check without an
    // index): never a failure count, never the next fix target. An `advisory`
    // check is neutral for the same reason — it cannot move the outcome
    // (resolveOutcome excludes it), so counting it here or pointing the agent
    // at it would route attention to the one check that can never unblock the
    // run. Both stay visible as rows and in `advisoryFailures`. The predicate
    // itself lives in verify.mjs (`isGatingCheck`) so this surface and the test
    // that pins it can never drift apart.
    const gating = isGatingCheck;
    const failed = result.checks.filter(gating).length;
    const passed = result.outcome === 'passed';
    console.log(
      ui.line({
        state: cancelled ? 'warn' : passed ? 'ok' : exitCode === 0 ? 'warn' : 'error',
        key: 'verify',
        value: cancelled
          ? 'cancelled · verification interrupted'
          : passed
            ? `passed · ${result.checks.length} checks`
            : `${result.outcome} · ${failed} of ${result.checks.length} checks`,
        note: result.evidencePath,
      })
    );
    // A policy that tried to mark a plan-required check advisory disagrees
    // with the plan it is verifying; the run ignores it, and says so.
    for (const refused of result.refusedSeverityDowngrades || []) {
      console.log(
        ui.line({
          state: 'warn',
          key: 'policy',
          value: `checks.${refused.id}.severity: advisory ignored`,
          note: `the active plan requires ${refused.id}; running as ${refused.effective}`,
        })
      );
    }
    printChecks(flags, result.checks, (c) => c.status === 'passed' || c.status === 'skipped');
    if (passed) {
      printNext('harness compound (or /auto-compound), then stop');
    } else if (!cancelled) {
      // Main's `isGatingCheck` predicate (skipped/advisory are neutral) AND
      // P1.6's cancelled guard: an interrupted run has no "first failure" to
      // point at — the run never finished deciding.
      const firstFail = result.checks.find(gating);

      if (firstFail) {
        const detail = String(firstFail.message ?? firstFail.name ?? '').slice(0, 100);
        printNext(`fix ${firstFail.id} (${detail})`);
      }
    }
  }
  return exitCode;
}

export async function cmdRecall(argv) {
  const { runRecall } = await import('./recall-cmd.mjs');
  const flags = parseFlags(argv);
  if (hasFlag(argv, '--include-plans')) flags.includePlans = true;
  const workspace = path.resolve(flags.workspace);
  const copilotHome = resolveCopilotHome(flags.copilotHome);
  const result = runRecall({ workspace, copilotHome, flags, argv });
  writeEvent(workspace, flags, {
    type: 'recall',
    command: 'recall',
    result: 'pass',
    exitCode: 0,
  });

  if (flags.json) {
    emitJson(flags, result);
  } else {
    console.log(
      ui.line({
        state: result.recall.length ? 'ok' : 'warn',
        key: 'recall',
        value: `"${result.query}"`,
        note: `${result.recall.length} hit${result.recall.length === 1 ? '' : 's'}`,
      })
    );
    for (const r of result.recall) {
      const label = r.kind === 'insight' ? ' [insight]' : '';
      console.log(ui.line({ key: String(r.score), value: r.path, note: `${r.title}${label}`, keyWidth: 6 }));
    }
    for (const p of result.plans ?? []) {
      console.log(ui.line({ key: 'plan', value: p.path, note: p.status, keyWidth: 6 }));
    }
  }
  return 0;
}

export async function cmdEvents(argv) {
  const flags = parseFlags(argv);
  const workspace = path.resolve(flags.workspace);
  const events = readEvents(workspace, {
    limit: Number.isFinite(flags.limit) ? flags.limit : 20,
    session: flags.session,
    failures: flags.failures,
  });
  const summary = summarizeEvents(events);
  const totalMatched = events.totalMatched ?? events.length;

  if (flags.json) {
    const body = { count: events.length, totalMatched, summary };
    if (!flags.summary) body.events = [...events];
    emitJson(flags, body);
  } else {
    const keyWidth = keyWidthFor(['events', 'tokens', 'last plan']);
    console.log(
      ui.line({
        key: 'events',
        value: `${events.length}${totalMatched > events.length ? ` of ${totalMatched}` : ''}`,
        note: `${summary.pass} pass · ${summary.warn} warn · ${summary.fail} fail`,
        keyWidth,
      })
    );
    if (totalMatched > events.length) {
      console.log(
        ui.paint('muted', `  showing latest ${events.length} · narrow with --session/--failures or raise --limit`)
      );
    }
    const u = summary.usage;
    if (u && u.totalTokens) {
      console.log(
        ui.line({
          key: 'tokens',
          value: `in=${u.inputTokens} out=${u.outputTokens} total=${u.totalTokens}`,
          note: 'est',
          keyWidth,
        })
      );
      if (flags.summary) {
        const typeWidth = keyWidthFor(Object.keys(u.byType));
        for (const [type, bucket] of Object.entries(u.byType).sort((a, b) => b[1].totalTokens - a[1].totalTokens)) {
          console.log(ui.paint('muted', `  ${type.padEnd(typeWidth)}  ${bucket.totalTokens}`));
        }
      }
    }
    if (summary.lastActivePlan) {
      console.log(ui.line({ key: 'last plan', value: summary.lastActivePlan, keyWidth }));
    }
    if (summary.latestBlockedReason) {
      console.log(ui.line({ state: 'warn', key: 'blocked', value: summary.latestBlockedReason, keyWidth }));
    }
  }
  return 0;
}

export async function cmdReport(argv) {
  const { buildReport, renderReport, hasBudgetBreach } = await import('./report.mjs');
  const flags = parseFlags(argv);
  const workspace = path.resolve(flags.workspace);
  const copilotHome = resolveCopilotHome(flags.copilotHome);

  const { loadReportEvents } = await import('./report.mjs');
  const { collectHostUsage, mergeHostUsage } = await import('./host-telemetry/index.mjs');

  let base = null;
  if (flags.sync || flags.global) {
    const store = await import('./telemetry-store.mjs');
    if (flags.sync) {
      const synced = store.syncWorkspaceEvents({ workspace });
      if (!flags.json) {
        console.log(ui.line({ state: 'ok', key: 'sync', value: `${synced.added} new event(s)`, note: synced.file }));
      }
    }
    if (flags.global) base = store.readGlobalEvents();
  }
  if (base === null) base = loadReportEvents({ workspace });

  // Overlay real host usage (if any adapter has it) on top of harness estimates.
  const merged = mergeHostUsage(base, collectHostUsage({ workspace, host: flags.host, copilotHome }));
  const report = buildReport({ workspace, copilotHome, events: merged });

  if (flags.check) {
    if (hasBudgetBreach(report)) {
      if (flags.json) emitJson(flags, { pass: false, breaches: report.flags.budgetBreaches });
      else {
        const breaches = report.flags.budgetBreaches;
        console.log(
          ui.line({ state: 'error', key: 'report', value: `budget breach · ${breaches.length}` })
        );
        for (const b of breaches) {
          console.log(ui.line({ key: b.kind, value: `${b.target} = ${b.value}`, note: `cap ${b.cap}` }));
        }
      }
      return 1;
    }
    if (flags.json) emitJson(flags, { pass: true, breaches: [] });
    else console.log(ui.line({ state: 'ok', key: 'report', value: 'no budget breaches' }));
    return 0;
  }

  if (flags.json) emitJson(flags, report);
  else console.log(renderReport(report));
  return 0;
}

export async function cmdValidatePlan(argv) {
  const { runValidatePlan } = await import('./validate-plan.mjs');
  const flags = parseFlags(argv);
  const workspace = path.resolve(flags.workspace);
  const result = runValidatePlan({ workspace, flags, planPath: flags.plan });
  const policy = loadPolicy(workspace, flags.enforcement);
  const policyExitCode = policy.enforcement === 'enforce' ? result.exitCode : 0;
  result.enforcement = policy.enforcement;
  result.policyExitCode = policyExitCode;
  writeEvent(workspace, flags, {
    type: 'validate_plan',
    command: 'validate-plan',
    plan: result.plan?.path || null,
    exitCode: policyExitCode,
    checks: result.checks,
    blockedReason: result.blockedReason,
  });

  if (flags.json) {
    emitJson(flags, result);
  } else {
    const failed = result.checks.filter((c) => !c.pass && c.severity !== 'warn').length;
    console.log(
      ui.line({
        state: result.pass ? 'ok' : 'error',
        key: 'validate-plan',
        value: result.pass
          ? `pass · ${result.checks.length} checks`
          : `fail · ${failed} of ${result.checks.length} checks`,
        keyWidth: 13,
      })
    );
    printChecks(flags, result.checks);
  }
  return policyExitCode;
}

export async function cmdCompound(argv) {
  const { runCompound } = await import('./compound.mjs');
  const flags = parseFlags(argv);
  const workspace = path.resolve(flags.workspace);
  const copilotHome = resolveCopilotHome(flags.copilotHome);
  const logger = (m) => log(flags, m);
  const result = runCompound({ workspace, copilotHome, flags, log: logger });
  writeEvent(workspace, flags, {
    type: 'compound',
    command: 'compound',
    exitCode: result.exitCode,
    result: result.pass ? (result.exitCode === 2 ? 'warn' : 'pass') : 'fail',
    blockedReason: result.blockedReason,
  });

  if (flags.json) {
    emitJson(flags, result);
  } else {
    if (result.pass && result.kind === 'insight') {
      console.log(
        ui.line({
          state: 'ok',
          key: 'insight',
          value: result.path,
          note: `indexed ${result.indexed?.entries ?? 0} entries`,
        })
      );
      printNext(result.nextTools?.[0]);
    } else if (result.pass) {
      console.log(
        ui.line({
          state: result.exitCode === 2 ? 'warn' : 'ok',
          key: 'compound',
          value: `indexed ${result.indexed?.entries ?? 0} entries`,
          note: result.exitCode === 2 ? 'verify gate warned — review Activity' : undefined,
        })
      );
    } else {
      console.log(ui.line({ state: 'error', key: 'compound', value: `blocked · ${result.blockedReason}` }));
    }
  }
  return result.exitCode;
}

export async function cmdConsolidate(argv) {
  const flags = parseFlags(argv);
  const workspace = path.resolve(flags.workspace);
  const copilotHome = resolveCopilotHome(flags.copilotHome);
  const logger = (m) => log(flags, m);

  if (hasFlag(argv, '--apply')) {
    const { applyOps } = await import('./knowledge/apply.mjs');
    if (!flags.ops) {
      throw Object.assign(new Error('--apply requires --ops <path> (the skill-emitted operations JSON)'), {
        code: 'E_USAGE',
        hint: 'harness consolidate --apply --ops ops.json',
        exit: EXIT.usage,
      });
    }
    const result = applyOps({
      workspace,
      opsPath: path.resolve(flags.ops),
      dryRun: flags.dryRun,
      approve: flags.yes,
      log: logger,
      copilotHome,
      layer: flags.layer,
    });
    writeEvent(workspace, flags, {
      type: 'consolidate',
      command: 'consolidate',
      decision: 'apply',
      result: result.exitCode === 0 ? 'pass' : 'fail',
      exitCode: result.exitCode,
      blockedReason: result.rejected?.[0]?.reason || null,
    });
    if (flags.json) {
      emitJson(flags, result);
    } else if (result.exitCode === 0) {
      const noteParts = [];
      if (result.committed) noteParts.push('committed to knowledge store');
      if (result.governed?.length) noteParts.push(`${result.governed.length} re-governed`);
      if (result.staleLockRemoved) noteParts.push(result.staleLockRemoved);
      console.log(
        ui.line({
          state: 'ok',
          key: 'apply',
          value: result.applied.map((a) => `${a.op.toLowerCase()} ${a.id || ''}`.trim()).join(' · ') || 'no ops',
          note: noteParts.length ? noteParts.join(' · ') : undefined,
        })
      );
    } else {
      console.log(
        ui.line({
          state: 'error',
          key: 'apply',
          value: `rejected · ${result.rejected?.[0]?.reason || 'invalid ops'}`,
        })
      );
    }
    return result.exitCode;
  }

  if (hasFlag(argv, '--candidates')) {
    const { consolidateCandidates } = await import('./knowledge/consolidate.mjs');
    const packet = consolidateCandidates({ workspace, copilotHome });
    writeEvent(workspace, flags, { type: 'consolidate', command: 'consolidate', result: 'pass', exitCode: 0 });
    if (flags.json) {
      emitJson(flags, packet);
    } else {
      console.log(
        ui.line({
          state: 'ok',
          key: 'candidates',
          value: `${packet.clusters.length} clusters · ${packet.learnings.length} active learnings`,
          note: 'JSON packet is the contract — use --json for the skill',
        })
      );
      printNext('emit ops JSON, then harness consolidate --apply --ops <path>');
    }
    return 0;
  }

  if (hasFlag(argv, '--rebuild')) {
    const { rebuildStore } = await import('./knowledge/admin.mjs');
    const { CONSOLIDATION_THRESHOLD } = await import('./knowledge/consolidate.mjs');
    const result = rebuildStore({ workspace, yes: flags.yes, copilotHome, log: logger });
    writeEvent(workspace, flags, {
      type: 'consolidate',
      command: 'consolidate',
      decision: 'rebuild',
      result: result.pass ? 'pass' : 'fail',
      exitCode: result.exitCode,
    });
    if (flags.json) {
      emitJson(flags, result);
    } else if (!result.pass) {
      for (const l of ui.errorBlock({ code: 'E_USAGE', message: result.blockedReason, exit: result.exitCode })) {
        console.error(l);
      }
    } else {
      console.log(
        ui.line({
          state: 'warn',
          key: 'rebuild',
          value: `archived ${result.archived} · debt ${result.debt}/${CONSOLIDATION_THRESHOLD}`,
        })
      );
      printNext(result.nextTools?.[0]);
    }
    return result.exitCode;
  }

  // Default: --status (deterministic debt gauge, zero model cost).
  const { consolidateStatus } = await import('./knowledge/consolidate.mjs');
  const status = consolidateStatus({ workspace, copilotHome });
  writeEvent(workspace, flags, { type: 'consolidate', command: 'consolidate', result: 'pass', exitCode: 0 });
  if (flags.json) {
    emitJson(flags, status);
  } else {
    const atCapDomains = (status.domains || []).filter((d) => d.atCap).map((d) => d.domain);
    console.log(
      ui.line({
        state: status.due ? 'warn' : 'ok',
        key: 'consolidate',
        value: `debt ${status.debt}/${status.threshold}`,
        note: `${status.learnings.active} active learnings${status.promotionCandidates.length ? ` · ${status.promotionCandidates.length} promotion candidate${status.promotionCandidates.length === 1 ? '' : 's'}` : ''}${status.quarantined.length ? ` · ${status.quarantined.length} quarantined` : ''}${atCapDomains.length ? ` · ${atCapDomains.join(', ')} at cap` : ''}`,
      })
    );
    printNext(status.nextTools?.[0]);
  }
  return 0;
}

export async function cmdRemember(argv) {
  const { runRemember } = await import('./knowledge/remember.mjs');
  const flags = parseFlags(argv);
  const workspace = path.resolve(flags.workspace);
  const copilotHome = resolveCopilotHome(flags.copilotHome);
  const logger = (m) => log(flags, m);
  const result = runRemember({ workspace, copilotHome, flags, argv, log: logger });
  writeEvent(workspace, flags, {
    type: 'remember',
    command: 'remember',
    result: result.pass ? 'pass' : 'fail',
    exitCode: result.exitCode,
    blockedReason: result.blockedReason,
  });

  if (flags.json) {
    emitJson(flags, result);
  } else if (result.pass) {
    console.log(
      ui.line({
        state: 'ok',
        key: 'remember',
        value: result.learningId,
        note: result.dryRun
          ? `dry-run — nothing written (would-be episode ${result.episodePath})`
          : `source: human · episode ${result.episodePath}`,
      })
    );
    printNext(result.nextTools?.[0]);
  } else if (result.exitCode === EXIT.usage) {
    for (const l of ui.errorBlock({
      code: 'E_USAGE',
      message: result.blockedReason,
      fix: result.nextTools?.[0],
      exit: EXIT.usage,
    })) {
      console.error(l);
    }
  } else {
    console.log(ui.line({ state: 'error', key: 'remember', value: `blocked · ${result.blockedReason}` }));
    printNext(result.nextTools?.[0]);
  }
  return result.exitCode;
}

export async function cmdLearning(argv) {
  const { setLearningStatus } = await import('./knowledge/lifecycle.mjs');
  const flags = parseFlags(argv);
  const workspace = path.resolve(flags.workspace);
  const action = argv[0] && !argv[0].startsWith('--') ? argv[0] : null;
  const id = argv[1] && !argv[1].startsWith('--') ? argv[1] : null;
  const logger = (m) => log(flags, m);
  const result = setLearningStatus({ workspace, id, action, reason: flags.reason, to: flags.to, log: logger });
  writeEvent(workspace, flags, {
    type: 'learning',
    command: 'learning',
    decision: action,
    result: result.pass ? 'pass' : 'fail',
    exitCode: result.exitCode,
    blockedReason: result.blockedReason,
  });

  if (flags.json) {
    emitJson(flags, result);
  } else if (result.pass) {
    const value = action === 'promote' ? `${id} → promoted (${flags.to})` : `${id} → ${result.status}`;
    console.log(ui.line({ state: action === 'retire' ? 'warn' : 'ok', key: 'learning', value }));
  } else if (result.exitCode === EXIT.usage) {
    for (const l of ui.errorBlock({
      code: 'E_USAGE',
      message: result.blockedReason,
      fix: 'harness learning <retire|dispute|confirm|promote> <id> [--reason "<r>"] [--to <path>]',
      exit: EXIT.usage,
    })) {
      console.error(l);
    }
  } else {
    for (const l of ui.errorBlock({
      code: 'E_TARGET',
      message: result.blockedReason,
      exit: result.exitCode,
    })) {
      console.error(l);
    }
  }
  return result.exitCode;
}

// Read-only: paged listing of learnings with provenance and failure
// annotations, plus single-learning provenance via --why. Matches the
// recall/report convention — no writeEvent call.
export async function cmdLearnings(argv) {
  const { listingView, whyView } = await import('./knowledge/listing.mjs');
  const flags = parseFlags(argv);
  const workspace = path.resolve(flags.workspace);
  const copilotHome = resolveCopilotHome(flags.copilotHome);

  // A trailing bare --why (no id following it) must never silently fall
  // through to the full listing below — parseFlags leaves flags.why unset
  // when there's no next token to consume.
  if (hasFlag(argv, '--why') && !flags.why) {
    const blockedReason = 'usage: harness learnings --why <id>';
    if (flags.json) {
      emitJson(flags, { pass: false, blockedReason });
    } else {
      for (const l of ui.errorBlock({ code: 'E_USAGE', message: blockedReason, exit: EXIT.usage })) {
        console.error(l);
      }
    }
    return EXIT.usage;
  }

  if (flags.why) {
    const result = whyView({ workspace, id: flags.why });
    if (!result) {
      const blockedReason = `E_TARGET: no learning ${flags.why}`;
      if (flags.json) {
        emitJson(flags, { pass: false, id: flags.why, blockedReason });
      } else {
        for (const l of ui.errorBlock({ code: 'E_TARGET', message: `no learning ${flags.why}`, exit: 1 })) {
          console.error(l);
        }
      }
      return 1;
    }

    if (flags.json) {
      emitJson(flags, result);
      return 0;
    }

    console.log(ui.paint('muted', LEARNINGS_FENCE));
    const keyWidth = keyWidthFor(['id', 'trigger', 'claim', 'status']);
    console.log(ui.line({ key: 'id', value: result.id, keyWidth }));
    console.log(ui.line({ key: 'trigger', value: result.trigger, keyWidth }));
    console.log(ui.line({ key: 'claim', value: result.claimLine, keyWidth }));
    for (const ep of result.episodes) {
      console.log(ui.paint('muted', `    · ${ep.kind} · ${ep.path}${ep.plan ? ` · ${ep.plan}` : ''}`));
    }
    console.log(
      ui.line({
        key: 'status',
        // Same note idiom as the listing view — carries failures/promotionEligible too.
        value: learningNote(result),
        keyWidth,
      })
    );
    return 0;
  }

  const domain = argv[0] && !argv[0].startsWith('--') ? argv[0] : null;
  const result = listingView({ workspace, copilotHome, domain });

  if (flags.json) {
    emitJson(flags, result);
    return 0;
  }

  console.log(ui.paint('muted', LEARNINGS_FENCE));
  const rows = result.learnings.filter((l) => flags.verbose || !['retired', 'superseded'].includes(l.status));
  const keyWidth = keyWidthFor(rows.map((l) => l.id));
  for (const l of rows) {
    console.log(
      ui.line({ state: learningRowState(l.status), key: l.id, value: l.trigger, note: learningNote(l), keyWidth })
    );
  }
  if (result.quarantined.length > 0) {
    console.log(
      ui.paint(
        'muted',
        `${result.quarantined.length} quarantined episode(s) — inspect with harness consolidate --status, clear with knowledge purge <path>`
      )
    );
  }
  return 0;
}

// Deterministic retrieval PROXY, not the model-graded net-benefit number
// (design §12, deferred) — hit/false-surface/token cost per ranking arm on a
// temporally held-out split. Read-only: never creates the store (recall/report
// convention — no writeEvent call).
export async function cmdEvalKnowledge(argv) {
  const { evalKnowledge, DEFAULT_NEGATIVE_QUERIES } = await import('./knowledge/eval.mjs');
  const flags = parseFlags(argv);
  const workspace = path.resolve(flags.workspace);
  const copilotHome = resolveCopilotHome(flags.copilotHome);
  const result = evalKnowledge({ workspace, copilotHome, negativeQueries: DEFAULT_NEGATIVE_QUERIES });

  if (flags.json) {
    emitJson(flags, result);
    return result.exitCode;
  }

  if (!result.pass) {
    for (const l of ui.errorBlock({ code: 'E_TARGET', message: result.blockedReason, exit: result.exitCode })) {
      console.error(l);
    }
    return result.exitCode;
  }

  const armKeys = Object.keys(result.arms);
  const keyWidth = keyWidthFor(['eval-knowledge', ...armKeys, 'recommendation']);
  console.log(
    ui.line({
      state: 'ok',
      key: 'eval-knowledge',
      value: `${result.split.train} train · ${result.split.heldOut} held-out · cutoff ${result.split.cutoff}`,
      note: result.split.unscorable ? `${result.split.unscorable} held-out unscorable` : undefined,
      keyWidth,
    })
  );
  for (const arm of armKeys) {
    const stats = result.arms[arm];
    console.log(
      ui.line({
        key: arm,
        value: `hit ${Math.round(stats.hitRate * 100)}% · false ${Math.round(stats.falseSurfaceRate * 100)}% · ~${stats.injectedTokens} tok`,
        keyWidth,
      })
    );
  }
  console.log(ui.line({ key: 'recommendation', value: result.recommendation, keyWidth }));
  console.log(
    ui.paint(
      'muted',
      '  deterministic retrieval proxy — hit/false-surface/token cost per arm; model-graded net-benefit is deferred, not measured here'
    )
  );
  return 0;
}

// The kill switch and purge cascade. Mode-switching and --status read/write
// store.mjs's config.json directly; purge is never mode-gated — human
// deletion always wins — and delegates to knowledge/admin.mjs.
export async function cmdKnowledge(argv) {
  const flags = parseFlags(argv);
  const workspace = path.resolve(flags.workspace);
  const copilotHome = resolveCopilotHome(flags.copilotHome);
  const subcommand = argv[0] && !argv[0].startsWith('--') ? argv[0] : null;
  // Single definition (store.mjs) — commands.mjs no longer keeps its own copy.
  const { KNOWLEDGE_MODES, KNOWLEDGE_COMMIT_MODES, writeStoreConfig, readStoreConfig } = await import('./knowledge/store.mjs');

  if (subcommand === 'purge') {
    const { purgeEpisode, purgeAll } = await import('./knowledge/admin.mjs');
    const rawTarget = argv[1];
    const isAll = rawTarget === '--all';
    // A missing target must never fall through to the next global flag
    // (e.g. `harness knowledge purge --workspace <dir>`) — anything shaped
    // like an option is treated as absent, not as a filename.
    const target = !isAll && rawTarget && !rawTarget.startsWith('--') ? rawTarget : null;
    const logger = (m) => log(flags, m);
    // copilotHome threaded through (P2) so a global episode (resolved under
    // copilotHome/knowledge, the same root `collectEpisodes` scans) can be
    // purged exactly as readily as a product-repo-local one.
    const result = isAll ? purgeAll({ workspace, log: logger }) : purgeEpisode({ workspace, target, copilotHome, log: logger });
    writeEvent(workspace, flags, {
      type: 'knowledge',
      command: 'knowledge',
      decision: 'purge',
      result: result.pass ? 'pass' : 'fail',
      exitCode: result.exitCode,
      blockedReason: result.blockedReason,
    });
    if (flags.json) {
      emitJson(flags, result);
    } else if (!result.pass) {
      for (const l of ui.errorBlock({ code: 'E_USAGE', message: result.blockedReason, exit: result.exitCode })) {
        console.error(l);
      }
    } else if (isAll) {
      console.log(
        ui.line({
          state: 'warn',
          key: 'purge',
          value: `--all · ${result.removed.learnings} learning${result.removed.learnings === 1 ? '' : 's'} removed`,
          note: 'episodes remain on disk — they will re-appear as debt',
        })
      );
    } else {
      console.log(
        ui.line({
          state: 'warn',
          key: 'purge',
          value: target,
          note: `${result.removed.learnings.length} learning(s) deleted · ${result.removed.links.length} link(s) unlinked`,
        })
      );
    }
    return result.exitCode;
  }

  // Explicit, human-run migration for a stranded store (P2, design §2) —
  // never automatic; `harness doctor`'s K4 check only detects and prints
  // this exact command. Checked before the mode-set branch below for the
  // same reason `purge` is: 'migrate-store' is never a member of
  // KNOWLEDGE_MODES, so there's no ambiguity either way, but keeping every
  // non-mode subcommand branch together above the mode-set branch matches
  // the existing purge → commit → mode-set → bare status → E_USAGE order.
  if (subcommand === 'migrate-store') {
    const { migrateStrandedStore } = await import('./knowledge/admin.mjs');
    const logger = (m) => log(flags, m);
    const result = migrateStrandedStore({ workspace, log: logger });
    writeEvent(workspace, flags, {
      type: 'knowledge',
      command: 'knowledge',
      decision: 'migrate-store',
      result: result.pass ? 'pass' : 'fail',
      exitCode: result.exitCode,
      blockedReason: result.blockedReason,
    });
    if (flags.json) {
      emitJson(flags, result);
    } else if (!result.pass) {
      for (const l of ui.errorBlock({ code: 'E_USAGE', message: result.blockedReason, exit: result.exitCode })) {
        console.error(l);
      }
    } else {
      console.log(ui.line({ state: 'ok', key: 'migrate-store', value: `${result.from} -> ${result.to}` }));
    }
    return result.exitCode;
  }

  // Layer-aware read-only report (blueprint P6, Phase 1): golden per-domain
  // counts, branch-bucket rows when buckets exist, and the recall-index drift
  // line. 'status' is never a member of KNOWLEDGE_MODES, so there's no
  // ambiguity with the mode-set branch below.
  if (subcommand === 'status') {
    const { knowledgeStatus } = await import('./knowledge/status.mjs');
    const report = knowledgeStatus({ workspace, copilotHome });
    writeEvent(workspace, flags, {
      type: 'knowledge',
      command: 'knowledge',
      decision: 'status',
      result: 'pass',
      exitCode: 0,
    });
    if (flags.json) {
      emitJson(flags, report);
      return 0;
    }
    const { inertLine } = await import('./knowledge/store.mjs');
    const keyWidth = keyWidthFor(['knowledge', 'golden', 'drift', ...report.golden.domains.map((d) => d.domain), ...report.buckets.map((b) => b.key)]);
    const contextNote = report.context
      ? report.context.detached
        ? 'detached HEAD'
        : `branch ${inertLine(report.context.branch).slice(0, 80)}`
      : 'no git context';
    console.log(
      ui.line({
        state: report.storeExists ? 'ok' : 'pending',
        key: 'knowledge',
        value: report.storeExists ? `mode ${report.mode} · commit ${report.commit}` : 'no store yet',
        note: contextNote,
        keyWidth,
      })
    );
    console.log(
      ui.line({ key: 'golden', value: `${report.golden.active} active · ${report.golden.total} total`, keyWidth })
    );
    for (const d of report.golden.domains) {
      console.log(ui.line({ key: d.domain, value: `${d.active} active · ${d.total} total`, keyWidth }));
    }
    for (const b of report.buckets) {
      const noteParts = [];
      if (b.branch) noteParts.push(inertLine(b.branch).slice(0, 80));
      if (b.ageDays !== null) noteParts.push(`${b.ageDays}d old`);
      if (b.baseSha) noteParts.push(`base ${b.baseSha.slice(0, 12)}`);
      noteParts.push(b.promotable ? 'promotable' : 'never promotable');
      if (b.prunable) noteParts.push('prunable — harness knowledge prune');
      if (b.ancestryOk === false) noteParts.push('base not an ancestor of HEAD — excluded from overlay');
      console.log(
        ui.line({
          state: b.ancestryOk === false ? 'warn' : 'ok',
          key: b.key,
          value: `${b.active} active · ${b.total} total${b.promoted ? ` · ${b.promoted} promoted` : ''}`,
          note: noteParts.join(' · '),
          keyWidth,
        })
      );
    }
    if (report.drift) {
      console.log(
        ui.line({
          state: report.drift.indexed ? (report.drift.stale ? 'warn' : 'ok') : 'pending',
          key: 'drift',
          value: report.drift.indexed ? (report.drift.stale ? 'recall index stale' : 'recall index current') : 'no recall index',
          note: report.drift.recommendation,
          keyWidth,
        })
      );
    }
    return 0;
  }

  // Branch→golden promotion emitter (blueprint §5): writes ONLY the
  // reviewable op-set at .harness/promote-ops.json — the store mutates
  // exclusively through `consolidate --apply` running in promotion mode.
  if (subcommand === 'promote') {
    const { buildPromotionOps } = await import('./knowledge/promote.mjs');
    const logger = (m) => log(flags, m);
    const ids = flags.ids ? flags.ids.split(',').map((s) => s.trim()).filter(Boolean) : null;
    const result = buildPromotionOps({ workspace, branchKey: flags.branch, ids, all: flags.all, log: logger });
    writeEvent(workspace, flags, {
      type: 'knowledge',
      command: 'knowledge',
      decision: 'promote',
      result: result.pass ? 'pass' : 'fail',
      exitCode: result.exitCode,
      blockedReason: result.blockedReason,
    });
    if (flags.json) {
      emitJson(flags, result);
    } else if (!result.pass) {
      for (const l of ui.errorBlock({ code: 'E_USAGE', message: result.blockedReason, exit: result.exitCode })) {
        console.error(l);
      }
    } else {
      console.log(
        ui.line({
          state: 'ok',
          key: 'promote',
          value: `${result.ops} op(s) → ${result.opsPath}`,
          note: `${result.bucketKey}${result.remaining ? ` · remaining ${result.remaining}` : ''}${result.skipped.length ? ` · skipped ${result.skipped.length}` : ''}`,
        })
      );
      for (const s of result.skipped) console.log(ui.paint('muted', `  skip ${s.id} — ${s.reason}`));
      printNext(result.nextTools?.[0]);
    }
    return result.exitCode;
  }

  // Bucket deletion (blueprint P6/§5): human authority, never mode-gated —
  // exactly like purge. One store commit removes the selected buckets.
  if (subcommand === 'prune') {
    const { pruneBuckets } = await import('./knowledge/prune.mjs');
    const logger = (m) => log(flags, m);
    const result = pruneBuckets({
      workspace,
      branchKey: flags.branch,
      merged: flags.merged,
      staleDays: flags.stale,
      // Deleting a bucket that still holds ACTIVE, unpromoted learnings is a
      // destructive human decision — prune previews it and refuses without --yes.
      yes: flags.yes,
      log: logger,
    });
    writeEvent(workspace, flags, {
      type: 'knowledge',
      command: 'knowledge',
      decision: 'prune',
      result: result.pass ? 'pass' : 'fail',
      exitCode: result.exitCode,
      blockedReason: result.blockedReason,
    });
    if (flags.json) {
      emitJson(flags, result);
    } else {
      // The per-bucket preview prints on BOTH paths — it is what a human needs
      // in order to decide whether to re-run with --yes, and what a human
      // deserves to see after a prune that did land. `p.branch` is already
      // redacted/flattened/capped at the data boundary (safeBranchName).
      for (const p of result.preview || []) {
        console.log(
          ui.paint(
            'muted',
            `  ${p.key}${p.branch ? ` (${p.branch})` : ''} — ${p.active ?? '?'} active · ${p.promoted ?? '?'} promoted · ${p.total ?? '?'} total`
          )
        );
      }
      if (!result.pass) {
        for (const l of ui.errorBlock({ code: 'E_USAGE', message: result.blockedReason, exit: result.exitCode })) {
          console.error(l);
        }
      } else {
        console.log(
          ui.line({
            state: 'warn',
            key: 'prune',
            value: `${result.removed.length} bucket(s) removed`,
            note: result.removed.join(' · '),
          })
        );
      }
    }
    return result.exitCode;
  }

  // commit <none|repo> is checked BEFORE the mode-set branch below — 'commit'
  // itself is never a member of KNOWLEDGE_MODES, so there's no ambiguity, but
  // ordering matches the brief's explicit branch order (purge → commit →
  // mode-set → bare status → E_USAGE).
  if (subcommand === 'commit') {
    const commitValue = argv[1];
    if (!KNOWLEDGE_COMMIT_MODES.has(commitValue)) {
      writeEvent(workspace, flags, {
        type: 'knowledge',
        command: 'knowledge',
        decision: 'commit',
        result: 'fail',
        exitCode: EXIT.usage,
      });
      for (const l of ui.errorBlock({
        code: 'E_USAGE',
        message: `unknown commit mode: ${commitValue || '(none)'}`,
        fix: 'harness knowledge commit <none|repo>',
        exit: EXIT.usage,
      })) {
        console.error(l);
      }
      return EXIT.usage;
    }
    const commitResult = writeStoreConfig(workspace, { commit: commitValue });
    writeEvent(workspace, flags, {
      type: 'knowledge',
      command: 'knowledge',
      decision: `commit ${commitValue}`,
      result: commitResult.pass ? 'pass' : 'fail',
      exitCode: commitResult.pass ? 0 : 1,
      blockedReason: commitResult.blockedReason,
    });
    if (!commitResult.pass) {
      if (flags.json) {
        emitJson(flags, commitResult);
      } else {
        for (const l of ui.errorBlock({ code: commitResult.code || 'E_USAGE', message: commitResult.blockedReason, exit: 1 })) {
          console.error(l);
        }
      }
      return 1;
    }
    if (flags.json) {
      emitJson(flags, { pass: true, commit: commitValue });
    } else {
      console.log(
        ui.line({ state: commitValue === 'repo' ? 'ok' : 'warn', key: 'knowledge', value: `commit ${commitValue}` })
      );
    }
    return 0;
  }

  if (subcommand && KNOWLEDGE_MODES.has(subcommand)) {
    const modeResult = writeStoreConfig(workspace, { mode: subcommand });
    writeEvent(workspace, flags, {
      type: 'knowledge',
      command: 'knowledge',
      decision: subcommand,
      result: modeResult.pass ? 'pass' : 'fail',
      exitCode: modeResult.pass ? 0 : 1,
      blockedReason: modeResult.blockedReason,
    });
    if (!modeResult.pass) {
      if (flags.json) {
        emitJson(flags, modeResult);
      } else {
        for (const l of ui.errorBlock({ code: modeResult.code || 'E_USAGE', message: modeResult.blockedReason, exit: 1 })) {
          console.error(l);
        }
      }
      return 1;
    }
    if (flags.json) {
      emitJson(flags, { pass: true, mode: subcommand });
    } else {
      console.log(
        ui.line({ state: subcommand === 'on' ? 'ok' : 'warn', key: 'knowledge', value: `mode ${subcommand}` })
      );
    }
    return 0;
  }

  if (!subcommand) {
    const { mode, commit } = readStoreConfig(workspace);
    writeEvent(workspace, flags, {
      type: 'knowledge',
      command: 'knowledge',
      decision: 'status',
      result: 'pass',
      exitCode: 0,
    });
    if (flags.json) {
      emitJson(flags, { mode, commit });
    } else {
      console.log(
        ui.line({ state: mode === 'on' ? 'ok' : 'warn', key: 'knowledge', value: `mode ${mode} · commit ${commit}` })
      );
    }
    return 0;
  }

  writeEvent(workspace, flags, {
    type: 'knowledge',
    command: 'knowledge',
    decision: subcommand,
    result: 'fail',
    exitCode: EXIT.usage,
  });
  for (const l of ui.errorBlock({
    code: 'E_USAGE',
    message: `unknown knowledge mode: ${subcommand}`,
    fix: 'harness knowledge <on|suggest|off|freeze|capture-only> | --status | purge <file|--all> | commit <none|repo> | migrate-store',
    exit: EXIT.usage,
  })) {
    console.error(l);
  }
  return EXIT.usage;
}

export async function cmdGet(argv) {
  const { runGet } = await import('./get-cmd.mjs');
  const { inertLine } = await import('./knowledge/store.mjs');
  const flags = parseFlags(argv);
  const workspace = path.resolve(flags.workspace);
  const copilotHome = resolveCopilotHome(flags.copilotHome);
  const result = runGet({ workspace, copilotHome, flags });

  if (flags.json) {
    emitJson(flags, result);
  } else {
    console.log(ui.line({ key: 'get', value: result.docid || result.path, keyWidth: 3 }));
    // inertLine, applied PER LINE (minor #4, adversarial review): a raw file
    // excerpt is printed straight to the terminal, so an embedded ANSI
    // escape (ESC, 0x1B) or other control char could manipulate the
    // terminal itself — inertLine collapses those to a space. Split/rejoin
    // on '\n' first so the excerpt's genuine multi-line formatting (up to
    // 40 real lines) survives; only PLAIN JSON output (emitJson above) ever
    // needs the raw, un-scrubbed excerpt.
    console.log(result.excerpt.split('\n').map(inertLine).join('\n'));
  }
  return 0;
}

export async function cmdUninstall(argv) {
  const flags = parseFlags(argv);
  const copilotHome = resolveCopilotHome(flags.copilotHome);
  const lock = readLock(copilotHome);
  if (!lock?.files?.length) {
    const code = 'E_NOT_INSTALLED';
    const message = 'no lock file — nothing to uninstall';
    const hint = 'harness install';
    if (flags.json) {
      // Fix-wave C2: error envelopes are emission sinks too.
      console.error(redactedJson({ ok: false, error: { code, message, hint, exit: 1 } }));
    } else {
      for (const l of ui.errorBlock({ code, message, fix: hint, exit: 1 })) console.error(l);
    }
    return 1;
  }
  let removed = 0;
  for (const rel of lock.files) {
    const dest = resolveContainedPath(copilotHome, rel);
    if (!dest) {
      log(flags, `skip unsafe lock path: ${rel}`);
      continue;
    }
    if (!fs.existsSync(dest)) continue;
    if (flags.dryRun) {
      log(flags, `would remove ${rel}`);
      removed++;
      continue;
    }
    fs.rmSync(dest, { recursive: true, force: true });
    removed++;
  }
  if (!flags.dryRun) {
    fs.rmSync(path.join(copilotHome, LOCK_NAME), { force: true });
  }
  log(flags, `uninstall removed ${removed} paths`);
  return 0;
}

export async function cmdResolve(argv) {
  const flags = parseFlags(argv);
  const copilotHome = resolveCopilotHome(flags.copilotHome);
  const workspace = path.resolve(flags.workspace);
  const resolved = resolveHarnessBin({ workspace, copilotHome });
  const runner = path.join(workspace, '.harness', 'run.mjs');
  const shim = globalHarnessShimPath(copilotHome);

  const payload = {
    bin: resolved.bin,
    source: resolved.source,
    globalShim: fs.existsSync(shim) ? shim : null,
    onPath: resolved.onPath,
    runner: fs.existsSync(runner) ? runner : null,
    agentCommand: agentHarnessCommand(resolved),
    tried: resolved.tried,
  };

  if (flags.json) {
    emitJson(flags, payload);
  } else {
    if (payload.agentCommand) {
      const keyWidth = keyWidthFor(['resolve', 'agent']);
      console.log(ui.line({ state: 'ok', key: 'resolve', value: resolved.bin, note: resolved.source, keyWidth }));
      console.log(ui.line({ key: 'agent', value: payload.agentCommand, keyWidth }));
    } else {
      for (const l of ui.errorBlock({
        code: 'E_NO_HARNESS_BIN',
        message: 'could not resolve the harness CLI',
        fix: 'harness install',
        exit: 1,
      })) {
        console.error(l);
      }
      for (const t of resolved.tried) console.error(ui.paint('muted', `  tried ${t.source}  ${t.path}`));
    }
  }
  return resolved.bin ? 0 : 1;
}
