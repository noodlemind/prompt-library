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
import { pathToFileURL } from 'node:url';

const FORMAT = 'harness-eval-workspace-manifest.v1';
const COLLECTION_MODE = 'bounded-content-hash-manifest-v1';
const MAX_FILES = 20_000;
const MAX_DIRECTORIES = 5_000;
const MAX_NODES = 25_000;
const MAX_DEPTH = 64;
const MAX_HASHED_BYTES = 64 * 1024 * 1024;
const MAX_FILE_BYTES = 4 * 1024 * 1024;
const MAX_CHANGED_PATHS = 200;
const MAX_EVENT_BYTES = 1024 * 1024;
const MAX_STATE_BYTES = 128 * 1024 * 1024;
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
const ALLOWED_CHECK_SEVERITIES = new Set(['ok', 'warn', 'fail']);

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

function excluded(relative, isDirectory = false) {
  const parts = relative.split('/');
  if (parts.some((part) => EXCLUDED_DIR_NAMES.has(part))) return true;
  // Common dependency caches nested under otherwise useful vendor trees.
  if (parts.join('/').includes('vendor/bundle/')) return true;
  return isDirectory && parts.at(-1) === '.pytest_cache';
}

function evidenceError(reason) {
  const error = new Error(reason);
  error.evidenceReason = reason;
  return error;
}

function noFollowFlag() {
  return fs.constants.O_NOFOLLOW ?? 0;
}

function nonBlockingFlag() {
  return fs.constants.O_NONBLOCK ?? 0;
}

function directoryFlag() {
  return fs.constants.O_DIRECTORY ?? 0;
}

function sameIdentity(left, right) {
  return Boolean(left && right && left.dev === right.dev && left.ino === right.ino && left.mode === right.mode);
}

