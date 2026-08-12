/**
 * Minimal locked plan fixture writer.
 */
import fs from 'node:fs';
import path from 'node:path';

/**
 * Write a locked in-progress plan under docs/plans/.
 * Matches the long-standing harness-cli fixture shape so assertions stay stable.
 *
 * @param {string} workspace
 * @param {{
 *   frontmatter?: string,
 *   activity?: string,
 *   name?: string,
 *   title?: string,
 * }} [opts]
 * @returns {string} absolute path to the plan file
 */
export function writePlan(workspace, {
  frontmatter = '',
  activity = '- Plan created.',
  name = '2026-05-22-fix-example-plan.md',
  title = 'Fix example',
} = {}) {
  const plansDir = path.join(workspace, 'docs', 'plans');
  fs.mkdirSync(plansDir, { recursive: true });
  const planPath = path.join(plansDir, name);
  fs.writeFileSync(
    planPath,
    `---
title: "${title}"
status: in-progress
plan_lock: true
phase: 1
${frontmatter}---

# ${title}

## Overview

Do the work.

## Intent Contract

- **Goal:** ${title}
- **Expected outputs:** code change
- **Success criteria:** tests pass

## Acceptance Criteria

- [ ] Example is fixed.

## Verification Plan

Run the relevant test command.

## Impacted Files

- src/example.ts

## Activity

${activity}
`,
    'utf8',
  );
  return planPath;
}
