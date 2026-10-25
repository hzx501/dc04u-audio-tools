'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createLibrary } = require('../eq-library.js');
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const url = value => `https://cdn-service.moondroplab.tech/api/v1/huihifi/evaluations/${value}/raw-fr`;
const record = n => ({ id: id(n), name: `Headphone ${n}`, rawUrl: url(id(n)), source: 'HuiHiFi via MOONDROP HUB', category: 'EARBUDS', brand: { name: 'Example' }, article: { description: 'Silicone tips, B&K 5128' } });
const catalog = count => ({ version: 'test-1', records: Array.from({ length: count }, (_, i) => record(i + 1)) });
const payload = (value, groups) => ({ code: 0, data: { uuid: value, title: 'Test measurement', rawFrDataList: groups || [{ group: 'Default', desc: 'L', name: 'Left channel', dataSet: [['Freq(Hz)', 'SPL(dB)'], ['20', '90'], ['1000', '0'], ['20000', '-5']] }] } });
const response = value => new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } });
const code = value => error => error.code === value;

test('only exact catalog IDs and their exact fixed CDN endpoint can fetch', async () => {
  let calls = 0;
  const c = catalog(1);
  const loader = createLibrary({ catalog: c, storage: null, fetch: async () => { calls++; return response(payload(id(1))); } });
  await assert.rejects(loader.loadRecord(id(2)), code('UNKNOWN_RECORD'));
  await assert.rejects(loader.loadRecord('https://example.com/'), code('UNKNOWN_RECORD'));
  for (const invalid of ['https://example.com/raw', url(id(2)), url(id(1)) + '?x=1', url(id(1)) + '#part', url(id(1)).replace('https:', 'http:'), url(id(1)).replace('cdn-service.', 'user@cdn-service.')]) {
    c.records[0].rawUrl = invalid;
    await assert.rejects(loader.loadRecord(id(1)), code('INVALID_URL'));
  }
  assert.equal(calls, 0);
});

test('network requests omit credentials/referrers, reject redirects, and never include device data', async () => {
  const c = catalog(1);
  let seen;
  const loader = createLibrary({ catalog: c, storage: null, fetch: async (rawUrl, options) => { seen = { rawUrl, options }; return response(payload(id(1))); } });
  const loaded = await loader.loadRecord(id(1));
  assert.equal(seen.rawUrl, url(id(1)));
  assert.equal(seen.options.method, 'GET');
  assert.equal(seen.options.credentials, 'omit');
  assert.equal(seen.options.referrerPolicy, 'no-referrer');
  assert.equal(seen.options.redirect, 'error');
  assert.equal(seen.options.mode, 'cors');
  assert.equal(seen.options.body, undefined);
  assert.equal(loaded.cached, false);
});

test('headers and invalid rows are removed, real zero dB remains, frequencies sort and deduplicate', async () => {
  const rows = [['Freq(Hz)', 'SPL(dB)'], ['1000', '0'], ['20', '91'], ['1000', '100'], ['20000', '-4'], [0, 0], [-10, 3], ['Infinity', 2], [40, ''], [50, null], [60, 'NaN'], null];
  const loader = createLibrary({ catalog: catalog(1), storage: null, fetch: async () => response(payload(id(1), [{ group: 'Mode A', desc: 'R', dataSet: rows }])) });
  const loaded = await loader.loadRecord(id(1));
  assert.deepEqual(loaded.curves[0].points, [{ frequency: 20, db: 91 }, { frequency: 1000, db: 0 }, { frequency: 20000, db: -4 }]);
  assert.equal(loaded.curves[0].rig, 'B&K 5128');
});

