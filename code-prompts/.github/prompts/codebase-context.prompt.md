---
mode: 'agent'
description: 'Generate architecture + LLM context with per-file API inventory and import graph (DRY, repo-agnostic)'
---

# Inputs (optional; defaults in parentheses)
- Depth: ${input:depth:'standard|deep|light'} (standard)
- Max files to inventory (300)
- Max functions per file (200)

# Policy
- No CLIs or network. Edit files directly; then print a change summary (paths + actions).
- Be concise and **DRY** (avoid repeating the same info in multiple sections).
- If a section would exceed practical size, summarize patterns and provide 5–10 exemplars.

# Scope
- Focus on source files; skip generated/third-party/build artifacts.
- Exclude globs: `.git/**`, `**/node_modules/**`, `**/vendor/**`, `**/build/**`, `**/dist/**`, `**/target/**`, `**/.next/**`, `**/.nuxt/**`, `**/.vercel/**`, `**/coverage/**`, `**/__pycache__/**`, `**/.venv/**`, `**/.mypy_cache/**`, `**/.idea/**`, `**/.vscode/**`, `**/*.min.*`, `**/*.map`, `**/*.bundle.*`, binaries/images.
- Prefer typical source extensions: `ts,tsx,js,jsx,mjs,cjs,py,go,rs,java,kt,scala,rb,php,cs,c,cpp,h,hpp`.

# Method
1) **Overview / Architecture**  
   - Identify modules, layers, and boundaries; note entry points.  
   - Produce one **ASCII map** and one **Mermaid flowchart** (`flowchart TD`) illustrating high-level data/control flow.  
   - Include a **sequenceDiagram** for one critical request path.

2) **Per-directory snapshot (1–2 lines each)**  
   - Purpose, major components, notable risks.

3) **Per-file API inventory (budgeted)**  
   - For each file (up to “Max files”), list exported/public functions and important reused helpers.  
   - Signature format: ``name(param: type, ...): returnType`` (infer from annotations/types if present; else `unknown`).  
   - For classes: list key methods and ctor params with one‑line purposes.  
   - If a file has > “Max functions per file”, summarize patterns and show exemplars (5–10).  
   - Mark obviously generated/boilerplate files as such and skip details.

4) **Connections (imports/uses)**  
   - Build an adjacency list (normalized module paths, no extensions).  
   - Provide a compact ASCII graph; add a **Mermaid** `flowchart TD` of module dependencies.  
   - If feasible, call out high‑fan‑in hotspots.

5) **Style, Data & Risks**  
   - Infer **code style guide** from configs (`package.json`, `.eslintrc*`, `.editorconfig`, `pyproject.toml`, `ruff`, `black`, `go.mod`, etc.) and exemplars.  
   - Summarize **data formats** (schemas, JSON shapes, wire protocols) with file references.  
   - List top 5 **risks/TODOs** (security/perf/maintainability) and obvious coverage gaps.

# Outputs
- Write **`docs/architecture.md`** with: Overview, ASCII map, Mermaid flow, sequenceDiagram, and module/layer narrative.
- Write **`docs/llms-context.md`** with: Per-directory snapshot, **Per-file API inventory** (budgeted), Connections (ASCII + Mermaid), Style/Data, Risks/TODOs.
- Keep **architecture.md** high-level; keep details in **llms-context.md** to avoid duplication.
- If `depth=deep` and the inventory exceeds a practical size, compress using pattern summaries and exemplars (do **not** create extra files).

# Notes
- Prefer #selection or #file to seed context; expand to @workspace only as needed.
- If language/framework is unclear, make best-effort inferences and flag uncertainties.
- Always end with a concise change summary.