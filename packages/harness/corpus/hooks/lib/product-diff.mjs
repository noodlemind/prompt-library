import path from 'node:path';
import { spawnSync } from 'node:child_process';

export function readGitArgs(workspace, { timeout = 4000, env = process.env } = {}) {
  const args = ['-c', 'core.fsmonitor=false'];
  const config = spawnSync('git', ['--no-pager', ...args, 'config', '--includes', '--null', '--get-regexp', '^filter\\..*\\.(clean|smudge|process|required)$'], {
    cwd: workspace, encoding: 'utf8', timeout, maxBuffer: 64 * 1024, env,
  });
  if (config.error || ![0, 1].includes(config.status)) return null;
  const output = String(config.stdout || '');
  if (config.status === 1) return output === '' ? args : null;
  if (!output.endsWith('\0')) return null;
  const drivers = new Set();
  for (const entry of output.slice(0, -1).split('\0')) {
    const separator = entry.indexOf('\n');
    if (separator < 1) return null;
    const match = entry.slice(0, separator).match(/^filter\.(.+)\.(?:clean|smudge|process|required)$/i);
    if (!match || /[=\r\n\0]/.test(match[1])) return null;
    drivers.add(match[1]);
  }
  for (const driver of drivers) {
    for (const operation of ['clean', 'smudge', 'process']) args.push('-c', `filter.${driver}.${operation}=`);
    args.push('-c', `filter.${driver}.required=false`);
  }
  return args;
}

export function readProductDiff(workspace, { base = 'HEAD', planPath, timeout = 4000 } = {}) {
  if (typeof base !== 'string' || !base || base.startsWith('-') || /[\0\r\n]/.test(base)) return null;
  const prefix = readGitArgs(workspace, { timeout });
  if (!prefix) return null;
  const args = [...prefix, 'diff', '--no-ext-diff', '--no-textconv', base, '--', '.', ':(exclude).harness/**'];
  if (planPath) {
    const rel = path.relative(workspace, path.resolve(workspace, planPath)).replace(/\\/g, '/');
    if (rel && !rel.startsWith('../') && !path.isAbsolute(rel)) args.push(`:(literal,exclude)${rel}`);
  }
  const diff = spawnSync('git', args, { cwd: workspace, encoding: 'utf8', timeout });
  if (diff.error || diff.status !== 0) return null;
  return String(diff.stdout || '').split(/\r?\n/).filter(line => !/^index [0-9a-f]+\.\.[0-9a-f]+(?:\s|$)/.test(line)).join('\n');
}
