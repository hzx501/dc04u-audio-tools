'use strict';

// Each test runs the real extension scripts in an isolated mock Window. There
// is no browser connection, physical HID access or sound generation.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const coreScript = fs.readFileSync(path.join(__dirname, '..', 'guard-core.js'), 'utf8');
const mainScript = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');

function packet(left, right = left) {
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
    bytes[34] = 246;
    return bytes;
  });
  return [...bands, setting([1, 10, 4, slot, 0, 255, 255]), setting([1, 1, 4, 0, 0, 2])];
}

function emitter() {
  const listeners = new Map();
  return {
    listeners,
    addEventListener(type, listener) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(listener);
    },
    emit(type, event = {}) {
      event.type = type;
      for (const listener of listeners.get(type) || []) {
        listener(event);
        if (event.stopped) break;
      }
      return event;
    },
  };
}

function environment({ webhidAvailable = true, readyState = 'loading', blockedMethod = null } = {}) {
  let milliseconds = 10_000;
  const nativeCalls = [];
  const featureCalls = [];
  const posts = [];
  const document = Object.assign(emitter(), { readyState });
  const hid = emitter();
  class MockElement {
    constructor(value = '20') { this.value = value; }
    matches(selector) { return selector === 'input.vol-slider'; }
    closest() { return null; }
  }
  class MockHIDDevice {
    constructor(vendorId = 0x0661, productId = 0x0883) {
      Object.assign(this, emitter());
      this.vendorId = vendorId;
      this.productId = productId;
      this.opened = false;
      this.nextFailure = null;
      this.nextThrow = null;
    }
    open() { this.opened = true; return Promise.resolve(); }
    sendReport(reportId, bytes) {
      nativeCalls.push({ device: this, reportId, bytes });
      if (this.nextThrow) {
        const failure = this.nextThrow;
        this.nextThrow = null;
        throw failure;
      }
      const failure = this.nextFailure;
      this.nextFailure = null;
      return failure ? Promise.reject(failure) : Promise.resolve();
    }
    sendFeatureReport(reportId, bytes) {
      featureCalls.push({ device: this, reportId, bytes });
      return Promise.resolve();
    }
  }
  if (blockedMethod) {
    Object.defineProperty(MockHIDDevice.prototype, blockedMethod, {
      value: MockHIDDevice.prototype[blockedMethod], configurable: false, writable: false,
    });
  }
  const sandbox = Object.assign(emitter(), {
    document,
    navigator: { hid },
    location: { hash: '#/device/DC04U' },
    performance: { now: () => milliseconds },
    HIDDevice: webhidAvailable ? MockHIDDevice : undefined,
    Element: MockElement,
    DOMException,
    setInterval: () => 1,
    postMessage: (message) => posts.push(message),
  });
  sandbox.window = sandbox;
  sandbox.top = sandbox;
  const context = vm.createContext(sandbox);
  vm.runInContext(coreScript, context, { filename: 'guard-core.js' });
  vm.runInContext(mainScript, context, { filename: 'main.js' });
  const device = new MockHIDDevice();
  function observe(left, right = left, { trusted = true, length = 63, offset = 0 } = {}) {
    const bytes = new Uint8Array(length + offset);
    bytes.set([0x80, 0x3F, 0x08, 0x42, 0x10, left, right], offset);
    device.emit('inputreport', { isTrusted: trusted, reportId: 0x4B,
      data: new DataView(bytes.buffer, offset, length) });
  }
  function input(element, value) {
    element.value = String(value);
    return document.emit('input', {
      target: element,
      stopped: false,
      defaultPrevented: false,
      stopImmediatePropagation() { this.stopped = true; },
      preventDefault() { this.defaultPrevented = true; },
    });
  }
  return { sandbox, context, device, hid, document, nativeCalls, featureCalls, posts,
    observe, input, MockElement, MockHIDDevice,
    tick: (delta) => { milliseconds += delta; },
    status: () => posts.filter(message => message.type === 'DC04U_GUARD_STATUS_V1').at(-1)?.status,
    injectAgain: () => vm.runInContext(mainScript, context, { filename: 'main.js' }),
  };
}

