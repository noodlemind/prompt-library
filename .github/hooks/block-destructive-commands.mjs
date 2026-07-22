#!/usr/bin/env node
/** PreToolUse terminal guard: block destructive shell commands. */
import fs from 'node:fs';
import { normalizeToolPayload } from './lib/tool-payload.mjs';

const BLOCKED = [
  /\brm\s+-rf\s+\//,
  /\bgit\s+push\b[^\n]*(?:--force-with-lease|--force|-[A-Za-z]*f[A-Za-z]*)\b[^\n]*\b(main|master)\b/i,
  /\bgit\s+push\b[^\n]*\b(main|master)\b[^\n]*(?:--force-with-lease|--force|-[A-Za-z]*f[A-Za-z]*)\b/i,
  /\bgit\s+reset\s+--hard\b/,
  /\bgit\s+clean\b[^;\n|&]*(?:-[a-zA-Z]*[dxX][a-zA-Z]*|\s+-[dxX]\b)/,
  /\bgit\s+config\s+--global\b/,
];

let payload;
try {
  payload = JSON.parse(fs.readFileSync(0, 'utf8') || '{}');
} catch {
  process.exit(0);
}

const { command } = normalizeToolPayload(payload);
for (const pattern of BLOCKED) {
  if (!pattern.test(command)) continue;
  console.log(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: 'destructive-command: command blocked by Harness policy',
    },
  }));
  process.exit(0);
}

console.log(JSON.stringify({ continue: true }));
