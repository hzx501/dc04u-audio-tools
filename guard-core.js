(function installDC04UGuardCore(root) {
  "use strict";

  const VENDOR_ID = 0x0661;
  const PRODUCT_IDS = new Set([0x0883, 0x0884]);
  const REPORT_ID = 0x4b;
  const REPORT_LENGTH = 63;
  const JUMP_THRESHOLD = 30;
  const GESTURE_GRACE_MS = 400;
  const BURST_IDLE_MS = 1000;
  const arrayBufferLength = Object.getOwnPropertyDescriptor(
    ArrayBuffer.prototype, "byteLength"
  ).get;
  const READ_SECTIONS = new Map([
    [0x42, 0x10], [0x59, 0x20], [0x60, 0x30],
    [0x61, 0x40], [0x63, 0x50], [0x58, 0xf0]
  ]);

  function errorWithCode(code, message) {
    const error = new Error(message);
    error.code = code;
    return error;
  }

  // Always return owned bytes. Preserve a view's offset and reject shared or
  // detached backing stores instead of parsing a different report from native.
  function copyBufferSource(source) {
    try {
      let buffer;
      let offset;
      let length;
      if (ArrayBuffer.isView(source)) {
        buffer = source.buffer;
        arrayBufferLength.call(buffer);
        offset = source.byteOffset;
        length = source.byteLength;
      } else {
        buffer = source;
        length = arrayBufferLength.call(buffer);
        offset = 0;
      }
      const result = new Uint8Array(length);
      result.set(new Uint8Array(buffer, offset, length));
      return result;
    } catch (_) {
      throw errorWithCode("INVALID_BUFFER", "Expected a non-shared, attached BufferSource.");
    }
  }

  function deviceIdentity(device) {
    if ((typeof device !== "object" && typeof device !== "function") || device === null) {
      throw errorWithCode("INVALID_DEVICE", "Expected a HID device object.");
    }
    let vendorId;
    let productId;
    try {
      vendorId = device.vendorId;
      productId = device.productId;
    } catch (_) {
      throw errorWithCode("INVALID_DEVICE", "Cannot read the HID device identity.");
    }
    if (!Number.isInteger(vendorId) || !Number.isInteger(productId) ||
        vendorId < 0 || vendorId > 0xffff || productId < 0 || productId > 0xffff) {
      throw errorWithCode("INVALID_DEVICE", "Invalid USB vendor or product ID.");
    }
    return { vendorId, productId, target: vendorId === VENDOR_ID && PRODUCT_IDS.has(productId) };
  }

  function zeroTail(bytes, start) {
    for (let index = start; index < bytes.length; index += 1) {
      if (bytes[index] !== 0) return false;
    }
    return true;
  }

  function isKnownRead(bytes) {
    if (bytes.length !== REPORT_LENGTH || bytes[0] !== 0x80) return false;
    if (bytes[1] === 0x3f && bytes[2] === 0x08 &&
        READ_SECTIONS.has(bytes[3]) && READ_SECTIONS.get(bytes[3]) === bytes[4]) {
      return zeroTail(bytes, 5);
    }
    return bytes[1] === 0x09 && bytes[2] === 0x1f &&
      bytes[3] >= 7 && bytes[3] <= 9 && bytes[4] <= 9 && zeroTail(bytes, 5);
  }

  function isKnownSetting(bytes) {
    if (bytes.length !== REPORT_LENGTH || bytes[0] !== 0x01) return false;

    if (bytes[1] === 0x3f && bytes[2] === 0x08) {
      if ((bytes[3] === 0x11 && bytes[4] === 0x20) ||
          (bytes[3] === 0x19 && bytes[4] === 0x30)) {
        return zeroTail(bytes, 8);
      }
      if ((bytes[3] === 0x19 && bytes[4] === 0x40) ||
          (bytes[3] === 0x21 && bytes[4] === 0x50)) {
        return zeroTail(bytes, 10);
      }
      return false;
    }

    // Official custom-EQ writes use slots 7–9 and ten indexed bands. Only
    // the encoded parameter fields may vary; reserved report bytes stay zero.
    if (bytes[1] === 0x09 && bytes[2] === 0x1f &&
        bytes[3] >= 7 && bytes[3] <= 9 && bytes[4] <= 9 &&
        bytes[33] <= 7 && zeroTail(bytes, 35)) {
      for (let index = 5; index <= 26; index += 1) {
        if (bytes[index] !== 0) return false;
      }
      return true;
    }
    // Match the official encoder, which repeats the same eight-bit mask.
    if (bytes[1] === 0x0a && bytes[2] === 0x04 &&
        bytes[3] >= 7 && bytes[3] <= 9 && bytes[4] === 0 &&
        bytes[5] === bytes[6] && zeroTail(bytes, 7)) {
      return true;
    }
    return bytes[1] === 0x01 && bytes[2] === 0x04 &&
      bytes[3] === 0 && bytes[4] === 0 && bytes[5] === 0x02 && zeroTail(bytes, 6);
  }

  function isVolumeShape(bytes) {
    return bytes.length === REPORT_LENGTH && bytes[0] === 0x01 &&
      bytes[1] === 0x3f && bytes[2] === 0x08 && bytes[3] === 0x01 &&
      bytes[4] === 0x10 && zeroTail(bytes, 7);
  }

  function pairCopy(pair) {
    return pair === null ? null : { left: pair.left, right: pair.right };
  }

  function createGate(options = {}) {
    const now = options.now === undefined ? () => performance.now() : options.now;
    if (typeof now !== "function") throw new TypeError("now must be a function.");
    const byDevice = new WeakMap();
    const records = new Set();
    let nextId = 1;
    let ready = false;
    let jumpThreshold = null;
    let blocked = 0;
    let acceptedReads = 0;
    let acceptedVolumes = 0;
    let failures = 0;
    let lastReason = null;
    let globalGesture = { mode: null, graceUntil: null };

    function time() {
      let value;
      try { value = now(); } catch (_) {
        throw errorWithCode("CLOCK_INVALID", "The operation clock failed.");
      }
      if (!Number.isFinite(value)) {
        throw errorWithCode("CLOCK_INVALID", "The operation clock must be finite.");
      }
      return value;
    }

    function getRecord(device, identity) {
      let record = byDevice.get(device);
      if (!record) {
        record = {
          id: nextId++, vendorId: identity.vendorId, productId: identity.productId,
          baseline: null, anchor: null, reservation: null, observed: null,
          mode: globalGesture.mode,
          graceUntil: globalGesture.graceUntil, lastAttemptAt: null,
          lastObservedAt: null, blocked: 0, acceptedReads: 0,
          acceptedVolumes: 0, failures: 0, lastReason: null
        };
        byDevice.set(device, record);
        records.add(record);
      }
      return record;
    }

    function deny(record, code, message) {
      blocked += 1;
      lastReason = code;
      if (record) {
        record.blocked += 1;
        record.lastReason = code;
      }
      throw errorWithCode(code, message);
    }

    function clearBaseline(record) {
      record.baseline = null;
      record.anchor = null;
      record.reservation = null;
      record.observed = null;
      record.mode = null;
      record.graceUntil = null;
      record.lastAttemptAt = null;
    }

    function expireOperation(record, timestamp) {
      if (record.mode === "grace" && timestamp >= record.graceUntil) {
        record.mode = null;
        record.anchor = null;
        record.graceUntil = null;
        record.lastAttemptAt = null;
      } else if (record.mode === "burst" && record.lastAttemptAt !== null &&
                 timestamp - record.lastAttemptAt >= BURST_IDLE_MS) {
        record.mode = null;
        record.anchor = null;
        record.lastAttemptAt = null;
      }
    }

    function expireGlobalGesture(timestamp) {
      if (globalGesture.mode === "grace" && timestamp >= globalGesture.graceUntil) {
        globalGesture = { mode: null, graceUntil: null };
      }
    }

    function configure(configuration) {
      let valid = false;
      try {
        valid = configuration !== null && typeof configuration === "object" &&
          configuration.version === 1 && configuration.jumpThreshold === JUMP_THRESHOLD;
      } catch (_) { valid = false; }
      if (!valid) {
        ready = false;
        jumpThreshold = null;
        lastReason = "INVALID_CONFIG";
        globalGesture = { mode: null, graceUntil: null };
        for (const record of records) clearBaseline(record);
        return false;
      }
      ready = true;
      jumpThreshold = JUMP_THRESHOLD;
      lastReason = null;
      return true;
    }

    function prepare(device, reportId, source) {
      let bytes;
      try { bytes = copyBufferSource(source); } catch (error) {
        return deny(null, error.code, error.message);
      }
      let identity;
      try { identity = deviceIdentity(device); } catch (error) {
        return deny(null, error.code, error.message);
      }
      if (!identity.target) return { kind: "passthrough", bytes };
      const record = getRecord(device, identity);
      if (reportId !== REPORT_ID) {
        return deny(record, "INVALID_REPORT_ID", "This DC04U report ID is not allowed.");
      }
      if (isKnownRead(bytes)) {
        record.acceptedReads += 1;
        acceptedReads += 1;
        return { kind: "read", bytes };
      }
      if (isKnownSetting(bytes)) return { kind: "setting", bytes };
      if (!isVolumeShape(bytes)) {
        return deny(record, "COMMAND_BLOCKED", "Only known reads, settings and volume writes are allowed.");
      }

      let timestamp;
      try { timestamp = time(); } catch (error) {
        return deny(record, error.code, error.message);
      }
      expireGlobalGesture(timestamp);
      expireOperation(record, timestamp);
      // Both accepted and rejected attempts keep a continuous drag/burst open.
      record.lastAttemptAt = timestamp;
      const left = bytes[5];
      const right = bytes[6];
      if (left > 100 || right > 100) {
        return deny(record, "INVALID_VOLUME", "DC04U volume values must be in 0–100.");
      }
      if (!ready) return deny(record, "NOT_CONFIGURED", "Configure the guard before writing volume.");
      if (!record.baseline) {
        return deny(record, "BASELINE_REQUIRED", "Read hardware volume before writing it.");
      }
      if (!record.anchor) record.anchor = pairCopy(record.baseline);
      if (!record.mode) record.mode = "burst";
      if ((left > record.baseline.left && left - record.anchor.left > jumpThreshold) ||
          (right > record.baseline.right && right - record.anchor.right > jumpThreshold)) {
        return deny(record, "JUMP_TOO_LARGE", "A single operation may not raise either channel by more than 30 steps.");
      }
      // Reserve synchronously: concurrent native calls cannot each compare with
      // a moving per-packet baseline. The operation anchor stays fixed.
      record.baseline = { left, right };
      record.reservation = { left, right };
      // A decrease is always allowed, but a later rebound must be compared
      // with that lower level rather than an earlier, louder gesture start.
      record.anchor.left = Math.min(record.anchor.left, left);
      record.anchor.right = Math.min(record.anchor.right, right);
      record.acceptedVolumes += 1;
      acceptedVolumes += 1;
      return { kind: "volume", bytes };
    }

    function observe(device, left, right) {
      let identity;
      try { identity = deviceIdentity(device); } catch (_) { return false; }
      if (!identity.target) return false;
      const record = getRecord(device, identity);
      let timestamp;
      try { timestamp = time(); } catch (_) {
        clearBaseline(record);
        record.lastReason = "CLOCK_INVALID";
        lastReason = "CLOCK_INVALID";
        return false;
      }
      expireGlobalGesture(timestamp);
      expireOperation(record, timestamp);
      if (!Number.isInteger(left) || !Number.isInteger(right) ||
          left < 0 || left > 100 || right < 0 || right > 100) {
        clearBaseline(record);
        record.lastReason = "INVALID_OBSERVATION";
        lastReason = "INVALID_OBSERVATION";
        return false;
      }
      record.observed = { left, right };
      // Reports can arrive after newer writes. While an operation is active or
      // its latest target is unconfirmed, a late high ACK must not turn a rise
      // from a reserved lower level into an apparently unrestricted decrease.
      if (record.baseline && (record.mode || record.reservation)) {
        record.baseline = {
          left: Math.min(record.baseline.left, left),
          right: Math.min(record.baseline.right, right)
        };
      } else {
        record.baseline = { left, right };
      }
      if (record.reservation && left === record.reservation.left && right === record.reservation.right) {
        record.reservation = null;
      }
      record.lastObservedAt = timestamp;
      // Initial observation can seed a gesture that began before discovery.
      // Confirmations can lower the anchor, but can never advance it upward.
      if (record.mode && !record.anchor) record.anchor = pairCopy(record.baseline);
      else if (record.anchor) {
        record.anchor.left = Math.min(record.anchor.left, record.baseline.left);
        record.anchor.right = Math.min(record.anchor.right, record.baseline.right);
      }
      return true;
    }

    function failed(device) {
      let identity;
      try { identity = deviceIdentity(device); } catch (_) { return false; }
      if (!identity.target) return false;
      const record = getRecord(device, identity);
      clearBaseline(record);
      record.failures += 1;
      failures += 1;
      record.lastReason = "NATIVE_FAILURE";
      lastReason = "NATIVE_FAILURE";
      return true;
    }

    function startRecordGesture(record, timestamp) {
      expireOperation(record, timestamp);
      if (record.mode === "gesture") return;
      record.anchor = pairCopy(record.baseline);
      record.mode = "gesture";
      record.graceUntil = null;
      record.lastAttemptAt = null;
    }

    function endRecordGesture(record, timestamp) {
      if (record.mode !== "gesture") return;
      record.mode = "grace";
      record.graceUntil = timestamp + GESTURE_GRACE_MS;
    }

    function beginGesture(device) {
      const timestamp = time();
      expireGlobalGesture(timestamp);
      if (device === undefined) {
        globalGesture = { mode: "gesture", graceUntil: null };
        for (const record of records) startRecordGesture(record, timestamp);
        return true;
      }
      const identity = deviceIdentity(device);
      if (!identity.target) return false;
      startRecordGesture(getRecord(device, identity), timestamp);
      return true;
    }

    function endGesture(device) {
      const timestamp = time();
      if (device === undefined) {
        if (globalGesture.mode === "gesture") {
          globalGesture = { mode: "grace", graceUntil: timestamp + GESTURE_GRACE_MS };
        }
        for (const record of records) endRecordGesture(record, timestamp);
        return true;
      }
      const identity = deviceIdentity(device);
      if (!identity.target) return false;
      endRecordGesture(getRecord(device, identity), timestamp);
      return true;
    }

    function snapshot(record) {
      return {
        id: record.id, vendorId: record.vendorId, productId: record.productId,
        baseline: pairCopy(record.baseline), anchor: pairCopy(record.anchor),
        reservation: pairCopy(record.reservation), observed: pairCopy(record.observed),
        mode: record.mode, graceUntil: record.graceUntil,
        lastAttemptAt: record.lastAttemptAt, lastObservedAt: record.lastObservedAt,
        blocked: record.blocked, acceptedReads: record.acceptedReads,
        acceptedVolumes: record.acceptedVolumes, failures: record.failures,
        lastReason: record.lastReason
      };
    }

    function getState(device) {
      const summary = {
        ready, jumpThreshold, blocked, acceptedReads, acceptedVolumes, failures,
        lastReason, gestureGraceMs: GESTURE_GRACE_MS, burstIdleMs: BURST_IDLE_MS
      };
      if (device !== undefined) {
        const identity = deviceIdentity(device);
        if (!identity.target) return { ...summary, target: false, baseline: null, anchor: null, mode: null };
        return { ...summary, ...snapshot(getRecord(device, identity)), target: true };
      }
      return { ...summary, devices: Array.from(records, snapshot) };
    }

    return Object.freeze({ configure, prepare, observe, failed, getState, beginGesture, endGesture });
  }

  const api = Object.freeze({ createGate });
  Object.defineProperty(root, "DC04UGuardCore", {
    value: api, configurable: true, enumerable: true, writable: false
  });
})(globalThis);
