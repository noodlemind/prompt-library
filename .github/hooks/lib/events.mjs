import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

function ensureEventDir(workspace) {
  const dir = path.join(workspace, '.harness');
  fs.mkdirSync(dir, { recursive: true });
  const gitignore = path.join(dir, '.gitignore');
  if (!fs.existsSync(gitignore)) {
    fs.writeFileSync(gitignore, '# Ephemeral Harness state\n*\n!.gitignore\n', 'utf8');
  }
  return dir;
}

export function writeHookEvent(workspace, payload, fields) {
  try {
    const dir = ensureEventDir(workspace);
    const event = {
      version: 2,
      id: `${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`,
      ts: new Date().toISOString(),
      type: fields.type,
      command: 'hook',
      plan: fields.plan || null,
      phase: fields.phase || null,
      result: fields.result || (fields.success === false || fields.decision === 'block' ? 'fail' : 'pass'),
      exitCode: fields.exitCode ?? 0,
      checks: [],
      session: payload.session_id || payload.sessionId || fields.session || null,
      host: payload.host || 'github-copilot-vscode',
      agent: payload.agent || payload.agent_name || payload.agentName || null,
      skill: fields.skill || null,
      tool: fields.tool || null,
      mutation: Boolean(fields.mutation),
      targets: fields.targets || [],
      targetResolved: Boolean(fields.targetResolved),
      gate: fields.gate || null,
      decision: fields.decision || null,
      durationMs: fields.durationMs ?? 0,
    };
    if (fields.success !== undefined) event.success = Boolean(fields.success);
    if (fields.blockedReason) event.blockedReason = fields.blockedReason;
    fs.appendFileSync(path.join(dir, 'events.jsonl'), `${JSON.stringify(event)}\n`, 'utf8');
    return event;
  } catch {
    return null;
  }
}
