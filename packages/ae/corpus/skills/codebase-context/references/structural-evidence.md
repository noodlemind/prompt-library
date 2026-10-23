# Structural evidence for an engineering question

Use the existing CLI; do not install a parser, model loop, graph database or MCP server.

1. Choose the question and exact file seeds. Use `graph deps|dependents|path` for module relationships, `graph explain <file> <target>` for evidence, and `graph impact <file>` for bounded reverse-import candidates.
2. For combined context call `ae orient --read --context-version 2 --question-kind change-impact --file <seed> --query <task>`. Use `dependency-path` with two files, `lookup` for source expansion or `prior-lesson` for memory. Inspect `slice.impactContext` and any outer read barrier.
3. Read occurrence-focused excerpts and relevant configuration. Preserve extraction method, resolver status, source hashes, scope and omissions. A lexical observation is weaker than an AST observation; imports and candidate calls do not establish runtime targets.
4. Judge affected scope and existing verification requirements. Suggested verification areas cannot select or waive named checks. Inspect Spring qualifiers/profiles and implementations before claiming active wiring; inspect producer/consumer configuration before asserting an event connection.
5. Check learning applicability separately from historical evidence. `needs-review` means selected supporting bytes changed; `unknown` includes legacy/unavailable bindings. Neither changes original proof, golden/human authority or branch-local subordination.

Live CLI queries prepare shipped AST assets when needed. Named `--generation <id>` graph queries are historical, never current worktree proof. Only retained generations are queryable. Complete coverage refers to bounded Git-tracked sources, not semantic or runtime completeness. Safe explicit lookup can read untracked files without adding them to the graph.

Expand a smaller batch when evidence clips. No supported path under incomplete coverage means unknown, rather than no dependency. Read sources before changing code or asserting architecture, and refresh after relevant edits. Do not make traversal mandatory for literal/prose questions or infer model-quality gains from mechanical tests.
