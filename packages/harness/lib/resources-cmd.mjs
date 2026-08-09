/**
 * `harness resources list|show|register|unregister` — the locally-added
 * primitive surface.
 *
 * The workflow this serves: someone obtains a skill or agent from an external
 * source and drops it straight into `~/.copilot/skills` or `~/.copilot/agents`,
 * where every host already looks. It is deliberately NOT in the harness lock,
 * so `upgrade` and `uninstall` never touch it. What was missing is that the
 * harness had no idea it existed — worse, it read as cruft, and `doctor` told
 * people to tombstone their own team's work.
 *
 * So this command answers three questions: what did we add, does it actually
 * work, and is it recognized. `register` is the operator saying "I read this
 * and I want it" — validated first, because marking a primitive as working when
 * the host would never load it is the failure mode with the longest feedback
 * loop in the system.
 *
 * Bundles are the managed route and they are wired: `bundle-sync` places an
 * approved bundle's contributions on every install and upgrade, and withdraws
 * them when it is disabled or removed.
 *
 * The plugin protocol is NOT reachable from here. A manifest may declare a
 * plugin entry point and nothing reads it; the only sanctioned start path is
 * the first-party provider seam, and `test/provider-seam.test.mjs` asserts this
 * file cannot reach it.
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseFlags } from './flags.mjs';
import { resolveCopilotHome } from './paths.mjs';
import { createStyle, keyWidthFor, EXIT } from './style.mjs';
import { redactedJson } from './redact.mjs';
import { inertLine } from './knowledge/store.mjs';
import { readLock } from './lock.mjs';
import { getAssetsRoot } from './commands.mjs';
import { collectAllAssetFiles } from './sync.mjs';
import { approvedBundleNames, placedFiles, readPlacements, syncBundles } from './bundle-sync.mjs';
import { bundleDigest, discoverBundles, parseManifest, MANIFEST_FILE, resourcesRoot } from './resources.mjs';
import {
  localPrimitiveStatus,
  registerPrimitive,
  registeredPath,
  unregisterPrimitive,
  validatePrimitive,
} from './local-primitives.mjs';

const ui = createStyle({ argv: process.argv.slice(2) });

export const RESOURCES_VERBS = Object.freeze([
  'list', 'show', 'register', 'unregister',
  // Bundle verbs. A bundle is the MANAGED way to put primitives into the
  // Copilot home — versioned, removable, and provenance-tracked — next to the
  // unmanaged way of copying a file in by hand, which `register` covers.
  'add', 'update', 'remove', 'bundles',
]);

function usageError(message, hint) {
  return Object.assign(new Error(message), { code: 'E_USAGE', exit: EXIT.usage, hint });
}

/** Flags on this entry that take a value — a BOOLEAN flag before the verb must
 * not swallow it, which is the bug the same parser had in `run`. */
const VALUE_FLAGS = new Set(['--workspace', '--copilot-home']);

function context(argv) {
  const flags = parseFlags(argv);
  const positionals = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--') break;
    if (a.startsWith('-')) {
      if (!a.includes('=') && VALUE_FLAGS.has(a) && argv[i + 1] !== undefined) i += 1;
      continue;
    }
    positionals.push(a);
    if (positionals.length === 2) break;
  }
  return {
    flags,
    verb: positionals[0] ?? 'list',
    target: positionals[1] ?? null,
    copilotHome: resolveCopilotHome(flags.copilotHome),
  };
}

/**
 * What the package ships, and what it has hydrated here.
 *
 * Both are needed to tell a local addition from an orphan. A failure to resolve
 * assets is not fatal: without them every non-lock file simply reads as local,
 * which errs toward showing a file rather than hiding it.
 */
function origins(copilotHome) {
  let shippedFiles = new Set();
  try {
    shippedFiles = new Set(collectAllAssetFiles(getAssetsRoot()));
  } catch {
    /* assets unavailable — see the note above */
  }
  // A bundle's placed files are not hand-added, so they are excluded from the
  // local set: reporting a managed file as "pending registration" would ask the
  // operator to approve something a bundle already accounts for.
  const lockFiles = new Set([...(readLock(copilotHome)?.files || []), ...placedFiles(copilotHome)]);
  return { shippedFiles, lockFiles };
}

/** Re-place every enabled bundle. Shared by add/update/remove so the three
 * cannot drift about what "applied" means. */
function applyBundles(copilotHome) {
  let shippedFiles = new Set();
  try {
    shippedFiles = new Set(collectAllAssetFiles(getAssetsRoot()));
  } catch { /* assets unavailable */ }
  return syncBundles({ copilotHome, shippedFiles, trustedNames: approvedBundleNames(copilotHome) });
}

/** Copy a bundle directory in, refusing anything whose manifest does not parse
 * — an invalid bundle installed is one that fails later, further from the
 * decision that caused it. */
