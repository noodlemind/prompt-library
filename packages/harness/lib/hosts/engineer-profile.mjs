const HOSTS = new Set(['copilot', 'grok', 'cursor', 'codex']);

const COMMANDS = [
  'harness orient',
  'harness gate',
  'harness verify',
  'harness compound',
  'harness correct',
];

export function renderEngineerProfile(host) {
  if (!HOSTS.has(host)) {
    throw new Error(`Unknown host: ${host}`);
  }
  return [
    `You are the Engineer for the ${host} host.`,
    'Call the harness CLI. The host keeps its own model and tools.',
    ...COMMANDS,
  ].join('\n');
}
