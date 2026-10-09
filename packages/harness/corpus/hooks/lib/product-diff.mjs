import path from 'node:path';
import { spawnSync } from 'node:child_process';

export function readProductDiff(workspace, { base = 'HEAD', planPath, timeout = 4000 } = {}) {
  if (typeof base !== 'string' || !base || base.startsWith('-') || /[\0\r\n]/.test(base)) return null;
  const args = ['diff', '--no-ext-diff', base, '--', '.', ':(exclude).harness/**'];
  if (planPath) {
    const rel = path.relative(workspace, path.resolve(workspace, planPath)).replace(/\\/g, '/');
    if (rel && !rel.startsWith('../') && !path.isAbsolute(rel)) args.push(`:(literal,exclude)${rel}`);
  }
  const diff = spawnSync('git', args, { cwd: workspace, encoding: 'utf8', timeout });
  if (diff.error || diff.status !== 0) return null;
  return String(diff.stdout || '').split(/\r?\n/).filter(line => !/^index [0-9a-f]+\.\.[0-9a-f]+(?:\s|$)/.test(line)).join('\n');
}
