/**
 * Thin knowledge-store test helpers.
 * Domain-heavy seeding stays in module tests; this only centralizes git env + dirs.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { tempDir } from './temp.mjs';

/** Deterministic git env so store commits do not pick up the operator identity. */
export const TEST_GIT_ENV = {
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_AUTHOR_NAME: 'harness-test',
  GIT_AUTHOR_EMAIL: 'harness-test@example.test',
  GIT_COMMITTER_NAME: 'harness-test',
  GIT_COMMITTER_EMAIL: 'harness-test@example.test',
};

/**
 * @param {string} cwd
 * @param {string[]} args
 * @param {{ env?: NodeJS.ProcessEnv }} [opts]
 */
export function git(cwd, args, opts = {}) {
  return spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...TEST_GIT_ENV, ...(opts.env || {}) },
  });
}

/**
 * Workspace + user home + optional harnessHome for knowledge store tests.
 * @param {{ prefix?: string }} [opts]
 */
export function storeScopes(opts = {}) {
  const p = opts.prefix || 'store-';
  return {
    ws: tempDir(`${p}ws-`),
    home: tempDir(`${p}home-`),
    harnessHome: tempDir(`${p}hh-`),
  };
}

/**
 * Write an ops.json file for applyOps / consolidate --apply fixtures.
 * @param {string} dir
 * @param {unknown[]} ops
 * @param {string} [filename='ops.json']
 * @returns {string} path written
 */
export function writeOps(dir, ops, filename = 'ops.json') {
  const p = path.join(dir, filename);
  fs.writeFileSync(p, JSON.stringify({ schema: 1, ops }));
  return p;
}
