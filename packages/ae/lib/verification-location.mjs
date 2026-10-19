import fs from 'node:fs';
import path from 'node:path';
import { assertNoSymlinkAncestors, readFileNoFollow } from './fs-safe.mjs';

export function locateVerification(workspace, selected = null, { limit = 32 } = {}) {
  const warnings = [];
  if (assertNoSymlinkAncestors(workspace, 'docs/features') && fs.existsSync(path.join(workspace, 'docs/features'))) warnings.push('extra-feature-directory');
  const valid = rel => {
    if (typeof rel !== 'string' || rel.includes('\\') || /[\x00-\x1f\x7f:]/.test(rel) || path.isAbsolute(rel) || rel.split('/').includes('..') || !rel.endsWith('/SKILL.md')) return false;
    const source = readFileNoFollow(path.join(workspace, rel), { root: workspace, maxBytes: 64 * 1024 });
    return source !== null;
  };
  if (selected) return valid(selected) ? { state: 'selected', path: selected, warnings } : { state: 'invalid', path: null, warnings };
  const candidates = [];
  const skills = assertNoSymlinkAncestors(workspace, '.cursor/skills');
  if (skills && fs.existsSync(skills)) {
    let dir;
    try {
      dir = fs.opendirSync(skills);
      let entry, visited = 0;
      while ((entry = dir.readSync())) {
        if (++visited > limit) return { state: 'incomplete', path: null, candidates: candidates.sort(), warnings };
        if (!entry.isDirectory() || !entry.name.startsWith('verify-')) continue;
        const rel = `.cursor/skills/${entry.name}/SKILL.md`;
        if (valid(rel)) candidates.push(rel);
      }
    } catch { return { state: 'incomplete', path: null, candidates, warnings }; }
    finally { dir?.closeSync(); }
  }
  if (candidates.length > 1) return { state: 'ambiguous', path: null, candidates: candidates.sort(), warnings };
  if (candidates.length === 1) return { state: 'selected', path: candidates[0], warnings };
  return valid('docs/verification/SKILL.md') ? { state: 'selected', path: 'docs/verification/SKILL.md', warnings }
    : { state: 'absent', path: null, warnings };
}
