import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

function read(rel) {
  return fs.readFileSync(path.join(repoRoot, rel), 'utf8');
}

const rulePath = 'packages/ae/corpus/skills/references/duplicate-guards.md';
const pointer = 'ae get --reference skills/references/duplicate-guards.md --json';

test('duplicate guard rule names both sites, the path, and one owner', () => {
  const text = read(rulePath);
  assert.match(text, /ae search <name> --match literal --source code --json/);
  assert.match(text, /`ae graph explain`/);
  assert.match(text, /`ae graph impact`/);
  assert.match(text, /do not list method callers/i);
  assert.match(text, /likely duplicate guard/i);
  assert.match(text, /one owner/i);
  assert.match(text, /every caller of the inner method/i);
  assert.match(text, /user's OK/i);
  assert.match(text, /locked plan/i);
  assert.match(text, /Do not copy the change into both places/i);
  assert.match(text, /Redundant guard/);
  assert.match(text, /`charge` returns when `paid` is already true/);
  assert.match(text, /`ledger\.post`/);
  assert.match(text, /`account\.apply`/);
  assert.match(text, /`charge` to `ledger\.post` to `account\.apply`/);
});

test('planning and delivery prompts read the duplicate guard rule before a repeated edit', () => {
  const files = [
    'packages/ae/corpus/agents/engineer.agent.md',
    'packages/ae/corpus/skills/ensure-plan/SKILL.md',
    'packages/ae/corpus/skills/plan-issue/SKILL.md',
    'packages/ae/corpus/skills/references/playbooks/bug-fix.md',
    'packages/ae/corpus/skills/references/playbooks/feature.md',
    'packages/ae/corpus/skills/references/playbooks/refactor.md',
    'packages/ae/corpus/skills/references/playbooks/perf.md',
    'packages/ae/corpus/agents/pattern-recognition-specialist.agent.md',
    'packages/ae/corpus/skills/code-review/references/review-personas.md',
  ];
  for (const file of files) {
    assert.ok(read(file).includes(pointer), `${file} missing ${pointer}`);
  }
});

test('review reports a redundant guard when the same condition lands in two places', () => {
  const personas = read('packages/ae/corpus/skills/code-review/references/review-personas.md');
  const schema = read('packages/ae/corpus/skills/code-review/references/findings-schema.md');
  const specialist = read('packages/ae/corpus/agents/pattern-recognition-specialist.agent.md');
  assert.match(personas, /title `Redundant guard`/);
  assert.match(personas, /outer check already covers every path to an inner check/i);
  assert.match(personas, /Name both sites, the call path, and one owner/);
  assert.match(schema, /title `Redundant guard`/);
  assert.match(schema, /both locations, the call path, and one owner/i);
  assert.match(schema, /`gated_auto`/);
  assert.match(schema, /callers that skip the outer check/i);
  assert.match(specialist, /title `Redundant guard`/);
});
