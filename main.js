(() => {
  "use strict";
  const MARK = "__DC04U_JUMP_GUARD_V1__";
  if (Object.prototype.hasOwnProperty.call(window, MARK)) return;
  const core = globalThis.DC04UGuardCore;
  const gate = core.createGate();
  gate.configure({ version: 1, jumpThreshold: 30 });
  const target = d => d && d.vendorId === 0x0661 && [0x0883, 0x0884].includes(d.productId);
  const devices = new Map();
  const attached = new WeakSet();
  let blockCount = 0, readCount = 0, volumeCount = 0, settingCount = 0, latest = "尚未发生拦截";
  let lastReport = null, lastSent = null, lastInputAt = null, selfTest = null;
  let hookReady = false, hookError = "", uiGesture = null;
  const proto = globalThis.HIDDevice?.prototype;
  let wrappedSend, wrappedFeature, wrappedOpen;
  const sendNative = proto?.sendReport;
  const featureNative = proto?.sendFeatureReport;
  const openNative = proto?.open;
  const refs = Object.freeze({ sendNative, featureNative, openNative });
  function status() {
    const intact = hookReady && proto.sendReport === wrappedSend && proto.sendFeatureReport === wrappedFeature && proto.open === wrappedOpen;
    return {
      version: "1.1.3", installedAtStart: document.readyState === "loading" || startWasEarly,
      hookReady: !!intact, hookError, jumpThreshold: 30, fixedCap: null,
      connected: [...devices.values()].some(d => d.opened),
      baselineKnown: lastReport !== null, lastReport, lastSent,
      blockCount, readCount, volumeCount, settingCount, latest, lastInputAt, selfTest,
      frameIsTop: window === window.top
    };
  }
  const startWasEarly = document.readyState === "loading";
  function publish() { window.postMessage({ type: "DC04U_GUARD_STATUS_V1", status: status() }, "*"); }
  function blocked(message) { blockCount++; latest = message; publish(); }
  function track(device) {
    if (!target(device) || attached.has(device)) return;
    attached.add(device); devices.set(device, device);
    device.addEventListener("inputreport", event => {
      if (!event.isTrusted || event.reportId !== 0x4B) return;
      let bytes;
      try { bytes = new Uint8Array(event.data.buffer, event.data.byteOffset, event.data.byteLength); }
      catch { return; }
      // Matches the official controller's volume response parser; only real HID events are accepted.
      if (bytes.length !== 63 || bytes[4] !== 0x10 || bytes[5] > 100 || bytes[6] > 100) return;
      gate.observe(device, bytes[5], bytes[6]);
      lastReport = { left: bytes[5], right: bytes[6] };
      lastInputAt = Date.now(); publish();
    });
  }
  function denial(reason) { return new DOMException(`DC04U 跳变保护：${reason}`, "NotAllowedError"); }
  const messages = {
    JUMP_TOO_LARGE: "本次向上跳变超过 30 档，已在发送前拦截",
    BASELINE_REQUIRED: "尚未收到设备音量回报，暂不允许写音量",
    NOT_CONFIGURED: "保护初始化未完成，暂不允许写音量",
    JUMP: "本次向上跳变超过 30 档，已在发送前拦截",
    JUMP_BLOCKED: "本次向上跳变超过 30 档，已在发送前拦截",
    UNKNOWN_BASELINE: "尚未收到设备音量回报，暂不允许写音量",
    BASELINE_UNKNOWN: "尚未收到设备音量回报，暂不允许写音量",
    NOT_READY: "保护初始化未完成，暂不允许写音量"
  };
  try {
    if (!proto || typeof sendNative !== "function" || typeof featureNative !== "function" || typeof openNative !== "function") {
      throw new Error("当前浏览器未提供可保护的 WebHID 接口");
    }
    wrappedSend = function(reportId, data) {
      if (!target(this)) return Reflect.apply(refs.sendNative, this, [reportId, data]);
      track(this);
      let packet;
      try { packet = gate.prepare(this, reportId, data); }
      catch (error) {
        const text = messages[error.code] || `已拒绝命令（${error.code || "未知协议"}）：${error.message}`;
        blocked(text); return Promise.reject(denial(text));
      }
      let result;
      try { result = Reflect.apply(refs.sendNative, this, [reportId, packet.bytes]); }
      catch (error) {
        if (packet.kind !== "setting") { gate.failed(this); lastReport = null; lastSent = null; }
        publish(); return Promise.reject(error);
      }
      if (packet.kind === "volume") lastSent = { left: packet.bytes[5], right: packet.bytes[6] };
      return Promise.resolve(result).then(value => {
        if (packet.kind === "read") readCount++;
        if (packet.kind === "volume") volumeCount++;
        if (packet.kind === "setting") settingCount++;
        publish(); return value;
      }, error => {
        if (packet.kind !== "setting") {
          gate.failed(this); lastReport = null; lastSent = null;
          latest = "设备命令失败，音量基线已清除；等待重新读取";
        } else { latest = "网页设置未被设备接受，请查看官网提示"; }
        publish(); throw error;
      });
    };
    wrappedFeature = function(reportId, data) {
      if (!target(this)) return Reflect.apply(refs.featureNative, this, [reportId, data]);
      blocked("已拒绝未验证的 Feature 写入；没有发送给 DC04U");
      return Promise.reject(denial("未验证的 Feature 写入"));
    };
    wrappedOpen = function(...args) {
      // A website can reuse one HIDDevice object after closing it. Never reuse
      // the old volume baseline across a new control connection.
      if (target(this)) { gate.failed(this); lastReport = null; lastSent = null; }
      track(this);
      return Reflect.apply(refs.openNative, this, args);
    };
    for (const [key, value] of [["sendReport", wrappedSend], ["sendFeatureReport", wrappedFeature], ["open", wrappedOpen]]) {
      Object.defineProperty(proto, key, { value, configurable: false, writable: false });
    }
    hookReady = true;
    navigator.hid?.addEventListener("disconnect", event => {
      if (target(event.device)) {
        gate.failed(event.device); devices.delete(event.device); lastReport = null; lastSent = null; publish();
      }
    });
  } catch (error) { hookError = String(error.message || error); }
  Object.defineProperty(window, MARK, { value: Object.freeze({ version: "1.1.3" }), writable: false, configurable: false });

  const isDC04UPage = () => location.hash.includes("/device/DC04U");
  const isVolume = el => el instanceof Element && el.matches("input.vol-slider");
  document.addEventListener("pointerdown", event => {
    if (!isDC04UPage() || !isVolume(event.target)) return;
    gate.beginGesture();
    uiGesture = { element: event.target, anchor: Number(event.target.value), last: Number(event.target.value), active: true, until: Infinity };
  }, true);
  function endGesture() {
    if (!uiGesture) return;
    uiGesture.active = false; uiGesture.until = performance.now() + 400;
    gate.endGesture();
  }
  document.addEventListener("pointerup", endGesture, true);
  document.addEventListener("pointercancel", endGesture, true);
  window.addEventListener("blur", endGesture, true);
  document.addEventListener("keydown", event => {
    if (!isDC04UPage() || !isVolume(event.target) || event.repeat) return;
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown"].includes(event.key)) return;
    gate.beginGesture();
    uiGesture = { element: event.target, anchor: Number(event.target.value), last: Number(event.target.value), active: true, until: Infinity };
  }, true);
  document.addEventListener("keyup", event => { if (isVolume(event.target)) endGesture(); }, true);
  document.addEventListener("input", event => {
    if (!isDC04UPage() || !isVolume(event.target)) return;
    const el = event.target;
    if (!uiGesture || uiGesture.element !== el || (!uiGesture.active && performance.now() >= uiGesture.until)) {
      const fallback = lastSent || lastReport;
      const anchor = fallback ? Math.min(fallback.left, fallback.right) : NaN;
      uiGesture = { element: el, anchor, last: anchor, active: false, until: performance.now() + 400 };
    }
    const value = Number(el.value), from = uiGesture.anchor;
    if (!hookReady || !Number.isFinite(from) || value - from > 30) {
      event.stopImmediatePropagation(); event.preventDefault();
      if (Number.isFinite(uiGesture.last)) el.value = String(uiGesture.last);
      blocked(Number.isFinite(from) ? `已拦截 ${from}→${value}（+${value - from} 档）；维持上一档，未发送` : "等待设备音量回报，本次调整未发送");
      return;
    }
    uiGesture.last = value;
    uiGesture.anchor = Math.min(uiGesture.anchor, value);
  }, true);
  // Ordinary controls keep the website's own events. Only the volume slider
  // has capture handlers; known non-volume reports pass through unchanged.
  function runSelfTest() {
    const fake = { vendorId: 0x0661, productId: 0x0883 };
    const packet = (l, r = l) => { const a = new Uint8Array(63); a.set([1, 63, 8, 1, 16, l, r]); return a; };
    const cases = [[20, 50, true], [20, 51, false], [70, 100, true], [67, 100, false], [80, 0, true], [0, 100, false]];
    let passed = 0;
    for (const [from, to, allowed] of cases) {
      const test = core.createGate(); test.configure({ version: 1, jumpThreshold: 30 }); test.observe(fake, from, from);
      let actual = true; try { test.prepare(fake, 0x4B, packet(to)); } catch { actual = false; }
      if (actual === allowed) passed++;
    }
    selfTest = { passed, total: cases.length, noHardwareCalls: true, hookIntact: status().hookReady };
    publish();
  }
  window.addEventListener("message", event => {
    if (event.source !== window) return;
    if (event.data?.type === "DC04U_GUARD_PING_V1") publish();
    if (event.data?.type === "DC04U_GUARD_SELFTEST_V1") runSelfTest();
  });
  runSelfTest();
  setInterval(publish, 2000);
})();
