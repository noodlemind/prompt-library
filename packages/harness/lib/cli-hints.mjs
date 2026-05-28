/**
 * User-facing CLI invocation hints. Package name is @dev-kit/harness for npm uniqueness;
 * day-to-day commands use the `harness` binary (global install, npm link, or local node_modules/.bin).
 */

export const CLI_BIN = 'harness';
export const PACKAGE_NAME = '@dev-kit/harness';

/** Primary agent/human command prefix (no scope, no npx). */
export function cliPrefix() {
  return CLI_BIN;
}

export function cliCommand(subcommand) {
  const cmd = (subcommand || '').trim();
  return cmd ? `${CLI_BIN} ${cmd}` : CLI_BIN;
}

export function hintInstall() {
  return [
    `Run: ${cliCommand('install')}  (after npm install -g, npm link, or repo npm run harness:install)`,
    `Maintainer (no publish): npm run harness:install  from prompt-library root`,
    `Registry: npx ${PACKAGE_NAME} install  (only when package is on your npm registry)`,
  ].join('\n       ');
}

export function hintInitRepo() {
  return cliCommand('init-repo');
}

export function hintIndex() {
  return `${cliCommand('index')} — rebuild manifest with symptom/module/excerpt`;
}

export function hintPostingsIndex() {
  return `${cliCommand('index')} — rebuild .harness-index/postings.json`;
}

export function hintDoctor() {
  return cliCommand('doctor');
}

export function hintUpgrade() {
  return cliCommand('upgrade');
}
