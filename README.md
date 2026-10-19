# Adaptive Engineering

The Engineer decides. The Harness checks the work and keeps the record. You start with those two. Skills, specialist agents, and instructions are acquired when the work needs them.

This repository authors that ship set under `packages/ae/corpus/`. `ae install` copies the tree onto `~/.copilot/`.

Read [how it grows](docs/adaptive-engineering.md).

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
