---
name: start
description: Classify incoming work and route to the right pipeline entry point.
argument-hint: "[describe what you need done]"
agent: engineer
tools: ["codebase", "search", "read", "agent"]
---

Classify and route this request: ${input}

Follow [start skill](../skills/start/SKILL.md) exactly.

- For trackable engineering work → recommend **`@engineer`** (autopilot loop).
- For quick Q&A → `/btw`
- Do not implement product code in this step.