async function connected(baseline = 20) {
  const env = environment();
  await env.device.open();
  if (baseline !== null) env.observe(baseline);
  return env;
}

function denied(promise) { return assert.rejects(promise, error => error.name === 'NotAllowedError'); }

test('Feature writes are rejected before any native HID call', async () => {
  const env = await connected();
  await denied(env.device.sendFeatureReport(0x4B, packet(50)));
  assert.equal(env.featureCalls.length, 0);
  assert.equal(env.nativeCalls.length, 0);
});

test('unknown baseline blocks the native sender', async () => {
  const env = await connected(null);
  await denied(env.device.sendReport(0x4B, packet(21)));
  assert.equal(env.nativeCalls.length, 0);
  assert.equal(env.status().baselineKnown, false);
});

test('20 → 51 never reaches native, while 20 → 50 reaches it once', async () => {
  const env = await connected(20);
  await denied(env.device.sendReport(0x4B, packet(51)));
  assert.equal(env.nativeCalls.length, 0);
  await env.device.sendReport(0x4B, packet(50));
  assert.equal(env.nativeCalls.length, 1);
  assert.deepEqual(Array.from(env.nativeCalls[0].bytes), Array.from(packet(50)));
});

test('native receives owned bytes rather than the website’s mutable buffer', async () => {
  const env = await connected();
  const source = packet(50);
  const pending = env.device.sendReport(0x4B, source);
  source.fill(255);
  await pending;
  assert.notEqual(env.nativeCalls[0].bytes, source);
  assert.deepEqual(Array.from(env.nativeCalls[0].bytes), Array.from(packet(50)));
});

test('unknown command shapes still fail before native transport', async () => {
  const env = await connected();
  const commands = [
    Uint8Array.from([1, 63, 8, 255, 255]),
    Uint8Array.from([1, 63, 8, 21, 48]),
    Uint8Array.from([1, 9, 31, 6, 0]),
  ];
  for (const prefix of commands) {
    const bytes = new Uint8Array(63); bytes.set(prefix);
    await denied(env.device.sendReport(0x4B, bytes));
  }
  assert.equal(env.nativeCalls.length, 0);
});

test('ordinary settings work without a known volume and reach native unchanged exactly once each', async () => {
  const env = await connected(null);
  const writes = ordinarySettings();
  for (const bytes of writes) await env.device.sendReport(0x4B, bytes);
  assert.equal(env.nativeCalls.length, 4);
  for (let index = 0; index < writes.length; index += 1) {
    assert.equal(env.nativeCalls[index].reportId, 0x4B);
    assert.notEqual(env.nativeCalls[index].bytes, writes[index]);
    assert.deepEqual(Array.from(env.nativeCalls[index].bytes), Array.from(writes[index]));
  }
  assert.equal(env.status().baselineKnown, false);
  assert.equal(env.status().settingCount, 4);
});

test('the official custom EQ chain sends all ten bands, mask and save without a volume baseline', async () => {
  const env = await connected(null);
  const writes = equalizerWrites();
  for (const bytes of writes) await env.device.sendReport(0x4B, bytes);
  assert.equal(env.nativeCalls.length, 12);
  assert.equal(env.status().settingCount, 12);
  for (let index = 0; index < writes.length; index += 1) {
    assert.deepEqual(Array.from(env.nativeCalls[index].bytes), Array.from(writes[index]));
  }
  assert.equal(env.status().baselineKnown, false);
});

test('ordinary settings and EQ cannot restart a drag or bypass its 30-step volume limit', async () => {
  const env = await connected(20);
  env.document.emit('pointerdown', { target: new env.MockElement('20') });
  await env.device.sendReport(0x4B, packet(50));
  for (const bytes of [...ordinarySettings(), ...equalizerWrites()]) {
    await env.device.sendReport(0x4B, bytes);
  }
  assert.equal(env.nativeCalls.length, 17);
  await denied(env.device.sendReport(0x4B, packet(51)));
  assert.equal(env.nativeCalls.length, 17);
});

