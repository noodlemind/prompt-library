function nonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

export function decideNext({ lastAttempt, nextAttempt, failedCheck }) {
  if (nonEmptyString(nextAttempt) && nextAttempt === lastAttempt) {
    return { action: 'block', reason: 'unchanged-retry' };
  }
  if (nonEmptyString(failedCheck)) {
    return { action: 'resume', checkpoint: failedCheck };
  }
  return { action: 'continue' };
}
