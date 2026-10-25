'use strict';

// Offline only: no browser, audio output or real HID device is used here.
const test = require('node:test');
const assert = require('node:assert/strict');
require('../guard-core.js');
const { createGate } = globalThis.DC04UGuardCore;

const target = () => ({ vendorId: 1633, productId: 2179, productName: 'iBasso DC04U' });
const reportId = 75;

// These bytes are fixtures of the observed DC04U protocol, deliberately kept
// independent of the implementation's exported constants or encoder.
function volume(left, right = left) {
  const bytes = new Uint8Array(63);
  bytes.set([1, 63, 8, 1, 16, left, right]);
  return bytes;
}

function setting(prefix) {
  const bytes = new Uint8Array(63);
  bytes.set(prefix);
  return bytes;
}

function ordinarySettings() {
  return [
    setting([1, 63, 8, 0x11, 0x20, 2, 8, 1]),
    setting([1, 63, 8, 0x19, 0x30, 1, 3, 2]),
    setting([1, 63, 8, 0x19, 0x40, 1, 2, 4, 0, 1]),
    setting([1, 63, 8, 0x21, 0x50, 1, 1, 0, 1, 2]),
  ];
}

function equalizerWrites(slot = 7) {
  const bands = Array.from({ length: 10 }, (_, band) => {
    const bytes = setting([1, 9, 31, slot, band]);
    const data = new DataView(bytes.buffer);
    data.setUint16(27, 100 * (band + 1), true);
    data.setUint16(29, 256, true);
    data.setInt16(31, band % 2 ? -256 : 256, true);
    bytes[33] = band % 8;
    bytes[34] = 246; // Signed -10 dB preamp, encoded by the official controller.
    return bytes;
  });
  return [...bands, setting([1, 10, 4, slot, 0, 255, 255]), setting([1, 1, 4, 0, 0, 2])];
}

function setup(left = 20, right = left, configure = true) {
  let milliseconds = 10_000;
  const gate = createGate({ now: () => milliseconds });
  const device = target();
  if (configure) gate.configure({ version: 1, jumpThreshold: 30 });
  gate.observe(device, left, right);
  return {
    gate, device,
    tick: (delta) => { milliseconds += delta; },
    write: (nextLeft, nextRight = nextLeft) => gate.prepare(device, reportId, volume(nextLeft, nextRight)),
  };
}

function blocked(action, expectedCode) {
  assert.throws(action, (error) => {
    assert.ok(error instanceof Error, 'blocked operations reject with an Error');
    assert.equal(typeof error.code, 'string', 'blocked operations expose a machine-readable code');
    assert.ok(error.code.length > 0);
    if (expectedCode) assert.equal(error.code, expectedCode);
    return true;
  });
}

function accepted(action, expected) {
  const result = action();
  assert.equal(typeof result.kind, 'string');
  assert.deepEqual(Array.from(result.bytes), Array.from(expected));
  return result;
}

test('70 → 100 is permitted: there is no fixed ceiling below 100', () => {
  const fixture = setup(70);
  accepted(() => fixture.write(100), volume(100));
});

test('67 → 100 is rejected because the increase of 33 exceeds 30', () => {
  const fixture = setup(67);
  blocked(() => fixture.write(100), 'JUMP_TOO_LARGE');
});

test('an upward change of exactly 30 is permitted', () => {
  const fixture = setup(20);
  accepted(() => fixture.write(50), volume(50));
});

test('an upward change of 31 is rejected', () => {
  const fixture = setup(20);
  blocked(() => fixture.write(51), 'JUMP_TOO_LARGE');
});

test('0 → 100 is rejected', () => {
  const fixture = setup(0);
  blocked(() => fixture.write(100), 'JUMP_TOO_LARGE');
});

test('all downward changes, including 100 → 0, are permitted', () => {
  const fixture = setup(100);
  accepted(() => fixture.write(0), volume(0));
});

