import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { buildChangeImpactContext } from '../../lib/change-impact.mjs';
import { queryGraph } from '../../lib/graph.mjs';
import { buildStructuralIndex, readStructuralIndex } from '../../lib/repo-map/structural-index.mjs';
import { createTreesitterExtract } from '../../lib/repo-map/treesitter-extractor.mjs';
import { sourceHash } from '../../lib/retrieval/source-evidence.mjs';
import { resolveStudyOutput } from './study.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const checkout = path.resolve(here, '../../../..');
const catalogBytes = fs.readFileSync(path.join(here, 'structural-cases.json'));
export const structuralCases = JSON.parse(catalogBytes).cases;
const packageRoot = path.resolve(here, '../..');
const PRODUCER_DIRECTORIES = ['lib', 'corpus', 'config', 'eval/context'];
const PRODUCER_FILES = ['package.json', 'package-lock.json'];
const MAX_PRODUCER_FILES = 20_000;
const MAX_PRODUCER_BYTES = 256 * 1024 * 1024;

function git(workspace, args) {
  const result = spawnSync('git', args, { cwd: workspace, encoding: 'utf8', timeout: 15_000,
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
      GIT_AUTHOR_NAME: 'Structural qualification', GIT_AUTHOR_EMAIL: 'qualification@example.invalid',
      GIT_COMMITTER_NAME: 'Structural qualification', GIT_COMMITTER_EMAIL: 'qualification@example.invalid' } });
  if (result.error || result.status !== 0) throw new Error(`fixture git operation failed: ${result.error?.code || result.stderr?.slice(0, 300)}`);
  return result.stdout.trim();
}

function target(workspace, relative) {
  if (typeof relative !== 'string' || !relative || relative.includes('\0') || path.isAbsolute(relative)) throw new Error('fixture path must be relative');
  const full = path.resolve(workspace, relative);
  const rel = path.relative(workspace, full);
  if (!rel || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel) || rel.split(path.sep).includes('.git')) throw new Error('unsafe fixture path');
  return full;
}

function write(workspace, relative, content) {
  const full = target(workspace, relative);
  if (typeof content !== 'string') throw new Error('fixture source must be a string');
  fs.mkdirSync(path.dirname(full), { recursive: true }); fs.writeFileSync(full, content);
}

/** Identity for the complete owned implementation, including added helpers,
 * schemas, evaluation protocol and actual vendored loader/grammar bytes.
 * Missing optional directories are inputs too; symlinks are never followed. */
export function captureStructuralProducer({ packageRoot: root = packageRoot, expected = null } = {}) {
  root = path.resolve(root);
  const files = [];
  let totalBytes = 0, valid = true;
  const add = row => {
    if (files.length >= MAX_PRODUCER_FILES) throw new Error('producer input inventory exceeds its file bound');
    files.push(row);
  };
  const visit = relative => {
    const full = path.join(root, relative);
    let stat;
    try { stat = fs.lstatSync(full); }
    catch (error) {
      if (error.code === 'ENOENT') add({ path: relative, state: 'missing' });
      else { valid = false; add({ path: relative, state: 'unreadable' }); }
      return;
    }
    if (stat.isSymbolicLink() || !stat.isFile() && !stat.isDirectory()) {
      valid = false; add({ path: relative, state: 'unsafe' }); return;
    }
    if (stat.isDirectory()) {
      let entries;
      try { entries = fs.readdirSync(full).sort(); }
      catch { valid = false; add({ path: relative, state: 'unreadable' }); return; }
      if (!entries.length) add({ path: `${relative}/`, state: 'empty-directory' });
      for (const entry of entries) visit(`${relative}/${entry}`);
      return;
    }
    totalBytes += stat.size;
    if (totalBytes > MAX_PRODUCER_BYTES) throw new Error('producer input bytes exceed their bound');
    try {
      const bytes = fs.readFileSync(full);
      add({ path: relative, state: 'readable', bytes: bytes.length, sha256: sourceHash(bytes) });
    } catch { valid = false; add({ path: relative, state: 'unreadable' }); }
  };
  for (const relative of [...PRODUCER_DIRECTORIES, ...PRODUCER_FILES]) visit(relative);
  files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const runtime = { node: process.version, platform: process.platform, arch: process.arch, versions: { ...process.versions } };
  const digest = sourceHash(JSON.stringify({ schema: 1, files, runtime }));
  return { schema: 1, digest, valid, current: expected === null ? null : valid && digest === expected, files, runtime };
}

function normalized(value) {
  if (Array.isArray(value)) return value.map(normalized);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, normalized(item)]));
  return value;
}

