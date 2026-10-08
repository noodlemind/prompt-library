import fs from 'node:fs';

export function copyDirectorySync(source, target, options = {}) {
  // A filter selects JS traversal; Node 22's native copy can silently omit accented Windows paths.
  fs.cpSync(source, target, { ...options, recursive: true, filter: () => true });
}
