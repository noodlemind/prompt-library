# Knowledge Layer Milestone 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the knowledge-layer foundations from `docs/brainstorms/2026-07-26-knowledge-layer-design.md`: two-lane compound (`--insight`), committed codebase map, the local knowledge store, `harness consolidate` (status/candidates/apply), and learnings surfaced in orient — on branch `feat/knowledge-layer` atop PR #36.

**Architecture:** All model-free mechanics live in `packages/harness/lib/` modules called by thin command handlers in `lib/commands.mjs`, rendered through `lib/style.mjs` (ledger grammar, `--json` parity). The learnings store is a CLI-managed local git repo at `$HARNESS_HOME/knowledge/<repo-id>/` (HARNESS_HOME env override makes tests hermetic). The consolidation skill (model half) is Milestone 2; this milestone ships the deterministic contract it will call.

**Tech Stack:** Node ESM (`.mjs`), `node:test`, no new dependencies (git via spawnSync; yaml already a dep).

## Global Constraints

- Every new command surface renders through `createStyle` (`ui.line`, `errorBlock`, muted `→` next-hints); `--json` output is one compact JSON object.
- Exit codes from `EXIT` registry only (0 ok / 1 fail / 2 warn / 64 usage — read `lib/style.mjs` EXIT for exact values).
- No new npm dependencies. No model calls anywhere in the CLI.
- Learning byte cap: **1,200 bytes** per file. Ops per apply run: **≤5**. Debt threshold: **≥5** unconsolidated episodes. Injection: **top-3** learnings in orient pack.
- Slugs: lowercase, NFC-normalized, `[a-z0-9-]` only.
- `last_confirmed` clamped ≤ today.
- Run the full suite after every task: `node --test test/*.test.mjs` from `packages/harness/` (started at 234/234 on the base branch; also `node evals/run.mjs` before final push if present).
- Commit messages: `feat:`/`fix:`/`docs:` prefix, no co-author/tool references.
- Doc-sync rule: new/changed commands must update `bin/harness.mjs` CATALOG and `packages/harness/README.md`.

---

### Task 1: Secret scan library

**Files:**
- Create: `packages/harness/lib/secret-scan.mjs`
- Test: `packages/harness/test/secret-scan.test.mjs`

**Interfaces:**
- Produces: `scanSecrets(text) → [{ id, line }]` — array empty when clean. IDs: `aws-access-key`, `github-token`, `private-key`, `jwt`, `connection-string`, `bearer-token`, `slack-token`, `generic-api-key`.

- [ ] **Step 1: Write the failing test** (`test/secret-scan.test.mjs`)

```js
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { scanSecrets } from '../lib/secret-scan.mjs';

test('scanSecrets flags common credential shapes with line numbers', () => {
  const text = ['title: ok', 'key=AKIAIOSFODNN7EXAMPLE', 'token: ghp_' + 'a'.repeat(36)].join('\n');
  const hits = scanSecrets(text);
  assert.equal(hits.length, 2);
  assert.deepEqual(hits.map((h) => h.id).sort(), ['aws-access-key', 'github-token']);
  assert.equal(hits.find((h) => h.id === 'aws-access-key').line, 2);
});

test('scanSecrets passes clean markdown', () => {
  assert.deepEqual(scanSecrets('# Fix\n\nUse two-step backfill for NOT NULL columns.'), []);
});

test('scanSecrets flags PEM, JWT, connection strings, bearer and slack tokens', () => {
  const samples = [
    ['-----BEGIN RSA PRIVATE KEY-----', 'private-key'],
    ['eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcDEF123_-', 'jwt'],
    ['postgres://user:s3cret@db.internal:5432/app', 'connection-string'],
    ['Authorization: Bearer abcdef1234567890abcdef', 'bearer-token'],
    ['xox' + 'b-1234567890' + '12-abcdefghijklmnop', 'slack-token'],
  ];
  for (const [sample, id] of samples) {
    assert.equal(scanSecrets(sample)[0]?.id, id, `expected ${id} for: ${sample}`);
  }
});
```

