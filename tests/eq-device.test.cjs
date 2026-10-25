'use strict';

// Only plain mocked stores are used. No browser, audio or HID API is opened.
const test = require('node:test');
const assert = require('node:assert/strict');
const { webcrypto } = require('node:crypto');
require('../eq-device.js');
const { createAdapter, profileFromPreset } = globalThis.DC04UEQDevice;
const copy = value => JSON.parse(JSON.stringify(value));
const draft = () => ({ name: 'Mock draft', preamp: -4.2, bands: [
  { frequency: 123.9, gain: 1.23, q: 0.7, type: 'peaking', enabled: true },
  { frequency: 7000, gain: 5, q: 1, type: 'highpass', enabled: false }
] });
const deviceProfile = value => ({ settingId: 7, name: 'Original', totalGain: -2,
  filterSettings: Array.from({ length: 10 }, (_, i) => ({ filterIndex: i, status: true, filterType: 2, frequency: 1000 + i, gain: value, factor: 0.7 })) });
function fixture(options = {}) {
  let milliseconds = 1000;
  let active = true;
  const writes = [], reads = [];
  const hardware = new Map([[7, deviceProfile(0)], [8, deviceProfile(1)], [9, deviceProfile(2)]]);
  for (const [id, profile] of hardware) profile.settingId = id;
  const controller = {
    slotCache: new Map([...hardware].map(([key, value]) => [key, copy(value)])),
    currentParametricEqualizer: copy(hardware.get(7)),
    getCurrentParametricEqualizer() { return this.slotCache.get(store.dc04u.eqIndex - 1) || this.currentParametricEqualizer; },
    async readSlotForEqIndex(index) {
      reads.push(index);
      if (options.onRead) await options.onRead(index);
      if (options.readErrorAfterApply && writes.length) throw new Error('Mock readback unavailable');
      this.currentParametricEqualizer = copy(hardware.get(index - 1));
      this.slotCache.set(index - 1, copy(this.currentParametricEqualizer));
    },
    async setEqualizer(index) { writes.push({ mode: index }); store.dc04u.eqIndex = index; },
    async setParametricEqualizer(profile, index) { writes.push({ profile: copy(profile), index }); hardware.set(index - 1, copy(profile)); }
  };
  const store = { isConnected: true, connectionState: 'CONNECTED', currentDevice: { vendorId: 0x0661, productId: 0x0883, name: 'DC04U' },
    controller, dc04u: { eqIndex: 8 }, updateDc04uState(value) { Object.assign(this.dc04u, value); } };
  const eq = {
    currentEqualizer: copy(hardware.get(7)),
    async applyPresetToSlot(profile, slot) {
      writes.push({ profile: copy(profile), slot });
      if (options.onApply) await options.onApply(profile, slot);
      if (options.rejectApply) return false;
      store.dc04u.eqIndex = slot + 7;
      const encoded = copy(profile);
      encoded.settingId = slot + 6;
      for (const band of encoded.filterSettings) { band.gain = Number(band.gain.toFixed(2)); band.factor = Number(band.factor.toFixed(2)); }
      if (options.corruptReadback) encoded.filterSettings[0].frequency += 1;
      hardware.set(slot + 6, encoded);
      this.currentEqualizer = copy(profile);
      return true;
    }
  };
  if (options.noReadback) delete controller.readSlotForEqIndex;
  const adapter = createAdapter({ getStores: () => ({ device: store, eq: options.fallback ? null : eq }), now: () => milliseconds,
    crypto: webcrypto, userActivated: () => active, delay: async () => {} });
  return { adapter, store, eq, controller, writes, reads, hardware, tick: n => { milliseconds += n; }, activate: value => { active = value; } };
}
async function reviewed(f, slot = 2) {
  const stage = f.adapter.stage({ preset: draft(), slot });
  const review = await f.adapter.review({ stageId: stage.stageId });
  return { stage, review, confirmation: { reviewToken: review.reviewToken, digest: review.digest } };
}
const code = expected => error => error.code === expected;

test('status, store read and draft staging never call official hardware methods', async () => {
  const f = fixture();
  assert.equal(f.adapter.status().connected, true);
  assert.equal((await f.adapter.read()).preset.bands.length, 10);
  const staged = f.adapter.stage({ preset: draft(), slot: 2 });
  assert.equal(staged.hardwareWrites, 0);
  assert.deepEqual(f.writes, []);
  assert.deepEqual(f.reads, []);
});

