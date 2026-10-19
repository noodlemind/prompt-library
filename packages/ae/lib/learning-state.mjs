export function evidenceState({ id, cited }) {
  if (cited === true && typeof id === 'string' && id.length > 0) {
    return 'application-evidenced';
  }
  return 'retrieved';
}
