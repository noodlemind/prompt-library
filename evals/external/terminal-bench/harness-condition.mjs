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

const DEFAULT_ACTIVATION = ['harness install'];

export function buildHarnessCondition({ instruction, limits, engineerContract, guidance = '', activationCommands = DEFAULT_ACTIVATION } = {}) {
  if (!instruction) throw new Error('instruction is required');
  if (!limits) throw new Error('limits is required');
  if (!engineerContract) throw new Error('engineerContract is required');
  const sections = [NEUTRAL_SYSTEM_PROMPT, engineerContract];
  if (guidance) sections.push(guidance);
  return {
    id: 'harness',
    systemPrompt: sections.join('\n\n'),
    instruction,
    setupCommands: [...activationCommands],
    limits: { ...limits },
  };
}
