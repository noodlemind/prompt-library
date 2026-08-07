import fs from 'fs';
import path from 'path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'module';
import { resolveIndexDir } from './recall-config.mjs';
import { isIndexStale } from './postings-index.mjs';
import { resolveHarnessBin, RUNNER_VERSION } from './resolve-harness-bin.mjs';
import { globalHarnessShimPath, findHarnessOnPath } from './global-bin.mjs';
import { planDigest } from './evidence.mjs';
import { loadPlan } from './plan-parse.mjs';
import { runVerify } from './verify.mjs';
import { readSession, writeSession } from './session.mjs';
import { parseVSCodeSettings } from './vscode-settings.mjs';
import { resolveVSCodeSettingsPaths } from './paths.mjs';
import { loadRetired, findStaleOrphans } from './sync.mjs';
import { storeDir, storeDirForId, repoId, localRepoId, listLearnings } from './knowledge/store.mjs';
import { consolidateStatus } from './knowledge/consolidate.mjs';
import { listBuckets } from './knowledge/overlay.mjs';
import { branchExists } from './knowledge/layer.mjs';
import { deriveGitContext, resolveDefaultBranch } from './git-context.mjs';
import { loadReportEvents, knowledgeSlos } from './report.mjs';
import { readStructuralIndex } from './repo-map/structural-index.mjs';
import { grammarStatus, packageGrammarRoots } from './repo-map/treesitter-extractor.mjs';
import { assertNoSymlinkAncestors } from './fs-safe.mjs';

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

