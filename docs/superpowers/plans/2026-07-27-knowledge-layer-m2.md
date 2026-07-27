# Knowledge Layer Milestone 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete the knowledge layer from `docs/brainstorms/2026-07-26-knowledge-layer-design.md` atop Milestone 1 (PR #37): human-authority surfaces (`remember`, `learnings [--why]`, `learning retire|dispute|confirm`, `knowledge <mode>|purge`), `consolidate --rebuild`, anchors + stale-anchor exclusion, seed arming, session-start debt drain, the `/consolidate` skill, knowledge SLOs in report/doctor, `eval-knowledge`, and the MEMORY-MODEL/threat-model docs.

**Architecture:** Same shape as M1 — model-free mechanics in `packages/harness/lib/knowledge/*.mjs` called by thin handlers in `lib/commands.mjs`, rendered through `createStyle`. Every learning write still flows through the `applyOps` sole-writer transaction (including `remember`); lifecycle commands mutate only frontmatter via `updateFrontmatterField` + `commitStore`. Model steps live only in the new `/consolidate` skill asset. Store home resolves via `harnessGlobalHome()` (HARNESS_HOME env → hermetic tests; there is no `--home` CLI flag).

**Tech Stack:** Node ESM (`.mjs`), `node:test`, no new dependencies.

## Global Constraints

- Every new command renders through `createStyle` (`ui.line`, `ui.errorBlock`, `printNext`); `--json` = one compact object via `emitJson`.
- Exit codes: `EXIT` registry in `lib/style.mjs` is `{ ok:0, usage:2, notInitialized:3, needsApproval:4, syncConflict:5, doctorFailed:6, network:7, interrupted:130 }` — plain `1` for command failures (matches `applyOps`). Use `EXIT.usage` (2) for usage errors, never a literal 64.
- No new npm dependencies. No model calls anywhere in the CLI.
- Caps unchanged: learning ≤ **1,200 bytes**; ≤ **5** file-touching ops per apply; debt threshold ≥ **5**; **top-3** injection.
- New telemetry event types MUST be added to `EVENT_TYPES` in `lib/events.mjs` (L10–21) or `writeEvent` silently drops them. New payload fields MUST be added to the passthrough list in `writeEvent` (L58–77). `writeEvent(workspace, flags, payload)` is the signature.
- Every store mutation ends in exactly one `commitStore(dir, message)`; the store is never pushed.
- Command registration = 3 places in `bin/harness.mjs`: import (L6–24), CATALOG entry (knowledge group, L170–181), `switch` case (L253–341).
- Run the full suite after every task: `node --test test/*.test.mjs` from `packages/harness/` (276/276 at branch tip); `node evals/run.mjs` before final push (13/13).
- Commit messages: `feat:`/`fix:`/`docs:` prefix; no co-author or tool references.
- Doc-sync rule: new/changed commands update `bin/harness.mjs` CATALOG, `packages/harness/README.md`, and `.github/skills/references/harness-tool-contract.md`.
- Integration tests use the `consolidate-apply.test.mjs` idiom: three temp dirs (`ws`, `home`, `harnessHome`), spawn the CLI with `--workspace ws --copilot-home home --json` and `env: { ...process.env, HARNESS_HOME: harnessHome }`, then re-open the store via `ensureStore(ws, { home: harnessHome })` + `listLearnings`/`readLedger` for assertions.

---

### Task 1: `harness remember` — the human teaching lane

**Files:**
- Modify: `packages/harness/lib/compound.mjs` (parameterize episode kind), `packages/harness/lib/knowledge/apply.mjs` (derive `source`/`status` from evidence kind), `packages/harness/lib/flags.mjs` (`--domain`), `packages/harness/lib/events.mjs` (`remember` event type), `packages/harness/lib/commands.mjs` (`cmdRemember`), `packages/harness/bin/harness.mjs` (import + CATALOG + case)
- Create: `packages/harness/lib/knowledge/remember.mjs`
- Test: `packages/harness/test/remember.test.mjs`

**Interfaces:**
- Consumes: `runInsightCompound` (compound.mjs L31), `applyOps` (apply.mjs L87), `normalizeSlug`/`ensureStore` (store.mjs), `scanSecrets`.
- Produces: `runRemember({ workspace, copilotHome, flags, argv, log }) → { pass, exitCode, episodePath, learningId, blockedReason, nextTools }` from `lib/knowledge/remember.mjs`. `runInsightCompound` gains a trailing `kind = 'insight'` option (frontmatter `kind: <kind>`; every other behavior unchanged). `renderLearning` (apply.mjs L38) derives: `source = episodes.length && episodes.every(e => e.kind === 'human-teaching') ? 'human' : 'auto'` and `status = source === 'human' ? 'active' : 'provisional'` (design §6: a direct human statement outranks statistics — no provisional damping for teachings).
- CLI: `harness remember "<claim>" --trigger "<applicability>" [--domain <d>]` — claim is the first positional; `--trigger` required; `--domain` defaults to `general`; `--category` (existing flag) defaults to `teachings` for the episode.

- [ ] **Step 1: Write the failing test** (`test/remember.test.mjs`)

```js
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { ensureStore, listLearnings, readLedger } from '../lib/knowledge/store.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const binPath = path.join(packageRoot, 'bin', 'harness.mjs');
const tempDir = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const ctx = () => ({ ws: tempDir('rem-ws-'), home: tempDir('rem-home-'), harnessHome: tempDir('rem-hh-') });
const run = ({ ws, home, harnessHome }, args) =>
  spawnSync(process.execPath, [binPath, ...args, '--workspace', ws, '--copilot-home', home, '--json'], {
    encoding: 'utf8', env: { ...process.env, HARNESS_HOME: harnessHome },
  });

test('remember writes a human-teaching episode and an active source: human learning in one transaction', () => {
  const c = ctx();
  const res = run(c, ['remember', 'Use two-step default+backfill for NOT NULL adds; direct ALTER takes an exclusive lock.',
    '--trigger', 'adding NOT NULL columns to hot tables', '--domain', 'sql']);
  assert.equal(res.status, 0, res.stderr + res.stdout);
  const out = JSON.parse(res.stdout);
  assert.equal(out.learningId, 'sql/adding-not-null-columns-to-hot-tables');
  const episode = fs.readFileSync(path.join(c.ws, out.episodePath), 'utf8');
  assert.match(episode, /kind: human-teaching/);
  const { dir } = ensureStore(c.ws, { home: c.harnessHome });
  const learning = listLearnings(dir).find((l) => l.id === out.learningId);
  assert.ok(learning, 'learning materialized');
  assert.equal(learning.fm.source, 'human');
  assert.equal(learning.fm.status, 'active');
  assert.equal(learning.fm.episodes[0].kind, 'human-teaching');
  assert.ok(readLedger(dir).some((e) => e.learning === out.learningId), 'episode consumed in ledger');
});

test('remember requires --trigger and a claim positional', () => {
  const c = ctx();
  assert.equal(run(c, ['remember', '--trigger', 'x']).status, 2);
  assert.equal(run(c, ['remember', 'claim text only']).status, 2);
});

test('remember refuses secret-shaped claims', () => {
  const c = ctx();
  const res = run(c, ['remember', 'key=AKIAIOSFODNN7EXAMPLE', '--trigger', 'aws keys']);
  assert.equal(res.status, 1);
  assert.match(res.stdout + res.stderr, /secret/i);
});
```

