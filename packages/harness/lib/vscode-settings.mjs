import fs from 'fs';
import path from 'path';
import { resolveVSCodeSettingsPaths } from './paths.mjs';

const MERGE_KEYS = {
  'chat.agentFilesLocations': { '~/.copilot/agents': true },
  'chat.instructionsFilesLocations': { '~/.copilot/instructions': true },
  'chat.agentSkillsLocations': { '~/.copilot/skills': true },
  'chat.hookFilesLocations': { '~/.copilot/hooks': true },
  'chat.customAgentInSubagent.enabled': true,
  'chat.useAgentSkills': true,
};

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
  return JSON.parse(stripTrailingCommas(stripJsonComments(text)));
}

function deepMerge(target, source) {
  for (const [k, v] of Object.entries(source)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && target[k] && typeof target[k] === 'object') {
      deepMerge(target[k], v);
    } else {
      target[k] = v;
    }
  }
  return target;
}

export function mergeVSCodeSettings(settings = {}) {
  const copy = JSON.parse(JSON.stringify(settings));
  return deepMerge(copy, MERGE_KEYS);
}

export function configureVSCodeSettings(flags, log) {
  const paths = resolveVSCodeSettingsPaths();
  let updated = 0;
  for (const settingsPath of paths) {
    let data = {};
    if (fs.existsSync(settingsPath)) {
      try {
        const raw = fs.readFileSync(settingsPath, 'utf8');
        data = parseVSCodeSettings(raw);
      } catch (e) {
        log(`warn: could not parse ${settingsPath}: ${e.message}`);
        continue;
      }
    }
    data = mergeVSCodeSettings(data);
    if (flags.dryRun) {
      log(`would update ${settingsPath}`);
      updated++;
      continue;
    }
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify(data, null, 2) + '\n', 'utf8');
    log(`updated ${settingsPath}`);
    updated++;
  }
  return updated;
}
