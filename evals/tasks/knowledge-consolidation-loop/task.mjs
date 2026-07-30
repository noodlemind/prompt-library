import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { applyOps } from '../../../packages/harness/lib/knowledge/apply.mjs';
import { consolidateStatus, consolidateCandidates } from '../../../packages/harness/lib/knowledge/consolidate.mjs';
import { rankLearnings } from '../../../packages/harness/lib/knowledge/retrieve.mjs';
import { storeDir, listLearnings } from '../../../packages/harness/lib/knowledge/store.mjs';

// Capability: the heart of the knowledge layer end to end — five dated fix
// episodes accrue to consolidation debt, `consolidate --candidates` clusters
// them under the real write contract, a packet-faithful ADD ops file (path/
// sha256/kind copied verbatim from the packet — never re-derived) applies
// through the sole writer, the fresh learning is retrievable for a
// trigger-matching query, and debt returns to zero.
export const meta = {
  id: 'knowledge-consolidation-loop',
  capability: 'consolidation turns episode debt into a retrievable learning end to end',
  kind: 'deterministic',
  runtime: 'node',
  success: 'debt hits threshold, the candidates packet clusters every episode, a packet-faithful ADD applies as provisional/auto and clears debt, and rankLearnings surfaces it',
};

const TRIGGER = 'auth token refresh race condition';
const TITLES = [
  'Auth token refresh race condition',
  'Auth token refresh double request bug',
  'Auth token refresh retry storm',
  'Auth token refresh deadlock under load',
  'Auth token refresh silent failure',
];

function writeEpisode(ws, category, slug, { title, tags = [], date }) {
  const dir = path.join(ws, 'docs', 'solutions', category);
  fs.mkdirSync(dir, { recursive: true });
  const lines = ['---', `title: "${title}"`];
  if (tags.length) lines.push(`tags: ${tags.join(', ')}`);
  if (date) lines.push(`date: ${date}`);
  lines.push('---', '', '## Problem', '', `${title} details.`, '');
  const text = lines.join('\n');
  fs.writeFileSync(path.join(dir, `${slug}.md`), text, 'utf8');
  return {
    path: `docs/solutions/${category}/${slug}.md`,
    sha256: crypto.createHash('sha256').update(text).digest('hex'),
  };
}

export async function run() {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-eval-consolidation-loop-ws-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-eval-consolidation-loop-home-'));
  try {
    TITLES.forEach((title, i) => {
      writeEpisode(ws, 'auth', `auth-${i + 1}`, { title, tags: ['auth', 'token', 'refresh'], date: `2026-01-0${i + 1}` });
    });

    const statusBefore = consolidateStatus({ workspace: ws, copilotHome: ws, home });

    const packet = consolidateCandidates({ workspace: ws, copilotHome: ws, home });
    const cluster = packet.clusters.find((c) => c.id === 'auth');
    const clusterEpisodeCount = cluster ? cluster.episodes.length : 0;

    const learningId = 'auth/token-refresh-race';
    const opsPath = path.join(ws, 'ops.json');
    fs.writeFileSync(
      opsPath,
      JSON.stringify({
        schema: 1,
        ops: [
          {
            op: 'ADD',
            domain: 'auth',
            slug: 'token-refresh-race',
            trigger: TRIGGER,
            body: 'Serialize refresh calls behind a per-session lock so concurrent requests never double-refresh.',
            // Packet fidelity: path/sha256/kind copied verbatim from the packet's
            // own cluster episodes — never re-derived from the source files.
            episodes: cluster ? cluster.episodes.map((e) => ({ path: e.path, sha256: e.sha256, kind: e.kind, plan: null })) : [],
          },
        ],
      })
    );

    const applied = applyOps({ workspace: ws, opsPath, home });

    const dir = storeDir(ws, { home });
    const learning = applied.exitCode === 0 ? listLearnings(dir).find((l) => l.id === learningId) : null;

    const surfaced = rankLearnings({ workspace: ws, query: TRIGGER, limit: 3, home });

    const statusAfter = consolidateStatus({ workspace: ws, copilotHome: ws, home });

    return {
      debtBefore: statusBefore.debt,
      due: statusBefore.due,
      clusterEpisodeCount,
      appliedExitCode: applied.exitCode,
      appliedOps: applied.applied,
      learningStatus: learning ? learning.fm.status : null,
      learningSource: learning ? learning.fm.source : null,
      surfacedTop1: surfaced[0] ? surfaced[0].id : null,
      debtAfter: statusAfter.debt,
    };
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
}

const CHECKS = ['debtBeforeIsFive', 'due', 'clustersCoverEpisodes', 'applied', 'learningProvisionalAuto', 'surfacedTop1Match', 'debtAfterIsZero'];

function evaluateChecks(result) {
  return {
    debtBeforeIsFive: result.debtBefore === 5,
    due: result.due === true,
    clustersCoverEpisodes: result.clusterEpisodeCount === 5,
    applied: result.appliedExitCode === 0 && Array.isArray(result.appliedOps) && result.appliedOps.some((a) => a.op === 'ADD'),
    learningProvisionalAuto: result.learningStatus === 'provisional' && result.learningSource === 'auto',
    surfacedTop1Match: result.surfacedTop1 === 'auth/token-refresh-race',
    debtAfterIsZero: result.debtAfter === 0,
  };
}

export async function grade(result) {
  const checks = evaluateChecks(result);
  const failed = CHECKS.filter((k) => checks[k] !== true);
  return {
    verdict: failed.length === 0 ? 'pass' : 'fail',
    reason:
      failed.length === 0
        ? 'debt accrued to 5, the packet clustered every episode, a packet-faithful ADD applied provisional/auto and cleared debt, and rankLearnings surfaced it'
        : `failed checks: ${failed.join(', ')}`,
    evidence: { result, checks },
  };
}

// Verifier fixtures: pre-shaped result objects (not run() output) whose derived
// checks pass/fail per evaluateChecks above — matches the runner contract
// (evals/lib/runner.mjs:53).
export const fixtures = {
  pass: {
    debtBefore: 5,
    due: true,
    clusterEpisodeCount: 5,
    appliedExitCode: 0,
    appliedOps: [{ op: 'ADD', id: 'auth/token-refresh-race' }],
    learningStatus: 'provisional',
    learningSource: 'auto',
    surfacedTop1: 'auth/token-refresh-race',
    debtAfter: 0,
  },
  fail: {
    debtBefore: 5,
    due: true,
    clusterEpisodeCount: 5,
    appliedExitCode: 0,
    appliedOps: [{ op: 'ADD', id: 'auth/token-refresh-race' }],
    learningStatus: 'provisional',
    learningSource: 'auto',
    surfacedTop1: 'auth/token-refresh-race',
    debtAfter: 3,
  },
};
