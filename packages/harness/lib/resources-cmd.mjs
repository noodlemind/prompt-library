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
 * The bundle/manifest machinery in `lib/resources.mjs` and the plugin protocol
 * in `lib/plugin-host.mjs` remain as reviewed but UNWIRED groundwork: external
 * distribution is not a workflow this project wants today, and neither module
 * has a production caller. That is recorded rather than implied — see the plan.
 */
import path from 'node:path';
import { parseFlags } from './flags.mjs';
import { resolveCopilotHome } from './paths.mjs';
import { createStyle, keyWidthFor, EXIT } from './style.mjs';
import { redactedJson } from './redact.mjs';
import { inertLine } from './knowledge/store.mjs';
import { readLock } from './lock.mjs';
import { getAssetsRoot } from './commands.mjs';
import { collectAllAssetFiles } from './sync.mjs';
import {
  localPrimitiveStatus,
  registerPrimitive,
  registeredPath,
  unregisterPrimitive,
  validatePrimitive,
} from './local-primitives.mjs';

const ui = createStyle({ argv: process.argv.slice(2) });

export const RESOURCES_VERBS = Object.freeze(['list', 'show', 'register', 'unregister']);

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
    const assets = getAssetsRoot();
    shippedFiles = new Set(collectAllAssetFiles(assets));
  } catch {
    /* assets unavailable — see the note above */
  }
  return { shippedFiles, lockFiles: new Set(readLock(copilotHome)?.files || []) };
}

export async function resourcesResultOf(argv, ctx = {}) {
  const { verb, target, copilotHome } = context(argv);
  if (!RESOURCES_VERBS.includes(verb)) {
    throw usageError(`unknown resources verb: ${verb}`, `one of ${RESOURCES_VERBS.join(', ')}`);
  }
  const { shippedFiles, lockFiles } = origins(copilotHome);
  const primitives = localPrimitiveStatus({ copilotHome, shippedFiles, lockFiles });

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
  if (result?.verb === 'list' && result.status !== 'ok') return 1;
  return EXIT.ok;
}
