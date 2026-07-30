import fs from 'fs';
import path from 'path';
import { findEntryByDocid, resolveDocPath } from './recall-rank.mjs';
import { safeResolveUnderRoot } from './path-safe.mjs';
import { readFileNoFollow } from './fs-safe.mjs';

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
  // The trusted root `fullPath` resolved under — handed to readFileNoFollow so
  // the read is containment-verified (canonicalize-after-acquire) against the
  // SAME root, closing the ancestor-swap window before the leaf open.
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

  // readFileNoFollow (not fs.readFileSync): the O_NOFOLLOW open re-confirms the
  // leaf atomically, and `root: readRoot` adds the canonicalize-after-acquire
  // containment verify — the opened inode's realpath must sit under the real
  // root — so an ancestor swapped to an outside symlink between
  // safeResolveUnderRoot's walk and this read is caught, not trusted from a
  // moment earlier. No maxBytes override here — `flags.maxBytes` governs the
  // EXCERPT's truncation below, not what's admissible to read at all.
  const raw = readFileNoFollow(fullPath, { root: readRoot });
  if (raw === null) throw new Error(`file not found for ${docid || relPath}`);
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
