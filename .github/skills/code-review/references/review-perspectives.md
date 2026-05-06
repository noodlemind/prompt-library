# Review Perspectives Reference

## Always-Engaged Perspectives

### Architecture
- Component boundaries and coupling
- Dependency direction (toward stable abstractions)
- Pattern consistency across the codebase
- SOLID principle compliance
- API contract stability

### Security
- Input validation at all entry points
- Authentication and authorization on every endpoint
- No hardcoded secrets or credentials
- SQL parameterization, XSS prevention, CSRF protection
- Dependency vulnerability scanning

### Performance
- Algorithmic complexity in hot paths
- N+1 query detection
- Memory allocation in loops
- Missing caching opportunities
- I/O bottleneck identification

### Simplicity
- YAGNI violations and premature abstraction
- Dead code and unused imports
- Over-engineered error handling
- Unnecessary indirection layers

### Pattern Consistency
- Naming convention adherence
- Code organization matching existing patterns
- Duplication that should be extracted
- Anti-pattern detection

### Data Integrity
- Migration reversibility
- Lock risk on large tables
- Constraint correctness
- Transaction boundary appropriateness

## Language-Specific Perspectives

### Java
- API contracts and nullability
- Resource lifecycle and thread safety
- Exception behavior and validation
- Modern Java conventions
- Test coverage at unit and integration boundaries

### TypeScript
- Type safety (no `any`, proper narrowing)
- Strict mode compliance
- Modern patterns (optional chaining, nullish coalescing)
- React hook dependencies (when applicable)

### Python
- Type annotations on public functions
- Pythonic patterns (comprehensions, context managers)
- Specific exception handling
- Pydantic for data validation

### SQL/Data
- Query correctness and parameterization
- Index coverage and lock behavior
- Migration rollback and batching
- Constraints that enforce business invariants

### AWS
- Least-privilege IAM
- Credential and secret handling
- Retry, timeout, DLQ, and idempotency behavior
- Observability, quotas, and cost controls
