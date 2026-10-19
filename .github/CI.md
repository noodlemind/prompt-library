# Continuous integration

Each pull request runs the full source suite on Linux and Windows. Both jobs
discover every top-level `packages/ae/test/*.test.mjs` file, including delivery,
adaptive authority, workflow and installed-runtime cases. The CLI's trusted named
checks remain unchanged.

The Windows workflow runs automatically on pull requests and can also be started
manually. Branch pushes no longer start a second copy of the same full suite.
New revisions cancel older runs of the same workflow and ref, including package
candidate runs.

## Jobs and evidence

| Job | What it proves | Retained output |
| --- | --- | --- |
| Linux source tests | Full source behavior and prompt contracts on Node 22 | Full console log and installed-delivery transcripts |
| Windows source tests | Full source behavior on Node 22, native CLI scenarios, redaction and descendant termination | Full console log, installed-delivery transcripts, environment and process diagnostics |
| Linux package | Exact Node 24 archive installs offline and hydrates a runnable `ae` | Archive, checksum and source metadata |
| Windows package | Exact Node 24 archive installs offline and hydrates a runnable `ae` | Archive, checksum and source metadata |
| Documentation | Canonical pages build with Jekyll | Pages artifact |

The former delivery and Windows adaptive jobs repeated files already discovered
by the full suites. Their diagnostic output is now collected by those suites.
Uploads run after failure. Linux log capture preserves a failing command's exit
code. The Windows final gate rejects a failed, cancelled or missing suite verdict
and any failed or missing redaction or descendant-termination verdict.

## Conditional work

Package candidates run for changes inside `packages/ae/`, the package workflow,
root npm configuration or license files. Both operating systems install the exact
archive produced by their job. Manual execution remains available.

Documentation runs when its workflow, renderer, site templates or one of its
three canonical Markdown inputs changes. The input list follows
`scripts/build-docs.mjs`. Publishing still requires a manual run with the publish
input enabled.

The Linux and Windows source jobs always report on pull requests. Docs and package
workflows use native path filters, so they are absent for unrelated changes.
Do not make these conditional workflow checks mandatory in branch protection:
GitHub leaves path-filtered required checks pending. If they become required,
replace workflow filters with job conditions and an always-reporting gate first.

## Runtime improvements

When all inputs change, the configuration runs five jobs rather than nine. This
removes repeated work; it does not establish a measured latency improvement.
Keep console timings, test totals, failures and platform skips when comparing
revisions. Record queue time, runner image, Node version, elapsed feedback time
and billed runner time across repeated runs.

Windows keeps its existing two-worker limit. Evaluate balanced shards only after
identifying the slow files. Every discovered file must belong to exactly one
shard, and unavailable or failed shard results must fail the aggregate gate.
