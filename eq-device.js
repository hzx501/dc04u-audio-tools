(function installEQDeviceAPI(root) {
  "use strict";
  const VERSION = "1.0.0";
  const REVIEW_MS = 120000;
  const STAGE_MS = 300000;
  const TYPES = Object.freeze({ disable: 0, lowshelf: 1, peaking: 2, peak: 2, highshelf: 3, lowpass: 4, highpass: 5, bandpass: 6, allpass: 7 });
  const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
  const target = device => device && device.vendorId === 0x0661 && [0x0883, 0x0884].includes(device.productId);

  function failure(code, message, details) {
    const error = new Error(message);
    error.code = code;
    if (details) error.details = details;
    return error;
  }
  function finite(value, min, max, label) {
    if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
      throw failure("INVALID_PRESET", `${label} must be finite and within ${min}–${max}.`);
    }
    return value;
  }
  function slotNumber(value) {
    if (!Number.isInteger(value) || value < 1 || value > 3) throw failure("INVALID_SLOT", "Choose Custom 1, 2 or 3.");
    return value;
  }
  function profileFromPreset(preset) {
    if (!preset || typeof preset !== "object" || !Array.isArray(preset.bands) || preset.bands.length < 1 || preset.bands.length > 10) {
      throw failure("INVALID_PRESET", "DC04U accepts 1–10 bands; unused bands are padded with neutral peaks.");
    }
    const name = preset.name === undefined ? "Custom EQ" : preset.name;
    if (typeof name !== "string" || !name.trim() || name.length > 100) throw failure("INVALID_PRESET", "Preset name must contain 1–100 characters.");
    const preamp = finite(preset.preamp === undefined ? 0 : preset.preamp, -24, 12, "Preamp");
    const changes = [];
    const totalGain = Math.floor(preamp);
    if (totalGain !== preamp) changes.push({ parameter: "preamp", from: preamp, to: totalGain });
    const filterSettings = preset.bands.map((band, index) => {
      if (!band || typeof band !== "object") throw failure("INVALID_PRESET", `Invalid band ${index + 1}.`);
      const rawType = band.type === undefined ? "peaking" : band.type;
      const type = Number.isInteger(rawType) ? rawType : TYPES[String(rawType).toLowerCase()];
      if (!Number.isInteger(type) || type < 0 || type > 7) {
        throw failure("UNSUPPORTED_FILTER", "DC04U has no verified notch filter. Use one of its eight numeric filter types.");
      }
      if (band.enabled !== undefined && typeof band.enabled !== "boolean") throw failure("INVALID_PRESET", "enabled must be boolean.");
      const frequency = finite(band.frequency, 20, 20000, `Band ${index + 1} frequency`);
      const gain = finite(band.gain === undefined ? 0 : band.gain, -24, 12, `Band ${index + 1} gain`);
      const q = finite(band.q === undefined ? 0.7 : band.q, 0.1, 20, `Band ${index + 1} Q`);
      const disabled = band.enabled === false || type === 0;
      const result = {
        filterIndex: index, status: true, filterType: disabled ? 2 : type,
        frequency: Math.round(frequency), gain: disabled ? 0 : Math.round(gain * 256) / 256,
        factor: disabled ? 1 : Math.round(q * 256) / 256
      };
      for (const [parameter, from, to] of [["frequency", frequency, result.frequency], ["gain", gain, result.gain], ["q", q, result.factor]]) {
        if (from !== to) changes.push({ band: index, parameter, from, to });
      }
      if (disabled) changes.push({ band: index, parameter: "disabledMapping", from: rawType, to: "neutral-peaking-0dB" });
      return result;
    });
    const paddedBands = 10 - filterSettings.length;
    while (filterSettings.length < 10) filterSettings.push({ filterIndex: filterSettings.length, status: true, filterType: 2, frequency: 1000, gain: 0, factor: 1 });
    return {
      profile: { settingId: 0, name: name.trim(), totalGain, filterSettings },
      quantization: { frequencyStepHz: 1, bandGainStepDB: 1 / 256, qStep: 1 / 256, preampStepDB: 1, preampRounding: "floor", paddedBands, changes,
        officialJsonCompatible: filterSettings.every(band => band.factor >= 0.3), disabledMapping: "neutral-peaking-0dB" }
    };
  }
  function presetFromProfile(profile) {
    if (!profile || !Array.isArray(profile.filterSettings)) return null;
    const names = ["peaking", "lowshelf", "peaking", "highshelf", "lowpass", "highpass", "bandpass", "allpass"];
    if (profile.filterSettings.some(band => !Number.isInteger(band.filterType) || band.filterType < 0 || band.filterType > 7)) return null;
    return { name: profile.name || "Device EQ", preamp: profile.totalGain ?? 0, bands: profile.filterSettings.map(band => ({
      frequency: band.filterType === 0 ? 1000 : band.frequency, gain: band.filterType === 0 ? 0 : band.gain, q: band.filterType === 0 ? 1 : band.factor,
      type: names[band.filterType], enabled: band.status !== false && band.filterType !== 0
    })) };
  }

  function defaultStores() {
    const app = root.document?.querySelector("#app")?.__vue_app__;
    const pinia = app?.config?.globalProperties?.$pinia;
    if (!pinia?._s || typeof pinia._s.get !== "function") return null;
    return { device: pinia._s.get("device"), eq: pinia._s.get("eq") };
  }

  function createAdapter(options = {}) {
    const getStores = options.getStores || defaultStores;
    const now = options.now || (() => Date.now());
    const cryptoAPI = options.crypto || root.crypto;
    const userActivated = options.userActivated || (() => root.navigator?.userActivation?.isActive === true);
    const delay = options.delay || (milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)));
    const stages = new Map();
    const reviews = new Map();
    let busy = null;
    let epoch = 0;

    function token() {
      if (typeof cryptoAPI?.getRandomValues !== "function") throw failure("CRYPTO_UNAVAILABLE", "Secure random tokens are unavailable.");
      return Array.from(cryptoAPI.getRandomValues(new Uint8Array(32)), value => value.toString(16).padStart(2, "0")).join("");
    }
    async function digest(value) {
      if (typeof cryptoAPI?.subtle?.digest !== "function") throw failure("CRYPTO_UNAVAILABLE", "Review digest is unavailable.");
      const bytes = new TextEncoder().encode(JSON.stringify(value));
      return Array.from(new Uint8Array(await cryptoAPI.subtle.digest("SHA-256", bytes)), value => value.toString(16).padStart(2, "0")).join("");
    }
    function stores() {
      try { return getStores() || null; } catch (_) { return null; }
    }
    function currentIndex(store) {
      const value = store?.dc04u?.eqIndex ?? store?.deviceParams?.eqIndex;
      return Number.isInteger(value) && value >= 0 && value <= 10 ? value : null;
    }
    function session() {
      const found = stores();
      const deviceStore = found?.device;
      if (!deviceStore) throw failure("STORE_UNAVAILABLE", "Open the official DC04U control page and EQ view first.");
      const connected = deviceStore.isConnected === true || deviceStore.connectionState === "CONNECTED";
      if (!connected || !deviceStore.controller || !target(deviceStore.currentDevice)) {
        throw failure("DEVICE_UNAVAILABLE", "A connected supported DC04U is required.");
      }
      return { deviceStore, eqStore: found.eq, controller: deviceStore.controller, device: deviceStore.currentDevice, epoch };
    }
    function assertSession(captured) {
      const present = session();
      if (captured.epoch !== epoch || present.controller !== captured.controller || present.device !== captured.device) {
        throw failure("DISCONNECTED", "The control connection changed; review again before applying.");
      }
      return present;
    }
    function requireManual() {
      if (userActivated() !== true) throw failure("MANUAL_ACTION_REQUIRED", "Use the panel's explicit review/apply button.");
    }
    function profileCopy(value) {
      if (!value || !Array.isArray(value.filterSettings) || value.filterSettings.length !== 10) return null;
      try {
        return clone({ settingId: value.settingId, name: value.name || "Device EQ", totalGain: value.totalGain ?? 0, filterSettings: value.filterSettings.map((band, index) => ({
          filterIndex: band.filterIndex ?? index, status: band.status !== false, filterType: band.filterType,
          frequency: band.frequency, gain: band.gain, factor: band.factor
        })) });
      } catch (_) { return null; }
    }
    function cachedSlot(captured, index) {
      const controller = captured.controller;
      const cached = controller.slotCache?.get?.(index - 1);
      if (cached) return profileCopy(cached);
      if (controller.currentParametricEqualizer?.settingId === index - 1) return profileCopy(controller.currentParametricEqualizer);
      if (currentIndex(captured.deviceStore) === index) {
        try { return profileCopy(controller.getCurrentParametricEqualizer?.() || captured.eqStore?.currentEqualizer); } catch (_) { return null; }
      }
      return null;
    }
    async function readSlot(captured, index) {
      assertSession(captured);
      if (typeof captured.controller.readSlotForEqIndex !== "function") return { source: "cache", verified: false, profile: cachedSlot(captured, index) };
      await captured.controller.readSlotForEqIndex(index);
      assertSession(captured);
      const profile = cachedSlot(captured, index);
      if (!profile) throw failure("READBACK_UNAVAILABLE", "The official controller returned no complete slot data.");
      return { source: "official-readback", verified: true, profile };
    }
    function info() {
      const found = stores();
      const device = found?.device;
      const controller = device?.controller;
      const index = currentIndex(device);
      const connected = !!(target(device?.currentDevice) && controller && (device.isConnected === true || device.connectionState === "CONNECTED"));
      return {
        version: VERSION, available: !!device, connected, supportedDevice: target(device?.currentDevice) || false,
        device: device?.currentDevice ? { vendorId: device.currentDevice.vendorId, productId: device.currentDevice.productId, name: device.currentDevice.name || "DC04U" } : null,
        currentEqIndex: index, currentSlot: index >= 8 && index <= 10 ? index - 7 : null,
        canApply: connected && (typeof found?.eq?.applyPresetToSlot === "function" || (typeof controller.setEqualizer === "function" && typeof controller.setParametricEqualizer === "function")),
        readbackSupported: typeof controller?.readSlotForEqIndex === "function", busy, stagedCount: stages.size, reviewCount: reviews.size
      };
    }
    function prune() {
      const timestamp = now();
      for (const [key, value] of stages) if (timestamp >= value.expiresAt) stages.delete(key);
      for (const [key, value] of reviews) if (timestamp >= value.expiresAt) reviews.delete(key);
    }
    async function serial(label, operation) {
      if (busy) throw failure("BUSY", "Another EQ read/review/apply is still in progress.");
      busy = label;
      try { return await operation(); } finally { busy = null; }
    }
    function stage(payload) {
      prune();
      const slot = slotNumber(payload?.slot);
      const normalized = profileFromPreset(payload?.preset);
      const stageId = token();
      if (stages.size >= 20) stages.delete(stages.keys().next().value);
      const entry = { ...normalized, slot, expiresAt: now() + STAGE_MS };
      stages.set(stageId, entry);
      return { stageId, slot, expiresAt: entry.expiresAt, ...clone(normalized), hardwareWrites: 0 };
    }
    async function read(payload = {}) {
      const captured = session();
      const index = currentIndex(captured.deviceStore);
      const current = profileCopy(captured.eqStore?.currentEqualizer) || (index >= 8 ? cachedSlot(captured, index) : null);
      if (!payload.refresh || index === null || index < 8) return { ...info(), currentProfile: current, preset: presetFromProfile(current), source: "store", verified: false,
        warning: index !== null && index < 8 ? "The active mode is off or a built-in preset; the custom-EQ store snapshot may be cached." : null };
      return serial("read", async () => {
        const result = await readSlot(captured, index);
        return { ...info(), currentProfile: result.profile, preset: presetFromProfile(result.profile), source: result.source, verified: result.verified };
      });
    }
    async function review(payload) {
      requireManual();
      prune();
      const draft = stages.get(payload?.stageId);
      if (!draft) throw failure("STAGE_EXPIRED", "Stage the draft again before reviewing.");
      return serial("review", async () => {
        const captured = session();
        const currentEqIndex = currentIndex(captured.deviceStore);
        const currentSnapshot = profileCopy(captured.eqStore?.currentEqualizer);
        const backups = { capturedAt: now(), targetSlot: draft.slot, currentEqIndex, current: { source: "store", verified: false, profile: currentSnapshot }, target: { source: "cache", verified: false, profile: cachedSlot(captured, draft.slot + 7) } };
        const warnings = [];
        if (currentEqIndex >= 8 && currentEqIndex <= 10) {
          try { backups.current = await readSlot(captured, currentEqIndex); } catch (error) {
            assertSession(captured);
            warnings.push(`Current-slot backup: ${error.message}`);
          }
        }
        if (currentEqIndex === draft.slot + 7 && backups.current.verified) backups.target = clone(backups.current);
        else {
          try { backups.target = await readSlot(captured, draft.slot + 7); } catch (error) {
            assertSession(captured);
            warnings.push(`Target-slot backup: ${error.message}`);
          }
        }
        assertSession(captured);
        if (!backups.target.verified) warnings.push("The target-slot backup is absent or cached; it is not a verified hardware backup.");
        const reviewToken = token();
        const reviewDigest = await digest({ stageId: payload.stageId, slot: draft.slot, profile: draft.profile });
        assertSession(captured);
        const entry = { captured, slot: draft.slot, profile: clone(draft.profile), backups: clone(backups), digest: reviewDigest, expiresAt: now() + REVIEW_MS };
        reviews.set(reviewToken, entry);
        return { reviewToken, digest: reviewDigest, expiresAt: entry.expiresAt, slot: draft.slot, profile: clone(draft.profile), quantization: clone(draft.quantization), backups, warnings,
          changesActiveSlot: currentEqIndex !== draft.slot + 7, hardwareWrites: 0, confirmationRequired: true };
      });
    }
    function mismatch(expected, actual) {
      if (!actual || !Number.isFinite(actual.totalGain) || actual.totalGain !== expected.totalGain || actual.filterSettings?.length !== 10) return "Missing or different global gain/band count.";
      for (let index = 0; index < 10; index += 1) {
        const e = expected.filterSettings[index], a = actual.filterSettings[index];
        if (!a || a.filterType !== e.filterType || a.frequency !== e.frequency || !Number.isFinite(a.gain) || !Number.isFinite(a.factor) ||
            Math.abs(a.gain - e.gain) > 0.005000001 || Math.abs(a.factor - e.factor) > 0.005000001) return `Band ${index + 1} does not match the quantized draft.`;
      }
      return null;
    }
    async function commit(payload) {
      requireManual();
      const entry = reviews.get(payload?.reviewToken);
      if (!entry) throw failure("REVIEW_REQUIRED", "Create a new manual review before applying.");
      // Consume even an invalid/expired confirmation. Failure never replays it.
      reviews.delete(payload.reviewToken);
      if (now() >= entry.expiresAt) throw failure("REVIEW_EXPIRED", "The 120-second review expired; review again.");
      if (payload.digest !== entry.digest) throw failure("REVIEW_MISMATCH", "The confirmation does not match the reviewed draft.");
      return serial("commit", async () => {
        const captured = assertSession(entry.captured);
        const startIndex = currentIndex(captured.deviceStore);
        if (startIndex !== entry.backups.currentEqIndex) throw failure("DEVICE_CHANGED", "The EQ mode changed since review; review again.");
        let possiblyApplied = false;
        try {
          let accepted;
          if (typeof captured.eqStore?.applyPresetToSlot === "function") {
            possiblyApplied = true;
            accepted = await captured.eqStore.applyPresetToSlot(clone(entry.profile), entry.slot);
          } else if (typeof captured.controller.setEqualizer === "function" && typeof captured.controller.setParametricEqualizer === "function") {
            possiblyApplied = true;
            await captured.controller.setEqualizer(entry.slot + 7);
            assertSession(captured);
            captured.deviceStore.updateDc04uState?.({ eqIndex: entry.slot + 7 });
            await delay(150);
            assertSession(captured);
            await captured.controller.setParametricEqualizer(clone(entry.profile), entry.slot + 7);
            accepted = true;
          } else throw failure("APPLY_UNAVAILABLE", "The official EQ apply API is unavailable.");
          assertSession(captured);
          if (accepted !== true) throw failure("APPLY_REJECTED", "The official controller did not confirm submission.");
          if (typeof captured.controller.readSlotForEqIndex !== "function") {
            return { state: "submitted-unverified", slot: entry.slot, profile: clone(entry.profile), backups: clone(entry.backups), verified: false,
              warning: "Submitted through the official controller; hardware readback is unavailable." };
          }
          let readback;
          try { readback = await readSlot(captured, entry.slot + 7); } catch (error) {
            assertSession(captured);
            return { state: "submitted-unverified", slot: entry.slot, profile: clone(entry.profile), backups: clone(entry.backups), verified: false, warning: `Submission returned successfully, but readback failed: ${error.message}` };
          }
          const difference = mismatch(entry.profile, readback.profile);
          if (difference) throw failure("VERIFY_MISMATCH", difference, { readback: readback.profile });
          return { state: "verified", slot: entry.slot, profile: clone(entry.profile), readback: readback.profile, backups: clone(entry.backups), verified: true };
        } catch (error) {
          if (!error.code) error.code = "APPLY_FAILED";
          error.details = { ...error.details, possiblyApplied, automaticRetry: false, backups: clone(entry.backups) };
          throw error;
        }
      });
    }
    function cancel() {
      epoch += 1;
      stages.clear();
      reviews.clear();
      return { cancelled: true, inFlight: busy === "commit", note: busy === "commit" ? "Commands already submitted to the official controller cannot be recalled." : null };
    }
    async function handle(action, payload) {
      switch (action) {
        case "status": prune(); return info();
        case "read": return read(payload);
        case "stage": return stage(payload);
        case "review": return review(payload);
        case "commit": return commit(payload);
        case "cancel": return cancel();
        default: throw failure("UNKNOWN_ACTION", "Unknown EQ adapter action.");
      }
    }
    return Object.freeze({ handle, status: info, stage, read, review, commit, cancel, disconnect: cancel });
  }

  Object.defineProperty(root, "DC04UEQDevice", { value: Object.freeze({ createAdapter, profileFromPreset }), configurable: true });
  if (root.window === root && root.document && !root.__DC04U_EQ_ADAPTER_V1__) {
    const adapter = createAdapter();
    root.navigator?.hid?.addEventListener("disconnect", event => { if (target(event.device)) adapter.disconnect(); });
    root.addEventListener("message", event => {
      const request = event.data;
      if (event.source !== root || request?.type !== "DC04U_EQ_REQUEST_V1" || typeof request.id !== "string" || request.id.length > 100) return;
      adapter.handle(request.action, request.payload).then(result => {
        root.postMessage({ type: "DC04U_EQ_RESPONSE_V1", id: request.id, ok: true, result }, "*");
      }, error => {
        root.postMessage({ type: "DC04U_EQ_RESPONSE_V1", id: request.id, ok: false, error: { code: error.code || "ADAPTER_ERROR", message: String(error.message || error), details: error.details || null } }, "*");
      });
    });
    Object.defineProperty(root, "__DC04U_EQ_ADAPTER_V1__", { value: Object.freeze({ version: VERSION }), configurable: false });
  }
})(globalThis);
