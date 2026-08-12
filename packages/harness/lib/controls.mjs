import { spawnSync } from 'node:child_process';

export const ENFORCEMENT_CLASSES = Object.freeze(['enforced', 'detect-and-block', 'audit-only']);

export const STATIC_CONTROLS = Object.freeze([
  { id: 'cwd-containment', class: 'enforced', constrains: 'where the process may run' },
  { id: 'timeout', class: 'enforced', constrains: 'how long the process tree may live' },
  { id: 'environment-allowlist', class: 'enforced', constrains: 'what the process can read from the environment' },
  { id: 'shell-gate', class: 'enforced', constrains: 'whether a shell may be invoked at all' },
]);

/** Controls whose realized class depends on how the caller invoked them, rather
 * than on the platform. */
const CALLER_DEPENDENT = new Set(['environment-allowlist']);

const DARWIN_PROFILE = '(version 1)(allow default)(deny network*)';

function darwinWrapper() {
  return ['/usr/bin/sandbox-exec', '-p', DARWIN_PROFILE];
}

function linuxWrapper() {
    return ['unshare', '-rn'];
}

function probeWrapper(wrapper, { spawn = spawnSync } = {}) {
  try {
    const result = spawn(wrapper[0], [...wrapper.slice(1), process.execPath, '-e', 'process.exit(0)'], {
      stdio: 'ignore',
      timeout: 5000,
    });
    return result.status === 0;
  } catch {
    return false;
  }
}

const probeCache = new Map();

export function resetControlProbeCache() {
  probeCache.clear();
}

export function resolveNetworkControl({
  policy = 'allow',
  platform = process.platform,
  spawn = spawnSync,
  cache = probeCache,
} = {}) {
  const base = { id: 'network-policy', declared: 'enforced', constrains: 'whether the process can reach the network' };
  if (policy !== 'deny') {
    return { ...base, realized: 'audit-only', wrapper: [], reason: 'policy is allow — the network is not restricted' };
  }

  const wrapper = platform === 'darwin' ? darwinWrapper() : platform === 'linux' ? linuxWrapper() : null;
  if (!wrapper) {
    return {
      ...base,
      realized: 'audit-only',
      wrapper: [],
      reason: `no network-isolation primitive on ${platform} — the request is recorded, not enforced`,
    };
  }

  const key = `${platform}:${wrapper.join(' ')}`;
  if (!cache.has(key)) cache.set(key, probeWrapper(wrapper, { spawn }));
  if (!cache.get(key)) {
    return {
      ...base,
      realized: 'audit-only',
      wrapper: [],
      reason: `${wrapper[0]} is present but not usable here — the request is recorded, not enforced`,
    };
  }
  return { ...base, realized: 'enforced', wrapper, reason: `isolated with ${wrapper[0]}` };
}

export function resolveControls({
  networkPolicy = 'allow',
  platform = process.platform,
  spawn = spawnSync,
  cache = probeCache,
    environmentAllowlisted = true,
} = {}) {
  const network = resolveNetworkControl({ policy: networkPolicy, platform, spawn, cache });
  const controls = [
    ...STATIC_CONTROLS.map((c) => {
      const downgraded = CALLER_DEPENDENT.has(c.id) && !environmentAllowlisted;
      return {
        id: c.id,
        declared: c.class,
        realized: downgraded ? 'audit-only' : c.class,
        constrains: c.constrains,
        ...(downgraded ? { reason: 'the child inherited the parent environment — set checks.env_allowlist to enforce this' } : {}),
      };
    }),
    { id: network.id, declared: network.declared, realized: network.realized, constrains: network.constrains, reason: network.reason },
  ];
  return { controls, networkWrapper: network.wrapper, degraded: controls.filter((c) => c.declared !== c.realized) };
}
