---
name: 'Java Conventions'
description: 'Java coding standards following Google Java Style Guide and Sun conventions for Java 17+'
applyTo: '**/*.java'
---

# Java Conventions

## Language Level
- Target Java 17+ features. Use records, sealed classes, pattern matching, and text blocks where they improve clarity.
- Prefer `var` for local variables when the type is obvious from the right-hand side. Spell out the type when it adds clarity.
- Use switch expressions (not switch statements) for exhaustive matching.

## Google Java Style
- 2-space indentation (not 4). Configure IDE/formatter accordingly.
- Braces required for all `if`, `else`, `for`, `while`, and `do` statements, even single-line bodies.
- One statement per line.
- Column limit: 100 characters.
- Import ordering: static imports first (sorted), then non-static imports (sorted). No wildcard imports.
- Class member ordering: static fields → instance fields → constructors → methods. Group by accessibility (public → protected → package-private → private).

## Naming
- Classes: `UpperCamelCase` — nouns or noun phrases (`UserRepository`, `OrderService`).
- Methods: `lowerCamelCase` — verbs or verb phrases (`findById`, `calculateTotal`).
- Constants: `UPPER_SNAKE_CASE` — `static final` fields with immutable values.
- Type parameters: single uppercase letter (`T`, `E`, `K`, `V`) or uppercase letter + digit (`T2`).
- Packages: all lowercase, no underscores (`com.example.userservice`).
- Avoid Hungarian notation. Don't prefix interfaces with `I` or implementations with `Impl`.

## Modern Java (17+)
- **Records** for immutable data carriers. Prefer over POJOs with getters/setters when the class is pure data.
- **Sealed classes** for restricted type hierarchies. Use `permits` to control subclassing.
- **Pattern matching** with `instanceof` — avoid explicit casts after type checks.
- **Text blocks** (`"""`) for multi-line strings (SQL, JSON, HTML templates).
- **Optional** for return types that may be absent. Never use Optional as a field type or method parameter.
- **Stream API** for collection transformations. Prefer streams over manual loops for map/filter/reduce operations. Use traditional loops when readability suffers or side effects are needed.

## Error Handling
- Catch specific exceptions, never bare `catch (Exception e)` unless re-throwing.
- Use custom exceptions for domain-specific errors. Extend `RuntimeException` for unchecked, `Exception` for checked.
- Prefer unchecked exceptions for programming errors. Use checked exceptions only when the caller can meaningfully recover.
- Always include the cause when wrapping exceptions: `throw new ServiceException("message", cause)`.
- Never swallow exceptions silently. At minimum, log them.
- Use try-with-resources for all `AutoCloseable` resources.

## Null Safety
- Annotate nullable parameters and return types with `@Nullable`. Assume non-null by default.
- Return `Optional<T>` instead of `null` for methods that may not produce a result.
- Use `Objects.requireNonNull()` at API boundaries for defensive null checks.
- Prefer empty collections (`List.of()`, `Map.of()`) over null collections.

## Dependency Injection
- Constructor injection over field injection. Makes dependencies explicit and testable.
- Keep constructors focused — if you have more than 5 parameters, the class may have too many responsibilities.
- Use `@Qualifier` or custom annotations to disambiguate when multiple beans of the same type exist.

## Testing
- Use JUnit 5 (`@Test`, `@BeforeEach`, `@Nested`, `@ParameterizedTest`).
- Name tests descriptively: `shouldReturnEmptyWhenUserNotFound`, `shouldThrowWhenAmountIsNegative`.
- Use `@Nested` classes to group related test cases.
- Use `@ParameterizedTest` with `@ValueSource`, `@CsvSource`, or `@MethodSource` for input variations.
- Mock at boundaries (external services, databases, APIs) with Mockito. Don't mock data classes or value objects.
- Use `assertThat` (AssertJ) over `assertEquals`/`assertTrue` for readable assertions.
- One assertion concern per test method. Multiple `assertThat` calls are fine if they verify one logical outcome.

## Code Organization
- One public class per file.
- Keep classes focused — single responsibility. Extract when a class exceeds ~200 lines of logic.
- Keep methods under 20 lines of logic. Extract helper methods for complex operations.
- Use packages to represent bounded contexts, not technical layers (prefer `com.example.order` over `com.example.service`).

## Concurrency
- Prefer `ExecutorService` and `CompletableFuture` over raw threads.
- Use `ConcurrentHashMap` over `Collections.synchronizedMap()`.
- Minimize synchronized blocks — lock only what needs protection.
- Use `volatile` for flags shared between threads. Use `AtomicInteger`/`AtomicReference` for atomic operations.
- Virtual threads (Java 21+): prefer for I/O-bound tasks when available. Avoid for CPU-bound work.

## Security
- Parameterize all database queries. Never concatenate user input into SQL.
- Validate input at API boundaries. Use Bean Validation (`@Valid`, `@NotNull`, `@Size`, `@Pattern`).
- Never log sensitive data (passwords, tokens, PII).
- Use `SecureRandom` instead of `Random` for security-sensitive operations.
