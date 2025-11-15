---
name: Test Prompt
description: A test prompt for unit testing
tools: ['search']
model: Claude Sonnet 4
handoffs:
  - label: Run Analysis
    agent: architecture-strategist
    prompt: Analyze the architecture
    send: true
---

## Test Prompt Instructions

This is a test prompt used for unit testing the prompt parser.

It should correctly parse the same structure as agents.
