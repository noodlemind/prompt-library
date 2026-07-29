import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { applyOps, rebuildIndex } from '../../../packages/harness/lib/knowledge/apply.mjs';
import { consolidateStatus, consolidateCandidates } from '../../../packages/harness/lib/knowledge/consolidate.mjs';
import { runInsightCompound } from '../../../packages/harness/lib/compound.mjs';
import { storeDir, listLearnings, ensureStore, writeStoreConfig, serializeLearning } from '../../../packages/harness/lib/knowledge/store.mjs';

// Capability: the mechanical safety gates that bound the knowledge layer's
// writes — a `suggest`-mode run blocks until approved, three byte-cap
// rejections on the same episode quarantine it out of both debt and future
// candidate clusters, a domain at its active-learning cap rejects a plain ADD
// outright, and a secret-shaped capture is blocked before any file is
// written. Four independent scenarios, each in its own hermetic workspace.
export const meta = {
  id: 'knowledge-safety-gates',
  capability: 'suggest-mode approval, three-strike quarantine, domain cap, and secret-shaped capture are all enforced',
  kind: 'deterministic',
  runtime: 'node',
  success: 'suggest mode blocks without approve and applies with it, three byte-cap failures quarantine an episode out of debt/candidates, a 26th domain ADD is rejected at cap, and a secret-shaped capture writes nothing',
};

function writeEpisode(ws, category, slug, body = 'Fixture episode body.') {
  const dir = path.join(ws, 'docs', 'solutions', category);
  fs.mkdirSync(dir, { recursive: true });
  const text = `---\ntitle: "${slug}"\ndate: 2026-02-01\n---\n\n${body}\n`;
  fs.writeFileSync(path.join(dir, `${slug}.md`), text, 'utf8');
  return { path: `docs/solutions/${category}/${slug}.md`, sha256: crypto.createHash('sha256').update(text).digest('hex') };
}

function writeOps(ws, name, ops) {
  const opsPath = path.join(ws, `${name}.json`);
  fs.writeFileSync(opsPath, JSON.stringify({ schema: 1, ops }), 'utf8');
  return opsPath;
}

