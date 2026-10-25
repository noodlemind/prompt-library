import fs from 'node:fs';
import path from 'node:path';

function npmCliPath() {
  const candidates = [];
  if (process.env.npm_execpath) candidates.push(process.env.npm_execpath);
  const execDir = path.dirname(process.execPath);
  candidates.push(path.join(execDir, 'node_modules', 'npm', 'bin', 'npm-cli.js'));
  candidates.push(path.join(execDir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'));
  return candidates.find((candidate) => candidate && fs.existsSync(candidate)) || null;
}

/** Launch npm with Node when npm-cli.js is present. On Windows, cmd.exe runs npm.cmd. */
export function npmCommand(args) {
  const cli = npmCliPath();
  if (cli) return { command: process.execPath, args: [cli, ...args] };
  if (process.platform === 'win32') {
    const comspec = process.env.ComSpec || 'cmd.exe';
    return { command: comspec, args: ['/d', '/s', '/c', ['npm.cmd', ...args].join(' ')] };
  }
  return { command: 'npm', args };
}

/** Global install shims sit in prefix/ on Windows and prefix/bin elsewhere. */
export function globalBin(prefix, name) {
  if (process.platform === 'win32') return path.join(prefix, `${name}.cmd`);
  return path.join(prefix, 'bin', name);
}
