---
name: 'Spring Boot Conventions'
description: 'Spring Boot 3.x patterns, configuration, and best practices layering on Java conventions'
applyTo: '**/*.java'
---

# Spring Boot Conventions

_Layers on `java.instructions.md`. These conventions apply to Spring Boot 3.x (Spring Framework 6.x) projects._

## Project Structure
- Use package-by-feature, not package-by-layer. `com.example.order` not `com.example.controller`.
- Each feature package contains its controller, service, repository, DTOs, and domain model.
- Shared infrastructure (config, security, common) lives in a top-level `infrastructure` or `config` package.

## Dependency Injection
- Constructor injection only. Never use `@Autowired` on fields.
- Use `@RequiredArgsConstructor` (Lombok) or explicit constructors — both are acceptable. Be consistent within a project.
- Prefer `@Component` stereotypes (`@Service`, `@Repository`, `@Controller`) over `@Bean` methods for application classes. Use `@Bean` for third-party library configuration.
- Keep constructor parameters under 5. More than 5 suggests the class has too many responsibilities.

## REST Controllers
- Use `@RestController` with `@RequestMapping` at the class level for the resource base path.
- HTTP method annotations on methods: `@GetMapping`, `@PostMapping`, `@PutMapping`, `@DeleteMapping`, `@PatchMapping`.
- Return `ResponseEntity<T>` for explicit status code control. Return the DTO directly when 200 OK is always correct.
- Use `@Valid` on request body parameters for Bean Validation.
- Use `@PathVariable` for resource identifiers, `@RequestParam` for filtering/pagination.
- Global exception handling via `@RestControllerAdvice` with `@ExceptionHandler` methods. Never catch exceptions in controllers to return error responses — let the advice handle it.

## Service Layer
- Services contain business logic. Controllers delegate to services — no business logic in controllers.
- Service methods are transactional by default: `@Transactional` on the class or method level.
- Use `@Transactional(readOnly = true)` for read-only operations — enables read replica routing and prevents accidental writes.
- Throw domain-specific exceptions from services. Don't throw `ResponseStatusException` — that couples the service layer to HTTP.

## Configuration
- Use `application.yml` over `application.properties` — hierarchical structure is clearer.
- Type-safe configuration with `@ConfigurationProperties` and `@EnableConfigurationProperties`. Never scatter `@Value` annotations.
- Profile-specific config: `application-{profile}.yml`. Use `spring.profiles.active` in environment, not hardcoded.
- Externalize all secrets via environment variables. Never commit secrets to config files.
- Use `@Profile` to conditionally load beans per environment. Don't use `if/else` on profile names in code.

## Data Access
- Use Spring Data JPA repositories. Extend `JpaRepository<T, ID>` for standard CRUD.
- Define custom queries with `@Query` annotation using JPQL. Use native queries only when JPQL can't express the query.
- Projection interfaces for read-only queries that don't need full entities.
- `@EntityGraph` or `JOIN FETCH` to prevent N+1 queries. Never rely on lazy loading in controllers or API responses.
- Pagination with `Pageable` parameter and `Page<T>` return type.

## Validation
- Bean Validation annotations on DTOs: `@NotNull`, `@NotBlank`, `@Size`, `@Email`, `@Pattern`, `@Min`, `@Max`.
- Custom validators with `@Constraint` for domain-specific rules.
- Validation groups for create vs update scenarios.
- Validate at the API boundary (controller layer), not in services.

## Error Handling
- `@RestControllerAdvice` with problem detail responses (RFC 9457 / `ProblemDetail`).
- Map domain exceptions to HTTP status codes in the advice, not in services.
- Include a machine-readable error code, human-readable message, and optional field-level errors.
- Log stack traces at ERROR level for unexpected exceptions. Don't log expected validation failures at ERROR.

## Security (Spring Security)
- Configure via `SecurityFilterChain` `@Bean` — never extend `WebSecurityConfigurerAdapter` (removed in Spring Security 6).
- Method-level security with `@PreAuthorize` for authorization checks.
- Stateless sessions for APIs: `SessionCreationPolicy.STATELESS`.
- CORS configuration in the security filter chain, not in controllers.

## Testing
- `@SpringBootTest` for integration tests — loads full context. Use sparingly.
- `@WebMvcTest` for controller tests — loads only the web layer with MockMvc.
- `@DataJpaTest` for repository tests — loads JPA components with an embedded database.
- `@MockitoExtension` for unit tests — no Spring context needed.
- Use Testcontainers for integration tests against real databases and message brokers.
- Slice testing over full context: `@WebMvcTest` > `@SpringBootTest` for controller tests.

## Actuator and Observability
- Enable health, info, and metrics endpoints. Disable all others in production unless explicitly needed.
- Custom health indicators for external dependencies (database, cache, message broker).
- Micrometer for metrics. Add `@Timed` or manual timer recording for business-critical operations.
- Structured logging with correlation IDs for distributed tracing.
