/**
 * Terminal-Bench verifier artifact reading.
 *
 * Harbor's verifier writes a numeric reward to `logs/verifier/reward.json`
 * (preferred) or `reward.txt` inside the trial's artifact tree. This module
 * reads that evidence without re-implementing the verifier: parse the reward,
 * grade it against the lock's passing threshold, pull pytest assertion counts
 * when a test log is present, and hash the artifact tree so a trial's end
 * state is auditable byte-for-byte.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/** Parse a reward artifact. Returns { reward, metrics } or null when unusable. */
export function parseReward(content, filename) {
  if (filename.endsWith('.json')) {
    let metrics;
    try {
      metrics = JSON.parse(content);
    } catch {
      return null;
    }
    if (!metrics || typeof metrics !== 'object') return null;
    if (typeof metrics.reward === 'number' && Number.isFinite(metrics.reward)) return { reward: metrics.reward, metrics };
    const numeric = Object.values(metrics).filter((v) => typeof v === 'number' && Number.isFinite(v));
    // A single numeric metric is unambiguous; anything else needs a human.
    return { reward: numeric.length === 1 ? numeric[0] : null, metrics };
  }
  const value = Number.parseFloat(String(content).trim());
  if (!Number.isFinite(value)) return null;
  return { reward: value, metrics: { reward: value } };
}

export function verdictFromReward(reward, { passingReward = 1 } = {}) {
  return typeof reward === 'number' && reward >= passingReward ? 'pass' : 'fail';
}

/** Extract assertion counts from a pytest summary line, if one exists. */
export function parsePytestSummary(text) {
  const passed = /(\d+) passed/.exec(text);
  const failed = /(\d+) failed/.exec(text);
  if (!passed && !failed) return null;
  return { passed: passed ? Number(passed[1]) : 0, failed: failed ? Number(failed[1]) : 0 };
}

function walkFiles(dir) {
  const out = [];
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile()) out.push(full);
    }
  }
  return out.sort();
}

/** sha256 over sorted relative paths + contents: the trial's end-state fingerprint. */
export function hashTree(dir) {
  const hash = crypto.createHash('sha256');
  for (const file of walkFiles(dir)) {
    hash.update(path.relative(dir, file));
    hash.update('\0');
    hash.update(fs.readFileSync(file));
    hash.update('\0');
  }
  return hash.digest('hex');
}

/**
 * Read a trial directory's verifier evidence: reward (reward.json preferred),
 * pytest assertion counts from any *.log/*.txt test output, and the artifact
 * tree hash. A missing reward stays null — it is never coerced to 0.
 */
export function collectVerifierEvidence(trialDir) {
  const files = walkFiles(trialDir);
  const rewardJson = files.find((f) => path.basename(f) === 'reward.json');
  const rewardTxt = files.find((f) => path.basename(f) === 'reward.txt');
  let reward = null;
  let rewardPath = null;
  let metrics = null;
  for (const candidate of [rewardJson, rewardTxt]) {
    if (!candidate) continue;
    const parsed = parseReward(fs.readFileSync(candidate, 'utf8'), path.basename(candidate));
    if (parsed) {
      reward = parsed.reward;
      metrics = parsed.metrics;
      rewardPath = candidate;
      break;
    }
  }
  let pytest = null;
  for (const file of files) {
    if (!/\.(log|txt|out)$/.test(file) || file === rewardTxt) continue;
    pytest = parsePytestSummary(fs.readFileSync(file, 'utf8'));
    if (pytest) break;
  }
  return { reward, rewardPath, metrics, pytest, treeHash: hashTree(trialDir) };
}
