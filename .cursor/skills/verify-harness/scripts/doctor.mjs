#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { binPath, packageRoot, repoRoot } from './lib.mjs';

const problems = [];

function note(ok, message) {
  process.stdout.write(`${ok ? 'ok' : 'fail'}  ${message}\n`);
  if (!ok) problems.push(message);
}

const major = Number.parseInt(process.versions.node, 10);
note(major >= 20, `node ${process.versions.node} (need >= 20)`);
note(fs.existsSync(binPath), `harness bin at ${binPath}`);
note(fs.existsSync(path.join(packageRoot, 'package.json')), `harness package at ${packageRoot}`);

try {
  const { createRequire } = await import('node:module');
  const requireYaml = createRequire(path.join(packageRoot, 'package.json'));
  requireYaml('yaml');
  note(true, 'yaml package loads');
} catch (error) {
  note(false, `yaml package loads (${error.message})`);
}

const git = spawnSync('git', ['--version'], { encoding: 'utf8' });
note(git.status === 0, `git on PATH (${(git.stdout || git.stderr).trim() || git.status})`);

const help = spawnSync(process.execPath, [binPath, '--help'], { encoding: 'utf8', cwd: packageRoot });
note(help.status === 0, `harness --help exits 0`);
note(/plan-new/.test(help.stdout) && /prepare/.test(help.stdout) && /gate/.test(help.stdout) && /worktree/.test(help.stdout), 'harness --help names prepare, plan-new, gate, and worktree');
note(fs.existsSync(path.join(repoRoot, '.cursor/skills/verify-harness/SKILL.md')), 'verify-harness skill is present');

if (problems.length) {
  process.stderr.write(`doctor failed:\n${problems.map((line) => `- ${line}`).join('\n')}\n`);
  process.exit(1);
}
process.stdout.write('doctor passed\n');
