'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const eq = require('../eq-math.js');

const close = (actual, expected, tolerance = 1e-7) => assert.ok(Math.abs(actual - expected) <= tolerance,
  `Expected ${actual} to be within ${tolerance} of ${expected}`);
const band = (type = 'peaking', frequency = 1000, gain = 6, q = 1) => ({ type, frequency, gain, q, enabled: true });
const curve = (frequencies, values) => frequencies.map((frequency, index) => ({ frequency, db: values[index] }));

test('the same pure module is available as a browser global and a CommonJS export', () => {
  const context = vm.createContext({});
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'eq-math.js'), 'utf8'), context);
  assert.equal(typeof context.DC04UEqMath.fit, 'function');
  assert.equal(typeof eq.fit, 'function');
});

test('logarithmic frequency grids retain exact endpoints and equal octave steps', () => {
  const grid = eq.frequencyGrid(4, 20, 160);
  assert.equal(grid[0], 20); assert.equal(grid[3], 160);
  close(grid[1], 40); close(grid[2], 80);
});

test('a peaking filter has its specified gain at its center for every supported sample rate', () => {
  for (const sampleRate of [44100, 48000, 96000, 192000]) {
    close(eq.response([band('peaking', 1000, 6, 1.2)], [1000], sampleRate)[0], 6);
  }
});

test('an equal boost and cut cancel across the spectrum, including at high sample rate', () => {
  for (const sampleRate of [44100, 192000]) {
    const grid = eq.frequencyGrid(300);
    const result = eq.response([band('peaking', 300, 9, 2), band('peaking', 300, -9, 2)], grid, sampleRate);
    result.forEach(value => close(value, 0, 1e-6));
  }
});

test('zero-gain peaks and shelves are unity and disabled filters have no response', () => {
  const grid = eq.frequencyGrid();
  for (const type of ['peaking', 'lowshelf', 'highshelf']) {
    eq.response([band(type, 1000, 0)], grid).forEach(value => close(value, 0));
  }
  eq.response([{ ...band('lowpass', 200), enabled: false }], grid).forEach(value => close(value, 0));
});

test('shelf limits and midpoint gains have the correct orientation', () => {
  const low = eq.response([band('lowshelf', 1000, 8, Math.SQRT1_2)], [0, 1000, 24000]);
  const high = eq.response([band('highshelf', 1000, 8, Math.SQRT1_2)], [0, 1000, 24000]);
  close(low[0], 8); close(low[1], 4); close(low[2], 0);
  close(high[0], 0); close(high[1], 4); close(high[2], 8);
});

test('low/high pass cutoff, passband and rejected endpoints follow Butterworth behavior', () => {
  const low = eq.response([band('lowpass', 1000, 0, Math.SQRT1_2)], [0, 1000, 24000]);
  const high = eq.response([band('highpass', 1000, 0, Math.SQRT1_2)], [0, 1000, 24000]);
  close(low[0], 0); close(low[1], -10 * Math.log10(2)); assert.ok(low[2] < -100);
  close(high[2], 0); close(high[1], -10 * Math.log10(2)); assert.ok(high[0] < -100);
});

test('bandpass, notch and allpass are distinct rather than interchangeable', () => {
  close(eq.response([band('bandpass', 1000)], [1000])[0], 0);
  assert.ok(eq.response([band('notch', 1000)], [1000])[0] < -100);
  eq.response([band('allpass', 1000)], eq.frequencyGrid()).forEach(value => close(value, 0));
});

test('the ten-band cascade equals the sum in dB and includes preamp exactly once', () => {
  const bands = Array.from({ length: 10 }, (_, index) => band('peaking', 40 * 2 ** (index * 0.8), index % 2 ? -3 : 3));
  const frequencies = [80, 1000, 8000];
  const separate = bands.map(filter => eq.response([filter], frequencies));
  const combined = eq.response({ bands, preamp: -7 }, frequencies);
  combined.forEach((value, index) => close(value, separate.reduce((sum, trace) => sum + trace[index], -7)));
  assert.deepEqual(eq.response({ bands: bands.slice().reverse(), preamp: -7 }, frequencies).map(value => value.toFixed(8)), combined.map(value => value.toFixed(8)));
});

test('stable biquad poles stay inside the unit circle throughout practical device settings', () => {
  for (const type of eq.TYPES) for (const frequency of [20, 1000, 20000]) for (const q of [0.3, 4, 20]) {
    const c = eq.biquad(band(type, frequency, 12, q), 44100);
    // Jury stability criterion for a real monic second-order denominator.
    assert.ok(1 + c.a1 + c.a2 > 0);
    assert.ok(1 - c.a1 + c.a2 > 0);
    assert.ok(1 - c.a2 > 0);
  }
});