- [ ] **Step 2: Run to verify failure** — `node --test test/remember.test.mjs` → FAIL (unknown command exits `EXIT.usage`).

- [ ] **Step 3: Implement.**
  - `flags.mjs`: add `domain: null` to defaults; parser arms `else if (a.startsWith('--domain=')) flags.domain = a.split('=').slice(1).join('=');` / `else if (a === '--domain') flags.domain = argv[++i];`.
  - `events.mjs`: add `'remember'` to `EVENT_TYPES`.
  - `compound.mjs`: `runInsightCompound({ workspace, copilotHome, flags, log = () => {}, kind = 'insight' })`; frontmatter line becomes `` `kind: ${kind}` ``; return object keeps `kind`.
  - `apply.mjs`: in `renderLearning`, replace the hardcoded `status: 'provisional'` / `source: 'auto'` with the derivation from **Interfaces** above.
  - `lib/knowledge/remember.mjs`:

```js
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { runInsightCompound } from '../compound.mjs';
import { applyOps } from './apply.mjs';
import { normalizeSlug } from './store.mjs';

export function runRemember({ workspace, copilotHome, flags, argv, log = () => {} }) {
  const claim = argv[0] && !argv[0].startsWith('--') ? argv[0] : null;
  if (!claim || !flags.trigger) {
    return { pass: false, exitCode: 2, episodePath: null, learningId: null,
      blockedReason: 'remember needs a claim positional and --trigger',
      nextTools: ['harness remember "<claim>" --trigger "<when it applies>"'] };
  }
  const teachFlags = { ...flags, title: claim.slice(0, 80), body: claim,
    category: flags.category || 'teachings', claim, insight: true };
  const episode = runInsightCompound({ workspace, copilotHome, flags: teachFlags, log, kind: 'human-teaching' });
  if (!episode.pass) return { ...episode, episodePath: episode.path, learningId: null };
  const text = fs.readFileSync(path.join(workspace, episode.path), 'utf8');
  const sha256 = crypto.createHash('sha256').update(text).digest('hex');
  const domain = normalizeSlug(flags.domain || 'general');
  const slug = normalizeSlug(flags.trigger);
  const ops = { schema: 1, ops: [{ op: 'ADD', domain, slug, trigger: flags.trigger, body: claim,
    episodes: [{ path: episode.path, sha256, kind: 'human-teaching', plan: null }] }] };
  const opsDir = path.join(workspace, '.harness');
  fs.mkdirSync(opsDir, { recursive: true });
  const opsPath = path.join(opsDir, 'remember-ops.json');
  fs.writeFileSync(opsPath, JSON.stringify(ops), 'utf8');
  const applied = applyOps({ workspace, opsPath, dryRun: flags.dryRun });
  if (applied.exitCode !== 0) {
    return { pass: false, exitCode: applied.exitCode, episodePath: episode.path, learningId: null,
      blockedReason: applied.rejected?.[0]?.reason || 'apply failed',
      nextTools: ['shorten the claim (1,200-byte learning cap) and re-run'] };
  }
  return { pass: true, exitCode: 0, episodePath: episode.path, learningId: `${domain}/${slug}`,
    blockedReason: null, nextTools: ['harness learnings ' + domain] };
}
```

  - `commands.mjs` `cmdRemember(argv)` follows the standard handler shape (lazy import → `parseFlags` → resolve workspace/home → run → `writeEvent(workspace, flags, { type: 'remember', command: 'remember', result: pass ? 'pass' : 'fail', exitCode })` → `emitJson` or `ui.line({ state: 'ok', key: 'remember', value: result.learningId, note: 'source: human · episode ' + result.episodePath })` + `printNext` → return exit code). Usage failures render `ui.errorBlock({ code: 'E_USAGE', message: result.blockedReason, fix: result.nextTools[0], exit: EXIT.usage })`.
  - `bin/harness.mjs`: import `cmdRemember`; CATALOG knowledge group entry `{ name: 'remember', desc: 'teach the harness a durable claim (human-teaching episode + learning)', sig: '"<claim>" --trigger "<t>" [--domain <d>]', options: [['--trigger <t>', 'applicability condition (required)'], ['--domain <d>', 'learning domain directory (default general)']] }`; `case 'remember':`.

- [ ] **Step 4: Tests pass + full suite** (the `consolidate-apply` fixtures still pass — `ADD` ops with fix episodes still render `source: auto`, `status: provisional`).
- [ ] **Step 5: Commit** — `feat: add harness remember human teaching lane through the sole writer`

---

### Task 2: `harness learning retire|dispute|confirm` — one-command human authority

**Files:**
- Create: `packages/harness/lib/knowledge/lifecycle.mjs`
- Modify: `packages/harness/lib/knowledge/apply.mjs` (export `updateFrontmatterField`), `packages/harness/lib/flags.mjs` (`--reason`), `packages/harness/lib/events.mjs` (`learning` event type), `packages/harness/lib/commands.mjs` (`cmdLearning`), `packages/harness/bin/harness.mjs`
- Test: `packages/harness/test/learning-lifecycle.test.mjs`

**Interfaces:**
- Consumes: `listLearnings`, `ensureStore`, `commitStore` (store.mjs), `updateFrontmatterField` (apply.mjs L253 — add `export`).
- Produces: `setLearningStatus({ workspace, id, action, reason, home }) → { pass, exitCode, id, status, blockedReason }` where `action ∈ retire|dispute|confirm`. `retire → status: retired`; `dispute → status: disputed`; `confirm → status: active` **and** `last_confirmed` set to today (clamped). Store commit message: `` `${action} ${id}: ${reason || 'human confirm'}` ``.
- CLI: `harness learning <retire|dispute|confirm> <id> --reason "<r>"` — reason required for retire/dispute (`EXIT.usage` without), optional for confirm. Unknown id → exit 1 with `E_TARGET` errorBlock. Unknown action → `EXIT.usage`.

