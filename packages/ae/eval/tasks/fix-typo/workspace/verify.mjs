import { greet } from './src/greet.mjs';

const out = greet('world');
if (out !== 'Hello, world!') {
  console.error('expected Hello, world! got', JSON.stringify(out));
  process.exit(1);
}
console.log('ok');
process.exit(0);
