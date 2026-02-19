---
name: 'Rails Conventions'
description: 'Rails-specific coding standards and patterns'
applyTo: '**/*.rb'
---

# Rails Conventions

## Models
- Validate all required fields with appropriate validators.
- Use `has_many`/`belongs_to` with explicit `dependent:` options.
- Extract shared behavior into concerns using `ActiveSupport::Concern`.
- Add database-level constraints to match model validations (uniqueness, NOT NULL, foreign keys).
- Name scopes to read like English: `User.active`, `Order.recent`.

## Controllers
- Keep actions thin: find, act, respond. Max 10 lines per action.
- Use strong parameters — always `permit` explicitly.
- Prefer REST: if adding custom actions, consider a new controller.
- Use `before_action` for shared setup, but keep the chain short.

## Queries
- Always use `includes`/`preload` to prevent N+1 queries.
- Never use string interpolation in `where` clauses.
- Prefer scopes and the query interface over raw SQL.
- Add indexes for all foreign keys and frequently-queried columns.

## Migrations
- Always add a default for new NOT NULL columns.
- Use `add_index :table, :column, algorithm: :concurrently` for zero-downtime index creation.
- Test rollback: every `up` should have a working `down`.
- Batch large data operations.

## Testing
- Use factories (FactoryBot) over fixtures.
- Test validations, scopes, and business logic in model tests.
- Test happy path, auth, and validation failures in controller tests.
- Use integration tests for critical user workflows.