- [ ] **Step 1: Write the failing test** — same `ctx()`/`run()` helper as Task 1. Seed one learning by running a Task-1 `remember` plus one auto learning via a `consolidate --apply` ops file (reuse the `EP`/`ADD` builders idiom from `consolidate-apply.test.mjs` L34–42). Assert:
  - `learning retire <autoId> --reason "wrong"` → exit 0; `listLearnings` shows `fm.status === 'retired'`; store `git log --oneline` head is `retire <autoId>: wrong`.
  - retired learning no longer appears in `rankLearnings` results (import from `../lib/knowledge/retrieve.mjs` with `{ home }`).
  - `learning dispute <id>` without `--reason` → exit 2.
  - `learning confirm <disputedId>` → exit 0, `fm.status === 'active'`, `fm.last_confirmed` equals today's `YYYY-MM-DD`.
  - `learning retire missing/id --reason x` → exit 1, output matches `/E_TARGET/`.
- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement** `lifecycle.mjs`:

```js
import { ensureStore, listLearnings, commitStore } from './store.mjs';
import { updateFrontmatterField, todayClamped } from './apply.mjs';

const ACTIONS = new Set(['retire', 'dispute', 'confirm']);
const TARGET_STATUS = { retire: 'retired', dispute: 'disputed', confirm: 'active' };

export function setLearningStatus({ workspace, id, action, reason, home }) {
  if (!ACTIONS.has(action) || !id) {
    return { pass: false, exitCode: 2, id: id || null, status: null,
      blockedReason: 'usage: harness learning <retire|dispute|confirm> <id> --reason "<r>"' };
  }
  if (action !== 'confirm' && !reason) {
    return { pass: false, exitCode: 2, id, status: null, blockedReason: `${action} requires --reason` };
  }
  const { dir } = ensureStore(workspace, { home });
  const learning = listLearnings(dir).find((l) => l.id === id);
  if (!learning) {
    return { pass: false, exitCode: 1, id, status: null, blockedReason: `E_TARGET: no learning ${id}` };
  }
  updateFrontmatterField(learning.file, 'status', TARGET_STATUS[action]);
  if (action === 'confirm') updateFrontmatterField(learning.file, 'last_confirmed', todayClamped());
  commitStore(dir, `${action} ${id}: ${reason || 'human confirm'}`);
  return { pass: true, exitCode: 0, id, status: TARGET_STATUS[action], blockedReason: null };
}
```

  (Also `export` `updateFrontmatterField` and `todayClamped` from apply.mjs.) `flags.mjs`: add `reason: null` + two-arm parser. `events.mjs`: add `'learning'` to `EVENT_TYPES`. `cmdLearning(argv)`: `action = argv[0]`, `id = argv[1]` (both non-flag positionals), standard handler; success line `ui.line({ state: action === 'retire' ? 'warn' : 'ok', key: 'learning', value: `${id} → ${result.status}` })`; event `{ type: 'learning', command: 'learning', decision: action, result: 'pass', exitCode: 0 }`. CATALOG entry `{ name: 'learning', desc: 'human authority over one learning: retire, dispute, or confirm', sig: '<retire|dispute|confirm> <id> --reason "<r>"', options: [['--reason <r>', 'required for retire/dispute; recorded in the store commit']] }` + `case 'learning':`.

- [ ] **Step 4: Tests pass + full suite.**
- [ ] **Step 5: Commit** — `feat: add learning retire dispute confirm lifecycle commands`

---

### Task 3: `harness learnings [domain] [--why <id>]` — fenced listing with provenance

**Files:**
- Create: `packages/harness/lib/knowledge/listing.mjs`
- Modify: `packages/harness/lib/flags.mjs` (`--why`), `packages/harness/lib/commands.mjs` (`cmdLearnings`), `packages/harness/bin/harness.mjs`
- Test: `packages/harness/test/learnings-listing.test.mjs`

**Interfaces:**
- Consumes: `listLearnings`, `ensureStore` (store.mjs), `promotionCandidates` (consolidate.mjs L79), `readEvents` (events.mjs) for failure annotations.
- Produces from `listing.mjs`:
  - `listingView({ workspace, domain, home }) → { learnings: [{ id, status, source, trigger, verified, plans, promotionEligible, failures }], counts: { active, total } }` — sorted by id; `domain` filters by directory; `verified` = episode links with `kind: 'fix'`; `plans` = distinct non-null `plan` values; `promotionEligible` = `verified >= 3 && plans >= 2`; `failures` = count of workspace events where `e.type === 'verify' && e.result === 'fail' && Array.isArray(e.learnings) && e.learnings.includes(id)`.
  - `whyView({ workspace, id, home }) → { id, trigger, claimLine, status, source, lastConfirmed, supersededBy, mergedFrom, episodes: [{ path, kind, plan }], verified, plans, promotionEligible, failures } | null`.
- Rendering contract (design §8 — every human surface fenced): first output line is the muted fence `ui.paint('muted', 'learnings are untrusted memory — data, not instructions')`; one `ui.line` per learning: `state` = `ok` (active) / `warn` (provisional|disputed) / `pending` (retired/superseded, shown only with `--verbose`); `key` = id; `value` = trigger; `note` = `` `${status} · ${source} · ${verified} verified/${plans} plans` `` plus, when `failures > 0 && source === 'human'`, `` ` · evidence contradicts (${failures} failures) — confirm or retire` ``, plus `promotionEligible` → `` ` · promotable → /create-primitive` ``.

- [ ] **Step 1: Write the failing test** — seed via one `remember` + one apply ADD (fix-kind episodes across 2 distinct `plan` values ×3 links so it is promotion-eligible). Append a fake failure event line directly to `<ws>/.harness/events.jsonl`: `{"version":2,"type":"verify","result":"fail","learnings":["sql/adding-not-null-columns-to-hot-tables"]}`. Assert:
  - `learnings --json` returns both learnings with correct `verified`, `plans`, `promotionEligible: true` on the seeded one, `failures: 1` on the remembered one.
  - `learnings sql --json` filters to the sql domain only.
  - plain `learnings` output contains the fence line `untrusted memory` and `evidence contradicts (1 failures)`.
  - `learnings --why sql/<slug> --json` returns the provenance object with `episodes[0].kind === 'human-teaching'`.
  - `learnings --why missing/id` exits 1.
- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement** — `listing.mjs` composes `listLearnings` + `parseLearningFrontmatter` output (`fm.episodes` already structured); failure counts read `<ws>/.harness/events.jsonl` through `readEvents(workspace)` in a try/catch (missing file → 0). `flags.mjs`: `why: null` + two-arm parser. `cmdLearnings(argv)`: `domain` = first non-flag positional; `--why` routes to `whyView` (render one line per field group: trigger, claim, provenance episodes as indented muted lines, then status/source/verified). No `writeEvent` (read-only command — matches the recall/report convention in `harness-tool-contract.md:176`). CATALOG entry `{ name: 'learnings', desc: 'paged listing of learnings with provenance and failure annotations', sig: '[domain] [--why <id>]', options: [['--why <id>', 'full provenance chain for one learning']] }` + case.
- [ ] **Step 4: Tests pass + full suite.**
- [ ] **Step 5: Commit** — `feat: add fenced learnings listing with provenance and failure annotations`

---

### Task 4: `harness knowledge <on|off|freeze|capture-only> | --status | purge` — kill switch and purge cascade

**Files:**
- Create: `packages/harness/lib/knowledge/admin.mjs`
- Modify: `packages/harness/lib/knowledge/store.mjs` (`readStoreConfig`/`writeStoreConfig`), `packages/harness/lib/knowledge/consolidate.mjs` (mode in status), `packages/harness/lib/knowledge/apply.mjs` (mode gate), `packages/harness/lib/knowledge/remember.mjs` (mode gate), `packages/harness/lib/compound.mjs` (insight gate), `packages/harness/lib/orient.mjs` (injection gate), `packages/harness/lib/events.mjs` (`knowledge` type), `packages/harness/lib/commands.mjs` (`cmdKnowledge`), `packages/harness/bin/harness.mjs`
- Test: `packages/harness/test/knowledge-admin.test.mjs`

**Interfaces:**
- `readStoreConfig(workspace, { home }) → { mode }` (default `{ mode: 'on' }`; reads `<store>/config.json`, tolerant of absence/corruption); `writeStoreConfig(workspace, { home, mode })` writes and `commitStore(dir, 'knowledge: mode <mode>')`. Both exported from store.mjs.
- Mode matrix (enforce exactly this):

| mode | orient injects learnings + debt hint | `compound --insight` | `remember` | `consolidate` hints/`--apply` |
|---|---|---|---|---|
| `on` | yes | yes | yes | yes |
| `freeze` | yes | yes | no | no |
| `capture-only` | no | yes | no | no |
| `off` | no | no | no | no |

  Gated paths return `{ pass: false, exitCode: 2, blockedReason: 'knowledge mode is <mode> — run: harness knowledge on' }` (in `applyOps`: `rejected: [{ code: 'E_MODE', reason: ... }], exitCode: 2`). `consolidateStatus` gains `mode` in its return and forces `due: false` + empty `nextTools` when mode ≠ `on`.
- `purgeEpisode({ workspace, target, home }) → { pass, exitCode, removed: { episode, learnings: [id], links: [id], ledger: n }, blockedReason }` — cascade (design §3): delete the episode file at repo-relative `target` (if present); for every learning citing it: sole evidence → delete the learning file; otherwise rewrite the file dropping that episode link (re-render frontmatter from parsed `fm` — write a `removeEpisodeLink(file, targetPath)` helper in admin.mjs that re-serializes the same field order `renderLearning` uses); rewrite `consolidated.jsonl` excluding entries with that `path`; rebuild INDEX.md (import `rebuildIndex` from apply.mjs — add `export`); one `commitStore(dir, 'purge: <target>')`.
- `purgeAll({ workspace, home }) → { pass, exitCode, removed: { learnings: n } }` — reset T2 only: delete `learnings/*`, truncate `consolidated.jsonl`, INDEX stub, keep `config.json`, `commitStore(dir, 'purge: --all (store reset)')`. Episodes stay (they re-appear as debt — the CLI prints that note).
- CLI: `harness knowledge <on|off|freeze|capture-only>` sets mode; `harness knowledge --status` (also bare `knowledge`) shows `ui.line({ state: mode === 'on' ? 'ok' : 'warn', key: 'knowledge', value: 'mode ' + mode })`; `harness knowledge purge <file>` / `purge --all`.

- [ ] **Step 1: Write the failing test** — assert: (a) `knowledge off` then `orient --json` → `learnings: []` even with a seeded matching learning, and `compound --insight` exits 2 with `/mode is off/`; (b) `knowledge freeze` → orient still injects, `remember` exits 2, `consolidate --apply` exits 2 with `E_MODE`; (c) `knowledge on` restores; (d) `knowledge purge <episodePath>` on a store where that episode is the sole evidence → learning file gone, ledger has no entry for the path, INDEX.md no longer lists it, episode file deleted from `ws`; a second learning citing it plus another episode keeps its file but loses the link; (e) `knowledge purge --all` → `learnings/` empty, ledger empty, `consolidate --status --json` shows the episodes as debt again; (f) `knowledge bogus` exits 2.
- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement** — gates read `readStoreConfig` at the top of `runOrient`'s learnings block (mode off/capture-only → `learnings = []`, skip Task-8 debt hint), `runInsightCompound` (off), `runRemember` (≠ on), `applyOps` (≠ on → `E_MODE`, checked before the lock), `consolidateStatus`. `cmdKnowledge(argv)`: subcommand = `argv[0]`; `purge` target = `argv[1]` or `--all`; event `{ type: 'knowledge', command: 'knowledge', decision: subcommand, result, exitCode }`. CATALOG entry `{ name: 'knowledge', desc: 'knowledge layer mode switch and purge (human deletion always wins)', sig: '<on|off|freeze|capture-only> | --status | purge <file|--all>', options: [['--status', 'show the active mode (default)'], ['purge <file>', 'cascade-delete an episode and dependent learnings'], ['purge --all', 'reset the learnings store (episodes remain, become debt)']] }` + case.
- [ ] **Step 4: Tests pass + full suite** (existing consolidate/orient tests still pass — default mode is `on`).
- [ ] **Step 5: Commit** — `feat: add knowledge mode kill switch and purge cascade`

---

### Task 5: Anchors written by `--apply`, stale-anchor exclusion at `harness index`

**Files:**
- Modify: `packages/harness/lib/knowledge/apply.mjs` (extract + render `anchors:`), `packages/harness/lib/knowledge/store.mjs` (parse `anchors:` list; `readStaleExclusions`/`writeStaleExclusions`), `packages/harness/lib/knowledge/retrieve.mjs` (skip excluded), `packages/harness/lib/commands.mjs` (`cmdIndex` stale pass)
- Test: `packages/harness/test/stale-anchors.test.mjs`