- [ ] **Step 2: Run to verify failure** — `node --test test/secret-scan.test.mjs` → FAIL (module not found).

- [ ] **Step 3: Implement** (`lib/secret-scan.mjs`)

```js
// Best-effort credential screening for knowledge capture and learning writes.
// Regex-grade by design (documented as screening, not prevention).
const PATTERNS = [
  { id: 'aws-access-key', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { id: 'github-token', re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b|\bgithub_pat_[A-Za-z0-9_]{22,}\b/ },
  { id: 'private-key', re: /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/ },
  { id: 'jwt', re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}\b/ },
  { id: 'connection-string', re: /\b\w+:\/\/[^\s:@/]+:[^\s@/]+@[^\s/]+/ },
  { id: 'bearer-token', re: /\bBearer\s+[A-Za-z0-9._~+/-]{16,}\b/i },
  { id: 'slack-token', re: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/ },
  { id: 'generic-api-key', re: /\b(?:api[_-]?key|secret[_-]?key|access[_-]?token)\s*[=:]\s*["']?[A-Za-z0-9_\-/+]{20,}["']?/i },
];

export function scanSecrets(text) {
  const hits = [];
  const lines = String(text || '').split('\n');
  for (let i = 0; i < lines.length; i++) {
    for (const { id, re } of PATTERNS) {
      if (re.test(lines[i])) hits.push({ id, line: i + 1 });
    }
  }
  return hits;
}
```

- [ ] **Step 4: Run to verify pass**, then run the full suite.
- [ ] **Step 5: Commit** — `feat: add secret scan library for knowledge capture`

---

### Task 2: Two-lane compound — `compound --insight`

**Files:**
- Modify: `packages/harness/lib/flags.mjs` (new flags), `packages/harness/lib/compound.mjs` (insight lane), `packages/harness/lib/commands.mjs` (`cmdCompound` rendering), `packages/harness/bin/harness.mjs` (CATALOG entry for compound options)
- Test: `packages/harness/test/insight-compound.test.mjs`

**Interfaces:**
- Consumes: `scanSecrets(text)` from Task 1.
- Produces: `runInsightCompound({ workspace, copilotHome, flags, log }) → { pass, exitCode, kind: 'insight', path, indexed, blockedReason, nextTools }` exported from `lib/compound.mjs`. Flags added: `insight` (bool), `title`, `category` (default `insights`), `tags`, `trigger`, `claim`, `body`, `bodyFile`.
- Written doc frontmatter keys: `title`, `kind: insight`, `date`, `tags`, `trigger`, `claim` (trigger/claim optional).

- [ ] **Step 1: Failing test** (`test/insight-compound.test.mjs`) — uses the runHarness/tempDir pattern from `test/harness-cli.test.mjs`:

```js
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const binPath = path.join(packageRoot, 'bin', 'harness.mjs');
const tempDir = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const run = (args, env = {}) =>
  spawnSync(process.execPath, [binPath, ...args], { encoding: 'utf8', env: { ...process.env, ...env } });

test('compound --insight writes a kind: insight doc without any plan or evidence', () => {
  const ws = tempDir('insight-ws-');
  const home = tempDir('insight-home-');
  const res = run([
    'compound', '--insight', '--title', 'Orders pool exhaustion under bulk load',
    '--category', 'debugging', '--tags', 'orders,timeout',
    '--body', 'Connection pool exhausts under N+1 on /orders/bulk. Suspect missing batch fetch.',
    '--workspace', ws, '--copilot-home', home, '--json',
  ]);
  assert.equal(res.status, 0, res.stderr);
  const out = JSON.parse(res.stdout);
  assert.equal(out.kind, 'insight');
  const doc = fs.readFileSync(path.join(ws, out.path), 'utf8');
  assert.match(doc, /kind: insight/);
  assert.match(doc, /title: "Orders pool exhaustion under bulk load"/);
});

test('compound --insight refuses to write when the body contains a secret', () => {
  const ws = tempDir('insight-sec-');
  const res = run([
    'compound', '--insight', '--title', 'leak', '--body', 'key=AKIAIOSFODNN7EXAMPLE',
    '--workspace', ws, '--copilot-home', tempDir('insight-sech-'), '--json',
  ]);
  assert.equal(res.status, 1);
  assert.match(res.stdout + res.stderr, /secret/i);
  assert.ok(!fs.existsSync(path.join(ws, 'docs', 'solutions')));
});

test('compound --insight requires --title and body', () => {
  const res = run(['compound', '--insight', '--workspace', tempDir('insight-req-'), '--json']);
  assert.notEqual(res.status, 0);
});
```

- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement.** In `lib/flags.mjs` add to the defaults object: `insight: false, title: null, category: null, tags: null, trigger: null, claim: null, body: null, bodyFile: null` and parser branches (same two-arm pattern as `--plan`): `--insight` (bool), `--title`, `--category`, `--tags`, `--trigger`, `--claim`, `--body`, `--body-file` → `bodyFile`. In `lib/compound.mjs` add:

```js
import { scanSecrets } from './secret-scan.mjs';

function slugify(text) {
  return String(text).toLowerCase().normalize('NFC')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'insight';
}

function yamlQuote(v) {
  return `"${String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

export function runInsightCompound({ workspace, copilotHome, flags, log = () => {} }) {
  const body = flags.body || (flags.bodyFile ? fs.readFileSync(path.resolve(flags.bodyFile), 'utf8') : '');
  if (!flags.title || !body.trim()) {
    return { pass: false, exitCode: 2, kind: 'insight', path: null, indexed: null,
      blockedReason: 'insight capture needs --title and --body (or --body-file)',
      nextTools: ['harness compound --insight --title "..." --body "..."'] };
  }
  const date = new Date().toISOString().slice(0, 10);
  const category = flags.category || 'insights';
  const rel = path.join('docs', 'solutions', category, `${date}-${slugify(flags.title)}.md`);
  const fmLines = [`title: ${yamlQuote(flags.title)}`, 'kind: insight', `date: ${date}`];
  if (flags.tags) fmLines.push(`tags: ${flags.tags}`);
  if (flags.trigger) fmLines.push(`trigger: ${yamlQuote(flags.trigger)}`);
  if (flags.claim) fmLines.push(`claim: ${yamlQuote(flags.claim)}`);
  const doc = `---\n${fmLines.join('\n')}\n---\n\n${body.trim()}\n`;
  const secrets = scanSecrets(doc);
  if (secrets.length) {
    return { pass: false, exitCode: 1, kind: 'insight', path: null, indexed: null,
      blockedReason: `secret-shaped content blocked capture: ${secrets.map((s) => `${s.id}@${s.line}`).join(', ')}`,
      nextTools: ['redact the credential and re-run'] };
  }
  const full = path.join(workspace, rel);
  if (!flags.dryRun) {
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, doc, 'utf8');
  }
  log(`wrote ${rel}`);
  const knowledgeRoot = fs.existsSync(path.join(copilotHome, 'knowledge'))
    ? path.join(copilotHome, 'knowledge') : null;
  const indexed = runIndexKnowledge({ knowledgeRoot, workspace, copilotHome, flags, log });
  return { pass: true, exitCode: 0, kind: 'insight', path: rel.split(path.sep).join('/'), indexed,
    blockedReason: null, nextTools: ['harness consolidate --status'] };
}
```

  In `runCompound` first line: `if (flags.insight) return runInsightCompound({ workspace, copilotHome, flags, log });`. In `cmdCompound` (commands.mjs) render the insight result: on pass `ui.line({ state: 'ok', key: 'insight', value: result.path, note: `indexed ${result.indexed?.entries ?? 0} entries` })`; failures reuse the existing error line. In `bin/harness.mjs` CATALOG, extend the `compound` entry: sig `'[--plan <path>] [--insight --title "..." --body "..."]'` and options rows for `--insight`, `--title <t>`, `--category <c>`, `--tags <a,b>`, `--trigger <t>`, `--claim <t>`, `--body <text>`, `--body-file <path>`.
- [ ] **Step 4: Tests pass + full suite.**
- [ ] **Step 5: Commit** — `feat: add two-lane compound with evidence-free insight capture`

---

### Task 3: Kind-aware manifest, ranking penalty, and labels

**Files:**
- Modify: `packages/harness/lib/index-knowledge.mjs` (carry `kind`/`trigger`/`claim` from frontmatter), `packages/harness/lib/recall-rank.mjs` (insight penalty), `packages/harness/lib/context-pack.mjs` (insight label), `packages/harness/lib/commands.mjs` (`cmdRecall` label)
- Test: `packages/harness/test/insight-ranking.test.mjs`

**Interfaces:**
- Manifest entries gain: `kind: solution|insight` (from `fm.kind`, default `solution`), `trigger`, `claim` (when present in frontmatter — also emitted to manifest so postings index them).
- `rankRecall` results: `score *= 0.7` when `entry.kind === 'insight'` (applied before minScore filter and sorting so verified fixes outrank insights at equal relevance).
- Context pack + `cmdRecall` line render `[insight]` label after the title for insight entries.

- [ ] **Step 1: Failing test** — build a workspace with two docs of equal text, one `kind: insight`; run `harness index` then `harness recall` (`--json`); assert the solution doc scores higher and the insight entry carries `kind: 'insight'`; assert non-JSON recall output contains `[insight]`.

```js
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const binPath = path.join(packageRoot, 'bin', 'harness.mjs');
const tempDir = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const run = (args) => spawnSync(process.execPath, [binPath, ...args], { encoding: 'utf8' });

