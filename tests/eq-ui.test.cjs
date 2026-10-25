'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const math = require('../eq-math.js');
const script = fs.readFileSync(path.join(__dirname, '..', 'eq-ui.js'), 'utf8');

// These are UI interaction tests, not browser or HID integration tests. The
// real UI handlers run, while the minimal DOM records their visible outputs.
function editor(initialStorage = [], options = {}) {
  const nodes = new Map(), windowListeners = new Map(), frames = [], timers = new Map(), storage = new Map(initialStorage), requests = [];
  let timerId = 0, shadow;
  class Node {
    constructor() {
      this.value = ''; this.textContent = ''; this._html = ''; this.htmlWrites = 0; this.hidden = false; this.open = false;
      this.dataset = {}; this.style = {}; this.isConnected = false; this.listeners = new Map();
      this.classList = { add() {}, remove() {}, toggle() {} };
    }
    get innerHTML() { return this._html; }
    set innerHTML(html) {
      this._html = html; this.htmlWrites++;
      for (const match of html.matchAll(/<input\b([^>]*data-numeric="[^"]*"[^>]*)>/g)) {
        const n = new Node();
        for (const attr of match[1].matchAll(/([\w-]+)="([^"]*)"/g)) n.setAttribute(attr[1], attr[2]);
        n.isConnected = true; nodes.set('#' + n.id, n);
      }
    }
    addEventListener(type, callback) {
      if (!this.listeners.has(type)) this.listeners.set(type, []);
      this.listeners.get(type).push(callback);
    }
    querySelector(selector) {
      if (!nodes.has(selector)) nodes.set(selector, new Node());
      return nodes.get(selector);
    }
    querySelectorAll(selector) { return selector === '[data-numeric]' ? [...new Set(nodes.values())].filter(n => n.dataset.numeric) : []; }
    get options() {
      return Array.from(this.innerHTML.matchAll(/<option\b([^>]*)>([\s\S]*?)<\/option>/g), match => ({
        value: match[1].match(/\bvalue="([^"]*)"/)?.[1] || '',
        textContent: match[2], selected: /\bselected\b/.test(match[1]),
      }));
    }
    attachShadow() { shadow = new Node(); return shadow; }
    appendChild(child) { child.parentElement = this; child.isConnected = true; return child; }
    append(child) { if (child && typeof child === 'object') this.appendChild(child); }
    setAttribute(name, value) {
      this[name] = value;
      if (name.startsWith('data-')) this.dataset[name.slice(5).replace(/-([a-z])/g, (_,c) => c.toUpperCase())] = value;
    }
    getAttribute(name) { return this[name] ?? null; }
    focus() { shadow.activeElement = this; }
    select() { this.selectionStart = 0; this.selectionEnd = this.value.length; }
    closest(selector) { return selector === '[data-step]' && this.dataset.step ? this : null; }
    replaceChildren() {}
    showModal() { this.open = true; }
    close() { this.open = false; }
    click() { return this.onclick?.({ isTrusted: false, target: this }); }
  }
  const document = new Node(), nav = new Node(), page = new Node();
  document.readyState = 'complete'; document.documentElement = new Node();
  document.createElement = () => new Node();
  document.querySelector = selector => selector === '.dc04u-nav .nav-tabs[role=tablist]' ? nav : selector === '.dc04u-page' ? page : null;
  const localStorage = { getItem: key => storage.get(key) || null, setItem: (key, value) => storage.set(key, value) };
  const curves = [
    { id: 'measurement', name: 'METEOR 4195', kind: 'measurement', rig: '4195', points: [[20, 0], [100, 0], [1000, 0], [10000, 0], [20000, 0]].map(([frequency, db]) => ({ frequency, db })) },
    { id: 'alternate', name: 'Another headphone 4195', kind: 'measurement', rig: '4195', points: [[20, 3], [100, 3], [1000, 0], [10000, -3], [20000, -3]].map(([frequency, db]) => ({ frequency, db })) },
    { id: 'target', name: 'VDSF 4195', kind: 'target', rig: '4195', points: [[20, 0], [100, 0], [1000, 0], [10000, 0], [20000, 0]].map(([frequency, db]) => ({ frequency, db })) },
  ];
  const sandbox = {
    DC04UEqMath: math, DC04UCurveLibrary: { curves }, DC04UHuiHiFiCatalog: { records: options.records || [] },
    DC04UEqLibrary: { loadRecord: options.loadRecord },
    document, localStorage, location: { hash: '#/device/DC04U' },
    MutationObserver: class { observe() {} },
    setTimeout: callback => { const id = ++timerId; timers.set(id, callback); return id; },
    clearTimeout: id => timers.delete(id),
    requestAnimationFrame: callback => { frames.push(callback); return frames.length; },
    addEventListener: (type, callback) => {
      if (!windowListeners.has(type)) windowListeners.set(type, []);
      windowListeners.get(type).push(callback);
    },
    postMessage: message => { if (message.type === 'DC04U_EQ_REQUEST_V1') requests.push(message); },
  };
  sandbox.__testWindowListeners = windowListeners;
  sandbox.window = sandbox; sandbox.top = sandbox;
  const context = vm.createContext(sandbox);
  vm.runInContext(script, context, { filename: 'eq-ui.js' });
  const node = selector => {
    assert.ok(nodes.has(selector), `The UI must provide ${selector}`);
    return nodes.get(selector);
  };
  function importText(text) {
    node('#import').onclick(); node('#io-text').value = text; node('#io-apply').onclick();
  }
  function exportProfile() {
    node('#io-cancel').onclick(); node('#export').onclick();
    const result = JSON.parse(node('#io-text').value); node('#io-cancel').onclick();
    return result;
  }
  const emit = (type, target, extra = {}) => {
    const event = {target, preventDefault() {}, ...extra};
    for(const handler of shadow.listeners.get(type) || []) handler(event);
  };
  return { node, importText, exportProfile, requests, storage, curves, emit,
    focus(id) { const input=node(id); input.focus(); emit('focusin',input); return input; },
    input(input,text) { input.value=text;emit('input',input); },
    key(input,key,extra={}) { emit('keydown',input,{key,...extra}); },
    blur(input) { emit('change',input);emit('focusout',input);shadow.activeElement=null; },
    active() { return shadow.activeElement; },
    flushGraph() { while (frames.length) frames.shift()(); },
    flushTimers() { const scheduled = [...timers.values()]; timers.clear(); scheduled.forEach(callback => callback()); },
    respond(action, result) {
      const request = requests.filter(item => item.action === action).at(-1);
      assert.ok(request, `Expected an outgoing ${action} request`);
      const data = JSON.stringify({ type: 'DC04U_EQ_RESPONSE_V1', id: request.id, ok: true, result });
      vm.runInContext(`for (const listener of __testWindowListeners.get('message') || []) listener({ source: window, data: ${data} });`, context);
    },
  };
}

