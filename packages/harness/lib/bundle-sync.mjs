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
import crypto from 'node:crypto';
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
    // Every recorded path is checked here, at the boundary, so no consumer has
    // to remember to — the deletion loop below is the one that would forget.
    for (const record of Object.values(bundles)) {
      if (!record || !Array.isArray(record.files)) continue;
      if (!record.files.every((f) => isContainedPlacement(typeof f === 'string' ? f : f?.path))) {
        return { version: PLACEMENTS_SCHEMA, bundles: {}, unreadable: true };
      }
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
    for (const entry of record?.files || []) all.add(typeof entry === 'string' ? entry : entry.path);
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
 * Whether a recorded placement path is one this code may act on.
 *
 * F1 (Codex phase-5 review): withdrawal did `fs.rmSync(path.join(copilotHome,
 * rel))` over paths read back from `bundles.yaml` without checking them, so a
 * record containing `../../victim.txt` deleted a file outside `~/.copilot`
 * entirely. The manifest parser already refuses traversal on the way IN; that
 * is not a reason to trust the file on the way back OUT, because the record is
 * a separate artifact that a different bug — or a hand edit — can corrupt.
 *
 * Lexical, deliberately: this decides whether a path is well-formed, and runs
 * before anything is resolved or opened. A `realpath` check belongs at the
 * moment of deletion, where `assertRealpathContained` already does it.
 */
export function isContainedPlacement(rel) {
  if (typeof rel !== 'string' || !rel || rel.includes('\0')) return false;
  if (path.isAbsolute(rel) || /^[a-zA-Z]:/.test(rel)) return false;
  const normalized = path.normalize(rel).split(path.sep).join('/');
  if (normalized.startsWith('../') || normalized === '..') return false;
  return !normalized.split('/').includes('..');
}

/**
 * A source file's bytes, read once, refusing anything that is not a regular
 * file.
 *
 * F3 (Codex phase-5 review): integrity hashed the bundle at discovery and
 * placement read it AGAIN, so bytes swapped between the two were installed
 * under a pin that had approved something else. Worse for a symlink: the
 * digest walk skips it (`Dirent.isFile()` is false) while `readFileSync`
 * follows it, so its target was never pinned at all and could be anything on
 * the filesystem.
 */
function readSourceOnce(full) {
  const stat = fs.lstatSync(full);
  if (stat.isSymbolicLink()) throw Object.assign(new Error('is a symlink'), { code: 'E_TARGET' });
  if (!stat.isFile()) throw Object.assign(new Error('is not a regular file'), { code: 'E_TARGET' });
  return fs.readFileSync(full);
}

const digestOf = (bytes) => `sha256-${crypto.createHash('sha256').update(bytes).digest('hex')}`;

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
  const byId = new Map(bundles.map((b) => [b.id ?? b.dir.split(path.sep).pop(), b]));

  const placed = [];
  const refused = [];
  const shadowed = [];
  const nextBundles = {};

  for (const row of winners) {
    // By DIRECTORY id, not by manifest name. `find(b => b.name === winner)`
    // returned whichever bundle came first with that manifest name, so with two
    // claimants a contribution could be read out of the wrong directory —
    // installing the wrong content or refusing a valid one.
    const bundle = byId.get(row.winnerId) || byId.get(row.winner);
    if (!bundle) continue;
    const { source, target } = placementFor(row.kind, row.path);

    // The package always wins — see the module note.
    if (shippedFiles.has(target)) {
      refused.push({ bundle: row.winner, target, reason: 'the harness ships this path; a bundle may not replace it' });
      continue;
    }
    const from = path.join(bundle.dir, source);
    let bytes;
    try {
      bytes = readSourceOnce(from);
    } catch (error) {
      refused.push({
        bundle: row.winner,
        target,
        reason: error.code === 'E_TARGET' ? `${source} ${error.message}` : `declared but missing from the bundle: ${source}`,
      });
      continue;
    }
    if (!dryRun) {
      // The SNAPSHOT is written, and the snapshot is what gets hashed — no
      // second read for anything to happen between.
      const written = writeFileContained(copilotHome, target, bytes);
      if (!written) {
        refused.push({ bundle: row.winner, target, reason: 'refused by path containment' });
        continue;
      }
    }
    placed.push({ bundle: row.winner, target });
    // The digest is what makes withdrawal safe: it is how a later run tells a
    // file this bundle put there from one the package or the operator has since
    // written over the top of it.
    (nextBundles[row.winner] ||= { version: bundle.manifest?.version ?? null, files: [] })
      .files.push({ path: target, digest: digestOf(bytes) });
    for (const loser of row.shadowed) shadowed.push({ bundle: loser, target, winner: row.winner });
  }

  // Withdraw what a previous sync placed and this one did not. This is the
  // retirement half, and it is exact BECAUSE placements were recorded: guessing
  // from the filesystem would either strand a file or delete a hand-added one
  // that happened to share a name.
  const previous = readPlacements(copilotHome);
  const stillPlaced = new Set(placed.map((p) => p.target));
  const withdrawn = [];
  const retained = [];
  if (!previous.unreadable) {
    for (const [name, record] of Object.entries(previous.bundles)) {
      for (const entry of record?.files || []) {
        const rel = typeof entry === 'string' ? entry : entry.path;
        const recordedDigest = typeof entry === 'string' ? null : entry.digest;
        if (stillPlaced.has(rel)) continue;

        // F2 (Codex phase-5 review): withdrawal used to delete whatever now sat
        // at the path. Two ways that destroys someone else's file. A bundle
        // places `skills/x/SKILL.md`; a later harness version SHIPS that path;
        // hydration writes the package's copy, placement refuses the bundle
        // (the package wins), and withdrawal then deletes the package file. Or
        // the operator simply edits the file before disabling the bundle. A
        // path is not ownership — the bytes are.
        if (shippedFiles.has(rel)) {
          retained.push({ bundle: name, target: rel, reason: 'the harness now ships this path' });
          continue;
        }
        const full = path.join(copilotHome, rel);
        let current = null;
        try {
          current = fs.lstatSync(full).isFile() ? digestOf(fs.readFileSync(full)) : null;
        } catch (error) {
          if (error.code === 'ENOENT') { withdrawn.push(rel); continue; }
          retained.push({ bundle: name, target: rel, reason: `unreadable (${error.code || error.message})` });
          continue;
        }
        if (current === null) {
          retained.push({ bundle: name, target: rel, reason: 'not a regular file' });
          continue;
        }
        // A record written before digests existed has nothing to compare, and
        // deleting on a path match alone is what this fix removes. It is
        // retained and reported rather than guessed at.
        if (!recordedDigest) {
          retained.push({ bundle: name, target: rel, reason: 'placed before placements recorded content; remove it by hand' });
          continue;
        }
        if (current !== recordedDigest) {
          retained.push({ bundle: name, target: rel, reason: 'the file has changed since this bundle placed it' });
          continue;
        }
        if (dryRun) { withdrawn.push(rel); continue; }
        try {
          fs.rmSync(full);
          withdrawn.push(rel);
        } catch (error) {
          // F10: only ENOENT means "already gone". Reporting an EBUSY or EACCES
          // as withdrawn AND dropping it from the record left the file in place
          // with nothing recording that a bundle owns it.
          if (error.code === 'ENOENT') { withdrawn.push(rel); continue; }
          retained.push({ bundle: name, target: rel, reason: `could not remove (${error.code || error.message})` });
          (nextBundles[name] ||= { version: record?.version ?? null, files: [] }).files.push(entry);
        }
      }
    }
  }

  if (!dryRun && !previous.unreadable) {
    writePlacements(copilotHome, { version: PLACEMENTS_SCHEMA, bundles: nextBundles });
  }
  return { placed, withdrawn, retained, refused, shadowed, unreadable: previous.unreadable === true };
}