function writeDoc(ws, name, kind) {
  const dir = path.join(ws, 'docs', 'solutions', 'debugging');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name),
    `---\ntitle: "orders timeout pool exhaustion"\n${kind ? `kind: ${kind}\n` : ''}date: 2026-07-01\n---\n\n## Problem\n\norders timeout pool exhaustion under load.\n`);
}

test('insight entries rank below equal-content solutions and are labeled', () => {
  const ws = tempDir('rank-ws-');
  const home = tempDir('rank-home-');
  writeDoc(ws, 'verified-fix.md', null);
  writeDoc(ws, 'hunch.md', 'insight');
  assert.equal(run(['index', '--workspace', ws, '--copilot-home', home]).status, 0);
  const json = JSON.parse(run(['recall', 'orders timeout pool', '--workspace', ws, '--copilot-home', home, '--json']).stdout);
  const insight = json.recall.find((e) => e.kind === 'insight');
  const solution = json.recall.find((e) => e.kind !== 'insight');
  assert.ok(insight && solution, JSON.stringify(json.recall));
  assert.ok(solution.score > insight.score);
  const plain = run(['recall', 'orders timeout pool', '--workspace', ws, '--copilot-home', home]).stdout;
  assert.match(plain, /\[insight\]/);
});
```

- [ ] **Step 2: Verify failure.** — insight entry will currently have `kind: 'solution'` and no penalty.
- [ ] **Step 3: Implement.** `index-knowledge.mjs` `collectSolutions`: `kind: fm.kind === 'insight' ? 'insight' : 'solution'`, add `trigger: fm.trigger || ''`, `claim: fm.claim || ''`; emit `trigger`/`claim` lines in the manifest writer (yamlQuoted, only when non-empty). `recall-rank.mjs`: in both `rankWithBm25` and `rankWithOverlap`, after computing the entry score apply `const kindAdjusted = (entry.kind === 'insight' ? 0.7 : 1) * score;` and use it for the minScore filter and sort; ensure `kind` survives into the returned object. `context-pack.mjs` recall loop: `` const label = r.kind === 'insight' ? ' [insight]' : ''; `` appended after the bolded title. `commands.mjs` `cmdRecall`: append the same label to the rendered title, and pass `kind` through the JSON mapping (check the existing mapping in `cmdRecall` — add `kind: e.kind` beside `scope`). Also pass `kind` through the orient recall mapping in `lib/orient.mjs` (`kind: e.kind`).
- [ ] **Step 4: Tests pass + full suite** (the postings index stores manifest entries — confirm `runBuildPostingsIndex` copies whole entries; if it whitelists fields, add `kind`, `trigger`, `claim`).
- [ ] **Step 5: Commit** — `feat: rank insight knowledge below verified fixes and label both lanes`

---

### Task 4: Committed codebase map

**Files:**
- Modify: `packages/harness/lib/repo-map/index.mjs` (optional `title`/`preamble`), `packages/harness/lib/init-repo.mjs`, `packages/harness/lib/commands.mjs` (`cmdIndex` writes the map), `packages/harness/bin/harness.mjs` (CATALOG note)
- Test: `packages/harness/test/codebase-map.test.mjs`

**Interfaces:**
- `buildRepoMap({ workspace, query: '', maxTokens: 2500, title: 'Codebase Map' })` — new optional `title` param replaces the hard-coded `# Repo Map` heading.
- `writeCodebaseMap({ workspace, dryRun }) → { path: 'docs/codebase-map.md', tokens, files } | null` exported from `lib/repo-map/index.mjs`; content contains no timestamps (stable diffs). Called by `runInitRepo` and `cmdIndex` (after a successful rebuild, never on `--status`).

