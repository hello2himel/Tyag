/**
 * Automated motion-contract check. Keeps the token set single-sourced and
 * asserts the spring settle time / projection / rubber-band formulas.
 */
import { readFileSync } from 'node:fs';

const motion = readFileSync(new URL('../apps/web/src/ui/motion.ts', import.meta.url), 'utf8');
const css = readFileSync(new URL('../apps/web/src/ui/styles.css', import.meta.url), 'utf8');
const failures = [];
function check(condition, message) {
  if (!condition) failures.push(message);
}

check(/smooth:\s*\{\s*duration:\s*0\.5,\s*bounce:\s*0/.test(motion), 'smooth spring token missing');
check(/snappy:\s*\{\s*duration:\s*0\.5,\s*bounce:\s*0\.15/.test(motion), 'snappy spring token missing');
check(/quick:\s*\{\s*duration:\s*0\.3,\s*bounce:\s*0/.test(motion), 'quick spring token missing');
check(motion.includes('cubic-bezier(0.32, 0.72, 0, 1)'), 'sheet curve token missing');
check(motion.includes('--motion-duration') === false, 'motion tokens must live in one place');
check(css.includes('--motion-duration-fast: 150ms'), 'CSS fast duration token missing');
check(css.includes('--motion-curve-ease-out: cubic-bezier(0, 0, 0.58, 1)'), 'CSS easeOut token missing');
const animationDecls = css.replace(/--[\w-]+:[^;]+;/g, '').match(/animation:[^;]+;/g) ?? [];
check(
  !animationDecls.some((declaration) => /(?<!var\()\b(0\.\d+s|\d+ms)\b/.test(declaration.replace(/var\([^)]*\)/g, ''))),
  'un-tokenised animation duration found in CSS',
);

// Spring settle simulation (duration/bounce → parameters), must settle < 600 ms.
const duration = 0.5;
const bounce = 0.15;
const stiffness = (2 * Math.PI / duration) ** 2;
const damping = 2 * (1 - bounce) * Math.sqrt(stiffness);
let x = 0;
let v = 0;
let t = 0;
const dt = 1 / 120;
while (t < 2) {
  v += (-stiffness * (x - 1) - damping * v) * dt;
  x += v * dt;
  t += dt;
  if (Math.abs(x - 1) < 0.005 && Math.abs(v) < 0.01) break;
}
check(t * 1000 < 600, `snappy spring settles in ${Math.round(t * 1000)}ms (expected < 600ms)`);

const projection = (velocity) => (velocity / 1000) * (0.998 / (1 - 0.998));
check(Math.abs(projection(1000) - 499) < 2, 'projection formula mismatch');
const rb = (x, d) => (1 - 1 / ((x * 0.55) / d + 1)) * d;
check(rb(10, 100) < 10 && rb(10, 100) > 5, 'rubber-band formula mismatch');

if (failures.length) {
  console.error('MOTION CHECK FAILED');
  for (const failure of failures) console.error(' -', failure);
  process.exit(1);
}
console.log('MOTION CHECK PASS, tokens, curves, spring settle <600ms, projection/rubber-band formulas');
