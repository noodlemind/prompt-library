import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assertNoSymlinkAncestors, readFileNoFollow } from './fs-safe.mjs';
import { parseVSCodeSettings } from './vscode-settings.mjs';
import { readPluginJar, parsePluginXml } from './inventory-jar.mjs';

export const EDITOR_FAMILIES = Object.freeze(['vscode', 'cursor', 'jetbrains']);
const DEFAULT_LIMITS = Object.freeze({ directories: 1024, files: 2048, bytes: 32 * 1024 * 1024, milliseconds: 2000 });
export const INVENTORY_SETTINGS_KEYS = Object.freeze(['chat.agentFilesLocations', 'chat.instructionsFilesLocations', 'chat.agentSkillsLocations', 'chat.hookFilesLocations', 'chat.customAgentInSubagent.enabled', 'chat.useAgentSkills']);
const SETTINGS_KEYS = new Set(INVENTORY_SETTINGS_KEYS);
const JETBRAINS_DIRECTORY = /^(?:IntelliJIdea|IdeaIC|PyCharm|PyCharmCE|WebStorm|Rider|CLion|DataGrip|GoLand|RubyMine|PhpStorm|RustRover|AndroidStudio)[0-9][A-Za-z0-9.-]{0,40}$/;
const LAUNCHERS = {
  vscode: ['code', 'code.cmd', 'Code.exe', 'code-insiders', 'code-insiders.cmd'],
  cursor: ['cursor', 'cursor.cmd', 'Cursor.exe'],
  jetbrains: ['idea', 'idea.sh', 'idea64.exe', 'pycharm', 'pycharm.sh', 'pycharm64.exe', 'webstorm', 'webstorm.sh', 'webstorm64.exe', 'rider', 'rider.sh', 'rider64.exe', 'clion', 'clion.sh', 'clion64.exe', 'datagrip', 'datagrip.sh', 'datagrip64.exe', 'goland', 'goland.sh', 'goland64.exe', 'studio', 'studio.sh', 'studio64.exe'],
};

function observation(value, source, scope, observed = value !== null) {
  return { value, source, scope, observed };
}

function safePath(full) {
  const absolute = path.resolve(full);
  const root = path.parse(absolute).root;
  return assertNoSymlinkAncestors(root, path.relative(root, absolute));
}

function budgetOf(overrides, warnings) {
  const limits = { ...DEFAULT_LIMITS, ...overrides };
  for (const [name, limit] of Object.entries(limits)) {
    if (!Object.hasOwn(DEFAULT_LIMITS, name) || !Number.isSafeInteger(limit) || limit < 0 || limit > DEFAULT_LIMITS[name]) throw new Error(`Inventory: invalid ${name} collection bound`);
  }
  const began = Date.now();
  const counts = { directories: 0, files: 0, bytes: 0 };
  let complete = true;
  const warning = message => {
    complete = false;
    if (warnings.length < 64 && !warnings.includes(message)) warnings.push(message);
  };
  const check = (name, amount = 0) => {
    if (Date.now() - began >= limits.milliseconds) {
      warning('Collection time bound reached; coverage is incomplete.');
      return false;
    }
    if (name && counts[name] + amount > limits[name]) {
      warning(`Collection ${name} bound reached; coverage is incomplete.`);
      return false;
    }
    if (name) counts[name] += amount;
    return true;
  };
  const stat = full => {
    if (!check()) return null;
    if (!safePath(full)) {
      warning(`Unsafe path was not read: ${full}`);
      return null;
    }
    try { return fs.lstatSync(full); } catch (error) {
      if (error.code !== 'ENOENT') warning(`Path could not be observed: ${full}`);
      return null;
    }
  };
  const read = (full, maxBytes = 65_536, binary = false) => {
    const entry = stat(full);
    if (!entry) return null;
    if (!entry.isFile() || entry.size > maxBytes) {
      warning(`Metadata must be a bounded regular file: ${full}`);
      return null;
    }
    if (!check('files', 1) || !check('bytes', entry.size)) return null;
    const value = readFileNoFollow(full, { maxBytes, root: path.dirname(full), encoding: binary ? null : 'utf8' });
    if (value === null) warning(`Metadata could not be safely read: ${full}`);
    return value;
  };
  const entries = (full, max = 256) => {
    const entry = stat(full);
    if (!entry) return [];
    if (!entry.isDirectory()) {
      warning(`Directory expected: ${full}`);
      return [];
    }
    if (!check('directories', 1)) return [];
    let directory;
    try {
      directory = fs.opendirSync(full);
      const results = [];
      let next;
      while ((next = directory.readSync())) {
        if (!check()) break;
        if (results.length >= max) {
          warning(`Directory entry bound reached: ${full}`);
          break;
        }
        if (next.isDirectory() && !check('directories', 1)) break;
        results.push(next);
      }
      return results.sort((a, b) => a.name.localeCompare(b.name));
    } catch {
      warning(`Directory could not be safely read: ${full}`);
      return [];
    } finally {
      if (directory) directory.closeSync();
    }
  };
  return { warning, check, stat, read, entries, coverage: () => ({ complete, ...counts, elapsed_ms: Date.now() - began, limits }) };
}