**Interfaces:**
- `extractAnchors({ workspace, episodes }) → string[]` (apply.mjs, module-private): for each op episode whose `path` exists under `workspace`, regex the episode text with `/\b[\w][\w./-]*\.(?:mjs|js|ts|tsx|py|java|sql|md|ya?ml|json)\b/g`, keep matches where `fs.existsSync(path.join(workspace, m))`, exclude the episode's own path, dedupe, sort, cap at 8. `renderLearning` writes `anchors:` as a YAML list (`anchors: []` when empty; else one `  - <path>` line each) between `episodes` and `superseded_by`.
- `parseLearningFrontmatter` (store.mjs L92): handle the `anchors:` block — when the current list key is `anchors`, lines matching `^  - (.+)$` push unquoted strings to `fm.anchors` (default `[]`; must not collide with the `episodes` block parser — track which list key is open).
- `readStaleExclusions(dir) → { excluded: { [id]: string[] } }` (from `<store>/stale.json`, tolerant default `{ excluded: {} }`); `writeStaleExclusions(dir, data)`. stale.json is CLI state, not a learning write — no commit needed, but include it in `ensureStore`'s created set semantics (just write the file; git picks it up on next `commitStore`).
- `cmdIndex` (commands.mjs L312): after the manifest rebuild + codebase-map refresh (never in `--status`, never in dry-run), run the stale pass: `ensureStore` → for each `listLearnings` entry with `fm.anchors.length`, `missing = anchors.filter((a) => !fs.existsSync(path.join(workspace, a)))`; `missing.length` → `excluded[id] = missing`; write the full recomputed map (reconfirmation = anchors resolve again → entry dropped). Report `· learnings excluded N (stale anchors)` in the index note when N > 0, and `staleLearnings: N` in the JSON result.
- `rankLearnings` (retrieve.mjs): after the status filter, skip ids present in `readStaleExclusions(dir).excluded`.

- [ ] **Step 1: Write the failing test** — in a temp git `ws`, create `src/orders.mjs`, an episode doc whose body mentions `src/orders.mjs`, apply an ADD linking it. Assert: (a) the learning file contains `anchors:` with `  - src/orders.mjs`; (b) `harness orient --query <trigger words> --json` surfaces it; (c) delete `src/orders.mjs`, run `harness index`, JSON has `staleLearnings: 1`, and orient no longer surfaces the learning; (d) restore the file, `harness index`, orient surfaces it again; (e) a learning with `anchors: []` is never excluded.
- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement** per the interfaces. Keep the whole stale pass inside a try/catch in `cmdIndex` (advisory — index must never fail because the store is unreadable).
- [ ] **Step 4: Tests pass + full suite** (knowledge-store parser tests updated for the new `anchors` fixture line; `consolidate-apply` fixtures gain `anchors: []` in written files — update any exact-content assertions).
- [ ] **Step 5: Commit** — `feat: write learning anchors and exclude stale-anchored learnings at index`

---

### Task 6: `consolidate --rebuild` — T2 reset for regeneration

**Files:**
- Modify: `packages/harness/lib/knowledge/admin.mjs` (`rebuildStore`), `packages/harness/lib/flags.mjs` (`yes: false` + `--yes` bool arm), `packages/harness/lib/commands.mjs` (`cmdConsolidate` branch), `packages/harness/bin/harness.mjs` (CATALOG sig), `packages/harness/test/prompt-library-contracts.test.mjs` (sig pin)
- Test: `packages/harness/test/consolidate-rebuild.test.mjs`

**Interfaces:**
- `rebuildStore({ workspace, home, yes }) → { pass, exitCode, archived, debt, blockedReason, nextTools }`. Without `yes`: no mutation, `exitCode: 2`, `blockedReason: 'rebuild resets N learnings (git history retains them) — re-run with --yes'`. With `yes`: delete every file under `learnings/`, truncate `consolidated.jsonl` to empty, write the INDEX stub, delete `stale.json`, keep `config.json`, one `commitStore(dir, 'consolidate: rebuild reset (N learnings archived to git history)')`; `archived` = prior learning count; `debt` = fresh `consolidateStatus(...).debt` (all episodes unconsolidated again — human teachings persist as `kind: human-teaching` episodes, so `source: human` learnings regenerate with full authority: the re-derivability invariant, design §2). `nextTools: ['harness consolidate --candidates']`. Mode gate: ≠ `on` → `E_MODE` exit 2.
- CLI: `harness consolidate --rebuild [--yes]` — new branch in `cmdConsolidate` checked **before** `--status` default (`argv.includes('--rebuild')`). CATALOG sig becomes `'[--status | --candidates | --apply --ops <path> | --rebuild --yes]'` — update the contract-test pin at `prompt-library-contracts.test.mjs:558` to the new literal.

- [ ] **Step 1: Write the failing test** — seed 2 learnings (one via `remember`); (a) `consolidate --rebuild` without `--yes` → exit 2, store untouched; (b) with `--yes` → exit 0, `listLearnings` empty, ledger empty, `consolidate --status --json` debt counts every episode (including the human-teaching one), store `git log` head matches `/rebuild reset \(2 learnings archived/`; (c) `--rebuild --yes` on an empty store → exit 0, `archived: 0`.
- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement** per interfaces; render `ui.line({ state: 'warn', key: 'rebuild', value: `archived ${archived} · debt ${debt}/5` })` + `printNext`; event `{ type: 'consolidate', command: 'consolidate', decision: 'rebuild', result, exitCode }`.
- [ ] **Step 4: Tests pass + full suite** (contract test pin updated in the same commit).
- [ ] **Step 5: Commit** — `feat: add consolidate rebuild as the model-upgrade regeneration reset`

---

### Task 7: Seed arming in `init-repo` + upgrade next-hint

**Files:**
- Modify: `packages/harness/lib/init-repo.mjs`, `packages/harness/lib/commands.mjs` (`cmdInstallOrUpgrade` hint)
- Test: `packages/harness/test/seed-arming.test.mjs`

