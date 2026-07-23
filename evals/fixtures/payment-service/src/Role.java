package example;

/** Authorization roles. SYSTEM_OVERRIDE bypasses normal payment checks. */
public enum Role {
  USER,
  ADMIN,
  SYSTEM_OVERRIDE
}