test('malformed volume packets remain blocked instead of being accepted as settings', async () => {
  const env = await connected(20);
  const bytes = packet(100);
  bytes[7] = 1;
  await denied(env.device.sendReport(0x4B, bytes));
  assert.equal(env.nativeCalls.length, 0);
});

test('the website cannot mutate a settings packet after it has passed the guard', async () => {
  const env = await connected();
  const expected = ordinarySettings()[1];
  const source = expected.slice();
  const pending = env.device.sendReport(0x4B, source);
  source.fill(255);
  await pending;
  assert.deepEqual(Array.from(env.nativeCalls[0].bytes), Array.from(expected));
});

test('asynchronous setting failures preserve the existing usable volume baseline', async () => {
  const env = await connected(20);
  env.device.nextFailure = new Error('setting request failed');
  await assert.rejects(env.device.sendReport(0x4B, ordinarySettings()[0]), /setting request failed/);
  assert.equal(env.status().baselineKnown, true);
  assert.equal(env.status().settingCount, 0);
  await env.device.sendReport(0x4B, packet(50));
  assert.equal(env.nativeCalls.length, 2);
});

test('synchronous setting failures also preserve the volume baseline', async () => {
  const env = await connected(20);
  env.device.nextThrow = new Error('native setting validation failed');
  await assert.rejects(env.device.sendReport(0x4B, ordinarySettings()[0]), /native setting validation failed/);
  assert.equal(env.status().baselineKnown, true);
  await env.device.sendReport(0x4B, packet(50));
  assert.equal(env.nativeCalls.length, 2);
});

test('read failures still invalidate the volume baseline', async () => {
  const env = await connected(20);
  env.device.nextFailure = new Error('read request failed');
  await assert.rejects(env.device.sendReport(0x4B, setting([0x80, 63, 8, 0x42, 0x10])), /read request failed/);
  assert.equal(env.status().baselineKnown, false);
  await denied(env.device.sendReport(0x4B, packet(21)));
  assert.equal(env.nativeCalls.length, 1);
});

test('non-volume website controls retain pointer, click, input, change, key and wheel events', () => {
  const env = environment();
  const control = new env.MockElement('0');
  control.matches = () => false;
  // This models an official EQ input inside one of the previously locked cards.
  control.closest = selector => selector.includes('.dc04u-eq-panel') || selector.includes('input,button') ? control : null;
  for (const type of ['pointerdown', 'mousedown', 'click', 'input', 'change', 'keydown', 'wheel']) {
    const event = {
      target: control, key: 'ArrowRight', repeat: false, stopped: false, defaultPrevented: false,
      stopImmediatePropagation() { this.stopped = true; },
      preventDefault() { this.defaultPrevented = true; },
    };
    env.document.emit(type, event);
    assert.equal(event.stopped, false, `${type} must reach the official control`);
    assert.equal(event.defaultPrevented, false, `${type} must keep the official default action`);
  }
});

test('rejected native writes invalidate the baseline and later writes remain blocked', async () => {
  const env = await connected();
  env.device.nextFailure = new Error('USB device disconnected');
  await assert.rejects(env.device.sendReport(0x4B, packet(40)), /USB device disconnected/);
  assert.equal(env.nativeCalls.length, 1);
  assert.equal(env.status().baselineKnown, false);
  await denied(env.device.sendReport(0x4B, packet(41)));
  assert.equal(env.nativeCalls.length, 1);
  env.observe(20);
  await env.device.sendReport(0x4B, packet(40));
  assert.equal(env.nativeCalls.length, 2);
});

test('reinjecting the same frame does not stack wrappers or event listeners', async () => {
  const env = await connected();
  const originalWrapper = env.MockHIDDevice.prototype.sendReport;
  const listenerCount = env.document.listeners.get('input').length;
  env.injectAgain();
  assert.equal(env.MockHIDDevice.prototype.sendReport, originalWrapper);
  assert.equal(env.document.listeners.get('input').length, listenerCount);
  await env.device.sendReport(0x4B, packet(40));
  assert.equal(env.nativeCalls.length, 1);
});

