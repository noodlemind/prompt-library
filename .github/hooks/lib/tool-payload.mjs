import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const FILE_MUTATION_TOOLS = new Set([
  'Edit',
  'Write',
  'MultiEdit',
  'edit',
  'editFiles',
  'multi_replace_string_in_file',
  'replace_string_in_file',
  'insert_edit_into_file',
  'edit_notebook_file',
  'create_new_jupyter_notebook',
  'apply_patch',
  'create_file',
  'createFile',
  'create_new_file',
  'create_directory',
]);

export const TERMINAL_TOOLS = new Set([
  'run_in_terminal',
  'runTerminalCommand',
  'execute',
  'Bash',
]);

const SKILL_READ_TOOLS = new Set([
  'read',
  'Read',
  'read_file',
  'readFile',
  'copilot_readFile',
  'read_skill',
  'readSkill',
]);

export const READ_ONLY_TOOLS = new Set([
  ...SKILL_READ_TOOLS,
  'grep_search',
  'file_search',
  'list_dir',
  'semantic_search',
  'list_code_usages',
  'get_errors',
  'get_changed_files',
  'get_search_view_results',
  'test_search',
  'github_repo',
  'fetch_webpage',
  'open_file',
  'open_simple_browser',
  'codebase',
  'search',
  'usages',
  'changes',
  'problems',
  'terminalLastCommand',
  'get_terminal_output',
  'think',
  'todos',
]);

const PRIMITIVE_PREFIXES = [
  '.github/skills/',
  '.github/agents/',
  '.github/instructions/',
  '.github/prompts/',
  '.github/checks/',
  'enterprise/skills/',
];

const PRIMITIVE_FILES = new Set(['knowledge/capability-registry.yaml']);

function cleanShellToken(value) {
  const token = String(value || '').trim();
  if ((token.startsWith('"') && token.endsWith('"')) || (token.startsWith("'") && token.endsWith("'"))) {
    return token.slice(1, -1);
  }
  return token;
}

export function tokenizeShell(segment) {
  return [...segment.matchAll(/"(?:\\.|[^"\\])*"|'[^']*'|[^\s]+/g)].map((match) => cleanShellToken(match[0]));
}

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=.*/;
const POSIX_SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh']);
const POWERSHELLS = new Set(['powershell', 'powershell.exe', 'pwsh', 'pwsh.exe']);

/** Strip env/command/nohup wrappers and VAR=value prefixes from a token list. */
export function unwrapLeadingWrappers(tokens) {
  const normalized = tokens.slice();
  let progressed = true;
  while (progressed) {
    progressed = false;
    while (normalized[0] && ASSIGNMENT.test(normalized[0])) {
      normalized.shift();
      progressed = true;
    }
    const base = path.basename(normalized[0] || '').toLowerCase();
    if (base === 'env') {
      normalized.shift();
      while (normalized.length) {
        if (ASSIGNMENT.test(normalized[0])) normalized.shift();
        else if (normalized[0] === '--') {
          normalized.shift();
          break;
        } else if (normalized[0] === '-u' || normalized[0] === '--unset') normalized.splice(0, 2);
        else if (/^--unset=/.test(normalized[0]) || /^-(?:i|0)$/.test(normalized[0]) || normalized[0] === '--ignore-environment') {
          normalized.shift();
        } else if (normalized[0].startsWith('-')) normalized.shift();
        else break;
      }
      progressed = true;
    } else if (base === 'command' || base === 'nohup') {
      normalized.shift();
      if (base === 'command') {
        if (normalized[0] === '-p' || normalized[0] === '-v' || normalized[0] === '-V') normalized.shift();
        if (normalized[0] === '--') normalized.shift();
      } else {
        while (normalized[0]?.startsWith('-')) normalized.shift();
      }
      progressed = true;
    }
  }
  return normalized;
}