function profile() {
  return JSON.parse(math.formatOfficialJSON({ name: 'Recovered backup', preamp: -7, bands: [
    { frequency: 2500, gain: -5.5, q: 1.75, type: 'peaking', enabled: true },
  ] }));
}

test('downloaded target-slot backup JSON can be restored through the real import handler', () => {
  for (const backup of [{ target: { profile: profile() } }, { backups: { target: { profile: profile() } } }]) {
    const ui = editor();
    ui.importText(JSON.stringify(backup));
    assert.equal(ui.node('#io-dialog').open, false);
    const exported = ui.exportProfile();
    assert.equal(exported.name, 'Recovered backup');
    assert.equal(exported.totalGain, -7);
    assert.equal(exported.filterSettings[0].frequency, 2500);
    assert.equal(exported.filterSettings[0].gain, -5.5);
    assert.deepEqual(ui.requests, [], 'import/export must remain entirely offline');
  }
});

test('a CSV with repeated frequencies is rejected before corrupting the selected curve', () => {
  const ui = editor(), before = ui.curves.length;
  ui.importText(Array.from({ length: 10 }, (_, i) => `1000,${i}`).join('\n'));
  assert.equal(ui.node('#io-dialog').open, true);
  assert.ok(ui.node('#io-hint').textContent.length > 0);
  assert.equal(ui.curves.length, before);
  assert.deepEqual(ui.requests, []);
});

test('a CSV without the required 1 kHz reference is rejected with the previous curve intact', () => {
  const ui = editor(), before = ui.curves.length;
  ui.importText(Array.from({ length: 10 }, (_, i) => `${20 + i * 20},0`).join('\n'));
  assert.equal(ui.node('#io-dialog').open, true);
  assert.ok(ui.node('#io-hint').textContent.length > 0);
  assert.equal(ui.curves.length, before);
});

test('an enabled AutoEq notch is rejected rather than displayed as a different hardware filter', () => {
  const ui = editor(), before = ui.exportProfile();
  ui.importText('Preamp: -6 dB\nFilter 1: ON NO Fc 1000 Hz Q 2');
  assert.equal(ui.node('#io-dialog').open, true);
  assert.match(ui.node('#io-hint').textContent, /Notch|notch/);
  assert.deepEqual(ui.exportProfile(), before);
});

