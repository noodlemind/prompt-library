/** Canonical inventory shared by the Harness package builder and eval snapshotter. */

const entries = (values) => Object.freeze(values.map((value) => Object.freeze({ ...value })));
const FORBIDDEN_DESTINATION_SEGMENTS = new Set(['eval', 'evals', 'test', 'tests']);

function assertSafeRelativePath(value, label) {
  const segments = typeof value === 'string' ? value.split('/') : [];
  if (typeof value !== 'string'
      || segments.length === 0
      || segments.some((segment) => segment === '' || segment === '.' || segment === '..')
      || value.includes('\0')
      || value.includes('\\')
      || value.startsWith('/')
      || /^[a-z]:/i.test(value)) {
    throw new Error(`unsafe Harness asset ${label}: ${String(value)}`);
  }
  return segments;
}

function portablePathKey(value) {
  return value.normalize('NFC').toLowerCase();
}

function pathsOverlap(left, right) {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

export function validateHarnessAssetMappings({ directories, files } = {}) {
  if (!Array.isArray(directories) || !Array.isArray(files)) {
    throw new TypeError('Harness asset directory and file mappings must be arrays');
  }

  const destinations = [];
  for (const [kind, mappings] of [['directory', directories], ['file', files]]) {
    for (const mapping of mappings) {
      if (mapping == null || typeof mapping !== 'object' || Array.isArray(mapping)) {
        throw new TypeError(`Harness asset ${kind} mapping must be an object`);
      }
      assertSafeRelativePath(mapping.from, 'source');
      const destinationSegments = assertSafeRelativePath(mapping.to, 'destination');
      if (destinationSegments.some((segment) => FORBIDDEN_DESTINATION_SEGMENTS.has(segment.toLowerCase()))) {
        throw new Error(`forbidden Harness asset destination: ${mapping.to}`);
      }

      const destinationKey = portablePathKey(mapping.to);
      const conflict = destinations.find(({ key }) => pathsOverlap(key, destinationKey));
      if (conflict?.key === destinationKey) {
        throw new Error(`duplicate Harness asset destination: ${mapping.to}`);
      }
      if (conflict) {
        throw new Error(
          `overlapping Harness asset destinations: ${conflict.value} and ${mapping.to}`,
        );
      }
      destinations.push({ key: destinationKey, value: mapping.to });
    }
  }
  return true;
}

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

validateHarnessAssetMappings({
  directories: HARNESS_ASSET_DIRECTORIES,
  files: HARNESS_ASSET_FILES,
});

export const HARNESS_ASSET_SOURCE_PATHS = Object.freeze(
  [...HARNESS_ASSET_DIRECTORIES, ...HARNESS_ASSET_FILES].map(({ from }) => from),
);