/** Split a command into unwrapped argv segments, recursing into sh/bash/pwsh -c. */
export function unwrapShellSegments(command) {
  const out = [];
  function collect(text) {
    for (const segment of String(text || '').split(/(?:&&|\|\||[;|\n])/)) {
      const tokens = unwrapLeadingWrappers(tokenizeShell(segment));
      if (!tokens.length) continue;
      const exe = path.basename(tokens[0] || '').toLowerCase();
      if (POSIX_SHELLS.has(exe)) {
        const flagIndex = tokens.findIndex((token, index) => index > 0 && /^-[A-Za-z]*c$/.test(token));
        const nested = flagIndex > 0 ? tokens[flagIndex + 1] : null;
        if (nested) collect(nested);
        continue;
      }
      if (POWERSHELLS.has(exe)) {
        const flagIndex = tokens.findIndex((token, index) => index > 0 && /^-c(?:ommand)?$/i.test(token));
        const nested = flagIndex > 0 ? tokens[flagIndex + 1] : null;
        if (nested) collect(nested);
        continue;
      }
      out.push(tokens);
    }
  }
  collect(command);
  return out;
}

function withoutRedirections(args) {
  const result = [];
  for (let i = 0; i < args.length; i++) {
    if (/^(?:\d*>>?\|?|&>>?)$/.test(args[i])) {
      i += 1;
      continue;
    }
    if (/^(?:\d*>>?\|?|&>>?).+/.test(args[i])) continue;
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

function withoutHeredocBodies(commandText) {
  let delimiter = null;
  return String(commandText || '')
    .split('\n')
    .map((line) => {
      if (delimiter) {
        if (line.trim() === delimiter) {
          delimiter = null;
          return line;
        }
        return '';
      }
      const opener = line.match(/<<-?\s*(?:(['"])([^'"]+)\1|([A-Za-z0-9_]+))\s*$/);
      if (opener) delimiter = opener[2] || opener[3];
      return line;
    })
    .join('\n');
}

const POWERSHELL_WRITERS = new Set([
  'set-content',
  'add-content',
  'clear-content',
  'out-file',
  'new-item',
  'copy-item',
  'move-item',
  'rename-item',
  'remove-item',
  'tee-object',
]);

const POWERSHELL_PATH_PARAMS = /^-(?:path|literalpath|filepath|destination|newname|outfile)$/i;

export function analyzeShellMutation(command) {
  const targets = [];
  const mkdirCreated = [];
  let mutation = false;
  const commandText = String(command || '');
  const shellControlText = withoutHeredocBodies(commandText);
  const redirection = /(?<![<>])(?:\d*>>?\|?|&>>?)\s*("(?:\\.|[^"\\])*"|'[^']*'|[^\s;&|]+)/g;
  for (const match of shellControlText.matchAll(redirection)) {
    const target = cleanShellToken(match[1]);
    if (target.startsWith('&') || /^\/dev\/(?:null|stdout|stderr)$/.test(target)) continue;
    mutation = true;
    targets.push(target);
  }

  const interpreterWrite = /(?:^|[;&|]\s*)(?:python\d*|node|ruby)\b[\s\S]*\b(?:write_text|write_bytes|writeFile(?:Sync)?|appendFile(?:Sync)?|rmSync|mkdirSync|renameSync|copyFileSync|File\.write|File\.open)\s*\(/m;
  const mutatingOpen = /\bopen\s*\(\s*(['"])([^'"]+)\1\s*,\s*(['"])[wa+][^'"]*\3/g;
  if (interpreterWrite.test(commandText) || mutatingOpen.test(commandText)) {
    mutation = true;
    for (const match of commandText.matchAll(/\b(?:pathlib\.)?Path\s*\(\s*(['"])([^'"]+)\1\s*\)/g)) {
      targets.push(match[2]);
    }
    for (const match of commandText.matchAll(/\bopen\s*\(\s*(['"])([^'"]+)\1/g)) {
      targets.push(match[2]);
    }
  }

  for (const segment of shellControlText.split(/(?:&&|\|\||[;|\n])/)) {
    const tokens = tokenizeShell(segment);
    let unwrapped = true;
    while (unwrapped) {
      unwrapped = false;
      while (tokens[0]?.includes('=') && !tokens[0].startsWith('=')) tokens.shift();
      if (['env', 'command', 'nohup'].includes(path.basename(tokens[0] || ''))) {
        tokens.shift();
        while (tokens[0]?.startsWith('-')) tokens.shift();
        unwrapped = true;
      }
    }
    const executable = path.basename(tokens[0] || '').toLowerCase();
    const args = withoutRedirections(tokens.slice(1));
    const positional = args.filter((arg) => !arg.startsWith('-'));

    if (['sh', 'bash', 'zsh', 'dash', 'ksh'].includes(executable)) {
      const flagIndex = tokens.findIndex((token, index) => index > 0 && /^-[A-Za-z]*c$/.test(token));
      const nestedCommand = flagIndex > 0 ? tokens[flagIndex + 1] : null;
      if (nestedCommand) {
        const nested = analyzeShellMutation(nestedCommand);
        if (nested.mutation) mutation = true;
        targets.push(...nested.targets);
        mkdirCreated.push(...nested.mkdirTargets);
      }
      continue;
    }
    if (['powershell', 'powershell.exe', 'pwsh', 'pwsh.exe'].includes(executable)) {
      const flagIndex = tokens.findIndex((token, index) => index > 0 && /^-c(?:ommand)?$/i.test(token));
      const nestedCommand = flagIndex > 0 ? tokens[flagIndex + 1] : null;
      if (nestedCommand) {
        const nested = analyzeShellMutation(nestedCommand);
        if (nested.mutation) mutation = true;
        targets.push(...nested.targets);
        mkdirCreated.push(...nested.mkdirTargets);
      }
      continue;
    }
    if (POWERSHELL_WRITERS.has(executable)) {
      mutation = true;
      const named = [];
      const bare = [];
      const valueParams = /^-(?:value|itemtype|encoding|name)$/i;
      for (let index = 0; index < args.length; index += 1) {
        if (POWERSHELL_PATH_PARAMS.test(args[index])) {
          if (args[index + 1] && !args[index + 1].startsWith('-')) named.push(args[index + 1]);
          index += 1;
        } else if (valueParams.test(args[index])) {
          index += 1;
        } else if (!args[index].startsWith('-')) {
          bare.push(args[index]);
        }
      }
      // Positional form is `Set-Content <path> <value>`; only the first operand
      // is a path, and none are once -Path/-LiteralPath is given explicitly.
      const positionalPaths = ['set-content', 'add-content'].includes(executable)
        ? named.length
          ? []
          : bare.slice(0, 1)
        : bare;
      const cmdletTargets = [...named, ...positionalPaths];
      targets.push(...cmdletTargets);
      if (executable === 'new-item' && args.some((arg, index) => /^-itemtype$/i.test(arg) && /^dir/i.test(args[index + 1] || ''))) {
        mkdirCreated.push(...cmdletTargets);
      }
      continue;
    }

    if (['touch', 'rm', 'rmdir', 'unlink', 'truncate', 'del', 'erase', 'rd'].includes(executable)) {
      mutation = true;
      targets.push(...positional);
    } else if (executable === 'mkdir' || executable === 'md') {
      mutation = true;
      targets.push(...positional);
      mkdirCreated.push(...positional);
    } else if (executable === 'dd') {
      for (const arg of args) {
        const output = arg.match(/^of=(.+)$/);
        if (output) {
          mutation = true;
          targets.push(cleanShellToken(output[1]));
        }
      }
    } else if (['cp', 'install'].includes(executable)) {
      mutation = true;
      if (positional.length) targets.push(positional.at(-1));
    } else if (['mv', 'ln'].includes(executable)) {
      mutation = true;
      targets.push(...positional);
    } else if (executable === 'tee') {
      const teeTargets = args.filter((arg) => !arg.startsWith('-') && !arg.startsWith('/dev/'));
      if (teeTargets.length) {
        mutation = true;
        targets.push(...teeTargets);
      }
    } else if (
      ['sed', 'perl'].includes(executable) &&
      args.some((arg) => /^-[^-]*i/.test(arg) || (executable === 'sed' && /^--in-place(?:=|$)/.test(arg)))
    ) {
      mutation = true;
      if (positional.length > 1) targets.push(...positional.slice(1));
    } else if (executable === 'git') {
      const git = parseGitInvocation(args);
      if (
        ['apply', 'checkout', 'restore', 'rm', 'mv', 'clean', 'reset', 'stash', 'switch', 'merge', 'rebase', 'cherry-pick', 'revert', 'am', 'pull'].includes(
          git.subcommand
        )
      ) {
        mutation = true;
        const separator = git.args.indexOf('--');
        let gitTargets = separator >= 0 ? git.args.slice(separator + 1) : [];
        if (separator < 0 && ['restore', 'rm', 'mv', 'clean'].includes(git.subcommand)) {
          gitTargets = git.args.filter((arg) => !arg.startsWith('-'));
        }
        targets.push(...withGitCwd(git.cwd, gitTargets));
      }
    }
  }

  // The planned-ancestor exception is only safe for paths that mkdir alone
  // touches: a compound command that also mutates the same path (for example
  // `mkdir -p src && rm -rf src`) gets no exception for it.
  const mkdirOnly = new Set(mkdirCreated);
  for (const target of targets) {
    let occurrences = 0;
    for (const candidate of targets) if (candidate === target) occurrences += 1;
    let created = 0;
    for (const candidate of mkdirCreated) if (candidate === target) created += 1;
    if (occurrences > created) mkdirOnly.delete(target);
  }
  return { mutation, targets, mkdirTargets: [...mkdirOnly] };
}

function addPath(targets, value) {
  if (typeof value === 'string' && value.trim()) targets.push(value.trim());
}

function itemPath(item) {
  if (typeof item === 'string') return item;
  return item?.filePath || item?.file_path || item?.path;
}

function canonicalPath(value) {
  const lexical = path.resolve(value);
  try {
    return fs.realpathSync(lexical);
  } catch {
    return lexical;
  }
}

function workspaceFromTranscript(transcriptPath) {
  if (typeof transcriptPath !== 'string' || !transcriptPath.trim()) return null;
  let cursor = path.dirname(path.resolve(transcriptPath));
  for (let depth = 0; depth < 6; depth += 1) {
    const metadataPath = path.join(cursor, 'workspace.json');
    if (fs.existsSync(metadataPath)) {
      try {
        const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
        const value = metadata.folder || metadata.workspace;
        if (typeof value === 'string' && value) {
          return canonicalPath(value.startsWith('file:') ? fileURLToPath(value) : value);
        }
      } catch {
        return null;
      }
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  return null;
}

function workspaceFromTarget(target) {
  if (typeof target !== 'string' || !path.isAbsolute(target)) return null;
  let cursor = path.resolve(target);
  while (!fs.existsSync(cursor)) {
    const parent = path.dirname(cursor);
    if (parent === cursor) return null;
    cursor = parent;
  }
  if (!fs.statSync(cursor).isDirectory()) cursor = path.dirname(cursor);
  while (true) {
    if (fs.existsSync(path.join(cursor, '.git')) || fs.existsSync(path.join(cursor, '.harness'))) {
      return canonicalPath(cursor);
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) return null;
    cursor = parent;
  }
}

export function resolveHookWorkspace(payload = {}, targets = []) {
  if (typeof payload.workspace === 'string' && payload.workspace.trim()) return canonicalPath(payload.workspace);
  const transcriptWorkspace = workspaceFromTranscript(payload.transcript_path || payload.transcriptPath);
  if (transcriptWorkspace) return transcriptWorkspace;
  for (const target of targets) {
    const targetWorkspace = workspaceFromTarget(target);
    if (targetWorkspace) return targetWorkspace;
  }
  return canonicalPath(payload.cwd || process.cwd());
}

function parseToolInput(value) {
  if (value && typeof value === 'object') return value;
  if (typeof value !== 'string' || !value.trim()) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

export function normalizeToolPayload(payload = {}) {
  const input = parseToolInput(payload.tool_input);
  const toolName = String(payload.tool_name || payload.toolName || '').trim();
  const targets = [];
  for (const candidate of [
    payload.filePath,
    payload.file_path,
    payload.path,
    input.filePath,
    input.file_path,
    input.path,
  ]) addPath(targets, candidate);

  for (const collection of [input.files, input.edits, input.replacements]) {
    if (!Array.isArray(collection)) continue;
    for (const item of collection) addPath(targets, itemPath(item));
  }

  const patchText = input.patch || input.input || '';
  for (const match of String(patchText).matchAll(/^\*\*\* (?:(?:Add|Update|Delete) File|Move to):\s+(.+)$/gm)) {
    addPath(targets, match[1]);
  }

  const command = input.command || payload.command || '';
  const shell = TERMINAL_TOOLS.has(toolName) || command
    ? analyzeShellMutation(command)
    : { mutation: false, targets: [], mkdirTargets: [] };
  targets.push(...shell.targets);
  const uniqueTargets = [...new Set(targets)];
  // Fail closed on unrecognized tools: any payload naming a concrete file
  // target is a mutation unless the tool is a known read-only or terminal tool
  // (terminal mutations are decided by shell analysis above).
  const mutation = FILE_MUTATION_TOOLS.has(toolName)
    || shell.mutation
    || (uniqueTargets.length > 0 && !READ_ONLY_TOOLS.has(toolName) && !TERMINAL_TOOLS.has(toolName));
  const workspace = resolveHookWorkspace(payload, uniqueTargets);

  return {
    toolName,
    toolInput: input,
    command,
    mutation,
    targets: uniqueTargets,
    mkdirTargets: [...new Set(shell.mkdirTargets)],
    targetResolved: !mutation || uniqueTargets.length > 0,
    sessionId: payload.session_id || payload.sessionId || null,
    hookEvent: payload.hook_event_name || payload.hookEventName || null,
    workspace,
  };
}

export function toolMutationSucceeded(payload = {}) {
  if (payload.success === false || payload.ok === false) return false;
  if (payload.error || payload.tool_error || payload.toolError) return false;
  if ((payload.hook_event_name || payload.hookEventName) === 'PostToolUseFailure') return false;
  if (payload.tool_response && typeof payload.tool_response === 'object') {
    if (payload.tool_response.success === false || payload.tool_response.error) return false;
  }
  return true;
}

export function activatedSkillFromPayload(payload = {}) {
  const normalized = normalizeToolPayload(payload);
  if (!SKILL_READ_TOOLS.has(normalized.toolName)) return null;

  const candidates = [
    ...normalized.targets,
    normalized.toolInput?.skill,
    normalized.toolInput?.skillName,
    normalized.toolInput?.name,
  ].filter((value) => typeof value === 'string');
  for (const candidate of candidates) {
    const value = candidate.replace(/\\/g, '/');
    const pathMatch = value.match(/(?:^|\/)skills\/([a-z0-9]+(?:-[a-z0-9]+)*)\/SKILL\.md(?:$|[?#])/i);
    if (pathMatch) return pathMatch[1].toLowerCase();
    if (/^[a-z0-9]+(?:-[a-z0-9]+)*$/i.test(value) && /skill/i.test(normalized.toolName)) {
      return value.toLowerCase();
    }
  }
  return null;
}

export function isPrimitivePath(value) {
  const normalized = String(value || '').replace(/\\/g, '/').replace(/^\.\//, '');
  return PRIMITIVE_FILES.has(normalized) || PRIMITIVE_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

export function planUsesCreatePrimitive(text) {
  const frontmatter = String(text || '').match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1] || '';
  const skills = frontmatter.match(/^skills_used:\s*\r?\n([\s\S]*?)(?=^[A-Za-z_][\w-]*:\s*|(?![\s\S]))/m)?.[1] || '';
  return /^\s*-\s*create-primitive\s*$/m.test(skills) || /skills_used:\s*\[[^\]]*\bcreate-primitive\b[^\]]*\]/m.test(frontmatter);
}
