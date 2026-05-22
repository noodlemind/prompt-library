# NPM Harness Distribution Plan

**Status:** Approved naming — **`@dev-kit/harness`**; Nexus manual publish; CLI implementation Phase 1+  
**Package path:** `packages/harness/` in prompt-library  
**Audience:** Platform / DevEx teams packaging the Adaptive Engineer Harness for enterprise  
**Related:** [`harness-quickstart.md`](../onboarding/harness-quickstart.md), [`2026-03-12-feat-global-workspace-sync-and-copilot-cli-compatibility-plan.md`](../plans/2026-03-12-feat-global-workspace-sync-and-copilot-cli-compatibility-plan.md), [`composer-style-autonomous-harness-proposal.md`](composer-style-autonomous-harness-proposal.md)

---

## 1. Executive summary

Today, teams install the harness by cloning **prompt-library** and running a **VS Code PowerShell task** (robocopy → `~/.copilot/`). That works for maintainers but is weak for enterprise rollout: Windows-centric, easy to forget, hard to version, and unrelated to how modern AI-config tools ship (**npx**, **semver upgrades**, **doctor** commands).

**Recommendation:** Publish **`@dev-kit/harness`** to your enterprise npm registry (e.g. **Sonatype Nexus**). Maintainers build assets and **`npm publish`** manually; developers consume via **`npx @dev-kit/harness`**.

1. **Installs** skills, agents, instructions, knowledge skeleton, and enterprise scaffold into Copilot global paths (VS Code + IntelliJ + CLI).
2. **Upgrades** in place with a file manifest (retire removed paths, preserve user `profile.md` and compounded solutions).
3. **Versions** the harness independently from any single product repo.
4. Supports **optional packages** for enterprise overlay and team knowledge.

**Primary UX:**

```bash
npx @dev-kit/harness@latest install
npx @dev-kit/harness doctor
npx @dev-kit/harness upgrade
```

**Registry:** Private Nexus (or equivalent). See [`nexus-registry-setup.md`](../onboarding/nexus-registry-setup.md).

> **Scope note:** The npm scope is **`@dev-kit`** (hyphen). Configure `@dev-kit:registry=...` in `.npmrc` — not `@devkits`.

---

## 2. Industry review (how others distribute AI harnesses)