function addBundle(copilotHome, source) {
  const from = path.resolve(source);
  const manifestPath = path.join(from, MANIFEST_FILE);
  if (!fs.existsSync(manifestPath)) {
    throw Object.assign(new Error(`no ${MANIFEST_FILE} in ${source}`), {
      code: 'E_USAGE', exit: EXIT.usage, hint: 'a bundle is a directory containing a manifest',
    });
  }
  const { manifest, errors } = parseManifest(fs.readFileSync(manifestPath, 'utf8'), { source });
  if (!manifest) {
    throw Object.assign(new Error(`invalid bundle: ${errors[0]}`), { code: 'E_USAGE', exit: EXIT.usage });
  }
  const dest = path.join(resourcesRoot(copilotHome), manifest.name);
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.cpSync(from, dest, { recursive: true });
  // Never carries approval across: a bundle arriving pre-enabled would mean
  // installing it and approving it were the same act.
  for (const marker of ['.enabled', '.disabled']) {
    fs.rmSync(path.join(dest, marker), { force: true });
  }
  return { name: manifest.name, version: manifest.version, dir: dest, digest: bundleDigest(dest) };
}

export async function resourcesResultOf(argv, ctx = {}) {
  const { verb, target, copilotHome } = context(argv);
  if (!RESOURCES_VERBS.includes(verb)) {
    throw usageError(`unknown resources verb: ${verb}`, `one of ${RESOURCES_VERBS.join(', ')}`);
  }
  const { shippedFiles, lockFiles } = origins(copilotHome);
  const primitives = localPrimitiveStatus({ copilotHome, shippedFiles, lockFiles });

  if (verb === 'bundles') {
    const bundles = discoverBundles(copilotHome, { trustedNames: approvedBundleNames(copilotHome) });
    const placements = readPlacements(copilotHome);
    return {
      schema: 1,
      verb,
      status: bundles.some((b) => b.state === 'tampered' || b.state === 'invalid') ? 'failed' : 'ok',
      bundles: bundles.map((b) => ({
        name: b.name,
        dir: b.dir,
        version: b.manifest?.version ?? null,
        state: b.state,
        reason: b.reason,
        placed: placements.bundles[b.name]?.files ?? [],
      })),
    };
  }

  if (verb === 'add' || verb === 'update') {
    if (!target) throw usageError(`resources ${verb} requires a bundle directory`, `harness resources ${verb} ./my-bundle`);
    const added = addBundle(copilotHome, target);
    // Placement happens on the same pass, so `add` leaves the home in the state
    // the next `upgrade` would produce rather than a half-applied one.
    const sync = applyBundles(copilotHome);
    return { schema: 1, verb, bundle: added, sync };
  }

  if (verb === 'remove') {
    if (!target) throw usageError('resources remove requires a bundle name', 'harness resources bundles');
    const dir = path.join(resourcesRoot(copilotHome), target);
    if (!fs.existsSync(dir)) {
      throw Object.assign(new Error(`no bundle named ${JSON.stringify(target)}`), {
        code: 'E_NOT_FOUND', exit: EXIT.notFound, hint: 'harness resources bundles',
      });
    }
    fs.rmSync(dir, { recursive: true, force: true });
    // Withdrawal is the same sync: whatever this bundle placed is no longer
    // contributed, so the pass that re-places everything removes exactly it.
    const sync = applyBundles(copilotHome);
    return { schema: 1, verb, bundle: { name: target }, sync };
  }

  if (verb === 'list') {
    const invalid = primitives.filter((p) => p.state === 'invalid').length;
    return {
      schema: 1,
      verb,
      home: copilotHome,
      registry: registeredPath(copilotHome),
      // An invalid primitive is a real problem someone should see; a merely
      // pending one is a decision waiting to be made, not a failure.
      status: invalid ? 'failed' : 'ok',
      counts: {
        total: primitives.length,
        registered: primitives.filter((p) => p.state === 'registered').length,
        pending: primitives.filter((p) => p.state === 'pending').length,
        stale: primitives.filter((p) => p.state === 'stale').length,
        invalid,
      },
      primitives,
    };
  }

  if (!target) throw usageError(`resources ${verb} requires a path`, 'harness resources list');
  // Matched generously on purpose. A person types the name they gave the thing
  // — `my-team-skill` — not `skills/my-team-skill/SKILL.md`. Matching only the
  // full path or the frontmatter name meant an INVALID primitive (whose name
  // could not be read) reported "not found", hiding the actual problem behind a
  // misleading error.
  const matches = (p) => p.path === target
    || p.path.endsWith(`/${target}`)
    || p.name === target
    || p.path.split('/')[1] === target
    || path.basename(p.path).replace(/\.(agent|instructions)\.md$/, '') === target;
  const found = primitives.find(matches);
  if (verb === 'show') {
    if (!found) {
      throw Object.assign(new Error(`no locally-added primitive matching ${JSON.stringify(target)}`), {
        code: 'E_NOT_FOUND', exit: EXIT.notFound, hint: 'harness resources list',
      });
    }
    return { schema: 1, verb, primitive: found, validation: validatePrimitive(copilotHome, found.path) };
  }

  const rel = found?.path ?? target;
  if (verb === 'register') {
    const result = registerPrimitive({ copilotHome, rel, shippedFiles, lockFiles });
    return { schema: 1, verb, primitive: { ...result, reason: 'registered' } };
  }
  return { schema: 1, verb, primitive: unregisterPrimitive({ copilotHome, rel }) };
}

