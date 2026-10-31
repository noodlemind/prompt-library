# AE knowledge and distribution architecture research

Research baseline: AE local `8699e9e6c73ad8fae164ded22085ffa53b9df6f1`, PR #104 `34ccbf003f9dd31d3ad8215f9da80e44097dea6a`, pstack v0.15.36 `4dd1d05818d19792e7cd6e818f1667f95f7e1dbe`. This is read-only source research plus disposable real-CLI probes. No project source was changed by this research task.

## Result

Preserve AE's deterministic project-private storage, evidence-bound learning writes, captured index generations, and packaged offline runtime. Do not replace them with pstack's transcript-mining procedures. Adopt the upstream lessons of explicit scope, durable destination ownership, structural enforcement, generated host adapters, and honest unavailable host capabilities. Three additional user-path boundary failures are demonstrated below; fix them in the existing owning functions rather than adding prompt rules or a new memory abstraction.

The highest-leverage change in this area is consistent physical ownership at the I/O boundary: a lexical path or a ledger from a different host must not grant permission to read, overwrite, or retire a file.

## Coverage and source map

The source reads cover capture, recall/ranking, indexing/status, snapshots, consolidation packets and apply governance, selected homes and migration identity, install/hydration, retirement, runtime copying, corpus references, packed release contracts, host qualification, and the corresponding pstack setup/recall/reflect/correct/teach/automate-me plus generated host tree and CI. Most tests were inspected rather than rerun; the root already has a full candidate run. This report does not claim that every branch of every knowledge module was executed.

| Subsystem | AE implementation and contract examined | pstack reference | Decision |
| --- | --- | --- | --- |
| Capture | `lib/compound.mjs:376` selects a current verified plan; authored learning decision publishes through the existing writer. `lib/knowledge/remember.mjs` captures explicit human teachings and records their provenance. | `recall` separates history from current truth; `reflect` routes durable judgments to a reviewed destination. | Keep separate capture and retrieval. Do not auto-promote a recalled fact into authority. |
| Episodic storage | `project-layout.mjs`, `knowledge/store.mjs`, private `projects/<repo-id>/docs/solutions`, and existing global Copilot solutions. | `recall/SKILL.md:18` and `automate-me` restrict transcript reads to the active workspace. | Keep per-project identity and current isolation fix. Treat physical containment as part of that identity; fix manifest read escape below. |
| Recall | `recall-rank.mjs:76` loads effective corpus, `:141` ranks captured entries; `recall-config.mjs:75` resolves per-project postings. Retrieval callers `search`, `lookup`, `tree`, `get`, doctor/admin thread selected home. | `recall/SKILL.md:17-22` scopes first, keeps raw transcripts out of the parent, verifies live state, and has a bounded brief. | Keep deterministic local ranking and bounded output. Do not import the default multi-source agent sweep; activate more expensive investigation only for the actual question. |
| Index coherence | `index-knowledge.mjs:107` serializes rebuilds; existing project snapshot, postings and metadata publication/rollback; `knowledge-manifest.mjs:52` selects global plus current project; `index-status.mjs` reports stale identity. | pstack has no equivalent BM25/private snapshot subsystem. | Keep. This solves an AE requirement pstack does not implement, so copying pstack would remove useful guarantees. |
| Consolidation | `knowledge/packet-ops.mjs:40-68` binds packet/repository/layer/governance/episode and target bytes; `knowledge/apply.mjs` owns semantic-op publication, modes and store transaction. | `reflect/SKILL.md:41-58` separates findings, structural enforcement, and approved edits; `/correct` prefers architecture, types/lint, behavioral tests, then docs. | Keep semantic judgment outside deterministic apply. Keep suggest/freeze/capture-only gates and standing human decisions. Do not create a second automatic skill writer. |
| Learning behavior | `knowledge/retrieve.mjs`, `layer.mjs`, `overlay.mjs` distinguish advisory/inference, branch-local decisions and active standing. `auto-compound` gates on actual passed evidence. | `/correct` does not assume repeating a prose instruction enforces it. | Keep advisory memory distinct from current product proof. Use actual recurrence evidence to propose structural fixes; do not add another always-loaded instruction for these I/O defects. |
| Promotion | `auto-skill-draft`, `knowledge/promote.mjs`, `create-primitive` and capability registry treat proposals as dormant until approval/merge. | `reflect` and `automate-me` route approved edits through the owning creator, never mutate plugin cache. | Keep existing owner. Preserve shipped corpus versus personal customization versus generated hydration as distinct destinations. |
| Store migration | `knowledge/store.mjs` canonicalizes origin/local primary worktree identity and scans only bounded matching legacy stores; admin migration preserves sources/conflicts. | pstack has transcript path mapping per host, not AE's long-lived store identity. | Keep migration explicit and conservative. No new global memory DB or universal user store is justified by this comparison. |
| Install/upgrade | `commands.mjs:144-228`, `sync.mjs`, `install-harness-bin.mjs`, `global-bin.mjs`, `lock.mjs`. Prior fixes address custom home, owned stale runtime leaves and corpus/runtime/shim symlinks. | Host-native plugin installs plus generated Claude Code tree; immutable plugin cache versus editable user/workspace skill copy. | Keep offline runtime because AE supplies deterministic CLI controls. Correct target-specific ownership ledger and lock publication; do not infer ownership from a different host. |
| Host mapping | `paths.mjs`, corpus reference resolver, copied hooks, VS Code bridge, IntelliJ instruction merge. | `docs/harness/claude-code.md` explicitly maps tool/model/path differences and names unsupported features. Generator checks mapping coverage and links. | Adapt explicit capability/mapping tables. Do not claim Copilot, IntelliJ, Cursor and Codex parity because the same Markdown installs. |
| Packaging and release | `package.json` pins bundled runtime dependencies; Node >=20; release validator; offline local/global packed install tests; Windows CI on PR #104. | `scripts/generate-pstack-harness-trees.mjs` derives generated copies and checks drift, tool mapping and links; workflow runs the generator check and skill-script tests. | Keep one authored corpus plus generated/hydrated artifacts. Add changed boundary regressions to existing suites, not a new installer abstraction. |
| Native qualification | `eval/host/README.md` already distinguishes installed real-host trial, cancellation, stale intent, actual reviewer invocation, independent acceptance and manual interventions from model-free tests. | pstack's guide also requires real app proof rather than only unit tests. | Run the existing protocol when the host exists. In this cloud Linux workspace it is unavailable; do not script a model reply or fake activation to turn qualification green. |

