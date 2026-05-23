import fs from 'fs';
import path from 'path';
import { findEntryByDocid, resolveDocPath } from './recall-rank.mjs';
import { safeResolveUnderRoot } from './path-safe.mjs';

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
  const maxLines = flags.lines || 40;
  const maxBytes = flags.maxBytes || 2048;
  const workspaceResolved = path.resolve(workspace);

  let entry = null;
  let fullPath = null;

  if (docid) {
    entry = findEntryByDocid(copilotHome, workspace, docid);
    if (!entry) throw new Error(`docid not found in manifest: ${docid}`);
    fullPath = resolveDocPath(copilotHome, workspace, entry);
  } else if (relPath) {
    fullPath = safeResolveUnderRoot(workspaceResolved, relPath);
    if (!fullPath) throw new Error(`path escapes workspace: ${relPath}`);
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

  const raw = fs.readFileSync(fullPath, 'utf8');
  const lines = raw.split(/\r?\n/).slice(0, maxLines);
  let excerpt = lines.join('\n');
  if (Buffer.byteLength(excerpt, 'utf8') > maxBytes) {
    excerpt = truncateUtf8(excerpt, maxBytes);
  }

  return {
    docid: entry.docid || entry.id || docid || null,
    path: entry.path || relPath,
    title: entry.title || path.basename(fullPath),
    excerpt,
    bytes: Buffer.byteLength(excerpt, 'utf8'),
    lines: excerpt.split('\n').length,
  };
}
