import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

const SYNC_TOP_LEVEL = ['skills', 'agents', 'instructions', 'hooks', 'knowledge', 'enterprise'];

const KNOWLEDGE_PRESERVE_PREFIXES = ['knowledge/solutions/'];
const KNOWLEDGE_NEVER_OVERWRITE = ['knowledge/profile.md'];

export function loadRetired(pkgRoot) {
  const p = path.join(pkgRoot, 'retired.json');
  if (!fs.existsSync(p)) return [];
  const data = JSON.parse(fs.readFileSync(p, 'utf8'));
  return data.retired || [];
}

// Primitive directories that accumulate orphans across versions. Knowledge and
// enterprise are excluded: they hold user- and enterprise-owned content, not
// harness-shipped primitives, so their extra files are not orphans.
const ORPHAN_SCAN_DIRS = ['skills', 'agents', 'instructions', 'prompts', 'hooks'];

/**
 * Stale orphans: files hydrated in the Copilot home that current assets no
 * longer ship AND retired.json does not cover — i.e. leftovers from an older
 * harness that upgrade will not clean because nobody tombstoned them. Returns
 * the sorted relative paths so `doctor` can flag them for retirement.
 */
export function findStaleOrphans(copilotHome, assetsRoot, retiredList = []) {
  const current = new Set();
  for (const top of SYNC_TOP_LEVEL) {
    for (const f of walkFiles(path.join(assetsRoot, top))) current.add(`${top}/${f}`);
  }
  const retiredCovered = (rel) =>
    retiredList.some((r) => {
      const base = String(r).replace(/\/$/, '');
      return rel === base || rel.startsWith(`${base}/`);
    });

  const orphans = [];
  for (const top of ORPHAN_SCAN_DIRS) {
    for (const f of walkFiles(path.join(copilotHome, top))) {
      const rel = `${top}/${f}`;
      if (current.has(rel)) continue; // still shipped
      if (retiredCovered(rel)) continue; // explicitly retired — upgrade removes it
      orphans.push(rel);
    }
  }
  return orphans.sort();
}

export function resolveContainedPath(root, rel) {
  if (!rel || typeof rel !== 'string') return null;
  if (path.isAbsolute(rel) || path.win32.isAbsolute(rel)) return null;

  const parts = rel.replace(/\\/g, '/').split('/');
  if (parts.some((part) => part === '..')) return null;

  const rootResolved = path.resolve(root);
  const dest = path.resolve(rootResolved, ...parts.filter(Boolean));
  const relative = path.relative(rootResolved, dest);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return null;
  return dest;
}

function fileHash(filePath) {
  const buf = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function renderTargetAsset(src, rel, targetRoot) {
  if (rel !== 'hooks/hooks.json') return null;
  const config = JSON.parse(fs.readFileSync(src, 'utf8'));
  for (const entries of Object.values(config.hooks || {})) {
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      const commands = Array.isArray(entry.hooks) ? entry.hooks : [entry];
      for (const command of commands) {
        if (command?.cwd === '.github/hooks') command.cwd = path.join(targetRoot, 'hooks');
      }
    }
  }
  return Buffer.from(`${JSON.stringify(config, null, 2)}\n`, 'utf8');
}

function walkFiles(dir, base = dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) out.push(...walkFiles(full, base));
    else if (ent.isFile()) out.push(path.relative(base, full).split(path.sep).join('/'));
  }
  return out;
}

function shouldSkipDest(rel, flags, destExists) {
  if (!flags.preserveKnowledge || !destExists) return false;
  const norm = rel.replace(/\\/g, '/');
  if (KNOWLEDGE_NEVER_OVERWRITE.some((p) => norm === p)) return true;
  if (KNOWLEDGE_PRESERVE_PREFIXES.some((p) => norm.startsWith(p))) return true;
  return false;
}

export function applyRetired(copilotHome, retiredList, previousLock, flags, log) {
  const stats = { removed: 0, skipped: 0 };
  const prevFiles = new Set(previousLock?.files || []);
  for (const rel of retiredList) {
    if (!prevFiles.has(rel)) {
      stats.skipped++;
      continue;
    }
    const dest = resolveContainedPath(copilotHome, rel);
    if (!dest) {
      log(`warn: skipped unsafe retired path: ${rel}`);
      stats.skipped++;
      continue;
    }
    if (!fs.existsSync(dest)) continue;
    if (flags.dryRun) {
      log(`would remove retired: ${rel}`);
      stats.removed++;
      continue;
    }
    fs.rmSync(dest, { recursive: true, force: true });
    log(`removed retired: ${rel}`);
    stats.removed++;
  }
  return stats;
}

