import fs from 'fs';
import path from 'path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'module';
import { resolveIndexDir } from './recall-config.mjs';
import { isIndexStale } from './postings-index.mjs';
import { resolveHarnessBin } from './resolve-harness-bin.mjs';
import { globalHarnessShimPath, findHarnessOnPath } from './global-bin.mjs';
import { planDigest } from './evidence.mjs';
import { loadPlan } from './plan-parse.mjs';
import { runVerify } from './verify.mjs';
import { readSession, writeSession } from './session.mjs';
import { parseVSCodeSettings } from './vscode-settings.mjs';
import { resolveVSCodeSettingsPaths } from './paths.mjs';
import { loadRetired, findStaleOrphans } from './sync.mjs';
import { storeDir } from './knowledge/store.mjs';
import { consolidateStatus } from './knowledge/consolidate.mjs';
import { loadReportEvents, knowledgeSlos } from './report.mjs';

const require = createRequire(import.meta.url);

const MIN_ENRICHED_RATIO = 0.5;

function isEntryEnriched(e) {
  return Boolean((e.symptom && e.symptom.trim()) || (e.module && e.module.trim()));
}

function loadManifestEntries(manifestPath) {
  if (!fs.existsSync(manifestPath)) return { entries: [], updated: null };
  try {
    const yaml = require('yaml');
    const doc = yaml.parse(fs.readFileSync(manifestPath, 'utf8'));
    return { entries: doc.entries || [], updated: doc.updated || null };
  } catch {
    return { entries: [], updated: null };
  }
}

function hookCommands(config, event) {
  return (config?.hooks?.[event] || []).flatMap((entry) => (Array.isArray(entry.hooks) ? entry.hooks : [entry]));
}

function commandScript(command, hookRoot) {
  const match = String(command?.command || '').match(/^node\s+(?:"([^"]+)"|'([^']+)'|(\S+))/);
  if (!match) return null;
  const script = match[1] || match[2] || match[3];
  const cwd = command.cwd ? path.resolve(command.cwd) : hookRoot;
  return path.isAbsolute(script) ? script : path.resolve(cwd, script);
}

function loadInstalledHookConfig(hookRoot) {
  const configPath = path.join(hookRoot, 'hooks.json');
  if (!fs.existsSync(configPath)) return { config: null, error: 'Installed hooks/hooks.json is missing' };
  try {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    const requiredEvents = ['PreToolUse', 'PostToolUse', 'Stop'];
    for (const event of requiredEvents) {
      if (hookCommands(config, event).length === 0) throw new Error(`${event} is not registered`);
    }
    for (const event of Object.keys(config.hooks || {})) {
      for (const command of hookCommands(config, event)) {
        const script = commandScript(command, hookRoot);
        if (!script || !fs.existsSync(script)) throw new Error(`${event} command is not resolvable: ${command.command}`);
      }
    }
    return { config, error: null };
  } catch (error) {
    return { config: null, error: error.message };
  }
}

function vscodeDiscoveryConfigured(settingsPaths) {
  for (const settingsPath of settingsPaths) {
    if (!fs.existsSync(settingsPath)) continue;
    try {
      const settings = parseVSCodeSettings(fs.readFileSync(settingsPath, 'utf8'));
      if (settings['chat.hookFilesLocations']?.['~/.copilot/hooks'] === true) return true;
    } catch {
      // A parseable-settings check is represented by this false result.
    }
  }
  return false;
}

function fixturePlan() {
  return `---
plan_schema: 1
title: "VS Code hook doctor fixture"
type: fix
status: in-progress
plan_lock: true
phase: 1
risk: green
intent: "Prove the installed hook lifecycle"
expected_outputs: ["hook evidence"]
success_criteria: ["AC1 Hook probe passes"]
verification:
  required: [hook-probe]
  criteria:
    AC1: [hook-probe]
reviews:
  required: []
  completed: []
  critical_open: []
skills_used: [engineer]
capability_gaps: []
---

# VS Code hook doctor fixture

## Overview

Exercise installed hooks in an isolated fixture.

## Intent Contract

- **Goal:** Prove the installed hook lifecycle.
- **Expected outputs:** Hook evidence.
- **Success criteria:** AC1 passes.

## Acceptance Criteria

- [x] **AC1** Hook probe passes.

## Plan

### Phase 1 — Probe

- [x] Exercise the hook lifecycle.

## Impacted Files

- \`src/schema.json\`

## Verification Plan

- Run the trusted hook probe.

## Risk & Review Routing

- Green fixture-only risk.

## Review Findings

- None.

## Activity

- Doctor fixture created.
`;
}

