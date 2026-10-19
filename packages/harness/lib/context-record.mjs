import crypto from 'node:crypto';
import { captureWorkingSources, readSourceFile } from './repo-map/working-sources.mjs';
import { MAX_FILES_SCANNED, MAX_FILE_BYTES } from './repo-map/scan.mjs';
import { planDigest } from './evidence.mjs';
import { worktreeId } from './structural/shape.mjs';
import { loadPlan } from './plan-parse.mjs';
import { accountContext } from './token-meter.mjs';
import { policyDigest } from './trust.mjs';

const EVIDENCE_LIMIT = 80;
const digest = (value) => crypto.createHash('sha256').update(value).digest('hex');

export function buildContextRecord({ workspace, flags = {}, query = '', facts }) {
  const snapshot = facts.sourceSnapshot || captureWorkingSources(workspace);
  const neighborhood = facts.slice.neighborhood;
  const selected = new Set(neighborhood?.requested || facts.namedFiles);
  const paths = [...new Set([...(neighborhood?.inputs || facts.namedFiles.map(rel => ({ rel }))).map(input => input.rel), ...(neighborhood?.files || []).map(file => file.rel)])];
  const evidence = paths.slice(0, EVIDENCE_LIMIT).map((location) => {
    const input = readSourceFile(workspace, location);
    return {
      source: 'code', location, state: input.state,
      sha256: input.hash || null, bytes: input.size ?? null,
      reason: selected.has(location) ? 'declared task file' : 'import neighborhood',
      reference: input.hash ? `${location}@sha256:${input.hash}` : null,
    };
  });
  const identity = {
    schema: 'harness.context.v2',
    worktree: worktreeId(workspace),
    task: { plan: facts.active?.path || null, contractDigest: facts.active ? planDigest(facts.active.text) : null },
    selection: { queryHash: digest(facts.query ?? query), files: facts.namedFiles },
    sourceState: snapshot.state || null,
    policyDigest: facts.slice.trust.digest || null,
    evidence,
  };
  const after = captureWorkingSources(workspace);
  const factHashes = new Map((facts.slice.neighborhood?.files || []).filter(file => file.sha256).map(file => [file.rel, file.sha256]));
  const currentPlan = facts.active ? loadPlan(workspace, facts.active.path) : null;
  const planChanged = facts.active && (!currentPlan || planDigest(currentPlan.text) !== identity.task.contractDigest);
  const changed = Boolean(planChanged || policyDigest(workspace) !== identity.policyDigest || !snapshot.valid || !after.valid || snapshot.state.digest !== after.state.digest || evidence.some((record) =>
    (record.sha256 && readSourceFile(workspace, record.location).hash !== record.sha256) ||
    (factHashes.has(record.location) && factHashes.get(record.location) !== record.sha256)));
  const stableFacts = { ...facts.slice, trust: { state: facts.slice.trust.state, digest: facts.slice.trust.digest } };
  return {
    ...identity,
    contextId: digest(JSON.stringify({ ...identity, facts: stableFacts })),
    slice: facts.slice,
    coverage: {
      sourceState: changed ? 'changed-or-unavailable' : 'validated',
      semanticCompleteness: 'unverified',
      failures: facts.failures,
      scan: { maxFiles: MAX_FILES_SCANNED, maxFileBytes: MAX_FILE_BYTES, total: snapshot.state?.total ?? null, truncated: snapshot.state?.truncated ?? null },
      evidenceOmitted: Math.max(0, paths.length - EVIDENCE_LIMIT),
      unavailable: evidence.filter((record) => record.state !== 'readable'),
      scanOmissions: snapshot.state?.omitted || [],
      limitations: ['Import relationships are heuristic and limited to one hop.', 'Unsaved editor buffers are unavailable through filesystem reads.'],
    },
    expansion: { command: 'harness orient --read --context-version 2', sourceChanged: changed },
    accounting: accountContext({ boundary: 'orientation-output', components: [{ category: 'evidence', id: 'orientation-facts', content: facts.slice }] }),
  };
}