test('invalid or Nyquist filter parameters are rejected instead of producing NaN charts', () => {
  assert.throws(() => eq.biquad(band('peaking', 24000)), /Nyquist/);
  assert.throws(() => eq.biquad(band('peaking', 1000, 6, 0)), /positive/);
  assert.throws(() => eq.response([], [1000], NaN), /finite/);
  assert.throws(() => eq.response([], [25000]), /Nyquist/);
});

test('curve interpolation operates on log frequency and normalization removes only level', () => {
  const input = [{ frequency: 100, db: 2 }, { frequency: 10000, db: 10 }];
  close(eq.interpolateCurve(input, [1000])[0].db, 6);
  assert.deepEqual(eq.normalizeCurve(input, 1000), [{ frequency: 100, db: -4 }, { frequency: 10000, db: 4 }]);
});

test('target correction has target minus measured sign and ignores arbitrary SPL offsets', () => {
  const measured = { frequency: [100, 1000, 10000], raw: [85, 90, 85] };
  const target = { frequency: [100, 1000, 10000], raw: [102, 100, 103] };
  const correction = eq.targetDifference(measured, target, { frequencies: [100, 1000, 10000] });
  assert.deepEqual(correction.map(point => point.db), [7, 0, 8]);
});

test('bad measurement arrays, nonfinite points and disjoint domains fail explicitly', () => {
  assert.throws(() => eq.canonicalCurve({ frequency: [100, 1000], raw: [1] }), /length/);
  assert.throws(() => eq.canonicalCurve([[100, NaN], [1000, 0]]), /finite/);
  assert.throws(() => eq.targetDifference([[20, 0], [100, 0]], [[1000, 0], [10000, 0]], { normalize: false }), /overlapping/);
});

test('device quantization respects signed gain, Q and whole-Hz/whole-dB encoding', () => {
  const result = eq.quantizePreset({ preamp: -3.8, bands: [band('peaking', 999.7, -1.501, 0.701)] });
  assert.equal(result.bands.length, 10);
  assert.equal(result.bands[0].frequency, 1000);
  assert.equal(result.bands[0].gain, -384 / 256);
  assert.equal(result.bands[0].q, 179 / 256);
  assert.equal(result.preamp, -4, 'negative fractions round toward greater attenuation');
  assert.equal(result.bands[1].enabled, false);
});

test('in-range quantization errors are bounded and preamp export uses the official range', () => {
  for (const frequency of [20, 31.25, 1000.499, 19999.8]) for (const q of [0.3, 0.7071, 4.999, 20]) {
    const input = band('peaking', frequency, -2.501, q);
    const output = eq.quantizePreset({ bands: [input] }).bands[0];
    assert.ok(Math.abs(output.frequency - frequency) <= 0.5);
    assert.ok(Math.abs(output.gain - input.gain) <= 1 / 512 + 1e-12);
    assert.ok(Math.abs(output.q - q) <= 1 / 512 + 1e-12);
  }
  assert.equal(eq.quantizePreset({ preamp: -100, bands: [] }).preamp, -24);
  assert.equal(eq.quantizePreset({ preamp: 20, bands: [] }).preamp, 12);
  assert.equal(JSON.parse(eq.formatOfficialJSON({ preamp: -4.2, bands: [] })).totalGain, -5);
});

test('official JSON uses the verified type map and truly disables bands with type zero', () => {
  const preset = { name: 'Test', preamp: -8, bands: [band('lowshelf'), band('peaking'), band('highshelf'),
    band('lowpass'), band('highpass'), band('bandpass'), band('allpass'), { ...band(), enabled: false }] };
  const object = JSON.parse(eq.formatOfficialJSON(preset));
  assert.deepEqual(object.filterSettings.slice(0, 8).map(filter => filter.filterType), [1, 2, 3, 4, 5, 6, 7, 0]);
  assert.equal(object.filterSettings[7].status, false);
  const read = eq.parseOfficialJSON(object);
  assert.equal(read.bands[5].type, 'bandpass');
  assert.equal(read.bands[7].enabled, false);
  assert.equal(read.preamp, -8);
  assert.equal(read.bands.length, 10);
});

test('an offline notch cannot be silently exported as DC04U bandpass', () => {
  assert.throws(() => eq.formatOfficialJSON({ bands: [band('notch')] }), /no verified notch/);
});

