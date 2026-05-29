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
import { applyInstallDefaults } from './install-defaults.mjs';
import { isFirstHarnessInstall, markOnboardingComplete, printPostSetupOnboarding } from './onboard.mjs';
import { parseQueryFromArgv } from './argv.mjs';
import { readEvents, summarizeEvents, writeEvent } from './events.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const pkgRoot = pkgRootFromImportMeta(import.meta.url);

function readPkgVersion() {
  const p = JSON.parse(fs.readFileSync(path.join(pkgRoot, 'package.json'), 'utf8'));
  return p.version;
}

export function getAssetsRoot() {
  const bundled = path.join(pkgRoot, 'assets');
  if (fs.existsSync(path.join(bundled, 'skills', 'engineer', 'SKILL.md'))) {
    return bundled;
  }
  const buildScript = path.resolve(pkgRoot, '../../scripts/build-harness-assets.mjs');
  if (fs.existsSync(buildScript)) {
    execSync(`node "${buildScript}"`, { cwd: pkgRoot, stdio: 'pipe' });
    if (fs.existsSync(path.join(bundled, 'skills'))) return bundled;
  }
  throw new Error(
    'Package assets not found. From a prompt-library clone run: npm --prefix packages/harness run build:assets. Otherwise reinstall the packaged CLI with: npm install -g @dev-kit/harness.'
  );
}

function log(flags, msg) {
  if (flags.json) return;
  console.log(`[harness] ${msg}`);
}

export async function cmdInstallOrUpgrade(command, argv) {
  const flags = applyInstallDefaults(parseFlags(argv), argv, command);
  const version = readPkgVersion();
  const assets = getAssetsRoot();
  const copilotHome = resolveCopilotHome(flags.copilotHome);
  const previousLock = readLock(copilotHome);
  const retired = loadRetired(pkgRoot);
  const logger = (m) => log(flags, m);

  if (!flags.json && (command === 'setup' || command === 'install')) {
    log(
      flags,
      command === 'setup'
        ? 'setup: syncing Copilot globals (VS Code discovery, autonomy=balanced)'
        : 'install: syncing Copilot globals (use harness setup for the same defaults)'
    );
  }

  const allStats = { vscode: null, intellij: null };

  if (flags.targets.has('vscode') || flags.targets.has('cli')) {
    applyRetired(copilotHome, retired, previousLock, flags, logger);
    allStats.vscode = syncAssetsToTarget(assets, copilotHome, flags, logger);
    seedProfile(assets, copilotHome, flags, logger);
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
  ]);

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
    else console.log('  Next: harness doctor');
    if (!flags.dryRun && firstInstall && (command === 'setup' || command === 'install')) {
      markOnboardingComplete(copilotHome, false);
      printPostSetupOnboarding({ copilotHome });
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
    console.log(JSON.stringify({ pass, checks }, null, 2));
  } else {
    for (const c of checks) {
      const mark = c.pass ? 'PASS' : c.optional ? 'WARN' : 'FAIL';
      console.log(`${mark}  ${c.id}  ${c.name}`);
      if (!c.pass && c.hint) console.log(`       → ${c.hint}`);
    }
    console.log('');
    console.log(pass ? 'Harness doctor: all required checks passed.' : 'Harness doctor: fix FAIL items above.');
  }
  return pass ? 0 : 1;
}

export async function cmdStatus(argv) {
  const flags = parseFlags(argv);
  const copilotHome = resolveCopilotHome(flags.copilotHome);
  const lock = readLock(copilotHome);
  const version = readPkgVersion();

  if (flags.json) {
    console.log(JSON.stringify({ packageVersion: version, copilotHome, lock }, null, 2));
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
  if (!flags.json) console.log('[harness] init-repo done.');
  return 0;
}

export async function cmdIndex(argv) {
  const flags = parseFlags(argv);
  const copilotHome = resolveCopilotHome(flags.copilotHome);
  const knowledgeRoot = path.join(copilotHome, 'knowledge');
  const workspace = path.resolve(flags.workspace);
  const logger = (m) => log(flags, m);
  runIndexKnowledge({
    knowledgeRoot: fs.existsSync(knowledgeRoot) ? knowledgeRoot : null,
    workspace,
    copilotHome,
    flags,
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
  writeEvent(workspace, flags, {
    type: 'orient',
    command: 'orient',
    plan: result.activePlan?.path || null,
    result: result.gateStatus === 'pass' ? 'pass' : 'fail',
    exitCode: 0,
    blockedReason: result.blockedReason,
  });

  if (flags.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`[harness] orient: context pack → ${result.contextPack}`);
    console.log(`  recall: ${result.recall.length} | plans: ${result.plans.length} | gate: ${result.gateStatus}`);
    if (result.blockedReason) console.log(`  blocked: ${result.blockedReason}`);
  }
  return 0;
}

export async function cmdGate(argv) {
  const { runGate } = await import('./gate.mjs');
  const flags = parseFlags(argv);
  const workspace = path.resolve(flags.workspace);
  const query = parseQueryFromArgv(argv, flags);
  const result = runGate({ workspace, flags, query });
  writeEvent(workspace, flags, {
    type: 'gate',
    command: 'gate',
    plan: result.plan?.path || null,
    phase: result.phase,
    exitCode: result.exitCode,
    checks: result.checks,
    blockedReason: result.blockedReason,
  });

  if (flags.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    for (const c of result.checks) {
      const mark = c.pass ? 'PASS' : c.severity === 'warn' ? 'WARN' : 'FAIL';
      console.log(`${mark}  ${c.id}  ${c.message}`);
    }
    console.log('');
    console.log(result.pass ? 'harness gate: pass' : 'harness gate: FAIL — stop before editFiles');
  }
  return result.exitCode;
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
    console.log(JSON.stringify(result, null, 2));
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
  const events = readEvents(workspace, flags.limit || 20);
  const summary = summarizeEvents(events);

  if (flags.json) {
    console.log(JSON.stringify({ count: events.length, summary, events }, null, 2));
  } else {
    console.log(`[harness] events: ${events.length}`);
    console.log(`  pass=${summary.pass} warn=${summary.warn} fail=${summary.fail}`);
    if (summary.lastActivePlan) console.log(`  last plan: ${summary.lastActivePlan}`);
    if (summary.latestBlockedReason) console.log(`  blocked: ${summary.latestBlockedReason}`);
  }
  return 0;
}

export async function cmdValidatePlan(argv) {
  const { runValidatePlan } = await import('./validate-plan.mjs');
  const flags = parseFlags(argv);
  const workspace = path.resolve(flags.workspace);
  const result = runValidatePlan({ workspace, flags, planPath: flags.plan });
  writeEvent(workspace, flags, {
    type: 'validate_plan',
    command: 'validate-plan',
    plan: result.plan?.path || null,
    exitCode: result.exitCode,
    checks: result.checks,
    blockedReason: result.blockedReason,
  });

  if (flags.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    for (const c of result.checks) {
      const mark = c.pass ? 'PASS' : c.severity === 'warn' ? 'WARN' : 'FAIL';
      console.log(`${mark}  ${c.id}  ${c.message}`);
    }
    console.log('');
    console.log(result.pass ? 'harness validate-plan: pass' : 'harness validate-plan: FAIL');
  }
  return result.exitCode;
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
    console.log(JSON.stringify(result, null, 2));
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
    console.log(JSON.stringify(result, null, 2));
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