test('out-of-range imported numbers leave the original draft unchanged', () => {
  const ui = editor(), before = ui.exportProfile(), invalid = profile();
  invalid.filterSettings[0].frequency = 30000;
  ui.importText(JSON.stringify(invalid));
  assert.equal(ui.node('#io-dialog').open, true);
  assert.ok(ui.node('#io-hint').textContent.length > 0);
  assert.deepEqual(ui.exportProfile(), before);
  assert.deepEqual(ui.requests, []);
});

test('frequency comparison produces three finite numeric curves through the public math API', () => {
  const ui = editor();
  ui.importText(JSON.stringify(profile()));
  ui.node('#mode-fr').onclick(); ui.flushGraph();
  const svg = ui.node('#graph').innerHTML;
  assert.equal((svg.match(/<path\b/g) || []).length, 3);
  assert.doesNotMatch(svg, /NaN|Infinity|\[object Object\]/);
  assert.deepEqual(ui.requests, []);
});

test('reset changes only the draft and saved presets can restore the previous values', () => {
  const ui = editor();
  ui.importText(JSON.stringify(profile()));
  ui.node('#save-local').onclick();
  ui.node('#reset').onclick();
  const reset = ui.exportProfile();
  assert.equal(reset.totalGain, 0);
  assert.ok(reset.filterSettings.every(filter => filter.gain === 0));
  ui.node('#saved').value = '0'; ui.node('#load-local').onclick();
  const restored = ui.exportProfile();
  assert.equal(restored.totalGain, -7);
  assert.equal(restored.filterSettings[0].gain, -5.5);
  assert.deepEqual(ui.requests, []);
});

test('the original-curve selector can choose a non-METEOR measurement and persist its distinct preview', () => {
  const ui = editor();
  ui.node('#mode-fr').onclick(); ui.flushGraph();
  const previousGraph = ui.node('#graph').innerHTML;
  const original = ui.node('#measurement');
  original.value = 'alternate'; original.onchange({ target: original });
  ui.flushGraph(); ui.flushTimers();
  assert.notEqual(ui.node('#graph').innerHTML, previousGraph, 'a different measured shape must change the comparison');
  assert.doesNotMatch(ui.node('#graph').innerHTML, /NaN|Infinity/);
  const persisted = JSON.parse(ui.storage.get('dc04uAdvancedEqDraftV1'));
  assert.equal(persisted.measurement, 'alternate');
  assert.equal(persisted.draft.bands.length, 10);
  assert.deepEqual(ui.requests, [], 'choosing an original curve cannot stage or commit a device change');
});

test('filtering original-curve choices preserves the selected nonmatching measurement', () => {
  const ui = editor(), original = ui.node('#measurement');
  original.value = 'alternate'; original.onchange({ target: original });
  const search = ui.node('#source-search');
  search.value = 'METEOR'; search.oninput({ target: search });
  assert.match(original.innerHTML, /value="measurement"/, 'the matching choice remains available');
  assert.match(original.innerHTML, /<option\b[^>]*value="alternate"[^>]*selected[^>]*>/,
    'the selected curve remains explicitly selected even when it does not match the query');
  search.value = 'nothing matches this query'; search.oninput({ target: search });
  assert.match(original.innerHTML, /<option\b[^>]*value="alternate"[^>]*selected[^>]*>/);
  ui.flushTimers();
  assert.equal(JSON.parse(ui.storage.get('dc04uAdvancedEqDraftV1')).measurement, 'alternate');
  assert.deepEqual(ui.requests, []);
});

test('a user-imported original curve persists its points and is restored on reload without reverting to METEOR', () => {
  const ui = editor();
  const frequencies = [20, 40, 80, 160, 320, 640, 1000, 2000, 10000, 20000];
  ui.importText(frequencies.map((frequency, index) => `${frequency},${3 - index / 2}`).join('\n'));
  assert.equal(ui.node('#io-dialog').open, false);
  ui.flushTimers();
  const persisted = JSON.parse(ui.storage.get('dc04uAdvancedEqDraftV1'));
  assert.match(persisted.measurement, /^local-/);
  assert.equal(persisted.originalCurve.id, persisted.measurement);
  assert.equal(persisted.originalCurve.points.length, 10);
  const reloaded = editor(ui.storage);
  assert.equal(reloaded.node('#measurement').value, persisted.measurement);
  assert.deepEqual(JSON.parse(JSON.stringify(reloaded.curves.find(item => item.id === persisted.measurement).points)), persisted.originalCurve.points);
  reloaded.node('#mode-fr').onclick(); reloaded.flushGraph();
  assert.doesNotMatch(reloaded.node('#graph').innerHTML, /NaN|Infinity/);
  assert.deepEqual(ui.requests, []);
  assert.deepEqual(reloaded.requests, []);
});

