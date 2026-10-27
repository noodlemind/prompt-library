import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Point a process at a fresh home so default AE state cannot land in the real one. */
export function isolateTestHome(env = process.env) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ae-test-home-'));
  env.HOME = home;
  env.USERPROFILE = home;
  env.XDG_CONFIG_HOME = path.join(home, '.config');
  delete env.AE_HOME;
  delete env.HARNESS_HOME;
  delete env.AE_BIN;
  delete env.HARNESS_BIN;
  return home;
}
