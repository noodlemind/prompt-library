import { collectOrientationFacts } from './orientation-facts.mjs';
import { buildContextRecord } from './context-record.mjs';
import { writeSession } from './session.mjs';

export function readOrientSlice({ workspace, copilotHome, flags = {}, query = '', files } = {}) {
  const facts = collectOrientationFacts({ workspace, copilotHome, flags, query, files });
  const q = query || flags.query || '';
  if (String(q).trim() && !flags.dryRun) {
    try {
      writeSession(workspace, { ...facts.session, lastQuery: q, lastOrientReadAt: new Date().toISOString(), files: facts.namedFiles });
    } catch {
      process.stderr.write('repeat check was not armed\n');
    }
  }
  return flags.contextVersion === 2 ? buildContextRecord({ workspace, flags, query: q, facts }) : facts.slice;
}
