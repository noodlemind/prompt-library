import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

export const POLICY_RESOLVER_VERSION = 1;
export const ENFORCEMENT_MODES = Object.freeze(['observe', 'warn', 'enforce']);

export function readPolicySource(file) {
  let fd;
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) return null;
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (process.platform === 'win32' ? 0 : fs.constants.O_NONBLOCK || 0));
    const opened = fs.fstatSync(fd);
    if (!opened.isFile() || opened.size > 1024 * 1024 || opened.dev !== stat.dev || opened.ino !== stat.ino) return null;
    const buffer = Buffer.alloc(opened.size);
    let offset = 0;
    while (offset < buffer.length) {
      const read = fs.readSync(fd, buffer, offset, buffer.length - offset, offset);
      if (!read) break;
      offset += read;
    }
    return buffer.subarray(0, offset);
  } catch { return null; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}

export function sourceDigest(file) {
  const content = readPolicySource(file);
  return content ? createHash('sha256').update(content).digest('hex') : fs.existsSync(file) ? 'unreadable' : 'absent';
}

export function policySourceBinding(workspace, home, environment = process.env.HARNESS_ENFORCEMENT) {
  const root = fs.realpathSync(workspace);
  return {
    resolverVersion: POLICY_RESOLVER_VERSION,
    workspace: root,
    sources: Object.fromEntries(['config.yaml', 'policy.yaml', 'checks.yaml', 'routing.yaml'].map(name => [name, sourceDigest(path.join(root, '.github/harness', name))])),
    trustDigest: sourceDigest(path.join(home, 'trust.yaml')),
    environment: ENFORCEMENT_MODES.includes(environment) ? environment : null,
  };
}

export function snapshotRel(workspace) {
  const id = createHash('sha256').update(fs.realpathSync(workspace)).digest('hex').slice(0, 32);
  return `policies/${id}.json`;
}

export function validPolicySnapshot(snapshot, binding) {
  return snapshot?.version === 1 && snapshot?.binding?.resolverVersion === POLICY_RESOLVER_VERSION
    && JSON.stringify(snapshot.binding) === JSON.stringify(binding)
    && snapshot.scope === 'environment'
    && ENFORCEMENT_MODES.includes(snapshot.policy?.enforcement)
    && ['plan', 'completion', 'critical', 'destructive'].every(rule => ENFORCEMENT_MODES.includes(snapshot.policy?.rules?.[rule]))
    && Number.isFinite(snapshot.policy.gateTtlMinutes) && snapshot.policy.gateTtlMinutes > 0
    && Number.isFinite(snapshot.policy.evidenceTtlHours) && snapshot.policy.evidenceTtlHours > 0;
}
