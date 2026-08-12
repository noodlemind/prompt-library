import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import { findEntryByDocid, resolveDocPath } from './recall-rank.mjs';
import { safeResolveUnderRoot } from './path-safe.mjs';
import { readFileNoFollow } from './fs-safe.mjs';

/** The default window — sized for a knowledge-store excerpt, which is what
 * this command was built for. Exported because the registry declares the same
 * defaults on the flags; two spellings of one number is how help text and
 * behaviour drift apart. */
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
  // Where the window starts, 1-indexed. A bounded read with no start can only
  // ever show the beginning of a file, which is fine for a knowledge-store
  // excerpt — what this command was built for — and useless for reading source:
  // a model asked to change something 400 lines down re-read the first twenty
  // lines six times running and never found it. A length without an offset is
  // half a window.
  const offset = Math.max(1, Math.floor(flags.offset || 1));
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
  const allLines = raw.split(/\r?\n/);
  const start = Math.min(offset - 1, allLines.length);
  const lines = allLines.slice(start, start + maxLines);
  let excerpt = lines.join('\n');
  const clipped = Buffer.byteLength(excerpt, 'utf8') > maxBytes;
  if (clipped) {
    excerpt = truncateUtf8(excerpt, maxBytes);
  }
  // Derived from the WINDOW, not from comparing the excerpt to the raw file.
  // The split above normalizes CRLF to LF, so a complete read of a CRLF file
  // never equals its own source and reported itself truncated — which is the
  // one thing a caller uses this field to rule out.
  const truncated = clipped || start > 0 || start + lines.length < allLines.length;

  return {
    docid: entry.docid || entry.id || docid || null,
    path: entry.path || relPath,
    title: entry.title || path.basename(fullPath),
    excerpt,
    bytes: Buffer.byteLength(excerpt, 'utf8'),
    // An empty window has zero lines. `''.split('\n')` is `['']`, so the old
    // expression reported 1 for a read entirely past the end of the file, and
    // the agent lane rendered it as "lines 9999-9999".
    lines: excerpt === '' ? 0 : excerpt.split('\n').length,
    // Where this window sits in the file. Without these a caller cannot tell a
    // complete small file from the top of a large one, which is the difference
    // between "I have read this" and "I have read the first screen of this".
    offset,
    totalLines: allLines.length,
    // The digest of the WHOLE file, not of the excerpt above — `harness write
    // --expect` is a compare-and-swap against what is on disk, and a digest of
    // the first forty lines would authorize replacing content the caller never
    // saw. `truncated` says whether this read covered the file, so a caller can
    // tell "I have seen all of this" from "I have seen the beginning of it".
    sha256: createHash('sha256').update(raw, 'utf8').digest('hex'),
    truncated,
  };
}
