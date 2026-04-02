# Findings Schema

This file defines the structured output contract for review personas. Each persona returns JSON matching this schema. The skill body (SKILL.md) defines how findings are merged, deduplicated, and routed.

## Persona Output Format

Each persona returns a single JSON object:

```json
{
  "reviewer": "architecture-strategist",
  "findings": [
    {
      "file": "path/to/file.rb",
      "line": 42,
      "severity": "P1",
      "confidence": 0.85,
      "title": "Circular dependency between UserService and AuthService",
      "description": "UserService imports AuthService which imports UserService, creating a circular dependency that will cause initialization failures.",
      "suggested_fix": "Extract shared logic into a separate module that both services can depend on.",
      "autofix_class": "manual",
      "evidence": [
        "UserService line 3: require 'auth_service'",
        "AuthService line 5: require 'user_service'"
      ]
    }
  ],
  "residual_risks": [
    "The auth middleware chain has not been fully traced — additional circular dependencies may exist."
  ],
  "testing_gaps": [
    "No integration test verifies the full auth → user → auth chain."
  ]
}
```

## Field Definitions

### Finding Fields (required)

| Field | Type | Description |
|-------|------|-------------|
| `file` | string | Relative file path from repo root |
| `line` | integer | Line number in the file (approximate is acceptable) |
| `severity` | enum | `P1` (critical), `P2` (important), `P3` (suggestion) |
| `confidence` | float | 0.0 to 1.0 — how confident the reviewer is that this is a real issue |
| `title` | string | One-line summary of the issue |
| `description` | string | What the problem is, why it matters, what the impact is |
| `suggested_fix` | string | Concrete recommendation (not "consider" or "might want to") |
| `autofix_class` | enum | How the finding should be routed (see Action Routing below) |
| `evidence` | array[string] | Specific code references, line quotes, or observations supporting the finding |

### Top-Level Fields

| Field | Type | Description |
|-------|------|-------------|
| `reviewer` | string | Name of the persona that produced these findings |
| `findings` | array | List of finding objects |
| `residual_risks` | array[string] | Risks that remain even after all findings are addressed |
| `testing_gaps` | array[string] | Areas where test coverage is insufficient |

## Severity Definitions

| Level | Meaning | Examples |
|-------|---------|---------|
| **P1 Critical** | Exploitable vulnerability, data loss/corruption, breaking change, security hole | SQL injection, auth bypass, N+1 on user-facing endpoint with unbounded data |
| **P2 Important** | High-impact defect likely hit in normal usage, breaking contract, meaningful downside | Missing validation on public API, race condition under normal load, architectural violation |
| **P3 Suggestion** | Low-impact improvement, narrow scope, minor quality enhancement | Naming inconsistency, minor simplification opportunity, documentation gap |

## Confidence Guidelines

| Confidence | When to use |
|-----------|-------------|
| **0.90-1.0** | Certain — the issue is provably present (e.g., visible in the diff, confirmed by reading the code) |
| **0.75-0.89** | High — strong evidence but not 100% verified (e.g., likely N+1 but haven't traced the full query chain) |
| **0.60-0.74** | Moderate — plausible issue but context-dependent (e.g., may be handled elsewhere, depends on runtime behavior) |
| **Below 0.60** | Low — speculative or uncertain. These are suppressed during synthesis (exception: P1 at 0.50+ survives) |

## Action Routing (autofix_class)

| Class | Meaning | Routed to |
|-------|---------|-----------|
| `safe_auto` | Local, deterministic fix that doesn't change behavior or contracts | In-skill fixer (applied automatically) |
| `gated_auto` | Concrete fix exists but changes behavior, contracts, or permissions | User for approval before applying |
| `manual` | Actionable work that requires human judgment or larger changes | Handoff as residual work |
| `advisory` | Report-only: learnings, rollout notes, residual risk observations | Included in report, no action taken |

### Routing Guidelines

- A typo fix, missing null check on an internal method, or adding a missing test → `safe_auto`
- Changing a public API response format, modifying auth permissions, altering database constraints → `gated_auto`
- Architectural refactoring, redesigning a module boundary, rewriting a test strategy → `manual`
- "This area has historically been fragile", deployment considerations, monitoring suggestions → `advisory`

## Quality Rules for Findings

Before submitting findings, each persona should verify:

1. **Every finding is actionable** — it says exactly what to do, not "consider" or "might want to"
2. **No false positives from skimming** — the surrounding code was actually read; the "bug" isn't handled elsewhere
3. **Severity is calibrated** — a style nit is never P1; a SQL injection is never P3
4. **Line numbers are accurate** — verified against the actual file content
5. **Confidence is honest** — don't inflate confidence to get past the threshold
6. **Evidence supports the claim** — each finding has at least one concrete code reference
