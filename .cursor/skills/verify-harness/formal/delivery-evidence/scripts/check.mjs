import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { main } from '../../../../../../packages/ae/corpus/skills/create-primitive/assets/formal-verification/check.mjs';

const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../../..');
await main(process.argv.slice(2), { workspace, manifestPath: '.cursor/skills/verify-harness/formal/delivery-evidence/manifest.json' });