// P1.6: async — runVerify (lib/verify.mjs) is now async (AC8, wired onto
// lib/runner.mjs's async spawn). Nothing about this fixture probe's own
// behavior changes; it just has to await the one call it already made.
async function runVSCodeHookProbe(hookRoot) {
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
    const verification = await runVerify({
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

async function vscodeChecks({ copilotHome, settingsPaths }) {
  const hookRoot = path.join(copilotHome, 'hooks');
  const installed = fs.existsSync(path.join(hookRoot, 'hooks.json'));
  const loaded = installed ? loadInstalledHookConfig(hookRoot) : { config: null, error: 'Installed hook bundle is missing' };
  const discovery = vscodeDiscoveryConfigured(settingsPaths);
  const probe = loaded.config ? await runVSCodeHookProbe(hookRoot) : {};
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
// call is only made once storeDir already exists (like orient.mjs) — doctor
// must never materialize a store — and copilotHome is threaded through so
// its episode/debt computation uses the same roots as every other caller.
function knowledgeChecks({ workspace, copilotHome }) {
  const checks = [];

  try {
    const events = loadReportEvents({ workspace });
    const hasConsolidateEvent = events.some(
      (e) => e.type === 'consolidate' && e.decision === 'apply' && e.result === 'pass'
    );
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
    const quarantined = storeExists ? consolidateStatus({ workspace, copilotHome }).quarantined.length : 0;
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
    const noisy = slos.utilizationWeighted !== null && slos.utilizationWeighted < 0.15 && slos.surfacedOccurrences >= 20;
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

  // K4 (P2, design §2): repoId (store.mjs) switches from a path-keyed
  // local-<hash> id to a remote-keyed id the instant this workspace gains an
  // origin remote — a store built BEFORE that switch is left on disk under
  // the OLD id, silently orphaned (every mutator now resolves storeDir
  // against the NEW id, so the old store is never read or written again).
  // DETECTS only — never auto-migrates; a human runs the printed command.
  //
  // Two distinct FAILING shapes, not one — the common sequence (add remote,
  // then do one more consolidate --apply/remember before anyone notices) is
  // what makes this matter: the FRESH store materializes under the new id,
  // and a check that only fired on "legacy exists, current doesn't" would go
  // permanently blind at exactly that point — the orphaned legacy store
  // would sit there forever with K4 reporting a clean pass. Both shapes fail
  // (never silently clear once a second store exists), each with its own
  // hint:
  //   - legacy exists, current does NOT: the pre-write window — migrate-store
  //     will succeed cleanly.
  //   - legacy exists AND current exists: the post-write window — migrate-
  //     store now refuses (a non-empty target), so the hint routes to manual
  //     reconciliation instead of a command that would just fail.
  try {
    const currentId = repoId(workspace);
    const hasRemote = !currentId.startsWith('local-');
    let stranded = false;
    let hint = 'harness knowledge migrate-store';
    if (hasRemote) {
      const legacyDir = storeDirForId(localRepoId(workspace));
      const currentDir = storeDirForId(currentId);
      const legacyExists = fs.existsSync(path.join(legacyDir, 'consolidated.jsonl'));
      const currentExists = fs.existsSync(path.join(currentDir, 'consolidated.jsonl'));
      if (legacyExists && !currentExists) {
        stranded = true;
        hint = `a path-keyed store exists at ${legacyDir} but this workspace now resolves to ${currentDir} — run: harness knowledge migrate-store`;
      } else if (legacyExists && currentExists) {
        stranded = true;
        hint = `both a legacy path-keyed store and the remote-keyed store exist — reconcile manually (migrate-store will refuse a non-empty target); inspect ${legacyDir}`;
      }
    }
    checks.push({
      id: 'K4',
      name: 'Knowledge store not stranded behind a newly-added origin remote',
      pass: !stranded,
      hint,
      optional: true,
    });
  } catch {
    // Advisory; never fail doctor on a knowledge-check error.
  }

  // K5 (blueprint P6): a bucket whose branch no longer exists locally or on
  // any remote is an orphan — its work was merged, deleted, or abandoned;
  // the bucket sits as store growth until a human prunes it. Detached
  // buckets carry no branch to check and are aged out via prune --stale
  // instead. `branchExists` returning null means git state was unverifiable
  // — never reported as an orphan.
  try {
    const dir = storeDir(workspace);
    if (fs.existsSync(dir)) {
      const orphans = [];
      for (const bucket of listBuckets(dir)) {
        const branch = bucket.meta?.branch;
        if (!branch) continue;
        if (branchExists(workspace, branch) === false) orphans.push(bucket.key);
      }
      checks.push({
        id: 'K5',
        name: 'No orphan branch buckets (branch gone locally and on remotes)',
        pass: orphans.length === 0,
        hint: orphans.length
          ? `orphan bucket(s): ${orphans.join(', ')} — run: harness knowledge prune --branch <key> (or --merged/--stale)`
          : 'harness knowledge prune',
        optional: true,
      });
    }
  } catch {
    // Advisory; never fail doctor on a knowledge-check error.
  }

  // K6 (blueprint P6): layer misroute — bucket contents whose `branch:`
  // provenance disagrees with the bucket's own meta.json branch. A learning
  // carrying another branch's provenance inside this bucket means a write
  // was routed into the wrong layer (or a bucket dir was hand-moved).
  try {
    const dir = storeDir(workspace);
    if (fs.existsSync(dir)) {
      const misrouted = [];
      for (const bucket of listBuckets(dir)) {
        const metaBranch = bucket.meta?.branch;
        if (!metaBranch) continue;
        for (const l of listLearnings(bucket.dir)) {
          if (l.fm.branch && l.fm.branch !== metaBranch) misrouted.push(`${bucket.key}:${l.id}`);
        }
      }
      checks.push({
        id: 'K6',
        name: 'Bucket contents match their bucket branch (no layer misroute)',
        pass: misrouted.length === 0,
        hint: misrouted.length
          ? `misrouted learning(s): ${misrouted.slice(0, 5).join(', ')} — inspect the bucket, then knowledge prune or re-consolidate on the right branch`
          : 'inspect with harness knowledge status',
        optional: true,
      });
    }
  } catch {
    // Advisory; never fail doctor on a knowledge-check error.
  }

  // K7 (blueprint P1): the default branch drives write-layer routing; when it
  // is unresolvable (no store config.json defaultBranch, no origin/HEAD),
  // writes fail closed to branch-local — surfaced so a team can pin it.
  try {
    const dir = storeDir(workspace);
    if (fs.existsSync(dir)) {
      const context = deriveGitContext({ workspace });
      const unresolved = Boolean(context.branch) && !resolveDefaultBranch(workspace, {});
      checks.push({
        id: 'K7',
        name: 'Default branch resolvable for knowledge layer routing',
        pass: !unresolved,
        hint: 'set defaultBranch in the store config.json or run: git remote set-head origin -a — until then writes fail closed to branch-local',
        optional: true,
      });
    }
  } catch {
    // Advisory; never fail doctor on a knowledge-check error.
  }

  return checks;
}

// Structural-index health (blueprint P3, doctor S1). One check, five facts:
// grammar availability + integrity (BOTH the mismatch recorded at index time
// in meta.json AND the current on-disk wasm state via the sync grammarStatus
// probe), meta.sha drift vs HEAD, parse-failure rate, unreadable index tables,
// and orphaned cache entries. Binding blueprint rule: a grammar integrity
// mismatch — or an unreadable grammars.lock, which disables verification
// entirely — FAILS S1 (optional: false); the loud lexical fallback is a doctor
// failure, never a warning. A mismatch RECORDED in meta that the current wasm
// no longer has is stale, so it degrades to an advisory "re-run the index"
// instead of failing forever. Everything else about the optional tier stays
// advisory. The disk probe is scoped to the harness package's own node_modules
// and both it and the lock path are injectable, so S1 is never a verdict on an
// unrelated web-tree-sitter copy elsewhere on the filesystem (and the tests
// stay hermetic). Exported for direct testing, same as the check builders
// above are exercised through runDoctor.
export function structuralChecks({ workspace, grammarRoots = packageGrammarRoots(), lockPath } = {}) {
  const checks = [];
  try {
    // Scoped to the harness package's OWN node_modules: walking parent
    // node_modules made any unrelated web-tree-sitter anywhere up the
    // filesystem a hard doctor failure for a user who never built an index.
    const disk = grammarStatus({ grammarRoots, lockPath });
    const index = readStructuralIndex(workspace);
    const recorded = index?.meta?.integrityFailures || [];
    // A recorded mismatch the disk now verifies as good is STALE, not live:
    // the last build fell back, but the bytes are fixed — say "re-run", don't
    // keep failing forever on a record no rebuild ever clears.
    const stale = recorded.filter((f) => disk.grammars?.[f.language]?.ok === true);
    const live = recorded.filter((f) => !stale.includes(f));
    const mismatches = [...disk.integrityFailures, ...live];
    if (mismatches.length) {
      const languages = [...new Set(mismatches.map((f) => f.language))].join(', ');
      const lockGone = mismatches.some((f) => f.language === 'lock');
      checks.push({
        id: 'S1',
        name: 'Structural index grammar integrity',
        pass: false,
        hint: lockGone
          ? `grammars.lock missing or unreadable — wasm integrity cannot be verified and the treesitter tier is refused; reinstall the harness package, then re-run: harness index --structural`
          : `grammar wasm sha256 mismatch vs grammars.lock (${languages}) — the index fell back to lexical loudly; reinstall the harness optional dependencies, then re-run: harness index --structural`,
      });
      return checks;
    }
    if (!index) {
      checks.push({
        id: 'S1',
        name: 'Structural index (optional tier)',
        pass: true,
        optional: true,
        hint: 'not built — run: harness index --structural',
      });
      return checks;
    }
    const issues = [];
    if (stale.length) {
      const languages = [...new Set(stale.map((f) => f.language))].join(', ');
      issues.push(`index meta still records a grammar integrity mismatch (${languages}) that the current wasm no longer has — re-run: harness index --structural`);
    }
    // An existing-but-unreadable table (oversized past the fs-safe cap,
    // symlinked, corrupt JSON) used to read as empty everywhere. Say it.
    if (index.unreadable?.length) issues.push(`${index.unreadable.join('; ')} — delete the index directory and re-run: harness index --structural`);
    const head = spawnSync('git', ['-C', workspace, 'rev-parse', 'HEAD'], { encoding: 'utf8', timeout: 10_000 });
    const headSha = head.status === 0 ? head.stdout.trim() : null;
    if (index.meta.sha && headSha && index.meta.sha !== headSha) {
      issues.push('meta.sha behind HEAD — re-run: harness index --structural');
    }
    const filesIndexed = Math.max(index.meta.filesIndexed || Object.keys(index.files).length, 1);
    const failRate = (index.meta.parseFailures || 0) / filesIndexed;
    if (failRate > 0.2) issues.push(`parse-failure rate ${(failRate * 100).toFixed(0)}% — inspect grammar installation`);
    // Orphaned cache entries: indexed rels that no longer exist on disk.
    // files.json can be hand-edited, so each rel is containment-checked
    // before any stat — an escaping rel counts as an orphan, never a probe
    // outside the workspace.
    let orphans = 0;
    for (const rel of Object.keys(index.files).slice(0, 500)) {
      const full = assertNoSymlinkAncestors(workspace, rel);
      if (!full || !fs.existsSync(full)) orphans += 1;
    }
    if (orphans) issues.push(`${orphans} orphaned cache entries — pruned on the next harness index --structural`);
    checks.push({
      id: 'S1',
      name: 'Structural index health',
      pass: issues.length === 0,
      optional: true,
      hint: issues.length ? issues.join(' · ') : 'current with HEAD; grammars verified',
    });
  } catch {
    // Advisory; never fail doctor on a structural-check error.
  }

  return checks;
}

export async function runDoctor({ copilotHome, assetsRoot, pkgRoot, flags, vscodeSettingsPaths = null, workspace = flags.workspace }) {
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
  // Present AND current. Existence alone was not enough: the runner is
  // regenerated only by `init-repo` and by an `install`/`upgrade` run from
  // inside this workspace, so any other workspace can sit on a shim built by an
  // older harness indefinitely — and its owner has no reason to suspect it,
  // because upgrading the harness looks like it updated everything. A runner
  // carrying a fixed bug is worth as much as a missing one, so it fails the
  // same check with a hint that names the actual remedy.
  const runnerExists = fs.existsSync(runnerPath);
  let runnerCurrent = false;
  if (runnerExists) {
    try {
      runnerCurrent = fs.readFileSync(runnerPath, 'utf8').includes(`@harness-runner-version ${RUNNER_VERSION}`);
    } catch {
      // Unreadable — treat as not current; the hint's remedy rewrites it.
    }
  }
  checks.push({
    id: 'H13',
    name: 'Workspace harness runner',
    pass: runnerExists && runnerCurrent,
    hint: !runnerExists
      ? 'Run: harness init-repo'
      : runnerCurrent
        ? `.harness/run.mjs is current (v${RUNNER_VERSION})`
        : `.harness/run.mjs predates runner v${RUNNER_VERSION} — regenerate with: harness init-repo (or run harness upgrade from this workspace)`,
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

  checks.push(...knowledgeChecks({ workspace, copilotHome }));
  checks.push(...structuralChecks({ workspace }));

  if (flags.host === 'vscode') {
    checks.push(
      ...(await vscodeChecks({
        copilotHome,
        settingsPaths: vscodeSettingsPaths || resolveVSCodeSettingsPaths(),
      }))
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
