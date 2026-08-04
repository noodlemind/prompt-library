/**
 * Generic condition: the untreated baseline of the A/B pair.
 *
 * The baseline gets the original Terminal-Bench instruction and a neutral,
 * competent software-engineering prompt — deliberately fair (it encourages
 * exploring, testing, and verifying) but with zero Engineer Harness workflow:
 * no contract, no loaded-skill guidance, no activation commands. Wording here
 * is checked by tests to keep harness vocabulary from leaking into the
 * control arm.
 */
import { buildPromptComponentManifest } from '../../lib/prompt-manifest.mjs';

export { buildPromptComponentManifest } from '../../lib/prompt-manifest.mjs';

export const NEUTRAL_SYSTEM_PROMPT = [
  'You are an experienced software engineer working in a Linux terminal.',
  'Complete the task exactly as instructed.',
  'Explore the environment first to understand the code and data you are working with.',
  'Make focused changes, run the relevant commands and tests, and verify your outputs meet the requirements before you finish.',
  'Prefer small, checkable steps over large speculative changes.',
].join(' ');

export function buildGenericCondition({ instruction, limits } = {}) {
  if (!instruction) throw new Error('instruction is required');
  if (!limits) throw new Error('limits is required');
  const prompt = buildPromptComponentManifest([
    { id: 'neutral-system', content: NEUTRAL_SYSTEM_PROMPT },
  ]);
  return {
    id: 'generic',
    systemPrompt: prompt.systemPrompt,
    promptComponentManifest: prompt.manifest,
    instruction,
    setupCommands: [],
    limits: { ...limits },
  };
}
