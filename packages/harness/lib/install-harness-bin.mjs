import fs from 'fs';
import path from 'path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const COPY_DIRS = ['bin', 'lib', 'config'];
const COPY_FILES = ['package.json', 'retired.json'];
const RUNTIME_DEPENDENCIES = ['yaml'];

/**
 * Copy harness CLI into ~/.copilot/.harness-bin so agents can run without npx.
 */
export function installHarnessBin(pkgRoot, copilotHome, flags, log) {
  const destRoot = path.join(copilotHome, '.harness-bin');
  const stats = { created: 0, updated: 0, files: [] };

  for (const dir of COPY_DIRS) {
    const srcDir = path.join(pkgRoot, dir);
    if (!fs.existsSync(srcDir)) continue;
    for (const ent of fs.readdirSync(srcDir, { withFileTypes: true })) {
      const src = path.join(srcDir, ent.name);
      const rel = path.join(dir, ent.name).replace(/\\/g, '/');
      const dest = path.join(destRoot, rel);
      if (ent.isDirectory()) {
        copyDirRecursive(src, dest, destRoot, flags, log, stats);
      } else {
        copyFile(src, dest, rel, flags, log, stats);
      }
    }
  }

  for (const file of COPY_FILES) {
    const src = path.join(pkgRoot, file);
    if (!fs.existsSync(src)) continue;
    const rel = file;
    const dest = path.join(destRoot, rel);
    copyFile(src, dest, rel, flags, log, stats);
  }

  for (const dependency of RUNTIME_DEPENDENCIES) {
    const src = resolveDependencyRoot(dependency);
    const dest = path.join(destRoot, 'node_modules', dependency);
    copyDirRecursive(src, dest, destRoot, flags, log, stats);
  }

  return stats;
}

function resolveDependencyRoot(name) {
  let current = path.dirname(require.resolve(name));
  while (true) {
    const manifest = path.join(current, 'package.json');
    if (fs.existsSync(manifest)) {
      const pkg = JSON.parse(fs.readFileSync(manifest, 'utf8'));
      if (pkg.name === name) return current;
    }
    const parent = path.dirname(current);
    if (parent === current) throw new Error(`Unable to locate runtime dependency: ${name}`);
    current = parent;
  }
}

function copyDirRecursive(srcDir, destDir, destRoot, flags, log, stats) {
  if (!flags.dryRun) fs.mkdirSync(destDir, { recursive: true });
  for (const ent of fs.readdirSync(srcDir, { withFileTypes: true })) {
    const src = path.join(srcDir, ent.name);
    const rel = path.relative(destRoot, path.join(destDir, ent.name)).replace(/\\/g, '/');
    const dest = path.join(destRoot, rel);
    if (ent.isDirectory()) {
      copyDirRecursive(src, dest, destRoot, flags, log, stats);
    } else {
      copyFile(src, dest, rel, flags, log, stats);
    }
  }
}

function copyFile(src, dest, rel, flags, log, stats) {
  const exists = fs.existsSync(dest);
  if (flags.dryRun) {
    log(`would ${exists ? 'update' : 'create'} harness-bin: ${rel}`);
    stats[exists ? 'updated' : 'created']++;
    stats.files.push(`.harness-bin/${rel}`);
    return;
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
  stats[exists ? 'updated' : 'created']++;
  stats.files.push(`.harness-bin/${rel}`);
  if (flags.verbose) log(`${exists ? 'update' : 'create'} harness-bin: ${rel}`);
}
