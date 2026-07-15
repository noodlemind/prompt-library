import fs from 'node:fs';
import path from 'node:path';

export function loadHookPolicy(workspace, { ttlKey, ttlDefault }) {
  let text = '';
  try {
    text = fs.readFileSync(path.join(workspace, '.github', 'harness', 'policy.yaml'), 'utf8');
  } catch {
    // A missing policy uses safe enforcement defaults.
  }
  const configured = text.match(/^enforcement:\s*(observe|warn|enforce)\s*$/m)?.[1];
  const environment = ['observe', 'warn', 'enforce'].includes(process.env.HARNESS_ENFORCEMENT)
    ? process.env.HARNESS_ENFORCEMENT
    : null;
  const ttl = Number(text.match(new RegExp(`^${ttlKey}:\\s*(\\d+)\\s*$`, 'm'))?.[1] || ttlDefault);
  return {
    enforcement: environment || configured || 'enforce',
    ttl: Number.isFinite(ttl) && ttl > 0 ? ttl : ttlDefault,
  };
}

export function enforcementExitCode(enforcement) {
  return enforcement === 'enforce' ? 2 : 0;
}
