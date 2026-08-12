/**
 * Multi-file CAS apply on the single write path (`harness apply`).
 * All-or-nothing: preflight every change, then write; refuse on any conflict.
 * No LLM in this module.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { parseFlags, hasFlag } from './flags.mjs';
import { createStyle, keyWidthFor, EXIT } from './style.mjs';
import { redactedJson } from './redact.mjs';
import { inertLine } from './knowledge/store.mjs';
import { safeResolveUnderRoot } from './path-safe.mjs';
import { readFileNoFollow, writeFileContained } from './fs-safe.mjs';
import { ensureHarnessDir } from './session.mjs';
import { runEdit, runWrite, sha256, literalFlag } from './edit-cmd.mjs';

const ui = createStyle({ argv: process.argv.slice(2) });

export const APPLY_SCHEMA = 1;

function usageError(message, hint) {
  return Object.assign(new Error(message), { code: 'E_USAGE', exit: EXIT.usage, hint });
}

function failed(reason, message, hint, { changes = [] } = {}) {
  return {
    schema: APPLY_SCHEMA,
    mode: 'apply',
    status: 'failed',
    exitCode: 1,
    reason,
    applied: [],
    changes,
    dryRun: false,
    output: hint ? [{ line: message }, { line: hint }] : [{ line: message }],
  };
}

/**
 * Normalize one change descriptor.
 * @typedef {{ path: string, old?: string, new?: string, content?: string, expect?: string }} ApplyChange
 */
export function normalizeChange(raw) {
  if (!raw || typeof raw !== 'object') return { ok: false, reason: 'change must be an object' };
  const rel = typeof raw.path === 'string' ? raw.path.trim() : '';
  if (!rel) return { ok: false, reason: 'each change needs a path' };
  const hasEdit = typeof raw.old === 'string' && typeof raw.new === 'string';
  const hasWrite = typeof raw.content === 'string';
  if (hasEdit && hasWrite) return { ok: false, reason: `${rel}: use either edit (old/new) or write (content), not both` };
  if (!hasEdit && !hasWrite) return { ok: false, reason: `${rel}: needs old+new or content` };
  if (hasEdit && raw.old === '') return { ok: false, reason: `${rel}: edit old must be non-empty` };
  return {
    ok: true,
    change: {
      path: rel,
      kind: hasEdit ? 'edit' : 'write',
      old: hasEdit ? raw.old : undefined,
      new: hasEdit ? raw.new : undefined,
      content: hasWrite ? raw.content : undefined,
      expect: typeof raw.expect === 'string' ? raw.expect : null,
    },
  };
}

/**
 * Preflight: resolve paths, check uniqueness of edit matches, CAS expects.
 * Does not write.
 */
export function preflightApply(workspace, changes) {
  const workspaceResolved = path.resolve(workspace);
  const seen = new Set();
  const prepared = [];

  for (const raw of changes) {
    const n = normalizeChange(raw);
    if (!n.ok) return { ok: false, reason: n.reason, prepared: [] };
    const c = n.change;
    if (seen.has(c.path)) return { ok: false, reason: `duplicate path in batch: ${c.path}`, prepared: [] };
    seen.add(c.path);

    const full = safeResolveUnderRoot(workspaceResolved, c.path);
    if (!full) return { ok: false, reason: `path escapes workspace: ${c.path}`, prepared: [] };

    let exists = false;
    let content = null;
    if (fs.existsSync(full)) {
      const rawText = readFileNoFollow(full, { root: workspaceResolved });
      if (rawText === null) return { ok: false, reason: `cannot read ${c.path}`, prepared: [] };
      if (rawText.includes('\u0000')) return { ok: false, reason: `${c.path} is binary`, prepared: [] };
      exists = true;
      content = rawText;
    }

    if (c.kind === 'edit') {
      if (!exists) return { ok: false, reason: `no such file for edit: ${c.path}`, prepared: [] };
      let matches = 0;
      let at = content.indexOf(c.old);
      while (at !== -1) {
        matches += 1;
        if (matches > 1) break;
        at = content.indexOf(c.old, at + c.old.length);
      }
      if (matches === 0) return { ok: false, reason: `old text not found in ${c.path}`, prepared: [] };
      if (matches > 1) return { ok: false, reason: `old text appears more than once in ${c.path}`, prepared: [] };
      const after = content.replace(c.old, c.new);
      prepared.push({ ...c, exists, before: content, after, sha256Before: sha256(content), sha256After: sha256(after) });
    } else {
      if (exists && !c.expect) {
        return { ok: false, reason: `${c.path} exists — pass expect (sha256) to replace`, prepared: [] };
      }
      if (exists && c.expect) {
        const current = sha256(content);
        if (!current.startsWith(c.expect.trim().toLowerCase())) {
          return { ok: false, reason: `stale expect for ${c.path}`, prepared: [] };
        }
      }
      if (!exists && c.expect) {
        return { ok: false, reason: `${c.path} missing but expect was set`, prepared: [] };
      }
      prepared.push({
        ...c,
        exists,
        before: content,
        after: c.content,
        sha256Before: exists ? sha256(content) : null,
        sha256After: sha256(c.content),
      });
    }
  }

  return { ok: true, prepared };
}

/**
 * All-or-nothing multi-file apply. Uses the same edit/write primitives per file
 * after a successful preflight (single write path).
 */
