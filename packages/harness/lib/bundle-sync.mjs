/**
 * Placing an enabled bundle's contributions into `~/.copilot` (P5AC1).
 *
 * This is the piece that makes a bundle mean anything. Everything else —
 * manifests, precedence, integrity, approval — decides WHETHER a contribution
 * counts; this decides where it lands, and takes it away again when it stops
 * counting.
 *
 * IT EXTENDS THE EXISTING PIPELINE RATHER THAN PARALLELING IT. `install` and
 * `upgrade` already place files and already know how to withdraw what they
 * placed; bundles ride the same call, after the package's own sync, and their
 * placements are recorded so removal is exact. The contract is explicit that a
 * second mechanism would get retirement wrong, and retirement is the half
 * nobody notices until a file that should have vanished is still being loaded.
 *
 * THE PACKAGE ALWAYS WINS. A bundle contributing a path the harness itself
 * ships is refused rather than layered over it. Letting a bundle replace
 * `skills/engineer/SKILL.md` would let an installed extension silently redefine
 * the harness's own behavior, which is a different and much larger permission
 * than "add a skill". Bundle-versus-bundle conflicts are decided by the
 * declared precedence and reported; bundle-versus-package is simply not
 * allowed.
 *
 * PLACEMENTS ARE RECORDED SEPARATELY FROM THE PACKAGE LOCK. The lock is what
 * the harness package put there; a bundle's files are not the package's, and
 * mixing them would make `uninstall` remove someone's bundle or leave the
 * package's own files behind. `harness/bundles.yaml` records who placed what.
 */
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { writeFileContained } from './fs-safe.mjs';
import { CONTRIBUTION_KINDS, discoverBundles, resolvePrecedence } from './resources.mjs';

export const PLACEMENTS_FILE = path.join('harness', 'bundles.yaml');
export const PLACEMENTS_SCHEMA = 1;

/**
 * Bundles the operator has approved, keyed by DIRECTORY name.
 *
 * Lives here rather than in the command so `install` and `resources` cannot
 * disagree about what "approved" means — two definitions of a trust predicate
 * is one definition too many.
 */
export function approvedBundleNames(copilotHome) {
  const root = path.join(copilotHome, 'resources');
  if (!fs.existsSync(root)) return new Set();
  const names = new Set();
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (entry.isDirectory() && fs.existsSync(path.join(root, entry.name, '.enabled'))) names.add(entry.name);
  }
  return names;
}

export function placementsPath(copilotHome) {
  return path.join(copilotHome, PLACEMENTS_FILE);
}

export function readPlacements(copilotHome) {
  const file = placementsPath(copilotHome);
  if (!fs.existsSync(file)) return { version: PLACEMENTS_SCHEMA, bundles: {} };
  try {
    const doc = YAML.parse(fs.readFileSync(file, 'utf8'), { maxAliasCount: 50 });
    const bundles = doc?.bundles;
    if (!bundles || typeof bundles !== 'object' || Array.isArray(bundles)) {
      return { version: PLACEMENTS_SCHEMA, bundles: {}, unreadable: true };
    }
    return { version: doc.version || PLACEMENTS_SCHEMA, bundles };
  } catch {
    // Damaged, not empty — the same rule the trust and registration stores
    // follow. Rewriting it would orphan every file it recorded, leaving them
    // placed and unremovable.
    return { version: PLACEMENTS_SCHEMA, bundles: {}, unreadable: true };
  }
}

function writePlacements(copilotHome, placements) {
  const written = writeFileContained(copilotHome, PLACEMENTS_FILE, YAML.stringify(placements));
  if (!written) throw Object.assign(new Error(`could not write ${placementsPath(copilotHome)}`), { code: 'E_TARGET', exit: 1 });
  return written;
}

/** Every file any bundle has placed here, for callers that need to tell a
 * bundle's file from a hand-added one. */
export function placedFiles(copilotHome) {
  const placements = readPlacements(copilotHome);
  const all = new Set();
  for (const record of Object.values(placements.bundles)) {
    for (const rel of record?.files || []) all.add(rel);
  }
  return all;
}

/**
 * Where one contributed entry lands.
 *
 * The path is relative to the bundle's own `<kind>/` directory and lands under
 * the same directory in the Copilot home, so `skills: ["demo/SKILL.md"]` means
 * `<bundle>/skills/demo/SKILL.md` → `~/.copilot/skills/demo/SKILL.md`. One rule
 * in both directions: a reader never has to work out where something went.
 */
export function placementFor(kind, rel) {
  return { source: path.join(kind, rel), target: `${kind}/${rel}`.split(path.sep).join('/') };
}

/**
 * Place every enabled bundle's winning contributions, and withdraw anything a
 * previous sync placed that no longer wins.
 *
 * Returns `{ placed, withdrawn, refused, shadowed }` — `refused` and `shadowed`
 * are reported rather than dropped, because a contribution that silently does
 * not appear is the failure mode the whole provenance layer exists to prevent.
 */
export function syncBundles({ copilotHome, shippedFiles = new Set(), trustedNames = new Set(), dryRun = false } = {}) {
  const bundles = discoverBundles(copilotHome, { trustedNames });
  const winners = resolvePrecedence(bundles);
  const byName = new Map(bundles.map((b) => [b.dir.split(path.sep).pop(), b]));

  const placed = [];
  const refused = [];
  const shadowed = [];
  const nextBundles = {};

  for (const row of winners) {
    const bundle = bundles.find((b) => b.name === row.winner) || byName.get(row.winner);
    if (!bundle) continue;
    const { source, target } = placementFor(row.kind, row.path);

    // The package always wins — see the module note.
    if (shippedFiles.has(target)) {
      refused.push({ bundle: row.winner, target, reason: 'the harness ships this path; a bundle may not replace it' });
      continue;
    }
    const from = path.join(bundle.dir, source);
    if (!fs.existsSync(from)) {
      refused.push({ bundle: row.winner, target, reason: `declared but missing from the bundle: ${source}` });
      continue;
    }
    if (!dryRun) {
      const written = writeFileContained(copilotHome, target, fs.readFileSync(from));
      if (!written) {
        refused.push({ bundle: row.winner, target, reason: 'refused by path containment' });
        continue;
      }
    }
    placed.push({ bundle: row.winner, target });
    (nextBundles[row.winner] ||= { version: bundle.manifest?.version ?? null, files: [] }).files.push(target);
    for (const loser of row.shadowed) shadowed.push({ bundle: loser, target, winner: row.winner });
  }

  // Withdraw what a previous sync placed and this one did not. This is the
  // retirement half, and it is exact BECAUSE placements were recorded: guessing
  // from the filesystem would either strand a file or delete a hand-added one
  // that happened to share a name.
  const previous = readPlacements(copilotHome);
  const stillPlaced = new Set(placed.map((p) => p.target));
  const withdrawn = [];
  if (!previous.unreadable) {
    for (const record of Object.values(previous.bundles)) {
      for (const rel of record?.files || []) {
        if (stillPlaced.has(rel)) continue;
        const full = path.join(copilotHome, rel);
        if (!dryRun) {
          try {
            fs.rmSync(full, { force: true });
          } catch {
            /* already gone */
          }
        }
        withdrawn.push(rel);
      }
    }
  }

  if (!dryRun && !previous.unreadable) {
    writePlacements(copilotHome, { version: PLACEMENTS_SCHEMA, bundles: nextBundles });
  }
  return { placed, withdrawn, refused, shadowed, unreadable: previous.unreadable === true };
}
