# Harness package tests

## Policy (contributors)

1. **Module ownership** — name tests after the module or behavior under test (`growth-report.test.mjs`, `edit-command.test.mjs`), not a reviewer or PR round.
2. **No souvenir files** — do **not** add:
   - `*findings*.test.mjs`
   - `codex-*.test.mjs` / `coderabbit-*.test.mjs`
   - `*-round2*.test.mjs` / `*-round3*.test.mjs`
   - new `*-hardening-roundN*` sequels  

   Put the regression in the owning module file (or a stable domain name like `knowledge-path-safety.test.mjs`).
3. **Helpers once** — use `test/helpers/` for temp dirs, workspace/home, plans, trust, CLI spawn, and store git env. Do not copy-paste another local `tempDir` / `runHarness` / `writePlan`.
4. **Table-driven** over one-off numbered F1/F2 cases when adding edges; short history comments are fine.
5. **Soft size** — prefer under ~400 lines per file after helpers. Design-contract suites may exceed this with a header note.
6. **Coverage over ceremony** — fold then delete; never remove a safety assertion without an equivalent elsewhere.

## Shared helpers

| Module | Exports |
|--------|---------|
| `helpers/temp.mjs` | `tempDir`, `withTemp`, `withTempSync` |
| `helpers/workspace.mjs` | `makeScopes`, `ensureWorkspaceLayout` |
| `helpers/plan.mjs` | `writePlan` |
| `helpers/trust.mjs` | `approveTrust`, `approveProject` |
| `helpers/cli.mjs` | `runHarness`, `valueOf`, `packageRoot`, `binPath` |
| `helpers/store.mjs` | `git`, `storeScopes`, `writeOps`, `TEST_GIT_ENV` |
| `helpers/cli-fixtures.mjs` | versioned plan, checks.yaml, git init, hooks, recall seed helpers |
| `helpers/tty.mjs` | `fakeTty` (TUI render fixtures) |
| `helpers/index.mjs` | re-exports above |

### CLI domain splits (was `harness-cli.test.mjs`)

| File | Domain |
|------|--------|
| `cli-help.test.mjs` | help + HELP_COMMAND_ORDER |
| `cli-plan-gate.test.mjs` | plan parse, gate, scope, validate-plan |
| `cli-evidence-verify.test.mjs` | evidence + verify |
| `cli-events-session.test.mjs` | events / lifecycle ledger |
| `cli-install-upgrade.test.mjs` | install, shim, runner, upgrade, doctor hydration |
| `cli-vscode-hooks.test.mjs` | VS Code settings + host hooks |
| `cli-orient-context.test.mjs` | orient / context-pack |
| `cli-compound-telemetry.test.mjs` | compound + telemetry |
| `cli-recall-index.test.mjs` | index / recall / get |

Import from `./helpers/index.mjs` (or a specific file).

## Layers (scripts land in Phase 4 of the hygiene plan)

| Layer | Rule of thumb | Today |
|-------|----------------|-------|
| unit | pure functions, no disk or spawn | run with full `npm test` |
| contract | design/envelope/registry shape | full suite |
| integration | temp workspace + `runHarness` / git | full suite |

`npm test` always means the full suite (CI default).

## Souvenir inventory (Phase 0 — fold targets)

| File | Lines | Owning module(s) | Decision |
|------|------:|------------------|----------|
| `coderabbit-review-findings.test.mjs` | ~230 | flags, trust, checks, config, bundles | fold |
| `codex-review-findings.test.mjs` | ~159 | trust, controls, config, flags, bash, checks | fold |
| `codex-phase5-findings.test.mjs` | ~525 | sync/retire, agent-loop, journal, providers | fold |
| `knowledge-adversarial-fixes.test.mjs` | ~239 | knowledge store-io / apply / get | fold → path-safety |
| `knowledge-path-safety-round2.test.mjs` | ~169 | get, recall, candidates, sync | fold → path-safety |
| `knowledge-boundary-hardening.test.mjs` | ~586 | promote, absorb, prune, governance | fold → promote/admin |
| `knowledge-recall-hardening.test.mjs` | ~136 | context-pack / recall | fold → recall/pack |
| `knowledge-store-io-hardening.test.mjs` | ~942 | store-io, store lock | keep temporarily; rename later |
| `knowledge-structural-hardening.test.mjs` | ~440 | store learnings, absorb, rollback | fold into store tests |
| `verify-severity-hardening.test.mjs` | ~459 | verify / checks severity | fold → verify module |

**Keep (not souvenirs):** `tui-design.test.mjs` (product design contracts), module-named knowledge tests, gate/verify golden paths.

## Related plan

`docs/plans/2026-08-11-harness-test-hygiene.md`