**Interfaces:**
- New final step in `runInitRepo` (after the codebase-map step, init-repo.mjs L96), advisory try/catch: `ensureStore(workspace)` then `consolidateStatus({ workspace, copilotHome })`; when `debt > 0`, `log(\`armed ${debt} existing solution doc(s) as consolidation debt — drains at first session start\`)` and push `'knowledge store'` to `stats.created` when `ensureStore` reports `created: true`. Design §5: armed at init, executed at first session start (Task 8 does the executing).
- `cmdInstallOrUpgrade` (commands.mjs L107): after the existing steps, when `fs.existsSync(path.join(process.cwd(), 'docs', 'solutions'))` and the command was `upgrade`, print `printNext('harness init-repo  # arm existing docs/solutions as consolidation debt')`. No workspace mutation from upgrade (it is global-home scoped).

- [ ] **Step 1: Write the failing test** — temp git `ws` with 6 pre-existing `docs/solutions/debugging/*.md` fix docs; `harness init-repo --workspace ws` (with `HARNESS_HOME` temp) → exit 0, output matches `/armed 6/`, store dir exists, and `consolidate --status --json` reports `debt: 6, due: true` without any further command. A workspace with no solutions logs nothing about arming.
- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement** per interfaces (arming must not fail init when git is absent — `ensureStore` already degrades).
- [ ] **Step 4: Tests pass + full suite.**
- [ ] **Step 5: Commit** — `feat: arm existing solution docs as consolidation debt at init`

---

### Task 8: Session-start debt drain in orient + surfaced-learnings telemetry

**Files:**
- Modify: `packages/harness/lib/orient.mjs`, `packages/harness/lib/events.mjs` (`learnings` passthrough field), `packages/harness/lib/commands.mjs` (`cmdOrient` event payload)
- Test: `packages/harness/test/orient-debt-drain.test.mjs`

**Interfaces:**
- `runOrient` (orient.mjs L15): mirror the index-staleness block at L94–99 — in a try/catch, `const debt = consolidateStatus({ workspace, copilotHome });` and when `debt.due && !activePlan` (debounce: skip while an active plan has phases in flight, design §5 L74) push `` `harness consolidate --candidates  # knowledge debt ${debt.debt}/${debt.threshold}` `` to `nextTools`. Result object gains `knowledgeDebt: { debt, threshold, due }` (null on error/mode≠on).
- `writeEvent` (events.mjs L58–77): add `learnings` to the optional passthrough fields (array of ids, pass through as-is).
- `cmdOrient` (commands.mjs L389 writeEvent): add `learnings: (result.learnings || []).map((l) => l.id)` to the orient event payload — this is the **surfaced** half of the utilization SLO.

- [ ] **Step 1: Write the failing test** — seed 5 unconsolidated fix episodes + 1 matching learning; run `orient --query <trigger words> --json` with no active plan: JSON has `knowledgeDebt.due === true` and `nextTools` containing `consolidate --candidates`; `.harness/events.jsonl` last orient event contains `"learnings":["<id>"]`. With an active plan file in `docs/plans/` (copy the frontmatter shape from an existing orient test fixture), the debt hint is absent but `knowledgeDebt` still reports. With `knowledge off`, `knowledgeDebt` is null and no hint.
- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement** per interfaces.
- [ ] **Step 4: Tests pass + full suite** (orient-learnings and context-pack tests unchanged — the pack format does not change; only `nextTools` and the event payload grow).
- [ ] **Step 5: Commit** — `feat: drain consolidation debt at session start and record surfaced learnings`

---

### Task 9: `/consolidate` skill asset + engineer/auto-compound wiring + inventory sync

**Files:**
- Create: `.github/skills/consolidate/SKILL.md`
- Modify: `.github/skills/auto-compound/SKILL.md` (post-persist debt check), `.github/agents/engineer.agent.md` (orient step notes the debt hint), `.github/skills/recall/SKILL.md` (mention learnings in the pack), `CLAUDE.md`, `AGENTS.md`, `.github/copilot-instructions.md`, `.github/agent-context.md` (skill counts 24 → 25 and inventory lists), `README.md` (if it lists counts)
- Test: existing `prompt-library-contracts.test.mjs` suite (SKILL line cap + inventory checks)

**Interfaces:**
- `SKILL.md` frontmatter matches sibling internal skills (`user-invocable: false`, engineer-internal). Body (keep under the `SKILL_BODY_MAX_LINES` cap pinned in `prompt-library-contracts.test.mjs:566`) encodes the design §5 write path verbatim as steps:
  1. Run `harness consolidate --candidates --json`; read the packet (clusters + every active learning id/trigger; bodies present while corpus ≤30KB).
  2. Per cluster decide `ADD | STRENGTHEN | SUPERSEDE | NOOP`. Rules: corpus-wide dedup — an ADD must record in its op `reason` which k nearest learnings were checked and why none match; STRENGTHEN/SUPERSEDE re-read the RAW episode files, never paraphrase existing learning text; claims a repo map could derive → NOOP; run the imperative lint mentally before emitting (no shell fences/curl/wget/bare URLs in insight-derived bodies).
  3. Write ops JSON to `.harness/consolidate-ops.json`. The skill writes NOTHING else.
  4. If `harness knowledge --status` reports mode `suggest`-like review policy (or `consolidate --status` shows mode ≠ on) stop and present the ops JSON as a diff for the human; otherwise run `harness consolidate --apply --ops .harness/consolidate-ops.json` and report the ledger line, including any `E_DISPUTED` rejections verbatim.
  5. On apply failure: fix the ops per the error code (`E_BYTE_CAP` → split the claim; `E_DELTA_CONTRACT` → drop lowest-value ops; `E_LINT` → NOOP the cluster) and retry once; twice-failed clusters are left for quarantine.
- `auto-compound/SKILL.md`: after the persist step (L74–82), add: run `harness consolidate --status --json`; when `due`, invoke `/consolidate` (session-end drain, design §5 L91).
- `engineer.agent.md` step 1 (L31): append — "act on any `consolidate --candidates` next-hint in the pack by loading `/consolidate` (session-start drain)."

- [ ] **Step 1:** Write `SKILL.md` + wiring edits + inventory/count updates across the six sync files (CLAUDE.md "When Adding/Removing Agents or Skills" checklist).
- [ ] **Step 2:** Run the contract suite — `node --test test/prompt-library-contracts.test.mjs` → line cap and inventory assertions pass.
- [ ] **Step 3: Full suite.**
- [ ] **Step 4: Commit** — `feat: add consolidate skill and wire session start and end debt drains`

---

### Task 10: Knowledge SLOs — cited telemetry, report section, doctor checks

