---
name: codebase-context
description: >
  Generate architecture documentation and LLM context with per-file API inventory
  and import graph. Use when the user wants to document the codebase structure,
  create architecture diagrams, generate context for AI assistants, or understand
  module dependencies and code organization.
---

# Codebase Context Skill

## When to Use
Activate when the user wants to:
- Generate or update architecture documentation
- Create LLM-friendly context files for the codebase
- Understand module dependencies and code organization
- Produce API inventories or import graphs

## User Preferences
Before generating context, resolve the user's Profile:
1. Check for `.github/copilot-preferences.yml` or `.vscode/copilot-preferences.yml` in the workspace.
2. Apply any custom documentation conventions or output format preferences.

## Inputs (optional; defaults in parentheses)
- Depth: `standard` | `deep` | `light` (default: standard)
- Max files to inventory: 300
- Max functions per file: 200

## Policy
- No CLIs or network. Edit files directly; then print a change summary.
- Be concise and DRY (avoid repeating the same info in multiple sections).
- If a section would exceed practical size, summarize patterns and provide 5–10 exemplars.

## Scope
- Focus on source files; skip generated/third-party/build artifacts.
- Exclude: `.git/**`, `**/node_modules/**`, `**/vendor/**`, `**/build/**`, `**/dist/**`, `**/target/**`, `**/.next/**`, `**/.nuxt/**`, `**/.vercel/**`, `**/coverage/**`, `**/__pycache__/**`, `**/.venv/**`, `**/.mypy_cache/**`, `**/.idea/**`, `**/.vscode/**`, `**/*.min.*`, `**/*.map`, `**/*.bundle.*`, `**/*.{png,jpg,jpeg,gif,ico,svg,woff,woff2,ttf,eot,exe,dll,so,dylib}`.

## Steps

1. **Overview / Architecture**
   - Identify modules, layers, and boundaries; note entry points.
   - Produce one ASCII map and one Mermaid flowchart (`flowchart TD`) for high-level data/control flow.
   - Include a `sequenceDiagram` for one critical request path.

2. **Per-directory Snapshot (1–2 lines each)**
   - Purpose, major components, notable risks.

3. **Per-file API Inventory (budgeted)**
   - For each file (up to max), list exported/public functions and important reused helpers.
   - Signature format: `name(param: type, ...): returnType`.
   - For classes: list key methods and constructor params with one-line purposes.
   - If a file exceeds max functions, summarize patterns and show 5–10 exemplars.
   - Mark generated/boilerplate files as such and skip details.

4. **Connections (imports/uses)**
   - Build an adjacency list (normalized module paths, no extensions).
   - Provide a compact ASCII graph and a Mermaid `flowchart TD` of module dependencies.
   - Call out high-fan-in hotspots.

5. **Style, Data, and Risks**
   - Infer code style guide from configs and exemplars.
   - Summarize data formats (schemas, JSON shapes, wire protocols) with file references.
   - List top 5 risks/TODOs (security/perf/maintainability) and coverage gaps.

## Outputs
- Write `docs/architecture.md` with: Overview, ASCII map, Mermaid flow, sequenceDiagram, module/layer narrative.
- Write `docs/llms-context.md` with: Per-directory snapshot, per-file API inventory, connections, style/data, risks/TODOs.
- Keep architecture.md high-level; keep details in llms-context.md to avoid duplication.

## Guardrails
- Do **not** call CLIs or the network.
- Prefer `#selection` or `#file` to seed context; expand to `@workspace` only as needed.
