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
