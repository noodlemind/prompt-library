---
applyTo: "src/**,server/**"
---
- Preserve public method signatures and typed errors.
- Validate inputs; parameterize all DB queries; document transaction scope explicitly.
- Avoid cross-cutting logging changes; keep logs at boundaries and sanitize sensitive data.
