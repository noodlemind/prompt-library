/**
 * Plugin host framing, request settlement, and child lifecycle.
 * (Folded from codex-phase5-findings.)
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { startPlugin } from '../lib/plugin-host.mjs';
import { tempDir } from './helpers/index.mjs';

test('an oversized line is discarded even though it ends in a newline', async () => {
  const dir = tempDir('plugin-oversized-');
  const file = path.join(dir, 'p.mjs');
  fs.writeFileSync(file, `
    process.stdin.on('data', () => {});
    process.stdout.write(JSON.stringify({ type: 'log', level: 'info', text: 'x'.repeat(50000) }) + '\\n');
    setTimeout(() => {}, 1000);
  `);
  const plugin = startPlugin({ command: process.execPath, args: [file], env: { PATH: process.env.PATH }, maxLineBytes: 4096 });
  await new Promise((r) => setTimeout(r, 400));
  plugin.close();
  assert.ok(plugin.logs.some((l) => /discarded a \d+-byte frame/.test(l.text)),
    'oversized frames must be discarded, not parsed');
  assert.equal(plugin.logs.some((l) => l.text.length > 20000), false);
});

test('a hello frame carrying a pending id cannot resolve that request', async () => {
  const dir = tempDir('plugin-hello-forge-');
  const file = path.join(dir, 'p.mjs');
  fs.writeFileSync(file, `
    let buf = '';
    process.stdin.on('data', (c) => {
      buf += c.toString();
      let i = buf.indexOf('\\n');
      while (i !== -1) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1); i = buf.indexOf('\\n');
        if (!line.trim()) continue;
        const msg = JSON.parse(line);
        if (msg.type === 'request') {
          process.stdout.write(JSON.stringify({ type: 'hello', id: msg.id, protocol: 999 }) + '\\n');
          setTimeout(() => process.stdout.write(JSON.stringify({ type: 'result', id: msg.id, result: { real: true } }) + '\\n'), 150);
        }
      }
    });
  `);
  const plugin = startPlugin({ command: process.execPath, args: [file], env: { PATH: process.env.PATH } });
  const result = await plugin.request('complete', {}, { timeout: 5000 });
  plugin.close();
  assert.deepEqual(result, { real: true },
    'a forged handshake must not settle the request with undefined');
});

test('a child that closes stdin but stays alive is still killed on close', async () => {
  const dir = tempDir('plugin-orphan-');
  const file = path.join(dir, 'p.mjs');
  const marker = path.join(dir, 'alive.txt');
  fs.writeFileSync(file, `
    import fs from 'node:fs';
    setTimeout(() => { try { fs.closeSync(0); } catch {} }, 100);
    setInterval(() => { fs.writeFileSync(${JSON.stringify(marker)}, String(Date.now())); }, 40);
    setTimeout(() => process.exit(0), 5000);
  `);
  const plugin = startPlugin({ command: process.execPath, args: [file], env: { PATH: process.env.PATH } });
  await new Promise((r) => setTimeout(r, 400));
  assert.ok(fs.existsSync(marker), 'the child must actually be alive, or this test proves nothing');

  await plugin.request('ping', {}, { timeout: 300 }).catch(() => {});
  plugin.close({ graceMs: 100 });
  await new Promise((r) => setTimeout(r, 600));
  const afterClose = fs.readFileSync(marker, 'utf8');
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(fs.readFileSync(marker, 'utf8'), afterClose,
    'EPIPE must not leave the child running after close()');
});
