(function (root, factory) {
  "use strict";
  const api = factory(root);
  if (typeof module === "object" && module.exports) module.exports = api;
  if (typeof define === "function" && define.amd) define([], () => api);
  root.DC04UEqLibrary = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function (root) {
  "use strict";
  const MAX_BYTES = 8 * 1024 * 1024;
  const TIMEOUT_MS = 20000;
  const CACHE_LIMIT = 10;
  const ORIGIN = "https://cdn-service.moondroplab.tech";
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const clone = value => JSON.parse(JSON.stringify(value));
  const text = value => typeof value === "string" ? value.trim() : "";
  function fail(code, message) { const error = new Error(message); error.code = code; return error; }
  function checkSignal(signal) { if (signal?.aborted) throw fail("ABORTED", "Curve loading was cancelled."); }
  function number(value) {
    if (typeof value !== "number" && (typeof value !== "string" || value.trim() === "")) return NaN;
    return Number(value);
  }
  function explicitTarget(name) { return /\btarget\b|目标曲线|靶曲线/i.test(name); }
  function rigName(record, raw, data) {
    const explicit = text(raw.rig) || text(record.rig) || text(data.rig);
    if (explicit) return explicit;
    const labels = [record.name, data.title, raw.name, raw.group, raw.desc, record.article?.description].filter(value => typeof value === "string").join(" ");
    const match = labels.match(/(?:B\s*&\s*K\s*(?:5128|4195|4128)|GRAS(?:\s*[A-Z0-9-]+)?|IEC\s*60318[-–]4|\b(?:5128|4195|4128|711)\b)/i);
    return match ? match[0] : "未标注（请核对原始说明）";
  }
  function normalizeResponse(payload, record) {
    if (!payload || payload.code !== 0 || !payload.data || !Array.isArray(payload.data.rawFrDataList)) {
      throw fail("INVALID_RESPONSE", "The public curve service did not return code 0 and raw frequency-response data.");
    }
    const data = payload.data;
    if (data.uuid !== undefined && data.uuid !== record.id) throw fail("RECORD_MISMATCH", "The service returned a different catalog record.");
    const curves = [];
    data.rawFrDataList.forEach((raw, index) => {
      if (!raw || !Array.isArray(raw.dataSet)) return;
      const values = new Map();
      for (const row of raw.dataSet) {
        if (!Array.isArray(row) || row.length < 2) continue;
        const frequency = number(row[0]), db = number(row[1]);
        // Keep a real zero dB value; headers, empty cells and non-finite rows
        // are invalid. Duplicate frequencies retain the first original row.
        if (Number.isFinite(frequency) && frequency > 0 && Number.isFinite(db) && !values.has(frequency)) values.set(frequency, db);
      }
      const points = Array.from(values, ([frequency, db]) => ({ frequency, db })).sort((a, b) => a.frequency - b.frequency);
      if (!points.length) return;
      const group = text(raw.group), description = text(raw.desc), rawName = text(raw.name);
      const title = text(record.name) || text(record.title) || text(data.title) || record.id;
      const suffix = [...new Set([group, rawName, description].filter(Boolean))].join(" · ");
      const tags = [...new Set([record.brand?.name, record.category, group, rawName, description].filter(value => typeof value === "string" && value.trim()).map(value => value.trim()))];
      curves.push({
        id: `hui-${record.id}-${index}`, name: suffix ? `${title} · ${suffix}` : title,
        kind: record.kind === "target" || explicitTarget(title) || explicitTarget(text(data.title)) || explicitTarget(rawName) ? "target" : "measurement",
        rig: rigName(record, raw, data), source: text(record.source) || "HuiHiFi via MOONDROP HUB", url: record.rawUrl,
        points, tags, group, description, rawName, recordId: record.id,
        conditions: text(record.article?.description), rawIndex: index
      });
    });
    if (!curves.length) throw fail("NO_CURVES", "This record contains no usable finite frequency-response points.");
    return { curves, record: clone(record) };
  }

  function indexedStorage(indexedDB, now, limit) {
    let opening;
    async function database() {
      if (!indexedDB || typeof indexedDB.open !== "function") return null;
      if (!opening) opening = new Promise(resolve => {
        let request;
        try { request = indexedDB.open("DC04U-HuiHiFi-CurveCache-v1", 1); } catch (_) { resolve(null); return; }
        request.onupgradeneeded = () => {
          try { if (!request.result.objectStoreNames.contains("records")) request.result.createObjectStore("records", { keyPath: "key" }); } catch (_) { /* Storage failure falls back to memory. */ }
        };
        request.onsuccess = () => { request.result.onversionchange = () => request.result.close(); resolve(request.result); };
        request.onerror = request.onblocked = () => resolve(null);
      });
      return opening;
    }
    async function get(key) {
      const db = await database();
      if (!db) return null;
      return new Promise(resolve => {
        try {
          const transaction = db.transaction("records", "readwrite"), store = transaction.objectStore("records"), request = store.get(key);
          let result = null;
          request.onsuccess = () => { result = request.result || null; if (result) store.put({ ...result, usedAt: now() }); };
          transaction.oncomplete = () => resolve(result?.value || null);
          transaction.onerror = transaction.onabort = () => resolve(null);
        } catch (_) { resolve(null); }
      });
    }
    async function put(key, value) {
      const db = await database();
      if (!db) return;
      await new Promise(resolve => {
        try {
          const transaction = db.transaction("records", "readwrite"), store = transaction.objectStore("records");
          store.put({ key, value, usedAt: now() });
          const request = store.getAll();
          request.onsuccess = () => {
            const entries = request.result.sort((a, b) => b.usedAt - a.usedAt);
            for (const entry of entries.slice(limit)) store.delete(entry.key);
          };
          transaction.oncomplete = transaction.onerror = transaction.onabort = () => resolve();
        } catch (_) { resolve(); }
      });
    }
    return { get, put };
  }

  function createLibrary(options = {}) {
    const getCatalog = typeof options.catalog === "function" ? options.catalog : () => options.catalog || root.DC04UHuiHiFiCatalog || root.window?.DC04UHuiHiFiCatalog;
    const fetcher = options.fetch || (typeof root.fetch === "function" ? root.fetch.bind(root) : null);
    const timeoutMs = options.timeoutMs ?? TIMEOUT_MS;
    const maxBytes = options.maxBytes ?? MAX_BYTES;
    const cacheLimit = options.cacheLimit ?? CACHE_LIMIT;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > TIMEOUT_MS || !Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_BYTES || !Number.isInteger(cacheLimit) || cacheLimit < 1 || cacheLimit > CACHE_LIMIT) {
      throw new TypeError("Invalid curve-loader timeout, byte limit or cache limit.");
    }
    const now = options.now || (() => Date.now());
    const memory = new Map();
    const storage = options.storage === undefined ? indexedStorage(options.indexedDB === undefined ? root.indexedDB : options.indexedDB, now, cacheLimit) : options.storage;
    function knownRecord(id) {
      const catalog = getCatalog();
      if (typeof id !== "string" || !UUID.test(id) || !Array.isArray(catalog?.records)) throw fail("UNKNOWN_RECORD", "Choose an exact ID from the bundled public catalog.");
      const record = catalog.records.find(value => value.id === id);
      if (!record) throw fail("UNKNOWN_RECORD", "This ID is not in the bundled public catalog.");
      const expected = `${ORIGIN}/api/v1/huihifi/evaluations/${id}/raw-fr`;
      let url;
      try { url = new URL(record.rawUrl); } catch (_) { throw fail("INVALID_URL", "Invalid public raw-data URL."); }
      if (record.rawUrl !== expected || url.href !== expected || url.origin !== ORIGIN || url.search || url.hash || url.username || url.password) {
        throw fail("INVALID_URL", "Only the matching catalog CDN raw-fr endpoint is allowed.");
      }
      return { record: clone(record), key: `${catalog.version || "unversioned"}|${id}|${expected}` };
    }
    function remember(key, value) {
      memory.delete(key);
      memory.set(key, clone(value));
      while (memory.size > cacheLimit) memory.delete(memory.keys().next().value);
    }
    function validCache(value, record) {
      return value?.record?.id === record.id && Array.isArray(value.curves) && value.curves.length > 0 && value.curves.every(curve =>
        typeof curve.id === "string" && curve.id.startsWith(`hui-${record.id}-`) && curve.url === record.rawUrl &&
        Array.isArray(curve.points) && curve.points.length > 0 && curve.points.every(point => Number.isFinite(point.frequency) && point.frequency > 0 && Number.isFinite(point.db)));
    }
    async function boundedText(response) {
      const declared = Number(response.headers?.get?.("content-length"));
      if (Number.isFinite(declared) && declared > maxBytes) throw fail("TOO_LARGE", "The public curve response exceeds the 8 MB limit.");
      const reader = response.body?.getReader?.();
      if (reader) {
        const chunks = [];
        let length = 0;
        try {
          while (true) {
            const chunk = await reader.read();
            if (chunk.done) break;
            const bytes = chunk.value instanceof Uint8Array ? chunk.value : new Uint8Array(chunk.value);
            length += bytes.byteLength;
            if (length > maxBytes) { Promise.resolve(reader.cancel()).catch(() => {}); throw fail("TOO_LARGE", "The public curve response exceeds the 8 MB limit."); }
            chunks.push(bytes);
          }
        } finally { try { reader.releaseLock(); } catch (_) { /* Already aborted. */ } }
        const bytes = new Uint8Array(length);
        let offset = 0;
        for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
        return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      }
      if (typeof response.arrayBuffer === "function") {
        const buffer = await response.arrayBuffer();
        if (buffer.byteLength > maxBytes) throw fail("TOO_LARGE", "The public curve response exceeds the 8 MB limit.");
        return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
      }
      const value = await response.text();
      if (new TextEncoder().encode(value).byteLength > maxBytes) throw fail("TOO_LARGE", "The public curve response exceeds the 8 MB limit.");
      return value;
    }
    async function remote(record, signal) {
      if (!fetcher) throw fail("FETCH_UNAVAILABLE", "The browser does not provide fetch.");
      const controller = new AbortController();
      let rejectAbort, reason;
      const aborted = new Promise((_, reject) => { rejectAbort = reject; });
      const abort = error => { if (!reason) { reason = error; controller.abort(); rejectAbort(error); } };
      const listener = () => abort(fail("ABORTED", "Curve loading was cancelled."));
      signal?.addEventListener?.("abort", listener, { once: true });
      const timer = setTimeout(() => abort(fail("TIMEOUT", "The public curve request exceeded 20 seconds.")), timeoutMs);
      try {
        const operation = (async () => {
          const response = await fetcher(record.rawUrl, { method: "GET", mode: "cors", credentials: "omit", referrerPolicy: "no-referrer", redirect: "error", cache: "no-store", signal: controller.signal });
          if (!response?.ok) throw fail("HTTP_ERROR", `The public curve service returned HTTP ${response?.status ?? "unknown"}.`);
          let payload;
          try { payload = JSON.parse(await boundedText(response)); } catch (error) {
            if (error.code) throw error;
            throw fail("INVALID_RESPONSE", "The public curve service returned invalid JSON or text encoding.");
          }
          return normalizeResponse(payload, record);
        })();
        checkSignal(signal);
        return await Promise.race([operation, aborted]);
      } catch (error) {
        controller.abort();
        if (reason) throw reason;
        if (error.code) throw error;
        throw fail(signal?.aborted ? "ABORTED" : "NETWORK_ERROR", String(error.message || error));
      } finally { clearTimeout(timer); signal?.removeEventListener?.("abort", listener); }
    }
    async function loadRecord(id, { signal } = {}) {
      checkSignal(signal);
      const { record, key } = knownRecord(id);
      if (memory.has(key)) {
        const value = memory.get(key);
        remember(key, value);
        return { ...clone(value), cached: true, cacheSource: "memory" };
      }
      let cached;
      try { cached = await storage?.get?.(key); } catch (_) { /* Storage is optional. */ }
      checkSignal(signal);
      if (validCache(cached, record)) {
        remember(key, cached);
        return { ...clone(cached), cached: true, cacheSource: "indexeddb" };
      }
      const value = await remote(record, signal);
      checkSignal(signal);
      remember(key, value);
      try { await storage?.put?.(key, clone(value)); } catch (_) { /* Memory cache remains usable. */ }
      checkSignal(signal);
      return { ...clone(value), cached: false, cacheSource: "network" };
    }
    return Object.freeze({ loadRecord, cacheInfo: () => ({ size: memory.size, limit: cacheLimit, keys: [...memory.keys()] }), clearMemory: () => memory.clear() });
  }
  const library = createLibrary();
  return Object.freeze({ loadRecord: library.loadRecord, createLibrary, cacheInfo: library.cacheInfo, clearMemory: library.clearMemory });
});
