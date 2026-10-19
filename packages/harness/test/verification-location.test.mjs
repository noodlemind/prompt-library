import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { locateVerification } from '../lib/verification-location.mjs';
import { runHarness } from './helpers/cli.mjs';
import { planFromText } from '../lib/plan-parse.mjs';
import { tempDir } from './helpers/temp.mjs';

function fixture(t) {
  const root = tempDir('verification-location-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const skill = rel => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), '---\nname: verify-product\n---\n\n## Launch\nStart the product.\n## Drive\nExercise it.\n'); };
  return { root, skill };
}

test('canonical Cursor recipe wins while an extra feature tree is reported', t => {
  const f = fixture(t);
  f.skill('.cursor/skills/verify-product/SKILL.md');
  fs.mkdirSync(path.join(f.root, 'docs/features'), { recursive: true });
  const result = locateVerification(f.root);
  assert.equal(result.state, 'selected');
  assert.equal(result.path, '.cursor/skills/verify-product/SKILL.md');
  assert.ok(result.warnings.includes('extra-feature-directory'));
  assert.equal(fs.existsSync(path.join(f.root, 'docs/features')), true);
});

test('multiple recipes require explicit selection', t => {
  const f = fixture(t);
  f.skill('.cursor/skills/verify-one/SKILL.md'); f.skill('.cursor/skills/verify-two/SKILL.md');
  assert.equal(locateVerification(f.root).state, 'ambiguous');
  assert.equal(locateVerification(f.root, '.cursor/skills/verify-two/SKILL.md').state, 'selected');
  assert.equal(locateVerification(f.root, '../escape.md').state, 'invalid');
});

test('bounded enumeration cannot silently certify a sole candidate', t => {
  const f = fixture(t);
  f.skill('.cursor/skills/verify-one/SKILL.md'); f.skill('.cursor/skills/verify-two/SKILL.md');
  assert.equal(locateVerification(f.root, null, { limit: 1 }).state, 'incomplete');
});

test('docs recipe is the fallback and a missing recipe is explicit', t => {
  const f = fixture(t);
  assert.equal(locateVerification(f.root).state, 'absent');
  f.skill('docs/verification/SKILL.md');
  assert.equal(locateVerification(f.root).path, 'docs/verification/SKILL.md');
});


test('owned product verification procedure preserves lifecycle, feature and audit contracts', () => {
  const body = fs.readFileSync(new URL('../corpus/skills/create-primitive/references/product-verification.md', import.meta.url), 'utf8');
  for (const heading of ['Launch', 'Doctor', 'Drive', 'Evidence', 'Cleanup', 'Helpers', 'Sub-features', 'How a person reaches it', 'Driving it', 'Gotchas']) assert.ok(body.includes(`## ${heading}`), heading);
  assert.match(body, /returned path is discovery metadata/);
  assert.match(body, /ordinary visible change/);
  assert.match(body, /Drive every mapped feature/);
  assert.match(body, /does not create product recipes/);
});


test('short creation preserves an explicitly selected recipe on the accepted contract', t => {
  const f = fixture(t), home = tempDir('verification-short-home-');
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  f.skill('.cursor/skills/verify-one/SKILL.md'); f.skill('.cursor/skills/verify-two/SKILL.md');
  const decision = path.join(f.root, 'decision.json');
  fs.writeFileSync(decision, JSON.stringify({ version: 1, format: 'short', slug: 'selected-recipe', goal: 'Prove selected behavior', acceptance: ['Behavior is observed'], constraints: ['Keep fixtures disposable'], verificationRecipe: '.cursor/skills/verify-two/SKILL.md' }));
  const created = runHarness(['plan-new', '--workspace', f.root, '--harness-home', home, '--file', decision, '--json']);
  assert.equal(created.status, 0, created.stderr);
  const plan = planFromText(fs.readFileSync(JSON.parse(created.stdout).path, 'utf8'), { path: JSON.parse(created.stdout).path, fullPath: JSON.parse(created.stdout).path });
  assert.equal(plan.fm.verification.recipe, '.cursor/skills/verify-two/SKILL.md');
  assert.equal(locateVerification(f.root, plan.fm.verification.recipe).path, '.cursor/skills/verify-two/SKILL.md');
});