test('each channel uses its own baseline, and either excessive increase rejects the packet', () => {
  const fixture = setup(20, 60);
  accepted(() => fixture.write(50, 90), volume(50, 90));
  const leftUnsafe = setup(20, 60);
  blocked(() => leftUnsafe.write(51, 60));
  const rightUnsafe = setup(60, 20);
  blocked(() => rightUnsafe.write(60, 51));
});

test('configuration must be ready before target writes can pass', () => {
  const fixture = setup(20, 20, false);
  blocked(() => fixture.write(21), 'NOT_CONFIGURED');
  fixture.gate.configure({ version: 1, jumpThreshold: 30 });
  accepted(() => fixture.write(21), volume(21));
});

test('without a known device baseline even a small write is rejected', () => {
  const gate = createGate({ now: () => 10_000 });
  gate.configure({ version: 1, jumpThreshold: 30 });
  const device = target();
  blocked(() => gate.prepare(device, reportId, volume(1)), 'BASELINE_REQUIRED');
});

test('a native send failure invalidates the baseline until it is observed again', () => {
  const fixture = setup(20);
  accepted(() => fixture.write(40), volume(40));
  fixture.gate.failed(fixture.device);
  blocked(() => fixture.write(41), 'BASELINE_REQUIRED');
  fixture.gate.observe(fixture.device, 20, 20);
  accepted(() => fixture.write(40), volume(40));
});

test('typed-array subviews use exactly their byteOffset and byteLength', () => {
  const fixture = setup(20);
  const backing = new Uint8Array(100).fill(255);
  backing.set(volume(25), 17);
  const view = backing.subarray(17, 80);
  accepted(() => fixture.gate.prepare(fixture.device, reportId, view), volume(25));
});

test('DataView subviews and ArrayBuffer are supported', () => {
  const dataViewFixture = setup(20);
  const backing = new Uint8Array(80).fill(255);
  backing.set(volume(25), 9);
  accepted(() => dataViewFixture.gate.prepare(dataViewFixture.device, reportId,
    new DataView(backing.buffer, 9, 63)), volume(25));
  const arrayBufferFixture = setup(20);
  accepted(() => arrayBufferFixture.gate.prepare(arrayBufferFixture.device, reportId,
    volume(25).buffer), volume(25));
});

test('prepared bytes cannot be changed by mutating the caller’s original buffer', () => {
  const fixture = setup(20);
  const input = volume(25);
  const result = fixture.gate.prepare(fixture.device, reportId, input);
  input.fill(255);
  assert.deepEqual(Array.from(result.bytes), Array.from(volume(25)));
});

test('malformed report length, ID, header, and unknown command fail closed', () => {
  const fixture = setup(20);
  blocked(() => fixture.gate.prepare(fixture.device, reportId, new Uint8Array(62)));
  blocked(() => fixture.gate.prepare(fixture.device, reportId, new Uint8Array(64)));
  blocked(() => fixture.gate.prepare(fixture.device, 0, volume(25)));
  const badHeader = volume(25); badHeader[0] = 255;
  blocked(() => fixture.gate.prepare(fixture.device, reportId, badHeader));
  const unknown = volume(25); unknown[3] = 255; unknown[4] = 255;
  blocked(() => fixture.gate.prepare(fixture.device, reportId, unknown));
});

test('volume packets with unexpected trailing data cannot bypass through the settings whitelist', () => {
  const fixture = setup(20);
  const malformed = volume(100);
  malformed[7] = 1;
  blocked(() => fixture.gate.prepare(fixture.device, reportId, malformed), 'COMMAND_BLOCKED');
});

test('all four official ordinary-setting packet groups pass without a volume baseline', () => {
  const gate = createGate({ now: () => 10_000 });
  gate.configure({ version: 1, jumpThreshold: 30 });
  const device = target();
  for (const bytes of ordinarySettings()) {
    const result = accepted(() => gate.prepare(device, reportId, bytes), bytes);
    assert.equal(result.kind, 'setting');
    assert.equal(gate.getState(device).baseline, null);
  }
});

test('known settings do not depend on volume guard configuration being ready', () => {
  const gate = createGate({ now: () => 10_000 });
  const device = target();
  const bytes = ordinarySettings()[0];
  assert.equal(accepted(() => gate.prepare(device, reportId, bytes), bytes).kind, 'setting');
  blocked(() => gate.prepare(device, reportId, volume(21)), 'NOT_CONFIGURED');
});

