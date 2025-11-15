---
name: Test Agent
description: A test agent for unit testing
tools: ['search', 'githubRepo']
model: Claude Sonnet 4
handoffs:
  - label: Consult Security
    agent: security-sentinel
    prompt: Review for security issues
    send: false
---

## Test Agent Instructions

This is a test agent used for unit testing the agent parser.

It should correctly parse:
- YAML frontmatter with name, description, tools, model
- Handoff configuration
- Markdown content as instructions