## Confirmed defect K1: manifest symlink defeats workspace-private provenance

Evidence: `lib/recall-rank.mjs:76-99` uses `existsSync`, `statSync`, and `readFileSync` for the Copilot and workspace manifest candidates. It follows both leaf and ancestor symlinks. Line 94 sets `workspaceBound` by lexical candidate path. `lib/knowledge-manifest.mjs:62-63` intentionally accepts legacy unbound private rows when `workspaceBound` is true.

Real CLI probe on two temporary Git repositories:

1. Repo A has `knowledge/manifest.yaml` as a symlink to a manifest under repo B.
2. B's legacy manifest declares a `scope: product` row with no repository binding. This is the supported contained legacy shape, not a new invented format.
3. Run `ae recall SensitiveMeridianProject --workspace A --copilot-home <empty fixture home> --ae-home <fixture state> --json`.
4. Current CLI exits 0 and returns B's title, summary and snippet as A's product recall.

Observed output includes `scope: product`, `title: SensitiveMeridianProject`, and `summary: SensitiveMeridianProject secret roadmap`. No B source document is needed: the metadata is already exposed.

Root cause: lexical location was promoted into provenance before physical containment was established. The existing repository snapshot isolation fix is useful but does not close this legacy input path.

Minimal repair: use the existing bounded no-follow/contained read helper with the actual home/workspace root before accepting a manifest. Refuse leaf and ancestor escape, special files and oversized/unreadable inputs with explicit diagnostics. Continue supporting ordinary contained legacy workspace manifests; do not remove that compatibility to make the test pass. Use one captured read, not stat then unconstrained read.

Acceptance:

- Actual CLI recall/search never includes title/summary/snippet from a symlinked external manifest.
- Both workspace and selected-home manifest candidates reject leaf and ancestor escapes.
- Contained legacy workspace private rows still work, and captured current project snapshots keep their current semantics.
- Missing manifests retain the documented empty behavior; a present invalid/unsafe manifest is distinguishable from missing.
- Existing source-reference, stale-postings, isolation and same-captured-generation tests continue to pass.

## Confirmed defect D1: install lock symlink overwrites outside the selected home

Evidence: `lib/lock.mjs:16-21` writes `.harness-lock.json` through direct `fs.writeFileSync`. `commands.mjs:228` does this after corpus/runtime publication. The preceding target preflight covers shim/runtime/corpus destinations, not this final metadata destination.

Real CLI probe:

1. Selected Copilot home has `.harness-lock.json` as a symlink to a sibling sentinel JSON.
2. Run `ae install --target cli --copilot-home <fixture home> --ae-home <fixture state> --json`.
3. Current CLI exits 0; sentinel is replaced with the AE ownership ledger; symlink remains.

Minimal repair: preflight every selected home's lock destination before any managed install mutation, validate existing lock input as a regular contained record, then publish through the existing contained atomic writer. Avoid a new locking framework. A read-only diagnostic may still report an invalid lock; destructive retirement must not treat unreadable ownership as permission.

Acceptance:

