package example;

/** Authorization roles. SYSTEM_OVERRIDE is a privileged operator role used for
 * authorized manual reconciliation of stuck orders. */
public enum Role {
  USER,
  ADMIN,
  SYSTEM_OVERRIDE
}