- [ ] **Step 1: Failing test:** in a temp git repo with two committed `.mjs` files, `harness init-repo` creates `docs/codebase-map.md` starting with `# Codebase Map` and listing the files; running `harness index` after adding a file refreshes it; content has no ISO date; `harness index --status` does NOT touch it (mtime unchanged).
- [ ] **Step 2: Verify failure.**
- [ ] **Step 3: Implement.** In `repo-map/index.mjs`: add `title = 'Repo Map'` param, use `` `# ${title}` ``; export:

```js
export function writeCodebaseMap({ workspace, dryRun = false, maxTokens = 2500 }) {
  const map = buildRepoMap({ workspace, query: '', maxTokens, title: 'Codebase Map' });
  if (map.empty) return null;
  // Strip the query clause and keep content deterministic — this file is committed.
  const rel = path.join('docs', 'codebase-map.md');
  if (!dryRun) {
    fs.mkdirSync(path.join(workspace, 'docs'), { recursive: true });
    fs.writeFileSync(path.join(workspace, rel), map.body + '\n', 'utf8');
  }
  return { path: rel.split(path.sep).join('/'), tokens: map.tokens, files: map.files.length };
}
```

  `init-repo.mjs`: after the checks/policy stubs, call `writeCodebaseMap({ workspace, dryRun: flags.dryRun })`, push `docs/codebase-map.md` to `stats.created`, `log('wrote docs/codebase-map.md (committed orientation map)')` when non-null. `commands.mjs` `cmdIndex`: after `runIndexKnowledge` succeeds (not in the `--status` branch), call `writeCodebaseMap({ workspace, dryRun: flags.dryRun })` and include `codebaseMap` in the JSON result + a muted log line.
- [ ] **Step 4: Tests pass + full suite** (repo-map.test.mjs pins the old `# Repo Map` heading — default param keeps it green).
- [ ] **Step 5: Commit** — `feat: write committed codebase map on init-repo and index`

---

### Task 5: Knowledge store (repo-id, local git repo, ledger)

**Files:**
- Create: `packages/harness/lib/knowledge/store.mjs`
- Test: `packages/harness/test/knowledge-store.test.mjs`

**Interfaces (consumed by Tasks 6–8):**
- `repoId(workspace) → string` — normalized origin remote (`github.com-org-repo`) or `local-<sha256(realpath).slice(0,12)}`.
- `storeDir(workspace) → path` under `harnessGlobalHome()/knowledge/<repoId>` (HARNESS_HOME override → hermetic tests).
- `ensureStore(workspace, { dryRun }) → { dir, created }` — mkdirs `learnings/`, `git init` if needed, seeds `INDEX.md`, touches `consolidated.jsonl`.
- `readLedger(dir) → [{ path, sha256, learning, at }]`, `appendLedger(dir, entries)` (append-only JSONL, torn-tail tolerant: skip unparsable last line).
- `listLearnings(dir) → [{ id, domain, slug, file, fm, body, bytes }]` — `id = "<domain>/<slug>"`; fm parsed from frontmatter (schema, trigger, status, source, superseded_by, last_confirmed, episodes as structured list).
- `commitStore(dir, message) → { committed: boolean }` — `git add -A && git commit` with `user.name=harness user.email=harness@local` config flags; false when tree clean.
- `normalizeSlug(text) → string` (lowercase, NFC, `[a-z0-9-]`).

