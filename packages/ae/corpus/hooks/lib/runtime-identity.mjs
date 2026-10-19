import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function usage(message) {
  return Object.assign(new Error(message), { code: 'E_USAGE', exit: 2, hint: 'ae help' });
}

export function runtimeSetting(name, env = process.env) {
  const canonical = env[`AE_${name}`];
  const legacy = env[`HARNESS_${name}`];
  const normalize = value => ['HOME', 'BIN'].includes(name) ? path.resolve(value) : value;
  if (canonical && legacy && normalize(canonical) !== normalize(legacy)) {
    throw usage(`AE_${name} conflicts with HARNESS_${name}; select one value`);
  }
  return canonical || legacy;
}

export function runtimeHome() {
  const selected = runtimeSetting('HOME');
  if (selected) return path.resolve(selected);
  const canonical = path.join(os.homedir(), '.ae');
  const legacy = path.join(os.homedir(), '.harness');
  const populated = dir => {
    try { return fs.readdirSync(dir).length > 0; } catch (error) {
      if (error.code === 'ENOENT') return false;
      throw error;
    }
  };
  const oldRecords = populated(legacy);
  if (oldRecords && populated(canonical)) {
    throw usage('Both ~/.ae and ~/.harness contain records; select --ae-home explicitly');
  }
  return oldRecords ? legacy : canonical;
}

export function normalizeRuntimeEnvironment(env = process.env) {
  for (const key of Object.keys(env)) {
    if (!/^AE_[A-Z0-9_]+$/.test(key) || !env[key]) continue;
    const name = key.slice(3);
    env[`HARNESS_${name}`] = runtimeSetting(name, env);
  }
  return env;
}
