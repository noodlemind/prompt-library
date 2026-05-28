import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { resolveIndexDir } from './recall-config.mjs';
import { isIndexStale } from './postings-index.mjs';
import {
  hintIndex,
  hintInitRepo,
  hintInstall,
  hintPostingsIndex,
  hintUpgrade,
} from './cli-hints.mjs';

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
    hint: hintInstall(),
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
    hint: hintInstall(),
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
    hint: hintInitRepo(),
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
      hint: hintUpgrade(),
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
    hint: hintIndex(),
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
    hint: hintPostingsIndex(),
    optional: manifestEntries.length === 0,
  });

  const required = checks.filter((c) => !c.optional);
  const pass = required.every((c) => c.pass);
  return { checks, pass };
}
