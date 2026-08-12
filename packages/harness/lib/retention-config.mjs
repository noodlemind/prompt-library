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
