# Harness Quality and Token Optimization Plan

**Status:** Industry research finalized — ready for phased implementation approval  
**Audience:** Platform / DevEx, harness maintainers, `@engineer` owners  
**Related:** [`tool-native-harness-design.md`](tool-native-harness-design.md), [`engineer-memory-system.md`](engineer-memory-system.md), [`context-budget.md`](../../.github/skills/references/context-budget.md), [`harness-tool-contract.md`](../../.github/skills/references/harness-tool-contract.md)

---

## 1. Executive summary

Teams report two costly failure modes:

1. **Whole-file rewrites** — agents debug briefly, then replace entire files instead of minimal patches (wasted tokens, review noise, regressions).
2. **Context hunger** — agents re-read the repo every session because there is no cheap, deterministic “map” of the codebase unless someone runs an LLM-heavy `/codebase-context` skill.

This plan defines a **four-pillar program** that complements (does not duplicate) GitHub Copilot’s built-in workspace semantic index and Chronicle:

| Pillar | Goal | Primary delivery |
|--------|------|------------------|
| **A. Surgical edit program** | Debug → localize → minimal patch | Prompt contract + plan fields + optional `harness gate` diff advisory |
| **B. Deterministic codebase map** | Markdown/symbol outline without LLM at init | `harness snapshot` (new CLI) + optional Repomix bridge |
| **C. Token & interaction budget** | Fewer turns, smaller context | Extend existing context-pack / recall; document host caching |
| **D. Host alignment** | Don’t fight Copilot | Use `#codebase` when indexed; harness for workflow + team memory |

**Principle:** Canonical truth stays in **git** (`docs/plans/`, solutions). Derived indexes are **rebuildable**. Agents use **tools + small files**, not chat dumps.

---

## 2. Problem statement

### 2.1 Surgical edits

| Symptom | Cost |
|---------|------|
| Agent rewrites 400-line file for a null-check fix | High input/output tokens |
| Reviewers see unrelated style/refactor churn | Time, trust |
| Tests pass but behavior drift in untouched areas | Quality risk |

**Root causes:**

- Model path of least resistance (`editFiles` whole file).
- `@engineer` autopilot emphasizes gates/plans, not **edit granularity**.
- Rules exist in `/work-on-task` and `code-implementer` but are **not enforced** on the default engineer path.
- No machine check on diff size vs plan scope.

### 2.2 Codebase context

| Symptom | Cost |
|---------|------|
| Agent lists directories repeatedly | Extra tool calls |
| User expects `harness index` to index plans | Confusion (`index` = solutions only) |
| `/codebase-context` requires LLM for diagrams | Tokens + variance; not run at init |

### 2.3 Interaction budget

| Symptom | Cost |
|---------|------|
| Full terminal output pasted into chat | Token burn |
| Multiple orient/gate cycles without progress | Turn tax |
| Re-explaining capture gate every session | Prompt bloat |

---

## 3. Industry research and synthesis

This section records **external** industry practice (May 2026), then maps it to harness decisions. Full phased design remains in §§5–10; **build vs document vs defer** is in §3.6.

### 3.0 External industry research

#### 3.0.1 Surgical edits and edit formats

