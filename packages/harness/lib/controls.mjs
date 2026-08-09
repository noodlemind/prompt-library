/**
 * Execution controls and their enforcement classes (P3AC1).
 *
 * Every control the harness applies to an executed process declares what it
 * ACTUALLY does, in one of three classes:
 *
 *   enforced         the control makes the thing impossible
 *   detect-and-block the control observes and stops it after the fact
 *   audit-only       the control records what happened and prevents nothing
 *
 * The reason this is data rather than prose is that the third class exists and
 * is easy to hide. A "network policy" that quietly does nothing on Windows is
 * worse than no network policy at all: an operator reads `network: deny` and
 * believes something. Declaring the class per control, and RESOLVING it per
 * platform at runtime, is what keeps `deny` from meaning two different things
 * on two machines with nobody able to tell which one they are on.
 *
 * The realized class is therefore never assumed from `process.platform` alone.
 * A primitive that should exist and does not — an `unshare` that the kernel
 * refuses, a `sandbox-exec` removed by a future macOS — degrades to `audit-only`
 * with a reason, and the degradation lands in the execution audit event. That is
 * the behavior P3AC3 asks for: "where the platform lacks isolation primitives
 * the degradation is recorded in the audit event".
 */
import { spawnSync } from 'node:child_process';

export const ENFORCEMENT_CLASSES = Object.freeze(['enforced', 'detect-and-block', 'audit-only']);

/**
 * The controls that do not vary by platform. Each is `enforced` because each is
 * implemented by refusing in-process, before anything is spawned — there is no
 * primitive to be missing.
 */
export const STATIC_CONTROLS = Object.freeze([
  { id: 'cwd-containment', class: 'enforced', constrains: 'where the process may run' },
  { id: 'timeout', class: 'enforced', constrains: 'how long the process tree may live' },
  { id: 'environment-allowlist', class: 'enforced', constrains: 'what the process can read from the environment' },
  { id: 'shell-gate', class: 'enforced', constrains: 'whether a shell may be invoked at all' },
]);

/**
 * macOS: a sandbox profile that allows everything except the network. The
 * `(allow default)` is deliberate — this control is about network reachability,
 * not a general sandbox, and a restrictive default here would break ordinary
 * builds while claiming to be a network policy.
 */
const DARWIN_PROFILE = '(version 1)(allow default)(deny network*)';

function darwinWrapper() {
  return ['/usr/bin/sandbox-exec', '-p', DARWIN_PROFILE];
}

function linuxWrapper() {
  // `-r` maps the current user into the namespace so the child keeps its own
  // uid; without it, an unprivileged `unshare -n` fails outright on most
  // distributions.
  return ['unshare', '-rn'];
}

/**
 * Does this wrapper actually work here?
 *
 * Probed rather than assumed, and probed by RUNNING it: `unshare` exists on
 * every Linux box and is refused by plenty of them (unprivileged user
 * namespaces disabled, containers without CAP_SYS_ADMIN), and a control that
 * reports `enforced` because a binary is on PATH would be lying in exactly the
 * environments people run CI in.
 *
 * The probe confirms the primitive is USABLE. That the profile denies network
 * is a property of the profile, covered by its own test on the platform that
 * implements it.
 */
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

// One probe per process. Spawning a child to answer the same question on every
// `exec` would make the control cost more than the thing it protects.
const probeCache = new Map();

export function resetControlProbeCache() {
  probeCache.clear();
}

/**
 * Resolve the network control for this platform and policy.
 *
 * `allow` is not a degraded `deny` — nothing was asked for, so nothing is
 * missing, and it reports `audit-only` with that as its reason rather than
 * implying a failed attempt at isolation.
 */
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

/**
 * The full control set for one execution, each with the class it actually
 * achieved. This is what the audit event records and what the ledger renders.
 */
export function resolveControls({ networkPolicy = 'allow', platform = process.platform, spawn = spawnSync, cache = probeCache } = {}) {
  const network = resolveNetworkControl({ policy: networkPolicy, platform, spawn, cache });
  const controls = [
    ...STATIC_CONTROLS.map((c) => ({ id: c.id, declared: c.class, realized: c.class, constrains: c.constrains })),
    { id: network.id, declared: network.declared, realized: network.realized, constrains: network.constrains, reason: network.reason },
  ];
  return { controls, networkWrapper: network.wrapper, degraded: controls.filter((c) => c.declared !== c.realized) };
}