export function syncAssetsToTarget(assetsRoot, targetRoot, flags, log) {
  const stats = { created: 0, updated: 0, skipped: 0, unchanged: 0, files: [] };

  for (const top of SYNC_TOP_LEVEL) {
    const srcDir = path.join(assetsRoot, top);
    if (!fs.existsSync(srcDir)) continue;
    const relFiles = walkFiles(srcDir, srcDir).map((f) => `${top}/${f}`);
    for (const rel of relFiles) {
      const src = path.join(assetsRoot, rel);
      const dest = path.join(targetRoot, rel);
      const destDir = path.dirname(dest);
      const relPosix = rel.replace(/\\/g, '/');
      const rendered = renderTargetAsset(src, relPosix, targetRoot);

      if (shouldSkipDest(relPosix, flags, fs.existsSync(dest))) {
        stats.skipped++;
        if (flags.verbose) log(`skip preserve: ${relPosix}`);
        continue;
      }

      let action = 'create';
      if (fs.existsSync(dest)) {
        try {
          const same = rendered
            ? fs.readFileSync(dest).equals(rendered)
            : fs.statSync(src).size === fs.statSync(dest).size && fileHash(src) === fileHash(dest);
          if (same) {
            stats.unchanged++;
            stats.files.push(relPosix);
            if (flags.verbose) log(`unchanged: ${relPosix}`);
            continue;
          }
        } catch {
          /* copy */
        }
        action = 'update';
      }

      if (flags.dryRun) {
        log(`would ${action}: ${relPosix}`);
        stats[action === 'create' ? 'created' : 'updated']++;
        stats.files.push(relPosix);
        continue;
      }

      fs.mkdirSync(destDir, { recursive: true });
      if (rendered) fs.writeFileSync(dest, rendered);
      else fs.copyFileSync(src, dest);
      stats[action === 'create' ? 'created' : 'updated']++;
      stats.files.push(relPosix);
      if (flags.verbose) log(`${action}: ${relPosix}`);
    }
  }

  const copilotMd = path.join(assetsRoot, 'copilot-instructions.md');
  if (fs.existsSync(copilotMd)) {
    const rel = 'copilot-instructions.md';
    const dest = path.join(targetRoot, rel);
    const srcHash = fileHash(copilotMd);
    const destHash = fs.existsSync(dest) ? fileHash(dest) : null;
    if (srcHash !== destHash) {
      if (!flags.dryRun) {
        fs.mkdirSync(targetRoot, { recursive: true });
        fs.copyFileSync(copilotMd, dest);
      }
      stats[destHash ? 'updated' : 'created']++;
      log(flags.dryRun ? `would update: ${rel}` : `update: ${rel}`);
    } else {
      stats.unchanged++;
    }
    stats.files.push(rel);
  }

  return stats;
}

export function seedProfile(assetsRoot, targetRoot, flags, log) {
  const template = path.join(assetsRoot, 'knowledge', 'profile.md.template');
  const dest = path.join(targetRoot, 'knowledge', 'profile.md');
  if (!fs.existsSync(template)) return;
  if (fs.existsSync(dest) && !flags.forceProfile) {
    if (flags.verbose) log('skip profile.md (exists)');
    return;
  }
  let content = fs.readFileSync(template, 'utf8');
  if (flags.autonomy) {
    content = content.replace(
      /(\*\*autonomy:\*\*\s*)(\w+)/,
      `$1${flags.autonomy}`
    );
  }
  if (!flags.dryRun) {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, content, 'utf8');
  }
  log(flags.dryRun ? 'would write knowledge/profile.md' : 'wrote knowledge/profile.md');
}

export function mergeIntelliJInstructions(assetsRoot, intellijRoot, flags, log) {
  const instrDir = path.join(assetsRoot, 'instructions');
  if (!fs.existsSync(instrDir)) return;
  const files = fs
    .readdirSync(instrDir)
    .filter((f) => f.endsWith('.instructions.md'))
    .sort((a, b) => {
      if (a === 'prompt-library-global.instructions.md') return -1;
      if (b === 'prompt-library-global.instructions.md') return 1;
      return a.localeCompare(b);
    });
  const parts = [];
  for (const f of files) {
    let text = fs.readFileSync(path.join(instrDir, f), 'utf8');
    text = text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '');
    parts.push(`<!-- Source: ${f} -->\n${text.trim()}`);
  }
  if (parts.length === 0) return;
  const dest = path.join(intellijRoot, 'global-copilot-instructions.md');
  const body = parts.join('\n\n');
  if (!flags.dryRun) {
    fs.mkdirSync(intellijRoot, { recursive: true });
    fs.writeFileSync(dest, body, 'utf8');
  }
  log(flags.dryRun ? 'would write IntelliJ global-copilot-instructions.md' : 'wrote IntelliJ global-copilot-instructions.md');
}

export function collectAllAssetFiles(assetsRoot) {
  const files = new Set();
  for (const top of SYNC_TOP_LEVEL) {
    const dir = path.join(assetsRoot, top);
    for (const f of walkFiles(dir, dir)) files.add(`${top}/${f}`.replace(/\\/g, '/'));
  }
  if (fs.existsSync(path.join(assetsRoot, 'copilot-instructions.md'))) {
    files.add('copilot-instructions.md');
  }
  return [...files].sort();
}