test('changing the draft while review is in flight invalidates the resulting confirmation', async () => {
  const ui = editor();
  const pending = ui.node('#review').onclick({ isTrusted: true });
  ui.node('#reset').onclick();
  ui.respond('stage', { stageId: 'stage-1' });
  await Promise.resolve(); await Promise.resolve();
  ui.respond('review', { reviewToken: 'review-1', digest: 'digest', profile: profile() });
  await Promise.resolve(); await Promise.resolve();
  ui.respond('cancel', { cancelled: true });
  await pending;
  assert.equal(ui.node('#review-dialog').open, false);
  assert.match(ui.node('#notice').textContent, /变化/);
  assert.deepEqual(ui.requests.map(request => request.action), ['stage', 'review', 'cancel']);
});

test('blank and partial negatives stay visible without silently committing zero', () => {
  const ui=editor();ui.importText(JSON.stringify(profile()));
  const input=ui.focus('#band-0-gain');
  for(const value of ['', '-', '-.']) {
    ui.input(input,value);
    assert.equal(input.value,value);assert.equal(input.getAttribute('aria-invalid'),'true');
    ui.flushTimers();
    assert.equal(JSON.parse(ui.storage.get('dc04uAdvancedEqDraftV1')).draft.bands[0].gain,-5.5);
  }
  ui.key(input,'Escape');assert.equal(input.value,'-5.5');assert.equal(input.getAttribute('aria-invalid'),'false');
  assert.deepEqual(ui.requests,[]);
});

test('typing negative decimals keeps input identity, focus, table and precision intact', () => {
  const ui=editor(),table=ui.node('#bands'),writes=table.htmlWrites,input=ui.focus('#band-0-gain');
  for(const value of ['-','-1','-1.','-1.2','-1.25'])ui.input(input,value);
  assert.equal(ui.node('#band-0-gain'),input);assert.equal(ui.active(),input);assert.equal(table.htmlWrites,writes);
  ui.blur(input);const next=ui.focus('#band-0-q');ui.input(next,'0.707');ui.key(next,'Enter');
  assert.equal(ui.active(),next);assert.equal(next.value,'0.707');
  assert.equal(ui.exportProfile().filterSettings[0].gain,-1.25);assert.deepEqual(ui.requests,[]);
});

test('frequency shorthand and Unicode minus normalize only on confirmation', () => {
  const ui=editor(),frequency=ui.focus('#band-0-frequency');
  ui.input(frequency,'1.5kHz');assert.equal(frequency.value,'1.5kHz');ui.key(frequency,'Enter');
  assert.equal(frequency.value,'1500');
  const gain=ui.focus('#band-0-gain');ui.input(gain,'−1.25 dB');ui.key(gain,'Enter');assert.equal(gain.value,'-1.25');
  assert.equal(ui.exportProfile().filterSettings[0].frequency,1500);
});

test('arrow keys support normal, fast and fine steps with explicit bounds', () => {
  const ui=editor(),input=ui.focus('#band-0-gain');
  ui.key(input,'ArrowUp');assert.equal(input.value,'0.1');
  ui.key(input,'ArrowUp',{shiftKey:true});assert.equal(input.value,'1.1');
  ui.key(input,'ArrowDown',{altKey:true});assert.equal(input.value,'1.09');
  ui.input(input,'12');ui.key(input,'ArrowUp');assert.equal(input.value,'12');
  const q=ui.focus('#band-0-q');ui.input(q,'0.3');ui.key(q,'ArrowDown');assert.equal(q.value,'0.3');
  assert.deepEqual(ui.requests,[]);
});

test('Escape restores the focus-session value and a sequence is one undo step', () => {
  const ui=editor(),input=ui.focus('#band-0-gain');
  ui.input(input,'-1');ui.input(input,'-1.25');ui.key(input,'Escape');assert.equal(input.value,'0');
  assert.equal(ui.node('#undo').disabled,true);
  ui.input(input,'-2');ui.input(input,'-2.25');ui.blur(input);ui.node('#undo').onclick();
  assert.equal(ui.node('#band-0-gain').value,'0');assert.equal(ui.node('#undo').disabled,true);
  ui.node('#redo').onclick();assert.equal(ui.node('#band-0-gain').value,'-2.25');
});

