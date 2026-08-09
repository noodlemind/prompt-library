/**
 * `harness resources list|show|enable|disable` — the bundle surface.
 *
 * `list` shows every bundle INCLUDING the ones that are not contributing, with
 * the reason. A bundle a user installed and cannot see is a support ticket; one
 * shown greyed with "not approved" or "integrity pin does not match" is a fix
 * they can make themselves.
 *
 * `show` is where precedence becomes inspectable (P5AC2): it prints the winner
 * for each contributed path AND the bundles it shadowed, because the question a
 * precedence rule exists to answer is not "what won" but "why did mine not".
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseFlags } from './flags.mjs';
import { resolveCopilotHome } from './paths.mjs';
import { createStyle, keyWidthFor, EXIT } from './style.mjs';
import { redactedJson } from './redact.mjs';
import { discoverBundles, resolvePrecedence, resourcesRoot } from './resources.mjs';

const ui = createStyle({ argv: process.argv.slice(2) });

export const RESOURCES_VERBS = Object.freeze(['list', 'show', 'enable', 'disable']);

function usageError(message, hint) {
  return Object.assign(new Error(message), { code: 'E_USAGE', exit: EXIT.usage, hint });
}

function notFoundError(message, hint) {
  return Object.assign(new Error(message), { code: 'E_NOT_FOUND', exit: EXIT.notFound, hint });
}

function context(argv) {
  const flags = parseFlags(argv);
  const positionals = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--') break;
    if (a.startsWith('--')) {
      if (!a.includes('=') && argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) i += 1;
      continue;
    }
    positionals.push(a);
    if (positionals.length === 2) break;
  }
  return {
    flags,
    verb: positionals[0] ?? 'list',
    name: positionals[1] ?? null,
    copilotHome: resolveCopilotHome(flags.copilotHome),
  };
}

/**
 * Which bundles the operator has approved.
 *
 * A marker file inside the bundle, written by `resources enable`. It lives with
 * the bundle rather than in a central list so that removing the directory
 * removes the approval too — a stale approval naming a bundle that is gone is
 * the kind of state that later grants something unintended.
 */
function approvedNames(copilotHome) {
  const root = resourcesRoot(copilotHome);
  if (!fs.existsSync(root)) return new Set();
  const names = new Set();
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (entry.isDirectory() && fs.existsSync(path.join(root, entry.name, '.enabled'))) names.add(entry.name);
  }
  return names;
}

export async function resourcesResultOf(argv, ctx = {}) {
  const { verb, name, copilotHome } = context(argv);
  if (!RESOURCES_VERBS.includes(verb)) {
    throw usageError(`unknown resources verb: ${verb}`, `one of ${RESOURCES_VERBS.join(', ')}`);
  }

  const bundles = discoverBundles(copilotHome, { trustedNames: approvedNames(copilotHome) });

  if (verb === 'list') {
    return {
      schema: 1,
      verb,
      root: resourcesRoot(copilotHome),
      status: bundles.some((b) => b.state === 'tampered') ? 'failed' : 'ok',
      bundles: bundles.map((b) => ({
        name: b.name,
        version: b.manifest?.version ?? null,
        state: b.state,
        reason: b.reason,
        contributes: b.manifest?.contributes ?? {},
        capabilities: b.manifest?.capabilities ?? [],
      })),
    };
  }

  if (verb === 'show') {
    if (!name) throw usageError('resources show requires a bundle name', 'harness resources list');
    const bundle = bundles.find((b) => b.name === name);
    if (!bundle) throw notFoundError(`no bundle named ${JSON.stringify(name)}`, 'harness resources list');
    return {
      schema: 1,
      verb,
      bundle: {
        name: bundle.name,
        version: bundle.manifest?.version ?? null,
        state: bundle.state,
        reason: bundle.reason,
        dir: bundle.dir,
        digest: bundle.digest ?? null,
        integrity: bundle.manifest?.integrity ?? null,
        capabilities: bundle.manifest?.capabilities ?? [],
        plugin: bundle.manifest?.plugin ?? null,
      },
      // Precedence across ALL bundles, not just this one — the shadowing that
      // matters to a reader is the shadowing of their own contributions.
      precedence: resolvePrecedence(bundles),
    };
  }

  // `enable` / `disable`
  if (!name) throw usageError(`resources ${verb} requires a bundle name`, 'harness resources list');
  const bundle = bundles.find((b) => b.name === name);
  if (!bundle) throw notFoundError(`no bundle named ${JSON.stringify(name)}`, 'harness resources list');
  if (verb === 'enable' && bundle.state === 'tampered') {
    throw Object.assign(new Error(`refusing to enable ${name}: ${bundle.reason}`), {
      code: 'E_DENIED',
      exit: EXIT.needsApproval,
      hint: 'the bundle’s contents no longer match its integrity pin — reinstall it from a source you trust',
    });
  }

  const marker = path.join(bundle.dir, verb === 'enable' ? '.enabled' : '.disabled');
  const opposite = path.join(bundle.dir, verb === 'enable' ? '.disabled' : '.enabled');
  fs.writeFileSync(marker, `${new Date().toISOString()}\n`);
  try {
    fs.unlinkSync(opposite);
  } catch {
    /* not previously in the other state */
  }
  const after = discoverBundles(copilotHome, { trustedNames: approvedNames(copilotHome) }).find((b) => b.name === name);
  return { schema: 1, verb, bundle: { name, state: after?.state ?? 'unknown', reason: after?.reason ?? null } };
}

