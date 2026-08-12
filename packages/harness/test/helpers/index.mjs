/**
 * Shared harness test fixtures. Prefer these over local tempDir/runHarness copies.
 */
export { tempDir, withTemp, withTempSync } from './temp.mjs';
export { makeScopes, ensureWorkspaceLayout } from './workspace.mjs';
export { writePlan } from './plan.mjs';
export { approveTrust, approveProject } from './trust.mjs';
export { runHarness, valueOf, packageRoot, binPath } from './cli.mjs';
export { git, storeScopes, writeOps, TEST_GIT_ENV } from './store.mjs';
export { fakeTty } from './tty.mjs';
