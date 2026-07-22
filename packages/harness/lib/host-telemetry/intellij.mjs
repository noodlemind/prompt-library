/**
 * IntelliJ GitHub Copilot host-usage adapter (stub).
 *
 * The multi-platform structure exists so a real adapter can drop in without
 * changing the report. Until the IntelliJ log format for token usage is
 * confirmed, this returns no host events and the report uses harness estimates.
 */
export function collect() {
  return [];
}
