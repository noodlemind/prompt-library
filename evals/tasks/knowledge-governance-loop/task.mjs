import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { applyOps } from '../../../packages/harness/lib/knowledge/apply.mjs';
import { consolidateCandidates } from '../../../packages/harness/lib/knowledge/consolidate.mjs';
import { setLearningStatus } from '../../../packages/harness/lib/knowledge/lifecycle.mjs';
import { rebuildStore } from '../../../packages/harness/lib/knowledge/admin.mjs';
import { runRemember } from '../../../packages/harness/lib/knowledge/remember.mjs';
import { storeDir, listLearnings, readGovernance, normalizeSlug } from '../../../packages/harness/lib/knowledge/store.mjs';

// Capability: human governance decisions survive a `consolidate --rebuild`
// regeneration. A retire recorded on a human-taught learning must (a) persist
// through a rebuild that wipes every learning, (b) be visible to the
// candidates packet as `governed`, (c) be REAPPLIED against a stale replay of
// the same (pre-retire) evidence with no fabricated confirm record, and (d)
// still yield to a genuinely FRESH human re-teach of the same trigger — the
// recency gate, not blanket immutability, is what governance enforces here.
export const meta = {
  id: 'knowledge-governance-loop',
  capability: 'human retire/confirm decisions survive rebuild and correctly gate stale vs fresh re-teaches',
  kind: 'deterministic',
  runtime: 'node',
  success: 'retire survives rebuild, the packet lists it governed, a stale replay is retired without a fabricated confirm, and a fresh re-teach overrides with a real confirm record',
};

// Fixed past date (not "yesterday") so the recency gate is exercised without
// any wall-clock-relative computation that could flake across midnight.
const STALE_DATE = '2020-01-01';
const DOMAIN = 'ops';
const TRIGGER = 'database migration lock timeout';

function writeStaleTeachingEpisode(ws) {
  const dir = path.join(ws, 'docs', 'solutions', 'teachings');
  fs.mkdirSync(dir, { recursive: true });
  const text = [
    '---',
    'title: "Stale db migration teaching"',
    'kind: human-teaching',
    `date: ${STALE_DATE}`,
    `trigger: "${TRIGGER}"`,
    '---',
    '',
    'Retry the migration with exponential backoff once a lock timeout is hit.',
    '',
  ].join('\n');
  const rel = 'docs/solutions/teachings/stale-db-migration.md';
  fs.writeFileSync(path.join(ws, rel), text, 'utf8');
  return { path: rel, sha256: crypto.createHash('sha256').update(text).digest('hex') };
}

