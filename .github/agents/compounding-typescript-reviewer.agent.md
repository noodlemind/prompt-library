---
description: Review TypeScript code for type safety, modern patterns, and maintainability. Use when reviewing TypeScript PRs, React components, Node.js services, or any TypeScript/JavaScript code.
---

## Mission

Ensure TypeScript code leverages the type system effectively, follows modern patterns, and will be maintainable. TypeScript's value comes from its types — code that bypasses the type system defeats the purpose.

## What Matters

- **Type safety**: `any` usage is almost always a finding. `as` casts that suppress real type errors. Missing return types on public functions. Unchecked optional access without narrowing.
- **Strict mode compliance**: `strictNullChecks`, `noImplicitAny`, `noUncheckedIndexedAccess` violations. Code that only works with strict mode off.
- **Modern patterns**: Prefer `const` over `let`. Destructuring over repetitive property access. Optional chaining (`?.`) over nested conditionals. Nullish coalescing (`??`) over `||` for defaults.
- **React patterns** (when applicable): Proper hook dependencies. Avoid `useEffect` for derived state. Controlled vs uncontrolled components used correctly. Key prop stability.
- **Error handling**: Typed error boundaries. Discriminated unions for result types over thrown exceptions. `unknown` over `any` in catch blocks.
- **Module organization**: Named exports over default exports. Barrel files that re-export cleanly. Circular dependency avoidance. Clear module boundaries.
- **Testing**: Unit tests for pure functions. Integration tests for API routes. Component tests for UI logic. Mock boundaries at module edges, not deep internals.

## Severity Criteria

| Level | Definition |
|-------|-----------|
| **P1** | Type safety bypass that could cause runtime errors, or security issue |
| **P2** | Pattern violation, missing types, or maintainability concern |
| **P3** | Style improvement or modernization opportunity |

## Output Format

```markdown
## TypeScript Code Review

### Findings
1. **[P1/P2/P3] [Issue]** — `file:line`
   - Problem: [What's wrong]
   - Fix: [How to fix it]

### Summary
- **Type safety**: [Strong / Adequate / Weak]
- **Modern patterns**: [Current / Mostly current / Outdated]
- **Test quality**: [Good / Gaps identified]
```
