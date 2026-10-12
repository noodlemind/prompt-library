import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { getCorpusRoot } from './assets.mjs';
import { resolveCopilotHome } from './paths.mjs';
import { PLAYBOOKS } from './routing-policy.mjs';
import { assertNoSymlinkAncestors, readFileNoFollow } from './fs-safe.mjs';

function readPlaybook(id, root, copilotHome) {
  if (!PLAYBOOKS.includes(id) || !['corpus', 'copilot'].includes(root)) throw new Error('Unsupported playbook binding');
  const base = root === 'corpus' ? getCorpusRoot() : resolveCopilotHome(copilotHome);
  const rel = `skills/references/playbooks/${id}.md`;
  const full = assertNoSymlinkAncestors(base, rel);
  const source = full && readFileNoFollow(full, { root: base, maxBytes: 64 * 1024, encoding: null });
  if (!Buffer.isBuffer(source)) throw new Error('Bound playbook is missing, oversized or unsafe');
  const numbered = [...source.toString('utf8').matchAll(/^(\d+)\. ([^\r\n]+)$/gm)];
  if (!numbered.length || numbered.length > 100 || numbered.some((step, index) => Number(step[1]) !== index + 1 || step[2].length > 2000)) throw new Error('Playbook requires a bounded consecutive numbered sequence');
  return { version: 1, id, root, path: rel, sha256: createHash('sha256').update(source).digest('hex'), steps: numbered.map((step, index) => ({ id: `S${index + 1}`, text: step[2] })) };
}

export function bindPlaybook(id, { copilotHome } = {}) {
  if (!PLAYBOOKS.includes(id)) throw new Error('Unsupported playbook identity');
  const rel = `skills/references/playbooks/${id}.md`;
  const base = resolveCopilotHome(copilotHome);
  const root = fs.existsSync(path.join(base, rel)) ? 'copilot' : 'corpus';
  const { steps: _steps, ...binding } = readPlaybook(id, root, copilotHome);
  return binding;
}

export function validatePlaybookBinding(plan, { copilotHome } = {}) {
  const binding = plan?.fm?.playbook_binding;
  try {
    if (!binding || binding.version !== 1 || binding.id !== plan.fm.playbook || !/^[a-f0-9]{64}$/.test(binding.sha256 || '')
      || binding.path !== `skills/references/playbooks/${binding.id}.md` || Object.keys(binding).some(key => !['version', 'id', 'root', 'path', 'sha256'].includes(key))) throw new Error('Playbook needs an accepted content binding');
    const current = readPlaybook(binding.id, binding.root, copilotHome);
    if (current.sha256 !== binding.sha256) throw new Error('Bound playbook changed; accept a workflow amendment before synchronization');
    return { pass: true, message: 'Accepted playbook content is current', binding, steps: current.steps };
  } catch (error) { return { pass: false, message: error.message, binding, steps: [] }; }
}