const STATE_STYLE = { registered: 'ok', pending: 'warn', stale: 'warn', invalid: 'error' };

export async function cmdResources(argv, ctx = {}) {
  const { flags } = context(argv);
  const result = await resourcesResultOf(argv, ctx);

  if (flags.json) {
    console.log(redactedJson(result, { pretty: flags.verbose }));
  } else if (result.verb === 'list') {
    const keyWidth = keyWidthFor(['primitives', ...result.primitives.map((p) => p.path)]);
    const c = result.counts;
    console.log(ui.line({
      key: 'primitives',
      value: `${c.total} locally added`,
      note: [`${c.registered} registered`, `${c.pending} pending`, c.stale ? `${c.stale} stale` : null, c.invalid ? `${c.invalid} invalid` : null].filter(Boolean).join(' · '),
      keyWidth,
    }));
    for (const p of result.primitives) {
      // Untrusted text from a file someone else wrote, on its way to a
      // terminal: inerted like every other external string the harness renders.
      console.log(ui.line({
        state: STATE_STYLE[p.state] || 'warn',
        key: p.path,
        value: p.state,
        note: inertLine(String(p.reason || '')),
        keyWidth,
      }));
    }
    if (!result.primitives.length) {
      console.log(ui.paint('muted', `  nothing added by hand under ${result.home}/skills or /agents`));
    }
  } else if (result.verb === 'bundles') {
    const keyWidth = keyWidthFor(['bundles', ...result.bundles.map((b) => b.name)]);
    console.log(ui.line({ key: 'bundles', value: `${result.bundles.length} installed`, keyWidth }));
    for (const b of result.bundles) {
      console.log(ui.line({
        state: b.state === 'enabled' ? 'ok' : b.state === 'tampered' || b.state === 'invalid' ? 'error' : 'warn',
        key: b.name,
        value: `${b.version ?? '(no version)'} · ${b.state}`,
        note: inertLine(b.reason || `${b.placed.length} file(s) placed`),
        keyWidth,
      }));
    }
    if (!result.bundles.length) console.log(ui.paint('muted', '  no bundles installed'));
  } else if (result.verb === 'add' || result.verb === 'update' || result.verb === 'remove') {
    const keyWidth = keyWidthFor(['bundle', 'placed', 'withdrew', 'refused']);
    console.log(ui.line({ state: 'ok', key: result.verb, value: inertLine(result.bundle.name), note: result.bundle.version || undefined, keyWidth }));
    console.log(ui.line({ key: 'placed', value: `${result.sync.placed.length} file(s)`, keyWidth }));
    if (result.sync.withdrawn.length) console.log(ui.line({ key: 'withdrew', value: `${result.sync.withdrawn.length} file(s)`, keyWidth }));
    for (const r of result.sync.refused) {
      console.log(ui.line({ state: 'warn', key: 'refused', value: inertLine(r.target), note: inertLine(r.reason), keyWidth }));
    }
    for (const s of result.sync.shadowed) {
      console.log(ui.paint('muted', `  ${inertLine(s.target)} — ${inertLine(s.bundle)} shadowed by ${inertLine(s.winner)}`));
    }
  } else if (result.verb === 'show') {
    const p = result.primitive;
    const keyWidth = keyWidthFor(['primitive', 'state', 'kind', 'digest']);
    console.log(ui.line({ state: STATE_STYLE[p.state] || 'warn', key: 'primitive', value: inertLine(p.path), note: p.state, keyWidth }));
    console.log(ui.line({ key: 'kind', value: `${p.kind ?? 'unknown'}${p.name ? ` · ${inertLine(p.name)}` : ''}`, keyWidth }));
    console.log(ui.line({ key: 'digest', value: p.digest ?? '(unreadable)', keyWidth }));
    console.log(ui.line({ state: p.state === 'invalid' ? 'error' : 'muted', key: 'reason', value: inertLine(String(p.reason || '')), keyWidth }));
    for (const error of result.validation.errors) console.log(ui.paint('muted', `  ${inertLine(error)}`));
  } else {
    const p = result.primitive;
    const keyWidth = keyWidthFor(['register', 'unregister']);
    console.log(ui.line({ state: p.state === 'registered' ? 'ok' : 'warn', key: result.verb, value: inertLine(p.path), note: p.state, keyWidth }));
  }

  return resourcesExitFor(result);
}

export function resourcesExitFor(result) {
  // An invalid primitive makes `list` a failure so CI — or a person reading an
  // exit code — learns that something someone added will never load.
  if ((result?.verb === 'list' || result?.verb === 'bundles') && result.status !== 'ok') return 1;
  return EXIT.ok;
}