export async function runStructuralStudy({ root, cases = structuralCases } = {}) {
  if (!Array.isArray(cases) || !cases.length) throw new Error('structural study requires a nonempty fixture selection');
  const output = resolveStudyOutput({ checkout, output: root });
  fs.mkdirSync(output);
  fs.mkdirSync(path.join(output, 'packets'));
  const producer = captureStructuralProducer();
  const sourceDigest = producer.digest;
  const sourceCommit = git(checkout, ['rev-parse', 'HEAD']);
  const sourceDirty = Boolean(git(checkout, ['status', '--porcelain']));
  const extractor = await createTreesitterExtract();
  const attempts = [];
  for (const task of cases) {
    if (!/^[a-z0-9-]+$/.test(task.id || '') || attempts.some(row => row.id === task.id)) throw new Error('fixture IDs must be unique lowercase names');
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'ae-structural-study-'));
    const workspace = path.join(temporary, 'workspace'), home = path.join(temporary, 'home'), cleanHome = path.join(temporary, 'clean-home'), copilotHome = path.join(temporary, 'copilot');
    fs.mkdirSync(workspace); fs.mkdirSync(copilotHome);
    const row = { id: task.id, language: task.language, split: task.split, family: task.family, kind: 'mechanical', pass: false,
      assertions: 0, incrementalEquivalent: null, packetReference: null, fixtureHash: sourceHash(JSON.stringify(task)), error: null };
    const check = (condition, message) => { row.assertions++; assert.ok(condition, message); };
    try {
      for (const [relative, content] of Object.entries(task.files || {})) write(workspace, relative, content);
      git(workspace, ['init', '-q']); git(workspace, ['add', '.']); git(workspace, ['commit', '-qm', 'frozen fixture']);
      await buildStructuralIndex({ workspace, home, extractor });
      const initial = readStructuralIndex(workspace, { home });
      check(Boolean(initial?.generation && !initial.unreadable.length), 'initial structural snapshot must be readable');
      for (const mutation of task.mutations || []) {
        if (mutation.delete) fs.rmSync(target(workspace, mutation.path));
        else write(workspace, mutation.path, mutation.content);
      }
      if (task.mutations?.length) {
        git(workspace, ['add', '.']);
        await buildStructuralIndex({ workspace, home, extractor });
        await buildStructuralIndex({ workspace, home: cleanHome, extractor });
        const incremental = readStructuralIndex(workspace, { home }), clean = readStructuralIndex(workspace, { home: cleanHome });
        row.assertions++;
        assert.deepEqual(normalized(incremental.graph), normalized(clean.graph), 'incremental relationships must equal a clean rebuild');
        row.incrementalEquivalent = true;
      }
      const packet = buildChangeImpactContext({ workspace, copilotHome, home, query: task.query, files: task.seeds,
        questionKind: task.questionKind, depth: task.depth || 3 });
      const edges = packet.graphs.flatMap(graph => graph.edges || []);
      check(packet.authority === 'descriptive-context', 'packet must retain descriptive authority');
      check(packet.coverage.semanticCompleteness === 'unverified', 'packet cannot assert semantic completeness');
      check(Buffer.byteLength(JSON.stringify(packet)) <= packet.coverage.maxBytes, 'whole packet must fit its byte budget');
      check(!Object.hasOwn(packet, 'requiredChecks'), 'impact suggestions cannot select required verification');
      for (const file of task.requiredSources || []) check(packet.sources.some(source => source.location === file), `required source missing: ${file}`);
      for (const [from, to] of task.expectedEdges || []) check(edges.some(edge => edge.from === from && edge.to === to), `expected relationship missing: ${from} -> ${to}`);
      for (const [from, to] of task.forbiddenEdges || []) {
        const direct = queryGraph({ workspace, home, operation: 'path', files: [from, to], depth: 1, limit: 200 });
        check(!direct.edges.some(edge => edge.from === from && edge.to === to), `forbidden relationship observed: ${from} -> ${to}`);
      }
      for (const kind of task.requiredGaps || []) check(packet.gaps.some(gap => gap.kind === kind), `required uncertainty gap missing: ${kind}`);
      for (const source of packet.sources) {
        check(sourceHash(fs.readFileSync(target(workspace, source.location))) === source.sha256, 'source identity must match captured bytes');
        check(sourceHash(source.excerpt) === source.evidence.representationSha256, 'excerpt identity must match exactly');
      }
      row.packetReference = `packets/${task.id}.json`;
      fs.writeFileSync(path.join(output, row.packetReference), JSON.stringify(packet, null, 2) + '\n');
      row.pass = true;
    } catch (error) { row.error = error.message; }
    finally { fs.rmSync(temporary, { recursive: true, force: true }); }
    attempts.push(row);
  }
  const result = { schema: 1, kind: 'mechanical', model: null, usage: null,
    provenance: { sourceCommit, sourceDirty, sourceDigest,
      sourceStable: producer.valid && captureStructuralProducer({ expected: sourceDigest }).current,
      producer, fixtureHash: sourceHash(JSON.stringify(cases)), catalogHash: sourceHash(catalogBytes), node: process.version },
    attempts,
    summary: { total: attempts.length, passed: attempts.filter(row => row.pass).length, failed: attempts.filter(row => !row.pass).length,
      heldOutCases: attempts.filter(row => row.split === 'held-out').length, promotionEligible: false,
      limitation: 'Mechanical packet and extraction assertions only. No model outcome, runtime correspondence, productivity, token reduction or default-policy promotion is established.' } };
  fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify(result, null, 2) + '\n');
  return result;
}