function defaultLocations(editor, { userHome, platform, env }) {
  if (editor === 'jetbrains') {
    const config = platform === 'darwin' ? path.join(userHome, 'Library/Application Support/JetBrains')
      : platform === 'win32' ? path.join(env.APPDATA || path.join(userHome, 'AppData/Roaming'), 'JetBrains') : path.join(env.XDG_CONFIG_HOME || path.join(userHome, '.config'), 'JetBrains');
    const products = ['IntelliJ IDEA', 'IntelliJ IDEA CE', 'PyCharm', 'PyCharm CE', 'WebStorm', 'Rider', 'CLion', 'DataGrip', 'GoLand', 'PhpStorm', 'RubyMine', 'RustRover', 'Android Studio'];
    const installations = platform === 'darwin' ? ['/Applications', path.join(userHome, 'Applications')].flatMap(root => products.map(product => path.join(root, `${product}.app/Contents`)))
      : platform === 'linux' ? ['idea', 'pycharm', 'webstorm', 'rider', 'clion', 'datagrip', 'goland', 'phpstorm', 'rubymine', 'rustrover', 'android-studio'].map(product => path.join('/opt', product)) : [];
    return { installations, userData: null, configRoot: config, pluginsRoot: null };
  }
  const product = editor === 'vscode' ? 'Code' : 'Cursor';
  const app = editor === 'vscode' ? 'Visual Studio Code' : 'Cursor';
  const slug = editor === 'vscode' ? 'code' : 'cursor';
  const support = platform === 'darwin' ? path.join(userHome, 'Library/Application Support')
    : platform === 'win32' ? env.APPDATA || path.join(userHome, 'AppData/Roaming') : env.XDG_CONFIG_HOME || path.join(userHome, '.config');
  const installations = platform === 'darwin' ? [path.join('/Applications', `${app}.app/Contents`), path.join(userHome, 'Applications', `${app}.app/Contents`)]
    : platform === 'win32' ? [path.join(env.LOCALAPPDATA || path.join(userHome, 'AppData/Local'), 'Programs', editor === 'vscode' ? 'Microsoft VS Code' : 'cursor')]
      : [path.join('/usr/share', slug), path.join('/opt', slug)];
  return { installations, userData: path.join(support, product), configRoot: null, pluginsRoot: path.join(userHome, editor === 'vscode' ? '.vscode/extensions' : '.cursor/extensions') };
}

function launcherTarget(full, platform, budget) {
  if (!budget.check()) return null;
  try {
    const resolved = fs.realpathSync(full);
    if (!budget.stat(resolved)?.isFile()) return null;
    if (platform !== 'win32') fs.accessSync(resolved, fs.constants.X_OK);
    return resolved;
  } catch { return null; }
}

