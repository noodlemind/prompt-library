---
name: 'TypeScript Conventions'
description: 'TypeScript-specific coding standards and patterns'
applyTo: '**/*.{ts,tsx}'
---

# TypeScript Conventions

## Type Safety
- Enable strict mode in `tsconfig.json`. Never disable `strictNullChecks` or `noImplicitAny`.
- Avoid `any`. Use `unknown` when the type is genuinely unknown, then narrow.
- Use `as` casts only when the type system cannot be convinced. Add a comment explaining why.
- Define return types on all exported functions.

## Modern Patterns
- Prefer `const` over `let`. Never use `var`.
- Use optional chaining (`?.`) instead of nested conditionals.
- Use nullish coalescing (`??`) instead of `||` for defaults (preserves `0`, `""`, `false`).
- Destructure objects and arrays when it improves readability.

## Error Handling
- Use discriminated unions for result types over thrown exceptions in libraries.
- Use `unknown` (not `any`) in catch blocks.
- Define custom error classes for domain-specific errors.

## React (when applicable)
- Keep components focused — one responsibility per component.
- Use hooks correctly — respect dependency arrays in `useEffect`.
- Don't use `useEffect` for derived state — compute it during render.
- Use `key` props that are stable and meaningful (not array index for dynamic lists).

## Modules
- Prefer named exports over default exports.
- Keep barrel files (`index.ts`) clean — only re-export public API.
- Avoid circular dependencies — if A imports B and B imports A, restructure.

## Testing
- Use the project's test framework consistently.
- Mock at module boundaries, not deep internals.
- Parametrize tests for multiple input variations.
- Test types with `expectTypeOf` or `satisfies` when type correctness matters.
