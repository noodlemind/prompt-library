import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderEngineerProfile } from '../lib/hosts/engineer-profile.mjs';
import { listCommands } from '../lib/registry.mjs';

const HOSTS = ['copilot', 'grok', 'cursor', 'codex'];

const COMMANDS = [
  'harness orient',
  'harness gate',
  'harness verify',
  'harness compound',
  'harness correct',
];

function expectedProfile(host) {
  return [
    `You are the Engineer for the ${host} host.`,
    'Call the harness CLI. The host keeps its own model and tools.',
    ...COMMANDS,
  ].join('\n');
}

for (const host of HOSTS) {
  test(`renderEngineerProfile returns the ${host} Engineer instruction`, () => {
    const text = renderEngineerProfile(host);
    assert.equal(text, expectedProfile(host));
    assert.equal(/\b(start|launch|invoke|run)\b[^.\n]{0,40}\bmodel\b/i.test(text), false);
  });
}

test('every harness command in the profile is registered', () => {
  const registered = new Set(listCommands());
  for (const host of HOSTS) {
    const text = renderEngineerProfile(host);
    const names = [...text.matchAll(/\bharness ([a-z][a-z0-9-]*)\b/g)].map((match) => match[1]);
    assert.notEqual(names.length, 0, `${host} profile names no harness command`);
    for (const name of names) {
      assert.equal(registered.has(name), true, `${host} names unregistered command ${name}`);
    }
  }
});

test('renderEngineerProfile throws for an unknown host', () => {
  for (const host of ['intellij', 'Copilot', '', null, undefined, 1]) {
    assert.throws(() => renderEngineerProfile(host), /Unknown host/);
  }
});