test('different groups and left/right descriptions stay independent without averaging', async () => {
  const groups = [
    { group: 'Stock tips', desc: 'L', name: 'Left', dataSet: [[100, 90], [1000, 1]] },
    { group: 'Stock tips', desc: 'R', name: 'Right', dataSet: [[100, 92], [1000, 3]] },
    { group: 'Foam tips', desc: 'L', name: '', dataSet: [[100, 95], [1000, 6]] }
  ];
  const loader = createLibrary({ catalog: catalog(1), storage: null, fetch: async () => response(payload(id(1), groups)) });
  const loaded = await loader.loadRecord(id(1));
  assert.equal(loaded.curves.length, 3);
  assert.deepEqual(loaded.curves.map(curve => curve.id), [0, 1, 2].map(index => `hui-${id(1)}-${index}`));
  assert.deepEqual(loaded.curves.map(curve => curve.points[0].db), [90, 92, 95]);
  assert.equal(loaded.curves[1].description, 'R');
  assert.ok(loaded.curves[1].name.includes('Right'));
});

test('skipping an empty group preserves the original raw group index', async () => {
  const loader = createLibrary({ catalog: catalog(1), storage: null, fetch: async () => response(payload(id(1), [{ dataSet: [['header', 'header']] }, { group: 'Second', dataSet: [[20, 0]] }])) });
  assert.equal((await loader.loadRecord(id(1))).curves[0].id, `hui-${id(1)}-1`);
});

test('only an explicit target name marks a target; article prose does not', async () => {
  const c = catalog(2);
  c.records[0].name = 'VDSF Target Response';
  c.records[1].article.description = '可以对照目标曲线调音';
  const loader = createLibrary({ catalog: c, storage: null, fetch: async rawUrl => response(payload(rawUrl.includes(id(1)) ? id(1) : id(2))) });
  assert.equal((await loader.loadRecord(id(1))).curves[0].kind, 'target');
  assert.equal((await loader.loadRecord(id(2))).curves[0].kind, 'measurement');
});

test('memory-cache hits do not network and callers cannot mutate cached points or metadata', async () => {
  let calls = 0;
  const loader = createLibrary({ catalog: catalog(1), storage: null, fetch: async () => { calls++; return response(payload(id(1))); } });
  const first = await loader.loadRecord(id(1));
  first.curves[0].points[0].db = 999;
  first.record.name = 'mutated';
  const second = await loader.loadRecord(id(1));
  assert.equal(second.cacheSource, 'memory');
  assert.equal(second.curves[0].points[0].db, 90);
  assert.equal(second.record.name, 'Headphone 1');
  assert.equal(calls, 1);
});

