import fs from 'fs';
import os from 'node:os';
import path from 'path';
import { resolveCopilotHome, resolveVSCodeSettingsPaths } from './paths.mjs';
import { readFileNoFollow, writeFileContained } from './fs-safe.mjs';
import { EXIT } from './style.mjs';

const LOCATION_KEYS = {
  'chat.agentFilesLocations': 'agents',
  'chat.instructionsFilesLocations': 'instructions',
  'chat.agentSkillsLocations': 'skills',
  'chat.hookFilesLocations': 'hooks',
};
const MERGE_KEYS = {
  'chat.customAgentInSubagent.enabled': true,
  'chat.useAgentSkills': true,
  'chat.subagents.allowInvocationsFromSubagents': true,
};

export function vscodeCustomizationLocations(copilotHome = path.join(os.homedir(), '.copilot')) {
  const home = path.resolve(copilotHome);
  const prefix = path.relative(path.join(os.homedir(), '.copilot'), home) === '' ? '~/.copilot' : home.replace(/\\/g, '/');
  return Object.fromEntries(Object.entries(LOCATION_KEYS).map(([key, directory]) => [key, `${prefix}/${directory}`]));
}

function stripJsonComments(text) {
  let output = '';
  let inString = false;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    const next = text[index + 1];
    if (lineComment) {
      if (char === '\n') {
        lineComment = false;
        output += char;
      }
      continue;
    }
    if (blockComment) {
      if (char === '*' && next === '/') {
        blockComment = false;
        index++;
      } else if (char === '\n') output += char;
      continue;
    }
    if (!inString && char === '/' && next === '/') {
      lineComment = true;
      index++;
      continue;
    }
    if (!inString && char === '/' && next === '*') {
      blockComment = true;
      index++;
      continue;
    }
    output += char;
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
    } else if (char === '"') inString = true;
  }
  return output;
}

function stripTrailingCommas(text) {
  let output = '';
  let inString = false;
  let escaped = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (!inString && char === ',') {
      let next = index + 1;
      while (/\s/.test(text[next] || '')) next++;
      if (text[next] === '}' || text[next] === ']') continue;
    }
    output += char;
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
    } else if (char === '"') inString = true;
  }
  return output;
}

export function parseVSCodeSettings(text) {
  const value = JSON.parse(stripTrailingCommas(stripJsonComments(text)));
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('settings must be a JSON object');
  return value;
}

function deepMerge(target, source) {
  for (const [k, v] of Object.entries(source)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && target[k] && typeof target[k] === 'object' && !Array.isArray(target[k])) {
      deepMerge(target[k], v);
    } else {
      target[k] = v;
    }
  }
  return target;
}

export function mergeVSCodeSettings(settings = {}, { copilotHome } = {}) {
  const copy = JSON.parse(JSON.stringify(settings));
  const locations = Object.fromEntries(Object.entries(vscodeCustomizationLocations(copilotHome)).map(([key, location]) => [key, { [location]: true }]));
  for (const key of Object.keys(locations)) {
    if (Array.isArray(copy[key]) && copy[key].every(location => typeof location === 'string')) copy[key] = Object.fromEntries(copy[key].map(location => [location, true]));
  }
  return deepMerge(copy, { ...locations, ...MERGE_KEYS });
}

export function configureVSCodeSettings(flags, log) {
  const paths = resolveVSCodeSettingsPaths();
  const failure = (settingsPath, reason) => Object.assign(new Error(`Cannot configure VS Code settings ${settingsPath}: ${reason}`), {
    code: 'E_VSCODE_SETTINGS', exit: EXIT.syncConflict,
    hint: 'Inspect this settings.json and restore a readable regular JSONC object, then retry ae install --target vscode --configure-vscode with the same --copilot-home. Authored settings are not replaced after a read or parse failure.',
  });
  // Validate every discovered profile before updating any. In particular, a
  // malformed Insiders profile must not silently leave a partial setup.
  const updates = paths.map(settingsPath => {
    let data = {};
    let stat;
    try { stat = fs.lstatSync(settingsPath, { throwIfNoEntry: false }); }
    catch (error) { throw failure(settingsPath, error.message); }
    if (stat) {
      try {
        const raw = readFileNoFollow(settingsPath, { root: path.dirname(settingsPath), maxBytes: 1024 * 1024 });
        if (raw === null) throw new Error('source is unreadable, symlinked, nonregular or larger than 1 MiB');
        data = parseVSCodeSettings(raw);
      } catch (e) {
        throw failure(settingsPath, e.message);
      }
    }
    data = mergeVSCodeSettings(data, { copilotHome: resolveCopilotHome(flags.copilotHome) });
    return { settingsPath, content: JSON.stringify(data, null, 2) + '\n', mode: stat ? stat.mode & 0o777 : 0o600 };
  });
  for (const { settingsPath, content, mode } of updates) {
    if (flags.dryRun) {
      log(`would update ${settingsPath}`);
      continue;
    }
    try {
      fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
      if (!writeFileContained(path.dirname(settingsPath), path.basename(settingsPath), content, { mode })) throw new Error('safe atomic write refused');
    } catch (error) { throw failure(settingsPath, error.message); }
    log(`updated ${settingsPath}`);
  }
  return updates.length;
}