test('the complete official ten-band EQ, mask and save chain passes unchanged for every custom slot', () => {
  const gate = createGate({ now: () => 10_000 });
  gate.configure({ version: 1, jumpThreshold: 30 });
  const device = target();
  for (const slot of [7, 8, 9]) {
    const writes = equalizerWrites(slot);
    assert.equal(writes.length, 12);
    for (const bytes of writes) {
      assert.equal(accepted(() => gate.prepare(device, reportId, bytes), bytes).kind, 'setting');
    }
  }
  assert.equal(gate.getState(device).baseline, null);
});

test('setting packets are copied with DataView offsets and cannot alias caller memory', () => {
  const fixture = setup();
  const expected = ordinarySettings()[1];
  const backing = new Uint8Array(90).fill(255);
  backing.set(expected, 11);
  const result = fixture.gate.prepare(fixture.device, reportId, new DataView(backing.buffer, 11, 63));
  assert.equal(result.kind, 'setting');
  backing.fill(0);
  assert.deepEqual(Array.from(result.bytes), Array.from(expected));
});

test('settings preserve a drag baseline, anchor and reservation and cannot permit a larger volume jump', () => {
  const fixture = setup(20);
  fixture.gate.beginGesture();
  accepted(() => fixture.write(50), volume(50));
  const before = fixture.gate.getState(fixture.device);
  for (const bytes of [...ordinarySettings(), ...equalizerWrites()]) {
    fixture.gate.prepare(fixture.device, reportId, bytes);
  }
  const after = fixture.gate.getState(fixture.device);
  for (const field of ['baseline', 'anchor', 'reservation', 'mode', 'lastAttemptAt']) {
    assert.deepEqual(after[field], before[field], `settings must not change ${field}`);
  }
  blocked(() => fixture.write(51), 'JUMP_TOO_LARGE');
});

test('malformed settings, EQ slots, reserved fields and save commands fail closed', () => {
  const fixture = setup();
  const malformed = [];
  for (const bytes of ordinarySettings()) {
    const extra = bytes.slice(); extra[62] = 1; malformed.push(extra);
    const badOpcode = bytes.slice(); badOpcode[3] = 255; malformed.push(badOpcode);
  }
  for (const slot of [6, 10]) {
    malformed.push(equalizerWrites(slot)[0], setting([1, 10, 4, slot, 0, 255, 255]));
  }
  const badBand = equalizerWrites()[0]; badBand[4] = 10; malformed.push(badBand);
  const reserved = equalizerWrites()[0]; reserved[5] = 1; malformed.push(reserved);
  const badType = equalizerWrites()[0]; badType[33] = 8; malformed.push(badType);
  const badMask = setting([1, 10, 4, 7, 0, 255, 127]); malformed.push(badMask);
  const badSave = setting([1, 1, 4, 0, 0, 3]); malformed.push(badSave);
  for (const bytes of malformed) {
    blocked(() => fixture.gate.prepare(fixture.device, reportId, bytes), 'COMMAND_BLOCKED');
  }
});

test('only exact known read requests can pass before configuration or baseline exists', () => {
  const gate = createGate({ now: () => 10_000 });
  const device = target();
  for (const [opcode, section] of [[0x42, 0x10], [0x59, 0x20], [0x60, 0x30],
    [0x61, 0x40], [0x63, 0x50], [0x58, 0xF0]]) {
    const request = new Uint8Array(63);
    request.set([0x80, 0x3F, 0x08, opcode, section]);
    const result = accepted(() => gate.prepare(device, reportId, request), request);
    assert.equal(result.kind, 'read');
    request[62] = 1;
    blocked(() => gate.prepare(device, reportId, request));
  }
});

test('out-of-range channel values cannot reach the native sender', () => {
  const fixture = setup(67);
  blocked(() => fixture.write(101, 67));
  blocked(() => fixture.write(67, 255));
});