export async function run() {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-eval-governance-loop-ws-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-eval-governance-loop-home-'));
  try {
    const domain = normalizeSlug(DOMAIN);
    const slug = normalizeSlug(TRIGGER);
    const learningId = `${domain}/${slug}`;

    // (a) Build the initial human-authored learning directly: a verified
    // human-teaching episode dated in the past (STALE_DATE), applied via a
    // plain ADD — applyOps derives source: human / status: active because
    // the episode's own on-disk frontmatter verifies as human-teaching.
    const staleEpisode = writeStaleTeachingEpisode(ws);
    const addOpsPath = path.join(ws, 'ops-add.json');
    fs.writeFileSync(
      addOpsPath,
      JSON.stringify({
        schema: 1,
        ops: [
          {
            op: 'ADD',
            domain: DOMAIN,
            slug: TRIGGER,
            trigger: TRIGGER,
            body: 'Retry the migration with exponential backoff once a lock timeout is hit.',
            episodes: [{ path: staleEpisode.path, sha256: staleEpisode.sha256, kind: 'human-teaching', plan: null }],
          },
        ],
      })
    );
    const added = applyOps({ workspace: ws, opsPath: addOpsPath, home });

    const dir = storeDir(ws, { home });
    const learningAfterAdd = listLearnings(dir).find((l) => l.id === learningId);

    // (b) A human retires it — governance record written, frontmatter flipped.
    const retired = setLearningStatus({ workspace: ws, id: learningId, action: 'retire', reason: 'no longer applicable', home });

    // (c) Regenerate: every learning is wiped, governance.jsonl survives.
    const rebuilt = rebuildStore({ workspace: ws, home, yes: true, copilotHome: ws });
    const learningsAfterRebuild = listLearnings(dir);
    const governanceAfterRebuild = readGovernance(dir);

    // (d) The candidates packet must list this id under `governed`.
    const packet = consolidateCandidates({ workspace: ws, copilotHome: ws, home });

    // (e) Replay the SAME (stale, pre-retire) episode via a fresh ADD — the
    // id no longer exists post-rebuild, so this is a plain ADD, not a
    // SUPERSEDE. Governance reapplication should retire it again with no
    // fabricated confirm, since the episode's date predates the retire.
    const replayOpsPath = path.join(ws, 'ops-replay.json');
    fs.writeFileSync(
      replayOpsPath,
      JSON.stringify({
        schema: 1,
        ops: [
          {
            op: 'ADD',
            domain: DOMAIN,
            slug: TRIGGER,
            trigger: TRIGGER,
            body: 'Retry the migration with exponential backoff once a lock timeout is hit.',
            episodes: [{ path: staleEpisode.path, sha256: staleEpisode.sha256, kind: 'human-teaching', plan: null }],
          },
        ],
      })
    );
    const replayed = applyOps({ workspace: ws, opsPath: replayOpsPath, home });
    const learningAfterReplay = listLearnings(dir).find((l) => l.id === learningId);
    const governanceAfterReplay = readGovernance(dir);

    // (f) A genuinely FRESH human re-teach (today-dated, via `remember`) of
    // the exact same trigger/domain overrides the retire — same-day evidence
    // ties favor the override, so this must land active/human with a real
    // confirm record appended (never overwriting the retire's own history).
    const reteach = runRemember({
      workspace: ws,
      copilotHome: ws,
      flags: { trigger: TRIGGER, domain: DOMAIN },
      argv: ['Retry the migration immediately with a fresh connection pool.'],
      home,
    });
    const learningAfterReteach = listLearnings(dir).find((l) => l.id === learningId);
    const governanceAfterReteach = readGovernance(dir);

    return {
      learningId,
      addedExitCode: added.exitCode,
      learningAfterAddSource: learningAfterAdd ? learningAfterAdd.fm.source : null,
      learningAfterAddStatus: learningAfterAdd ? learningAfterAdd.fm.status : null,
      retiredPass: retired.pass,
      rebuiltPass: rebuilt.pass,
      learningsAfterRebuildCount: learningsAfterRebuild.length,
      governanceAfterRebuildAction: governanceAfterRebuild.get(learningId)?.action || null,
      packetGoverned: packet.governed,
      replayedExitCode: replayed.exitCode,
      replayedGoverned: replayed.governed,
      learningAfterReplayStatus: learningAfterReplay ? learningAfterReplay.fm.status : null,
      governanceAfterReplayAction: governanceAfterReplay.get(learningId)?.action || null,
      reteachPass: reteach.pass,
      learningAfterReteachStatus: learningAfterReteach ? learningAfterReteach.fm.status : null,
      learningAfterReteachSource: learningAfterReteach ? learningAfterReteach.fm.source : null,
      governanceAfterReteachAction: governanceAfterReteach.get(learningId)?.action || null,
    };
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
}

const CHECKS = ['initialTeachingHumanActive', 'governanceSurvivedRebuild', 'packetListsGoverned', 'staleReplayRetired', 'noFabricatedConfirm', 'freshReteachOverrides'];

function evaluateChecks(result) {
  return {
    initialTeachingHumanActive: result.addedExitCode === 0 && result.learningAfterAddSource === 'human' && result.learningAfterAddStatus === 'active',
    governanceSurvivedRebuild:
      result.rebuiltPass === true && result.learningsAfterRebuildCount === 0 && result.governanceAfterRebuildAction === 'retire',
    packetListsGoverned: Array.isArray(result.packetGoverned) && result.packetGoverned.some((g) => g.id === result.learningId && g.action === 'retire'),
    staleReplayRetired:
      result.replayedExitCode === 0 &&
      Array.isArray(result.replayedGoverned) &&
      result.replayedGoverned.some((g) => g.id === result.learningId && g.action === 'retire') &&
      result.learningAfterReplayStatus === 'retired',
    noFabricatedConfirm: result.governanceAfterReplayAction === 'retire',
    freshReteachOverrides:
      result.reteachPass === true &&
      result.learningAfterReteachStatus === 'active' &&
      result.learningAfterReteachSource === 'human' &&
      result.governanceAfterReteachAction === 'confirm',
  };
}

export async function grade(result) {
  const checks = evaluateChecks(result);
  const failed = CHECKS.filter((k) => checks[k] !== true);
  return {
    verdict: failed.length === 0 ? 'pass' : 'fail',
    reason:
      failed.length === 0
        ? 'retire survived rebuild, the packet listed it governed, a stale replay was retired with no fabricated confirm, and a fresh re-teach overrode with a real confirm record'
        : `failed checks: ${failed.join(', ')}`,
    evidence: { result, checks },
  };
}

// Verifier fixtures: pre-shaped result objects whose derived checks pass/fail
// per evaluateChecks above — matches the runner contract (evals/lib/runner.mjs:53).
export const fixtures = {
  pass: {
    learningId: 'ops/database-migration-lock-timeout',
    addedExitCode: 0,
    learningAfterAddSource: 'human',
    learningAfterAddStatus: 'active',
    retiredPass: true,
    rebuiltPass: true,
    learningsAfterRebuildCount: 0,
    governanceAfterRebuildAction: 'retire',
    packetGoverned: [{ id: 'ops/database-migration-lock-timeout', action: 'retire' }],
    replayedExitCode: 0,
    replayedGoverned: [{ id: 'ops/database-migration-lock-timeout', action: 'retire' }],
    learningAfterReplayStatus: 'retired',
    governanceAfterReplayAction: 'retire',
    reteachPass: true,
    learningAfterReteachStatus: 'active',
    learningAfterReteachSource: 'human',
    governanceAfterReteachAction: 'confirm',
  },
  fail: {
    learningId: 'ops/database-migration-lock-timeout',
    addedExitCode: 0,
    learningAfterAddSource: 'human',
    learningAfterAddStatus: 'active',
    retiredPass: true,
    rebuiltPass: true,
    learningsAfterRebuildCount: 0,
    governanceAfterRebuildAction: 'retire',
    packetGoverned: [{ id: 'ops/database-migration-lock-timeout', action: 'retire' }],
    replayedExitCode: 0,
    replayedGoverned: [{ id: 'ops/database-migration-lock-timeout', action: 'retire' }],
    learningAfterReplayStatus: 'retired',
    governanceAfterReplayAction: 'confirm',
    reteachPass: true,
    learningAfterReteachStatus: 'active',
    learningAfterReteachSource: 'human',
    governanceAfterReteachAction: 'confirm',
  },
};
