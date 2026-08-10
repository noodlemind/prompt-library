/**
 * `harness trust status|approve|revoke`.
 *
 * `status` is the discoverability half of the gate. A project whose config
 * silently does nothing because nobody approved it is indistinguishable from a
 * project whose config is wrong, so every state here carries a reason and the
 * exact list of files an approval pins.
 */
import path from 'node:path';
import { parseFlags } from './flags.mjs';
import { verbOf } from './positionals.mjs';
import { resolveCopilotHome } from './paths.mjs';
import { createStyle, keyWidthFor, EXIT } from './style.mjs';
import { redactedJson } from './redact.mjs';
import { approveProject, revokeProject, trustStatus } from './trust.mjs';

const ui = createStyle({ argv: process.argv.slice(2) });

export const TRUST_VERBS = Object.freeze(['status', 'approve', 'revoke']);

function usageError(message, hint) {
  return Object.assign(new Error(message), { code: 'E_USAGE', exit: EXIT.usage, hint });
}

function context(argv) {
  const flags = parseFlags(argv);
  // Matched against TRUST_VERBS rather than taken positionally. The old scan
  // read `approve` as the value of `--json`, found no positional, and fell back
  // to `status` — so `harness trust --json approve` PRINTED THE CURRENT STATE
  // AND EXITED 0 while recording no approval. An operator reading "not trusted"
  // could not tell their request had been dropped rather than refused.
  const verb = verbOf(argv, TRUST_VERBS, { fallback: 'status' });
  return {
    flags,
    verb,
    workspace: path.resolve(flags.workspace),
    copilotHome: resolveCopilotHome(flags.copilotHome),
  };
}

export async function trustResultOf(argv, ctx = {}) {
  const { verb, workspace, copilotHome } = context(argv);
  if (!TRUST_VERBS.includes(verb)) {
    throw usageError(`unknown trust verb: ${verb}`, `one of ${TRUST_VERBS.join(', ')}`);
  }

  if (verb === 'status') return { verb, ...trustStatus({ workspace, copilotHome }) };

  const before = trustStatus({ workspace, copilotHome });
  const after = verb === 'approve'
    ? approveProject({ workspace, copilotHome })
    : revokeProject({ workspace, copilotHome });

  // P3AC6: "trust changes are recorded". Emitted from here rather than the
  // handler so the envelope and agent lanes record the change too — the same
  // gap that made `exec`'s audit skippable by choosing an output format.
  const events = ctx?.events;
  const sink = typeof events?.withCommand === 'function' ? events.withCommand('trust') : events;
  sink?.emit?.('trust', {
    result: 'pass',
    status: 'ok',
    trust: {
      verb,
      project: after.project,
      id: after.id,
      from: before.state,
      to: after.state,
      digest: after.digest,
    },
  });

  return { verb, ...after, previousState: before.state };
}

const STATE_STYLE = { trusted: 'ok', untrusted: 'warn', stale: 'warn', revoked: 'error' };

export async function cmdTrust(argv, ctx = {}) {
  const { flags } = context(argv);
  const result = await trustResultOf(argv, ctx);

  if (flags.json) {
    console.log(redactedJson(result, { pretty: flags.verbose }));
  } else {
    const keyWidth = keyWidthFor(['project', 'trust', 'pinned', 'store']);
    console.log(ui.line({ state: STATE_STYLE[result.state] || 'warn', key: 'trust', value: result.state, note: result.reason, keyWidth }));
    console.log(ui.line({ key: 'project', value: result.project, keyWidth }));
    console.log(ui.line({ key: 'pinned', value: result.pinned.join(', '), keyWidth }));
    console.log(ui.line({ key: 'store', value: result.store, keyWidth }));
    if (result.state === 'stale') {
      console.log(ui.paint('muted', '  the pinned files changed — re-approve after reading them: harness trust approve'));
    } else if (result.state !== 'trusted' && result.verb === 'status') {
      console.log(ui.paint('muted', '  project config and policy are ignored until approved: harness trust approve'));
    }
  }

  // `status` answers a question and always succeeds at answering it; reporting
  // an untrusted project as a command failure would make `trust status` unusable
  // in exactly the scripts that need to branch on it.
  return 0;
}
