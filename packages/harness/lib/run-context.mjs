/**
 * The ambient run context — who is driving this process, and which run its
 * writes belong to.
 *
 * WHY AMBIENT, when ambient state is usually a smell: a run is a PROCESS fact.
 * One CLI invocation is exactly one run, established before dispatch and true
 * for every write that follows. Threading it through call sites would model it
 * as a per-call fact, which it is not.
 *
 * The Phase 4a acceptance criterion asks for the ~20 legacy `writeEvent` call
 * sites to be "migrated onto the event registry" so they gain actor metadata.
 * This achieves the same property a better way, and the difference is worth
 * stating rather than glossing: migrating call sites one at a time fixes the
 * twenty that exist and does nothing about the twenty-first, which regresses
 * silently the moment someone adds it. Reading the context inside the single
 * `writeEvent` sink cannot be forgotten by a future call site, because there is
 * nothing for that call site to remember. Same lesson as `dispatchLane`'s exit
 * code: make the correct behavior the default rather than the thing everyone
 * has to opt into.
 *
 * A payload that supplies its own `run`/`actor` still wins — the event registry
 * stamps both explicitly, and this must not override a caller that knows more
 * than the ambient default does.
 */

let current = { run: null, actor: null };

/** Establish the context for this process. Called once, from bin/harness.mjs,
 * after the run id is minted. */
export function setRunContext({ run = null, actor = null } = {}) {
  current = { run, actor };
  return current;
}

export function currentRunContext() {
  return current;
}

/** Test seam: restore the empty context so one test's process-level state
 * cannot leak into the next. */
export function clearRunContext() {
  current = { run: null, actor: null };
}
