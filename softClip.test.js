const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const vm = require('node:vm');

// Robustly load app.js by providing a mocked browser environment
const appJsContent = fs.readFileSync('app.js', 'utf8');

// Mocking the browser environment
const mockElement = () => ({
  getContext: () => ({
    imageSmoothingEnabled: false,
    fillRect: () => {},
    fillText: () => {},
    beginPath: () => {},
    arc: () => {},
    fill: () => {},
    stroke: () => {},
    moveTo: () => {},
    lineTo: () => {},
    closePath: () => {},
  }),
  appendChild: () => {},
  addEventListener: () => {},
  classList: {
    add: () => {},
    remove: () => {},
    toggle: () => {},
  },
  style: {},
  setAttribute: () => {},
  textContent: '',
  value: '',
});

const sandbox = {
  window: {
    addEventListener: () => {},
  },
  document: {
    getElementById: () => mockElement(),
    createElement: () => mockElement(),
    querySelectorAll: () => [],
    addEventListener: () => {},
  },
  localStorage: {
    getItem: () => null,
    setItem: () => {},
  },
  navigator: {
    clipboard: {
      writeText: async () => {},
    },
  },
  AudioContext: class {
    createGain() { return { gain: { value: 0, setTargetAtTime: () => {}, cancelScheduledValues: () => {} }, connect: () => {} }; }
    createDynamicsCompressor() { return { threshold: { value: 0 }, knee: { value: 0 }, ratio: { value: 0 }, attack: { value: 0 }, release: { value: 0 }, connect: () => {} }; }
    createOscillator() { return { frequency: { value: 0, cancelScheduledValues: () => {}, linearRampToValueAtTime: () => {} }, start: () => {}, connect: () => {}, type: '' }; }
    createBiquadFilter() { return { frequency: { value: 0, cancelScheduledValues: () => {}, exponentialRampToValueAtTime: () => {} }, Q: { value: 0, cancelScheduledValues: () => {}, setTargetAtTime: () => {} }, connect: () => {}, type: '' }; }
    createWaveShaper() { return { connect: () => {}, curve: null, oversample: '' }; }
    createBufferSource() { return { connect: () => {}, start: () => {}, addEventListener: () => {} }; }
    createBuffer() { return { getChannelData: () => new Float32Array(100) }; }
    get currentTime() { return 0; }
    get sampleRate() { return 44100; }
  },
  requestAnimationFrame: () => {},
  setInterval: () => {},
  clearInterval: () => {},
  Math,
  Float32Array,
  Uint8Array,
  Set,
  Map,
  Number,
  String,
  Boolean,
  Array,
  Error,
  RegExp,
  JSON,
  console,
};
sandbox.window = sandbox;

vm.createContext(sandbox);
// Overwrite window again to be sure it points to sandbox
sandbox.window = sandbox;
sandbox.addEventListener = () => {};
vm.runInContext(appJsContent, sandbox);

const softClip = sandbox.softClip;

test('softClip function', async (t) => {
  await t.test('returns 1.0 for values > 1.5', () => {
    assert.strictEqual(softClip(1.500001), 1.0);
    assert.strictEqual(softClip(2.0), 1.0);
    assert.strictEqual(softClip(100), 1.0);
  });

  await t.test('returns -1.0 for values < -1.5', () => {
    assert.strictEqual(softClip(-1.500001), -1.0);
    assert.strictEqual(softClip(-2.0), -1.0);
    assert.strictEqual(softClip(-100), -1.0);
  });

  await t.test('clamps at exactly 1.5 to 1.0 (or very close based on cubicAmount)', () => {
    // For x = 1.5 and default cubicAmount = 0.1481
    // 1.5 - 0.1481 * 1.5^3 = 1.0001625
    const valAt15 = softClip(1.5);
    assert.ok(valAt15 > 1.0, 'Value at 1.5 should be slightly above 1.0 with default cubicAmount');
    assert.strictEqual(softClip(1.500001), 1.0, 'Value just above 1.5 should be clamped to 1.0');
  });

  await t.test('returns 0 for input 0', () => {
    assert.strictEqual(softClip(0), 0);
  });

  await t.test('performs cubic clipping within range', () => {
    const x = 0.5;
    const cubicAmount = 0.1481;
    const expected = x - cubicAmount * x * x * x;
    assert.strictEqual(softClip(x), expected);
  });

  await t.test('respects custom cubicAmount', () => {
    const x = 1.0;
    const cubicAmount = 0.5;
    const expected = 1.0 - 0.5 * 1.0 * 1.0 * 1.0; // 0.5
    assert.strictEqual(softClip(x, cubicAmount), expected);
  });

  await t.test('boundary at -1.5', () => {
    // -1.5 - 0.1481 * (-1.5)^3 = -1.0001625
    assert.ok(softClip(-1.5) < -1.0);
    assert.strictEqual(softClip(-1.500001), -1.0);
  });
});
