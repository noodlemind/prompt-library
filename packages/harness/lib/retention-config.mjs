/**
 * The retention window for one workspace.
 *
 * Split out of `lib/retention.mjs` so that module stays a pure file operation
 * with no opinion about configuration, and out of `lib/events.mjs` so the write
 * path is not entangled with config resolution.
 *
 * FAILURE IS NOT FATAL. An unreadable or untrusted configuration falls back to
 * the default window, because refusing to write an event because retention
 * could not be computed would lose the very record the caller was trying to
 * keep. Retention decides what to discard later; it must never decide what to
 * refuse now.
 */
import { resolveConfig } from './config.mjs';
import { isProjectTrusted } from './trust.mjs';
import { resolveCopilotHome } from './paths.mjs';
import { DEFAULT_RETENTION_DAYS } from './retention.mjs';

export function retentionDaysFor(workspace, flags = {}) {
  try {
    const copilotHome = resolveCopilotHome(flags.copilotHome);
    const config = resolveConfig({
      copilotHome,
      workspace,
      projectTrusted: isProjectTrusted({ workspace, copilotHome }),
    });
    const days = config.values['runs.retention_days'];
    return Number.isInteger(days) && days > 0 ? days : DEFAULT_RETENTION_DAYS;
  } catch {
    return DEFAULT_RETENTION_DAYS;
  }
}