function selectedLauncher(editor, requested, env, platform, budget) {
  if (requested) {
    const full = path.resolve(requested);
    if (!LAUNCHERS[editor].some(name => name.toLowerCase() === path.basename(full).toLowerCase())) throw new Error(`Inventory: --launcher must name a known launcher for ${editor}`);
    const target = launcherTarget(full, platform, budget);
    return { ...observation(target ? full : null, 'explicit-override', 'cli_selected'), resolved_path: target };
  }
  const paths = typeof env.PATH === 'string' ? env.PATH.split(path.delimiter) : [];
  if (paths.length > 64) budget.warning('PATH directory bound reached; launcher selection is incomplete.');
  for (const dir of paths.slice(0, 64)) {
    if (!dir || !path.isAbsolute(dir)) continue;
    for (const name of LAUNCHERS[editor]) {
      const full = path.join(dir, name);
      const target = launcherTarget(full, platform, budget);
      if (target) return { ...observation(full, 'PATH-file-observation', 'cli_selected'), resolved_path: target };
    }
  }
  return { ...observation(null, 'PATH-no-executable-observed', 'cli_selected'), resolved_path: null };
}

function jsonFile(full, budget, parser = JSON.parse) {
  const raw = budget.read(full);
  if (raw === null) return null;
  try {
    const result = parser(raw);
    if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('object expected');
    return result;
  } catch {
    budget.warning(`Malformed metadata was not accepted: ${full}`);
    return null;
  }
}

function textField(value, max = 256) {
  return typeof value === 'string' && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value) ? value : null;
}

function productOf(editor, installation, budget) {
  const candidates = editor === 'jetbrains' ? ['product-info.json', 'Resources/product-info.json', 'Contents/product-info.json', 'Contents/Resources/product-info.json']
    : ['resources/app/package.json', 'Resources/app/package.json', 'package.json'];
  for (const rel of candidates) {
    const full = path.join(installation || '', rel);
    if (!installation) break;
    const data = jsonFile(full, budget);
    if (data) return { name: textField(data.name), version: textField(data.version), build: textField(data.buildNumber), source: full, scope: 'local-installation' };
  }
  return { name: null, version: null, build: null, source: null, scope: 'local-installation' };
}

function projectedSettings(full, budget) {
  const data = jsonFile(full, budget, parseVSCodeSettings);
  const overrides = {};
  if (data) for (const [key, value] of Object.entries(data)) {
    if (!SETTINGS_KEYS.has(key)) continue;
    if (key.endsWith('Locations')) {
      if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length > 32) {
        budget.warning(`Unsupported override value was omitted: ${key}`);
        continue;
      }
      const projected = {};
      for (const [location, enabled] of Object.entries(value)) {
        if (!textField(location, 1024) || typeof enabled !== 'boolean') {
          budget.warning(`Unsupported override location was omitted: ${key}`);
          continue;
        }
        Object.defineProperty(projected, location, { value: enabled, enumerable: true, configurable: true, writable: true });
      }
      overrides[key] = projected;
    } else if (typeof value === 'boolean') overrides[key] = value;
    else budget.warning(`Unsupported override value was omitted: ${key}`);
  }
  return { overrides, source: data ? full : null, scope: 'local-user-overrides', effective_known: false };
}

function vsCodeInventory(options, budget, defaults) {
  const { editor, profile } = options;
  const installed = options.installation ? [path.resolve(options.installation)] : defaults.installations;
  const installation = installed.find(full => budget.stat(full)?.isDirectory()) || null;
  const userData = path.resolve(options.userData || defaults.userData);
  const userRoot = path.basename(userData) === 'User' ? userData : path.join(userData, 'User');
  const settingsRoot = profile ? path.join(userRoot, 'profiles', profile) : userRoot;
  const profileExists = Boolean(budget.stat(settingsRoot)?.isDirectory());
  if (profile && !profileExists) budget.warning(`Requested profile directory was not found: ${profile}`);
  const plugins = path.resolve(options.pluginsRoot || defaults.pluginsRoot);
  const extensions = [];
  for (const entry of budget.entries(plugins)) {
    if (!entry.isDirectory()) {
      if (entry.isSymbolicLink()) budget.warning(`Unsafe extension directory was not read: ${path.join(plugins, entry.name)}`);
      continue;
    }
    const full = path.join(plugins, entry.name, 'package.json');
    const data = jsonFile(full, budget);
    if (!data) continue;
    if (!textField(data.publisher, 128) || !textField(data.name, 128) || !/^[A-Za-z0-9_-]+$/.test(data.publisher) || !/^[A-Za-z0-9_-]+$/.test(data.name) || !textField(data.version, 128)) {
      budget.warning(`Extension identity was not accepted: ${full}`);
      continue;
    }
    if (extensions.length >= 512) {
      budget.warning('Extension count bound reached.');
      break;
    }
    extensions.push({ id: `${data.publisher}.${data.name}`, name: textField(data.displayName), version: data.version, enabled: null, source: full, scope: 'local-installed', profile: profile || null });
  }
  return {
    installation: observation(installation, options.installation ? 'explicit-override' : 'known-installation-paths', 'local-installation'),
    product: productOf(editor, installation, budget),
    user_data: observation(budget.stat(userData)?.isDirectory() ? userData : null, options.userData ? 'explicit-override' : 'known-user-data-path', 'local-user-data'),
    profile: observation(profile || null, profile ? 'existing-directory-id' : 'default-user-directory', 'local-profile', profileExists),
    extensions,
    settings: profileExists ? projectedSettings(path.join(settingsRoot, 'settings.json'), budget) : { overrides: {}, source: null, scope: 'local-user-overrides', effective_known: false },
  };
}