test('quantization matches the official transport, with conservative integer preamp', () => {
  const { profile, quantization } = profileFromPreset(draft());
  assert.equal(profile.totalGain, -5);
  assert.equal(profile.filterSettings[0].frequency, 124);
  assert.equal(profile.filterSettings[0].gain, 315 / 256);
  assert.equal(profile.filterSettings[0].factor, 179 / 256);
  assert.equal(profile.filterSettings.length, 10);
  assert.equal(profile.filterSettings[1].filterType, 2);
  assert.equal(profile.filterSettings[1].gain, 0);
  assert.equal(quantization.paddedBands, 8);
});

test('unsupported notch, excessive bands and invalid numeric inputs reject without hardware', () => {
  const f = fixture();
  const invalid = [
    { ...draft(), bands: [{ ...draft().bands[0], type: 'notch' }] },
    { ...draft(), bands: Array.from({ length: 11 }, () => draft().bands[0]) },
    { ...draft(), bands: [{ ...draft().bands[0], frequency: NaN }] },
    { ...draft(), bands: [{ ...draft().bands[0], q: 21 }] },
    { ...draft(), preamp: Infinity }
  ];
  for (const preset of invalid) assert.throws(() => f.adapter.stage({ preset, slot: 1 }));
  assert.throws(() => f.adapter.stage({ preset: draft(), slot: 4 }), code('INVALID_SLOT'));
  assert.equal(f.writes.length, 0);
});

test('review requires a fresh manual activation and performs only read-only backups', async () => {
  const f = fixture();
  const stage = f.adapter.stage({ preset: draft(), slot: 2 });
  f.activate(false);
  await assert.rejects(f.adapter.review({ stageId: stage.stageId }), code('MANUAL_ACTION_REQUIRED'));
  f.activate(true);
  const review = await f.adapter.review({ stageId: stage.stageId });
  assert.deepEqual(f.reads, [8, 9]);
  assert.equal(review.backups.current.verified, true);
  assert.equal(review.backups.target.verified, true);
  assert.equal(review.backups.target.profile.filterSettings[0].gain, 1);
  assert.equal(review.expiresAt, 121000);
  assert.equal(f.writes.length, 0);
});

test('commit needs its own manual activation and a matching single-use review', async () => {
  const f = fixture();
  const { confirmation } = await reviewed(f);
  f.activate(false);
  await assert.rejects(f.adapter.commit(confirmation), code('MANUAL_ACTION_REQUIRED'));
  assert.equal(f.writes.length, 0);
  f.activate(true);
  const result = await f.adapter.commit(confirmation);
  assert.equal(result.state, 'verified');
  assert.equal(result.verified, true);
  assert.equal(f.writes.length, 1);
  assert.equal(f.writes[0].slot, 2);
  await assert.rejects(f.adapter.commit(confirmation), code('REVIEW_REQUIRED'));
  assert.equal(f.writes.length, 1);
});

test('readback comparison accounts for the official reader rounding gain and Q to two decimals', async () => {
  const f = fixture();
  const { confirmation } = await reviewed(f);
  const result = await f.adapter.commit(confirmation);
  assert.equal(result.profile.filterSettings[0].gain, 315 / 256);
  assert.equal(result.readback.filterSettings[0].gain, 1.23);
  assert.equal(result.state, 'verified');
});

test('altered digest consumes confirmation without applying', async () => {
  const f = fixture();
  const { confirmation } = await reviewed(f);
  await assert.rejects(f.adapter.commit({ ...confirmation, digest: 'wrong' }), code('REVIEW_MISMATCH'));
  await assert.rejects(f.adapter.commit(confirmation), code('REVIEW_REQUIRED'));
  assert.equal(f.writes.length, 0);
});

test('expired stage/review tokens cannot apply', async () => {
  const f = fixture();
  const { stage, confirmation } = await reviewed(f);
  f.tick(120000);
  await assert.rejects(f.adapter.commit(confirmation), code('REVIEW_EXPIRED'));
  f.tick(300000);
  await assert.rejects(f.adapter.review({ stageId: stage.stageId }), code('STAGE_EXPIRED'));
  assert.equal(f.writes.length, 0);
});

test('a changed device, disconnected session or changed mode requires a new review', async () => {
  for (const mutate of [f => { f.store.currentDevice = { ...f.store.currentDevice }; }, f => { f.store.isConnected = false; f.store.connectionState = 'DISCONNECTED'; }, f => { f.store.dc04u.eqIndex = 10; }]) {
    const f = fixture();
    const { confirmation } = await reviewed(f);
    mutate(f);
    await assert.rejects(f.adapter.commit(confirmation));
    assert.equal(f.writes.length, 0);
  }
});

