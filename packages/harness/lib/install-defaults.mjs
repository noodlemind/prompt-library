/**
 * Opinionated defaults for human-facing install commands (setup / install / upgrade).
 */
export function applyInstallDefaults(flags, argv, command) {
  const isInstall =
    command === 'install' || command === 'upgrade' || command === 'setup';
  if (!isInstall) return flags;

  if (!argv.includes('--no-configure-vscode')) flags.configureVsCode = true;

  const hasAutonomy = argv.some((a) => a === '--autonomy' || a.startsWith('--autonomy='));
  if (!hasAutonomy) flags.autonomy = 'balanced';

  return flags;
}
