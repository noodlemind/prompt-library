import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';
import { parseFlags } from './flags.mjs';
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
import { resolveHarnessBin, agentHarnessCommand } from './resolve-harness-bin.mjs';
import { installGlobalHarnessShim, configureShellPath, globalHarnessShimPath } from './global-bin.mjs';
import { readSession, writeSession } from './session.mjs';
import { loadPolicy } from './policy.mjs';
import { createStyle, keyWidthFor, clampNote, EXIT } from './style.mjs';

// One renderer per process, bound to stdout's real capabilities.
// --no-color / NO_COLOR / non-TTY all degrade to the ascii surface.
const ui = createStyle({ argv: process.argv.slice(2) });

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const pkgRoot = pkgRootFromImportMeta(import.meta.url);

function readPkgVersion() {
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
function emitJson(flags, obj) {
  console.log(flags.verbose ? JSON.stringify(obj, null, 2) : JSON.stringify(obj));
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
    console.log(
      JSON.stringify(
        {
          command,
          version,
          copilotHome,
          dryRun: flags.dryRun,
          vscode: allStats.vscode,
          intellij: allStats.intellij,
        },
        null,
        2
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
    const shim = globalHarnessShimPath(copilotHome);
    if (!flags.dryRun && fs.existsSync(shim)) {
      console.log(
        ui.line({ key: 'global cli', value: shim, note: 'PATH: harness install --configure-path', keyWidth })
      );
    }
    if (flags.dryRun) console.log(ui.paint('muted', '  dry-run — no files written'));
    else printNext('harness doctor');
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
  const { checks, pass } = runDoctor({
    copilotHome,
    assetsRoot: assets,
    pkgRoot,
    flags,
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

export async function cmdStatus(argv) {
  const flags = parseFlags(argv);
  const copilotHome = resolveCopilotHome(flags.copilotHome);
  const lock = readLock(copilotHome);
  const version = readPkgVersion();

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
  const logger = (m) => log(flags, m);
  runInitRepo({ workspace, flags, log: logger });
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

  // Read-only freshness report — never rebuilds, zero model cost.
  if (argv.includes('--status')) {
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

  // Stamp the current git HEAD so `index --status` can measure drift later.
  const head = spawnSyncHead(workspace);
  const result = runIndexKnowledge({
    knowledgeRoot: fs.existsSync(knowledgeRoot) ? knowledgeRoot : null,
    workspace,
    copilotHome,
    flags: { ...flags, headSha: head },
    log: logger,
  });
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
    console.log(
      ui.line({
        state: 'ok',
        key: 'index',
        value: `${result.entries} entries · ${result.indexEntries ?? result.entries} postings`,
        note: empty ? 'no solution docs under knowledge/solutions or docs/solutions yet' : undefined,
        next: empty ? 'harness compound records the first learning' : undefined,
      })
    );
  }
  return 0;
}

export async function cmdOrient(argv) {
  const { runOrient } = await import('./orient.mjs');
  const flags = parseFlags(argv);
  const workspace = path.resolve(flags.workspace);
  const copilotHome = resolveCopilotHome(flags.copilotHome);
  const query = parseQueryFromArgv(argv, flags);
  const result = runOrient({ workspace, copilotHome, flags, query });
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
  });

  if (flags.json) {
    emitJson(flags, result);
  } else {
    console.log(
      ui.line({
        state: result.gateStatus === 'pass' ? 'ok' : 'warn',
        key: 'orient',
        value: result.contextPack,
        note: `recall ${result.recall.length} · plans ${result.plans.length} · gate ${result.gateStatus}`,
      })
    );
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

export async function cmdVerify(argv) {
  const { runVerify, exitCodeForOutcome } = await import('./verify.mjs');
  const flags = parseFlags(argv);
  const workspace = path.resolve(flags.workspace);
  const result = runVerify({ workspace, flags });
  const exitCode = exitCodeForOutcome(result.outcome, result.enforcement);
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
    result: result.outcome === 'passed' ? 'pass' : result.outcome === 'failed' ? 'fail' : 'warn',
    checks: result.checks,
    blockedReason: result.outcome === 'passed' ? null : `${result.outcome} verification`,
    usage: usageFields({ input: result.plan || '', output: result.checks.map((c) => c.message).join('\n') }),
  });

  if (flags.json) emitJson(flags, result);
  else {
    const failed = result.checks.filter((c) => c.status !== 'passed').length;
    const passed = result.outcome === 'passed';
    console.log(
      ui.line({
        state: passed ? 'ok' : exitCode === 0 ? 'warn' : 'error',
        key: 'verify',
        value: passed
          ? `passed · ${result.checks.length} checks`
          : `${result.outcome} · ${failed} of ${result.checks.length} checks`,
        note: result.evidencePath,
      })
    );
    printChecks(flags, result.checks, (c) => c.status === 'passed');
    if (passed) {
      printNext('harness compound (or /auto-compound), then stop');
    } else {
      const firstFail = result.checks.find((c) => c.status !== 'passed');
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
  if (argv.includes('--include-plans')) flags.includePlans = true;
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
      console.log(ui.line({ key: String(r.score), value: r.path, note: r.title, keyWidth: 6 }));
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

export async function cmdGet(argv) {
  const { runGet } = await import('./get-cmd.mjs');
  const flags = parseFlags(argv);
  const workspace = path.resolve(flags.workspace);
  const copilotHome = resolveCopilotHome(flags.copilotHome);
  const result = runGet({ workspace, copilotHome, flags });

  if (flags.json) {
    emitJson(flags, result);
  } else {
    console.log(ui.line({ key: 'get', value: result.docid || result.path, keyWidth: 3 }));
    console.log(result.excerpt);
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
      console.error(JSON.stringify({ ok: false, error: { code, message, hint, exit: 1 } }));
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
