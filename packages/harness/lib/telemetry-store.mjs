import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { eventPath } from './events.mjs';
import { harnessGlobalHome } from './paths.mjs';
import { createRedactor, redactedJson } from './redact.mjs';

// Reuses the existing event-log artifact type (JSONL of the same event shape),
// only relocated to a global home — no new persistent artifact type.
const MAX_STORE_BYTES = 5 * 1024 * 1024; // per-project cap; oldest lines rotated out
const KEEP_LINES_ON_ROTATE = 5000;

function telemetryDir() {
  return path.join(harnessGlobalHome(), 'telemetry');
}

/** Stable, filesystem-safe project slug from the git remote, else the dir name. */
export function projectSlug(workspace) {
  const remote = spawnSync('git', ['-C', workspace, 'config', '--get', 'remote.origin.url'], {
    encoding: 'utf8',
    timeout: 5000,
  });
  const url = remote.status === 0 ? remote.stdout.trim() : '';
  const match = url.match(/[:/]([^/:]+\/[^/]+?)(?:\.git)?$/);
  const raw = match ? match[1] : path.basename(path.resolve(workspace));
  return raw.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'unknown';
}

function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

// Fix-wave P1 (report --sync repersists secrets): every write into the GLOBAL
// telemetry store is a persistence boundary and must route through the shared
// redactor, not a bare `JSON.stringify`. Local events.jsonl rows are already
// redacted at write time (events.mjs, C3), but a global-store copy must never
// depend on that upstream pass — a row hand-written into a workspace log, or a
// project slug derived from a credential-bearing git remote, must still be
// masked here before it lands in `~/.harness`. `redactedJson` applies the
// structural walk AND the final serialize-time text pass, so a `toJSON` on a
// row can't smuggle a raw secret past this boundary either. Byte-identical for
// secret-free rows.
function rotateIfNeeded(file, redactor) {
  try {
    if (fs.existsSync(file) && fs.statSync(file).size > MAX_STORE_BYTES) {
      const kept = readJsonl(file).slice(-KEEP_LINES_ON_ROTATE);
      fs.writeFileSync(file, kept.map((e) => redactedJson(e, { redactor })).join('\n') + '\n', 'utf8');
    }
  } catch {
    // Rotation is best-effort; a failed rotate must not block reporting.
  }
}

/** Copy this workspace's events into the global store, deduped by event id. */
export function syncWorkspaceEvents({ workspace }) {
  const redactor = createRedactor();
  const local = readJsonl(eventPath(workspace));
  const dir = telemetryDir();
  fs.mkdirSync(dir, { recursive: true });
  const slug = projectSlug(workspace);
  const file = path.join(dir, `${slug}.jsonl`);
  const existingIds = new Set(readJsonl(file).map((e) => e.id).filter(Boolean));
  const fresh = local.filter((e) => e.id && !existingIds.has(e.id)).map((e) => ({ ...e, project: slug }));
  if (fresh.length) {
    fs.appendFileSync(file, fresh.map((e) => redactedJson(e, { redactor })).join('\n') + '\n', 'utf8');
    rotateIfNeeded(file, redactor);
  }
  return { added: fresh.length, file, slug };
}

/** Merge every project's telemetry from the global store. */
export function readGlobalEvents() {
  const dir = telemetryDir();
  if (!fs.existsSync(dir)) return [];
  const events = [];
  for (const name of fs.readdirSync(dir)) {
    if (name.endsWith('.jsonl')) events.push(...readJsonl(path.join(dir, name)));
  }
  return events.sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
}
