const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// Read app.js
const appCode = fs.readFileSync(path.join(__dirname, '../app.js'), 'utf8');

// Instead of executing the entire app.js, we can just extract the `clamp` function and run it.
// It's a pure function, so this is much cleaner and avoids the need for massive mock contexts.
const match = appCode.match(/function clamp\s*\([^)]*\)\s*\{[\s\S]*?\}/);
if (!match) {
  throw new Error('Could not find clamp function in app.js');
}
const clampCode = match[0];

const context = { Math };
vm.createContext(context);
vm.runInContext(clampCode + '\nthis.clamp = clamp;', context);

const clamp = context.clamp;

describe('clamp function', () => {
  test('returns the value when it is within min and max', () => {
    assert.strictEqual(clamp(5, 0, 10), 5);
  });

  test('returns min when the value is below min', () => {
    assert.strictEqual(clamp(-5, 0, 10), 0);
  });

  test('returns max when the value is above max', () => {
    assert.strictEqual(clamp(15, 0, 10), 10);
  });

  test('handles negative boundaries correctly', () => {
    assert.strictEqual(clamp(-15, -20, -10), -15);
    assert.strictEqual(clamp(-25, -20, -10), -20);
    assert.strictEqual(clamp(-5, -20, -10), -10);
  });

  test('handles decimal values correctly', () => {
    assert.strictEqual(clamp(5.5, 0, 10), 5.5);
    assert.strictEqual(clamp(-0.1, 0, 10), 0);
    assert.strictEqual(clamp(10.1, 0, 10), 10);
  });

  test('handles cases where min and max are the same', () => {
    assert.strictEqual(clamp(5, 10, 10), 10);
    assert.strictEqual(clamp(15, 10, 10), 10);
    assert.strictEqual(clamp(10, 10, 10), 10);
  });
});
