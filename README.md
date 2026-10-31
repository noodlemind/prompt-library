# Adaptive Engineering

The Engineer decides. The Harness checks the work and keeps the record. You start with those two. Skills, specialist agents, and instructions are acquired when the work needs them.

This repository authors that ship set under `packages/ae/corpus/`. `ae install` copies the tree onto `~/.copilot/`.

Read [how it grows](docs/adaptive-engineering.md).
The [architecture research and stabilization plan](.audit/ae-native-architecture-2026-10-29.md)
records the pstack comparison, PR #104 reassessment, repairs, and qualification.

```bash
npm ci --prefix packages/ae
npm install -g ./packages/ae
ae install --configure-vscode
```

The npm distribution is named `ae-harness`; registry installation is available after publication. See the [migration guide](docs/migration/ae.md) for candidate archives, saved work, upgrades and the later repository rename.

Select `@engineer` in Copilot Chat.

```text
@engineer: Answer      → direct, read-only reply
           Investigate → evidence-backed, read-only report
           Deliver     → orient → lock intent → gate → work → review → verify → compound → report
           Review      → independent assessment
```

New installations use `~/.ae/projects/<repo-id>/` for plans and private solutions. Existing populated `~/.harness` homes remain discoverable. `--ae-home <path>` selects a root for one command; `AE_HOME` selects it for all processes. To copy an existing root with a backup, use `ae migrate --from-home ~/.harness --ae-home ~/.ae`, starting with `--dry-run`.

`ae init-repo` defaults to private project configuration.
`ae init-repo --shared` explicitly publishes team policy and checks under
`.github/harness/` for review and commit. Existing shared configuration stays
selected. Runtime files use Git-local excludes; each teammate retains their
own installation and approval.


## Recorded formal diagrams

`ae diagrams formal --file <formal-verification.json> --model <Module.tla> --json`
draws a retained counterexample or a positive model's exported state graph through
the bundled local renderer. It preserves recorded states, transitions, and progress
loops; expected negative controls are identified as controls. An explicitly
configured formal checker can retain a graph with `--capture-graph`. Rendering
runs no model checker and installs no Java,
JAR, tool, or service. A diagram is a view of retained evidence, not a fresh
verification result. See the [diagram reference](packages/ae/corpus/skills/codebase-context/references/diagrams.md)
for inputs, limits, and freshness.

## Attribution

AE's own retained-evidence compiler learns from
[Lauren Tan's pstack `/statechart`](https://github.com/cursor/plugins/tree/4dd1d05818d19792e7cd6e818f1667f95f7e1dbe/pstack/skills/statechart),
version 0.15.36. Lauren's separation of checking, evidence, compilation, and
projection informs AE's native implementation. AE does not ship pstack's parser,
runner, installer, or view modules. Retained upstream protocol fixtures keep her
[MIT license and copyright notice](packages/ae/test/fixtures/formal-diagrams/LICENSE.pstack).
See [third-party notices](packages/ae/THIRD-PARTY-NOTICES.md).