test('untrusted inputreport events cannot establish a baseline', async () => {
  const env = await connected(null);
  env.observe(20, 20, { trusted: false });
  await denied(env.device.sendReport(0x4B, packet(21)));
  assert.equal(env.nativeCalls.length, 0);
});

test('a trusted 63-byte HID report preserves DataView offsets', async () => {
  const env = await connected(null);
  env.observe(20, 30, { offset: 9 });
  await env.device.sendReport(0x4B, packet(50, 60));
  assert.equal(env.nativeCalls.length, 1);
});

test('disconnect clears the known baseline', async () => {
  const env = await connected();
  env.device.opened = false;
  env.hid.emit('disconnect', { device: env.device });
  await denied(env.device.sendReport(0x4B, packet(21)));
  assert.equal(env.nativeCalls.length, 0);
  assert.equal(env.status().baselineKnown, false);
});

test('reopening the same device requires a fresh volume report', async () => {
  const env = await connected(20);
  await env.device.open();
  await denied(env.device.sendReport(0x4B, packet(21)));
  assert.equal(env.nativeCalls.length, 0, 'reopened devices cannot reuse a previous baseline');
  assert.equal(env.status().baselineKnown, false);
  env.observe(67);
  await env.device.sendReport(0x4B, packet(97));
  assert.equal(env.nativeCalls.length, 1, 'the new 67 baseline permits an increase of exactly 30');
});

test('other HID devices retain their native output and feature operations', async () => {
  const env = environment();
  const other = new env.MockHIDDevice(0x1234, 1);
  const bytes = Uint8Array.from([255, 1]);
  await other.sendReport(0, bytes);
  await other.sendFeatureReport(0, bytes);
  assert.equal(env.nativeCalls.length, 1);
  assert.equal(env.featureCalls.length, 1);
  assert.equal(env.nativeCalls[0].bytes, bytes);
});

test('input events without an explicit drag cannot restart the core burst after only 401 ms', async () => {
  const env = await connected();
  const slider = new env.MockElement('20');
  const first = env.input(slider, 40);
  assert.equal(first.stopped, false);
  await env.device.sendReport(0x4B, packet(40));
  env.observe(40);
  env.tick(401);
  const second = env.input(slider, 51);
  if (!second.stopped) await denied(env.device.sendReport(0x4B, packet(51)));
  assert.equal(env.nativeCalls.length, 1, 'the second packet must not be sent');
});

test('status reports installed hooks and a hardware-free self-test separately from device baseline', () => {
  const env = environment();
  const status = env.status();
  assert.equal(status.version, '1.1.3');
  assert.equal(status.jumpThreshold, 30);
  assert.equal(status.hookReady, true);
  assert.equal(status.installedAtStart, true);
  assert.equal(status.baselineKnown, false);
  assert.equal(status.selfTest.noHardwareCalls, true);
  assert.equal(status.selfTest.passed, 6);
  assert.equal(status.selfTest.total, 6);
  assert.equal(env.nativeCalls.length, 0);
  assert.equal(env.featureCalls.length, 0);
});

test('missing WebHID is reported as unavailable instead of a successful hook', () => {
  const env = environment({ webhidAvailable: false });
  assert.equal(env.status().hookReady, false);
  assert.ok(env.status().hookError.length > 0);
  assert.equal(env.status().selfTest.hookIntact, false);
});

test('a prototype patch failure is reported as unavailable', () => {
  const env = environment({ blockedMethod: 'sendFeatureReport' });
  assert.equal(env.status().hookReady, false);
  assert.ok(env.status().hookError.length > 0);
  assert.equal(env.status().selfTest.hookIntact, false);
});

test('late injection is not reported as protection installed at document start', () => {
  const env = environment({ readyState: 'complete' });
  assert.equal(env.status().installedAtStart, false);
});
