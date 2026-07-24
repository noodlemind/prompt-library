/**
 * Hook decisions in one payload for every supported host: VS Code reads the
 * nested hookSpecificOutput contract while Copilot CLI reads the top-level
 * permissionDecision/decision fields, so denials fail closed on both.
 */
export function preToolDenyOutput(reason) {
  return {
    permissionDecision: 'deny',
    permissionDecisionReason: reason,
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  };
}

export function stopBlockOutput(reason) {
  return {
    decision: 'block',
    reason,
    hookSpecificOutput: {
      hookEventName: 'Stop',
      decision: 'block',
      reason,
    },
  };
}
