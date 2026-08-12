/**
 * Phase 5 product feel: clear language, common-first palette, settings titles.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildCommandIndex, orderPaletteRows, TUI_COMMON_NOUNS } from '../lib/command-index.mjs';
import { openPalette } from '../lib/tui/palette.mjs';
import { configSettingsRows, SETTING_LABELS } from '../lib/tui/modals.mjs';
import { footerSegments, DEFAULT_FOOTER_ITEMS } from '../lib/tui/chrome.mjs';
import { tempDir } from './helpers/index.mjs';

test('tree and learnings use product language, not bare registry nouns', () => {
  const { rows } = buildCommandIndex({ surface: 'tui', workspace: process.cwd() });
  const tree = rows.find((r) => r.noun === 'tree');
  assert.ok(tree);
  assert.match(tree.label, /browse|files|knowledge/i);
  assert.doesNotMatch(tree.label, /^tree$/i);
  assert.ok(tree.note && tree.note.length > 10);

  const learnings = rows.find((r) => r.noun === 'learnings' && !r.verb);
  assert.ok(learnings);
  assert.match(learnings.label, /learn/i);
  assert.doesNotMatch(learnings.label, /^learnings$/i);
  assert.match(learnings.note, /learn/i);

  const why = rows.find((r) => r.noun === 'learnings' && /why/i.test(String(r.verb || r.label)));
  if (why) {
    assert.match(why.label, /why|provenance|learned/i);
  }
});

test('empty palette puts common intents before more', () => {
  const { rows } = buildCommandIndex({ surface: 'tui', workspace: process.cwd() });
  const ordered = orderPaletteRows(rows, { query: '' });
  const sections = ordered.filter((r) => r.section).map((r) => r.label);
  assert.deepEqual(sections.slice(0, 2), ['common', 'more']);
  const commonStart = ordered.findIndex((r) => r.section && r.label === 'common');
  const moreStart = ordered.findIndex((r) => r.section && r.label === 'more');
  const commonNouns = ordered
    .slice(commonStart + 1, moreStart)
    .filter((r) => !r.section)
    .map((r) => r.noun);
  assert.ok(commonNouns.includes('search'));
  assert.ok(commonNouns.includes('tree'));
  assert.ok(commonNouns.includes('learnings'));
  assert.ok(commonNouns.includes('config'));
  assert.equal(commonNouns[0], TUI_COMMON_NOUNS[0]);
  // Typing still ranks without forced sections.
  const filtered = orderPaletteRows(rows, { query: 'tree' });
  assert.equal(filtered.some((r) => r.section), false);
});

test('typing tree still finds Browse files (noun/note match)', () => {
  const { rows } = openPalette({ workspace: process.cwd(), query: 'tree' });
  assert.ok(rows.some((r) => r.noun === 'tree'), 'tree row survives product label rename');
});

test('typing learnings finds Browse learnings', () => {
  const { rows } = openPalette({ workspace: process.cwd(), query: 'learnings' });
  assert.ok(rows.some((r) => r.noun === 'learnings'));
});

test('settings sheet uses human titles, keeps machine key in note', () => {
  const workspace = tempDir('feel-ws-');
  const copilotHome = tempDir('feel-home-');
  const rows = configSettingsRows({ workspace, copilotHome });
  const agent = rows.find((r) => r.configKey === 'agent.enabled');
  assert.ok(agent);
  assert.equal(agent.label, SETTING_LABELS['agent.enabled']);
  assert.match(agent.note, /agent\.enabled/);
});

test('footer can show shell on/off', () => {
  assert.ok(DEFAULT_FOOTER_ITEMS.includes('shell'));
  const segs = footerSegments({ shell: 'denied', agent: false });
  assert.ok(segs.some((s) => /shell off/i.test(s.text)));
  const on = footerSegments({ shell: 'allowed' });
  assert.ok(on.some((s) => /shell on/i.test(s.text)));
});

test('CLI inventory is still machine nouns', () => {
  const { rows } = buildCommandIndex({ surface: 'cli', workspace: process.cwd() });
  assert.ok(rows.some((r) => r.id === 'command:tree' && r.label === 'tree'));
  assert.ok(rows.some((r) => r.id === 'command:learnings' && r.label === 'learnings'));
});

test('empty palette with section headers never selects a section', async () => {
  const { createOverlay } = await import('../lib/tui/overlay.mjs');
  const { rows } = buildCommandIndex({ surface: 'tui', workspace: process.cwd() });
  const ordered = orderPaletteRows(rows, { query: '' });
  assert.ok(ordered[0]?.section);
  const overlay = createOverlay({ rows: ordered });
  assert.equal(overlay.selected?.section, undefined);
  assert.ok(overlay.selected?.label);
  const enter = overlay.handleKey(null, { name: 'return' });
  assert.equal(enter.intent, 'choose');
  assert.equal(enter.row?.section, undefined);
});
