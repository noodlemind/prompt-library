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

### Rails
- Strong parameters and mass assignment
- N+1 queries (includes/preload)
- REST purity (custom actions → new controllers)
- Fat models, thin controllers
- Hotwire over JavaScript frameworks

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
