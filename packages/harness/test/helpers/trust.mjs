/**
 * Trust approval helpers for CLI tests that need an approved project.
 */
import { approveProject } from '../../lib/trust.mjs';

/**
 * Best-effort approve — fixtures without a writable home skip silently.
 * @param {{ workspace: string, copilotHome: string }} scopes
 */
export function approveTrust(scopes) {
  try {
    approveProject(scopes);
  } catch {
    /* unwritable home fixtures do not need trust */
  }
}

export { approveProject };
