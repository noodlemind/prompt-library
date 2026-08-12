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