test('official JSON imports by filterIndex and rejects duplicate indices', () => {
  const object = JSON.parse(eq.formatOfficialJSON({ bands: [band('highshelf', 3000), band('peaking', 200)] }));
  object.filterSettings.reverse();
  const result = eq.parseOfficialJSON(object);
  assert.equal(result.bands[0].type, 'highshelf'); assert.equal(result.bands[1].frequency, 200);
  object.filterSettings[0].filterIndex = object.filterSettings[1].filterIndex;
  assert.throws(() => eq.parseOfficialJSON(object), /unique/);
});

test('AutoEq text roundtrips shelf, peak, disabled state and fractional preamp', () => {
  const text = 'Preamp: -6.2 dB\nFilter 1: ON LSC Fc 105 Hz Gain 3 dB Q 0.7\nFilter 2: ON PK Fc 1250 Hz Gain -4.5 dB Q 2.1\nFilter 3: OFF HSC Fc 8000 Hz Gain 2 dB Q 0.707';
  const first = eq.parseAutoEq(text), second = eq.parseAutoEq(eq.formatAutoEq(first));
  assert.equal(first.preamp, -6.2);
  assert.equal(first.bands[0].type, 'lowshelf');
  assert.equal(first.bands[2].enabled, false);
  assert.equal(second.preamp, first.preamp);
  first.bands.forEach((filter, index) => {
    const roundtripped = second.bands[index];
    assert.equal(roundtripped.type, filter.type);
    assert.equal(roundtripped.enabled, filter.enabled);
    close(roundtripped.frequency, filter.frequency, 1e-8);
    close(roundtripped.gain, filter.gain, 1e-8);
    close(roundtripped.q, filter.q, 1e-8);
  });
});

test('unsupported AutoEq lines and too many filters cannot be silently discarded', () => {
  assert.throws(() => eq.parseAutoEq('GraphicEQ: 20 0; 100 1'), /Unrecognized/);
  assert.throws(() => eq.parseAutoEq(Array.from({ length: 11 }, (_, i) => `Filter ${i + 1}: ON PK Fc 1000 Hz Gain 1 dB Q 1`).join('\n')), /at most ten/);
});

test('identical normalized curves produce ten disabled bands and no gratuitous boost', () => {
  const frequencies = eq.frequencyGrid(100);
  const measured = curve(frequencies, frequencies.map(frequency => Math.log2(frequency / 1000)));
  const result = eq.fit(measured, measured);
  assert.equal(result.bands.length, 10);
  assert.equal(result.bands.filter(filter => filter.enabled).length, 0);
  assert.equal(result.preamp, 0);
  close(result.metrics.afterRmse, 0);
});

test('bounded auto-fit substantially reduces broad spectral errors after hardware quantization', () => {
  const frequencies = eq.frequencyGrid(240);
  const desired = eq.response([band('lowshelf', 120, 4, 0.707), band('peaking', 1800, -5, 1.1), band('highshelf', 5000, 2, 0.707)], frequencies);
  const result = eq.fit(curve(frequencies, frequencies.map(() => 0)), curve(frequencies, desired));
  assert.equal(result.bands.length, 10);
  assert.ok(result.metrics.afterRmse < result.metrics.beforeRmse * 0.35,
    `before ${result.metrics.beforeRmse}, after ${result.metrics.afterRmse}`);
  assert.ok(result.bands.filter(filter => filter.enabled).every(filter => filter.q <= 4 && filter.gain <= 6 && filter.gain >= -12));
  assert.equal(result.metrics.includesPreamp, false);
  assert.ok(result.metrics.peakBoostDb + result.preamp <= 0);
  assert.equal(result.preamp, Math.trunc(result.preamp));
});

test('auto-fit remains deterministic and does not use narrow filters to chase a treble spike', () => {
  const frequencies = eq.frequencyGrid(160);
  const target = curve(frequencies, frequencies.map(frequency => 12 * Math.exp(-(Math.log2(frequency / 11000) ** 2) / 0.001)));
  const measured = curve(frequencies, frequencies.map(() => 0));
  const first = eq.fit(measured, target, { maxFilters: 4 });
  const second = eq.fit(measured, target, { maxFilters: 4 });
  assert.deepEqual(first, second);
  assert.ok(first.bands.filter(filter => filter.enabled).every(filter => filter.q <= 4));
  assert.ok(first.metrics.smoothingOctaves >= 1 / 3);
});