// (a) knowledge suggest mode: applyOps blocked without approve, applied with it.
function runSuggestGate() {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-eval-safety-suggest-ws-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-eval-safety-suggest-home-'));
  try {
    const episode = writeEpisode(ws, 'gate', 'suggest-ep');
    writeStoreConfig(ws, { home, mode: 'suggest' });
    const opsPath = writeOps(ws, 'ops-suggest', [
      { op: 'ADD', domain: 'gate', slug: 'suggest-test', trigger: 'suggest gate trigger', body: 'Body text for the suggest gate test.', episodes: [{ path: episode.path, sha256: episode.sha256, kind: 'fix', plan: null }] },
    ]);
    const dir = storeDir(ws, { home });

    const noApprove = applyOps({ workspace: ws, opsPath, home });
    const learningAfterNoApprove = fs.existsSync(dir) ? listLearnings(dir).find((l) => l.id === 'gate/suggest-test') : null;

    const withApprove = applyOps({ workspace: ws, opsPath, home, approve: true });
    const learningAfterApprove = listLearnings(dir).find((l) => l.id === 'gate/suggest-test');

    return {
      noApproveExitCode: noApprove.exitCode,
      noApproveRejectedCode: noApprove.rejected?.[0]?.code || null,
      learningAbsentBeforeApprove: !learningAfterNoApprove,
      withApproveExitCode: withApprove.exitCode,
      learningPresentAfterApprove: !!learningAfterApprove,
    };
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
}

// (b) three byte-cap-violating applies against ONE episode -> quarantine.
function runQuarantineGate() {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-eval-safety-quarantine-ws-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-eval-safety-quarantine-home-'));
  try {
    const episode = writeEpisode(ws, 'quarantine', 'big-ep');
    const hugeBody = 'x'.repeat(2000);
    let last;
    for (let i = 0; i < 3; i++) {
      const opsPath = writeOps(ws, `ops-byte-${i}`, [
        { op: 'ADD', domain: 'quarantine', slug: `attempt-${i}`, trigger: `byte cap attempt ${i}`, body: hugeBody, episodes: [{ path: episode.path, sha256: episode.sha256, kind: 'fix', plan: null }] },
      ]);
      last = applyOps({ workspace: ws, opsPath, home });
    }
    const status = consolidateStatus({ workspace: ws, copilotHome: ws, home });
    const candidates = consolidateCandidates({ workspace: ws, copilotHome: ws, home });
    const clusterEpisodes = candidates.clusters.flatMap((c) => c.episodes);
    return {
      lastRejectedCode: last.rejected?.[0]?.code || null,
      quarantined: status.quarantined.some((q) => q.path === episode.path && q.sha256 === episode.sha256),
      debtAfter: status.debt,
      clusterStillCitesEpisode: clusterEpisodes.some((e) => e.path === episode.path && e.sha256 === episode.sha256),
    };
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
}

// (c) fill a domain to the 25-active cap, then a 26th ADD is rejected.
function runDomainCapGate() {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-eval-safety-cap-ws-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-eval-safety-cap-home-'));
  try {
    const { dir } = ensureStore(ws, { home });
    const domainDir = path.join(dir, 'learnings', 'capdomain');
    fs.mkdirSync(domainDir, { recursive: true });
    for (let i = 1; i <= 25; i++) {
      const fm = { trigger: `cap trigger ${i}`, status: 'active', source: 'auto', episodes: [], anchors: [], superseded_by: null, last_confirmed: null, origin: 'fixture' };
      fs.writeFileSync(path.join(domainDir, `slug-${i}.md`), serializeLearning(fm, `Learning body ${i}.`), 'utf8');
    }
    rebuildIndex(dir);
    const countBefore = listLearnings(dir).filter((l) => l.domain === 'capdomain').length;

    const episode = writeEpisode(ws, 'cap', 'ep-26');
    const opsPath = writeOps(ws, 'ops-cap-26', [
      { op: 'ADD', domain: 'capdomain', slug: 'slug-26', trigger: 'cap trigger 26', body: 'Learning body 26.', episodes: [{ path: episode.path, sha256: episode.sha256, kind: 'fix', plan: null }] },
    ]);
    const result26 = applyOps({ workspace: ws, opsPath, home });
    const countAfter = listLearnings(dir).filter((l) => l.domain === 'capdomain').length;

    return {
      countBefore,
      rejectedCode: result26.rejected?.[0]?.code || null,
      countAfter,
    };
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
}

// (d) compound --insight with secret-shaped body -> blocked, no episode file.
function runSecretGate() {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-eval-safety-secret-ws-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-eval-safety-secret-home-'));
  try {
    const result = runInsightCompound({
      workspace: ws,
      copilotHome: ws,
      flags: { title: 'Leaked credential', body: 'Found AWS key AKIAABCDEFGHIJKLMNOP hardcoded in the logs.', category: 'incidents' },
      home,
    });
    const dir = path.join(ws, 'docs', 'solutions', 'incidents');
    const filesWritten = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.md')) : [];
    return {
      pass: result.pass,
      exitCode: result.exitCode,
      path: result.path,
      noFilesWritten: filesWritten.length === 0,
    };
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
}

export async function run() {
  const suggestGate = runSuggestGate();
  const quarantineGate = runQuarantineGate();
  const domainCapGate = runDomainCapGate();
  const secretGate = runSecretGate();
  return { suggestGate, quarantineGate, domainCapGate, secretGate };
}

const CHECKS = ['suggestBlocks', 'approveApplies', 'quarantinedAfterThree', 'quarantineExcludedFromDebt', 'capRejects26', 'secretBlocked'];

function evaluateChecks(result) {
  const { suggestGate, quarantineGate, domainCapGate, secretGate } = result;
  return {
    suggestBlocks: suggestGate.noApproveExitCode !== 0 && suggestGate.noApproveRejectedCode === 'E_MODE' && suggestGate.learningAbsentBeforeApprove === true,
    approveApplies: suggestGate.withApproveExitCode === 0 && suggestGate.learningPresentAfterApprove === true,
    quarantinedAfterThree: quarantineGate.lastRejectedCode === 'E_BYTE_CAP' && quarantineGate.quarantined === true,
    quarantineExcludedFromDebt: quarantineGate.debtAfter === 0 && quarantineGate.clusterStillCitesEpisode === false,
    capRejects26: domainCapGate.countBefore === 25 && domainCapGate.rejectedCode === 'E_DOMAIN_CAP' && domainCapGate.countAfter === 25,
    secretBlocked: secretGate.pass === false && secretGate.path === null && secretGate.noFilesWritten === true,
  };
}

export async function grade(result) {
  const checks = evaluateChecks(result);
  const failed = CHECKS.filter((k) => checks[k] !== true);
  return {
    verdict: failed.length === 0 ? 'pass' : 'fail',
    reason:
      failed.length === 0
        ? 'suggest mode gated on approve, three byte-cap failures quarantined the episode out of debt/candidates, a 26th domain ADD was capped, and a secret-shaped capture wrote nothing'
        : `failed checks: ${failed.join(', ')}`,
    evidence: { result, checks },
  };
}

// Verifier fixtures: pre-shaped result objects whose derived checks pass/fail
// per evaluateChecks above — matches the runner contract (evals/lib/runner.mjs:53).
export const fixtures = {
  pass: {
    suggestGate: { noApproveExitCode: 2, noApproveRejectedCode: 'E_MODE', learningAbsentBeforeApprove: true, withApproveExitCode: 0, learningPresentAfterApprove: true },
    quarantineGate: { lastRejectedCode: 'E_BYTE_CAP', quarantined: true, debtAfter: 0, clusterStillCitesEpisode: false },
    domainCapGate: { countBefore: 25, rejectedCode: 'E_DOMAIN_CAP', countAfter: 25 },
    secretGate: { pass: false, exitCode: 1, path: null, noFilesWritten: true },
  },
  fail: {
    suggestGate: { noApproveExitCode: 2, noApproveRejectedCode: 'E_MODE', learningAbsentBeforeApprove: true, withApproveExitCode: 0, learningPresentAfterApprove: true },
    quarantineGate: { lastRejectedCode: 'E_BYTE_CAP', quarantined: true, debtAfter: 0, clusterStillCitesEpisode: false },
    domainCapGate: { countBefore: 25, rejectedCode: 'E_DOMAIN_CAP', countAfter: 26 },
    secretGate: { pass: false, exitCode: 1, path: null, noFilesWritten: true },
  },
};