test('wrong target model cannot be reviewed or applied', async () => {
  const f = fixture();
  f.store.currentDevice.productId = 2177;
  const stage = f.adapter.stage({ preset: draft(), slot: 1 });
  assert.equal(f.adapter.status().connected, false);
  await assert.rejects(f.adapter.review({ stageId: stage.stageId }), code('DEVICE_UNAVAILABLE'));
  assert.deepEqual(f.reads, []);
  assert.deepEqual(f.writes, []);
});

test('a failed official apply is reported once and never retried automatically', async () => {
  const f = fixture({ rejectApply: true });
  const { confirmation } = await reviewed(f);
  await assert.rejects(f.adapter.commit(confirmation), error => error.code === 'APPLY_REJECTED' && error.details.possiblyApplied && error.details.automaticRetry === false);
  await assert.rejects(f.adapter.commit(confirmation), code('REVIEW_REQUIRED'));
  assert.equal(f.writes.length, 1);
});

test('missing or failed readback reports submitted-unverified rather than success', async () => {
  for (const options of [{ noReadback: true }, { readErrorAfterApply: true }]) {
    const f = fixture(options);
    const { confirmation, review } = await reviewed(f);
    const result = await f.adapter.commit(confirmation);
    assert.equal(result.state, 'submitted-unverified');
    assert.equal(result.verified, false);
    assert.ok(result.warning);
    if (options.noReadback) assert.equal(review.backups.target.verified, false);
  }
});

test('a mismatched readback fails verification without replay or rollback', async () => {
  const f = fixture({ corruptReadback: true });
  const { confirmation } = await reviewed(f);
  await assert.rejects(f.adapter.commit(confirmation), error => error.code === 'VERIFY_MISMATCH' && error.details.possiblyApplied);
  assert.equal(f.writes.length, 1);
});

test('controller fallback uses official mode/apply methods and the chosen custom slot', async () => {
  const f = fixture({ fallback: true });
  const { confirmation } = await reviewed(f, 3);
  const result = await f.adapter.commit(confirmation);
  assert.equal(f.writes[0].mode, 10);
  assert.equal(f.writes[1].index, 10);
  assert.equal(result.state, 'verified');
});

test('read-only operations serialize and never queue a second review', async () => {
  let release;
  const wait = new Promise(resolve => { release = resolve; });
  const f = fixture({ onRead: () => wait });
  const stage = f.adapter.stage({ preset: draft(), slot: 2 });
  const pending = f.adapter.review({ stageId: stage.stageId });
  await Promise.resolve();
  assert.equal(f.adapter.status().busy, 'review');
  await assert.rejects(f.adapter.review({ stageId: stage.stageId }), code('BUSY'));
  release();
  await pending;
  assert.equal(f.adapter.status().busy, null);
  assert.equal(f.writes.length, 0);
});

test('disconnect during an in-flight official apply aborts follow-up verification and reports uncertainty', async () => {
  let release;
  const wait = new Promise(resolve => { release = resolve; });
  const f = fixture({ onApply: () => wait });
  const { confirmation } = await reviewed(f);
  const readsBefore = f.reads.length;
  const pending = f.adapter.commit(confirmation);
  await Promise.resolve();
  f.adapter.disconnect();
  f.store.isConnected = false;
  f.store.connectionState = 'DISCONNECTED';
  release();
  await assert.rejects(pending, error => error.details.possiblyApplied === true && error.details.automaticRetry === false);
  assert.equal(f.reads.length, readsBefore);
  assert.equal(f.writes.length, 1);
});

test('returned draft/review objects cannot mutate the staged hardware profile', async () => {
  const f = fixture();
  const { stage, review, confirmation } = await reviewed(f);
  stage.profile.filterSettings[0].gain = 12;
  review.profile.filterSettings[0].gain = 12;
  await f.adapter.commit(confirmation);
  assert.equal(f.writes[0].profile.filterSettings[0].gain, 315 / 256);
});

test('default feature detection finds only the existing official Pinia stores without importing or connecting', () => {
  const previous = globalThis.document;
  const f = fixture();
  globalThis.document = { querySelector: () => ({ __vue_app__: { config: { globalProperties: { $pinia: { _s: new Map([['device', f.store], ['eq', f.eq]]) } } } } }) };
  try {
    const adapter = createAdapter({ crypto: webcrypto });
    assert.equal(adapter.status().connected, true);
    assert.equal(f.writes.length, 0);
    assert.equal(f.reads.length, 0);
  } finally { globalThis.document = previous; }
});