function disabledPlugins(config, budget) {
  const full = path.join(config, 'disabled_plugins.txt');
  const text = budget.read(full);
  if (text === null) return new Set();
  const rows = text.split(/\r?\n/).map(value => value.trim()).filter(Boolean);
  if (rows.length > 512 || rows.some(value => !/^[A-Za-z0-9_.-]{1,256}$/.test(value))) {
    budget.warning(`Disabled plugin list was not accepted: ${full}`);
    return new Set();
  }
  return new Set(rows);
}

function jarMetadata(full, budget) {
  const bytes = budget.read(full, 4 * 1024 * 1024, true);
  if (bytes === null) return null;
  try {
    const xml = readPluginJar(bytes);
    return xml === null ? null : parsePluginXml(xml);
  } catch (error) {
    budget.warning(`JAR descriptor was not accepted: ${full} (${error.message})`);
    return null;
  }
}

function pluginsIn(root, scope, config, disabled, budget) {
  const plugins = [];
  const add = (metadata, source) => {
    if (!metadata) return;
    if (!metadata.id) {
      budget.warning(`Plugin descriptor has no stable ID: ${source}`);
      return;
    }
    if (plugins.length >= 512) {
      budget.warning('Plugin count bound reached.');
      return;
    }
    plugins.push({ ...metadata, enabled: disabled.has(metadata.id) ? false : null, source, scope, configuration: config || null });
  };
  for (const entry of budget.entries(root)) {
    const full = path.join(root, entry.name);
    if (entry.isSymbolicLink()) {
      budget.warning(`Unsafe plugin path was not read: ${full}`);
      continue;
    }
    if (entry.isFile() && entry.name.endsWith('.jar')) {
      add(jarMetadata(full, budget), full);
      continue;
    }
    if (!entry.isDirectory()) continue;
    const descriptor = path.join(full, 'META-INF/plugin.xml');
    const xml = budget.read(descriptor);
    if (xml !== null) {
      try { add(parsePluginXml(xml), descriptor); } catch { budget.warning(`Malformed plugin descriptor was not accepted: ${descriptor}`); }
    }
    for (const jar of budget.entries(path.join(full, 'lib'))) {
      if (jar.isFile() && jar.name.endsWith('.jar')) {
        const source = path.join(full, 'lib', jar.name);
        add(jarMetadata(source, budget), source);
      } else if (jar.isSymbolicLink()) budget.warning(`Unsafe plugin library was not read: ${path.join(full, 'lib', jar.name)}`);
    }
  }
  return plugins;
}

