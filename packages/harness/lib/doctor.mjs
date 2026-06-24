import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { resolveIndexDir } from './recall-config.mjs';
import { isIndexStale } from './postings-index.mjs';
import { resolveHarnessBin } from './resolve-harness-bin.mjs';
import { globalHarnessShimPath, findHarnessOnPath } from './global-bin.mjs';

const require = createRequire(import.meta.url);

const MIN_ENRICHED_RATIO = 0.5;

function isEntryEnriched(e) {
  return Boolean((e.symptom && e.symptom.trim()) || (e.module && e.module.trim()));
}

function loadManifestEntries(manifestPath) {
  if (!fs.existsSync(manifestPath)) return { entries: [], updated: null };
  try {
    const yaml = require('yaml');
    const doc = yaml.parse(fs.readFileSync(manifestPath, 'utf8'));
    return { entries: doc.entries || [], updated: doc.updated || null };
  } catch {
    return { entries: [], updated: null };
  }
}

export function runDoctor({ copilotHome, assetsRoot, pkgRoot, flags }) {
  const checks = [];

  const manifest = path.join(copilotHome, 'knowledge', 'manifest.yaml');
  const manifestRepo = path.join(assetsRoot, 'knowledge', 'manifest.yaml');
  checks.push({
    id: 'H1',
    name: 'Global knowledge manifest',
    pass: fs.existsSync(manifest) || fs.existsSync(manifestRepo),
    hint: 'Run: npx @dev-kit/harness install',
  });

  const profile = path.join(copilotHome, 'knowledge', 'profile.md');
  checks.push({
    id: 'H2',
    name: 'Profile (autonomy)',
    pass: fs.existsSync(profile),
    hint: 'install seeds knowledge/profile.md from template',
  });

  const engineer = path.join(copilotHome, 'agents', 'engineer.agent.md');
  const engineerAsset = path.join(assetsRoot, 'agents', 'engineer.agent.md');
  checks.push({
    id: 'H3',
    name: 'Engineer agent',
    pass: fs.existsSync(engineer) || fs.existsSync(engineerAsset),
    hint: 'Run: npx @dev-kit/harness install',
  });

  const captureGate = path.join(
    copilotHome,
    'skills',
    'references',
    'capture-gate.md'
  );
  checks.push({
    id: 'H4',
    name: 'Capture gate reference',
    pass:
      fs.existsSync(captureGate) ||
      fs.existsSync(path.join(assetsRoot, 'skills', 'references', 'capture-gate.md')),
    hint: 'Re-run install',
  });

  checks.push({
    id: 'H5',
    name: 'Product docs/plans (cwd)',
    pass: fs.existsSync(path.join(flags.workspace, 'docs', 'plans')),
    hint: 'npx @dev-kit/harness init-repo',
  });

  const entReg = path.join(copilotHome, 'enterprise', 'capability-registry.enterprise.yaml');
  checks.push({
    id: 'H6',
    name: 'Enterprise overlay (optional)',
    pass: fs.existsSync(entReg) || fs.existsSync(path.join(assetsRoot, 'enterprise', 'capability-registry.enterprise.yaml')),
    hint: 'Optional: add enterprise pack or install base harness',
    optional: true,
  });

  for (const skill of ['ensure-plan', 'auto-compound', 'ensure-capability']) {
    const p = path.join(copilotHome, 'skills', skill, 'SKILL.md');
    checks.push({
      id: 'H7',
      name: `Autopilot skill /${skill}`,
      pass: fs.existsSync(p) || fs.existsSync(path.join(assetsRoot, 'skills', skill, 'SKILL.md')),
      hint: 'Upgrade to latest @dev-kit/harness',
    });
  }

  checks.push({
    id: 'H8',
    name: 'Assets bundle in package',
    pass: fs.existsSync(assetsRoot),
    hint: 'Maintainer: npm run build:assets before publish',
  });

  const lockPath = path.join(copilotHome, '.harness-lock.json');
  checks.push({
    id: 'H9',
    name: 'Harness lock file',
    pass: fs.existsSync(lockPath),
    hint: 'Run install or upgrade',
    optional: true,
  });

  const manifestPath = fs.existsSync(manifest)
    ? manifest
    : fs.existsSync(path.join(flags.workspace, 'knowledge', 'manifest.yaml'))
      ? path.join(flags.workspace, 'knowledge', 'manifest.yaml')
      : manifestRepo;
  const { entries: manifestEntries, updated: manifestUpdated } = loadManifestEntries(manifestPath);
  const enrichedCount = manifestEntries.filter(isEntryEnriched).length;
  const hasEnrichedFields =
    manifestEntries.length === 0 ||
    enrichedCount / manifestEntries.length >= MIN_ENRICHED_RATIO;
  checks.push({
    id: 'H10',
    name: 'Manifest enriched fields (symptom/module)',
    pass: hasEnrichedFields,
    hint: 'Run: harness index — rebuild manifest with symptom/module/excerpt',
    optional: manifestEntries.length === 0,
  });

  const indexDir = resolveIndexDir(copilotHome, flags.workspace);
  const indexFresh =
    manifestEntries.length === 0 || !fs.existsSync(path.join(indexDir, 'meta.json'))
      ? false
      : !isIndexStale(indexDir, manifestUpdated);
  checks.push({
    id: 'H11',
    name: 'BM25 postings index fresh',
    pass: indexFresh,
    hint: 'Run: harness index — rebuild .harness-index/postings.json',
    optional: manifestEntries.length === 0,
  });

  const resolved = resolveHarnessBin({ workspace: flags.workspace, copilotHome });
  const runnerPath = path.join(flags.workspace, '.harness', 'run.mjs');
  checks.push({
    id: 'H12',
    name: 'Harness CLI resolvable',
    pass: Boolean(resolved.bin),
    hint: resolved.bin
      ? `Resolved via ${resolved.source}: ${resolved.bin}`
      : 'Run: harness install, then init-repo (creates .harness/run.mjs)',
  });
  checks.push({
    id: 'H13',
    name: 'Workspace harness runner',
    pass: fs.existsSync(runnerPath),
    hint: 'Run: harness init-repo',
    optional: true,
  });

  const hooksJson = path.join(copilotHome, 'hooks', 'hooks.json');
  const hooksAsset = path.join(assetsRoot, 'hooks', 'hooks.json');
  checks.push({
    id: 'H14',
    name: 'Lifecycle hooks bundle',
    pass: fs.existsSync(hooksJson) || fs.existsSync(hooksAsset),
    hint: 'Re-run harness install to sync .github/hooks/',
    optional: true,
  });

  const shim = globalHarnessShimPath(copilotHome);
  const cliResolvable = Boolean(resolved.bin);
  checks.push({
    id: 'H15',
    name: 'Global harness shim (~/.copilot/bin/harness)',
    pass: fs.existsSync(shim),
    hint: 'Run: harness install (creates ~/.copilot/bin/harness)',
    optional: cliResolvable && !fs.existsSync(shim),
  });

  const onPath = Boolean(findHarnessOnPath());
  checks.push({
    id: 'H16',
    name: 'harness on PATH',
    pass: onPath,
    hint: 'Run: harness install --configure-path  (or add ~/.copilot/bin to PATH)',
    optional: true,
  });

  const required = checks.filter((c) => !c.optional);
  const pass = required.every((c) => c.pass);
  return { checks, pass };
}
