/**
 * Harness bundle provisioning for the treatment condition.
 *
 * The pinned COBOL task image ships Python and GnuCOBOL — no Node, no npm, no
 * Harness. Instead of mutating the task image (which would contaminate the
 * benchmark), the release runner prepares a self-contained bundle on the host
 * and Harbor mounts it read-only into BOTH conditions (per the plan, the
 * executable may be present in both; only the treatment activates it):
 *
 *   <bundle>/node/...        an extracted official Linux Node runtime
 *   <bundle>/harness/...     the harness package at the evaluated SHA, with
 *                            production deps installed
 *   <bundle>/harness-cli     a POSIX wrapper running harness via bundled node
 *
 * Activation (treatment setupCommands) installs the wrapper on PATH and
 * proves the CLI answers — and setup fails closed if it does not.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const BUNDLE_MOUNT_TARGET = '/opt/harness-bundle';

const repoRootDefault = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

export function harnessWrapperScript() {
  return [
    '#!/bin/sh',
    `exec ${BUNDLE_MOUNT_TARGET}/node/bin/node ${BUNDLE_MOUNT_TARGET}/harness/bin/harness.mjs "$@"`,
    '',
  ].join('\n');
}

/** Treatment setup: install the wrapper on PATH, then prove the CLI answers. */
export function activationCommands() {
  return [`install -m 0755 ${BUNDLE_MOUNT_TARGET}/harness-cli /usr/local/bin/harness`, 'harness --version'];
}

/**
 * Prepare the bundle directory on the host. Network and process access are
 * injected; the real run copies the working tree's harness package (the
 * evaluated SHA), installs its production deps, and unpacks a Linux Node
 * runtime for the sandbox architecture (`nodeTarball` may point at a
 * pre-downloaded archive to keep releases offline-friendly).
 */
export function prepareHarnessBundle({
  bundleDir,
  repoRoot = repoRootDefault,
  nodeTarball = process.env.HARNESS_EVAL_NODE_TARBALL ?? null,
  spawnImpl = spawnSync,
}) {
  fs.mkdirSync(bundleDir, { recursive: true });
  const harnessDir = path.join(bundleDir, 'harness');
  const run = (cmd, args, opts = {}) => {
    const res = spawnImpl(cmd, args, { encoding: 'utf8', ...opts });
    if (res.status !== 0) throw new Error(`bundle step failed: ${cmd} ${args.join(' ')}: ${res.stderr || res.error?.message || res.status}`);
    return res;
  };
  run('cp', ['-R', path.join(repoRoot, 'packages', 'harness'), harnessDir]);
  run('npm', ['install', '--omit=dev', '--no-audit', '--no-fund'], { cwd: harnessDir });
  const nodeDir = path.join(bundleDir, 'node');
  fs.mkdirSync(nodeDir, { recursive: true });
  if (!nodeTarball) {
    throw new Error('a Linux Node runtime tarball is required (set HARNESS_EVAL_NODE_TARBALL to a downloaded node-vXX-linux-<arch>.tar.gz)');
  }
  run('tar', ['-xzf', nodeTarball, '--strip-components=1', '-C', nodeDir]);
  const wrapper = path.join(bundleDir, 'harness-cli');
  fs.writeFileSync(wrapper, harnessWrapperScript(), { mode: 0o755 });
  return { bundleDir, mount: { source: bundleDir, target: BUNDLE_MOUNT_TARGET, readOnly: true } };
}
