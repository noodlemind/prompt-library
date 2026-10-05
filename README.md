# Adaptive Engineering

The Engineer decides. The Harness checks the work and keeps the record. You start with those two. Skills, specialist agents, and instructions are acquired when the work needs them.

Adaptive Engineering is the locked delivery loop those two parts run. The Engineer chooses Answer, Investigate, Deliver, or Review. The Harness orients the work, locks intent, gates edits, and records named-check evidence. A change is done when that evidence passes. After a pass, compounding stores what the task taught. A person still approves new skills and agents.

That loop is what chat-code and "paste a spec into an agent" skip. The contract is written before files move. Verification is a named check rather than a claim. Learning is classified only after a pass.

Read [what Adaptive Engineering is, what pain it removes, how the self-improving loop helps, and how it compares with SDD, BDD, and spec-wrapping agent harnesses](docs/adaptive-engineering.md).

```bash
npm install -g harness
harness install --configure-vscode
```

Select `@engineer` in Copilot Chat.

```text
@engineer: Answer      → direct, read-only reply
           Investigate → evidence-backed, read-only report
           Deliver     → orient → lock intent → gate → work → review → verify → compound → report
           Review      → independent assessment
```

Product plans and private solutions live under `~/.harness/projects/<repo-id>/`. They are not committed in the product repository. `--harness-home <path>` moves that root for one command. `HARNESS_HOME` moves it for every command. The flag wins.