**Files:**
- Modify: `packages/harness/lib/flags.mjs` (`learnings: null` + `--learnings` csv arm), `packages/harness/lib/commands.mjs` (`cmdVerify` event payload, `cmdDoctor` workspace), `packages/harness/lib/report.mjs` (`knowledgeSlos` + render + JSON), `packages/harness/lib/doctor.mjs` (K1–K3 checks), `.github/skills/references/harness-tool-contract.md` (verify `--learnings` attribution contract)
- Test: `packages/harness/test/knowledge-slos.test.mjs`

**Interfaces:**
- Attribution (design §7): `harness verify --learnings <id1,id2>` — the skill passes the ids it actually applied. `cmdVerify` (commands.mjs L491) adds `learnings: flags.learnings ? flags.learnings.split(',').map((s) => s.trim()).filter(Boolean) : undefined` to its event payload (passthrough field added in Task 8). This is the **cited** half.
- `knowledgeSlos(events)` (report.mjs, exported, beside `recoveryLoops`): 

```js
export function knowledgeSlos(events) {
  const surfaced = new Set(); const cited = new Set();
  let consolidations = 0; let humanActions = 0;
  for (const e of events) {
    if (e.type === 'orient' && Array.isArray(e.learnings)) e.learnings.forEach((id) => surfaced.add(id));
    if (e.type === 'verify' && Array.isArray(e.learnings)) e.learnings.forEach((id) => cited.add(id));
    if (e.type === 'consolidate' && e.decision === 'apply' && e.result === 'pass') consolidations += 1;
    if (e.type === 'remember' || e.type === 'learning') humanActions += 1;
  }
  const citedSurfaced = [...cited].filter((id) => surfaced.has(id)).length;
  return { surfaced: surfaced.size, cited: cited.size,
    utilization: surfaced.size ? Number((citedSurfaced / surfaced.size).toFixed(2)) : null,
    consolidations, humanActions,
    engagement: consolidations ? Number((humanActions / consolidations).toFixed(2)) : null };
}
```

  Requires `cmdConsolidate`'s apply branch (commands.mjs L769) to add `decision: 'apply'` to its event payload (existing passthrough field). `buildReport` return gains `slos: { knowledge: knowledgeSlos(events) }`; `renderReport` adds a `knowledge` section after the session-performance call (report.mjs L324): `ui.line({ state: utilization !== null && utilization < 0.15 && surfaced >= 20 ? 'warn' : 'ok', key: 'knowledge', value: `utilization ${...}% (${cited}/${surfaced} surfaced)`, note: `engagement ${...} human actions/${consolidations} consolidations` })` — skip the section entirely when `surfaced === 0 && consolidations === 0`.
- Doctor (design §2 L29, §3 L39, §12 L147): `runDoctor` signature gains `workspace` (cmdDoctor passes `path.resolve(flags.workspace)`); three checks appended, all `optional: true`, each in a try/catch:
  - `K1` store-vanished: workspace events contain any `consolidate` event but `storeDir(workspace)` does not exist → fail, hint `'knowledge store missing — restore from backup or run: harness consolidate --rebuild --yes after re-arming'`.
  - `K2` quarantine: `consolidateStatus(...).quarantined.length > 0` → fail, hint `'quarantined episode cluster(s) — inspect with harness consolidate --status'`.
  - `K3` utilization: `knowledgeSlos(loadReportEvents({ workspace })).utilization < 0.15` with `surfaced >= 20` → fail, hint `'knowledge layer is noise (<15% utilization) — consider: harness knowledge off'`.

- [ ] **Step 1: Write the failing test** — build an events.jsonl with 3 orient events surfacing ids a,b,c and 1 verify event citing a: `report --json` → `slos.knowledge.utilization === 0.33`... (exact: cited∩surfaced 1 / surfaced 3 → `0.33`), `consolidations`/`humanActions` counted from seeded consolidate/remember events; plain `report` renders a `knowledge` line. Doctor: with a consolidate event and no store dir → K1 appears failed-optional in `doctor --verbose` output; existing doctor tests still pass (K-checks optional).
- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement** per interfaces. Preserve the pinned report contract: first line `^report\s+~[\d,]+ tokens` (report.test.mjs:34) and single-line `--json` (:87).
- [ ] **Step 4: Tests pass + full suite.**
- [ ] **Step 5: Commit** — `feat: add knowledge utilization and engagement slos to report and doctor`

---

### Task 11: `harness eval-knowledge` — deterministic retrieval eval with temporal split

**Files:**
- Create: `packages/harness/lib/knowledge/eval.mjs`, `evals/tasks/eval-knowledge/task.mjs`, `evals/fixtures/knowledge-negative-queries.json`
- Modify: `packages/harness/lib/commands.mjs` (`cmdEvalKnowledge`), `packages/harness/bin/harness.mjs` (CATALOG knowledge group + case)
- Test: `packages/harness/test/eval-knowledge.test.mjs`

