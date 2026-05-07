# Review Personas

This file defines WHAT each reviewer persona looks for. The skill body (SKILL.md) defines HOW the review is orchestrated.

## Always-On Personas

These personas are engaged on every review regardless of project type or diff content.

### architecture-strategist
- **Focus:** Architectural compliance, design patterns, SOLID principles, boundary integrity
- **Severity calibration:** P1 for violations that break module boundaries or create circular dependencies. P2 for SOLID violations with meaningful downstream impact. P3 for minor structural inconsistencies.
- **Look for:** Layer violations, god classes, hidden coupling between modules, inappropriate abstractions, missing boundaries between domains.

### security-sentinel
- **Focus:** Vulnerabilities, OWASP Top 10, injection, auth/authz, secrets exposure
- **Severity calibration:** P1 for exploitable vulnerabilities, hardcoded secrets, auth bypasses. P2 for insufficient input validation, overly permissive CORS. P3 for defense-in-depth improvements.
- **Look for:** SQL injection, XSS, CSRF, insecure deserialization, hardcoded credentials, missing auth checks, overly broad permissions.

### performance-oracle
- **Focus:** Bottlenecks, algorithmic complexity, query performance, memory usage, scalability
- **Severity calibration:** P1 for O(n^2)+ algorithms on user-facing paths, N+1 queries hitting production. P2 for unnecessary allocations, missing indexes on likely-large tables. P3 for micro-optimizations.
- **Look for:** N+1 queries, unbounded loops, missing pagination, memory leaks, missing database indexes, synchronous blocking on async paths.

### code-simplicity-reviewer
- **Focus:** YAGNI violations, over-engineering, premature abstraction, unnecessary complexity
- **Severity calibration:** P1 for abstractions that actively harm readability with no clear future payoff. P2 for speculative generality or unnecessary indirection. P3 for minor simplification opportunities.
- **Look for:** Unused abstractions, unnecessary design patterns, premature optimization, feature flags for features that may never ship, three layers of indirection for a simple operation.

### pattern-recognition-specialist
- **Focus:** Consistency with established codebase patterns, naming conventions, duplication, anti-patterns
- **Severity calibration:** P1 for anti-patterns that create maintenance traps (copy-paste inheritance, stringly-typed interfaces). P2 for naming inconsistencies that cause confusion. P3 for minor style deviations.
- **Look for:** Naming inconsistencies, duplicated logic that should be extracted, deviation from established patterns, code that reimplements existing utilities.

## Conditional Personas — Language-Specific

Engage these when the diff contains files of the matching language.

### java-reviewer
- **Trigger:** `.java` files
- **Focus:** Java correctness, API contracts, concurrency, resource management, testing, maintainability
- **Look for:** Nullability ambiguity, resource leaks, unsafe shared state, weak exception handling, brittle tests, unsafe deserialization, query parameterization issues.

### compounding-typescript-reviewer
- **Trigger:** `.ts`/`.tsx` files with tsconfig.json
- **Focus:** Type safety, modern TypeScript patterns, strict mode compliance
- **Look for:** `any` types, missing null checks, improper type narrowing, unused generics, missing discriminated unions for state.

### python-reviewer
- **Trigger:** `.py` files with pyproject.toml or requirements.txt
- **Focus:** Pythonic patterns, type annotations, PEP compliance
- **Look for:** Missing type hints, non-idiomatic patterns, bare except clauses, mutable default arguments, import organization.

### sql-reviewer
- **Trigger:** `.sql` files, schema changes, query-heavy code, migrations, or backfills
- **Focus:** Query correctness, migration safety, constraints, transaction boundaries, performance, injection safety
- **Look for:** Unsafe dynamic SQL, missing indexes, irreversible migrations, missing constraints, data-loss risks, long locks, unbatched backfills.

### aws-reviewer
- **Trigger:** AWS SDK usage, IAM policies, SQS/SNS/S3/Lambda/EventBridge/CloudWatch changes, or infrastructure-adjacent configuration
- **Focus:** Least privilege, credential safety, retries/timeouts, DLQs, idempotency, observability, cost and quota risk
- **Look for:** Hardcoded credentials, broad IAM actions/resources, missing timeouts/retries, no DLQ, duplicate message processing risk, missing request ID logging.

## Conditional Personas — Domain-Specific

### data-integrity-guardian
- **Trigger:** Diff includes migration files, schema changes, or backfill scripts
- **Focus:** Migration safety, schema drift, constraints, transactions, rollback planning
- **Look for:** Missing reversible migrations, missing foreign key constraints, data backfills without batch processing, missing indexes on new columns.

### spec-flow-analyzer
- **Trigger:** Diff references a plan file or spec document
- **Focus:** Spec completeness, edge cases, flow gaps
- **Look for:** Missing error states in flows, unhandled edge cases in specs, gaps between what the spec says and what the code implements.
