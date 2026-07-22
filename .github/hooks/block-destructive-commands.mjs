#!/usr/bin/env node
/** PreToolUse terminal guard: block destructive shell commands. */
import fs from 'node:fs';
import { preToolDenyOutput } from './lib/hook-output.mjs';
import { normalizeToolPayload } from './lib/tool-payload.mjs';

const FORCE_FLAG = String.raw`(?:--force-with-lease|--force|(?<=\s)-[A-Za-z]*f[A-Za-z]*)`;
const BLOCKED = [
  /\brm\s+-rf\s+\//,
  new RegExp(String.raw`\bgit\s+push\b[^\n]*${FORCE_FLAG}\b[^\n]*\b(main|master)\b`, 'i'),
  new RegExp(String.raw`\bgit\s+push\b[^\n]*\b(main|master)\b[^\n]*${FORCE_FLAG}\b`, 'i'),
  // Force pushes and deletions expressed as refspecs: `+main`, `+HEAD:main`, `:main`.
  /\bgit\s+push\b[^\n]*\s\+\S*\b(main|master)\b/i,
  /\bgit\s+push\b[^\n]*\s:(?:refs\/heads\/)?(main|master)\b/i,
  /\bgit\s+reset\s+--hard\b/,
  /\bgit\s+clean\b[^;\n|&]*(?:-[a-zA-Z]*[dxX][a-zA-Z]*|\s+-[dxX]\b)/,
  /\bgit\s+config\s+--global\b/,
];

function output(value) {
  console.log(JSON.stringify(value));
}

function deny(reason) {
  if ((process.env.HARNESS_ENFORCEMENT || 'enforce') !== 'enforce') {
    output({ continue: true, systemMessage: `[harness hook] ${reason}` });
    process.exit(0);
  }
  output(preToolDenyOutput(reason));
  process.exit(0);
}

let payload;
try {
  const raw = fs.readFileSync(0, 'utf8');
  if (!raw.trim()) throw new Error('payload is empty');
  payload = JSON.parse(raw);
} catch (error) {
  deny(`invalid-hook-payload: ${error.message}`);
}

const { command } = normalizeToolPayload(payload);
for (const pattern of BLOCKED) {
  if (!pattern.test(command)) continue;
  deny('destructive-command: command blocked by Harness policy');
}

output({ continue: true });
