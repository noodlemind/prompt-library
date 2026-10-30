import fs from 'fs';
import path from 'path';
import { createRequire } from 'node:module';
import { readLock } from './lock.mjs';
import { resolveContainedPath } from './sync.mjs';

const require = createRequire(import.meta.url);
const COPY_DIRS = ['bin', 'lib', 'config', 'corpus', 'vscode-extension'];
const COPY_FILES = ['package.json', 'retired.json'];

/**
 * Copy harness CLI into ~/.copilot/.ae-bin so agents can run without npx.
 */
export function installHarnessBin(pkgRoot, copilotHome, flags, log) {
  const stats = { created: 0, updated: 0, removed: 0, files: [] };
  const previous = readLock(copilotHome);
  const previousFiles = Array.isArray(previous?.files) ? previous.files : [];
  const sources = [];

  for (const dir of COPY_DIRS) {
    const srcDir = path.join(pkgRoot, dir);
    if (!fs.existsSync(srcDir)) continue;
    collectFiles(srcDir, dir, sources);
  }

  for (const file of COPY_FILES) {
    const src = path.join(pkgRoot, file);
    if (!fs.existsSync(src)) continue;
    sources.push({ src, rel: file });
  }

  const manifest = JSON.parse(fs.readFileSync(path.join(pkgRoot, 'package.json'), 'utf8'));
  for (const dependency of Object.keys(manifest.dependencies || {})) {
    const src = resolveDependencyRoot(dependency);
    collectFiles(src, `node_modules/${dependency}`, sources);
  }

  // Refuse unsafe targets before replacing any part of the current runtime.
  for (const { rel } of sources) runtimeTarget(copilotHome, rel);
  for (const { src, rel } of sources) {
    copyFile(src, runtimeTarget(copilotHome, rel), rel, flags, log, stats);
  }

  const legacyRel = '.harness-bin/bin/harness.mjs';
  if (['harness', 'ae-harness'].includes(previous?.package) && previousFiles.includes(legacyRel)) {
    const segments = ['.harness-bin', '.harness-bin/bin', legacyRel];
    const managed = segments.every((relative, index) => {
      const stat = fs.lstatSync(path.join(copilotHome, relative), { throwIfNoEntry: false });
      return stat && !stat.isSymbolicLink() && (index === segments.length - 1 ? stat.isFile() : stat.isDirectory());
    });
    if (managed) {
      if (!flags.dryRun) fs.writeFileSync(path.join(copilotHome, legacyRel), "#!/usr/bin/env node\nimport { main } from '../../.ae-bin/bin/ae.mjs';\n\nawait main();\n");
      stats.updated++;
      stats.files.push(legacyRel);
      log(`${flags.dryRun ? 'would update' : 'updated'} owned legacy runtime: ${legacyRel}`);
    }
  }

  if (['harness', 'ae-harness'].includes(previous?.package)) {
    const current = new Set(stats.files);
    for (const rel of new Set(previousFiles)) {
      if (typeof rel !== 'string' || !rel.startsWith('.ae-bin/') || current.has(rel)) continue;
      const stale = resolveContainedPath(copilotHome, rel);
      if (!stale || !fs.lstatSync(stale, { throwIfNoEntry: false })?.isFile()) continue;
      log(`${flags.dryRun ? 'would remove' : 'removed'} obsolete harness-bin: ${rel}`);
      if (!flags.dryRun) fs.unlinkSync(stale);
      stats.removed++;
    }
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

function collectFiles(srcDir, relative, files) {
  for (const ent of fs.readdirSync(srcDir, { withFileTypes: true })) {
    const src = path.join(srcDir, ent.name);
    const rel = `${relative}/${ent.name}`;
    if (ent.isDirectory()) {
      collectFiles(src, rel, files);
    } else {
      files.push({ src, rel });
    }
  }
}

function runtimeTarget(copilotHome, rel) {
  const target = resolveContainedPath(copilotHome, `.ae-bin/${rel}`);
  if (!target) throw Object.assign(new Error(`refusing an unsafe runtime target: ${rel}`), { code: 'E_TARGET', exit: 1 });
  return target;
}

function copyFile(src, dest, rel, flags, log, stats) {
  const exists = fs.existsSync(dest);
  if (flags.dryRun) {
    log(`would ${exists ? 'update' : 'create'} harness-bin: ${rel}`);
    stats[exists ? 'updated' : 'created']++;
    stats.files.push(`.ae-bin/${rel}`);
    return;
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
  stats[exists ? 'updated' : 'created']++;
  stats.files.push(`.ae-bin/${rel}`);
  if (flags.verbose) log(`${exists ? 'update' : 'create'} harness-bin: ${rel}`);
}