function jetBrainsInventory(options, budget, defaults) {
  const candidates = options.installation ? [path.resolve(options.installation)] : defaults.installations;
  const installation = candidates.find(full => budget.stat(full)?.isDirectory()) || null;
  const configRoot = path.resolve(options.configRoot || defaults.configRoot);
  const configs = JETBRAINS_DIRECTORY.test(path.basename(configRoot)) ? (budget.stat(configRoot)?.isDirectory() ? [configRoot] : []) : budget.entries(configRoot, 32)
    .filter(entry => entry.isDirectory() && JETBRAINS_DIRECTORY.test(entry.name)).map(entry => path.join(configRoot, entry.name));
  const configurations = configs.map(config => ({ id: path.basename(config), path: config, source: 'versioned-configuration-directory', scope: 'local-config', disabled: disabledPlugins(config, budget) }));
  const extensions = [];
  const bundled = installation ? [path.join(installation, 'plugins'), path.join(installation, 'Contents/plugins')] : [];
  for (const root of bundled) if (budget.stat(root)?.isDirectory()) extensions.push(...pluginsIn(root, 'bundled', null, new Set(), budget));
  if (options.pluginsRoot) {
    const disabled = configurations.length === 1 ? configurations[0].disabled : new Set();
    const config = configurations.length === 1 ? configurations[0].path : null;
    if (configurations.length > 1) budget.warning('An explicit plugin root cannot infer enabled state across multiple configurations.');
    extensions.push(...pluginsIn(path.resolve(options.pluginsRoot), 'downloaded', config, disabled, budget));
  } else {
    for (const config of configurations) {
      const roots = [path.join(config.path, 'plugins')];
      if (options.platform === 'linux') roots.push(path.join(options.userHome, '.local/share/JetBrains', config.id, 'plugins'));
      for (const root of roots) if (budget.stat(root)?.isDirectory()) extensions.push(...pluginsIn(root, 'downloaded', config.path, config.disabled, budget));
    }
  }
  if (extensions.length > 512) budget.warning('Aggregate plugin count bound reached.');
  return {
    installation: observation(installation, options.installation ? 'explicit-override' : 'known-installation-paths', 'local-installation'),
    product: productOf('jetbrains', installation, budget),
    profile: observation(null, 'unsupported', 'local-profile', false),
    configurations: configurations.map(({ disabled, ...config }) => config),
    extensions: extensions.slice(0, 512),
    settings: { overrides: {}, source: null, scope: 'uncollected', effective_known: false },
  };
}

export function validateInventoryCollection(options = {}) {
  const editor = options.editor;
  if (!EDITOR_FAMILIES.includes(editor)) throw new Error('Inventory: --editor must be vscode, cursor or jetbrains');
  if (options.profile !== undefined && (typeof options.profile !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(options.profile) || editor === 'jetbrains')) throw new Error('Inventory: --profile requires an existing VS Code or Cursor directory ID');
  if (editor === 'jetbrains' && options.userData) throw new Error('Inventory: JetBrains uses --config-root, not --user-data');
  if (editor !== 'jetbrains' && options.configRoot) throw new Error('Inventory: --config-root is only supported for JetBrains');
  for (const key of ['installation', 'launcher', 'userData', 'configRoot', 'pluginsRoot']) if (options[key] !== undefined && (typeof options[key] !== 'string' || !options[key].trim() || options[key].length > 4096 || /[\u0000-\u001f\u007f]/.test(options[key]))) throw new Error(`Inventory: invalid ${key} path`);
  if (options.launcher && !LAUNCHERS[editor].some(name => name.toLowerCase() === path.basename(options.launcher).toLowerCase())) throw new Error(`Inventory: --launcher must name a known launcher for ${editor}`);
}

export function collectEditorInventory(options = {}) {
  validateInventoryCollection(options);
  const editor = options.editor;
  const resolved = { ...options, userHome: path.resolve(options.userHome || os.homedir()), platform: options.platform || process.platform, env: options.env || process.env };
  const warnings = [];
  const budget = budgetOf(options.limits, warnings);
  const defaults = defaultLocations(editor, resolved);
  const launcher = selectedLauncher(editor, options.launcher, resolved.env, resolved.platform, budget);
  const data = editor === 'jetbrains' ? jetBrainsInventory(resolved, budget, defaults) : vsCodeInventory(resolved, budget, defaults);
  const coverage = budget.coverage();
  const observed = Boolean(data.installation.value || data.user_data?.value || data.configurations?.length || data.extensions.length || launcher.value);
  return { family: editor, collected_at: new Date().toISOString(), status: !coverage.complete ? 'partial' : observed ? 'collected' : 'not-found', ...data, launcher, running_instance: null, remote: { status: 'uncollected', scope: 'remote' }, coverage, warnings };
}
