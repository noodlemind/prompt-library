import fs from 'node:fs';
import path from 'node:path';
import { pkgRootFromImportMeta } from './paths.mjs';

export const pkgRoot = pkgRootFromImportMeta(import.meta.url);

export function readPkgVersion() {
  const p = JSON.parse(fs.readFileSync(path.join(pkgRoot, 'package.json'), 'utf8'));
  return p.version;
}

export function getCorpusRoot() {
  const root = path.join(pkgRoot, 'corpus');
  if (!fs.existsSync(path.join(root, 'skills', 'engineer', 'SKILL.md'))) {
    throw new Error('Package corpus not found. Reinstall the packaged CLI with: npm install -g harness.');
  }
  return root;
}
