# Resource operations

The Engineer owns need, overlap, primitive type, authored content, meaningful evaluation cases and minimum permissions. Deterministic reusable operations belong in Harness; contextual judgment protocols belong in skills; separate perspective or authority belongs in agents; product assertions belong in product checks.

`harness resources validate --corpus --json` validates shipped source, metadata, descriptions, concrete trigger examples, relative Markdown references, capability registry and delegation targets. `resources validate --path <root>` inspects another resource root; `resources scaffold <skill|agent|instruction> <name> --json` emits a dormant template. Generated counts replace manual inventory arithmetic. Host support declarations are separate from live host proof.

Use `resources create <type> <name> --file <decision.json> --json` for validated creation through the existing writer. Schema 1 accepts `text` and optional `expectedDigest`. Replacing changed bytes requires the observed digest. Agent tool or delegation expansion also requires caller `--yes` after authorization under [human-approval-policy.md](human-approval-policy.md); an input field cannot authorize it. Dry-run validates without publication. Legacy text-on-stdin remains readable under its weaker discovery-only validation.

`resources candidates --json` freezes recurring review and repeated-mistake evidence. Exact recorded identities stay distinct from suspected semantic matches. The packet exposes existing named checks without claiming relevance. Global-tag clustering does not establish verified use; legacy fix/plan links require proof review before promotion. Read the full `packetPath` when the bounded result reports omissions.

A dormant proposal uses `resources propose --file <proposal.json> --json`:

```json
{
  "schema": 1,
  "operation": "gap-review-order",
  "type": "skill",
  "name": "focused-review",
  "rationale": "Why reusable judgment is missing and existing capabilities do not cover it.",
  "text": "Authored canonical primitive text with frontmatter and concrete examples.",
  "evidence": [],
  "candidatePacket": "optional frozen packet ID",
  "candidate": "optional selected candidate ID"
}
```

Omit optional candidate fields when no recorded candidate applies. Evidence paths select current workspace files; Harness captures their hashes. Supported dormant types are skill, agent, instruction, check, test and cli. Same operation and accepted bytes replay one proposal; changed payload conflicts. Stale selected evidence blocks. No proposal installs a file, grants authority, registers a capability or changes an allowlist. Activation follows the existing writer and approval contract after the semantic decision is accepted.