- Lock leaf/ancestor symlink refuses install/upgrade and preserves the outside sentinel.
- Rejection occurs before corpus/runtime/retirement changes, including a selected second target with an unsafe lock.
- A regular lock still upgrades, dry-run writes nothing, and preservation of custom user files continues.
- Explicitly corrupted ownership metadata is not silently overwritten into a successful ownership claim.

## Confirmed defect D2: one host's ledger can retire another host's user files

Evidence: `commands.mjs:149` reads only the Copilot home's lock. Line 189 passes it to `applyRetired` for IntelliJ. Lines 200-223 union relative files across targets into one ledger. Line 228 writes that ledger only to the Copilot home. IntelliJ has no own deletion-authority ledger.

Real CLI probe:

1. Copilot lock has `targets: [vscode]` and owns `prompts/personal.prompt.md` from a prior release.
2. A fresh IntelliJ home has unrelated personal content at that same relative path, never owned by AE there.
3. Run `ae upgrade --target intellij` with both fixture homes selected.
4. CLI exits 0, deletes the unowned IntelliJ file, and writes no IntelliJ lock.

Minimal repair: bind each target home's relative ownership list to that home and use it only there. Write each selected target's actual ledger. Shared VS Code/CLI home may share one ledger because it is one physical root. Preserve each target's previously owned unselected artifacts conservatively when doing a target-only upgrade. Do not let a legacy aggregate ledger authorize destructive cleanup in a different home; use conservative migration/rehydration and explain any retained stale file instead of deleting an unproven owner.

Acceptance:

- An IntelliJ-only first install/upgrade never deletes a personal file because a Copilot lock names the same relative path.
- A previously IntelliJ-owned retired file can be retired using the IntelliJ ledger.
- VS Code-only, CLI-only, IntelliJ-only and combined installs produce correct per-home ownership; selected home roots may be equal only with explicitly handled collision semantics.
- A later upgrade of one target retains enough ownership information for another previously installed target in the same physical home.
- Global CLI runtime/shim retirement remains owner-bound; unrelated current files remain untouched.

The three probes are retained as `research/probe-knowledge-packaging.mjs`; initial results are in `research/knowledge-packaging-probe-results.json`. Run the script against the candidate to observe actual CLI behavior. It mutates only temporary owned fixture paths and deletes them afterward. The project source tree remains unchanged.

## What the pstack history contributes

- `e46364b` / PR #135 introduced explicit-invoke recall with a pinned topic/workspace/time window, live-state checking, and a narrow final capsule. This supports scoped retrieval, not automatic cross-project context capture.
- `00b14f1` / PR #538 removed more prompt text than it added (406 additions/736 deletions across 36 files). The lesson is to avoid importing broad prose and default agent swarms when AE already owns deterministic ranking and writes.
- `7054003` / PR #800 fixed edits disappearing because reflect wrote into plugin cache. Its initial proposed fix could publish an unsolicited public PR, and the final correction keeps approved edits in explicit local destinations and never pushes. The transferable rule is destination ownership and separation of local learning from public publication, not that AE should copy pstack's cache layout.
- `scripts/generate-pstack-harness-trees.mjs:19-25, 116-175` makes one source tree and checks rendered host adapter coverage, package links, content and executable-mode drift. AE already has one source corpus and package checks; extend those rather than maintaining a second host-authored workflow fork.
- `.github/workflows/validate-plugins.yml:22-35` runs Node 22 structural validation, generated-copy checks and skill-script tests. This source evidence does not qualify AE's Node 20, Windows, or IntelliJ behavior.

## Execution sequence for the integrated plan

1. Keep prior failing-before/passing-after fixes; preserve their independent regressions.
2. Add the manifest physical-provenance CLI regression first, observe it fail, repair `loadManifest` with existing safe I/O, then run recall/search/isolation/source-evidence tests.
3. Add install lock escape/preflight regressions first, observe the sentinel overwrite/current partial-write behavior, then repair lock input/publication at the owning install boundary.
4. Add cross-host retirement/preservation regressions first, observe personal-file deletion, then split ownership ledgers by actual target home with conservative legacy behavior.
5. Run installation/reference/upgrade/bundle suites and packed offline tests once; run Node 20 focused checks. The final root qualification should include the existing Windows workflow after publication, with unavailable cloud/native checks explicit.

No new memory DB, agent, skill, automatic repair loop, installer coordinator, or cloud service is justified by this research.

## Limits

- This was source/contract research plus three actual CLI reproductions. It is not a vulnerability-advisory audit of every bundled third-party dependency.
- No actual Copilot or IntelliJ desktop session was available. Installation tests and CLI-hook tests must not be called native model-quality evidence.
- pstack's existing safeguards and prose are references, not evidence that pstack has a higher task-success rate than AE.
- Project-private memory, source evidence, and ownership ledgers are user-local integrity contracts. They do not protect against an actor who can arbitrarily replace the user's AE state and matching metadata.