| Product / pattern | Distribution model | Relevant to us |
|-----------------|-------------------|----------------|
| **[ai-rulez](https://www.npmjs.com/package/ai-rulez)** | `npx ai-rulez init && generate`; single `.ai-rulez/` source → 19+ native outputs; builtins + opt-in domains; remote `includes` from git; semver (v4.x); MCP server | **Closest analog:** one source, many targets, `npx` onboarding, team presets via config |
| **[aicm](https://www.npmjs.com/package/aicm)** (AI Configuration Manager) | `npx aicm install`; translates Cursor `.mdc` to other tools; npm presets for teams | Preset packages per org |
| **[DotAI](https://github.com/bajinzhi/dotai)** | Git-backed repo + `dotai sync` / `dotai status` | Central repo + sync command (like our knowledge/compound flow) |
| **[load-rules](https://github.com/fix2015/load-rules)** | Registry + `npx load-rules install <name>` | Curated rule packs — maps to optional `@org/knowledge` package |
| **[ai-tools](https://github.com/PremierStudio/ai-tools)** | Monorepo CLI, multi-engine (rules, MCP, agents, skills) | Validates splitting **core CLI** vs **content packs** |
| **create-react-app / npm init** | `npx create-*@version` scaffolds project dirs | Maps to `aeh init-repo` for `docs/plans/` + `agent-context.md` |
| **Homebrew / pipx / uv tool** | Global binary install | Optional secondary channel after npm |
| **Copilot CLI plugins** | `/plugin install owner/repo` bundles agents+skills+hooks | **Complementary** second channel — npm still needed for VS Code globals |
| **pre-commit / lefthook** | Pin tool version in repo CI | `aeh validate` in CI for teams that pin harness version in product repos |

### Patterns worth adopting

| Pattern | Source | Our use |
|---------|--------|---------|
| **`npx package@latest install`** | ai-rulez, aicm | Zero global install for first run; pin version in docs for enterprises |
| **Manifest + retire list** | Our existing `.prompt-library-manifest.txt` | `~/.copilot/.harness-lock.json` on upgrade |
| **Doctor / status** | DotAI, 2026-03-12 internal plan | `harness doctor` (= `/harness-doctor` checks in Node) |
| **Separate content packs** | ai-rulez profiles, load-rules registry | `@dev-kit/harness-enterprise`, `@dev-kit/harness-knowledge` |
| **Remote includes (git)** | ai-rulez `includes` | `harness knowledge pull --repo <url>` (alternative to private npm) |
| **Dry-run / `--verbose`** | Sync plan 2026-03-12 | `harness install --dry-run` for IT review |
| **Cross-platform Node** | Sync plan 2026-03-12 | Replace robocopy/PowerShell entirely |

### Patterns to avoid

| Anti-pattern | Why |
|--------------|-----|
| **postinstall script that writes `~/.copilot`** | Surprises users/IT; breaks `npm ci` in unrelated projects |
| **Publishing only from a git clone** | No semver, no upgrade story |
| **One giant private repo copy per developer** | Drift vs npm version; same pain as today |
| **Overwriting `knowledge/solutions/` on upgrade** | Destroys compounded team memory — merge/preserve required |

---

## 3. Current state vs target

### Today

```text
prompt-library (git clone)
    └── VS Code Task: PowerShell + robocopy
            ├── %USERPROFILE%\.copilot\   (VS Code / CLI)
            └── %LOCALAPPDATA%\github-copilot\intellij\   (IntelliJ)
```

| Gap | Impact |
|-----|--------|
| Requires clone + IDE task | High friction for “anybody in enterprise” |
| Windows-first (robocopy) | Linux/macOS CI and cloud agents uneven |
| No semver on installed bits | Teams cannot audit “which harness version?” |
| Knowledge upgrade unclear | Fear of wiping `~/.copilot/knowledge/solutions/` |
| Enterprise overlay manual | No `npx` story for corp Splunk/Terraform pack |

### Target

```text
npm package @dev-kit/harness (versioned tarball)
    └── bin: harness
            ├── install | upgrade | doctor | index | init-repo
            └── copies bundled assets/ → Copilot homes
```

```text
~/.copilot/
├── agents/ skills/ instructions/ prompts/
├── knowledge/          # manifest, profile, solutions (user + team data preserved)
├── enterprise/         # optional; from overlay package or install --enterprise
├── .harness-lock.json  # installed version + file list + retired paths
└── .harness-config.json # targets: vscode, intellij, cli; autonomy default
```

---

## 4. Package architecture

### 4.1 Monorepo layout (recommended)

Keep **prompt-library** as source of truth; **build step** copies primitives into the npm tarball at publish time (no hand-maintained duplicate).

```text
prompt-library/
├── .github/              # authoritative agents, skills, instructions, prompts
├── knowledge/            # templates + starter manifest (solutions grow at runtime)
├── enterprise/           # overlay template
├── scripts/
│   └── index-knowledge.mjs   # moved or wrapped by CLI
├── packages/
│   └── harness/                    # npm name: @dev-kit/harness
│       ├── package.json
│       ├── bin/harness.mjs
│       ├── src/
│       │   ├── cli.ts
│       │   ├── commands/
│       │   │   ├── install.ts
│       │   │   ├── upgrade.ts
│       │   │   ├── doctor.ts
│       │   │   ├── index.ts
│       │   │   └── init-repo.ts
│       │   ├── sync/
│       │   │   ├── engine.ts      # manifest-aware copy
│       │   │   ├── paths.ts       # copilot home resolution
│       │   │   └── retired.ts
│       │   └── assets/            # populated by `npm run build:assets`
│       └── test/
└── docs/architecture/npm-harness-distribution-plan.md
```

**Publish flow:**

```bash
npm run build:assets   # rsync .github → assets/github, knowledge → assets/knowledge, ...
npm version patch
npm publish --access public   # or private registry
```

### 4.2 Package naming and bins (decided)

| Field | Value |
|-------|--------|
| **npm name** | `@dev-kit/harness` |
| **Scope** | `@dev-kit` |
| **CLI binary** | `harness` |
| **Invocation** | `npx @dev-kit/harness install` |
| **Registry** | Enterprise Nexus (manual `npm publish`) |

See `packages/harness/package.json` and [`nexus-registry-setup.md`](../onboarding/nexus-registry-setup.md).

### 4.3 Optional satellite packages

| Package | Contents | When to use |
|---------|----------|-------------|
| **Core** (`@dev-kit/harness`) | All base skills, agents, knowledge templates, internal autopilot skills | Everyone |
| **`@dev-kit/harness-enterprise`** | Splunk/Terraform agents, corp instructions, `capability-registry.enterprise.yaml` | Corp overlay only |
| **`@dev-kit/harness-knowledge`** | Pre-built `solutions/` + `manifest.yaml` (semver team memory) | Platform publishes after compounding milestones |
| **Git release** (alt) | `harness knowledge pull --tag v1.2.0` | Simpler for fast-moving solutions |

**Version coupling:**

```text
@dev-kit/harness-enterprise@2.1.0  →  requires  @dev-kit/harness >= 2.0.0 < 3.0.0
```

Declare in `peerDependencies` and verify in `aeh doctor`.

---

## 5. CLI command design

### 5.1 Core commands (v1)

| Command | Purpose |
|---------|---------|
| **`harness install`** | First-time sync to all configured targets |
| **`harness upgrade`** | Same as install with version bump + retire cleanup |
| **`harness doctor`** | Health checks (replaces `/harness-doctor` file checks + paths) |
| **`harness index`** | Run manifest rebuild (`index-knowledge`) |
| **`harness init-repo`** | Create `docs/plans/`, stub `docs/agent-context.md`, optional `knowledge/` fallback |
| **`harness status`** | Print installed version, paths, last sync time |
| **`harness uninstall`** | Remove only files listed in `.harness-lock.json` (never delete whole `~/.copilot`) |

### 5.2 Flags (install / upgrade)

| Flag | Behavior |
|------|----------|
| `--dry-run` | Print actions only (IT approval) |
| `--target vscode,intellij,cli` | Subset of hosts |
| `--copilot-home <path>` | Override `~/.copilot` |
| `--preserve-knowledge` | Never overwrite `knowledge/solutions/**`, `profile.md` (default **on**) |
| `--enterprise <path\|npm-spec>` | Overlay enterprise pack |
| `--autonomy balanced\|full\|strict` | Seed `profile.md` if missing |
| `--verbose` | Per-file log |

### 5.3 Example enterprise rollout

```bash
# Developer laptop (first time) — after .npmrc maps @dev-kit to Nexus
npx @dev-kit/harness@2.3.0 install --autonomy balanced

# Platform releases new specialists
npx @dev-kit/harness-enterprise@1.4.0 install
npx @dev-kit/harness@2.3.0 upgrade

# Product repo bootstrap
cd ~/services/orders-api
npx @dev-kit/harness init-repo

# CI (optional)
npx @dev-kit/harness@2.3.0 doctor --json
```

---

## 6. Sync engine (replace PowerShell)

Port logic from `.vscode/tasks.json` to Node (aligns with [2026-03-12 sync plan](../plans/2026-03-12-feat-global-workspace-sync-and-copilot-cli-compatibility-plan.md)):

| Concern | Implementation |
|---------|----------------|
| Path resolution | `os.homedir()`, `COPILOT_HOME`, `XDG_CONFIG_HOME` |
| Copy | `fs.cp` recursive (Node 16+) or `fs-extra` |
| Retired assets | Shipped `retired.json` per package version; delete only if in lock manifest |
| File manifest | SHA-256 or size+mtime; store in `.aeh-lock.json` |
| IntelliJ mirror | `%LOCALAPPDATA%/github-copilot/intellij` (Windows), `~/Library/...` (macOS) — table in sync plan |
| VS Code settings | Optional `aeh install --configure-vscode` merges `chat.*FilesLocations` once |
| Atomic writes | `write-file-atomic` for settings / lock files |

**Exit codes:** `0` success, `1` validation failed, `2` partial install (doctor lists fixes).

---

## 7. Versioning and upgrade semantics

### 7.1 Semver rules

| Bump | When |
|------|------|
| **MAJOR** | Removed agents, breaking plan schema, renamed skills |
| **MINOR** | New skills/agents, new enterprise registry fields |
| **PATCH** | Doc-only asset changes, checklist tweaks |

### 7.2 Lock file (`.harness-lock.json`)

```json
{
  "package": "@dev-kit/harness",
  "version": "2.3.0",
  "installedAt": "2026-05-21T12:00:00Z",
  "targets": ["vscode", "intellij"],
  "files": ["agents/engineer.agent.md", "skills/ensure-plan/SKILL.md"],
  "retiredApplied": ["skills/legacy-skill"]
}
```

**Upgrade algorithm:**

1. Read lock + compare to new package `assets/` manifest.
2. Delete paths in `retired.json` that exist in lock (only harness-owned files).
3. Copy new/changed files from tarball.
4. **Never delete** `knowledge/solutions/**` unless `--force-knowledge-reset` (explicit danger flag).
5. Update lock version.

### 7.3 Team knowledge releases

| Model | Pros | Cons |
|-------|------|------|
| **A. Separate npm `@org/harness-knowledge@1.2.0`** | Semver, private registry, `aeh upgrade` pulls both | Publishing overhead |
| **B. Git release artifact** | Fast for platform team; no npm publish per compound | Weaker discovery |
| **C. Stay in main harness package** | Simplest | Bloated package; frequent patches for every solution doc |

**Recommendation:** **A** for enterprises with 50+ solutions; **B** for smaller teams; **C** only for public starter kit (empty `solutions/`).

---

## 8. Relationship to prompt-library repo

| Role | Repo | npm |
|------|------|-----|
| **Authoring** | prompt-library `.github/`, `knowledge/` | — |
| **Consumption** | Product repos: `docs/plans/` only | `npx @dev-kit/harness install` |
| **Compounding** | Still writes `knowledge/solutions/` in library OR team's knowledge package source repo | `harness-knowledge` publish pipeline |

**CI in prompt-library:**

```yaml
on:
  release:
    types: [published]
jobs:
  publish-npm:
    - run: npm run build:assets
    - run: npm publish -w packages/harness   # publishes @dev-kit/harness to Nexus
  attach-enterprise-artifact:
    - run: tar -czf enterprise-overlay.tar.gz enterprise/
```

Deprecate: VS Code hydrate task → thin wrapper calling `npx @dev-kit/harness install` for maintainers who work inside the repo.

---

## 8b. Publishing to Nexus (manual — approved)

Platform team publishes; developers only consume from registry.

| Step | Action |
|------|--------|
| 1 | Set `packages/harness/.npmrc`: `@dev-kit:registry=https://<nexus>/repository/npm-hosted/` |
| 2 | Auth: `NEXUS_NPM_TOKEN` or `npm login` per org policy |
| 3 | `cd packages/harness && npm run build:assets && npm version patch && npm publish` |
| 4 | Announce version; developers run `npx @dev-kit/harness@X.Y.Z upgrade` |

Full runbook: [`nexus-registry-setup.md`](../onboarding/nexus-registry-setup.md).

**Do not commit** tokens or production Nexus URLs with credentials — use env vars and internal wiki for URLs.

---

## 9. Security and enterprise IT

| Topic | Control |
|-------|---------|
| **Supply chain** | Pin `npx @org/pkg@2.3.0` in docs; SBOM in npm; signed publishes on GitHub Actions |
| **Path traversal** | Resolve all paths under `copilotHome`; reject `..` in `--enterprise` |
| **Secrets** | Never bundle secrets; doctor warns if solutions contain `AKIA` patterns |
| **Air-gapped** | Download tarball from Nexus → `harness install --offline --from ./dev-kit-harness-2.3.0.tgz` |
| **Policy** | `--dry-run` output for change-management tickets |

---

## 10. Migration from workspace scripts

| Phase | Action |
|-------|--------|
| **M0** | Document `npx @dev-kit/harness` in quickstart ✓ |
| **M1** | Implement sync in `packages/harness`; parity test vs PowerShell |
| **M2** | `harness doctor` + `harness status`; CI smoke on win/mac/linux |
| **M3** | Default onboarding = npm; VS Code task → `npx @dev-kit/harness install` |
| **M4** | Remove embedded PowerShell from `tasks.json` (or keep 3-line wrapper) |
| **M5** | Private enterprise + knowledge packages |

---

## 11. Implementation roadmap

### Phase 1 — Package skeleton (1 deliverable)

- [x] `packages/harness/package.json` — `@dev-kit/harness`, bin `harness` (stub CLI)
- [ ] `harness install` + `harness doctor` implementation
- [ ] `build:assets` script copying `.github/skills`, `.github/agents`, etc.
- [ ] `aeh install` + `aeh doctor` MVP (citty + picocolors per sync plan)
- [ ] `.aeh-lock.json` manifest

### Phase 2 — Upgrade + retire (1 deliverable)

- [ ] `retired.json` per version in package
- [ ] `aeh upgrade` with `--preserve-knowledge` (default on)
- [ ] `aeh uninstall` (lock-file scoped)

### Phase 3 — Targets + IntelliJ (1 deliverable)

- [ ] `--target vscode,intellij,cli`
- [ ] IntelliJ global-copilot-instructions merge (port from PowerShell)
- [ ] Optional VS Code `settings.json` merge

### Phase 4 — Repo + knowledge (1 deliverable)

- [ ] `aeh init-repo`
- [ ] `aeh index` wrapping `index-knowledge.mjs`
- [ ] `aeh knowledge pull` from git tag OR install `@org/harness-knowledge`

### Phase 5 — Enterprise (1 deliverable)

- [ ] `@org/harness-enterprise` package template
- [ ] `aeh install --enterprise @org/harness-enterprise@x.y.z`
- [ ] `doctor` validates peer versions

### Phase 6 — Deprecate PowerShell (1 deliverable)

- [ ] Update `harness-quickstart.md`, README, AGENTS.md
- [ ] VS Code task calls `npx aeh install`

### Deferred (v2)

- Copilot CLI `/plugin install` bundle wrapping same assets
- `aeh validate` for pre-commit (plan file schema, capture gate)
- Semantic index MCP (`semantic-retrieval-v2.md`)
- Background auto-update notifier

---

## 12. Recommended tech stack (from prior research)

| Concern | Package |
|---------|---------|
| CLI | **citty** (subcommands) or **commander** (if team prefers) |
| Colors | **picocolors** |
| JSONC (VS Code settings) | **jsonc-parser** |
| Atomic write | **write-file-atomic** |
| Tests | **vitest** + **memfs** |
| Copy | Node **`fs.cp`** |

**Total prod deps: ≤5.** No heavy framework.

---

## 13. Decisions for sign-off

| # | Decision | Recommendation |
|---|----------|----------------|
| 1 | Package scope | **`@dev-kit/harness`** on Nexus ✓ |
| 2 | Binary name | **`harness`** ✓ |
| 3 | Knowledge distribution | `@dev-kit/harness-knowledge` when solutions > ~20 docs |
| 4 | Enterprise distribution | `@dev-kit/harness-enterprise` peer package |
| 5 | Preserve solutions on upgrade | **Default yes** — opt-in force reset only |
| 6 | PowerShell task | Deprecate after Phase 6; wrapper until then |
| 7 | First supported OS | Windows + macOS (Linux agent via repo-local `knowledge/` fallback) |
| 8 | Public vs private | Core public MIT; enterprise/knowledge private scoped |

---

## 14. Success criteria

1. New hire runs **`npx @dev-kit/harness install`** and passes **`harness doctor`** without cloning prompt-library.
2. Platform publishes **`@dev-kit/harness@2.4.0`** to Nexus; developers run **`npx @dev-kit/harness@2.4.0 upgrade`**.
3. Compounded solutions survive upgrades unless explicitly reset.
4. IT can review **`harness install --dry-run`** output.
5. Product repos stay free of `.github/agents` copies — only `docs/plans/` (+ optional local knowledge fallback).

---

## 15. Summary

Industry leaders (**ai-rulez**, **aicm**, **DotAI**) treat AI harness distribution as **versioned CLI + optional content packs**, not IDE tasks. Moving to npm standardizes onboarding, upgrades, and enterprise overlays while keeping **prompt-library** as the authoring source. The existing **2026-03-12 sync plan** already specifies the Node sync engine — this plan **productizes** it as a publishable package and adds **semver**, **knowledge/enterprise satellites**, and a clear **migration** from PowerShell hydrate.

**Next step:** implement Phase 1 (`harness install` / `harness doctor` sync engine) in `packages/harness`. Package skeleton and Nexus runbook are in repo.