const STATE_STYLE = { enabled: 'ok', disabled: 'muted', invalid: 'error', untrusted: 'warn', tampered: 'error' };

export async function cmdResources(argv, ctx = {}) {
  const { flags } = context(argv);
  const result = await resourcesResultOf(argv, ctx);

  if (flags.json) {
    console.log(redactedJson(result, { pretty: flags.verbose }));
  } else if (result.verb === 'list') {
    const keyWidth = keyWidthFor(['resources', ...result.bundles.map((b) => b.name)]);
    console.log(ui.line({ key: 'resources', value: `${result.bundles.length} bundle(s)`, note: result.root, keyWidth }));
    for (const b of result.bundles) {
      console.log(ui.line({
        state: STATE_STYLE[b.state] || 'warn',
        key: b.name,
        value: `${b.version ?? '(no version)'} · ${b.state}`,
        note: b.reason || Object.keys(b.contributes).join(', ') || undefined,
        keyWidth,
      }));
    }
    if (!result.bundles.length) console.log(ui.paint('muted', '  no bundles installed'));
  } else if (result.verb === 'show') {
    const b = result.bundle;
    const keyWidth = keyWidthFor(['bundle', 'state', 'capabilities', 'integrity']);
    console.log(ui.line({ state: STATE_STYLE[b.state] || 'warn', key: 'bundle', value: `${b.name} ${b.version ?? ''}`.trim(), note: b.state, keyWidth }));
    if (b.reason) console.log(ui.line({ state: 'warn', key: 'reason', value: b.reason, keyWidth }));
    console.log(ui.line({ key: 'capabilities', value: b.capabilities.join(', ') || '(none requested)', keyWidth }));
    console.log(ui.line({ key: 'integrity', value: b.integrity ? (b.integrity === b.digest ? 'pinned · matches' : 'pinned · MISMATCH') : 'unpinned', keyWidth }));
    for (const row of result.precedence.filter((r) => r.winner === b.name || r.shadowed.includes(b.name))) {
      const shadowed = row.shadowed.length ? ` · shadows ${row.shadowed.join(', ')}` : '';
      console.log(ui.paint('muted', `  ${row.kind}/${row.path} → ${row.winner}${shadowed}`));
    }
  } else {
    const keyWidth = keyWidthFor(['bundle', 'state']);
    console.log(ui.line({ state: STATE_STYLE[result.bundle.state] || 'warn', key: result.verb, value: result.bundle.name, note: result.bundle.state, keyWidth }));
    if (result.bundle.reason) console.log(ui.paint('muted', `  ${result.bundle.reason}`));
  }

  return resourcesExitFor(result);
}

export function resourcesExitFor(result) {
  // A tampered bundle makes `list` a failure: the whole point of a pin is that a
  // mismatch is loud, and an exit code CI can gate on is the loudest channel.
  if (result?.verb === 'list' && result.status !== 'ok') return 1;
  return EXIT.ok;
}
