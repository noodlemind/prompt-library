# Journey performance

Performance analysis links declared architecture flows, selected source dependencies, and attributed measurements for a single repository or an existing domain. Reports preserve unknown and stale evidence.

## Sub-features

- `performance-domain` reads a version-2 domain and selected current source bytes through the real CLI.
- `performance-perspectives` reports a missing declared completion path and an exact forbidden manifest package in separate views.
- `performance-observations` compares compatible exported measurements, then marks them stale after a dirty source edit.
- `performance-guidance` retrieves applicable journey goals and constraints in orientation and review preparation.
- `performance-repair` reruns a synthetic twelve-item journey with 12 then 1 database calls, refreshes source-bound observations and removes the structural violations.

## How to get to it (user POV)

- Author `.github/harness/performance.json` using the [performance reference](../../../../packages/ae/corpus/skills/engineer/references/performance-engineering.md).
- Run `ae performance analyze --json`, or select another relative profile with `--file` and an existing domain with `--domain`.
- Open the returned HTML path. Select a journey, service, source or finding to inspect the linked evidence.
- Use `ae orient --read --file <path> --json` before editing and `ae review prepare --file <path> --json` before review.

## Driving it with prove-performance.mjs

Preconditions: Node 20+, Git and installed package dependencies; doctor exits zero. Use disposable workspaces and a separate Harness home.

- Run `ae checks run verify-performance --json` from a trusted checkout. The helper runs doctor before the pilot.
- The helper creates two Git repositories and an existing domain descriptor. It invokes analysis, rereads written JSON/HTML, exercises dry-run, retrieves orientation/review context, edits a foreign source, observes stale measurements, and then reruns the corrected fixture.
- Require the missing completion and forbidden package diagnostics before repair, a stale goal after the dirty edit, and a met cost goal after recapture. The deterministic operation count is 12 → 1 database calls for the same twelve-item synthetic journey.
- Require `performance.json` under the runner's artifact directory and `cleanup: true`. The receipt includes actual CLI arguments, exit statuses and stdout. HTML and JSON snapshots remain beside it after disposable repositories are removed.
- Separately drive the generated report in a browser: change the journey selection, select a service and a source, inspect evidence, and check keyboard operation and a narrow viewport. A CLI pass does not establish those interactions.

## Gotchas

- The fixture cost assumes USD 0.001 per counted call. It proves analysis mechanics and operation-count reduction, not production billing, latency or throughput.
- Imported observation text is attributed data. It cannot approve checks, prove causality or authenticate a deployment.
- Native editor activation and live telemetry connectors remain outside this drive. Static extraction is lexical and may miss or misread dependency relationships.
- This feature map covers the new route. It does not claim a full Harness product audit.
