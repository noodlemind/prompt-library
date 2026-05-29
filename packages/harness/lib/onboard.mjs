import fs from 'fs';
import path from 'path';

const WELCOME_MARKER = '.harness-onboarding-complete';

export function isFirstHarnessInstall(copilotHome, previousLock) {
  return !previousLock && !fs.existsSync(path.join(copilotHome, WELCOME_MARKER));
}

export function markOnboardingComplete(copilotHome, dryRun) {
  if (dryRun) return;
  const marker = path.join(copilotHome, WELCOME_MARKER);
  fs.mkdirSync(copilotHome, { recursive: true });
  fs.writeFileSync(
    marker,
    `completedAt: ${new Date().toISOString()}\n`,
    'utf8'
  );
}

/** Shown after first successful harness setup (no repo docs required). */
export function printPostSetupOnboarding({ copilotHome } = {}) {
  const home = copilotHome || '~/.copilot';
  console.log('');
  console.log('── Next steps (no prompt-library repo needed) ──');
  console.log('');
  console.log('  1. Restart VS Code (or open a new window).');
  console.log('  2. Copilot Chat → type /  → you should see skills like /btw, /code-review.');
  console.log('  3. Copilot Chat → @  → pick @engineer for full-cycle work.');
  console.log('  4. In a product repo folder, run:');
  console.log('       harness init-repo');
  console.log('     Then in Copilot: /capture-issue or ask @engineer to start a task.');
  console.log('');
  console.log('  Memory model:');
  console.log(`    • Active work  → docs/plans/ in the product repo`);
  console.log(`    • Team fixes   → ${home}/knowledge/solutions/ (after /compound-learnings)`);
  console.log('    • harness index only lists solution files — not plans (that is normal).');
  console.log('');
  console.log('  VS Code Chronicle (/chronicle): personal chat history in the IDE.');
  console.log('  Harness: team skills + plans + compounded solutions (works with Chronicle).');
  console.log('');
  console.log('  Anytime: harness getting-started   (this guide in the terminal)');
  console.log('           harness doctor');
  console.log('');
}
