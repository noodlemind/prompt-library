#!/usr/bin/env node
/**
 * Bounded, content-only workspace evidence for Terminal-Bench sandboxes.
 *
 * The probe deliberately runs inside the task container. It never returns file
 * contents (or full tool commands): only sorted relative paths, sizes, types,
 * modes, and SHA-256 digests leave the sandbox. The manifest itself lives under
 * `.harness/`, which is excluded from both snapshots.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const FORMAT = 'harness-eval-workspace-manifest.v1';
const COLLECTION_MODE = 'bounded-content-hash-manifest-v1';
const MAX_FILES = 20_000;
const MAX_HASHED_BYTES = 64 * 1024 * 1024;
const MAX_FILE_BYTES = 4 * 1024 * 1024;
const MAX_CHANGED_PATHS = 200;
const MAX_EVENT_BYTES = 1024 * 1024;
const MAX_EVENTS = 200;

const EXCLUDED_DIR_NAMES = new Set([
  '.git',
  '.harness',
  '.cache',
  '.gradle',
  '.m2',
  '.npm',
  '.pnpm-store',
  '.tox',
  '.venv',
  '.yarn',
  '__pycache__',
  'node_modules',
  'venv',
]);

const ALLOWED_EVENT_TYPES = new Set([
  'session_start',
  'orient',
  'gate',
  'pre_tool',
  'post_tool',
  'skill_activation',
  'verify',
  'compound',
  'consolidate',
  'remember',
  'learning',
  'knowledge',
  'session_end',
]);
const ALLOWED_RESULTS = new Set(['pass', 'warn', 'fail']);
const ALLOWED_DECISIONS = new Set(['allow', 'block', 'warn', 'record', 'record-ungated', 'exempt', 'ignore-failure']);

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function bytewiseCompare(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function normalizedRelative(root, absolute) {
  return path.relative(root, absolute).split(path.sep).join('/');
}

function excluded(relative, dirent) {
  const parts = relative.split('/');
  if (parts.some((part) => EXCLUDED_DIR_NAMES.has(part))) return true;
  // Common dependency caches nested under otherwise useful vendor trees.
  if (parts.join('/').includes('vendor/bundle/')) return true;
  return dirent.isDirectory() && parts.at(-1) === '.pytest_cache';
}

function manifest(root = process.cwd()) {
  const entries = [];
  let hashedBytes = 0;
  let reason = null;
  const pending = [path.resolve(root)];

  while (pending.length && !reason) {
    const directory = pending.pop();
    let children;
    try {
      children = fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => bytewiseCompare(a.name, b.name));
    } catch {
      reason = 'workspace-directory-unreadable';
      break;
    }
    // Reverse the directories before pushing so stack traversal remains lexical.
    const directories = [];
    for (const child of children) {
      const absolute = path.join(directory, child.name);
      const relative = normalizedRelative(root, absolute);
      if (!relative || excluded(relative, child)) continue;
      if (child.isDirectory()) {
        directories.push(absolute);
        continue;
      }
      if (entries.length >= MAX_FILES) {
        reason = 'workspace-file-limit-exceeded';
        break;
      }
      let stat;
      try {
        stat = fs.lstatSync(absolute);
      } catch {
        reason = 'workspace-entry-unreadable';
        break;
      }
      if (stat.isSymbolicLink()) {
        // Hash, but never emit, the link target. Do not follow it outside the workspace.
        try {
          const target = fs.readlinkSync(absolute);
          entries.push({ path: relative, type: 'symlink', mode: stat.mode & 0o777, size: Buffer.byteLength(target), sha256: sha256(target) });
        } catch {
          reason = 'workspace-entry-unreadable';
        }
        continue;
      }
      if (!stat.isFile()) continue;
      if (stat.size > MAX_FILE_BYTES) {
        reason = 'workspace-file-byte-limit-exceeded';
        break;
      }
      if (hashedBytes + stat.size > MAX_HASHED_BYTES) {
        reason = 'workspace-total-byte-limit-exceeded';
        break;
      }
      try {
        const content = fs.readFileSync(absolute);
        hashedBytes += content.length;
        entries.push({ path: relative, type: 'file', mode: stat.mode & 0o777, size: content.length, sha256: sha256(content) });
      } catch {
        reason = 'workspace-entry-unreadable';
        break;
      }
    }
    for (let index = directories.length - 1; index >= 0; index -= 1) pending.push(directories[index]);
  }

  entries.sort((a, b) => bytewiseCompare(a.path, b.path));
  const available = reason === null;
  return {
    format: FORMAT,
    available,
    reason,
    collectionMode: COLLECTION_MODE,
    root: '.',
    fileCount: entries.length,
    hashedBytes,
    manifestHash: available ? sha256(stableJson(entries)) : null,
    entries: available ? entries : [],
    limits: { maxFiles: MAX_FILES, maxHashedBytes: MAX_HASHED_BYTES, maxFileBytes: MAX_FILE_BYTES },
  };
}

function safeStatePath(root, candidate) {
  const absolute = path.resolve(root, candidate);
  const harnessRoot = path.join(path.resolve(root), '.harness');
  if (absolute !== harnessRoot && !absolute.startsWith(`${harnessRoot}${path.sep}`)) {
    throw new Error('evidence state path must stay below .harness/');
  }
  return absolute;
}

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.tmp`);
  fs.writeFileSync(temporary, `${JSON.stringify(value)}\n`, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(temporary, file);
}

function snapshot(root, output) {
  const result = manifest(root);
  writeJsonAtomic(safeStatePath(root, output), result);
  // The persisted manifest has per-file records. Stdout stays a small summary.
  return {
    available: result.available,
    reason: result.reason,
    collectionMode: result.collectionMode,
    manifestHash: result.manifestHash,
    fileCount: result.fileCount,
    hashedBytes: result.hashedBytes,
  };
}

function readBefore(root, beforePath, expectedHash) {
  try {
    const parsed = JSON.parse(fs.readFileSync(safeStatePath(root, beforePath), 'utf8'));
    if (parsed?.format !== FORMAT || !Array.isArray(parsed.entries)) throw new Error('unexpected manifest format');
    const computedHash = sha256(stableJson(parsed.entries));
    if (parsed.manifestHash !== computedHash) throw new Error('manifest digest mismatch');
    if (expectedHash && parsed.manifestHash !== expectedHash) throw new Error('manifest does not match run-start digest');
    return parsed;
  } catch {
    return { available: false, reason: 'before-manifest-unavailable', entries: [], manifestHash: null };
  }
}

function conciseReason(value) {
  const text = String(value ?? '').toLowerCase();
  const reasons = [];
  if (/out[- ]of[- ]scope|outside.*scope|scope violation/.test(text)) reasons.push('out-of-scope');
  if (/danger|destruct|unsafe|protected|secret/.test(text)) reasons.push('dangerous-command');
  if (/verif|evidence/.test(text)) reasons.push('verification-required');
  if (/completion|stop/.test(text)) reasons.push('completion-blocked');
  return reasons.join(' ') || null;
}

function opaqueId(value) {
  return typeof value === 'string' && value ? sha256(value).slice(0, 24) : null;
}

function safeTimestamp(value) {
  if (typeof value !== 'string' || value.length > 40) return null;
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value) ? value : null;
}

function safeChangedPath(value) {
  if (typeof value !== 'string' || !value || value.startsWith('/') || /[\u0000-\u001f\u007f]/.test(value)) {
    return `[invalid-path:${sha256(String(value)).slice(0, 16)}]`;
  }
  if (value.length > 500 || /(?:secret|token|password|credential|api[-_]?key)/i.test(value)) {
    return `[sensitive-path:${sha256(value).slice(0, 16)}]`;
  }
  return value;
}

function projectCheck(check) {
  if (!check || typeof check !== 'object') return null;
  const id = opaqueId(check.id);
  if (!id) return null;
  return {
    id,
    pass: typeof check.pass === 'boolean' ? check.pass : null,
    severity: safeString(check.severity, 20),
  };
}

function projectEvent(event) {
  if (!event || typeof event !== 'object' || !ALLOWED_EVENT_TYPES.has(event.type)) return null;
  const projected = {
    version: Number.isInteger(event.version) ? event.version : null,
    id: opaqueId(event.id ?? event.eventId),
    ts: safeTimestamp(event.ts ?? event.timestamp),
    type: event.type,
    result: ALLOWED_RESULTS.has(event.result) ? event.result : null,
    exitCode: Number.isInteger(event.exitCode) ? event.exitCode : null,
  };
  const plan = typeof event.plan === 'string' && event.plan ? '[plan-present]' : null;
  const phase = typeof event.phase === 'string' && /^(?:open|planned|in-progress|review|done)$/.test(event.phase) ? event.phase : null;
  const gate = typeof event.gate === 'string' && event.gate ? '[gate-present]' : null;
  const decision = ALLOWED_DECISIONS.has(event.decision) ? event.decision : null;
  const blockedReason = conciseReason(event.blockedReason);
  const checks = Array.isArray(event.checks) ? event.checks.map(projectCheck).filter(Boolean).slice(0, 50) : [];
  if (plan) projected.plan = plan;
  if (phase) projected.phase = phase;
  if (gate) projected.gate = gate;
  if (decision) projected.decision = decision;
  if (blockedReason) projected.blockedReason = blockedReason;
  if (typeof event.mutation === 'boolean') projected.mutation = event.mutation;
  if (typeof event.success === 'boolean') projected.success = event.success;
  if (Number.isFinite(event.durationMs)) projected.durationMs = Math.max(0, Math.round(event.durationMs));
  if (checks.length) projected.checks = checks;
  return projected;
}

function collectHarnessEvents(root) {
  const file = path.join(root, '.harness', 'events.jsonl');
  if (!fs.existsSync(file)) return { available: false, reason: 'harness-events-not-found', events: [] };
  try {
    const stat = fs.statSync(file);
    const start = Math.max(0, stat.size - MAX_EVENT_BYTES);
    const handle = fs.openSync(file, 'r');
    const buffer = Buffer.alloc(stat.size - start);
    try {
      fs.readSync(handle, buffer, 0, buffer.length, start);
    } finally {
      fs.closeSync(handle);
    }
    let text = buffer.toString('utf8');
    if (start > 0) text = text.slice(Math.max(0, text.indexOf('\n') + 1));
    const projected = text
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        try {
          return projectEvent(JSON.parse(line));
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .slice(-MAX_EVENTS);
    return { available: true, reason: null, events: projected, sourceTruncated: start > 0 };
  } catch {
    return { available: false, reason: 'harness-events-unreadable', events: [] };
  }
}

function collect(root, beforePath, expectedBeforeHash) {
  const before = readBefore(root, beforePath, expectedBeforeHash);
  const after = manifest(root);
  const available = before.available === true && after.available === true;
  const beforeMap = new Map((before.entries ?? []).map((entry) => [entry.path, entry]));
  const afterMap = new Map((after.entries ?? []).map((entry) => [entry.path, entry]));
  const paths = [...new Set([...beforeMap.keys(), ...afterMap.keys()])].sort(bytewiseCompare);
  const changes = available
    ? paths
        .filter((entryPath) => stableJson(beforeMap.get(entryPath) ?? null) !== stableJson(afterMap.get(entryPath) ?? null))
        .map((entryPath) => ({ path: entryPath, before: beforeMap.get(entryPath) ?? null, after: afterMap.get(entryPath) ?? null }))
    : [];
  const harness = collectHarnessEvents(root);
  const hookEvents = harness.events.filter((event) => ['pre_tool', 'post_tool', 'session_end'].includes(event.type));
  return {
    workspaceEvidence: {
      available,
      collectionMode: COLLECTION_MODE,
      beforeManifestHash: available ? before.manifestHash : null,
      afterManifestHash: available ? after.manifestHash : null,
      diffHash: available ? sha256(stableJson(changes)) : null,
      changedPaths: changes.slice(0, MAX_CHANGED_PATHS).map((change) => safeChangedPath(change.path)),
      changedPathCount: changes.length,
      changedPathsTruncated: changes.length > MAX_CHANGED_PATHS,
      reason: available ? null : before.reason ?? after.reason ?? 'workspace-evidence-unavailable',
    },
    harnessEvents: harness.events,
    harnessEventEvidence: {
      available: harness.available,
      reason: harness.reason,
      retainedEvents: harness.events.length,
      sourceTruncated: harness.sourceTruncated ?? false,
    },
    enforcement: {
      // This file is sandbox-writable, so event names cannot by themselves
      // prove that host-level hooks were installed. The current bridge does
      // not install such hooks; retain the events for behavior analysis while
      // explicitly refusing to elevate them to mechanical enforcement proof.
      hooksActive: false,
      hookLikeEventsObserved: hookEvents.length,
      source: harness.available ? 'sandbox-writable-harness-events' : 'unavailable',
    },
  };
}

function option(args, name, fallback) {
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  if (!args[index + 1]) throw new Error(`${name} requires a value`);
  return args[index + 1];
}

function main(args = process.argv.slice(2)) {
  const [command] = args;
  const root = process.cwd();
  if (command === 'snapshot') return snapshot(root, option(args, '--output', '.harness/eval-before.json'));
  if (command === 'collect') {
    return collect(
      root,
      option(args, '--before', '.harness/eval-before.json'),
      option(args, '--expected-before-hash', null)
    );
  }
  throw new Error('usage: evidence-probe.mjs snapshot [--output .harness/file] | collect [--before .harness/file]');
}

try {
  process.stdout.write(`${JSON.stringify(main())}\n`);
} catch (error) {
  process.stderr.write(`evidence probe failed: ${error.message}\n`);
  process.exitCode = 2;
}
