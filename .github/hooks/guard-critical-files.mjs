#!/usr/bin/env node
/**
 * PreToolUse (Edit/Write) — block edits to secrets and harness-owned global files.
 */
import fs from 'fs';

const BLOCKED = [
  /^\.env/i,
  /(?:^|/)[._]?credentials(?:\.|$)/i,
  /\.pem$/i,
  /\.key$/i,
  /node_modules\//,
  // Hydrated harness home only — not arbitrary paths containing `.copilot` as a substring
  /^(?:\/Users\/[^/]+\/\.copilot\/|\/home\/[^/]+\/\.copilot\/|[A-Za-z]:\/Users\/[^/]+\/\.copilot\/)/,
];

function readStdin() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

const raw = readStdin();
let filePath = '';
try {
  const payload = raw ? JSON.parse(raw) : {};
  filePath = payload.tool_input?.file_path || payload.file_path || payload.path || '';
} catch {
  process.exit(0);
}

if (!filePath) process.exit(0);

const norm = filePath.replace(/\\/g, '/');
for (const pattern of BLOCKED) {
  if (pattern.test(norm)) {
    console.error(`[harness hook] Blocked edit to sensitive or out-of-scope path: ${filePath}`);
    process.exit(2);
  }
}

process.exit(0);