test('invalid observations invalidate an earlier baseline rather than keeping stale values', () => {
  const fixture = setup(20);
  assert.equal(fixture.gate.observe(fixture.device, NaN, 20), false);
  blocked(() => fixture.write(21));
});

test('DC04U control reports for unrelated devices pass through unchanged', () => {
  const fixture = setup();
  const otherDevice = { vendorId: 4660, productId: 1, productName: 'Other HID' };
  const bytes = Uint8Array.from([255, 1, 2]);
  const result = fixture.gate.prepare(otherDevice, 0, bytes);
  assert.equal(result.kind, 'passthrough');
  assert.deepEqual(Array.from(result.bytes), Array.from(bytes));
});

test('both known DC04U USB product IDs are protected', () => {
  const fixture = setup();
  const otherVariant = { vendorId: 1633, productId: 2180, productName: 'DC04U' };
  fixture.gate.observe(otherVariant, 20, 20);
  blocked(() => fixture.gate.prepare(otherVariant, reportId, volume(51)));
});

test('observed intermediate values do not move the anchor during a drag', () => {
  const fixture = setup(20);
  fixture.gate.beginGesture();
  accepted(() => fixture.write(40), volume(40));
  fixture.gate.observe(fixture.device, 40, 40);
  fixture.tick(5_000);
  blocked(() => fixture.write(51));
  accepted(() => fixture.write(50), volume(50));
});

test('drag anchor survives the 400 ms release tail, then a new change gets a fresh baseline', () => {
  const fixture = setup(20);
  fixture.gate.beginGesture();
  accepted(() => fixture.write(40), volume(40));
  fixture.gate.observe(fixture.device, 40, 40);
  fixture.gate.endGesture();
  fixture.tick(399);
  blocked(() => fixture.write(51));
  fixture.tick(2);
  accepted(() => fixture.write(51), volume(51));
});

test('continuous +1 packets cannot bypass the threshold by lasting over 1000 ms', () => {
  const fixture = setup(20);
  for (let value = 21; value <= 50; value += 1) {
    fixture.tick(100);
    accepted(() => fixture.write(value), volume(value));
    fixture.gate.observe(fixture.device, value, value);
  }
  fixture.tick(100);
  blocked(() => fixture.write(51));
});

test('after 1000 ms of idle, a new independent adjustment can use the observed baseline', () => {
  const fixture = setup(20);
  accepted(() => fixture.write(40), volume(40));
  fixture.gate.observe(fixture.device, 40, 40);
  fixture.tick(1_001);
  accepted(() => fixture.write(70), volume(70));
});

test('repeated rejected attempts keep one burst active until a genuine idle period', () => {
  const fixture = setup(20);
  accepted(() => fixture.write(40), volume(40));
  fixture.gate.observe(fixture.device, 40, 40);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    fixture.tick(900);
    blocked(() => fixture.write(70));
  }
  fixture.tick(1_001);
  accepted(() => fixture.write(70), volume(70));
});

test('downward adjustment during one drag does not permit returning 31 above its new lower value', () => {
  const fixture = setup(80);
  fixture.gate.beginGesture();
  accepted(() => fixture.write(0), volume(0));
  fixture.gate.observe(fixture.device, 0, 0);
  blocked(() => fixture.write(31));
});

test('a late acknowledgement of an older loud write cannot reopen a lowered baseline', () => {
  const fixture = setup(20);
  accepted(() => fixture.write(50), volume(50));
  accepted(() => fixture.write(0), volume(0));
  fixture.gate.observe(fixture.device, 50, 50);
  blocked(() => fixture.write(40), 'JUMP_TOO_LARGE');
  accepted(() => fixture.write(30), volume(30));
});

test('idle expiration does not let an unconfirmed write be replaced by a stale loud acknowledgement', () => {
  const fixture = setup(20);
  accepted(() => fixture.write(50), volume(50));
  accepted(() => fixture.write(0), volume(0));
  fixture.tick(1_001);
  fixture.gate.observe(fixture.device, 50, 50);
  blocked(() => fixture.write(40), 'JUMP_TOO_LARGE');
  accepted(() => fixture.write(30), volume(30));
});