export function runApply({ workspace, changes, dryRun = false } = {}) {
  if (!Array.isArray(changes) || changes.length === 0) {
    return failed('empty', 'apply needs at least one change', 'pass --spec <json-file> or JSON on --changes');
  }
  if (changes.length > 50) {
    return failed('too-many', 'apply refuses batches larger than 50 files', 'split the batch');
  }

  const pre = preflightApply(workspace, changes);
  if (!pre.ok) {
    return failed('preflight', pre.reason, 'fix conflicts then re-issue the full batch', { changes });
  }

  if (dryRun) {
    return {
      schema: APPLY_SCHEMA,
      mode: 'apply',
      status: 'ok',
      exitCode: 0,
      reason: null,
      dryRun: true,
      applied: pre.prepared.map((p) => ({
        path: p.path,
        kind: p.kind,
        sha256Before: p.sha256Before,
        sha256After: p.sha256After,
      })),
      changes: pre.prepared.map((p) => p.path),
      output: pre.prepared.map((p) => ({ line: `would ${p.kind} ${p.path}` })),
    };
  }

  if (ensureHarnessDir(workspace, false) === null) {
    return failed('no-harness', '.harness is not a real directory', null);
  }

  const applied = [];
  for (const p of pre.prepared) {
    let result;
    if (p.kind === 'edit') {
      result = runEdit({ workspace, path: p.path, old: p.old, next: p.new, dryRun: false });
    } else {
      result = runWrite({
        workspace,
        path: p.path,
        content: p.content,
        expect: p.expect,
        allowShrink: false,
        dryRun: false,
      });
    }
    if (result.status !== 'ok') {
      return {
        schema: APPLY_SCHEMA,
        mode: 'apply',
        status: 'failed',
        exitCode: 1,
        reason: 'partial-write',
        applied,
        failedPath: p.path,
        detail: result.reason,
        changes: pre.prepared.map((x) => x.path),
        output: [
          { line: `apply stopped on ${p.path}: ${result.reason || result.status}` },
          { line: `already applied: ${applied.map((a) => a.path).join(', ') || '(none)'}` },
          { line: 're-read files and re-issue the remaining batch (preflight was clean; a race may have occurred)' },
        ],
      };
    }
    applied.push({
      path: p.path,
      kind: p.kind,
      sha256Before: result.sha256Before,
      sha256After: result.sha256After,
      undo: result.undo,
    });
  }

  return {
    schema: APPLY_SCHEMA,
    mode: 'apply',
    status: 'ok',
    exitCode: 0,
    reason: null,
    dryRun: false,
    applied,
    changes: applied.map((a) => a.path),
    output: applied.map((a) => ({ line: `${a.kind} ${a.path}` })),
  };
}

/**
 * Parse --spec path (JSON array or { changes: [] }) or --changes inline JSON.
 */
export function parseApplySpec(argv) {
  const specPath = literalFlag(argv, '--spec');
  const inline = literalFlag(argv, '--changes');
  if (specPath && inline) {
    throw usageError('pass either --spec or --changes, not both', 'harness apply --spec patch.json');
  }
  if (!specPath && !inline) {
    throw usageError('apply needs --spec <file> or --changes <json>', 'harness apply --spec changes.json');
  }

  let text = inline;
  if (specPath) {
    const flags = parseFlags(argv);
    const workspace = path.resolve(flags.workspace);
    const full = safeResolveUnderRoot(workspace, specPath);
    if (!full || !fs.existsSync(full)) {
      throw usageError(`spec file not found: ${specPath}`, 'path is relative to the workspace');
    }
    text = readFileNoFollow(full, { root: workspace });
    if (text === null) throw usageError(`could not read spec: ${specPath}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw usageError(`invalid JSON for apply: ${error.message}`, 'expect an array of {path, old, new} or {path, content, expect?}');
  }

  const list = Array.isArray(parsed) ? parsed : (Array.isArray(parsed?.changes) ? parsed.changes : null);
  if (!list) {
    throw usageError('apply JSON must be an array or { "changes": [...] }');
  }
  return list;
}

export function applyResultOf(argv, ctx = {}) {
  const flags = parseFlags(argv.filter((a) => {
    // keep path flags for parseFlags workspace; strip JSON literals handled separately
    return true;
  }));
  const changes = parseApplySpec(argv);
  const result = runApply({
    workspace: path.resolve(flags.workspace),
    changes,
    dryRun: flags.dryRun || hasFlag(argv, '--dry-run'),
  });
  emitAudit(ctx, result);
  return result;
}

function emitAudit(ctx, result) {
  if (result.dryRun) return;
  const events = ctx?.events;
  const sink = typeof events?.withCommand === 'function' ? events.withCommand('apply') : events;
  sink?.emit?.('apply', {
    result: result.status === 'ok' ? 'pass' : 'fail',
    status: result.status,
    exitCode: result.exitCode,
    file: {
      path: result.applied?.map((a) => a.path).join(',') || null,
      reason: result.reason,
      count: result.applied?.length ?? 0,
    },
  });
}

function render(result, flags) {
  if (flags.json) {
    console.log(redactedJson(result, { pretty: flags.verbose }));
    return;
  }
  const keyWidth = keyWidthFor(['apply', 'status']);
  console.log(ui.line({
    state: result.status === 'ok' ? 'ok' : 'error',
    key: 'apply',
    value: result.status === 'ok'
      ? `${result.applied?.length || 0} file(s)`
      : (result.reason || 'failed'),
    keyWidth,
  }));
  for (const row of result.output || []) console.log(`  ${inertLine(row.line)}`);
}

export function applyExitFor(result) {
  return result?.status === 'ok' ? EXIT.ok : (result?.exitCode ?? 1);
}

export async function cmdApply(argv, ctx = {}) {
  const result = applyResultOf(argv, ctx);
  render(result, parseFlags(argv));
  ctx.reportStatus?.(result.status);
  return applyExitFor(result);
}