test('invalid field blocks stale-value export, save and hardware review', async () => {
  const ui=editor();ui.node('#io-cancel').onclick();const input=ui.focus('#band-0-q');ui.input(input,'200');ui.blur(input);
  ui.node('#export').onclick();assert.equal(ui.node('#io-dialog').open,false);
  ui.node('#save-local').onclick();assert.equal(ui.storage.has('dc04uAdvancedEqSavedV1'),false);
  await ui.node('#review').onclick({isTrusted:true});assert.deepEqual(ui.requests,[]);
  assert.equal(ui.active(),input);assert.match(ui.node('#band-0-q-error').textContent,/0.3/);
});

test('blank or fractional preamp is not silently reset or rounded', () => {
  const ui=editor();ui.importText(JSON.stringify(profile()));const input=ui.focus('#preamp');
  ui.input(input,'');assert.equal(input.getAttribute('aria-invalid'),'true');
  ui.input(input,'-2.5');assert.match(ui.node('#preamp-error').textContent,/整数/);
  ui.key(input,'Escape');assert.equal(input.value,'-7');assert.equal(ui.exportProfile().totalGain,-7);
});

test('ordinary graph wheel passes through and Alt wheel alone changes Q', () => {
  const ui=editor(),graph=ui.node('#graph');let prevented=0;
  const target={closest:()=>({dataset:{handle:'0'}})};
  const wheel=extra=>{for(const fn of graph.listeners.get('wheel'))fn({target,deltaY:10,preventDefault(){prevented++;},...extra});};
  wheel({});assert.equal(prevented,0);assert.equal(ui.node('#band-0-q').value,'0.707');
  wheel({altKey:true,deltaY:0});assert.equal(prevented,0);
  wheel({altKey:true});assert.equal(prevented,1);assert.equal(ui.node('#band-0-q').value,'0.672');assert.deepEqual(ui.requests,[]);
});

async function choose(ui, role, value) {
  const selector = ui.node('#' + role); selector.value = value;
  await selector.onchange({ target: selector });
}
function destination(ui, value) {
  const selector = ui.node('#library-destination'); selector.value = value;
  selector.onchange({ target: selector });
}
function libraryClick(ui, kind, id) {
  const button = { dataset: { [kind]: id } };
  return ui.node('#curve-list').onclick({ target: { closest: selector => selector === `[data-${kind}]` ? button : null } });
}
function remoteCurve(id, recordId = id, rig = '未标注（请核对原始说明）') {
  return { id, recordId, name: id, kind: 'measurement', rig,
    points: [20, 100, 1000, 10000, 20000].map(frequency => ({ frequency, db: frequency < 1000 ? 4 : 0 })) };
}
function pendingLibrary() {
  const pending = new Map();
  return { pending, loadRecord: id => new Promise((resolve, reject) => pending.set(id, { resolve, reject })) };
}

test('target search and headphone selection update B alone without changing the EQ draft', async () => {
  const ui = editor(), before = ui.exportProfile(), original = ui.node('#measurement').value;
  const search = ui.node('#target-search'); search.value = 'Another headphone'; search.oninput();
  assert.equal(ui.node('#measurement').value, original);
  assert.equal(ui.node('#target').value, 'target');
  assert.match(ui.node('#target').innerHTML, /value="alternate"/);
  await choose(ui, 'target', 'alternate'); ui.flushGraph(); ui.flushTimers();
  assert.equal(ui.node('#measurement').value, original);
  assert.equal(ui.node('#target').value, 'alternate');
  assert.match(ui.node('#target-name').textContent, /Another headphone/);
  assert.deepEqual(ui.exportProfile(), before);
  assert.equal(JSON.parse(ui.storage.get('dc04uAdvancedEqDraftV1')).target, 'alternate');
  const restored = editor(ui.storage);
  assert.equal(restored.node('#target').value, 'alternate');
  assert.equal(restored.node('#measurement').value, original);
  assert.deepEqual(ui.requests, []);
});

test('library destination determines the side independently of the curve kind', async () => {
  const ui = editor(); destination(ui, 'target');
  await libraryClick(ui, 'curve', 'alternate');
  assert.equal(ui.node('#target').value, 'alternate');
  assert.equal(ui.node('#measurement').value, 'measurement');
  destination(ui, 'measurement'); await libraryClick(ui, 'curve', 'target');
  assert.equal(ui.node('#measurement').value, 'target');
  assert.equal(ui.node('#target').value, 'alternate');
  assert.deepEqual(ui.requests, []);
});

