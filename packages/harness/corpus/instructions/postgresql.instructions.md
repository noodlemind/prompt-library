---
name: 'PostgreSQL Conventions'
description: 'PostgreSQL schema design, query patterns, and migration best practices'
applyTo: '**/*.sql'
---

# PostgreSQL Conventions

## Naming
- Tables: `snake_case`, plural (`orders`, `user_accounts`). Never camelCase or PascalCase.
- Columns: `snake_case`, singular (`created_at`, `order_total`). No table name prefix (`user_id` in `orders`, not `order_user_id`).
- Primary keys: always `id` (bigserial or UUID). Foreign keys: `<referenced_table_singular>_id` (`user_id`, `order_id`).
- Indexes: `idx_<table>_<columns>` (`idx_orders_user_id`, `idx_orders_created_at_status`).
- Constraints: `chk_<table>_<description>` for checks, `uq_<table>_<columns>` for unique.
- Enums: singular, lowercase (`order_status`, not `OrderStatuses`).

## Schema Design
- Always use `bigserial` or `bigint` for primary keys. Never `serial`/`int` — you will run out.
- Use `timestamptz` (with timezone), never `timestamp` without timezone. Store all times in UTC.
- Use `text` over `varchar(n)` unless a length constraint is a business rule. PostgreSQL handles `text` efficiently.
- Use `numeric` or `decimal` for money/financial values. Never `float` or `double precision`.
- Use `uuid` type (not `varchar(36)`) when UUIDs are needed. Generate with `gen_random_uuid()`.
- Use `jsonb` over `json` — supports indexing and is more efficient. Only use for genuinely semi-structured data, not as a replacement for proper columns.
- Add `NOT NULL` constraints by default. Make columns nullable only when NULL has an explicit business meaning.
- Add `created_at timestamptz NOT NULL DEFAULT now()` and `updated_at timestamptz NOT NULL DEFAULT now()` to every table.

## Indexes
- Index every foreign key column. PostgreSQL does NOT auto-index foreign keys.
- Use `btree` (default) for equality and range queries. Use `GIN` for `jsonb`, arrays, and full-text search. Use `GiST` for geometric and range types.
- Partial indexes for filtered queries: `CREATE INDEX idx_orders_active ON orders(created_at) WHERE status = 'active'`.
- Composite indexes: put the most selective column first. Column order matters for btree — `(user_id, created_at)` serves queries filtering by user_id, but not queries filtering only by created_at.
- Use `CONCURRENTLY` for index creation on production tables to avoid locking.
- Don't over-index. Each index costs write performance and storage. Index what you query.

## Queries
- Always use parameterized queries. Never concatenate user input into SQL.
- Use `EXPLAIN ANALYZE` to verify query plans before deploying new queries.
- Prefer `EXISTS` over `IN` for subqueries — more efficient for large result sets.
- Use `LIMIT` with `OFFSET` for simple pagination. Use keyset pagination (`WHERE id > ?`) for large datasets — offset pagination degrades linearly.
- Use CTEs (`WITH` clauses) for readability. Note: CTEs are optimization fences in PostgreSQL < 12 but are inlined in 12+.
- Avoid `SELECT *` — list columns explicitly. Prevents breakage when columns are added and enables covering index usage.

## Transactions
- Keep transactions short. Don't hold transactions open during external API calls or user interactions.
- Use `SERIALIZABLE` isolation only when necessary. Default `READ COMMITTED` is correct for most use cases.
- Use advisory locks (`pg_advisory_lock`) for application-level locking instead of `SELECT ... FOR UPDATE` when possible.
- Wrap multi-statement operations in explicit transactions. Don't rely on autocommit for operations that must be atomic.

## Migrations
- One migration per change. Don't combine unrelated schema changes.
- Migrations must be reversible. Include both `up` and `down` operations.
- Never modify a migration that has been applied to a shared environment. Create a new migration instead.
- Add indexes in a separate migration from table creation — allows `CONCURRENTLY` option.
- For column renames: add new column → backfill → update application → drop old column. Never rename in-place on production.
- For `NOT NULL` additions to existing tables: add column nullable → backfill → add constraint. Don't add `NOT NULL` with a default in one step on large tables (table rewrite in older PG versions).
- Use `IF NOT EXISTS` / `IF EXISTS` for idempotent migrations.

## Performance
- Use connection pooling (PgBouncer or application-level pool). Don't open connections per request.
- Set `statement_timeout` at the application level to prevent runaway queries.
- Use `pg_stat_statements` to identify slow queries.
- Vacuum configuration: ensure autovacuum is properly tuned for high-write tables.
- Prefer bulk operations (`INSERT ... VALUES (rows)` or `COPY`) over row-by-row inserts.

## Security
- Use least-privilege database roles. Application connects with a role that has only the permissions it needs.
- Row-Level Security (RLS) for multi-tenant data isolation.
- Never store plaintext passwords. Use `pgcrypto` extension with `crypt()` and `gen_salt()`, or handle hashing in the application layer.
- Audit sensitive table access with triggers or logical replication.
