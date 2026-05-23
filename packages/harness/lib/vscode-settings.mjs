import fs from 'fs';
import path from 'path';
import { resolveVSCodeSettingsPaths } from './paths.mjs';

const MERGE_KEYS = {
  'chat.agentFilesLocations': { '~/.copilot/agents': true },
  'chat.instructionsFilesLocations': { '~/.copilot/instructions': true },
  'chat.agentSkillsLocations': { '~/.copilot/skills': true },
  'chat.customAgentInSubagent.enabled': true,
  'chat.useAgentSkills': true,
};

function stripJsonComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/,\s*([\]}])/g, '$1');
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

export function configureVSCodeSettings(flags, log) {
  const paths = resolveVSCodeSettingsPaths();
  let updated = 0;
  for (const settingsPath of paths) {
    let data = {};
    if (fs.existsSync(settingsPath)) {
      try {
        const raw = fs.readFileSync(settingsPath, 'utf8');
        data = JSON.parse(stripJsonComments(raw));
      } catch (e) {
        log(`warn: could not parse ${settingsPath}: ${e.message}`);
        continue;
      }
    }
    deepMerge(data, MERGE_KEYS);
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
