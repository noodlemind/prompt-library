import path from 'node:path';
import { createStyle } from './style.mjs';
import { redactedJson } from './redact.mjs';
import { runInventory } from './inventory.mjs';

export const INVENTORY_VERBS = Object.freeze(['show', 'refresh']);
const VALUE_OPTIONS = { '--editor': 'editor', '--profile': 'profile', '--installation': 'installation', '--launcher': 'launcher', '--user-data': 'userData', '--config-root': 'configRoot', '--plugins-root': 'pluginsRoot', '--ae-home': 'home', '--harness-home': 'home', '--workspace': 'workspace', '--copilot-home': 'copilotHome' };

function parseInventoryArgs(argv, ctx) {
  const options = { home: ctx.harnessHome, verb: null, json: false, dryRun: false };
  const seen = new Set();
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === '--') {
      if (i !== argv.length - 1) throw new Error('Inventory: unexpected trailing arguments');
      break;
    }
    const flagName = token.startsWith('-') ? token.split('=')[0] : null;
    if (flagName) {
      const canonical = flagName === '-v' ? '--verbose' : flagName;
      if (seen.has(canonical)) throw new Error(`Inventory: duplicate option ${canonical}`);
      seen.add(canonical);
    }
    if (token === '--json') options.json = true;
    else if (token === '--dry-run') options.dryRun = true;
    else if (['--verbose', '-v', '--quiet', '--agent', '--no-color', '--no-events'].includes(token)) continue;
    else if (token.startsWith('-')) {
      const equal = token.indexOf('=');
      const name = equal === -1 ? token : token.slice(0, equal);
      const key = VALUE_OPTIONS[name];
      if (!key) throw new Error(`Inventory: unknown option ${name}`);
      const value = equal === -1 ? argv[++i] : token.slice(equal + 1);
      if (typeof value !== 'string' || !value || value.startsWith('-') || /[\u0000-\u001f\u007f]/.test(value)) throw new Error(`Inventory: ${name} requires a value`);
      options[key] = key === 'home' ? path.resolve(value) : value;
    } else if (options.verb === null) options.verb = token;
    else throw new Error('Inventory: unexpected extra arguments');
  }
  options.verb ||= 'show';
  if (!INVENTORY_VERBS.includes(options.verb)) throw new Error('Inventory: verb must be show or refresh');
  if (options.verb === 'show' && ['editor', 'profile', 'installation', 'launcher', 'userData', 'configRoot', 'pluginsRoot'].some(key => options[key] !== undefined)) throw new Error('Inventory: editor, path and profile options require refresh');
  return options;
}

export function inventoryResultOf(argv, ctx = {}) {
  try { return runInventory(parseInventoryArgs(argv, ctx)); } catch (error) {
    return { schema: 1, mode: 'inventory', status: 'failed', exitCode: 2, collected: false, published: false, inventory: null, reason: error.message, output: [{ line: error.message }] };
  }
}

export function cmdInventory(argv, ctx = {}) {
  const result = inventoryResultOf(argv, ctx);
  if (argv.includes('--json')) console.log(redactedJson(result, { pretty: true }));
  else {
    const ui = createStyle();
    for (const row of result.output) console.log(ui.line({ state: result.status === 'ok' ? 'ok' : 'fail', key: 'inventory', value: row.line }));
  }
  return result.exitCode;
}
