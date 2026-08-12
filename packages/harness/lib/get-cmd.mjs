import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import { findEntryByDocid, resolveDocPath } from './recall-rank.mjs';
import { safeResolveUnderRoot } from './path-safe.mjs';
import { readFileNoFollow } from './fs-safe.mjs';

export const GET_DEFAULT_LINES = 40;
export const GET_DEFAULT_MAX_BYTES = 2048;

function truncateUtf8(text, maxBytes) {
  let buf = Buffer.from(text, 'utf8');
  if (buf.length <= maxBytes) return text;
  buf = buf.slice(0, maxBytes);
  while (buf.length > 0 && (buf[buf.length - 1] & 0xc0) === 0x80) {
    buf = buf.slice(0, -1);
  }
  let excerpt = buf.toString('utf8');
  const lastNl = excerpt.lastIndexOf('\n');
  if (lastNl > maxBytes * 0.5) excerpt = excerpt.slice(0, lastNl);
  return `${excerpt}\n…(truncated)`;
}

export function runGet({ workspace, copilotHome, flags }) {
  const docid = flags.docid;
  const relPath = flags.path;
  const maxLines = flags.lines || GET_DEFAULT_LINES;
  const maxBytes = flags.maxBytes || GET_DEFAULT_MAX_BYTES;
    const offset = Math.max(1, Math.floor(flags.offset || 1));
  const workspaceResolved = path.resolve(workspace);

  let entry = null;
  let fullPath = null;
    let readRoot = null;

  if (docid) {
    entry = findEntryByDocid(copilotHome, workspace, docid);
    if (!entry) throw new Error(`docid not found in manifest: ${docid}`);
    const resolved = resolveDocPath(copilotHome, workspace, entry);
    fullPath = resolved?.full ?? null;
    readRoot = resolved?.root ?? null;
  } else if (relPath) {
    fullPath = safeResolveUnderRoot(workspaceResolved, relPath);
    if (!fullPath) throw new Error(`path escapes workspace: ${relPath}`);
    readRoot = workspaceResolved;
    entry = findEntryByDocid(copilotHome, workspace, path.basename(relPath, '.md')) || {
      docid: null,
      path: relPath,
      title: path.basename(relPath),
    };
  } else {
    throw new Error('get requires --docid <id> or --path <relative-path>');
  }

  if (!fullPath || !fs.existsSync(fullPath)) {
    throw new Error(`file not found for ${docid || relPath}`);
  }

    const raw = readFileNoFollow(fullPath, { root: readRoot });
  if (raw === null) throw new Error(`file not found for ${docid || relPath}`);
  const allLines = raw.split(/\r?\n/);
  const start = Math.min(offset - 1, allLines.length);
  const lines = allLines.slice(start, start + maxLines);
  let excerpt = lines.join('\n');
  const clipped = Buffer.byteLength(excerpt, 'utf8') > maxBytes;
  if (clipped) {
    excerpt = truncateUtf8(excerpt, maxBytes);
  }
    const truncated = clipped || start > 0 || start + lines.length < allLines.length;

  return {
    docid: entry.docid || entry.id || docid || null,
    path: entry.path || relPath,
    title: entry.title || path.basename(fullPath),
    excerpt,
    bytes: Buffer.byteLength(excerpt, 'utf8'),
        lines: excerpt === '' ? 0 : excerpt.split('\n').length,
        offset,
    totalLines: allLines.length,
        sha256: createHash('sha256').update(raw, 'utf8').digest('hex'),
    truncated,
  };
}