test('parallel public downloads retain their captured A/B roles when the library destination changes', async () => {
  const library = pendingLibrary(), ui = editor([], library);
  destination(ui, 'target'); const loadingB = libraryClick(ui, 'record', 'record-b');
  destination(ui, 'measurement'); const loadingA = libraryClick(ui, 'record', 'record-a');
  library.pending.get('record-a').resolve({ curves: [remoteCurve('curve-a')] }); await loadingA;
  library.pending.get('record-b').resolve({ curves: [remoteCurve('curve-b')] }); await loadingB;
  assert.equal(ui.node('#measurement').value, 'curve-a');
  assert.equal(ui.node('#target').value, 'curve-b');
  assert.deepEqual(ui.requests, []);
});

test('a late target download cannot overwrite a more recent target choice', async () => {
  const library = pendingLibrary(), ui = editor([], library);
  const loading = choose(ui, 'target', 'record:old-b');
  await choose(ui, 'target', 'alternate');
  library.pending.get('old-b').resolve({ curves: [remoteCurve('stale-b')] }); await loading;
  assert.equal(ui.node('#measurement').value, 'measurement');
  assert.equal(ui.node('#target').value, 'alternate');
  assert.deepEqual(ui.requests, []);
});

test('failed target downloads restore the previous selection and preserve the original', async () => {
  const library = pendingLibrary(), ui = editor([], library);
  const loading = choose(ui, 'target', 'record:bad-b');
  library.pending.get('bad-b').reject(new Error('offline')); await loading;
  assert.equal(ui.node('#measurement').value, 'measurement');
  assert.equal(ui.node('#target').value, 'target');
  assert.match(ui.node('#notice').textContent, /目标 B读取失败.*保留此前选择/);
});

test('an imported target persists its own full data and restores without replacing the original', () => {
  const ui = editor(); destination(ui, 'target');
  ui.importText([20,40,80,160,320,640,1000,2000,10000,20000].map((f,i) => `${f},${i / 2}`).join('\n'));
  ui.flushTimers();
  const saved = JSON.parse(ui.storage.get('dc04uAdvancedEqDraftV1'));
  assert.equal(saved.measurement, 'measurement');
  assert.match(saved.target, /^local-/);
  assert.equal(saved.targetCurve.points.length, 10);
  const restored = editor(ui.storage);
  assert.equal(restored.node('#target').value, saved.target);
  assert.equal(restored.node('#measurement').value, 'measurement');
  assert.deepEqual(JSON.parse(JSON.stringify(restored.curves.find(c => c.id === saved.target).points)), saved.targetCurve.points);
  assert.deepEqual(restored.requests, []);
});

test('swapping A/B preserves the draft and prevents pending downloads from undoing the swap', async () => {
  const library = pendingLibrary(), ui = editor([], library), before = ui.exportProfile();
  await choose(ui, 'target', 'alternate');
  const loading = choose(ui, 'target', 'record:late');
  ui.node('#swap-curves').onclick();
  library.pending.get('late').resolve({ curves: [remoteCurve('late-result')] }); await loading;
  assert.equal(ui.node('#measurement').value, 'alternate');
  assert.equal(ui.node('#target').value, 'measurement');
  assert.deepEqual(ui.exportProfile(), before);
  assert.deepEqual(ui.requests, []);
});

test('unknown measurement metadata is shown as unknown, and target variants affect B only', async () => {
  const ui = editor([], { loadRecord: async () => ({ curves: [remoteCurve('left', 'pair'), remoteCurve('right', 'pair')] }) });
  await choose(ui, 'target', 'record:pair');
  assert.match(ui.node('#rig-warning').textContent, /测量装置未注明/);
  assert.doesNotMatch(ui.node('#rig-warning').textContent, /标注不同/);
  assert.equal(ui.node('#target-variant').hidden, false);
  const variant = ui.node('#target-variant'); variant.value = 'right'; variant.onchange({ target: variant });
  assert.equal(ui.node('#target').value, 'right');
  assert.equal(ui.node('#measurement').value, 'measurement');
  await choose(ui, 'measurement', 'right');
  assert.match(ui.node('#rig-warning').textContent, /同一条曲线.*完全重合/);
  assert.deepEqual(ui.requests, []);
});