- [ ] **Step 1: Failing test:** `repoId` returns the same id for ssh/https forms of the same remote and a `local-` id without a remote; `ensureStore` creates a git repo with `learnings/`, `INDEX.md`, `consolidated.jsonl`; ledger round-trips entries and tolerates a torn tail line; `normalizeSlug('NOT NULL Cols!')` → `not-null-cols`. All under `HARNESS_HOME=<tempdir>`.
- [ ] **Step 2: Verify failure.**
- [ ] **Step 3: Implement** — frontmatter parse can reuse the simple `key: value` parser pattern from `index-knowledge.mjs`, plus a structured `episodes:` block parser (`- path:` items with indented `sha256:`, `kind:`, `plan:` lines). Git calls via `spawnSync('git', [...], { cwd: dir })`, failures returned not thrown (store must degrade gracefully when git is absent — `created.git: false`).
- [ ] **Step 4: Tests pass + full suite.**
- [ ] **Step 5: Commit** — `feat: add local knowledge store with repo-id, ledger, and learning parser`

---

### Task 6: `harness consolidate --status` and `--candidates`

**Files:**
- Create: `packages/harness/lib/knowledge/consolidate.mjs`
- Modify: `packages/harness/lib/commands.mjs` (new `cmdConsolidate`), `packages/harness/bin/harness.mjs` (dispatch + CATALOG group `knowledge`), `packages/harness/lib/flags.mjs` (`ops` flag)
- Test: `packages/harness/test/consolidate.test.mjs`

**Interfaces:**
- `consolidateStatus({ workspace, copilotHome }) → { debt, threshold: 5, due, unconsolidated: [{ path, sha256, kind, title }], quarantined: [...], learnings: { active, total }, promotionCandidates: [{ id, verified, plans }] }`. Episodes = solution docs from the same roots as `runIndexKnowledge` (workspace `docs/solutions/` + `<copilotHome>/knowledge/solutions/`); unconsolidated = `(path, sha256)` absent from ledger and not quarantined (quarantine = ledger entries with `learning: null, failures: >=3`). Promotion candidates computed (never stored): learnings whose episode links include ≥3 `kind: fix` entries across ≥2 distinct `plan` values.
- `consolidateCandidates({ workspace, copilotHome }) → { schema: 1, contract: { maxOps: 5, byteCap: 1200, statuses: [...] }, clusters: [{ id, episodes: [{ path, sha256, kind, title, excerpt }] }], learnings: [{ id, trigger, status, bytes, body? }] }` — clusters grouped by category directory + shared tags; `learnings` always includes every active learning's id+trigger; bodies included while total active corpus ≤30KB.
- CLI: `harness consolidate [--status | --candidates | --apply --ops <path>]` — bare `consolidate` = `--status`. Renders one ledger line: `ui.line({ state: due ? 'warn' : 'ok', key: 'consolidate', value: `debt ${debt}/${threshold}`, note, next })`.

- [ ] **Step 1: Failing test:** workspace with 6 solution docs (5 fix + 1 insight) and empty store → `consolidate --status --json` reports `debt: 6, due: true`; after a fake ledger consuming 5 of them, `debt: 1, due: false`. `--candidates --json` returns clusters covering all unconsolidated episodes, each with `sha256`, and a `contract.maxOps === 5`.
- [ ] **Step 2: Verify failure** (unknown command exits 64).
- [ ] **Step 3: Implement** `consolidate.mjs` + `cmdConsolidate` (mode from `argv.includes('--status'|'--candidates'|'--apply')`, JSON parity, `writeEvent({ type: 'consolidate', ... })`) + dispatch case + CATALOG:

