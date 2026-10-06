# Enterprise Capability Gaps

Open and resolved **hard-gap** proposals before primitives ship.

Naming: `YYYY-MM-DD-<id>.md` using `~/.copilot/skills/references/capability-gap-proposal.md`.

After fulfillment: a skill for every install is a commit under `packages/harness/corpus/skills/<name>/SKILL.md`. A personal skill is `harness resources create skill <name>` with the body on stdin. An agent for every install is `packages/harness/corpus/agents/<name>.agent.md`. Update `capability-registry.enterprise.yaml`, hydrate, and set plan `fulfillment: done`.
