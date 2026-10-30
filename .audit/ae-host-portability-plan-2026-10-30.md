# AE host portability: implementation plan

Date: October 30, 2026. Owner: AE maintainers. Status: first implementation slice implemented for draft review; later phases remain planned.

## Goal and authorized scope

AE should install as one harness/CLI and let a user configure one or more supported hosts from the same Engineer, skills, specialist criteria and project state. Host configuration must not create a separately maintained Engineer workflow. Each integration must state what it can do and what has actually been qualified.

The user authorized this work with: “Prepare a detailed plan and start implementing this change in a new PR.” That authorizes the shared-contract extraction, necessary generated entry assets, tests, documentation and a new reviewable PR. It does not authorize merging, publishing a package, granting project trust, changing user host configuration or claiming unobserved native behavior.

This file is the committed roadmap and design record. It is not a replacement for the CLI-owned execution plan or its gate, review, verification and completion state.

## Baseline and dependency

- Merged main: `0d44caad145bb3ef8ab9a7cf301ecfa00569615a`.
- Stabilization dependency: open PR [#104](https://github.com/noodlemind/prompt-library/pull/104), inspected at `a89869b2151d804633dd9dfe862ed7c87a24b4b0`.
- The new implementation is stacked on that revision. PR #104 remains independently reviewable; its subsequent changes may require rebasing this work.
- The prior host-portability assessment found that Engineer's normative behavior lives inside a Copilot agent file, while the skill redirects to that agent. Existing host-named wrapper files and short profiles do not establish installed integrations or native denial behavior.
- PR #104 already separates selected-target recovery, canonical `AE_HOME` state and private/shared project authority. Preserve those fixes. Do not restart state or policy migration as part of this extraction.

## Architectural decision

Keep the corpus. Separate behavior from native representation inside it.

| Owner | Responsibility | Does not own |
| --- | --- | --- |
| `corpus/skills/engineer/references/contract.md` | One authored Engineer behavior contract; host-neutral `<skills-root>` addresses | Native tool IDs, agent frontmatter, installer destinations |
| `corpus/skills/engineer/SKILL.md` | Discover and activate that contract with progressive references | A second lifecycle or mandatory Copilot redirect |
| `corpus/hosts/engineer-adapters.json` | Native metadata and skill-root mappings for generated projections | Kernel policy or independently authored behavior |
| `lib/hosts/engineer-exports.mjs` | Deterministic rendering and drift checks | Host execution, authentication or inferred qualifications |
| Existing Harness CLI | Intent, scope, gate, checks, evidence, review records and learning authority | Host model selection or a new agent loop |
| Future host integration | Setup, discovery, native tool/event translation and observed capability reporting | A fork of the Engineer's rules |

The Copilot projection remains inline: preserving behavior does not depend on an additional read of the extracted contract during an existing agent session. Native skill reads, tool declarations, delegation allowlist, handoffs and token budget remain review obligations. The experimental Claude Code projection lives outside `corpus/agents/` so Copilot hydration and primitive inventory do not treat it as another Copilot agent.

Canonical procedures use package-relative references where possible. A native projection can render the selected skill root, but that alone does not remove path assumptions from every supporting procedure. Those remaining dependencies must be audited before an integration is operationally supported.

## First PR: shared Engineer contract and generated exports

### Scope

1. Add tests before the renderer for one canonical behavioral source, exact projections, deterministic regeneration and drift refusal.
2. Extract existing Engineer behavior into the shared contract using `<skills-root>`. Preserve modes, intent-before-mutation, successful implement gate, genuine skill activation, review and verification requirements, consultation responsibility and finding dispositions.
3. Replace the Engineer skill's mandatory redirect with activation of the shared contract. Keep concrete trigger and confusable cases.
4. Render the existing Copilot agent from the contract and native metadata. Preserve current permissions and metadata; do not broaden its tool or specialist authority.
5. Render an experimental Claude Code entry asset with native metadata, outside Copilot's installed agent directory.
6. Provide `scripts/generate-engineer.mjs --write` and `--check`, exposed by `generate:engineer` and `check:engineer`. Integrate drift validation with the package's release check and include required assets in standalone distributions.
7. Update source ownership documentation and record actual validation and limitations in the PR.

### Acceptance criteria

- Copilot's required behavior, native skill-read activation and declared authority survive extraction. Existing prompt budgets continue to apply.
- Generated files match the canonical source plus their native mapping. Changing one generated output causes the check to fail; regeneration restores the expected output.
- The Engineer skill can load the contract without resolving `@engineer` as its behavioral owner.
- The Claude export contains no Copilot tool IDs or Copilot entry syntax as required native configuration. It is explicitly experimental and unqualified.
- Standalone source/package validation can find the canonical source, renderer, generation/check entry and exports without the parent repository or global configuration.
- Existing installation, hook payloads, gate semantics, trust decisions, state locations and primitive counts remain unchanged.

### Exclusions and evidence limits

This PR does not add `ae install --target claude-code`, interactive host selection, automatic Claude setup, specialist/instruction export, Claude hooks, MCP exposure or plugin packaging. It does not establish native activation, model outcomes, isolated review equivalence or uniform mutation denial. Supporting skills still contain Copilot path assumptions. The Claude file is reviewable export material, not a ready operational integration.

No new skill or specialist is added to the capability registry. This is extraction and projection of the existing Engineer contract, not promotion of another capability. The experimental Claude export deliberately omits delegation until role exports and their allowlists are implemented; it does not grant unrestricted Agent authority.

## Follow-on phases

### Phase 2: precise host capabilities and setup ownership

Separate runtime installation from host integration. A generic AE installation must not configure an editor implicitly. A user can choose hosts during setup and add or remove one later while preserving shared state. Make the meaning of `cli` precise with a compatible Copilot CLI alias; do not silently change existing target semantics.

Define an adapter identity from runtime, surface and supported version range. Include OS, trust/settings and configuration fingerprint in observations. VS Code alone is not a runtime identity: Copilot and another provider inside that editor can use different hooks and tool payloads.

Record declared capabilities separately from observations: instruction/skill discovery, workspace binding, reads, edits, execution, delegation, before-action denial, after-action observation, completion controls, session identity and resume. File presence proves configuration only. Unknown native behavior remains unknown. Diagnostics distinguish configured, mechanically tested and native-qualified status without converting one into another.

Setup/upgrade/uninstall must merge only owned configuration, retain unrelated user assets, avoid duplicate hooks and support dry-run. Repair guidance must preserve the selected host and homes. A missing required capability blocks its dependent operation; an optional fallback reports its weaker guarantee.

Exit criterion: a generic install configures no host; selecting one integration changes only its owned files; coexistence and uninstall fixtures preserve the other integration and user-authored settings.

### Phase 3: complete corpus projection and address resolution

Audit the transitive procedures Engineer loads, including planning, architecture, creation, review, learning and error handling. Remove installation-root assumptions through a shared content resolver or explicit native mappings. Do not use prompt search to guess a corpus path. Preserve complete-read evidence and source hashes where activation participates in an existing gate.

Separate specialist judgment criteria from native metadata and translate scoped instruction activation deliberately. Export only required existing primitives; do not expand the ship set or delegation authority merely because another host supports additional tools. Keep model choices host-owned. A host without isolated subagents must report that limitation; serial review criteria are not evidence of independent context.

Exit criterion: representative Answer, Investigate, Review and Deliver tasks can resolve every needed procedure from a selected installation. A missing artifact or ambiguous root fails explicitly. Exported tool and delegation permissions remain no broader than the accepted role.

### Phase 4: qualify two runtimes, then Codex

Use Copilot and Claude Code for the first paired native qualification, then implement Codex mappings against current official runtime documentation. Reuse `packages/ae/eval/host/README.md` and the existing verification recipe rather than adding a separate evaluation framework.

Qualify startup discovery, skill activation, correct workspace binding, accepted plan delivery, forbidden native edit and shell write, out-of-scope edit, failed verification, stale proof, cancellation/resume and truthful completion. Exercise each declared mutation path. Validate actual resulting files and retained evidence, not only a mocked hook response.

Map event payloads, tool effects, deny outputs, errors/timeouts, completion and subagent coverage per runtime. An after-write event cannot prevent an already-completed write. Native tools outside AE mediation remain a documented exclusion unless observed interception covers them. No integration claim implies operating-system confinement.

Exit criterion: each advertised capability has retained native evidence tied to runtime, version, OS and settings. Tests that are unavailable remain a coverage gap rather than being marked passed.

### Phase 5: thin MCP surface and portable packaging

Expose selected existing AE operations through MCP only after their input/output schemas and authority semantics are stable. CLI and MCP call the same implementation. Preserve workspace binding, typed inputs, validation, effects, cancellation, errors and provenance. Do not turn an unrestricted dispatch tool into a shell gateway or duplicate lifecycle state.

Use Agent Skills and AGENTS.md at their appropriate procedure and project-context boundaries. Add Agent Plugins packaging where clients support its skills/MCP format; retain generated native exports elsewhere. Native hooks and agent semantics remain client-specific. A package that validates is not thereby an installed or enforced host integration.

This is distinct from a generic optional-tools broker. Keep external GitHub/Jira/etc. connections native-first and reuse host authentication where sufficient. Do not make remote credential mediation a prerequisite for portability.

Exit criterion: paired CLI/MCP operations produce equivalent accepted effects/errors, package fixtures load the portable assets in supported clients, and unsupported clients have an explicit native path without changing the kernel.

### Phase 6: broader hosts and compatibility maintenance

Add Cursor, additional JetBrains runtimes and other hosts according to demand and observed capabilities. Maintain a versioned compatibility record and rerun native negative controls when hook/tool semantics change. Cloud and local environments receive separate qualification. Do not infer cloud behavior from local editor configuration.

## Storage, migration and compatibility

- Keep shared runtime/corpus authority in the installed AE package or AE-owned root; native host directories hold generated integrations.
- Retain the existing `AE_HOME` project store for private plans, episodes and caches. Preserve source identity, prior migration behavior and rollback records.
- Keep optional deliberate team policy/checks versioned separately from personal host preferences. Existing `.github/harness` configuration remains compatible; renaming that directory is not a prerequisite for behavioral portability.
- Follow PR #104's personal/shared setup ownership. Do not require a product `.gitignore` edit to hide personal AE state, and do not exempt all `.github` files from scope verification.
- Make generated ownership/version explicit before future automatic replacement. Preserve user-authored files and refuse unsafe path redirection. Uninstall cannot remove shared state merely because one host is removed.

## Verification strategy

| Evidence | Current-slice checks | What remains unproved |
| --- | --- | --- |
| Canonical/projection contract | Exact source-to-output parity, metadata preservation, unsupported-host refusal, deterministic regeneration, deliberate output drift | Native host activation or semantic model quality |
| Existing corpus behavior | Prompt contracts, corpus references, actual activation/source-binding regressions, resource validation | Cross-host hook compatibility |
| Distribution | Release validation and standalone archive/source checks include required generator inputs and exports | Installation into a live Claude session |
| Native qualification | Follow-on repeated task and negative-control matrix | Universal enforcement or OS confinement |

Inspect actual named checks before binding them. Run the new focused regressions plus relevant existing contracts and package/release checks. Do not treat an untrusted project or missing host session as approved execution authority. Record a blocked Harness proof separately from direct test results. Retain failures and environmental limits in the PR instead of weakening assertions.

The pivotal assumption is that AE's engineering discipline comes from its shared contract and deterministic state rather than Copilot-specific orchestration. The paired native lifecycle test is the test of that assumption. Initial measurements should include time to first valid task, manual interventions, missing required steps, false completion and scope violations. Small trials guide promotion; they do not establish universal reliability.

## Rollout and rollback

Land the shared-contract extraction independently before widening install targets. Review the new PR against its stacked base; after #104 merges, retarget/rebase and rerun affected checks. Keep the currently generated Copilot behavior inline during the first rollout so an extra activation hop cannot break existing sessions.

If projection or release validation regresses, revert the extraction PR as a unit. It changes no state schema or user configuration, so no state rollback is required. Future installer migrations need their own versioned backups, owned-file inventory, dry-run and restoration proof before release. Do not publish a universal-host claim until the corresponding compatibility evidence exists.

## First-slice implementation evidence

- Direct focused regressions: 93 passed across `prompt-library-contracts`, `corpus-references`, `corpus-reference`, `host-activation` and `corpus-home`. The named prompt-contracts entry includes the four export tests, covering canonical parity, native metadata, unsupported hosts, standalone regeneration, drift and redirected-output refusal.
- Distribution regressions: 9 passed across `release-version` and `package-standalone`, including packing, offline archive installation, package-local validation and repacking without global/editor configuration.
- `npm run check:release`, `npm run check:engineer`, corpus resource validation and `git diff --check` passed. Archive enumeration confirmed that the canonical contract, adapter metadata, renderer, generator and Claude export ship together.
- Independent static review found two corrected issues: remaining native `@engineer` routing in the portable skill and unrestricted Claude delegation. The reviewed Copilot body is byte-identical to the baseline; parsed metadata preserves its tools, delegation allowlist and handoffs. No remaining blocking finding was reported for this slice.
- Authoritative `ae verify` was attempted and did **not** pass. This checkout has no person-approved trust decision, so Harness refused to execute the repo-authored named check. Required bound multi-perspective review coverage also remains outstanding. Independent static review and direct tests are not substitutes for that bound record. Trust was not self-approved, and completion/compounding was not fabricated.
- Native Copilot/Claude sessions, Windows/macOS qualification and model outcomes were not exercised here. The draft should receive trusted-checkout verification and bound review before promotion; the Claude integration still requires the follow-on work above.
