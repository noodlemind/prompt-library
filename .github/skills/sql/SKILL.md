---
name: sql
description: SQL and PostgreSQL workflow for schema design, migrations, query changes, performance, and data integrity review preparation.
argument-hint: "[describe the SQL, schema, migration, or query task]"
---

# SQL

## Purpose

Apply SQL and PostgreSQL guidance as an on-demand skill. Use this for query work, schema design, migrations, data integrity checks, and review preparation.

## Trigger Examples

**Should trigger:**
- "Add an index for this slow query"
- "Review this migration plan"
- "Fix duplicate rows from this join"

**Should not trigger:**
- "Fix a Python parser" -> use `/python`
- "Review Java concurrency" -> use `/java`
- "Update README content" -> use `/project-readme`

## Workflow

1. **Load scoped conventions**: Apply the globally hydrated `postgresql.instructions.md` for `.sql` and PostgreSQL-related work.
2. **Classify risk**:
   - Query-only change -> inspect callers, expected row counts, and existing tests.
   - Schema, migration, backfill, or destructive data change -> require a plan through `/capture-issue` and `/plan-issue`.
3. **Inspect local patterns**: Match migration framework, naming conventions, transaction style, query builder usage, and rollback expectations.
4. **Design conservatively**:
   - Parameterize queries and avoid `SELECT *`.
   - Prefer reversible migrations.
   - For production-sized tables, avoid long locks and table rewrites.
   - Add constraints and indexes only when they support real access patterns or invariants.
5. **Verify**:
   - Run query tests or migration tests when present.
   - Use `EXPLAIN` / `EXPLAIN ANALYZE` guidance when performance is the point of the change.
   - Confirm rollback or forward-fix strategy for risky migrations.
6. **Review route**:
   - Use `@sql-reviewer` for SQL/query/schema review.
   - Add `@data-integrity-guardian` for migrations, backfills, constraints, or persistent data risk.
   - Add `@performance-oracle` for hot-path or large-table query risk.

## Guardrails

- Do not make destructive schema or data changes without an explicit plan and rollback story.
- Do not assume production table size is small.
- Do not treat ORM code as safe if it emits unsafe SQL.
