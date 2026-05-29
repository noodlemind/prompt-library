import fs from 'fs';
import path from 'path';

const VALID = new Set(['full', 'balanced', 'strict']);

/**
 * Resolve autonomy: CLI flag → active plan frontmatter → profile.md → balanced.
 */
export function resolveAutonomy({ flags, plan, copilotHome }) {
  if (flags?.autonomy && VALID.has(flags.autonomy)) return flags.autonomy;
  const planVal = plan?.fm?.autonomy;
  if (typeof planVal === 'string' && VALID.has(planVal)) return planVal;
  if (copilotHome) {
    const profilePath = path.join(copilotHome, 'knowledge', 'profile.md');
    if (fs.existsSync(profilePath)) {
      const text = fs.readFileSync(profilePath, 'utf8');
      const m =
        text.match(/\*\*autonomy:\*\*\s*(full|balanced|strict)/i) ||
        text.match(/^autonomy:\s*(full|balanced|strict)\s*$/im);
      if (m) return m[1].toLowerCase();
    }
  }
  return 'balanced';
}