```js
{
  group: 'knowledge',
  commands: [
    { name: 'consolidate', desc: 'episode→learning debt, work packet, and validated apply',
      sig: '[--status | --candidates | --apply --ops <path>]',
      options: [
        ['--status', 'debt vs threshold, quarantine, promotion candidates (default)'],
        ['--candidates', 'deterministic work packet for the consolidation skill'],
        ['--apply --ops <path>', 'validate and apply an ops JSON (sole writer)'],
      ] },
  ],
},
```

- [ ] **Step 4: Tests pass + full suite** (help contract tests may pin group lists — update `prompt-library-contracts.test.mjs` expectations if they enumerate CATALOG groups).
- [ ] **Step 5: Commit** — `feat: add consolidate status and candidates with episode ledger debt`

---

### Task 7: `consolidate --apply` — the sole writer

**Files:**
- Create: `packages/harness/lib/knowledge/apply.mjs`
- Modify: `packages/harness/lib/knowledge/consolidate.mjs` (re-export), `packages/harness/lib/commands.mjs` (`cmdConsolidate` apply branch)
- Test: `packages/harness/test/consolidate-apply.test.mjs`

**Interfaces:**
- Ops file schema (the contract the M2 skill will emit):

```json
{ "schema": 1, "ops": [
  { "op": "ADD", "domain": "sql", "slug": "not-null-large-tables",
    "trigger": "adding NOT NULL columns to large/hot tables",
    "body": "Use two-step default+backfill; a direct ALTER takes an exclusive lock.\n\nExample: orders.status backfill 2026-06.",
    "episodes": [{ "path": "docs/solutions/perf/x.md", "sha256": "…", "kind": "fix", "plan": "docs/plans/p.md" }] },
  { "op": "STRENGTHEN", "target": "sql/not-null-large-tables",
    "episodes": [{ "path": "…", "sha256": "…", "kind": "fix", "plan": "…" }] },
  { "op": "SUPERSEDE", "target": "sql/old-claim", "domain": "sql", "slug": "new-claim",
    "trigger": "…", "body": "…", "episodes": [ … ] },
  { "op": "NOOP", "episodes": [{ "path": "…", "sha256": "…" }], "reason": "covered by sql/x" }
] }
```

- `applyOps({ workspace, opsPath, dryRun }) → { applied: [...], rejected: [...], committed, indexPath, exitCode }`. Validation (reject whole run on any failure, exit 1): schema===1; ≤5 file-touching ops; ADD/SUPERSEDE need trigger+body+episodes; targets must exist; slug normalized; per-file byte total ≤1200 (error `E_BYTE_CAP` with `fix: 'split into two claims'`); `scanSecrets` clean; imperative lint — body/trigger containing ` ```sh`/`` ` ``-fenced shell, `curl `/`wget `, or a bare URL is rejected (`E_LINT`) when every linked episode is `kind: insight`. Writes: learning files (`schema: 1`, `status: provisional` on ADD, `source: auto`, structured episodes, `last_confirmed` = min(today, today) clamp helper, `origin: repoId`), SUPERSEDE sets `superseded_by` on target — unless target has ≥3 fix links or `source: human`, in which case target becomes `status: disputed` and the new file is NOT written (returned in `rejected` with reason `disputed-pending-human`). Ledger appended for every episode named in any op (including NOOP — consumed). INDEX.md rebuilt (one line per active learning: `- [<id>] <trigger>`). Lockfile `dir/.lock` via `fs.mkdirSync` (throw `E_LOCKED` if held); released in `finally`. One `commitStore(dir, 'consolidate: <op summaries>')`.

