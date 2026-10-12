import path from 'node:path';
import fs from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { readFileNoFollow, writeFileContained, assertNoSymlinkAncestors } from './fs-safe.mjs';
import { createRedactor } from './redact.mjs';
import { ensureHarnessDir } from './session.mjs';

const PREFIX = '.harness/evidence/check-artifacts/';
const MAX_BYTES = 1024 * 1024;
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

export function artifactPathsProblem(paths) {
  if (paths === undefined) return null;
  if (!Array.isArray(paths) || !paths.length || paths.length > 16 || new Set(paths).size !== paths.length) return 'artifacts must contain 1 to 16 unique JSON paths';
  if (paths.some(value => typeof value !== 'string' || value.length > 512 || createRedactor().redactText(value) !== value || !value.endsWith('.json')
    || /[\\:\x00-\x1f]/.test(value) || path.posix.isAbsolute(value)
    || value.split('/').some(part => !part || part === '.' || part === '..' || part === '.owner.json'))) return 'artifacts require safe relative JSON filenames';
  return null;
}

export function allocateCheckArtifacts(workspace, check) {
  if (ensureHarnessDir(workspace, false) === null) throw new Error('Artifact directory is unsafe');
  const root = `${PREFIX}${randomUUID()}`;
  if (!writeFileContained(workspace, `${root}/.owner.json`, JSON.stringify({ check, invocation: root }))) throw new Error('Artifact directory could not be created');
  return root;
}

export function captureCheckArtifacts(workspace, root, paths, redactValue) {
  return paths.map(name => {
    const rel = `${root}/${name}`;
    if (!assertNoSymlinkAncestors(workspace, rel)) throw new Error(`Required artifact is unsafe: ${name}`);
    const bytes = readFileNoFollow(path.join(workspace, rel), { root: workspace, maxBytes: MAX_BYTES, encoding: null });
    if (!bytes) throw new Error(`Required artifact is missing, unsafe or oversized: ${name}`);
    let value;
    try { value = JSON.parse(bytes.toString('utf8')); } catch { throw new Error(`Required artifact is not JSON: ${name}`); }
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Required artifact must be a JSON object: ${name}`);
    const sanitized = Buffer.from(`${JSON.stringify(redactValue(value))}\n`);
    if (sanitized.length > MAX_BYTES || !writeFileContained(workspace, rel, sanitized)) throw new Error(`Required artifact cannot be retained: ${name}`);
    return { path: rel, bytes: sanitized.length, sha256: digest(sanitized) };
  });
}

export function validateCheckArtifacts(workspace, config, result) {
  if (config.artifacts === undefined) return { pass: true };
  const fail = message => ({ pass: false, message });
  if (artifactPathsProblem(config.artifacts)) return fail('Required artifact declaration is invalid');
  const root = result?.artifactRoot;
  if (typeof root !== 'string' || !new RegExp(`^${PREFIX.replaceAll('.', '\\.')}[a-f0-9-]{36}$`).test(root)
    || !Array.isArray(result.artifacts) || result.artifacts.length !== config.artifacts.length) return fail('Required artifact bindings are missing');
  try {
    if (!assertNoSymlinkAncestors(workspace, root)) return fail('Artifact invocation directory changed or is unsafe');
    const owner = JSON.parse(readFileNoFollow(path.join(workspace, root, '.owner.json'), { root: workspace }) || 'null');
    if (!owner || owner.check !== result.id || owner.invocation !== root) return fail('Artifact invocation ownership changed');
    for (let index = 0; index < config.artifacts.length; index++) {
      const artifact = result.artifacts[index];
      if (artifact.path !== `${root}/${config.artifacts[index]}` || !/^[a-f0-9]{64}$/.test(artifact.sha256 || '')) return fail('Required artifact path or digest is invalid');
      if (!assertNoSymlinkAncestors(workspace, artifact.path)) return fail('Artifact path changed or is unsafe');
      const bytes = readFileNoFollow(path.join(workspace, artifact.path), { root: workspace, maxBytes: MAX_BYTES, encoding: null });
      if (!bytes || bytes.length !== artifact.bytes || digest(bytes) !== artifact.sha256) return fail(`Required artifact changed or unreadable: ${artifact.path}`);
    }
  } catch { return fail('Required artifact changed or unreadable'); }
  return { pass: true };
}

export function discardCheckArtifacts(workspace, root) {
  const parent = assertNoSymlinkAncestors(workspace, path.dirname(root));
  if (!parent) throw new Error('Artifact cleanup parent is unsafe');
  fs.rmSync(path.join(parent, path.basename(root)), { recursive: true, force: true });
}
