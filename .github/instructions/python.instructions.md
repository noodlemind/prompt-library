---
name: 'Python Conventions'
description: 'Python-specific coding standards and patterns'
applyTo: '**/*.py'
---

# Python Conventions

## Type Annotations
- Add type hints to all public function signatures.
- Use `str | None` over `Optional[str]` (Python 3.10+).
- Use `Pydantic` models for structured data, especially API inputs/outputs.
- Use `dataclasses` or `attrs` for simple data containers.

## Pythonic Patterns
- List comprehensions over `map`/`filter` with lambdas.
- Context managers (`with` statements) for resource management.
- `pathlib.Path` over `os.path` for file operations.
- `enumerate()` over manual index tracking.
- F-strings for string formatting (not `.format()` or `%`).

## Error Handling
- Catch specific exceptions, never bare `except:`.
- Use `raise from` for exception chaining to preserve context.
- Define custom exceptions for domain-specific errors.
- Never silently swallow exceptions — at minimum, log them.

## Code Organization
- Modules under 300 lines. Split when larger.
- Functions under 30 lines of logic.
- `__init__.py` should define the public API of a package.
- Use `__all__` to declare public exports.

## Testing
- Use `pytest` with fixtures for setup.
- Use `@pytest.mark.parametrize` for variations.
- Mock at boundaries (API calls, database, filesystem), not internals.
- Name tests descriptively: `test_user_creation_fails_without_email`.

## Security
- Validate input with Pydantic at API boundaries.
- Parameterize all database queries — never use f-strings in SQL.
- Never use `pickle` to deserialize untrusted data.
- Read secrets from environment variables, not config files.