**Interfaces:**
- Scope note (stated in the command's own output and README): this is the **deterministic retrieval eval** — hit/false-surface/token cost per arm on a temporally held-out split. The model-graded net-benefit number (design §12) requires agent sessions and stays deferred; no benefit claim is published from this command (design §1: never a headline before it is measured).
- `evalKnowledge({ workspace, copilotHome, home, negativeQueries = [] }) → { split: { train, heldOut, cutoff }, arms: { none, frontmatter, wholeIndex, bm25 }, recommendation }`:
  - Split: `collectEpisodes` sorted by frontmatter `date` (undated → excluded, counted); `cutoff` = median date; held-out = episodes strictly after cutoff. Fewer than 4 dated episodes → `{ pass: false, exitCode: 2, blockedReason: 'need ≥4 dated episodes for a split' }`.
  - Ground truth per held-out episode: relevant learnings = active learnings with a ledger-linked episode in the same `category` whose date ≤ cutoff (relevance proxy, labeled as such). Held-out episodes with no relevant learning are excluded from hit-rate (counted as `unscorable`).
  - Query per held-out episode = `tokenize(title + ' ' + tags.join(' '))` (reuse the tokenizer `rankLearnings` uses).
  - Arms, each `{ hitRate, falseSurfaceRate, injectedTokens }`: `none` — never surfaces (baseline 0/0/0); `frontmatter` — v1a control: rank held-out query against episode `trigger`/`claim` manifest lines of train episodes, hit when a top-3 entry shares the category; `wholeIndex` — every active learning's trigger line injected: hit when any relevant learning exists, `injectedTokens` = ceil(total trigger bytes / 4); `bm25` — `rankLearnings` top-3: hit when a relevant learning appears, `injectedTokens` = ceil(top-3 trigger+claim bytes / 4). `falseSurfaceRate` = fraction of `negativeQueries` (from the fixture JSON: 6 short queries about topics absent from the corpus, e.g. `"kubernetes ingress tls rotation"`) for which the arm surfaces ≥1 learning above `minScore`.
  - `recommendation`: `'whole-index'` while total active trigger bytes ≤ 1024 (half the 2KB pack), else `'bm25-top3'` — the design §7 default-ranking rule made mechanical.
- CLI: `harness eval-knowledge [--json]` — renders one `ui.line` per arm (`key` = arm, `value` = `hit X% · false Y% · ~N tok`) plus a `recommendation` line. CATALOG entry in the knowledge group.
- `evals/tasks/eval-knowledge/task.mjs`: `meta { id: 'eval-knowledge', kind: 'deterministic', runtime: 'node' }`; `run` materializes `payment-service` (via `evals/lib/fixture.mjs` `materializeFixture`), seeds 6 dated episodes (4 before / 2 after a fixed cutoff) + 2 learnings via a real `consolidate --apply`, runs `evalKnowledge`, returns the result; `grade` passes when `bm25.hitRate >= 0.5 && bm25.falseSurfaceRate === 0 && recommendation` is one of the two values; `fixtures: { pass, fail }` per the runner self-test contract (`evals/lib/runner.mjs:53`).

- [ ] **Step 1: Write the failing test** — hermetic unit test of `evalKnowledge` on a constructed ws/store: 4 train + 2 held-out episodes, 1 relevant learning; assert split counts, `bm25.hitRate === 1`, `wholeIndex.injectedTokens > 0`, `none.hitRate === 0`, false-surface 0 with the bundled negative queries, and the `<4 dated episodes` guard.
- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement** lib + command + eval task + fixture JSON.
- [ ] **Step 4: Tests pass + full suite + `node evals/run.mjs`** (now 14 tasks; the new one must pass its verifier self-test).
- [ ] **Step 5: Commit** — `feat: add deterministic eval-knowledge with temporal split and ranking arms`

---

### Task 12: MEMORY-MODEL, threat model, contract sync, final gate

**Files:**
- Create: `docs/MEMORY-MODEL.md`, `docs/architecture/knowledge-threat-model.md`
- Modify: `packages/harness/README.md` (`### Knowledge (semantic memory)` section: new commands + trust-gradient sentence + eval scope note), `.github/skills/references/harness-tool-contract.md` (catalog rows + JSON shapes for `remember`, `learning`, `learnings`, `knowledge`, `consolidate --rebuild`, `eval-knowledge`; verify `--learnings` attribution; events additions), `packages/harness/test/prompt-library-contracts.test.mjs` (new pins)
- Test: contract suite + full gate

- [ ] **Step 1: Write `docs/MEMORY-MODEL.md`** — one page (design §4/§8): the three tiers table, the learning lifecycle mermaid diagram copied from `docs/brainstorms/2026-07-26-knowledge-layer-design.md` §16 (stateDiagram), derived-not-stored rules (id/domain/evidence counts/promotion eligibility), the human register: exact commands for teach (`remember`), inspect (`learnings [--why]`), veto (`learning retire|dispute|confirm`), kill (`knowledge off|freeze|capture-only`), delete (`knowledge purge`), reset (`consolidate --rebuild --yes`), the hand-editability position (hand-edit auto-commit semantics are Milestone 3 — until then edit via `remember` + `learning`), and the trust-gradient paragraph verbatim from design §1.
- [ ] **Step 2: Write `docs/architecture/knowledge-threat-model.md`** — canonical residual (design §14): declarative deception through the insight lane passes every lint by construction, bounded by the advisory fence + provisional damping + never-promotes + one-command retire; secret scanning is regex-grade screening with the never-pushed store as the real backstop; purge vs git history honesty (`git filter-repo` note); prompt-injection stance: every human surface renders learnings as fenced data-not-instructions after lint; the data-flow diagram (mermaid `flowchart` of T1→candidates→ops→apply→T2→orient, marking trust boundaries at ops validation and the advisory fence).
- [ ] **Step 3: Sync `README.md` + `harness-tool-contract.md`** — command table rows in the existing format (see the consolidate row at `harness-tool-contract.md:78` for the template), JSON shape blocks for the new commands, the note that `learnings`/`eval-knowledge` are read-only (no events) while `remember`/`learning`/`knowledge` write events.
- [ ] **Step 4: Extend `prompt-library-contracts.test.mjs`** — the knowledge-surface test (L553) additionally asserts: `case 'remember':`, `case 'learning':`, `case 'learnings':`, `case 'knowledge':`, `case 'eval-knowledge':` in bin; `--rebuild` in the consolidate sig; `EVENT_TYPES` contains `remember`, `learning`, `knowledge`; `docs/MEMORY-MODEL.md` exists and contains `stateDiagram`.
- [ ] **Step 5: Final gate** — `node --test test/*.test.mjs` all pass; `node evals/run.mjs` all pass; `harness help` renders the knowledge group with all six commands.
- [ ] **Step 6: Commit** — `docs: add memory model and threat model and sync knowledge command contracts`

---

## Self-Review Notes

- Deferred-list coverage: `remember` (T1), `learning retire|dispute` (T2, + `confirm` to complete the disputed→active lifecycle edge), `learnings [--why]` (T3), `knowledge off|freeze|capture-only|purge` (T4), stale-anchor exclusion + prerequisite `anchors:` writing (T5), `consolidate --rebuild` (T6), seed arming (T7), session-start debt drain wiring (T8 CLI + T9 skills), `/consolidate` skill + engineer updates (T9), telemetry SLOs in report (T10), `eval-knowledge` held-out split + whole-index arm (T11), MEMORY-MODEL + threat model (T12).
- Type consistency: `setLearningStatus` and `listingView`/`whyView` both consume `listLearnings` entries (`{ id, domain, slug, file, fm, body, bytes }`); `knowledgeSlos` consumes raw event objects; all mode gates read `readStoreConfig(workspace, { home })`.

## Deferred to Milestone 3 (next plan)

Hand-edit detection with human-teaching episode snapshots (design §4 board condition); `knowledge.commit: repo` opt-in commit mode (§11); `knowledge.mode: suggest` as a first-class config (the `/consolidate` skill's suggest stop-point formalized); `orient --explain` score decomposition (§7); model-graded net-benefit + token-ledger arms of `eval-knowledge` (§12); poison-cluster quarantine **writer** (the ledger `quarantined` reader exists; nothing writes `failures >= 3` yet — §3); at-cap merge flow with `merged_from` enforcement (§9: 25 active per domain); promotion wiring into `/create-primitive` (§10).
