/**
 * Lane producers for the pre-existing retrieval commands (`recall`, `get`).
 *
 * P2D1, from the Phase 1 debt table: `resultOf` producers expand past the three
 * commands that had them, reversing the AC3 lane-scope amendment for this
 * surface. Declaring `resultOf` IS the opt-in — `assertLaneSupported` derives
 * lane support from its presence, and `laneBearingCommands()` regenerates the
 * help text from the same fact — so these two functions are the whole change
 * that gives `recall` and `get` the envelope and agent lanes they refused with
 * a structured `E_USAGE` before.
 *
 * These matter more than most: P2AC5 keeps `recall`/`get` working as the
 * compatibility path while `search`/`lookup` take over, and a compatibility
 * command that cannot speak the envelope lane is only half compatible — a
 * caller migrating to `--output json-envelope` would have to migrate commands
 * at the same time.
 *
 * The producers are PURE — they compute the result and write no events. That
 * mirrors `orientResultOf`/`statusResultOf`: the lane path is bracketed by the
 * registry's own `command.start`/`command.result`, while the domain event a
 * handler writes stays on the handler path. The asymmetry is real and is the
 * Phase 4a debt to migrate those ~25 legacy writers onto the event registry;
 * duplicating a domain write here would deepen it rather than pay it down.
 */
import path from 'node:path';
import { parseFlags, hasFlag } from '../flags.mjs';
import { resolveCopilotHome } from '../paths.mjs';

export async function recallResultOf(argv) {
  const { runRecall } = await import('../recall-cmd.mjs');
  const flags = parseFlags(argv);
  // `--include-plans` is boundary-aware for the same reason cmdRecall reads it
  // that way: a post-`--` literal is query content, not a flag.
  if (hasFlag(argv, '--include-plans')) flags.includePlans = true;
  return runRecall({
    workspace: path.resolve(flags.workspace),
    copilotHome: resolveCopilotHome(flags.copilotHome),
    flags,
    argv,
  });
}

export async function getResultOf(argv) {
  const { runGet } = await import('../get-cmd.mjs');
  const flags = parseFlags(argv);
  return runGet({
    workspace: path.resolve(flags.workspace),
    copilotHome: resolveCopilotHome(flags.copilotHome),
    flags,
  });
}