- [ ] **Step 1: Failing tests:** (a) valid ADD ops file → learning exists with `status: provisional`, ledger consumed, INDEX.md lists it, store git log has 1 new commit; (b) 6 ops → exit 1 nothing written; (c) body >1200 bytes → `E_BYTE_CAP`; (d) insight-only ADD containing `curl http://x` → `E_LINT`; (e) STRENGTHEN on missing target → exit 1; (f) SUPERSEDE on a 3-fix-link target → target `disputed`, no new file.
- [ ] **Step 2: Verify failure.**
- [ ] **Step 3: Implement** `apply.mjs` using Task 5 store primitives.
- [ ] **Step 4: Tests pass + full suite.**
- [ ] **Step 5: Commit** — `feat: add consolidate apply as the validated sole writer of learnings`

---

### Task 8: Learnings in orient (top-3, fenced, attributed)

**Files:**
- Create: `packages/harness/lib/knowledge/retrieve.mjs`
- Modify: `packages/harness/lib/orient.mjs`, `packages/harness/lib/context-pack.mjs`
- Test: `packages/harness/test/orient-learnings.test.mjs`

**Interfaces:**
- `rankLearnings({ workspace, query, limit = 3 }) → [{ id, trigger, claimLine, status, advisory }]` — loads store learnings; excludes `superseded_by != null`, `status` retired/disputed; score = token overlap of query vs `trigger + first body line` (reuse `tokenize`), `* 0.5` when `status === 'provisional'`; `advisory: true` when every episode link is `kind: insight`.
- `buildContextPack` gains a `learnings` param rendering after `## Repo map`:

```
## Learnings (memory)
Applied learnings: sql/not-null-large-tables, api/rate-limit-backoff
- [sql/not-null-large-tables] adding NOT NULL columns to large/hot tables → Use two-step default+backfill…
- [api/rate-limit-backoff] [unverified memory — advisory] retrying 429s → …
```

- Orient JSON result gains `learnings: [...]`; `cmdOrient` note appends `· learnings N`.

- [ ] **Step 1: Failing test:** seed a store (via a Task-7 apply run) with one active + one insight-only learning; `harness orient --query "<matching trigger words>" --json` returns them in `learnings`; the context pack file contains `Applied learnings:` and `[unverified memory — advisory]` on the insight one; a retired learning never appears.
- [ ] **Step 2: Verify failure.**
- [ ] **Step 3: Implement** — orient calls `rankLearnings` in a try/catch (advisory: never fail orientation), passes into `buildContextPack`; pack section sits before `## Next tools` in priority order (learnings are high-value).
- [ ] **Step 4: Tests pass + full suite** (context-pack byte-cap test must still pass — section is inside the 2KB cap by construction).
- [ ] **Step 5: Commit** — `feat: surface ranked learnings with attribution and advisory fencing in orient`

---

### Task 9: Doc sync + contract tests + final gate

**Files:**
- Modify: `packages/harness/README.md` (knowledge group section + output grammar rows), `packages/harness/test/prompt-library-contracts.test.mjs` (pin `consolidate` CATALOG row + `compound --insight` option), `.github/skills/references/harness-tool-contract.md` (command catalog: `compound --insight`, `consolidate`, codebase-map note)
- Test: full suite + evals

- [ ] **Step 1:** Add contract test pinning: `harness help` output lists `consolidate` under a `knowledge` group; `harness help compound` lists `--insight`; `harness help consolidate` shows the three modes.
- [ ] **Step 2:** Update README (command table + one “Knowledge” subsection with the trust gradient sentence) and `harness-tool-contract.md` command catalog.
- [ ] **Step 3:** `node --test test/*.test.mjs` → all pass; `node evals/run.mjs` → no regressions (12/13 baseline, one env-gated skip).
- [ ] **Step 4:** Commit — `docs: sync knowledge-layer commands into README and tool contract`

---

## Deferred to Milestone 2 (next plan)

`harness remember` / `learnings [--why]` / `learning retire|dispute` / `knowledge off|freeze|capture-only|purge` / `consolidate --rebuild`; session-start debt drain wiring into skills; `/consolidate` skill asset + engineer skill updates; seed arming in init/upgrade; stale-anchor exclusion at `harness index`; MEMORY-MODEL.md + threat-model docs; `eval-knowledge` with held-out split and whole-index arm; telemetry SLOs (utilization, human-engagement) in `harness report`.