function runHook(script, workspace, payload) {
  return spawnSync(process.execPath, [script], {
    cwd: workspace,
    input: JSON.stringify({
      cwd: workspace,
      session_id: 'doctor-vscode-session',
      ...payload,
    }),
    encoding: 'utf8',
    env: { ...process.env, HARNESS_ENFORCEMENT: 'enforce' },
    timeout: 15_000,
  });
}

function hookBlocked(result, event) {
  if (result.status === 2) return true;
  try {
    const line = result.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1);
    const output = line ? JSON.parse(line) : {};
    if (event === 'PreToolUse') {
      return (
        output.hookSpecificOutput?.permissionDecision === 'deny' || output.permissionDecision === 'deny'
      );
    }
    return output.hookSpecificOutput?.decision === 'block' || output.decision === 'block';
  } catch {
    return false;
  }
}

function runVSCodeHookProbe(hookRoot) {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-doctor-vscode-'));
  const planRel = 'docs/plans/vscode-hook-doctor-plan.md';
  const result = {
    recognized: false,
    missingGateDenied: false,
    gatedAllowed: false,
    postRecorded: false,
    unverifiedDenied: false,
    verifiedAllowed: false,
  };
  try {
    fs.mkdirSync(path.join(workspace, 'docs', 'plans'), { recursive: true });
    fs.mkdirSync(path.join(workspace, '.github', 'harness'), { recursive: true });
    fs.mkdirSync(path.join(workspace, 'src'), { recursive: true });
    fs.writeFileSync(path.join(workspace, planRel), fixturePlan());
    fs.writeFileSync(path.join(workspace, 'src', 'schema.json'), '{}\n');
    fs.writeFileSync(
      path.join(workspace, '.github', 'harness', 'policy.yaml'),
      'version: 1\nenforcement: enforce\ngate_ttl_minutes: 30\nevidence_ttl_hours: 24\n'
    );
    fs.writeFileSync(
      path.join(workspace, '.github', 'harness', 'checks.yaml'),
      `version: 1\nchecks:\n  hook-probe:\n    command: ${JSON.stringify([process.execPath, '-e', 'process.exit(0)'])}\n`
    );
    const git = (args) =>
      spawnSync('git', args, {
        cwd: workspace,
        encoding: 'utf8',
        timeout: 10_000,
        env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
      });
    if (git(['init', '-q']).status !== 0) return result;
    git(['config', 'user.email', 'harness@example.test']);
    git(['config', 'user.name', 'Harness Doctor']);
    git(['add', '.']);
    if (git(['commit', '-qm', 'fixture']).status !== 0) return result;

    const pre = path.join(hookRoot, 'require-plan-gate.mjs');
    const post = path.join(hookRoot, 'record-successful-edit.mjs');
    const stop = path.join(hookRoot, 'require-verification.mjs');
    const mutation = {
      hook_event_name: 'PreToolUse',
      tool_name: 'replace_string_in_file',
      tool_input: { filePath: 'src/schema.json' },
    };
    const missing = runHook(pre, workspace, mutation);
    result.missingGateDenied = hookBlocked(missing, 'PreToolUse');
    const eventsPath = path.join(workspace, '.harness', 'events.jsonl');
    if (fs.existsSync(eventsPath)) {
      const events = fs.readFileSync(eventsPath, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
      result.recognized = events.some(
        (event) => event.type === 'pre_tool' && event.tool === 'replace_string_in_file' && event.targetResolved === true
      );
    }

    writeSession(workspace, {
      sessionId: 'doctor-vscode-session',
      activePlan: planRel,
      gatedPlan: planRel,
      gatedPlanDigest: planDigest(fs.readFileSync(path.join(workspace, planRel), 'utf8')),
      gateStatus: 'pass',
      lastGateAt: new Date().toISOString(),
    });
    const allowed = runHook(pre, workspace, mutation);
    result.gatedAllowed = allowed.status === 0 && !hookBlocked(allowed, 'PreToolUse');

    const postResult = runHook(post, workspace, {
      hook_event_name: 'PostToolUse',
      tool_name: 'replace_string_in_file',
      tool_input: { filePath: 'src/schema.json' },
      tool_response: 'File edited successfully',
    });
    const afterPost = readSession(workspace);
    result.postRecorded = postResult.status === 0 && Boolean(afterPost?.lastEditAt);

    const deniedStop = runHook(stop, workspace, { hook_event_name: 'Stop', stop_hook_active: false });
    result.unverifiedDenied = hookBlocked(deniedStop, 'Stop');

    const plan = loadPlan(workspace, planRel);
    const verification = runVerify({
      workspace,
      flags: { plan: planRel, base: 'HEAD', dryRun: false, enforcement: 'enforce' },
    });
    if (verification.outcome === 'passed' && plan) {
      writeSession(workspace, {
        ...readSession(workspace),
        activePlan: planRel,
        lastVerifyAt: new Date().toISOString(),
        lastVerifyOutcome: verification.outcome,
        lastEvidencePath: verification.evidencePath,
      });
      const allowedStop = runHook(stop, workspace, { hook_event_name: 'Stop', stop_hook_active: false });
      const endEvents = fs.existsSync(eventsPath)
        ? fs.readFileSync(eventsPath, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse)
        : [];
      result.verifiedAllowed =
        allowedStop.status === 0 &&
        !hookBlocked(allowedStop, 'Stop') &&
        endEvents.some((event) => event.type === 'session_end' && event.result === 'pass');
    }
    return result;
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
}

function vscodeChecks({ copilotHome, settingsPaths }) {
  const hookRoot = path.join(copilotHome, 'hooks');
  const installed = fs.existsSync(path.join(hookRoot, 'hooks.json'));
  const loaded = installed ? loadInstalledHookConfig(hookRoot) : { config: null, error: 'Installed hook bundle is missing' };
  const discovery = vscodeDiscoveryConfigured(settingsPaths);
  const probe = loaded.config ? runVSCodeHookProbe(hookRoot) : {};
  return [
    { id: 'V1', name: 'VS Code hook bundle installed', pass: installed, hint: 'Run: harness upgrade --configure-vscode' },
    { id: 'V2', name: 'VS Code hook configuration and commands resolvable', pass: Boolean(loaded.config), hint: loaded.error || 'Reinstall hooks' },
    { id: 'V3', name: 'VS Code user hook discovery configured', pass: discovery, hint: 'Run: harness install --configure-vscode' },
    { id: 'V4', name: 'Known VS Code mutation payload recognized', pass: Boolean(probe.recognized), hint: 'Inspect payload normalization and hook events' },
    { id: 'V5', name: 'Missing-gate mutation denied', pass: Boolean(probe.missingGateDenied), hint: 'Inspect PreToolUse policy output' },
    { id: 'V6', name: 'Gated scoped mutation allowed', pass: Boolean(probe.gatedAllowed), hint: 'Inspect plan gate and scope handling' },
    { id: 'V7', name: 'Successful PostToolUse event recorded', pass: Boolean(probe.postRecorded), hint: 'Inspect record-successful-edit.mjs' },
    { id: 'V8', name: 'Completion without verification denied', pass: Boolean(probe.unverifiedDenied), hint: 'Inspect Stop hook registration and evidence checks' },
    { id: 'V9', name: 'Completion after passed verification allowed', pass: Boolean(probe.verifiedAllowed), hint: 'Inspect evidence binding and freshness' },
  ];
}

// Knowledge-layer health (design §2, §3, §12). All three are optional/advisory
// and each independently try/catch-guarded — a store or event-read failure
// degrades to "skip that check", never to a doctor crash. K2's consolidateStatus
// call touches the store via ensureStore, so — like orient.mjs — it is only
// made once storeDir already exists; doctor must never materialize a store.
function knowledgeChecks({ workspace }) {
  const checks = [];

  try {
    const events = loadReportEvents({ workspace });
    const hasConsolidateEvent = events.some((e) => e.type === 'consolidate');
    const storeExists = fs.existsSync(storeDir(workspace));
    checks.push({
      id: 'K1',
      name: 'Knowledge store present for consolidated history',
      pass: !hasConsolidateEvent || storeExists,
      hint: 'knowledge store missing — restore from backup or run: harness consolidate --rebuild --yes after re-arming',
      optional: true,
    });
  } catch {
    // Advisory; never fail doctor on a knowledge-check error.
  }

  try {
    const storeExists = fs.existsSync(storeDir(workspace));
    const quarantined = storeExists ? consolidateStatus({ workspace }).quarantined.length : 0;
    checks.push({
      id: 'K2',
      name: 'No quarantined episode clusters',
      pass: quarantined === 0,
      hint: 'quarantined episode cluster(s) — inspect with harness consolidate --status',
      optional: true,
    });
  } catch {
    // Advisory; never fail doctor on a knowledge-check error.
  }

  try {
    const slos = knowledgeSlos(loadReportEvents({ workspace }));
    const noisy = slos.utilization !== null && slos.utilization < 0.15 && slos.surfaced >= 20;
    checks.push({
      id: 'K3',
      name: 'Knowledge utilization above noise threshold',
      pass: !noisy,
      hint: 'knowledge layer is noise (<15% utilization) — consider: harness knowledge off',
      optional: true,
    });
  } catch {
    // Advisory; never fail doctor on a knowledge-check error.
  }

  return checks;
}

export function runDoctor({ copilotHome, assetsRoot, pkgRoot, flags, vscodeSettingsPaths = null, workspace = flags.workspace }) {
  const checks = [];

  const manifest = path.join(copilotHome, 'knowledge', 'manifest.yaml');
  const manifestRepo = path.join(assetsRoot, 'knowledge', 'manifest.yaml');
  checks.push({
    id: 'H1',
    name: 'Global knowledge manifest',
    pass: fs.existsSync(manifest) || fs.existsSync(manifestRepo),
    hint: 'Run: harness install',
  });

  const profile = path.join(copilotHome, 'knowledge', 'profile.md');
  checks.push({
    id: 'H2',
    name: 'Profile (autonomy)',
    pass: fs.existsSync(profile),
    hint: 'install seeds knowledge/profile.md from template',
  });

  const engineer = path.join(copilotHome, 'agents', 'engineer.agent.md');
  const engineerAsset = path.join(assetsRoot, 'agents', 'engineer.agent.md');
  checks.push({
    id: 'H3',
    name: 'Engineer agent',
    pass: fs.existsSync(engineer) || fs.existsSync(engineerAsset),
    hint: 'Run: harness install',
  });

  const captureGate = path.join(
    copilotHome,
    'skills',
    'references',
    'capture-gate.md'
  );
  checks.push({
    id: 'H4',
    name: 'Capture gate reference',
    pass:
      fs.existsSync(captureGate) ||
      fs.existsSync(path.join(assetsRoot, 'skills', 'references', 'capture-gate.md')),
    hint: 'Re-run install',
  });

  checks.push({
    id: 'H5',
    name: 'Product docs/plans (cwd)',
    pass: fs.existsSync(path.join(flags.workspace, 'docs', 'plans')),
    hint: 'harness init-repo',
  });

  const entReg = path.join(copilotHome, 'enterprise', 'capability-registry.enterprise.yaml');
  checks.push({
    id: 'H6',
    name: 'Enterprise overlay (optional)',
    pass: fs.existsSync(entReg) || fs.existsSync(path.join(assetsRoot, 'enterprise', 'capability-registry.enterprise.yaml')),
    hint: 'Optional: add enterprise pack or install base harness',
    optional: true,
  });

  for (const skill of ['ensure-plan', 'auto-compound', 'ensure-capability', 'auto-skill-draft']) {
    const p = path.join(copilotHome, 'skills', skill, 'SKILL.md');
    checks.push({
      id: 'H7',
      name: `Autopilot skill /${skill}`,
      pass: fs.existsSync(p) || fs.existsSync(path.join(assetsRoot, 'skills', skill, 'SKILL.md')),
      hint: 'Run: harness upgrade',
    });
  }

  checks.push({
    id: 'H8',
    name: 'Assets bundle in package',
    pass: fs.existsSync(assetsRoot),
    hint: 'Maintainer: npm run build:assets before publish',
  });

  const lockPath = path.join(copilotHome, '.harness-lock.json');
  checks.push({
    id: 'H9',
    name: 'Harness lock file',
    pass: fs.existsSync(lockPath),
    hint: 'Run install or upgrade',
    optional: true,
  });

  const manifestPath = fs.existsSync(manifest)
    ? manifest
    : fs.existsSync(path.join(flags.workspace, 'knowledge', 'manifest.yaml'))
      ? path.join(flags.workspace, 'knowledge', 'manifest.yaml')
      : manifestRepo;
  const { entries: manifestEntries, updated: manifestUpdated } = loadManifestEntries(manifestPath);
  const enrichedCount = manifestEntries.filter(isEntryEnriched).length;
  const hasEnrichedFields =
    manifestEntries.length === 0 ||
    enrichedCount / manifestEntries.length >= MIN_ENRICHED_RATIO;
  checks.push({
    id: 'H10',
    name: 'Manifest enriched fields (symptom/module)',
    pass: hasEnrichedFields,
    hint: 'Run: harness index — rebuild manifest with symptom/module/excerpt',
    optional: manifestEntries.length === 0,
  });

  const indexDir = resolveIndexDir(copilotHome, flags.workspace);
  const indexFresh =
    manifestEntries.length === 0 || !fs.existsSync(path.join(indexDir, 'meta.json'))
      ? false
      : !isIndexStale(indexDir, manifestUpdated);
  checks.push({
    id: 'H11',
    name: 'BM25 postings index fresh',
    pass: indexFresh,
    hint: 'Run: harness index — rebuild .harness-index/postings.json',
    optional: manifestEntries.length === 0,
  });

  const resolved = resolveHarnessBin({ workspace: flags.workspace, copilotHome });
  const runnerPath = path.join(flags.workspace, '.harness', 'run.mjs');
  checks.push({
    id: 'H12',
    name: 'Harness CLI resolvable',
    pass: Boolean(resolved.bin),
    hint: resolved.bin
      ? `Resolved via ${resolved.source}: ${resolved.bin}`
      : 'Run: harness install, then init-repo (creates .harness/run.mjs)',
  });
  checks.push({
    id: 'H13',
    name: 'Workspace harness runner',
    pass: fs.existsSync(runnerPath),
    hint: 'Run: harness init-repo',
    optional: true,
  });

  const hooksJson = path.join(copilotHome, 'hooks', 'hooks.json');
  const hooksAsset = path.join(assetsRoot, 'hooks', 'hooks.json');
  checks.push({
    id: 'H14',
    name: 'Lifecycle hooks bundle',
    pass: fs.existsSync(hooksJson) || fs.existsSync(hooksAsset),
    hint: 'Re-run harness install to sync .github/hooks/',
    optional: true,
  });

  const shim = globalHarnessShimPath(copilotHome);
  const cliResolvable = Boolean(resolved.bin);
  checks.push({
    id: 'H15',
    name: 'Global harness shim (~/.copilot/bin/harness)',
    pass: fs.existsSync(shim),
    hint: 'Run: harness install (creates ~/.copilot/bin/harness)',
    optional: cliResolvable && !fs.existsSync(shim),
  });

  const onPath = Boolean(findHarnessOnPath());
  checks.push({
    id: 'H16',
    name: 'harness on PATH',
    pass: onPath,
    hint: 'Run: harness install --configure-path  (or add ~/.copilot/bin to PATH)',
    optional: true,
  });

  // Degrade honestly: without the shipped asset bundle there is no ship list
  // to compare against, so never claim orphans that cannot be verified.
  const assetsAvailable = fs.existsSync(path.join(assetsRoot, 'skills', 'engineer', 'SKILL.md'));
  const orphans =
    pkgRoot && assetsAvailable ? findStaleOrphans(copilotHome, assetsRoot, loadRetired(pkgRoot)) : [];
  checks.push({
    id: 'H17',
    name: 'No stale orphaned primitives',
    pass: assetsAvailable && orphans.length === 0,
    hint: !assetsAvailable
      ? 'cannot verify — this runtime has no asset bundle; re-run: harness install (refreshes ~/.copilot/.harness-bin with assets), then harness doctor'
      : orphans.length
        ? `Hydrated but no longer shipped and not retired (${orphans.length}): ${orphans.join(', ')}. Add each to packages/harness/retired.json so upgrade purges it, or delete it from ${copilotHome}.`
        : 'No orphaned agents/skills/instructions/prompts/hooks in the Copilot home',
    optional: true,
  });

  checks.push(...knowledgeChecks({ workspace }));

  if (flags.host === 'vscode') {
    checks.push(
      ...vscodeChecks({
        copilotHome,
        settingsPaths: vscodeSettingsPaths || resolveVSCodeSettingsPaths(),
      })
    );
  } else if (flags.host) {
    checks.push({
      id: 'V0',
      name: `Unsupported doctor host: ${flags.host}`,
      pass: false,
      hint: 'Supported host: vscode',
    });
  }

  const required = checks.filter((c) => !c.optional);
  const pass = required.every((c) => c.pass);
  return { checks, pass };
}
