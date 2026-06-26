#!/usr/bin/env node
/**
 * PreToolUse (Bash) — block destructive shell commands.
 */
import fs from 'fs';

const BLOCKED = [
  /\brm\s+-rf\s+\//,
  /\bgit\s+push\b[^\n]*(?:--force-with-lease|--force)\b[^\n]*\b(main|master)\b/i,
  /\bgit\s+push\b[^\n]*\b(main|master)\b[^\n]*(?:--force-with-lease|--force)\b/i,
  /\bgit\s+reset\s+--hard\b/,
  // Destructive clean: -d, -x, or -X in flag cluster (-fd, -fx, -fX, -ffd, etc.) — not benign `git clean -f <path>`
  /\bgit\s+clean\b[^;\n|&]*(?:-[a-zA-Z]*[dxX][a-zA-Z]*|\s+-[dxX]\b)/,
  /\bgit\s+config\s+--global\b/,
];

function readStdin() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

const raw = readStdin();
let command = '';
try {
  const payload = raw ? JSON.parse(raw) : {};
  command = payload.tool_input?.command || payload.command || '';
} catch {
  process.exit(0);
}

if (!command) process.exit(0);

for (const pattern of BLOCKED) {
  if (pattern.test(command)) {
    console.error(`[harness hook] Blocked destructive command: ${command}`);
    process.exit(2);
  }
}

process.exit(0);
