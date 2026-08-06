/** Data-only inventory shared by the Harness package builder and eval snapshotter. */

const entries = (values) => Object.freeze(values.map((value) => Object.freeze({ ...value })));

export const HARNESS_ASSET_DIRECTORIES = entries([
  { from: '.github/skills', to: 'skills' },
  { from: '.github/agents', to: 'agents' },
  { from: '.github/instructions', to: 'instructions' },
  { from: '.github/hooks', to: 'hooks' },
  { from: 'knowledge', to: 'knowledge' },
  { from: 'enterprise', to: 'enterprise' },
]);

export const HARNESS_ASSET_FILES = entries([
  { from: '.github/copilot-instructions.md', to: 'copilot-instructions.md' },
]);

export const HARNESS_ASSET_SOURCE_PATHS = Object.freeze(
  [...HARNESS_ASSET_DIRECTORIES, ...HARNESS_ASSET_FILES].map(({ from }) => from),
);
