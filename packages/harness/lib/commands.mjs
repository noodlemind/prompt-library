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
  console.log(`[harness] ${msg}`);
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
// unless --verbose asks for the full list.
function printChecks(flags, checks, isPass = (c) => c.pass) {
  const shown = flags.verbose ? checks : checks.filter((c) => !isPass(c));
  for (const c of shown) {
    const mark = c.pass ?? isPass(c) ? 'PASS' : c.severity === 'warn' || c.status === 'warn' ? 'WARN' : 'FAIL';
    console.log(`${mark}  ${c.id}  ${c.message}`);
  }
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
    console.log(`harness ${command} complete (${version})`);
    console.log(`  Copilot home: ${copilotHome}`);
    if (allStats.vscode) {
      console.log(
        `  VS Code/CLI: +${allStats.vscode.created} ~${allStats.vscode.updated} =${allStats.vscode.unchanged} skip=${allStats.vscode.skipped}`
      );
    }
    if (allStats.intellij) {
      console.log(
        `  IntelliJ: +${allStats.intellij.created} ~${allStats.intellij.updated} =${allStats.intellij.unchanged}`
      );
    }
    if (flags.dryRun) console.log('  (dry-run — no files written)');
    else console.log('  Next: harness doctor  (or: node ~/.copilot/bin/harness doctor)');
    const shim = globalHarnessShimPath(copilotHome);
    if (!flags.dryRun && fs.existsSync(shim)) {
      console.log(`  Global CLI: ${shim}`);
      console.log('  Add to PATH: harness install --configure-path');
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
  const { checks, pass } = runDoctor({
    copilotHome,
    assetsRoot: assets,
    pkgRoot,
    flags,
  });

  if (flags.json) {
    emitJson(flags, { pass, checks });
  } else {
    const failed = checks.filter((c) => !c.pass && !c.optional).length;
    console.log(
      pass
        ? `Harness doctor: PASS (${checks.length} checks)`
        : `Harness doctor: FAIL (${failed} required) — fix items below`
    );
    for (const c of checks) {
      if (!flags.verbose && c.pass) continue;
      const mark = c.pass ? 'PASS' : c.optional ? 'WARN' : 'FAIL';
      console.log(`${mark}  ${c.id}  ${c.name}`);
      if (!c.pass && c.hint) console.log(`       → ${c.hint}`);
    }
  }
  return pass ? 0 : 1;
}

export async function cmdStatus(argv) {
  const flags = parseFlags(argv);
  const copilotHome = resolveCopilotHome(flags.copilotHome);
  const lock = readLock(copilotHome);
  const version = readPkgVersion();

  if (flags.json) {
    emitJson(flags, { packageVersion: version, copilotHome, lock });
  } else {
    console.log(`harness CLI ${version}`);
    console.log(`Copilot home: ${copilotHome}`);
    if (lock) {
      console.log(`Installed: ${lock.package}@${lock.version} at ${lock.installedAt}`);
      console.log(`Files tracked: ${lock.files?.length ?? 0}`);
    } else {
      console.log('No lock file — run: harness install');
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
    console.log('[harness] init-repo done.');
    console.log('  setup: run `harness index` to build the knowledge index and repo map; re-run after a major pull from main or a docs rewrite. Check drift anytime with `harness index --status`.');
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
      console.log(`harness index: ${status.indexed ? (status.stale ? 'STALE' : 'current') : 'not built'}`);
      console.log(`  ${status.recommendation}`);
    }
    return 0;
  }

  // Stamp the current git HEAD so `index --status` can measure drift later.
  const head = spawnSyncHead(workspace);
  runIndexKnowledge({
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
    console.log(`[harness] orient: context pack → ${result.contextPack}`);
    console.log(`  recall: ${result.recall.length} | plans: ${result.plans.length} | gate: ${result.gateStatus}`);
    if (result.blockedReason) console.log(`  blocked: ${result.blockedReason}`);
    if (result.nextTools?.[0]) console.log(`  next: ${result.nextTools[0]}`);
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
      result.pass
        ? `harness gate: PASS (${result.checks.length} checks)`
        : `harness gate: FAIL (${failed}/${result.checks.length}) — stop before editFiles`
    );
    printChecks(flags, result.checks);
    const next = result.nextTools?.[0];
    if (next) console.log(`next: ${next}`);
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
    console.log(`harness verify: ${result.outcome.toUpperCase()} (${failed}/${result.checks.length} checks not passed) — ${result.evidencePath}`);
    printChecks(flags, result.checks, (c) => c.status === 'passed');
    if (result.outcome === 'passed') {
      console.log('next: harness compound (or /auto-compound) to record the learning, then stop');
    } else {
      const firstFail = result.checks.find((c) => c.status !== 'passed');
      if (firstFail) console.log(`next: fix ${firstFail.id} (${firstFail.message.slice(0, 100)})`);
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
    console.log(`[harness] recall: "${result.query}"`);
    for (const r of result.recall) {
      console.log(`  ${r.score}  ${r.path}  ${r.title}`);
    }
    if (result.plans?.length) {
      console.log('  plans:');
      for (const p of result.plans) console.log(`    ${p.path} (${p.status})`);
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
    console.log(`[harness] events: ${events.length}${totalMatched > events.length ? ` of ${totalMatched}` : ''}`);
    if (totalMatched > events.length) console.log(`  (showing latest ${events.length}; narrow with --session/--failures or raise --limit)`);
    console.log(`  pass=${summary.pass} warn=${summary.warn} fail=${summary.fail}`);
    const u = summary.usage;
    if (u && u.totalTokens) {
      console.log(`  tokens (est): in=${u.inputTokens} out=${u.outputTokens} total=${u.totalTokens}`);
      if (flags.summary) {
        for (const [type, bucket] of Object.entries(u.byType).sort((a, b) => b[1].totalTokens - a[1].totalTokens)) {
          console.log(`    ${type}: ${bucket.totalTokens}`);
        }
      }
    }
    if (summary.lastActivePlan) console.log(`  last plan: ${summary.lastActivePlan}`);
    if (summary.latestBlockedReason) console.log(`  blocked: ${summary.latestBlockedReason}`);
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
      if (!flags.json) console.log(`[harness] report: synced ${synced.added} new event(s) → ${synced.file}`);
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
        console.log('harness report --check: FAIL — budget breaches');
        for (const b of report.flags.budgetBreaches) console.log(`  ${b.kind} ${b.target} = ${b.value} > cap ${b.cap}`);
      }
      return 1;
    }
    if (flags.json) emitJson(flags, { pass: true, breaches: [] });
    else console.log('harness report --check: PASS — no budget breaches');
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
    for (const c of result.checks) {
      const mark = c.pass ? 'PASS' : c.severity === 'warn' ? 'WARN' : 'FAIL';
      console.log(`${mark}  ${c.id}  ${c.message}`);
    }
    console.log('');
    console.log(result.pass ? 'harness validate-plan: pass' : 'harness validate-plan: FAIL');
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
    if (result.pass) {
      console.log(`[harness] compound: indexed ${result.indexed?.entries ?? 0} entries`);
      if (result.exitCode === 2) console.log('  verify gate warned — review Activity');
    } else {
      console.log(`[harness] compound: blocked — ${result.blockedReason}`);
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
    console.log(`[harness] get: ${result.docid || result.path}`);
    console.log(result.excerpt);
  }
  return 0;
}

export async function cmdUninstall(argv) {
  const flags = parseFlags(argv);
  const copilotHome = resolveCopilotHome(flags.copilotHome);
  const lock = readLock(copilotHome);
  if (!lock?.files?.length) {
    console.error('[harness] no lock file — nothing to uninstall');
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
      console.log(`[harness] resolved (${resolved.source}): ${resolved.bin}`);
      console.log(`[harness] agent command prefix: ${payload.agentCommand}`);
    } else {
      console.error('[harness] Could not resolve harness CLI');
      for (const t of resolved.tried) console.error(`  tried ${t.source}: ${t.path}`);
    }
  }
  return resolved.bin ? 0 : 1;
}
