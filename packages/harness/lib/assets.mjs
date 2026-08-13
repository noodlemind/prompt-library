import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { pkgRootFromImportMeta } from './paths.mjs';

export const pkgRoot = pkgRootFromImportMeta(import.meta.url);

export function readPkgVersion() {
  const p = JSON.parse(fs.readFileSync(path.join(pkgRoot, 'package.json'), 'utf8'));
  return p.version;
}

function hookAssetsStale(sourceHooks, bundledHooks) {
  if (!fs.existsSync(sourceHooks)) return false;
  const files = [
    'block-destructive-commands.mjs',
    'require-plan-gate.mjs',
    'lib/tool-payload.mjs',
  ];
  return files.some((rel) => {
    const src = path.join(sourceHooks, rel);
    const dst = path.join(bundledHooks, rel);
    if (!fs.existsSync(src)) return false;
    if (!fs.existsSync(dst)) return true;
    return fs.statSync(src).mtimeMs > fs.statSync(dst).mtimeMs;
  });
}

export function getAssetsRoot() {
  const bundled = path.join(pkgRoot, 'assets');
  const sourceHooks = path.resolve(pkgRoot, '../../.github/hooks');
  const bundledHooks = path.join(bundled, 'hooks');
  const skillsOk = fs.existsSync(path.join(bundled, 'skills', 'engineer', 'SKILL.md'));
  const hooksOk = fs.existsSync(path.join(bundled, 'hooks', 'hooks.json'));
  if (skillsOk && hooksOk && !hookAssetsStale(sourceHooks, bundledHooks)) {
    return bundled;
  }
  const buildScript = path.resolve(pkgRoot, '../../scripts/build-harness-assets.mjs');
  if (fs.existsSync(buildScript)) {
    execSync(`node "${buildScript}"`, { cwd: pkgRoot, stdio: 'pipe' });
    if (fs.existsSync(path.join(bundled, 'skills')) && fs.existsSync(path.join(bundled, 'hooks', 'hooks.json'))) {
      return bundled;
    }
  }
  if (skillsOk && hooksOk) return bundled;
  throw new Error(
    'Package assets not found. From a prompt-library clone run: npm --prefix packages/harness run build:assets. Otherwise reinstall the packaged CLI with: npm install -g @dev-kit/harness.'
  );
}