test('memory-cache capacity is bounded by LRU and recent use moves a record forward', async () => {
  let calls = 0;
  const loader = createLibrary({ catalog: catalog(3), cacheLimit: 2, storage: null, fetch: async rawUrl => { calls++; const value = /evaluations\/([^/]+)\//.exec(rawUrl)[1]; return response(payload(value)); } });
  await loader.loadRecord(id(1)); await loader.loadRecord(id(2)); await loader.loadRecord(id(1)); await loader.loadRecord(id(3));
  assert.equal(loader.cacheInfo().size, 2);
  assert.equal(loader.cacheInfo().keys.some(key => key.includes(id(2))), false);
  await loader.loadRecord(id(2));
  assert.equal(calls, 4);
});

test('persistent cache can load in a new session without network', async () => {
  const saved = new Map();
  const storage = { get: async key => saved.get(key), put: async (key, value) => { saved.set(key, value); } };
  const first = createLibrary({ catalog: catalog(1), storage, fetch: async () => response(payload(id(1))) });
  await first.loadRecord(id(1));
  const second = createLibrary({ catalog: catalog(1), storage, fetch: async () => { throw new Error('offline; should never fetch'); } });
  const loaded = await second.loadRecord(id(1));
  assert.equal(loaded.cacheSource, 'indexeddb');
  assert.equal(loaded.curves[0].points[1].db, 0);
});

test('storage failures fall back to usable memory, and catalog revisions invalidate persistent cache', async () => {
  let calls = 0;
  const broken = { get: async () => { throw new Error('denied'); }, put: async () => { throw new Error('quota'); } };
  const c = catalog(1);
  const loader = createLibrary({ catalog: c, storage: broken, fetch: async () => { calls++; return response(payload(id(1))); } });
  await loader.loadRecord(id(1)); await loader.loadRecord(id(1));
  assert.equal(calls, 1);
  c.version = 'test-2';
  await loader.loadRecord(id(1));
  assert.equal(calls, 2);
});

test('a browser IndexedDB open exception falls back without preventing curve loading', async () => {
  let calls = 0;
  const loader = createLibrary({ catalog: catalog(1), indexedDB: { open() { throw new Error('Storage disabled'); } }, fetch: async () => { calls++; return response(payload(id(1))); } });
  await loader.loadRecord(id(1));
  assert.equal((await loader.loadRecord(id(1))).cacheSource, 'memory');
  assert.equal(calls, 1);
});

test('HTTP errors, nonzero service codes, mismatched IDs and malformed data reject without caching', async () => {
  const bad = [
    new Response('no', { status: 403 }),
    response({ code: 1, data: {} }),
    response(payload(id(2))),
    new Response('not JSON', { status: 200 }),
    response({ code: 0, data: { rawFrDataList: [{ dataSet: [['header', 'header']] }] } })
  ];
  for (const value of bad) {
    const loader = createLibrary({ catalog: catalog(1), storage: null, fetch: async () => value });
    await assert.rejects(loader.loadRecord(id(1)));
    assert.equal(loader.cacheInfo().size, 0);
  }
});

test('declared and streamed byte limits stop oversize responses before parsing', async () => {
  for (const create of [
    () => new Response('{}', { headers: { 'content-length': '65' } }),
    () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(40)); controller.enqueue(new Uint8Array(40)); controller.close(); } }))
  ]) {
    let signal;
    const loader = createLibrary({ catalog: catalog(1), storage: null, maxBytes: 64, fetch: async (_, options) => { signal = options.signal; return create(); } });
    await assert.rejects(loader.loadRecord(id(1)), code('TOO_LARGE'));
    assert.equal(signal.aborted, true);
  }
});

test('timeouts reject and abort even if a mocked fetch never settles', async () => {
  let signal;
  const loader = createLibrary({ catalog: catalog(1), storage: null, timeoutMs: 5, fetch: (_, options) => { signal = options.signal; return new Promise(() => {}); } });
  await assert.rejects(loader.loadRecord(id(1)), code('TIMEOUT'));
  assert.equal(signal.aborted, true);
  assert.equal(loader.cacheInfo().size, 0);
});

test('caller cancellation works before fetch and during loading without populating cache', async () => {
  const early = new AbortController(); early.abort();
  let calls = 0;
  const loader = createLibrary({ catalog: catalog(1), storage: null, fetch: () => { calls++; return new Promise(() => {}); } });
  await assert.rejects(loader.loadRecord(id(1), { signal: early.signal }), code('ABORTED'));
  assert.equal(calls, 0);
  const controller = new AbortController();
  const pending = loader.loadRecord(id(1), { signal: controller.signal });
  await Promise.resolve(); await Promise.resolve();
  controller.abort();
  await assert.rejects(pending, code('ABORTED'));
  assert.equal(loader.cacheInfo().size, 0);
});

test('synthetic raw fixture parses without network and preserves its mathematical point grid', async () => {
  const raw = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/huihifi-raw-sample.json'), 'utf8'));
  const value = raw.data.uuid;
  const c = { version: 'saved-sample', records: [{ id: value, name: raw.data.title, rawUrl: url(value) }] };
  const loader = createLibrary({ catalog: c, storage: null, fetch: async () => response(raw) });
  const loaded = await loader.loadRecord(value);
  assert.equal(loaded.curves.length, 2);
  assert.equal(raw.synthetic, true);
  assert.equal(loaded.curves[0].group, 'Synthetic mode A');
  assert.equal(loaded.curves[1].group, 'Synthetic mode B');
  assert.equal(loaded.curves[0].points.length, raw.data.rawFrDataList[0].dataSet.length - 1);
});