| Source | Finding | Harness implication |
|--------|---------|---------------------|
| **[Aider edit formats](https://aider.chat/docs/more/edit-formats.html)** | `whole` returns entire files (simple, costly); `diff` / `udiff` return only changed regions; models differ in reliability by format | Host `editFiles` is whole-file by default — **policy + delegation** must compensate; we cannot assume diff-format tools |
| **[Aider architect mode](https://aider.chat/docs/usage/modes.html)** | Architect model proposes *what* to change; editor model applies *how* (editor-diff / editor-whole) | Aligns with **engineer → code-implementer** split; strengthen handoff with symbol/line scope |
| **[Aider unified diffs](https://aider.chat/docs/unified-diffs.html)** | Udiff reduced “lazy” incomplete edits vs SEARCH/REPLACE on GPT-4 Turbo benchmarks | Prefer **evidence-before-edit** and scoped delegation over betting on one host edit transport |
| **[mini-SWE-agent](https://github.com/SWE-agent/mini-swe-agent)** | Default path uses **bash/sed** for edits — minimal scaffold, brittle multi-line edits | Do not copy sed-only editing; document why harness uses host editor + surgical policy |
| **[mini-swe-agent-plus](https://github.com/Kwai-Klear/mini-swe-agent-plus)** | Adds **single-match string replacement** tool → fewer rounds, closer to SWE-agent on benchmarks | Optional future MCP — **defer**; harness does not own edit transport today |
| **[Intent-based editing](https://dev.to/youssefmejdi/why-file-editing-is-the-hardest-part-of-building-a-coding-agent-24k8)** | Too many edit transports confuses models; converge on read / replace_string / symbol edit | Keep **one host edit surface**; encode intent in plan `## Edit Scope` + implementer brief |
| **[surgical-dev](https://github.com/sniperwolf/surgical-dev)** | Minimal change surface, no drive-by refactors | Encode in `surgical-edit-policy.md` (Phase 1) |
| **IDE agent norms (Cursor, Copilot rules)** | Cap scope, forbid unrelated files, prefer bounded reads | Match **200 LOC** read-before-edit threshold in engineer checklist |

**Industry consensus:** Separate **planning/judgment** from **application of edits**, with **bounded change descriptions**, instead of relying on the model to choose minimal whole-file writes.

#### 3.0.2 Context budget, instruction limits, and context rot

| Source | Finding | Harness implication |
|--------|---------|---------------------|
| **[Chroma: Context rot](https://www.trychroma.com/research/context-rot)** (18 frontier models) | Quality degrades as input length grows, often sharply, below max context | Budget **always-loaded** instructions (AGENTS.md, copilot-instructions, thin engineer body) |
| **[Claude Code memory](https://code.claude.com/docs/en/memory)** | Target **under 200 lines** per project memory file; auto-memory capped at 200 lines / 25KB | Align `docs/agent-context.md` + root **AGENTS.md** as short maps |
| **[CLAUDE.md best practices](https://dev.to/nishilbhave/claudemd-best-practices-the-complete-2026-guide-435j)** | ~150–200 reliable instructions; long files → adherence drop | **Progressive disclosure** via skill references (existing pattern) |
| **[GitHub: Token efficiency in agentic workflows](https://github.blog/ai-and-ml/github-copilot/improving-token-efficiency-in-github-agentic-workflows/)** | Prune unused MCP tools; pre-fetch with **`gh` CLI**; `token-usage.jsonl`; Effective Tokens (ET) | **Document** for CI; keep harness CLI tools minimal; no unused MCP in templates |
| **MCP gateway / filtering** | Full tool catalogs can cost 10k+ tokens per turn | Allowlist MCP tools in product repos |

**Industry consensus:** **Small stable entry context** + **just-in-time retrieval** beats monolithic repo dumps.

#### 3.0.3 Deterministic codebase maps vs host semantic index

| Source | Finding | Harness implication |
|--------|---------|---------------------|
| **[VS Code workspace context](https://code.visualstudio.com/docs/copilot/reference/workspace-context)** | Workspace **embedding index** + semantic search | **Do not rebuild** in npm; document host-first search |
| **[Repomix](https://github.com/yamadashy/repomix)** | Deterministic MD/XML pack; token count; gitignore-aware | Optional `harness snapshot --via repomix` (Phase 4) |
| **[Gitingest](https://github.com/cyclotruc/gitingest)** | Python repo digest | Document only; no dependency |
| **Symbol/index MCP ecosystems** | Offline graphs for large monorepos | Phase 5 enterprise spike |
| **`/codebase-context` skill** | LLM + Mermaid narrative | On-demand human-reviewed snapshot, not init default |

**Industry consensus:** **Structural map (deterministic)** + **semantic search (host)** + **narrative (LLM on demand)**.

#### 3.0.4 Onboarding without repo docs (AGENTS.md)

| Source | Finding | Harness implication |
|--------|---------|---------------------|
| **[agents.md](https://agents.md/)** | Cross-tool agent README: commands, tests, boundaries | `init-repo` + snapshot should reinforce root **AGENTS.md** / `docs/agent-context.md` |
| **[AgentPatterns AGENTS.md](https://agentpatterns.ai/standards/agents-md/)** | ~100 lines pointing to `docs/` | Same as our AGENTS.md / CLAUDE.md guidance |
| **[Anthropic: Effective harnesses](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents)** | Artifacts bridge sessions; separate generation from evaluation | Plans, solutions, gates — continue as primary harness value |

### 3.1 Microsoft / GitHub Copilot (host-native)

| Capability | What it does | Harness stance |
|------------|--------------|----------------|
| **Workspace semantic index** | Embeddings + background index; agents use semantic search automatically ([VS Code workspace context](https://code.visualstudio.com/docs/copilot/reference/workspace-context)) | **Do not rebuild** for VS Code users with index ready |
| **`#codebase`** | Meaning-based code search | Document: prefer host search before reading huge files |
| **Grep / usages / read** | Exact + symbol navigation | Engineer investigate phase should prefer these before edit |
| **Chronicle** (`/chronicle`, `github.copilot.chat.localIndex.enabled`) | Personal **chat session** SQLite index; standups, tips | **Complementary** — personal history vs team plans/solutions ([GitHub docs](https://docs.github.com/en/copilot/concepts/agents/copilot-cli/chronicle)) |
| **Prompt caching / deferred tools** | Host reduces repeated instruction tokens | Harness cannot control; document in onboarding |

**Conclusion:** Harness optimizes **team workflow memory** (plans, solutions, gates). Copilot optimizes **workspace search** and **personal session recall**. Avoid duplicating Copilot’s embedding index in npm.

### 3.2 Deterministic “codebase → markdown” tools (no LLM)

| Tool | Mechanism | Fit for harness |
|------|-----------|-----------------|
| **[Repomix](https://github.com/yamadashy/repomix)** | Pack repo to single MD/XML; gitignore-aware; token count; optional Tree-sitter compress | **Optional peer** — `harness snapshot --via repomix` or document integration |
| **[Gitingest](https://github.com/cyclotruc/gitingest)** | Python; digest for LLM prompts | Alternative for Python-heavy teams |
| **Tree-sitter / LSP** | AST outlines, symbols | Phase 2 — `harness snapshot --symbols` for allowlisted langs |
| **codeagent-indexing-engine** | Local SQLite symbol graph + MCP | Future — heavy; enterprise optional |

**Conclusion:** Add a **first-party deterministic snapshot** (structure + manifests + README + bounded file excerpts). Optional Repomix for “full pack” when teams want it. Keep **`/codebase-context`** as the **LLM narrative + Mermaid** path on demand.

### 3.3 Surgical edit patterns (industry)

| Pattern | Source | Our adoption |
|---------|--------|--------------|
| TDD red-green-refactor | Universal | Already `/tdd-fix`, `code-implementer` |
| Impacted-files allowlist | Our plans | Strengthen with **line/symbol** scope |
| Diff-size review | Human review bots | `harness gate` advisory + review check |
| Delegate implementer | Our architecture | Engineer must delegate scoped patches |
| RTK / terminal compactors | [rtk-ai](https://github.com/rtk-ai/rtk) etc. | **Document optional** — compress logs, not edits |

### 3.4 What we already have (gaps highlighted)

| Asset | Surgical edits | Deterministic map | Token budget |
|-------|----------------|-------------------|--------------|
| `copilot-instructions.md` | “Surgical diffs” stated | — | — |
| `/work-on-task` | Strong | — | Plan slices |
| `code-implementer` | Strong | — | — |
| `@engineer` autopilot | **Weak explicit edit policy** | — | orient + context-pack |
| `harness index` | — | Solutions only | BM25 top-k |
| `/codebase-context` | — | **LLM required** | Large output |
| `init-repo` | — | Stub only | — |
| `context-budget.md` | — | — | Strong theory, partial enforcement |

---

### 3.6 Recommendations matrix (build · document · defer)

| Recommendation | Action | Phase | Rationale (evidence) |
|----------------|--------|-------|----------------------|
| `surgical-edit-policy.md` + engineer wiring | **Build** | 1 | Aider architect/editor; weak host whole-file edits |
| Plan `## Edit Scope` + `edit_strategy` / `max_lines_changed` | **Build** | 1 | SWE-bench scaffolds use explicit scope |
| `harness gate` diff advisories (E1–E3) | **Build** | 3 | Industry diff-size review; non-blocking advisory |
| Code review check `surgical-edit.md` | **Build** | 3 | Human + agent review alignment |
| `harness snapshot` deterministic map | **Build** | 2 | Repomix/Gitingest pattern without LLM at init |
| `init-repo --snapshot` + orient cites map | **Build** | 2 | Cold-start / IntelliJ / offline |
| Chronicle vs Harness in CLI guide | **Document** | 1 | GitHub Chronicle = personal; harness = team workflow |
| Host semantic index first; no harness embeddings | **Document** | 1 | VS Code workspace context |
| AGENTS.md ~100 lines + pointers to `docs/` | **Document** | 1 | agents.md standard; Chroma context rot |
| MCP tool pruning + `gh` pre-fetch for CI agents | **Document** | 1 | GitHub agentic workflows blog (May 2026) |
| Context rot / &lt;200 line instruction files | **Document** | 1 | Chroma 2025; Claude Code memory docs |
| `context-budget.md` enforcement in engineer | **Build** (extend) | 1–2 | Existing reference; partial today |
| `harness snapshot --via repomix` | **Defer** | 4 | Optional peer; not required for MVP |
| Symbol tree-sitter index / MCP graph | **Defer** | 5 | Heavy; enterprise-only candidate |
| `replace_string` edit MCP in harness | **Defer** | — | Host owns edits; mini-swe-agent-plus pattern |
| Index `docs/plans` in BM25 manifest | **Defer** | RFC §12 | Conflate workflow vs solutions |
| Full Copilot embedding index in npm | **Do not build** | — | Host-native capability |
| LLM at every `init-repo` | **Do not build** | — | Cost/variance; use `/codebase-context` optionally |
| Auto-delete repo solutions when global exists | **Do not build** | — | Data loss risk |

**Finalized priority order:** Phase 1 (policy + docs) → Phase 2 (snapshot CLI) → Phase 3 (gate + review) → Phase 4–5 (optional integrations). Phase 1 is **approval-ready** without npm release.

---

## 4. Design principles

1. **Debug before edit** — Hypothesis + evidence (test output, `problems`, `usages`) recorded before `editFiles`.
2. **Smallest verifiable patch** — Prefer hunks; whole-file rewrite requires justification in plan Activity.
3. **Separate maps from narratives** — Deterministic snapshot (structure) vs LLM snapshot (architecture story).
4. **Don’t duplicate the host** — If Copilot index is ready, harness points agents at search tools; snapshot is fallback.
5. **Rebuildable derivatives** — `.harness/codebase-map.md` may be gitignored; `docs/codebase-snapshot.md` is human-reviewed optional.
6. **Measure** — Log lines changed, files touched, turns to verify in plan Activity.

---

## 5. Pillar A — Surgical Edit Program

### A.1 New reference: `surgical-edit-policy.md`

Location: `.github/skills/references/surgical-edit-policy.md`

**Contents (normative):**

- Investigate checklist: `problems` → `usages` → read **function/class range** only.
- **Edit rules:** max scope per task; forbid drive-by format/refactor; whole-file replace only if plan says so or >30% lines change.
- **Delegation:** engineer → `code-implementer` with `files`, `symbols`, `line-range`, `do-not-touch`.
- **Bug route:** prefer `/tdd-fix` or `bug-reproduction-validator` before implement.
- **Reporting:** Activity line format: `fix: <path>:<lines> — <root cause one-liner>`.

Wire into: `engineer.agent.md`, `engineer-principles.md`, `work-on-task`, `tdd-fix`, `code-implementer`, `harness-tool-contract.md`.

### A.2 Engineer autopilot updates

Add to `@engineer` table (before implement):

| Step | Action |
|------|--------|
| **2a** | State **root-cause hypothesis** (1–2 sentences) in plan Activity or session |
| **2b** | List **evidence** (test name, stack frame, symbol) |
| **4** | **Edit policy:** minimal patch; if file >200 LOC, cite line range in Activity before edit |
| **4d** | Optional: delegate `code-implementer` when >2 files or fix is localized |

### A.3 Plan schema extensions (`/plan-issue`, template)

New optional sections / frontmatter:

```yaml
edit_strategy: patch|refactor|new-file
max_lines_changed: 50
root_cause: ""
```

```markdown
## Edit Scope

- **Strategy:** patch (default)
- **Files and symbols:**
  - `src/foo.ts` — `handleRequest()` approx. L42–68 only
- **Out of scope:** formatting, renaming unrelated symbols
```

`harness gate` (phase implement): warn if `edit_strategy: patch` and plan has no symbol/line hints for large files (advisory).

### A.4 Harness CLI: `harness gate` diff advisory (Phase A4)

**New checks (advisory in `balanced`, stricter in `strict` profile):**

| Id | Check |
|----|--------|
| E1 | `git diff --stat` vs `max_lines_changed` if set |
| E2 | Files edited ⊆ `## Impacted Files` |
| E3 | Single-file diff >40% lines changed without `edit_strategy: refactor` → warn |

Requires git repo; skip with `--no-git` flag.

**Does not block host `editFiles`** — returns exit `2` (warn) per harness exit code convention.

### A.5 Code review check

Add bundled check: `surgical-edit.md` under `code-review/references/checks/` — flag whole-file replacements, unrelated hunks.

### A.6 Success metrics

- Median lines changed per bugfix task ↓
- % sessions with Activity root-cause line ↑
- Review findings on “unrelated churn” ↓

---

## 6. Pillar B — Deterministic Codebase Map

### B.1 Two products (do not merge)

| Product | Producer | LLM? | Output | When |
|---------|----------|------|--------|------|
| **Codebase map** | `harness snapshot` | **No** | `.harness/codebase-map.md` (default gitignored) or `docs/codebase-map.md` | `init-repo`, CI, on demand |
| **Codebase snapshot** | `/codebase-context` | **Yes** | `docs/codebase-snapshot.md` + Mermaid | Major restructure, onboarding doc |

### B.2 `harness snapshot` specification (new command)

```bash
harness snapshot [--workspace .] [--out .harness/codebase-map.md]
                   [--max-files 200] [--max-bytes-per-file 8000]
                   [--include "src/**"] [--via repomix]
```

**Deterministic inputs (no LLM):**

1. **Tree** — depth-limited directory tree (respect `.gitignore`, `.cursorignore`, harness ignore list).
2. **Manifests** — parse `package.json`, `pom.xml`, `pyproject.toml`, `go.mod`, `*.csproj` (best-effort) → stack summary table.
3. **Entry points** — heuristics: `main.*`, `index.*`, `Application.java`, `routes/`, `Dockerfile`.
4. **README excerpt** — first N lines of root README.
5. **Test commands** — from manifests scripts (`test`, `verify`).
6. **Existing repo context** — if present, link `docs/agent-context.md`, count `docs/plans/*.md` (titles only from frontmatter).
7. **Token estimate** — byte count / 4 rough estimate per section.

**Optional `--via repomix`:** shell out to `repomix` if on PATH; write to `.harness/repomix-pack.md` (gitignored); map references it, does not inline 500k tokens into agent default read.

**Default output path:** `.harness/codebase-map.md` (add to `.harness/.gitignore` in `init-repo`).

**Why not only Repomix:** enterprise may not allow extra binary; need bounded default; harness controls schema for `orient` to cite.

### B.3 `init-repo` integration

```bash
harness init-repo [--snapshot] [--snapshot-out path]
```

| Flag | Behavior |
|------|----------|
| Default | Current behavior (plans, agent-context stub, `.harness/`) |
| `--snapshot` | Also run `harness snapshot` after scaffold |
| `--snapshot-commit` | Write `docs/codebase-map.md` for teams that want map in git (small repos only) |

Onboarding text: “Copilot indexes your workspace automatically in VS Code; this map helps IntelliJ, air-gapped, or cold-start agents.”

### B.4 `orient` integration (Phase B3)

Context-pack adds one line:

```markdown
## Codebase map
- `.harness/codebase-map.md` (generated YYYY-MM-DD; run `harness snapshot` to refresh)
```

Agent reads map **instead of** listing root directory when map exists and age <7 days.

### B.5 Microsoft semantic index — alignment doc

Add section to `harness getting-started` / guide:

- If status bar shows index ready → use natural language search; **do not** paste full Repomix output into chat.
- Run `harness snapshot` when index unavailable (new clone, IntelliJ-only, offline).

### B.6 Success metrics

- Directory-listing tool calls per orient session ↓
- Time-to-first-correct-file in engineer sessions ↓ (survey)

---

## 7. Pillar C — Token and Interaction Optimization

### C.1 Already implemented (maintain)

| Mechanism | Location |
|-----------|----------|
| Context pack ≤2 KB | `context-pack.mjs` |
| Recall top-3 | `recall-rank.mjs` |
| `harness get --max-bytes` | `get-cmd.mjs` |
| Events omit query text | `events.mjs` |
| `--json` for agents | harness contract |
| Memory card caps | `context-budget.md` |

### C.2 New / enhanced

| Item | Description |
|------|-------------|
| **Terminal policy** | Reference doc: agents use `terminalLastCommand` + summarize; optional RTK for humans in README |
| **Deferred reads** | Engineer: read plan sections by heading, not full plan |
| **Snapshot staleness** | `harness doctor` warns if codebase-map >30 days |
| **Index scope message** | Already added for 0 entries — keep |
| **Compound before re-index** | Avoid redundant `harness index` in same turn as compound |

### C.3 Copilot pricing / caching (documentation only)

Harness cannot set host cache. Document for teams:

- Keep **global instructions** stable (hydrate once).
- Keep **engineer.agent.md** thin; details in references loaded on demand.
- Avoid pasting **Repomix full pack** into chat (use map + search).
- Pin harness version in CI for reproducible gates.

### C.4 Interaction reduction

| Technique | Implementation |
|-----------|----------------|
| Batch delegations | Already coordinator batches 3–4 |
| Single orient per turn | Engineer checklist — no double orient |
| Gate before edit | Already required |
| `harness recall` vs re-investigate | Recall first if symptom known |

---

## 8. Pillar D — Archival and deduplication (clarify, don’t overbuild)

**Current state:** No automatic archival. Plans and solutions can coexist at repo + global levels by design.

**Recommendations (policy, Phase D1):**

| Learning type | Canonical home | Repo copy? |
|---------------|----------------|------------|
| Cross-team verified fix | `~/.copilot/knowledge/solutions/` | Link only in `docs/agent-context.md` |
| Repo-specific | `docs/solutions/` | Yes |
| Active work | `docs/plans/` | Yes |
| Stale plans | `docs/plans/archive/` (convention) | Manual move |

**Optional Phase D2:** `harness archive-plans --older-than 90d --dry-run` — move `status: done` plans to archive; **no** auto-delete solutions.

**Do not** auto-delete repo `docs/solutions` when global copy exists without human review.

---

## 9. Who invokes harness commands?

| Actor | Commands | Notes |
|-------|----------|-------|
| **Human** | `setup`, `getting-started`, `doctor`, `init-repo`, `snapshot` | Onboarding |
| **`@engineer`** | `orient`, `gate`, `compound`, `recall`, `get` | `--json`; read context-pack |
| **Skills** | `/index-memory` → `index`; `/auto-compound` | Documented contracts |
| **CI** | `gate`, `validate-plan` | Pin version |
| **Not default** | Humans running `orient`/`gate` | Unless debugging |

Surgical-edit and snapshot rules target **agent behavior** first; humans benefit from clearer CLI messages.

---

## 10. Implementation roadmap

### Phase 1 — Quick wins (prompt library only)

- [ ] Add `surgical-edit-policy.md` and wire to engineer, work-on-task, code-implementer, principles
- [ ] Extend plan template with `## Edit Scope` + frontmatter fields
- [ ] Update `index-memory` / getting-started (index vs plans vs snapshot) — partial done
- [ ] Document Chronicle vs Harness in guide (partial done)

**Deliverable:** Behavior change without npm release (hydrate skills).

### Phase 2 — Harness CLI v0.5.x

- [ ] `harness snapshot` (deterministic tree + manifests + README)
- [ ] `init-repo --snapshot`
- [ ] Update `.harness/.gitignore` for `codebase-map.md`, `repomix-pack.md`
- [ ] `orient` cites map when fresh
- [ ] `doctor` checks map staleness

**Deliverable:** npm publish + docs.

### Phase 3 — Gates and review

- [ ] `harness gate` E1–E3 diff advisory (git required)
- [ ] Code review check `surgical-edit.md`
- [ ] `autonomy: strict` treats E warnings as failures

### Phase 4 — Optional integrations

- [ ] `harness snapshot --via repomix`
- [ ] Symbol outline (TypeScript/Java) via tree-sitter — spike only
- [ ] `harness archive-plans` — if teams request

### Phase 5 — Research spikes (time-boxed)

- [ ] RTK: document in enterprise DevEx guide, not bundle in harness
- [ ] Evaluate codeagent-indexing-engine MCP for enterprises needing offline symbol graph
- [ ] Copilot “deferred tools” — re-test when VS Code version pinned in runbook

---

## 11. What we will NOT build

| Idea | Why not |
|------|---------|
| Full Copilot embedding index in harness | Host does this better in VS Code |
| LLM at `init-repo` by default | Cost, variance; keep `/codebase-context` optional |
| Auto-delete repo plans/solutions | Data loss risk |
| Block `editFiles` from CLI | Host owns edit tool; gate advises only |
| Replace `docs/plans` with manifest index | Plans are workflow state, not search index (optional future `kind: plan` is separate RFC) |
| Mandatory Repomix dependency | Optional bridge only |

---

## 12. RFC: Index plans in manifest? (future, optional)

If teams want `harness index` to include plans:

- Add `kind: plan` entries from `docs/plans/*.md` frontmatter (title, status, tags) — **no full body** in manifest.
- Keep BM25 on solutions separate collection.
- `recall --collection plans` vs `solutions`.

**Defer** until Phase 1–3 surgical edits prove value; avoids conflating workflow files with compounded knowledge.

---

## 13. Success criteria (program level)

| Metric | Target |
|--------|--------|
| Engineer sessions with documented root cause before edit | >80% on trackable tasks |
| Median diff lines per bugfix | ↓ 50% vs baseline (measure 2 sprints) |
| Whole-file rewrite review findings | ↓ 70% |
| Agents read context-pack vs full CLI stdout | Qualitative audit pass |
| `harness snapshot` adoption | >50% product repos after init-repo |
| User confusion on `index 0 entries` | ↓ support tickets (docs + CLI message) |

---

## 14. References

### Host and GitHub

- [VS Code: How Copilot understands your workspace](https://code.visualstudio.com/docs/copilot/reference/workspace-context)
- [GitHub: Indexing repositories for Copilot](https://docs.github.com/copilot/concepts/indexing-repositories-for-copilot-chat)
- [GitHub: Copilot CLI Chronicle](https://docs.github.com/en/copilot/concepts/agents/copilot-cli/chronicle)
- [GitHub Blog: Improving token efficiency in GitHub Agentic Workflows](https://github.blog/ai-and-ml/github-copilot/improving-token-efficiency-in-github-agentic-workflows/) (May 2026)

### Surgical edits and coding agents

- [Aider: Edit formats](https://aider.chat/docs/more/edit-formats.html)
- [Aider: Architect mode](https://aider.chat/docs/usage/modes.html)
- [Aider: Unified diffs](https://aider.chat/docs/unified-diffs.html)
- [mini-SWE-agent](https://github.com/SWE-agent/mini-swe-agent)
- [mini-swe-agent-plus](https://github.com/Kwai-Klear/mini-swe-agent-plus)
- [Why file editing is the hardest part of building a coding agent](https://dev.to/youssefmejdi/why-file-editing-is-the-hardest-part-of-building-a-coding-agent-24k8)
- [surgical-dev](https://github.com/sniperwolf/surgical-dev)

### Context, memory, and standards

- [Chroma: Context rot research](https://www.trychroma.com/research/context-rot)
- [Claude Code: Memory and CLAUDE.md](https://code.claude.com/docs/en/memory)
- [agents.md specification](https://agents.md/)
- [AgentPatterns: AGENTS.md standard](https://agentpatterns.ai/standards/agents-md/)
- [Anthropic: Effective harnesses for long-running agents](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents)

### Deterministic repo packing

- [Repomix](https://github.com/yamadashy/repomix)
- [Gitingest](https://github.com/cyclotruc/gitingest)

### Internal

- `docs/architecture/tool-native-harness-design.md`
- `.github/skills/references/context-budget.md`
- `.github/skills/references/harness-tool-contract.md`

---

## 15. Trackable plan

Implementation tracking: [`docs/plans/2026-05-29-feat-harness-quality-token-optimization-plan.md`](../plans/2026-05-29-feat-harness-quality-token-optimization-plan.md)
