# Enterprise Capability Gaps

Open and resolved **hard-gap** proposals before primitives ship.

Naming: `YYYY-MM-DD-<id>.md`. Read `<copilot-home>/skills/references/capability-gap-proposal.md` with the host read tool. Outside the enforce hook, `ae get --reference skills/references/capability-gap-proposal.md --json` prints the same file.

After fulfillment: a skill for every install is a commit under `packages/ae/corpus/skills/<name>/SKILL.md`. A personal skill is `ae resources create skill <name>` with the body on stdin. An agent for every install is `packages/ae/corpus/agents/<name>.agent.md`. Update `capability-registry.enterprise.yaml`, hydrate, and set plan `fulfillment: done`.
