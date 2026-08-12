import { newName } from './src/a.mjs';
import { useIt } from './src/b.mjs';

if (typeof newName !== 'function') {
  console.error('newName not exported from a.mjs');
  process.exit(1);
}
if (useIt() !== 42 || newName() !== 42) {
  console.error('rename incomplete');
  process.exit(1);
}
console.log('ok');
process.exit(0);