function sameStableFile(left, right) {
  return sameIdentity(left, right) && left.size === right.size && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

function statBigInt(file) {
  return fs.lstatSync(file, { bigint: true });
}

/**
 * Read a regular file through a non-blocking, no-follow descriptor and reject
 * concurrent mutation. Opening before fstat is intentional: a file replaced by
 * a FIFO cannot block the collector while it decides what kind of node it is.
 */
export function readRegularFileNoFollow(file, maxBytes, { expectedStat = null, validate = () => {} } = {}) {
  const handle = fs.openSync(file, fs.constants.O_RDONLY | nonBlockingFlag() | noFollowFlag());
  try {
    const before = fs.fstatSync(handle, { bigint: true });
    if (!before.isFile()) throw evidenceError('workspace-entry-not-regular-file');
    if (expectedStat && !sameIdentity(before, expectedStat)) throw evidenceError('workspace-entry-changed-during-read');
    if (before.size > BigInt(maxBytes)) throw evidenceError('workspace-file-byte-limit-exceeded');
    validate();
    const content = Buffer.alloc(Number(before.size));
    let offset = 0;
    while (offset < content.length) {
      const bytesRead = fs.readSync(handle, content, offset, content.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    const extra = Buffer.alloc(1);
    const extraBytes = fs.readSync(handle, extra, 0, 1, offset);
    const after = fs.fstatSync(handle, { bigint: true });
    validate();
    if (offset !== content.length || extraBytes !== 0 || !sameStableFile(before, after)) {
      throw evidenceError('workspace-entry-changed-during-read');
    }
    return { content, stat: after };
  } finally {
    fs.closeSync(handle);
  }
}

function descriptorAnchorBase(handle) {
  // Linux procfs supplies the descriptor-relative lookup Node's public fs API
  // otherwise lacks. Darwin's /dev/fd entries cannot be traversed as
  // directories, so non-Linux hosts deliberately use the checked fallback.
  if (process.platform !== 'linux') return null;
  const candidate = `/proc/self/fd/${handle}`;
  try {
    return fs.statSync(candidate).isDirectory() ? '/proc/self/fd' : null;
  } catch {
    return null;
  }
}

function openRootContext(root) {
  const resolvedRoot = fs.realpathSync(path.resolve(root));
  const namedRoot = statBigInt(resolvedRoot);
  if (namedRoot.isSymbolicLink() || !namedRoot.isDirectory()) throw new Error('workspace root is not a directory');
  let handle;
  try {
    handle = fs.openSync(
      resolvedRoot,
      fs.constants.O_RDONLY | directoryFlag() | nonBlockingFlag() | noFollowFlag()
    );
    const identity = fs.fstatSync(handle, { bigint: true });
    if (!identity.isDirectory() || !sameIdentity(namedRoot, identity)) {
      throw evidenceError('workspace-ancestor-identity-ambiguous');
    }
    const context = {
      handle,
      identity,
      absolute: resolvedRoot,
      relative: '',
      anchorBase: descriptorAnchorBase(handle),
    };
    assertDirectoryStack([context]);
    return context;
  } catch (error) {
    if (handle !== undefined) fs.closeSync(handle);
    throw error;
  }
}

function closeDirectoryStack(stack) {
  for (let index = stack.length - 1; index >= 0; index -= 1) {
    try {
      fs.closeSync(stack[index].handle);
    } catch {
      // A prior evidence error remains authoritative.
    }
  }
}

function accessPath(context, name = null) {
  if (context.anchorBase) {
    const base = `${context.anchorBase}/${context.handle}`;
    return name === null ? base : `${base}/${name}`;
  }
  return name === null ? context.absolute : path.join(context.absolute, name);
}

function assertDirectoryStack(stack) {
  for (const context of stack) {
    let opened;
    try {
      opened = fs.fstatSync(context.handle, { bigint: true });
    } catch {
      throw evidenceError('workspace-ancestor-identity-ambiguous');
    }
    if (!opened.isDirectory() || !sameIdentity(opened, context.identity)) {
      throw evidenceError('workspace-ancestor-identity-ambiguous');
    }
    if (!context.anchorBase) {
      // This portable fallback detects observable ancestor replacement before
      // and after each operation. It is intentionally reported as
      // identity-checked (not atomic) because Node exposes no openat/renameat.
      try {
        const named = statBigInt(context.absolute);
        if (named.isSymbolicLink() || !named.isDirectory() || !sameIdentity(named, context.identity)) {
          throw evidenceError('workspace-ancestor-identity-ambiguous');
        }
      } catch (error) {
        if (error?.evidenceReason) throw error;
        throw evidenceError('workspace-ancestor-identity-ambiguous');
      }
    }
  }
}

function readDirectoryIncrementally(context, stack, state) {
  assertDirectoryStack(stack);
  let directory;
  const children = [];
  try {
    directory = fs.opendirSync(accessPath(context));
    assertDirectoryStack(stack);
    while (true) {
      const child = directory.readSync();
      if (child === null) break;
      state.nodeCount += 1;
      if (state.nodeCount > state.maxNodes) throw evidenceError('workspace-node-limit-exceeded');
      children.push(child);
    }
  } catch (error) {
    if (error?.evidenceReason) throw error;
    throw evidenceError('workspace-directory-unreadable');
  } finally {
    if (directory) {
      try {
        directory.closeSync();
      } catch {
        // The primary evidence reason is more useful than a close error.
      }
    }
  }
  assertDirectoryStack(stack);
  children.sort((left, right) => bytewiseCompare(left.name, right.name));
  return children;
}

function childStat(context, name, stack, { allowMissing = false } = {}) {
  assertDirectoryStack(stack);
  try {
    const stat = statBigInt(accessPath(context, name));
    assertDirectoryStack(stack);
    return stat;
  } catch (error) {
    if (error?.evidenceReason) throw error;
    if (allowMissing && error?.code === 'ENOENT') {
      assertDirectoryStack(stack);
      return null;
    }
    throw evidenceError('workspace-entry-changed-during-read');
  }
}

function readSymlink(context, name, expectedStat, stack) {
  assertDirectoryStack(stack);
  try {
    const target = fs.readlinkSync(accessPath(context, name), { encoding: 'buffer' });
    const after = statBigInt(accessPath(context, name));
    assertDirectoryStack(stack);
    if (!after.isSymbolicLink() || !sameIdentity(expectedStat, after) || expectedStat.size !== after.size) {
      throw evidenceError('workspace-entry-changed-during-read');
    }
    return target;
  } catch (error) {
    if (error?.evidenceReason) throw error;
    throw evidenceError('workspace-entry-changed-during-read');
  }
}

function openChildDirectory(parent, name, relative, expectedStat, stack, options) {
  assertDirectoryStack(stack);
  let handle;
  try {
    handle = fs.openSync(
      accessPath(parent, name),
      fs.constants.O_RDONLY | directoryFlag() | nonBlockingFlag() | noFollowFlag()
    );
    const identity = fs.fstatSync(handle, { bigint: true });
    if (!identity.isDirectory() || !sameIdentity(expectedStat, identity)) {
      throw evidenceError('workspace-ancestor-identity-ambiguous');
    }
    const context = {
      handle,
      identity,
      absolute: path.join(parent.absolute, name),
      relative,
      anchorBase: parent.anchorBase,
    };
    options.onDirectoryOpened?.({ relative, descriptorAnchored: Boolean(parent.anchorBase) });
    assertDirectoryStack([...stack, context]);
    return context;
  } catch (error) {
    if (handle !== undefined) fs.closeSync(handle);
    if (error?.evidenceReason) throw error;
    // A no-follow open that no longer matches the lstat is a mutation, not an
    // ordinary unreadable-file result.
    throw evidenceError('workspace-ancestor-identity-ambiguous');
  }
}

function visitDirectory(context, stack, depth, state, options) {
  if (depth > MAX_DEPTH) throw evidenceError('workspace-depth-limit-exceeded');
  state.directoryCount += 1;
  if (state.directoryCount > MAX_DIRECTORIES) throw evidenceError('workspace-directory-limit-exceeded');

  const children = readDirectoryIncrementally(context, stack, state);
  for (const child of children) {
    const relative = context.relative ? `${context.relative}/${child.name}` : child.name;
    if (excluded(relative, child.isDirectory())) continue;
    const stat = childStat(context, child.name, stack);
    if (excluded(relative, stat.isDirectory())) continue;

    if (stat.isDirectory()) {
      if (depth + 1 > MAX_DEPTH) throw evidenceError('workspace-depth-limit-exceeded');
      const nested = openChildDirectory(context, child.name, relative, stat, stack, options);
      try {
        visitDirectory(nested, [...stack, nested], depth + 1, state, options);
      } finally {
        fs.closeSync(nested.handle);
      }
      assertDirectoryStack(stack);
      continue;
    }

    if (stat.isSymbolicLink()) {
      if (state.entries.length >= MAX_FILES) throw evidenceError('workspace-file-limit-exceeded');
      const target = readSymlink(context, child.name, stat, stack);
      state.entries.push({
        path: relative,
        type: 'symlink',
        mode: Number(stat.mode & 0o777n),
        size: target.length,
        sha256: sha256(target),
      });
      continue;
    }

    // Sockets, devices, and FIFOs are intentionally ignored. If a regular file
    // is raced into one of these after lstat, O_NONBLOCK above prevents a hang
    // and the descriptor type/identity checks fail evidence closed.
    if (!stat.isFile()) continue;
    if (state.entries.length >= MAX_FILES) throw evidenceError('workspace-file-limit-exceeded');
    if (stat.size > BigInt(MAX_FILE_BYTES)) throw evidenceError('workspace-file-byte-limit-exceeded');
    if (BigInt(state.hashedBytes) + stat.size > BigInt(MAX_HASHED_BYTES)) {
      throw evidenceError('workspace-total-byte-limit-exceeded');
    }
    const { content, stat: openedStat } = readRegularFileNoFollow(accessPath(context, child.name), MAX_FILE_BYTES, {
      expectedStat: stat,
      validate: () => assertDirectoryStack(stack),
    });
    if (state.hashedBytes + content.length > MAX_HASHED_BYTES) throw evidenceError('workspace-total-byte-limit-exceeded');
    state.hashedBytes += content.length;
    state.entries.push({
      path: relative,
      type: 'file',
      mode: Number(openedStat.mode & 0o777n),
      size: content.length,
      sha256: sha256(content),
    });
  }
}

export function manifest(root = process.cwd(), options = {}) {
  const entries = [];
  const configuredMaxNodes = Number.isInteger(options.maxNodes) && options.maxNodes > 0
    ? Math.min(options.maxNodes, MAX_NODES)
    : MAX_NODES;
  const state = { entries, hashedBytes: 0, directoryCount: 0, nodeCount: 0, maxNodes: configuredMaxNodes };
  let reason = null;
  let rootContext;
  let anchorBase = null;
  try {
    rootContext = openRootContext(root);
    anchorBase = rootContext.anchorBase;
    visitDirectory(rootContext, [rootContext], 0, state, options);
  } catch (error) {
    reason = error?.evidenceReason ?? 'workspace-root-unreadable';
  } finally {
    if (rootContext) closeDirectoryStack([rootContext]);
  }

  entries.sort((a, b) => bytewiseCompare(a.path, b.path));
  const available = reason === null;
  return {
    format: FORMAT,
    available,
    reason,
    collectionMode: COLLECTION_MODE,
    containmentMode: anchorBase ? 'descriptor-relative-procfs' : 'identity-checked-path-fallback',
    root: '.',
    fileCount: entries.length,
    directoryCount: state.directoryCount,
    nodeCount: state.nodeCount,
    hashedBytes: state.hashedBytes,
    manifestHash: available ? sha256(stableJson(entries)) : null,
    entries: available ? entries : [],
    limits: {
      maxFiles: MAX_FILES,
      maxDirectories: MAX_DIRECTORIES,
      maxNodes: configuredMaxNodes,
      maxDepth: MAX_DEPTH,
      maxHashedBytes: MAX_HASHED_BYTES,
      maxFileBytes: MAX_FILE_BYTES,
      maxStateBytes: MAX_STATE_BYTES,
    },
  };
}

function statePathComponents(candidate) {
  if (typeof candidate !== 'string' || !candidate || path.isAbsolute(candidate) || candidate.includes('\0')) {
    throw new Error('evidence state path must stay below .harness/');
  }
  const normalized = path.normalize(candidate);
  const components = normalized.split(path.sep);
  if (
    components.length < 2 ||
    components.length > MAX_DEPTH ||
    components[0] !== '.harness' ||
    components.some((component) => !component || component === '.' || component === '..')
  ) {
    throw new Error('evidence state path must stay below .harness/');
  }
  return components;
}

function openStateTarget(root, candidate, { createParent = false, onParentOpened = null } = {}) {
  const components = statePathComponents(candidate);
  const stack = [];
  try {
    const rootContext = openRootContext(root);
    stack.push(rootContext);
    let parent = rootContext;
    let relative = '';
    for (const component of components.slice(0, -1)) {
      relative = relative ? `${relative}/${component}` : component;
      let stat = childStat(parent, component, stack, { allowMissing: true });
      if (!stat) {
        if (!createParent) {
          const error = new Error(`${relative} state directory does not exist`);
          error.code = 'ENOENT';
          throw error;
        }
        assertDirectoryStack(stack);
        try {
          fs.mkdirSync(accessPath(parent, component), { mode: 0o700 });
        } catch (error) {
          if (error?.code !== 'EEXIST') throw error;
        }
        assertDirectoryStack(stack);
        stat = childStat(parent, component, stack);
      }
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new Error(`${relative} state path must be a real directory, not a symlink`);
      }
      const nested = openChildDirectory(parent, component, relative, stat, stack, {});
      stack.push(nested);
      parent = nested;
    }
    onParentOpened?.({
      containmentMode: parent.anchorBase ? 'descriptor-relative-procfs' : 'identity-checked-path-fallback',
    });
    assertDirectoryStack(stack);
    return { parent, name: components.at(-1), stack };
  } catch (error) {
    closeDirectoryStack(stack);
    throw error;
  }
}

function closeStateTarget(target) {
  closeDirectoryStack(target.stack);
}

function readStateFile(root, candidate, maxBytes, options = {}) {
  const target = openStateTarget(root, candidate, options);
  try {
    const expectedStat = childStat(target.parent, target.name, target.stack);
    if (expectedStat.isSymbolicLink() || !expectedStat.isFile()) {
      throw new Error('evidence state file must be a regular file, not a symlink');
    }
    return readRegularFileNoFollow(accessPath(target.parent, target.name), maxBytes, {
      expectedStat,
      validate: () => assertDirectoryStack(target.stack),
    });
  } finally {
    closeStateTarget(target);
  }
}

function writeJsonAtomic(target, value) {
  const serialized = Buffer.from(`${JSON.stringify(value)}\n`, 'utf8');
  if (serialized.length > MAX_STATE_BYTES) throw new Error('evidence state exceeds the byte limit');
  const existing = childStat(target.parent, target.name, target.stack, { allowMissing: true });
  if (existing && (existing.isSymbolicLink() || !existing.isFile())) {
    throw new Error('evidence state file must be a regular file, not a symlink');
  }
  const temporaryName = `.${target.name}.${process.pid}.${crypto.randomUUID()}.tmp`;
  const temporary = accessPath(target.parent, temporaryName);
  const destination = accessPath(target.parent, target.name);
  let handle;
  let writtenStat;
  let temporaryCreated = false;
  let renamed = false;
  try {
    assertDirectoryStack(target.stack);
    handle = fs.openSync(
      temporary,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | nonBlockingFlag() | noFollowFlag(),
      0o600
    );
    temporaryCreated = true;
    writtenStat = fs.fstatSync(handle, { bigint: true });
    if (!writtenStat.isFile()) throw new Error('evidence temporary state is not a regular file');
    assertDirectoryStack(target.stack);
    fs.writeFileSync(handle, serialized);
    fs.fsyncSync(handle);
    writtenStat = fs.fstatSync(handle, { bigint: true });
    if (!writtenStat.isFile() || writtenStat.size !== BigInt(serialized.length)) {
      throw new Error('evidence temporary state write was incomplete');
    }
    fs.closeSync(handle);
    handle = undefined;
    assertDirectoryStack(target.stack);
    fs.renameSync(temporary, destination);
    renamed = true;
    assertDirectoryStack(target.stack);
    const persisted = childStat(target.parent, target.name, target.stack);
    if (!sameIdentity(writtenStat, persisted) || persisted.size !== writtenStat.size) {
      throw evidenceError('workspace-ancestor-identity-ambiguous');
    }
  } finally {
    if (handle !== undefined) fs.closeSync(handle);
    if (temporaryCreated && !renamed) {
      try {
        assertDirectoryStack(target.stack);
        fs.unlinkSync(temporary);
        assertDirectoryStack(target.stack);
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
    }
  }
}

export function writeStateJson(root, candidate, value, options = {}) {
  const target = openStateTarget(root, candidate, { ...options, createParent: true });
  try {
    writeJsonAtomic(target, value);
  } finally {
    closeStateTarget(target);
  }
}

function snapshot(root, output) {
  const result = manifest(root);
  writeStateJson(root, output, result);
  // The persisted manifest has per-file records. Stdout stays a small summary.
  return {
    available: result.available,
    reason: result.reason,
    collectionMode: result.collectionMode,
    containmentMode: result.containmentMode,
    manifestHash: result.manifestHash,
    fileCount: result.fileCount,
    directoryCount: result.directoryCount,
    nodeCount: result.nodeCount,
    hashedBytes: result.hashedBytes,
  };
}

function readBefore(root, beforePath, expectedHash) {
  try {
    const { content } = readStateFile(root, beforePath, MAX_STATE_BYTES);
    const parsed = JSON.parse(content.toString('utf8'));
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
  if (!id || typeof check.pass !== 'boolean' || !ALLOWED_CHECK_SEVERITIES.has(check.severity)) return null;
  return {
    id,
    pass: check.pass,
    severity: check.severity,
  };
}

function projectEvent(event) {
  if (!event || typeof event !== 'object' || !ALLOWED_EVENT_TYPES.has(event.type)) return { event: null, rejectedChecks: 0 };
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
  const checks = [];
  let rejectedChecks = 0;
  for (const candidate of Array.isArray(event.checks) ? event.checks : []) {
    const check = projectCheck(candidate);
    if (!check || checks.length >= 50) rejectedChecks += 1;
    else checks.push(check);
  }
  if (plan) projected.plan = plan;
  if (phase) projected.phase = phase;
  if (gate) projected.gate = gate;
  if (decision) projected.decision = decision;
  if (blockedReason) projected.blockedReason = blockedReason;
  if (typeof event.mutation === 'boolean') projected.mutation = event.mutation;
  if (typeof event.success === 'boolean') projected.success = event.success;
  if (Number.isFinite(event.durationMs)) projected.durationMs = Math.max(0, Math.round(event.durationMs));
  if (checks.length) projected.checks = checks;
  return { event: projected, rejectedChecks };
}

function collectHarnessEvents(root) {
  let handle;
  let target;
  try {
    try {
      target = openStateTarget(root, '.harness/events.jsonl');
    } catch (error) {
      if (error?.code === 'ENOENT') return { available: false, complete: false, reason: 'harness-events-not-found', events: [], projectionRejectedEvents: 0, projectionRejectedChecks: 0 };
      throw error;
    }
    const expectedStat = childStat(target.parent, target.name, target.stack, { allowMissing: true });
    if (!expectedStat) return { available: false, complete: false, reason: 'harness-events-not-found', events: [], projectionRejectedEvents: 0, projectionRejectedChecks: 0 };
    if (expectedStat.isSymbolicLink() || !expectedStat.isFile()) throw new Error('events source is not a regular file');
    try {
      handle = fs.openSync(accessPath(target.parent, target.name), fs.constants.O_RDONLY | nonBlockingFlag() | noFollowFlag());
    } catch (error) {
      if (error?.code === 'ENOENT') return { available: false, complete: false, reason: 'harness-events-not-found', events: [], projectionRejectedEvents: 0, projectionRejectedChecks: 0 };
      throw error;
    }
    const before = fs.fstatSync(handle, { bigint: true });
    if (!before.isFile() || !sameIdentity(before, expectedStat)) throw new Error('events source is not a stable regular file');
    assertDirectoryStack(target.stack);
    const bytesToRead = Number(before.size > BigInt(MAX_EVENT_BYTES) ? BigInt(MAX_EVENT_BYTES) : before.size);
    const startBigInt = before.size - BigInt(bytesToRead);
    if (startBigInt > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('events source offset is not safely representable');
    const start = Number(startBigInt);
    const buffer = Buffer.alloc(bytesToRead);
    let offset = 0;
    while (offset < buffer.length) {
      const bytesRead = fs.readSync(handle, buffer, offset, buffer.length - offset, start + offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    const after = fs.fstatSync(handle, { bigint: true });
    assertDirectoryStack(target.stack);
    if (offset !== buffer.length || !sameStableFile(before, after)) throw new Error('events source changed during read');
    fs.closeSync(handle);
    handle = undefined;
    let text = buffer.toString('utf8', 0, offset);
    if (start > 0) {
      const firstNewline = text.indexOf('\n');
      text = firstNewline >= 0 ? text.slice(firstNewline + 1) : '';
    }
    let projectionRejectedEvents = 0;
    let projectionRejectedChecks = 0;
    const allProjected = [];
    for (const line of text.split(/\r?\n/).filter(Boolean)) {
      try {
        const projected = projectEvent(JSON.parse(line));
        projectionRejectedChecks += projected.rejectedChecks;
        if (projected.event) allProjected.push(projected.event);
        else projectionRejectedEvents += 1;
      } catch {
        projectionRejectedEvents += 1;
      }
    }
    const retentionTruncated = allProjected.length > MAX_EVENTS;
    const events = allProjected.slice(-MAX_EVENTS);
    const reasons = [];
    if (start > 0) reasons.push('harness-events-byte-limit-exceeded');
    if (retentionTruncated) reasons.push('harness-events-retention-limit-exceeded');
    if (projectionRejectedEvents || projectionRejectedChecks) reasons.push('harness-events-projection-rejected');
    const complete = reasons.length === 0;
    return {
      available: events.length > 0 || projectionRejectedEvents === 0,
      complete,
      reason: complete ? null : reasons.join(';'),
      events,
      sourceTruncated: start > 0 || retentionTruncated,
      projectionRejectedEvents,
      projectionRejectedChecks,
    };
  } catch {
    return {
      available: false,
      complete: false,
      reason: 'harness-events-unreadable',
      events: [],
      sourceTruncated: false,
      projectionRejectedEvents: 0,
      projectionRejectedChecks: 0,
    };
  } finally {
    if (handle !== undefined) fs.closeSync(handle);
    if (target) closeStateTarget(target);
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
      containmentMode: after.containmentMode,
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
      complete: harness.complete,
      reason: harness.reason,
      retainedEvents: harness.events.length,
      sourceTruncated: harness.sourceTruncated ?? false,
      projectionRejectedEvents: harness.projectionRejectedEvents ?? 0,
      projectionRejectedChecks: harness.projectionRejectedChecks ?? 0,
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

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedDirectly) {
  try {
    process.stdout.write(`${JSON.stringify(main())}\n`);
  } catch (error) {
    process.stderr.write(`evidence probe failed: ${error.message}\n`);
    process.exitCode = 2;
  }
}
