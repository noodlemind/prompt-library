/**
 * Harness condition: the treatment arm of the A/B pair.
 *
 * Identical baseline (same neutral prompt, same instruction, same limits)
 * plus everything the Engineer Harness adds: the engineer agent contract,
 * loaded-skill guidance, and CLI activation commands run at sandbox setup.
 * The added context and setup cost are deliberately charged to this arm —
 * they are real product overhead.
 */
import { NEUTRAL_SYSTEM_PROMPT } from './generic-condition.mjs';
import { buildPromptComponentManifest } from '../../lib/prompt-manifest.mjs';
import { activationCommands, BUNDLE_MOUNT_TARGET } from './provision.mjs';

// The task image has no Node and no Harness; activation installs the mounted
// bundle's wrapper on PATH and proves the CLI answers (setup fails closed).
const DEFAULT_ACTIVATION = activationCommands();
const IMMUTABLE_CLI_GUIDANCE = [
  `The Engineer Harness CLI is available only at ${BUNDLE_MOUNT_TARGET}/harness-cli.`,
  `Invoke that absolute read-only path for every Harness command (for example, ${BUNDLE_MOUNT_TARGET}/harness-cli verify ...).`,
  'Do not install, copy, or symlink the Harness CLI into /usr/bin, /usr/local/bin, the workspace, or another writable path.',
].join(' ');

export function buildHarnessCondition({ instruction, limits, engineerContract, guidance = '', activationCommands = DEFAULT_ACTIVATION } = {}) {
  if (!instruction) throw new Error('instruction is required');
  if (!limits) throw new Error('limits is required');
  if (!engineerContract) throw new Error('engineerContract is required');
  const prompt = buildPromptComponentManifest([
    { id: 'neutral-system', content: NEUTRAL_SYSTEM_PROMPT },
    { id: 'engineer-contract', content: engineerContract },
    { id: 'immutable-cli-guidance', content: IMMUTABLE_CLI_GUIDANCE },
    { id: 'guidance-index', content: guidance },
  ]);
  return {
    id: 'harness',
    systemPrompt: prompt.systemPrompt,
    promptComponentManifest: prompt.manifest,
    instruction,
    setupCommands: [...activationCommands],
    limits: { ...limits },
  };
}
