import { double, inc } from './src/math.mjs';

if (typeof double !== 'function') {
  console.error('double is not exported');
  process.exit(1);
}
if (double(3) !== 6 || double(0) !== 0) {
  console.error('double returned wrong value');
  process.exit(1);
}
if (inc(1) !== 2) {
  console.error('inc regressed');
  process.exit(1);
}
console.log('ok');
process.exit(0);
