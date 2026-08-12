import path from 'node:path';
import { parseFlags, hasFlag } from '../flags.mjs';
import { resolveCopilotHome } from '../paths.mjs';

export async function recallResultOf(argv) {
  const { runRecall } = await import('../recall-cmd.mjs');
  const flags = parseFlags(argv);
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
