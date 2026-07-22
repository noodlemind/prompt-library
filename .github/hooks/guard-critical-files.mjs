#!/usr/bin/env node
/** PreToolUse mutation guard: block secrets and Harness-owned global files. */
import fs from 'node:fs';
import { normalizeToolPayload } from './lib/tool-payload.mjs';

const BLOCKED = [
  /(?:^|\/)\.env(?:\.|$)/i,
  /(?:^|\/)[._]?credentials(?:\.|$)/i,
  /\.pem$/i,
  /\.key$/i,
  /node_modules\//,
  /(?:^|\/)\.harness(?:\/|$)/,
  /(?:^|\/)\.copilot\//,
];

let payload;
try {
  payload = JSON.parse(fs.readFileSync(0, 'utf8') || '{}');
} catch {
  process.exit(0);
}

const mutation = normalizeToolPayload(payload);
if (!mutation.mutation) {
  console.log(JSON.stringify({ continue: true }));
  process.exit(0);
}
for (const target of mutation.targets) {
  const normalized = target.replace(/\\/g, '/');
  if (!BLOCKED.some((pattern) => pattern.test(normalized))) continue;
  console.log(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: `sensitive-path: ${target}`,
    },
  }));
  process.exit(0);
}

console.log(JSON.stringify({ continue: true }));
