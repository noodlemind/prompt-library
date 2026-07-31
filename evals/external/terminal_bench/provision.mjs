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

/** The bundle's bind mount in harbor's Docker Compose service-volume format. */
export function bundleMount(bundleDir) {
  return { type: 'bind', source: bundleDir, target: BUNDLE_MOUNT_TARGET, read_only: true };
}

const repoRootDefault = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

export function harnessWrapperScript() {
  // The container architecture belongs to the task image (the pinned COBOL
  // image is amd64-only regardless of host), so the runtime is chosen by
  // uname -m and the bundle carries one runtime per supported arch.
  return [
    '#!/bin/sh',
    'case "$(uname -m)" in',
    `  x86_64) exec ${BUNDLE_MOUNT_TARGET}/node-x64/bin/node ${BUNDLE_MOUNT_TARGET}/harness/bin/harness.mjs "$@" ;;`,
    `  aarch64|arm64) exec ${BUNDLE_MOUNT_TARGET}/node-arm64/bin/node ${BUNDLE_MOUNT_TARGET}/harness/bin/harness.mjs "$@" ;;`,
    '  *) echo "harness bundle: unsupported architecture $(uname -m)" >&2; exit 1 ;;',
    'esac',
    '',
  ].join('\n');
}

/**
 * Treatment setup: install the wrapper somewhere every exec PATH can see
 * (harbor's exec PATH may omit /usr/local/bin), then prove the CLI answers
 * with a command that actually exists (`harness help`; there is no --version).
 */
export function activationCommands() {
  return [
    `install -m 0755 ${BUNDLE_MOUNT_TARGET}/harness-cli /usr/local/bin/harness`,
    'ln -sf /usr/local/bin/harness /usr/bin/harness',
    '/usr/bin/harness help',
  ];
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
  nodeTarballs = {
    x64: process.env.HARNESS_EVAL_NODE_TARBALL_X64 ?? null,
    arm64: process.env.HARNESS_EVAL_NODE_TARBALL_ARM64 ?? null,
  },
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
  // --ignore-scripts: the package's prepare hook (build:assets) needs the
  // full repo tree; the working copy already contains the built assets.
  run('npm', ['install', '--omit=dev', '--no-audit', '--no-fund', '--ignore-scripts'], { cwd: harnessDir });
  // Legacy single-tarball hook: infer its architecture from the filename.
  const legacy = process.env.HARNESS_EVAL_NODE_TARBALL;
  if (legacy && !nodeTarballs.x64 && !nodeTarballs.arm64) {
    if (/x64/.test(legacy)) nodeTarballs = { ...nodeTarballs, x64: legacy };
    else if (/arm64|aarch64/.test(legacy)) nodeTarballs = { ...nodeTarballs, arm64: legacy };
  }
  const provided = Object.entries(nodeTarballs).filter(([, tarball]) => tarball);
  if (!provided.length) {
    throw new Error(
      'a Linux Node runtime tarball is required (set HARNESS_EVAL_NODE_TARBALL_X64 and/or HARNESS_EVAL_NODE_TARBALL_ARM64 to downloaded node-vXX-linux-<arch>.tar.gz files)'
    );
  }
  for (const [arch, tarball] of provided) {
    const nodeDir = path.join(bundleDir, `node-${arch}`);
    fs.mkdirSync(nodeDir, { recursive: true });
    run('tar', ['-xzf', tarball, '--strip-components=1', '-C', nodeDir]);
  }
  const wrapper = path.join(bundleDir, 'harness-cli');
  fs.writeFileSync(wrapper, harnessWrapperScript(), { mode: 0o755 });
  return { bundleDir, mount: bundleMount(bundleDir) };
}
