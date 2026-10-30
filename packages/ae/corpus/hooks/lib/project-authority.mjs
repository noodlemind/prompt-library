import fs from 'node:fs';
import path from 'node:path';

export const PROJECT_AUTHORITY_FILES = Object.freeze(['config.yaml', 'policy.yaml', 'checks.yaml', 'routing.yaml']);

function failure(message) {
  return Object.assign(new Error(message), { code: 'E_PROJECT_AUTHORITY', exit: 1, hint: 'Choose one local or shared project configuration; inspect both locations before moving any policy files.' });
}

function present(root, directory) {
  const relative = path.relative(root, directory);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw failure('Project authority directory is outside its selected root');
  let current = root;
  for (const part of relative.split(path.sep)) {
    current = path.join(current, part);
    let stat;
    try { stat = fs.lstatSync(current, { throwIfNoEntry: false }); }
    catch { throw failure(`Project authority path is unreadable: ${current}`); }
    if (!stat) return false;
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw failure(`Project authority path is unsafe or nonregular: ${current}`);
  }
  return PROJECT_AUTHORITY_FILES.some(name => {
    try { return Boolean(fs.lstatSync(path.join(directory, name), { throwIfNoEntry: false })); }
    catch { throw failure(`Project authority source is unreadable: ${path.join(directory, name)}`); }
  });
}

/** The CLI and hydrated hooks select one complete source, never an overlay. */
export function selectProjectAuthority(workspace, projectStore, { home, mode } = {}) {
  if (mode !== undefined && !['local', 'shared'].includes(mode)) throw failure('Project authority mode must be local or shared');
  const shared = path.join(workspace, '.github', 'harness');
  const local = path.join(projectStore, 'authority');
  const sharedPresent = present(workspace, shared);
  const localPresent = present(home, local);
  if (sharedPresent && localPresent) throw failure(`Both local and shared project authority exist: ${local} and ${shared}`);
  if (mode === 'shared' && localPresent) throw failure(`Local project authority already exists at ${local}; explicitly migrate the reviewed files before selecting shared setup`);
  if (mode === 'local' && sharedPresent) throw failure(`Shared project authority already exists at ${shared}; existing team configuration must remain selected`);
  const selected = mode || (sharedPresent ? 'shared' : 'local');
  const directory = selected === 'shared' ? shared : local;
  return {
    mode: selected,
    directory,
    root: selected === 'shared' ? workspace : home,
    present: selected === 'shared' ? sharedPresent : localPresent,
    files: Object.fromEntries(PROJECT_AUTHORITY_FILES.map(name => [name, path.join(directory, name)])),
  };
}
