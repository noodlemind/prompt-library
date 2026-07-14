#!/usr/bin/env node
/** PreToolUse edit gate: require recent explicit implement gate and planned scope. */
import fs from 'node:fs';
import path from 'node:path';

function readPayload() {
  const raw = fs.readFileSync(0, 'utf8');
  if (!raw.trim()) throw new Error('Hook payload is empty');
  return JSON.parse(raw);
}

function loadPolicy(workspace) {
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
  const ttl = Number(text.match(/^gate_ttl_minutes:\s*(\d+)\s*$/m)?.[1] || 30);
  return {
    enforcement: environment || configured || 'enforce',
    gateTtlMinutes: Number.isFinite(ttl) && ttl > 0 ? ttl : 30,
  };
}

let activePolicy = { enforcement: 'enforce', gateTtlMinutes: 30 };

function stop(message) {
  console.error(`[harness hook] ${message}`);
  process.exit(activePolicy.enforcement === 'enforce' ? 2 : 0);
}

function impactedFiles(text) {
  const section = text.match(/## Impacted Files\s*\n([\s\S]*?)(?=\n## |$)/i)?.[1] || '';
  return section
    .split(/\r?\n/)
    .map((line) => line.match(/^\s*-\s+`?([^`#]+?)`?\s*(?:#.*)?$/)?.[1]?.trim())
    .filter(Boolean)
    .map((entry) => entry.replace(/^\.\//, '').replace(/\\/g, '/'));
}

function inScope(file, entries) {
  return entries.some((entry) => {
    if (entry.endsWith('/**')) return file.startsWith(entry.slice(0, -2));
    if (entry.endsWith('/')) return file.startsWith(entry);
    return file === entry;
  });
}

function cleanShellToken(value) {
  const token = String(value || '').trim();
  if ((token.startsWith('"') && token.endsWith('"')) || (token.startsWith("'") && token.endsWith("'"))) {
    return token.slice(1, -1);
  }
  return token;
}

function tokenizeShell(segment) {
  return [...segment.matchAll(/"(?:\\.|[^"\\])*"|'[^']*'|[^\s]+/g)].map((match) => cleanShellToken(match[0]));
}

function withoutRedirections(args) {
  const result = [];
  for (let i = 0; i < args.length; i++) {
    if (/^(?:\d*>>?|&>)$/.test(args[i])) {
      i += 1;
      continue;
    }
    if (/^(?:\d*>>?|&>).+/.test(args[i])) continue;
    result.push(args[i]);
  }
  return result;
}

function parseGitInvocation(args) {
  const valueOptions = new Set([
    '-C',
    '-c',
    '--exec-path',
    '--git-dir',
    '--work-tree',
    '--namespace',
    '--super-prefix',
    '--config-env',
  ]);
  let cwd = '';
  let index = 0;
  while (index < args.length) {
    const arg = args[index];
    if (arg === '-C') {
      const value = args[index + 1];
      if (!value) return { subcommand: null, args: [], cwd };
      cwd = path.isAbsolute(value) ? value : path.join(cwd, value);
      index += 2;
      continue;
    }
    if (valueOptions.has(arg)) {
      index += 2;
      continue;
    }
    if (/^--(?:exec-path|git-dir|work-tree|namespace|super-prefix|config-env)=/.test(arg)) {
      index += 1;
      continue;
    }
    if (arg.startsWith('-')) {
      index += 1;
      continue;
    }
    return { subcommand: arg, args: args.slice(index + 1), cwd };
  }
  return { subcommand: null, args: [], cwd };
}

function withGitCwd(cwd, targets) {
  return targets.map((target) => (path.isAbsolute(target) || !cwd ? target : path.join(cwd, target)));
}

function analyzeShellMutation(command) {
  const targets = [];
  let mutates = false;
  const redirection = /(?:^|[\s;&|])(?:\d*>>?|&>)\s*("(?:\\.|[^"\\])*"|'[^']*'|[^\s;&|]+)/g;
  for (const match of command.matchAll(redirection)) {
    const target = cleanShellToken(match[1]);
    if (target.startsWith('&') || /^\/dev\/(?:null|stdout|stderr)$/.test(target)) continue;
    mutates = true;
    targets.push(target);
  }

  for (const segment of command.split(/(?:&&|\|\||[;|\n])/)) {
    const tokens = tokenizeShell(segment);
    while (tokens[0]?.includes('=') && !tokens[0].startsWith('=')) tokens.shift();
    const executable = path.basename(tokens[0] || '');
    const args = withoutRedirections(tokens.slice(1));
    const positional = args.filter((arg) => !arg.startsWith('-'));

    if (['touch', 'mkdir', 'rm', 'rmdir', 'unlink', 'truncate'].includes(executable)) {
      mutates = true;
      targets.push(...positional);
    } else if (['cp', 'install'].includes(executable)) {
      mutates = true;
      if (positional.length) targets.push(positional.at(-1));
    } else if (['mv', 'ln'].includes(executable)) {
      mutates = true;
      targets.push(...positional);
    } else if (executable === 'tee') {
      const teeTargets = args.filter((arg) => !arg.startsWith('-') && !arg.startsWith('/dev/'));
      if (teeTargets.length) {
        mutates = true;
        targets.push(...teeTargets);
      }
    } else if (
      ['sed', 'perl'].includes(executable) &&
      args.some((arg) => /^-[^-]*i/.test(arg) || (executable === 'sed' && /^--in-place(?:=|$)/.test(arg)))
    ) {
      mutates = true;
      if (positional.length > 1) targets.push(...positional.slice(1));
    } else if (executable === 'git') {
      const git = parseGitInvocation(args);
      if (['apply', 'checkout', 'restore', 'rm', 'mv', 'clean'].includes(git.subcommand)) {
        mutates = true;
        const separator = git.args.indexOf('--');
        let gitTargets = separator >= 0 ? git.args.slice(separator + 1) : [];
        if (separator < 0 && ['restore', 'rm', 'mv', 'clean'].includes(git.subcommand)) {
          gitTargets = git.args.filter((arg) => !arg.startsWith('-'));
        }
        targets.push(...withGitCwd(git.cwd, gitTargets));
      }
    }
  }

  return { mutates, targets };
}

function mutationTargets(payload) {
  const input = payload.tool_input || {};
  const targets = [];
  for (const candidate of [payload.file_path, payload.path, input.file_path, input.path]) {
    if (typeof candidate === 'string' && candidate.trim()) targets.push(candidate.trim());
  }
  for (const collection of [input.files, input.edits]) {
    if (!Array.isArray(collection)) continue;
    for (const item of collection) {
      const candidate = typeof item === 'string' ? item : item?.file_path || item?.path;
      if (typeof candidate === 'string' && candidate.trim()) targets.push(candidate.trim());
    }
  }

  const patchText = input.patch || input.input || '';
  for (const match of String(patchText).matchAll(/^\*\*\* (?:Add|Update|Delete) File:\s+(.+)$/gm)) {
    targets.push(match[1].trim());
  }

  const command = input.command || payload.command || '';
  const shell = command ? analyzeShellMutation(command) : { mutates: false, targets: [] };
  return {
    mutates: targets.length > 0 || shell.mutates,
    targets: [...new Set([...targets, ...shell.targets])],
  };
}

let payload;
try {
  payload = readPayload();
} catch (error) {
  console.error(`[harness hook] Invalid hook payload: ${error.message}`);
  process.exit(2);
}
const workspace = path.resolve(payload.workspace || payload.cwd || process.cwd());
activePolicy = loadPolicy(workspace);
const mutation = mutationTargets(payload);
if (!mutation.mutates) process.exit(0);
if (mutation.targets.length === 0) stop('Mutation target could not be resolved for scope validation');

const relatives = mutation.targets.map((target) => {
  const relative = path.relative(workspace, path.resolve(workspace, target)).replace(/\\/g, '/');
  if (relative.startsWith('../') || path.isAbsolute(relative)) stop(`Edit target is outside workspace: ${target}`);
  return relative;
});
const governed = relatives.filter((relative) => !relative.startsWith('docs/plans/') && !relative.startsWith('.harness/'));
if (governed.length === 0) process.exit(0);

const sessionPath = path.join(workspace, '.harness', 'session.json');
if (!fs.existsSync(sessionPath)) stop('No harness session; run an explicit implement gate before edits');

let session;
try {
  session = JSON.parse(fs.readFileSync(sessionPath, 'utf8'));
} catch {
  stop('Harness session is unreadable');
}
if (session.gateStatus !== 'pass' || !session.gatedPlan || !session.lastGateAt) {
  stop('Implement gate has not passed for an explicit plan');
}
const lastGateAt = Date.parse(session.lastGateAt);
if (!Number.isFinite(lastGateAt)) stop('Implement gate timestamp is invalid; rerun harness gate --phase implement --plan <path>');
if (Date.now() - lastGateAt > activePolicy.gateTtlMinutes * 60 * 1000) {
  stop('Implement gate is stale; rerun harness gate --phase implement --plan <path>');
}

const planPath = path.resolve(workspace, session.gatedPlan);
if (!planPath.startsWith(path.join(workspace, 'docs', 'plans') + path.sep) || !fs.existsSync(planPath)) {
  stop('Gated plan is missing or outside docs/plans');
}
const allowed = impactedFiles(fs.readFileSync(planPath, 'utf8'));
for (const relative of governed) {
  if (!inScope(relative, allowed)) stop(`File is outside the plan's ## Impacted Files: ${relative}`);
}

session.lastEditAt = new Date().toISOString();
session.lastEditTargets = governed;
try {
  fs.writeFileSync(sessionPath, `${JSON.stringify(session, null, 2)}\n`, 'utf8');
} catch (error) {
  stop(`Harness session could not record pending edits: ${error.message}`);
}
process.exit(0);
