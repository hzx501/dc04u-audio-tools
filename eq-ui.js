(() => {
  'use strict';
  if (window !== window.top || globalThis.__DC04U_EQ_UI__) return;
  globalThis.__DC04U_EQ_UI__ = true;
  const M = globalThis.DC04UEqMath;
  const LIB = globalThis.DC04UCurveLibrary || { curves: [] };
  const CATALOG = globalThis.DC04UHuiHiFiCatalog || {records:[]};
  const officialIds = new Set((LIB.curves || []).map(c => c.id));
  let libraryMode = 'official', libraryDestination = 'measurement';
  const loadSequence = {measurement:0,target:0};
  if (!M) return;
  const KEY = 'dc04uAdvancedEqDraftV1', SAVES = 'dc04uAdvancedEqSavedV1';
  const types = [['peaking','峰值 PK'],['lowshelf','低架 LS'],['highshelf','高架 HS'],['lowpass','低通 LP'],['highpass','高通 HP'],['bandpass','带通 BP'],['allpass','全通 AP']];
  const centers = [31,63,125,250,500,1000,2000,4000,8000,16000];
  const neutral = () => ({ name:'我的 DC04U 调音', preamp:0, bands:centers.map(f => ({frequency:f,gain:0,q:0.707,type:'peaking',enabled:true})) });
  let draft = neutral(), selected = 4, measurement = '', target = '', compare = false, sampleRate = 48000;
  let host, root, entry, page, opened = false, review = null, pending = new Map(), seq = 0, history = [], future = [], dragging = false;
  let revision = 0, committing = false;
  let autosaveTimer, graphFrame, saved = [], deviceStatus = null;
  const curves = LIB.curves || [];
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const byId = id => curves.find(c => c.id === id);
  const points = c => c?.points || [];
  const isTarget = c => c.kind === 'target';
  const copy = x => JSON.parse(JSON.stringify(x));
  const $ = s => root.querySelector(s);
  const $$ = s => [...root.querySelectorAll(s)];
  function libraryStats() {
    const bundled=curves.filter(c=>officialIds.has(c.id)),records=CATALOG.records||[];
    return {bundled:bundled.length,synthetic:bundled.filter(c=>c.synthetic===true).length,
      measurements:bundled.filter(c=>!isTarget(c)).length,targets:bundled.filter(isTarget).length,
      records:records.length,earbuds:records.filter(c=>c.category==='EARBUDS').length,
      sources:records.filter(c=>c.category==='SOUND_SOURCE').length,
      groups:records.reduce((sum,c)=>sum+(Array.isArray(c.groups)?c.groups.length:Number(c.groupCount)||0),0)};
  }
  function localLibraryLabel() {const stats=libraryStats();return stats.synthetic===stats.bundled&&stats.bundled?'数学示例 · '+stats.bundled+' 条（非实测）':'本地曲线 · '+stats.bundled+' 条';}
  function curveKindLabel(curve) {return curve.synthetic===true?(isTarget(curve)?'模拟目标 · 非听音标准':'模拟响应 · 非实测'):(isTarget(curve)?'目标曲线':'耳机实测');}
  function sourceSummary() {
    const stats=libraryStats();
    const local=stats.synthetic===stats.bundled&&stats.bundled?`本发布版内置 ${stats.bundled} 条纯数学模拟曲线（${stats.measurements} 条响应、${stats.targets} 条参考），不代表任何真实耳机或听音标准。`:`本地库 ${stats.bundled} 条曲线（${stats.measurements} 条响应、${stats.targets} 条目标）；其中 ${stats.synthetic} 条是非实测模拟数据。`;
    return local+(stats.records?`已配置公开目录 ${stats.records} 条记录、${stats.groups} 个测量组，选中后按需读取，不附登录信息。`:'未附带第三方测量或目录；可导入自己有权使用的数据。');
  }
  try {
    const d = JSON.parse(localStorage.getItem(KEY));
    if (d?.draft) {
      draft = validateDraft(d.draft); measurement = d.measurement || ''; target = d.target || '';
      compare = d.compare === true; libraryDestination = d.libraryDestination === 'target' ? 'target' : 'measurement';
      for (const [id,stored] of [[measurement,d.originalCurve],[target,d.targetCurve]]) {
        if (stored?.id === id && !byId(id)) {
          try { const restored=copy(stored);restored.points=M.canonicalCurve(restored.points);M.normalizeCurve(restored.points,1000);curves.push(restored); } catch {}
        }
      }
    }
    saved = JSON.parse(localStorage.getItem(SAVES)) || [];
    if (!Array.isArray(saved)) saved = [];
  } catch { draft = neutral(); }
  if (measurement && !byId(measurement)) measurement = '';
  if (target && !byId(target)) target = '';
  measurement ||= curves.find(c => /METEOR/i.test(c.name) && /4195/.test(c.name))?.id || curves.find(c => !isTarget(c))?.id || '';
  target ||= curves.find(c => isTarget(c) && /VDSF/.test(c.name) && /4195/.test(c.name))?.id || curves.find(isTarget)?.id || '';
  function persist() {
    clearTimeout(autosaveTimer); autosaveTimer = setTimeout(() => {
      try { localStorage.setItem(KEY, JSON.stringify({draft,measurement,target,compare,libraryDestination,originalCurve:officialIds.has(measurement)?null:byId(measurement),targetCurve:officialIds.has(target)?null:byId(target)})); $('#draft-state').textContent = '草稿已保存在本机'; }
      catch { $('#draft-state').textContent = '本机保存失败，请导出备份'; }
    }, 250);
  }
  function remember() { history.push(copy(draft)); if (history.length > 50) history.shift(); future = []; }
  function changed() { revision++; review = null; persist(); updateSummary(); requestGraph(); }
  function notice(text, bad = false) { $('#notice').textContent = text; $('#notice').classList.toggle('error', bad); }
  function request(action, payload = {}, timeout = 12000) {
    return new Promise((resolve,reject) => {
      const id = `eq-${Date.now()}-${++seq}`;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error('未收到设备适配器响应。请重新加载扩展和 DC04U 网页。')); }, timeout);
      pending.set(id, {resolve,reject,timer});
      window.postMessage({type:'DC04U_EQ_REQUEST_V1',id,action,payload}, '*');
    });
  }
  window.addEventListener('message', e => {
    if (e.source !== window || e.data?.type !== 'DC04U_EQ_RESPONSE_V1') return;
    const p = pending.get(e.data.id); if (!p) return;
    clearTimeout(p.timer); pending.delete(e.data.id);
    e.data.ok ? p.resolve(e.data.result) : p.reject(new Error(e.data.error?.message || e.data.error || '设备操作失败'));
  });
  const numericSpecs = {
    frequency:{min:20,max:20000,step:1,unit:'Hz',label:'频率',frequency:true},
    gain:{min:-24,max:12,step:.1,unit:'dB',label:'增益'},
    q:{min:.3,max:20,step:.01,unit:'Q',label:'Q'},
    preamp:{min:-24,max:12,step:1,unit:'dB',label:'前级增益',integer:true},
    fitMin:{min:20,max:20000,step:1,unit:'Hz',label:'最低频率',frequency:true},
    fitMax:{min:20,max:20000,step:1,unit:'Hz',label:'最高频率',frequency:true},
  };
  const numericSessions = new WeakMap(), fitRange = {fitMin:20,fitMax:10000};
  function numericField(id,field,value,label,index) {
    const spec=numericSpecs[field];
    return `<div class="number-field"><div class="number-box"><input id="${id}" type="text" inputmode="decimal" autocomplete="off" spellcheck="false" data-numeric="${field}" ${index===undefined?'':`data-index="${index}" data-field="${field}"`} value="${value}" aria-label="${esc(label)}" aria-describedby="${id}-error input-help" title="${spec.min} 至 ${spec.max} ${spec.unit}${spec.frequency?'；支持 1.5kHz':''}"><span class="unit" aria-hidden="true">${spec.unit}</span><span class="steppers"><button type="button" tabindex="-1" data-step="1" data-for="${id}" aria-label="增加${esc(label)}" title="增加${esc(label)}">+</button><button type="button" tabindex="-1" data-step="-1" data-for="${id}" aria-label="减少${esc(label)}" title="减少${esc(label)}">−</button></span></div><div class="number-error" id="${id}-error" aria-live="polite" hidden></div></div>`;
  }
  function parseNumeric(input) {
    const spec=numericSpecs[input.dataset.numeric];
    const text=String(input.value).normalize('NFKC').trim().replace(/−/g,'-').replace(/\s+/g,'');
    if(!text)return {error:'请填写数值；Esc 可恢复上一值'};
    const match=text.match(/^([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)(k(?:hz)?|hz|db)?$/i);
    if(!match)return {error:'请输入完整数值'+(spec.frequency?'，例如 1500 或 1.5k':'，例如 −1.25')};
    const suffix=(match[2]||'').toLowerCase();
    if(suffix && !(spec.frequency?['hz','k','khz'].includes(suffix):spec.unit==='dB'&&suffix==='db'))return {error:`此项单位为 ${spec.unit}`};
    const value=Number(match[1])*(suffix.startsWith('k')?1000:1);
    if(!Number.isFinite(value)||value<spec.min||value>spec.max)return {error:`请输入 ${spec.min} 至 ${spec.max} ${spec.unit}`};
    if(spec.integer&&!Number.isInteger(value))return {error:'前级按 1 dB 调节，请输入整数'};
    return {value};
  }
  function readNumeric(input){return parseNumeric(input).value;}
  function numericValue(input) {
    const field=input.dataset.numeric;
    return input.dataset.index!==undefined?draft.bands[Number(input.dataset.index)][field]:field==='preamp'?draft.preamp:fitRange[field];
  }
  function numericError(input,message='') {
    input.setAttribute('aria-invalid',String(!!message));
    const hint=$(`#${input.id}-error`);if(hint){hint.hidden=!message;hint.textContent=message;}
  }
  function beginNumeric(input) {
    let session=numericSessions.get(input);
    if(!session){session={before:copy(draft),original:numericValue(input),remembered:false};numericSessions.set(input,session);}
    return session;
  }
  function setNumeric(input,value) {
    const field=input.dataset.numeric,session=beginNumeric(input);
    if(value===numericValue(input))return;
    if(field==='fitMin'||field==='fitMax'){fitRange[field]=value;return;}
    if(!session.remembered){history.push(session.before);if(history.length>50)history.shift();future=[];session.remembered=true;}
    if(input.dataset.index!==undefined)draft.bands[Number(input.dataset.index)][field]=value;
    else draft.preamp=value;
    changed();
  }
  function updateNumeric(input,finish=false) {
    if(!numericSpecs[input.dataset.numeric])return true;
    const parsed=parseNumeric(input);
    numericError(input,parsed.error);
    if(parsed.error)return false;
    setNumeric(input,parsed.value);
    if(finish){input.value=String(parsed.value);numericSessions.delete(input);}
    return true;
  }
  function validateInputs() {
    let invalid;
    for(const input of $$('[data-numeric]'))if(!updateNumeric(input,true)&&!invalid)invalid=input;
    if(invalid){notice('请先完成标红的输入；图表保留最后一个有效值。',true);invalid.focus();return false;}
    return true;
  }
  function nudgeNumeric(input,direction,event={}) {
    const spec=numericSpecs[input.dataset.numeric],value=readNumeric(input)??numericValue(input);
    const step=spec.step*(event.shiftKey?10:event.altKey&&!spec.integer?.1:1);
    input.value=String(Math.round(Math.max(spec.min,Math.min(spec.max,value+direction*step))*1e6)/1e6);
    updateNumeric(input);
  }
  function bindNumericInputs() {
    root.addEventListener('focusin',e=>{if(e.target.dataset?.numeric)beginNumeric(e.target);});
    root.addEventListener('input',e=>{
      if(!e.target.dataset?.numeric||e.isComposing)return;
      // Invalid intermediate text must also invalidate an in-flight review.
      revision++;review=null;updateNumeric(e.target);
    });
    root.addEventListener('compositionend',e=>{if(e.target.dataset?.numeric){revision++;review=null;updateNumeric(e.target);}});
    root.addEventListener('focusout',e=>{if(e.target.dataset?.numeric){updateNumeric(e.target,true);numericSessions.delete(e.target);}});
    root.addEventListener('change',e=>{if(e.target.dataset?.numeric)updateNumeric(e.target,true);});
    root.addEventListener('keydown',e=>{
      const input=e.target;if(!input.dataset?.numeric||e.isComposing)return;
      if(e.key==='Enter'){e.preventDefault();if(updateNumeric(input,true))input.select();}
      else if(e.key==='Escape'){
        e.preventDefault();const session=numericSessions.get(input),value=session?.original??numericValue(input),field=input.dataset.numeric;
        if(session?.remembered && history.at(-1)===session.before)history.pop();
        if(field==='fitMin'||field==='fitMax')fitRange[field]=value;
        else{if(input.dataset.index!==undefined)draft.bands[Number(input.dataset.index)][field]=value;else draft.preamp=value;changed();}
        input.value=String(value);numericError(input);numericSessions.delete(input);input.select();
      }else if(e.key==='ArrowUp'||e.key==='ArrowDown'){e.preventDefault();nudgeNumeric(input,e.key==='ArrowUp'?1:-1,e);}
    });
    root.addEventListener('pointerdown',e=>{if(e.target.closest('[data-step]'))e.preventDefault();});
    root.addEventListener('click',e=>{
      const button=e.target.closest('[data-step]');if(!button)return;
      const input=$(`#${button.dataset.for}`);input.focus();nudgeNumeric(input,Number(button.dataset.step),e);
    });
  }
  const css = `
    :host{display:block;color:#e9edf5;background:#10141c;font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;border-top:1px solid #303746;min-height:0;min-width:0;color-scheme:dark}*{box-sizing:border-box}[hidden]{display:none!important}button,input,select,textarea{font:inherit}button{cursor:pointer}button:disabled{opacity:.4;cursor:wait}button,input,select,textarea{color:inherit;background:#1b2230;border:1px solid #354055;border-radius:7px}button{padding:7px 12px}button:hover{background:#29354a;border-color:#8298b8}button.primary{background:#d6e5ac;color:#192415;border-color:#d6e5ac;font-weight:650}button.primary:hover{background:#e5f4bb}button.subtle{background:transparent}.wrap{max-width:1540px;margin:auto;padding:24px 28px 36px}.top{display:flex;gap:18px;justify-content:space-between;align-items:center;margin-bottom:22px}.eyebrow{font-size:11px;letter-spacing:2px;color:#a5b583;font-weight:650}h1{font-size:25px;letter-spacing:-.5px;margin:4px 0}h2{font-size:15px;margin:0 0 13px}p{margin:5px 0}.muted{color:#a2aec2;font-size:12px}.toolbar{display:flex;align-items:center;gap:7px;flex-wrap:wrap}.badge{font-size:11px;border:1px solid #45533e;border-radius:20px;color:#c8dda6;padding:4px 10px;white-space:nowrap}.layout{display:grid;grid-template-columns:245px minmax(450px,1fr);gap:18px}.card{background:#171d28;border:1px solid #2b3444;border-radius:12px;padding:18px}.library{grid-row:span 2}.label{font-size:11px;letter-spacing:1px;color:#a7b1c3;margin-bottom:7px;text-transform:uppercase}input,select{min-height:34px;padding:6px 9px;max-width:100%}input[type=number]{font-variant-numeric:tabular-nums}input[type=checkbox]{min-height:0;accent-color:#c5dc9d;width:16px;height:16px}.full{width:100%}.curve-list{display:flex;flex-direction:column;gap:5px;max-height:247px;overflow-y:auto;margin:8px -5px 14px;padding:0 5px}.curve{width:100%;text-align:left;font-size:12px;padding:8px 9px;background:#141b26;border-color:#293344}.curve strong{display:block;font-weight:500}.curve small{color:#8fa0b9;font-size:10px}.curve.chosen{border-color:#a5bd7f;background:#293225}.rule{height:1px;background:#2c3544;margin:17px 0}.field{display:flex;flex-direction:column;gap:5px;margin-bottom:11px}.field>span{font-size:12px;color:#bac4d6}.selection{font-size:12px;color:#dce3ef;overflow-wrap:anywhere}.origin{font-size:11px;color:#8294b1}.origin a{color:#b1c6ec}a{color:#c4d4ee}.plot-head{display:flex;align-items:center;justify-content:space-between;gap:12px}.seg{display:flex;background:#0f1520;border-radius:8px;padding:3px;gap:3px}.seg button{border:0;padding:5px 11px;font-size:12px;background:transparent;color:#a4b0c4}.seg button.active{color:#e3edce;background:#303b2b}.legend{display:flex;gap:15px;font-size:11px;color:#b5c0d2;margin:8px 0;flex-wrap:wrap}.legend i{display:inline-block;width:13px;height:3px;vertical-align:middle;margin-right:5px}.graph{display:block;width:100%;height:auto;aspect-ratio:940/305;touch-action:pan-y pinch-zoom;user-select:none}.graph text{fill:#8897b0;font-size:11px}.graph .handle{cursor:grab;touch-action:none}.graph .handle:focus{outline:none;stroke:#fff;stroke-width:3}.plot-note{display:flex;justify-content:space-between;gap:10px;font-size:11px;color:#8e9db3}.metrics{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-top:15px}.metric{padding:10px 12px;background:#111824;border-radius:7px}.metric span{display:block;font-size:10px;color:#9dacc1}.metric b{font-size:17px;font-weight:500;font-variant-numeric:tabular-nums}.table-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:13px;gap:12px}.table-head input{width:min(260px,100%);font-weight:550}.table-scroll{overflow-x:auto}table{width:100%;border-collapse:collapse;white-space:nowrap}th{text-align:left;color:#8fa1bb;font-size:11px;font-weight:400;padding:7px 8px}td{padding:5px 8px;border-top:1px solid #2b3443;font-variant-numeric:tabular-nums}td input[type=number]{width:100px}td select{width:126px}tr.selected{background:#222e40}td:first-child{width:34px;color:#9eb1ce;font-size:12px}td:last-child{color:#8fa1b7;font-size:11px}.bottom{display:flex;gap:14px;justify-content:space-between;align-items:flex-start;margin-top:16px}.preamp{display:flex;gap:8px;align-items:center}.preamp input{width:75px}.notice{margin-top:14px;background:#192435;color:#bdd4f1;border-left:3px solid #7fa3cf;padding:10px 13px;min-height:41px;font-size:12px}.notice.error{border-color:#edac90;color:#ffceb5}.footer{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-top:20px}.write{border:1px solid #59664a;background:#20291d;display:flex;align-items:center;gap:13px;padding:12px 15px;border-radius:9px}.write .muted{max-width:370px}.shortcut{font-size:11px;color:#8392ac}.dialog{color:#edf2fa;background:#171f2c;border:1px solid #5a6981;border-radius:12px;width:min(700px,94vw);max-height:88vh;padding:24px;box-shadow:0 20px 100px #0009}.dialog::backdrop{background:#050a13b8}.dialog h2{font-size:20px}.dialog textarea{width:100%;height:220px;padding:12px;font:12px/1.6 ui-monospace,monospace;resize:vertical}.dialog pre{max-height:250px;overflow:auto;background:#0f1622;padding:12px;white-space:pre-wrap;font:11px/1.5 ui-monospace,monospace}.dialog .actions{display:flex;justify-content:flex-end;gap:8px;margin-top:18px}.warning{color:#e8c59e;font-size:12px;margin:12px 0}.filters{display:flex;gap:6px;margin:9px 0}.filters button{font-size:11px;padding:3px 8px}.small{font-size:11px}.file{display:none}.empty{padding:14px 2px;color:#8fa0ba;font-size:12px}.source-note{font-size:11px;color:#8c9bb3;margin-top:11px}.source-note summary{cursor:pointer}.source-note p{margin:8px 0}.fit-row{display:flex;gap:8px}.fit-row>*{flex:1}.status-dot{color:#b9ce94}.tick-label{cursor:pointer;display:flex;align-items:center;gap:8px;font-size:12px}.review-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:14px}.review-grid div{background:#101825;border-radius:8px;padding:10px}.review-grid small{color:#98a9c1;display:block}.review-grid strong{font-size:14px;font-weight:500}.comparison-warn{font-size:11px;color:#dfc28d;margin-top:8px}.sample{width:108px;font-size:11px;min-height:28px;padding:3px 6px}@media(max-width:1000px){.wrap{padding:18px}.layout{grid-template-columns:210px minmax(0,1fr)}.metrics{grid-template-columns:repeat(2,1fr)}.bottom,.footer{flex-wrap:wrap}.plot-head{align-items:flex-start;flex-direction:column}}@media(max-width:740px){.layout{display:flex;flex-direction:column}.library .curve-list{max-height:140px}.top{align-items:flex-start;flex-direction:column}.library{order:2}.table-card{order:1}.graph-card{order:0}.write{flex-wrap:wrap;width:100%}.metrics{grid-template-columns:repeat(2,1fr)}.toolbar{gap:5px}.wrap{padding:14px}.graph{min-height:220px}.review-grid{grid-template-columns:1fr}}

    :host{scrollbar-gutter:stable;scrollbar-color:#64758e #111824;scrollbar-width:auto;scroll-padding:24px}
    :focus-visible{outline:2px solid #c5dc9d;outline-offset:3px}input:focus,select:focus,textarea:focus{border-color:#b3ca91;outline:none;box-shadow:0 0 0 3px #a5c37c20}
    input::placeholder{color:#8090a9}.layout{grid-template-columns:280px minmax(0,1fr);align-items:start}.card{min-width:0}.graph{max-height:340px}.library{align-self:stretch}.table-head{flex-wrap:wrap}.table-head label{display:flex;align-items:center;gap:10px;color:#a7b6ca;font-size:12px;white-space:nowrap;flex:1 1 300px;max-width:450px}.table-head label input{min-width:120px;flex:1}.table-head input{font-size:14px}.table-scroll{padding-bottom:5px;scrollbar-color:#64758e #111824}table{table-layout:auto}td{vertical-align:top;padding:7px 6px}th{padding:7px 6px}td select{min-height:40px;width:116px}td input[type=checkbox]{margin-top:12px}td:first-child{padding-top:18px}.quantized{padding-top:18px;white-space:normal;min-width:75px}
    .number-field{min-width:0}.number-box{display:flex;align-items:center;position:relative;background:#111925;border:1px solid #40506a;border-radius:8px;min-height:40px;overflow:hidden}.number-box:focus-within{border-color:#c5dc9d;box-shadow:0 0 0 3px #a5c37c20}.number-box input{background:transparent;border:0;outline:none;box-shadow:none!important;min-width:0;width:100%;height:40px;padding:8px 7px 8px 10px;text-align:right;font-variant-numeric:tabular-nums}.number-box .unit{color:#8da0bd;font-size:10px;padding-right:7px;pointer-events:none}.steppers{display:flex;flex-direction:column;flex:0 0 22px;border-left:1px solid #354055;align-self:stretch}.steppers button{border:0;border-radius:0;background:#1b2637;padding:0;min-height:19px;font-size:12px;line-height:19px;color:#c3d2e9}.steppers button:hover{background:#35465e}.steppers button+button{border-top:1px solid #354055}.number-error{font-size:11px;color:#ffbea1;white-space:normal;line-height:1.4;margin-top:4px;max-width:155px}.number-field:has([aria-invalid="true"]) .number-box{border-color:#e6a186}.number-field:has([aria-invalid="true"]) .number-box:focus-within{box-shadow:0 0 0 3px #e6a18620}td .number-field{width:154px}td[data-column="frequency"] .number-field{width:148px}.number-box input{font-size:13px}.editing-help{font-size:11px;color:#a1b1c8;line-height:1.7;margin:0 0 10px}.editing-help kbd{font:inherit;background:#263144;border:1px solid #3d4e68;border-radius:4px;padding:1px 4px}.preamp{flex-wrap:wrap}.preamp .number-field{width:140px}.fit-row{align-items:flex-start}.fit-row label{min-width:0;font-size:11px;color:#9fafc4}.fit-row .number-field{margin-top:4px}.fit-row .number-box input{padding-left:6px}.footer{padding-bottom:12px}.write{flex-wrap:wrap}.dialog{overflow-y:auto;overscroll-behavior:contain}.dialog .actions{flex-wrap:wrap}.number-field input[aria-invalid="true"]{color:#ffceb5}
    @media(max-width:1150px){.layout{grid-template-columns:240px minmax(0,1fr)}.wrap{padding:20px}.quantized,th:last-child{display:none}.footer{flex-wrap:wrap}}@media(max-width:900px){.layout{display:flex;flex-direction:column}.layout>.card{width:100%}.graph-card{order:0}.table-card{order:1}.library{order:2}.library .curve-list{max-height:180px}.top{align-items:flex-start;flex-direction:column}.plot-head{flex-direction:row;flex-wrap:wrap}.graph{min-height:200px}.table-head label{flex-wrap:wrap}.plot-note{flex-wrap:wrap}.wrap{padding:16px}.top h1{font-size:22px}.write{width:100%}.write .muted{max-width:none}}@media(max-width:460px){.card{padding:12px}.toolbar{gap:6px}.metrics{gap:6px}.metric{padding:8px}.graph{min-height:180px}.review-grid{grid-template-columns:1fr}}
  `;
  function mount() {
    if (!location.hash.includes('/device/DC04U')) { close(); return; }
    const nav = document.querySelector('.dc04u-nav .nav-tabs[role=tablist]');
    const foundPage = document.querySelector('.dc04u-page');
    if (!nav || !foundPage) return;
    page = foundPage;
    if (!entry?.isConnected) {
      entry = document.createElement('button'); entry.type='button'; entry.className='nav-tab'; entry.id='dc04u-advanced-eq-tab'; entry.role='tab';
      entry.textContent='高级 EQ'; entry.style.cssText='padding:9px 17px;color:#b8ce94;border:1px solid #62734e;border-radius:7px;background:transparent;cursor:pointer;font:inherit;white-space:nowrap';
      entry.setAttribute('aria-selected',String(opened)); entry.addEventListener('click',open);
      nav.appendChild(entry);
      nav.addEventListener('click', e => { if (e.target.closest('button') !== entry) close(); });
    }
    if (!host) {
      host=document.createElement('section'); host.id='dc04u-advanced-eq'; host.hidden=true; host.tabIndex=0;host.setAttribute('role','region');host.setAttribute('aria-label','高级 EQ 编辑器，可上下滚动');root=host.attachShadow({mode:'open'});
      root.innerHTML=`<style>${css}</style><div class="wrap">
        <header class="top"><div><div class="eyebrow">DC04U / ADVANCED STUDIO</div><h1>高级参数均衡器</h1><p class="muted">10 段参数均衡器 · 公开频响库 · 目标曲线拟合</p></div><div class="toolbar"><span class="badge">草稿模式 · 编辑不写入</span><button id="undo" title="撤销">↶</button><button id="redo" title="重做">↷</button><button id="import">导入</button><button id="export">导出</button><button id="close" class="subtle">返回官网</button></div></header>
        <div class="layout"><aside class="card library"><h2>频响资料库 <small class="muted" id="library-count"></small></h2><label class="field"><span>资料库选中后用于</span><select id="library-destination" aria-label="资料库选择用途"><option value="measurement">原始曲线 A</option><option value="target">目标 / 参考曲线 B</option></select></label><select id="library-mode" class="full" aria-label="选择资料库" style="margin-bottom:8px"><option value="official">${esc(localLibraryLabel())}</option><option value="hui-earbuds">公开耳机目录 · ${libraryStats().earbuds} 条${libraryStats().earbuds ? "" : "（未附带）"}</option><option value="hui-source">公开音源目录 · ${libraryStats().sources} 条${libraryStats().sources ? "" : "（未附带）"}</option></select><input class="full" id="search" type="search" placeholder="搜索耳机、目标、测量台…" aria-label="搜索频响库"><div class="filters"><button data-kind="all">全部</button><button data-kind="measurement">耳机</button><button data-kind="target">目标</button></div><div id="curve-list" class="curve-list"></div><div class="label">原始曲线 A · 自由选择</div><input id="source-search" class="full" type="search" aria-label="搜索原始曲线" placeholder="搜索全部型号 / 自己导入曲线" style="margin-bottom:7px"><select id="measurement" class="full" aria-label="原始曲线" style="margin-bottom:6px"></select><div id="measurement-name" class="selection"></div><div id="measurement-source" class="origin"></div><select id="measurement-variant" class="full" aria-label="测量组与声道" style="margin-top:8px" hidden></select><div class="rule"></div><div class="label">目标 / 参考曲线 B · 自由选择</div><input id="target-search" class="full" type="search" aria-label="搜索目标曲线" placeholder="搜索目标 / 另一副耳机型号" style="margin-bottom:7px"><select id="target" class="full" aria-label="目标曲线"></select><div id="target-name" class="selection" style="margin-top:6px"></div><div id="target-source" class="origin"></div><select id="target-variant" class="full" aria-label="目标测量组与声道" style="margin-top:8px" hidden></select><p class="muted">目标也可以是另一副耳机的实测曲线。选择 B 不会替换 A。</p><button id="swap-curves" class="full" style="margin-top:8px">交换 A / B</button><p id="rig-warning" class="comparison-warn"></p><div class="field" style="margin-top:14px"><span>自动拟合范围</span><div class="fit-row"><label>最低频率${numericField("fit-min","fitMin",20,"拟合最低频率")}</label><label>最高频率${numericField("fit-max","fitMax",10000,"拟合最高频率")}</label></div></div><button id="fit" class="primary full">一键拟合为 10 段草稿</button><p class="muted" style="margin-top:8px">先选耳机实测，再选目标。曲线在 1 kHz 对齐；拟合默认降低高频窄峰的影响。</p><div class="rule"></div><h2>我的调音</h2><select id="saved" class="full" aria-label="本机调音"></select><div class="toolbar" style="margin-top:8px"><button id="save-local">保存草稿</button><button id="load-local">载入</button></div><details class="source-note"><summary>数据来源与计算说明</summary><p id="source-info"></p><p>${LIB.synthetic===true?"本发布版内置纯数学模拟示例，不代表任何真实耳机或听音标准。":"请以各曲线附带的来源、测量装置与条件为准；不同数据源不保证可直接拟合。"}</p><p>滤波器采用公开 RBJ 双二阶公式；目标差值经平滑后，以受限优化拟合至 DC04U 的 10 段。本工具不是水月雨官方软件，算法结果不承诺与其完全相同。</p><a href="https://hub.moondroplab.tech/" target="_blank" rel="noopener noreferrer">水月雨原平台</a> · <a href="https://www.w3.org/TR/audio-eq-cookbook/" target="_blank" rel="noopener noreferrer">公式来源</a></details></aside>
        <section class="card graph-card"><div class="plot-head"><h2 style="margin:0">响应预览 <span class="muted">/ 仅计算</span></h2><div class="toolbar"><div class="seg"><button id="mode-eq" class="active">均衡器</button><button id="mode-fr">频响对比</button></div><select id="sample-rate" class="sample" aria-label="模拟采样率"><option value="44100">44.1 kHz</option><option value="48000" selected>48 kHz</option><option value="96000">96 kHz</option><option value="192000">192 kHz</option></select></div></div><div class="legend" id="legend"></div><svg id="graph" class="graph" viewBox="0 0 940 305" role="img" aria-label="EQ 频率响应，可拖动控制点编辑草稿"></svg><div class="plot-note"><span id="plot-caption">拖动圆点调频率 / 增益 · Alt + 滚轮调 Q · 双击复位该段</span><span>20 Hz — 20 kHz</span></div><div class="metrics"><div class="metric"><span>滤波峰值（不含前级）</span><b id="peak">0.00 dB</b></div><div class="metric"><span>建议前级（留 1 dB 余量）</span><b id="headroom">−1 dB</b></div><div class="metric"><span>选中频段 / Q</span><b id="band-summary">500 Hz / 0.707</b></div><div class="metric"><span>设备状态</span><b id="device-state" style="font-size:13px">编辑未连接设备</b></div></div></section>
        <section class="card table-card"><div class="table-head"><label>调音名称 <input id="name" aria-label="调音名称" maxlength="80" placeholder="给这份调音起个名字"></label><div class="toolbar"><button id="read">读取当前 EQ</button><button id="reset">全部归零</button></div></div><p class="editing-help" id="input-help">直接输入负数或小数，频率支持 <kbd>1.5k</kbd>。<kbd>Tab</kbd> 下一格 · <kbd>Enter</kbd> 确认 · <kbd>Esc</kbd> 撤回本格 · <kbd>↑ ↓</kbd> 微调（Shift ×10 / Alt ÷10）。</p><div class="table-scroll"><table><thead><tr><th>段</th><th>启用</th><th>类型</th><th>频率 Hz</th><th>增益 dB</th><th>Q</th><th>设备精度</th></tr></thead><tbody id="bands"></tbody></table></div><div class="bottom"><div><div class="preamp"><span>前级增益</span> ${numericField("preamp","preamp",draft.preamp,"前级增益")} <button id="auto-preamp">自动余量</button></div><p class="muted">草稿双精度计算；写入：频率 1 Hz，Q / 增益 1/256，前级 1 dB。</p></div><div class="muted" id="draft-state">本机草稿 · 不会自动改变声音</div></div><div id="notice" class="notice" role="status" aria-live="polite">选择公开频响，或直接编辑 10 段参数。所有改动都先留在草稿里。</div></section></div>
        <footer class="footer"><p class="shortcut">版本 1.1.3 · 音量向上跳变 &gt;30 档保护继续工作<br>响应图为数学模拟；未实测 DC04U 的 DSP 采样率及固件滤波实现。</p><div class="write"><div><strong>准备好再写入</strong><p class="muted">先读取目标槽与备份，再核对参数。确认写入会改变当前声音。</p></div><select id="slot" aria-label="写入自定义槽"><option value="0">自定义 1</option><option value="1">自定义 2</option><option value="2">自定义 3</option></select><button id="review" class="primary">检查并确认…</button></div></footer>
      </div><dialog id="io-dialog" class="dialog"><h2 id="io-title">导入调音或曲线</h2><p class="muted" id="io-hint">支持本工具 / iBasso JSON、AutoEq 文本，以及频率 / SPL 两列曲线。</p><select id="io-format" aria-label="导出格式" style="margin:12px 0"><option value="official">iBasso JSON</option><option value="autoeq">AutoEq 文本</option><option value="project">原始精度草稿 JSON</option></select><textarea id="io-text" spellcheck="false" aria-label="导入导出文本"></textarea><input id="file" class="file" type="file" accept=".json,.txt,.csv"><div class="actions"><button id="choose-file">选择文件</button><button id="download">下载文件</button><button id="io-cancel">关闭</button><button id="io-apply" class="primary">导入为草稿</button></div></dialog>
      <dialog id="review-dialog" class="dialog"><h2>确认写入 DC04U</h2><p class="muted">请先暂停播放并摘下耳机，再核对以下内容。编辑器从不自动写入。</p><div class="review-grid"><div><small>写入位置</small><strong id="review-slot"></strong></div><div><small>前级增益 / 参数</small><strong id="review-summary"></strong></div></div><pre id="review-details"></pre><p class="warning">这会替换所选自定义槽，并可能切换为该 EQ。音量跳变保护只限制音量档位；EQ 本身可以改变响度。</p><label class="tick-label"><input id="review-check" type="checkbox">我已暂停播放、摘下耳机，并同意写入这份参数</label><div class="actions"><button id="backup">下载写入前备份</button><button id="review-cancel">取消</button><button id="commit" class="primary" disabled>确认写入设备</button></div></dialog>`;
      const style=document.createElement('style'); style.id='dc04u-advanced-layout'; style.textContent=`
        .dc04u-page[data-advanced-eq-open="true"]{height:100dvh;min-height:0!important;min-width:0!important;overflow:hidden;display:flex;flex-direction:column}
        .dc04u-page[data-advanced-eq-open="true"]>.dc04u-nav{flex:0 0 auto;min-width:0;max-width:100%;overflow-x:auto}
        .dc04u-page[data-advanced-eq-open="true"]>:not(.dc04u-nav):not(#dc04u-advanced-eq){display:none!important}
        .dc04u-page[data-advanced-eq-open="true"]>#dc04u-advanced-eq{flex:1 1 0%;min-height:0!important;min-width:0;width:100%;overflow-y:auto;overflow-x:hidden;overscroll-behavior-y:contain}
        #dc04u-advanced-eq[hidden]{display:none!important}
      `; document.documentElement.append(style);
      bind(); renderAll();
    }
    if (host.parentElement !== page) page.appendChild(host);
    host.hidden=!opened; page.dataset.advancedEqOpen=String(opened);
  }
  function open() { opened=true; mount(); if (host) {host.hidden=false;entry.setAttribute('aria-selected','true');page.dataset.advancedEqOpen='true'; requestGraph(); refreshDevice();} }
  function close() { opened=false;if(host)host.hidden=true;if(page)delete page.dataset.advancedEqOpen;if(entry)entry.setAttribute('aria-selected','false'); }
  function renderAll() { renderBands(); renderLibrary(); renderSaved(); $('#name').value=draft.name || '我的 DC04U 调音'; $('#preamp').value=draft.preamp; const stats=libraryStats();$('#library-count').textContent=`${stats.bundled} 本地 / ${stats.records} 目录`; $('#source-info').textContent=sourceSummary(); updateSummary(); setCompare(compare); }
  function renderBands() {
    $('#bands').innerHTML=draft.bands.map((b,i)=>`<tr data-row="${i}" class="${i===selected?'selected':''}"><td>${String(i+1).padStart(2,'0')}</td><td><input type="checkbox" data-index="${i}" data-field="enabled" ${b.enabled!==false?'checked':''} aria-label="启用第${i+1}段"></td><td><select data-index="${i}" data-field="type" aria-label="第${i+1}段类型">${types.map(([v,n])=>`<option value="${v}" ${b.type===v?'selected':''}>${n}</option>`).join('')}</select></td><td data-column="frequency">${numericField(`band-${i}-frequency`,'frequency',b.frequency,`第${i+1}段频率`,i)}</td><td>${numericField(`band-${i}-gain`,'gain',b.gain,`第${i+1}段增益`,i)}</td><td>${numericField(`band-${i}-q`,'q',b.q,`第${i+1}段Q`,i)}</td><td class="quantized" data-quantized="${i}"></td></tr>`).join('');
    updateSummary();
  }
  let kindFilter='all';
  function renderLibrary() {
    const search=($('#search')?.value || '').toLowerCase().trim();
    if (libraryMode !== 'official') {
      const category = libraryMode === 'hui-source' ? 'SOUND_SOURCE' : 'EARBUDS';
      const matches = CATALOG.records.filter(c => c.category === category && `${c.name} ${c.title} ${c.brand?.name || ''} ${(c.groups || []).join(' ')}`.toLowerCase().includes(search));
      $('#curve-list').innerHTML = matches.slice(0,70).map(c => `<button class="curve" data-record="${esc(c.id)}"><strong>${esc(c.name || c.title)}</strong><small>${esc(c.brand?.name || '')} · ${c.groupCount} 测量组 · 按需读取</small></button>`).join('') + (matches.length > 70 ? `<div class="empty">共 ${matches.length} 条，显示前 70 条。输入型号缩小范围。</div>` : matches.length ? '' : '<div class="empty">未找到条目</div>');
    } else {
    const matches=curves.filter(c=>officialIds.has(c.id)&&(kindFilter==='all'||c.kind===kindFilter)&&`${c.name} ${c.rig||''} ${(c.tags||[]).join(' ')}`.toLowerCase().includes(search));
    $('#curve-list').innerHTML=matches.length?matches.map(c=>`<button class="curve ${[measurement,target].includes(c.id)?'chosen':''}" data-curve="${esc(c.id)}"><strong>${esc(c.name)}</strong><small>${curveKindLabel(c)} · ${esc(c.rig || '以原始名称为准')}</small></button>`).join(''):'<div class="empty">未找到匹配曲线。可以导入自己的频响文件。</div>';
    }
    $('.filters').hidden = libraryMode !== 'official';
    renderSourceSelector();renderCurveSelector('target');
    $('#library-destination').value=libraryDestination;
    for(const role of ['measurement','target']) {
      const curve=byId(role==='target'?target:measurement);
      $(`#${role}-name`).textContent=curve?.name||'尚未选择';
      $(`#${role}-source`).replaceChildren();
      if(curve?.url){const a=document.createElement('a');a.href=curve.url;a.textContent='原始数据 ↗';a.target='_blank';a.rel='noopener noreferrer';$(`#${role}-source`).append(a);}
      const variant=$(`#${role}-variant`),siblings=curve?.recordId?curves.filter(c=>c.recordId===curve.recordId):[];
      variant.hidden=siblings.length<2;variant.innerHTML=siblings.map(c=>`<option value="${esc(c.id)}" ${c.id===curve.id?'selected':''}>${esc(c.name)}</option>`).join('');
      if(curve)variant.value=curve.id;
    }
    const c=byId(measurement),t=byId(target);
    const rigs=curve=>String(curve?.rig||'').match(/5128|4195|4128|45CA|711|60318[-–]4/gi)||[];
    const a=rigs(c),b=rigs(t);
    $('#rig-warning').textContent=c&&t&&c.id===t.id?'A 与 B 为同一条曲线，原始与参考应完全重合。':!a.length||!b.length?'测量装置未注明：可以叠加比较，但尚不能确认两者适合直接拟合。1 kHz 对齐只消除整体电平差。':a.some(x=>b.includes(x))?'测量装置标注有重合；还需核对耳罩、声道和测量条件。曲线均在 1 kHz 对齐。':'测量装置标注不同：可以查看形状，但 1 kHz 对齐不能消除装置差异，不宜直接据此拟合。';
    $('#fit').disabled=!(c&&t);
  }
  function renderSourceSelector(){renderCurveSelector('measurement');}
  function renderCurveSelector(role) {
    const selectedId=role==='target'?target:measurement;
    const normalize=text=>String(text).toLowerCase().replace(/[\s_-]+/g,'');
    const search=normalize($(role==='target'?'#target-search':'#source-search').value||'');
    const matches=curve=>normalize(`${curve.name} ${curve.title||''} ${curve.rig||''} ${curve.brand?.name||''}`).includes(search);
    const local=curves.filter(c=>c.id===selectedId||matches(c)),records=CATALOG.records.filter(matches);
    const option=c=>`<option value="${esc(c.id)}" ${c.id===selectedId?'selected':''}>${esc(c.name)}${c.rig?' · '+esc(c.rig):''}</option>`;
    const group=(name,items)=>items.length?`<optgroup label="${name}">${items.map(option).join('')}</optgroup>`:'';
    $(`#${role}`).innerHTML=group('目标 / 参考曲线',local.filter(isTarget))+group('内置响应（数学示例标为 synthetic）',local.filter(c=>officialIds.has(c.id)&&!isTarget(c)))+group('已加载 / 自己导入的曲线',local.filter(c=>!officialIds.has(c.id)&&!isTarget(c)))+(records.length?`<optgroup label="已配置公开目录 · 选中读取测量组">${records.map(c=>`<option value="record:${esc(c.id)}">${esc(c.name||c.title)} · ${c.groupCount}组${c.category==='SOUND_SOURCE'?' · 音源':''}</option>`).join('')}</optgroup>`:'');
    $(`#${role}`).value=selectedId;
  }
  function setDestination(role) {libraryDestination=role==='target'?'target':'measurement';$('#library-destination').value=libraryDestination;}
  function setCompare(value) {compare=value;$('#mode-eq').classList.toggle('active',!value);$('#mode-fr').classList.toggle('active',value);requestGraph();}
  function sourceChanged(id){curveChanged(id,'measurement');}
  function curveChanged(id,role) {
    if(!byId(id))return;
    loadSequence[role]++;if(role==='target')target=id;else measurement=id;
    renderLibrary();setCompare(true);persist();
  }
  async function loadOriginalRecord(id,role='measurement') {
    const currentLoad=++loadSequence[role],label=role==='target'?'目标 B':'原始 A';notice(`正在读取${label}的公开曲线，只更新比较图。`);
    try {
      const result=await globalThis.DC04UEqLibrary.loadRecord(id);
      if(currentLoad!==loadSequence[role])return;
      if(!result.curves.length)throw new Error('该条目没有可用频响。');
      for(const curve of result.curves)if(!byId(curve.id))curves.push(curve);
      if(role==='target')target=result.curves[0].id;else measurement=result.curves[0].id;
      renderLibrary();setCompare(true);persist();notice(`已更新${label}，读取 ${result.curves.length} 个测量组。另一侧保持不变，EQ 草稿未修改。`);
    }catch(error){if(currentLoad===loadSequence[role]){renderCurveSelector(role);notice(`${label}读取失败：${error.message}。保留此前选择。`,true);}}
  }
  function renderSaved() { $('#saved').innerHTML=saved.length?saved.map((s,i)=>`<option value="${i}">${esc(s.name)}</option>`).join(''):'<option value="">尚无保存的调音</option>'; }
  function updateSummary() {
    if(!root)return;
    try{
      const qp=M.quantizePreset(draft); draft.bands.forEach((b,i)=>{ const el=$(`[data-quantized="${i}"]`); const q=qp.bands[i];if(el)el.textContent=`${q.gain.toFixed(3)} / Q ${q.q.toFixed(3)}`; });
      const f=M.frequencyGrid(768), r=M.response({...draft,preamp:0},f,sampleRate), peak=Math.max(...r);
      $('#peak').textContent=`${peak.toFixed(2)} dB`; $('#headroom').textContent=`${Math.min(0,-Math.ceil(Math.max(0,peak)+1))} dB`;
      const b=draft.bands[selected];$('#band-summary').textContent=`${b.frequency} Hz / ${b.q.toFixed(3)}`;
    }catch(e){notice(e.message,true);}
    $('#undo').disabled=!history.length;$('#redo').disabled=!future.length;
  }
  function requestGraph(){if(!root||graphFrame)return;graphFrame=requestAnimationFrame(()=>{graphFrame=null;try{drawGraph();}catch(error){notice(`曲线无法显示：${error.message}`,true);if(compare){compare=false;drawGraph();}}});}
  const dims={l:48,r:918,t:14,b:268}, minDB=-24,maxDB=18;
  const gx=f=>dims.l+Math.log10(f/20)/3*(dims.r-dims.l);
  const gy=db=>dims.b-(db-minDB)/(maxDB-minDB)*(dims.b-dims.t);
  function path(freqs,db){return freqs.map((f,i)=>`${i?'L':'M'}${gx(f).toFixed(2)},${Math.max(-200,Math.min(500,gy(db[i]))).toFixed(2)}`).join(' ');}
  function drawGraph(){
    const svg=$('#graph'),freqs=M.frequencyGrid(400),focusedHandle=root.activeElement?.dataset?.handle;let content='';
    for(const db of [-24,-18,-12,-6,0,6,12,18]){const y=gy(db);content+=`<line x1="48" y1="${y}" x2="918" y2="${y}" stroke="${db===0?'#56657b':'#2c3545'}"/><text x="37" y="${y+4}" text-anchor="end">${db>0?'+':''}${db}</text>`;}
    for(const f of [20,50,100,200,500,1000,2000,5000,10000,20000]){const x=gx(f);content+=`<line x1="${x}" y1="14" x2="${x}" y2="268" stroke="#283344"/><text x="${x}" y="291" text-anchor="middle">${f>=1000?`${f/1000}k`:f}</text>`;}
    let legend='',response=M.response(draft,freqs,sampleRate);
    if(compare&&byId(measurement)&&byId(target)){
      const raw=M.interpolateCurve(M.normalizeCurve(points(byId(measurement))),freqs).map(p=>p.db),goal=M.interpolateCurve(M.normalizeCurve(points(byId(target))),freqs).map(p=>p.db);
      const at1k=M.response({...draft,preamp:0},[1000],sampleRate)[0];
      const corrected=raw.map((x,i)=>x+response[i]-draft.preamp-at1k);
      for(const [db,color,dash] of [[raw,'#8b9fbc',''],[goal,'#dcb38a','5 4'],[corrected,'#c5df9a','']])content+=`<path clip-path="url(#graph-clip)" d="${path(freqs,db)}" fill="none" stroke="${color}" stroke-width="2" stroke-dasharray="${dash}"/>`;
      legend=`<span><i style="background:#8b9fbc"></i>A 原始：${esc(byId(measurement).name)}</span><span><i style="background:#dcb38a"></i>B 目标 / 参考：${esc(byId(target).name)}</span><span><i style="background:#c5df9a"></i>A + 当前 EQ 草稿（不含前级）</span>`;
      $('#plot-caption').textContent='频响在 1 kHz 对齐；均衡后曲线是数学预测，不是实测';
    }else{
      const single=M.response([draft.bands[selected]],freqs,sampleRate);
      content+=`<path d="${path(freqs,single)}" fill="none" stroke="#809cce" stroke-width="1.5" stroke-dasharray="4 4"/><path d="${path(freqs,response)}" fill="none" stroke="#c5df9a" stroke-width="2.5"/>`;
      draft.bands.forEach((b,i)=>{const active=b.enabled!==false;content+=`<circle class="handle" data-handle="${i}" tabindex="0" role="slider" aria-label="第${i+1}段 ${b.frequency}Hz ${b.gain}dB" aria-valuenow="${b.gain}" cx="${gx(b.frequency)}" cy="${gy(b.gain)}" r="${i===selected?8:6}" fill="${active?(i===selected?'#d6e9b5':'#748a60'):'#39465b'}" stroke="#121a25" stroke-width="2"/><text pointer-events="none" x="${gx(b.frequency)}" y="${gy(b.gain)-13}" text-anchor="middle">${i+1}</text>`;});
      legend='<span><i style="background:#c5df9a"></i>合成 EQ（含前级）</span><span><i style="background:#809cce"></i>选中单段（不含前级）</span>';
      $('#plot-caption').textContent='拖动圆点调频率 / 增益 · Alt + 滚轮调 Q · 双击复位该段';
    }
    svg.innerHTML=`<defs><clipPath id="graph-clip"><rect x="48" y="14" width="870" height="254"/></clipPath></defs><g>${content}</g>`;$('#legend').innerHTML=legend;if(focusedHandle!==undefined)svg.querySelector(`[data-handle="${focusedHandle}"]`)?.focus({preventScroll:true});
  }
  function selectBand(i){selected=i;$$('[data-row]').forEach(e=>e.classList.toggle('selected',Number(e.dataset.row)===i));updateSummary();requestGraph();}
  function getXY(e){const svg=$('#graph');return new DOMPoint(e.clientX,e.clientY).matrixTransform(svg.getScreenCTM().inverse());}
  function setGraphPoint(e){const {x,y}=getXY(e),b=draft.bands[selected];b.frequency=Math.round(Math.max(20,Math.min(20000,20*10**((x-dims.l)/(dims.r-dims.l)*3))));b.gain=Math.round(Math.max(-24,Math.min(12,maxDB-(y-dims.t)/(dims.b-dims.t)*(maxDB-minDB)))*100)/100;changed();}
  function validateDraft(input){const p=M.normalizePreset(input,true);if(p.preamp < -24||p.preamp>12)throw new Error('前级超出 DC04U 范围（−24 至 +12 dB）。');for(const b of p.bands){if(b.frequency<20||b.frequency>20000||b.gain < -24||b.gain>12||b.q<.3||b.q>20)throw new Error('参数超出范围：20–20000 Hz，−24 至 +12 dB，Q 0.3–20。');if(b.enabled&&b.type==='notch')throw new Error('DC04U 不支持 Notch 滤波器，请在源文件中转换或关闭该段。');}for(const b of p.bands)if(!b.enabled&&b.type==='notch'){b.type='peaking';b.gain=0;}p.name=(p.name||'导入的调音').slice(0,80);return p;}
  function replaceDraft(p){p=validateDraft(p);remember();draft=copy(p);if(!draft.name)draft.name='导入的调音';changed();renderAll();}
  function download(name,data,mime='application/json'){const url=URL.createObjectURL(new Blob([data],{type:mime}));const a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
  async function refreshDevice(){try{deviceStatus=await request('status');$('#device-state').textContent=deviceStatus.connected?'DC04U 已连接':'等待 DC04U 连接';}catch{$('#device-state').textContent='适配器未加载';}}
  function bind(){
    $('#close').onclick=close;
    $('#search').oninput=renderLibrary;
    $('#library-destination').onchange=e=>{setDestination(e.target.value);persist();};
    for(const role of ['measurement','target']) {
      const search=$(role==='target'?'#target-search':'#source-search');
      search.onfocus=()=>setDestination(role);
      search.oninput=()=>{setDestination(role);renderCurveSelector(role);};
      $(`#${role}`).onfocus=()=>setDestination(role);
      $(`#${role}`).onchange=async e=>{
        setDestination(role);const id=e.target.value;
        if(id.startsWith('record:')){await loadOriginalRecord(id.slice(7),role);return;}
        curveChanged(id,role);notice(`已更新${role==='target'?'目标 B':'原始 A'}。另一侧保持不变，EQ 草稿未修改。`);
      };
      $(`#${role}-variant`).onchange=e=>{setDestination(role);curveChanged(e.target.value,role);};
    }
    $$('[data-kind]').forEach(b=>b.onclick=()=>{kindFilter=b.dataset.kind;renderLibrary();});
    $('#library-mode').onchange=e=>{libraryMode=e.target.value;renderLibrary();};
    $('#curve-list').onclick=async e=>{
      // Capture the intended side before awaiting a network response.
      const destination=libraryDestination,record=e.target.closest('[data-record]');
      if(record){await loadOriginalRecord(record.dataset.record,destination);return;}
      const b=e.target.closest('[data-curve]');if(!b)return;
      curveChanged(b.dataset.curve,destination);
      notice(`资料库曲线已设为${destination==='target'?'目标 B':'原始 A'}，另一侧保持不变。`);
    };
    $('#swap-curves').onclick=()=>{loadSequence.measurement++;loadSequence.target++;[measurement,target]=[target,measurement];renderLibrary();setCompare(true);persist();notice('已交换 A / B，只改变比较方向，EQ 草稿未修改。');};
    $('#mode-eq').onclick=()=>{setCompare(false);persist();};
    $('#mode-fr').onclick=()=>{setCompare(true);persist();};
    $('#sample-rate').onchange=e=>{sampleRate=Number(e.target.value);changed();};
    bindNumericInputs();
    $('#bands').addEventListener('focusin',e=>{if(e.target.dataset.index!==undefined)selectBand(Number(e.target.dataset.index));});
    $('#bands').addEventListener('change',e=>{
      const t=e.target,i=Number(t.dataset.index),k=t.dataset.field;
      if(k!=='enabled'&&k!=='type')return;
      const v=k==='enabled'?t.checked:t.value;if(draft.bands[i][k]===v)return;
      remember();draft.bands[i][k]=v;changed();
    });
    $('#name').onchange=e=>{const name=e.target.value.trim()||'我的 DC04U 调音';if(name!==draft.name){remember();draft.name=name;changed();}e.target.value=name;};
    $('#auto-preamp').onclick=()=>{if(!validateInputs())return;remember();const peak=Math.max(...M.response({...draft,preamp:0},M.frequencyGrid(1024),sampleRate));draft.preamp=Math.max(-24,Math.min(0,-Math.ceil(Math.max(0,peak)+1)));$('#preamp').value=draft.preamp;changed();notice('已更新草稿前级余量。没有写入设备。');};
    $('#undo').onclick=()=>{if(!history.length)return;future.push(copy(draft));draft=history.pop();changed();renderAll();};
    $('#redo').onclick=()=>{if(!future.length)return;history.push(copy(draft));draft=future.pop();changed();renderAll();};
    $('#reset').onclick=()=>{replaceDraft({...neutral(),name:draft.name});notice('草稿已归零。设备 EQ 保持原状。');};
    $('#save-local').onclick=()=>{if(!validateInputs())return;const i=saved.findIndex(s=>s.name===draft.name);i>=0?saved.splice(i,1,copy(draft)):saved.push(copy(draft));try{localStorage.setItem(SAVES,JSON.stringify(saved));renderSaved();notice('调音已保存在本机。');}catch{notice('本机保存失败，请导出文件。',true);}};
    $('#load-local').onclick=()=>{const s=saved[Number($('#saved').value)];if(s)replaceDraft(s);};
    $('#fit').onclick=async()=>{
      if(!validateInputs())return;const lo=readNumeric($('#fit-min')),hi=readNumeric($('#fit-max'));if(!(lo>=20&&hi<=20000&&lo<hi)){notice('请检查拟合频率范围。',true);return;}
      const b=$('#fit');b.disabled=true;b.textContent='正在计算草稿…';notice('正在拟合目标，未写入设备。');
      await new Promise(resolve=>setTimeout(resolve,30));
      try{const p=M.fit(points(byId(measurement)),points(byId(target)),{minimum:lo,maximum:hi,sampleRate,maxFilters:10,headroomDb:1});p.name=`${byId(measurement).name} → ${byId(target).name}`;replaceDraft(p);$('#mode-fr').click();notice(`拟合完成，已生成 10 段草稿。${p.metrics?.afterRmse!==undefined?`拟合误差 ${Number(p.metrics.afterRmse).toFixed(2)} dB。`:''}请核对曲线与前级后再决定写入。`);}catch(e){notice(e.message,true);}finally{b.disabled=false;b.textContent='一键拟合为 10 段草稿';}
    };
    const svg=$('#graph');
    svg.addEventListener('pointerdown',e=>{const h=e.target.closest('[data-handle]');if(!h||compare)return;remember();selectBand(Number(h.dataset.handle));dragging=true;svg.setPointerCapture(e.pointerId);e.preventDefault();});
    svg.addEventListener('pointermove',e=>{if(dragging)setGraphPoint(e);});
    function finish(e){if(!dragging)return;dragging=false;if(svg.hasPointerCapture(e.pointerId))svg.releasePointerCapture(e.pointerId);renderBands();}
    svg.addEventListener('pointerup',finish);svg.addEventListener('pointercancel',finish);
    svg.addEventListener('dblclick',e=>{const h=e.target.closest('[data-handle]');if(!h)return;remember();const i=Number(h.dataset.handle);draft.bands[i]={frequency:centers[i],gain:0,q:0.707,type:'peaking',enabled:true};changed();renderBands();});
    svg.addEventListener('wheel',e=>{const h=e.target.closest('[data-handle]');if(!h||!e.altKey||!e.deltaY)return;e.preventDefault();remember();const i=Number(h.dataset.handle);draft.bands[i].q=Math.round(Math.max(.3,Math.min(20,draft.bands[i].q*(e.deltaY>0?.95:1.05)))*1000)/1000;selectBand(i);changed();renderBands();},{passive:false});
    svg.addEventListener('keydown',e=>{const h=e.target.closest('[data-handle]');if(!h||!['ArrowUp','ArrowDown','ArrowLeft','ArrowRight'].includes(e.key))return;e.preventDefault();remember();const i=Number(h.dataset.handle),b=draft.bands[i];if(e.key==='ArrowUp'||e.key==='ArrowDown')b.gain=Math.round(Math.max(-24,Math.min(12,b.gain+(e.key==='ArrowUp'?.1:-.1)))*100)/100;else b.frequency=Math.round(Math.max(20,Math.min(20000,b.frequency*(e.key==='ArrowRight'?1.01:.99))));selectBand(i);changed();renderBands();});
    $('#import').onclick=()=>{$('#io-format').hidden=true;$('#io-title').textContent='导入调音或曲线';$('#io-hint').textContent='支持本工具 / iBasso JSON、AutoEq 文本、频率 / SPL 两列曲线。只导入草稿。';$('#io-text').value='';$('#io-apply').hidden=false;$('#choose-file').hidden=false;$('#io-dialog').showModal();};
    $('#export').onclick=()=>{if(!validateInputs())return;$('#io-format').hidden=false;$('#io-format').value='official';$('#io-title').textContent='导出调音';$('#io-hint').textContent='iBasso 兼容 JSON（按设备精度量化）。可下载后在官网自定义 EQ 中导入。';try{$('#io-text').value=M.formatOfficialJSON(draft);}catch(e){notice(e.message,true);return;}$('#io-apply').hidden=true;$('#choose-file').hidden=true;$('#io-dialog').showModal();};
    $('#io-format').onchange=e=>{$('#io-text').value=e.target.value==='autoeq'?M.formatAutoEq(draft):e.target.value==='project'?JSON.stringify({version:1,draft},null,2):M.formatOfficialJSON(draft);};
    $('#io-cancel').onclick=()=>$('#io-dialog').close();$('#choose-file').onclick=()=>$('#file').click();
    $('#file').onchange=async e=>{const f=e.target.files[0];if(f){if(f.size>5e6){notice('文件大于 5 MB，请选择数值曲线文件。',true);return;}$('#io-text').value=await f.text();}e.target.value='';};
    $('#download').onclick=()=>download(`${draft.name.replace(/[\\/:*?"<>|]/g,'_')}.${$('#io-format').value==='autoeq'?'txt':'json'}`,$('#io-text').value);
    $('#io-apply').onclick=()=>{try{const txt=$('#io-text').value.trim();let p;
      if(txt.startsWith('{')){const original=JSON.parse(txt),obj=original.target?.profile || original.backups?.target?.profile || original; p=obj.draft || (obj.bands?obj:M.parseOfficialJSON(obj));if(!p.bands||p.bands.length!==10)throw new Error('DC04U 需要 10 段滤波器。');p=M.normalizePreset(p,true);replaceDraft(p);}
      else if(/Filter\s+\d+:/i.test(txt)){p=M.parseAutoEq(txt);if(p.bands.length>10)throw new Error('滤波器超过 DC04U 的 10 段，请先精简。');while(p.bands.length<10)p.bands.push({...neutral().bands[p.bands.length],enabled:false});replaceDraft(p);}
      else{const pts=txt.split(/\r?\n/).map(l=>l.trim()).filter(l=>l&&!/^[*#;]/.test(l)).map(l=>l.split(/[,;\t ]+/).slice(0,2).map(Number)).filter(([f,d])=>Number.isFinite(f)&&f>0&&Number.isFinite(d)).map(([frequency,db])=>({frequency,db}));const canonical=M.canonicalCurve(pts);if(canonical.length<10)throw new Error('曲线至少需要 10 个不同频率的有效点。');M.normalizeCurve(canonical,1000);const id=`local-${Date.now()}`;curves.push({id,name:'导入曲线 '+new Date().toLocaleTimeString(),kind:'measurement',rig:'用户导入',points:canonical,source:'本机文件'});curveChanged(id,libraryDestination);notice('已导入的曲线已加入当前选择侧，并随草稿保存在本机。');}
      $('#io-dialog').close();notice('导入完成，只更新了草稿。');}catch(e){$('#io-hint').textContent=e.message;}};
    $('#read').onclick=async()=>{const b=$('#read');b.disabled=true;try{const r=await request('read',{refresh:true});if(!r.preset)throw new Error('当前模式未提供可读取的自定义 PEQ。请先在官网 EQ 页面查看当前模式。');replaceDraft(r.preset);notice(r.verified?'已读取设备当前自定义 EQ 作为草稿。没有写入。':'已载入官网缓存参数，尚未通过硬件读回核实。没有写入。');}catch(e){notice(e.message,true);}finally{b.disabled=false;}};
    $('#review').onclick=async event=>{
      if(!event.isTrusted||!validateInputs())return;
      const b=$('#review');b.disabled=true;try{
        const slot=Number($('#slot').value)+1,snapshot=copy(draft),rev=revision,staged=await request('stage',{preset:snapshot,slot}),r=await request('review',{stageId:staged.stageId},30000);if(rev!==revision||slot!==Number($('#slot').value)+1){await request('cancel');throw new Error('检查期间草稿或目标槽发生变化，请重新检查。');}review={...r,slot};
        $('#review-slot').textContent=`自定义 ${slot}`;$('#review-summary').textContent=`${r.profile.totalGain} dB · 10 段 · ${r.profile.name}`;
        $('#review-details').textContent=JSON.stringify({写入参数:r.profile,量化变化:r.quantization?.changes,目标槽备份:r.backups?.target?.verified?'已通过硬件读取':'仅缓存或不可用',当前模式:r.backups?.currentEqIndex,提示:r.warnings,确认期限:'请在 2 分钟内确认，超时后重新检查'},null,2);
        $('#review-check').checked=false;$('#commit').disabled=true;$('#review-dialog').showModal();
      }catch(e){notice(e.message,true);}finally{b.disabled=false;}
    };
    $('#slot').onchange=()=>{revision++;review=null;};
    $('#review-dialog').addEventListener('cancel',e=>{if(committing){e.preventDefault();return;}review=null;request('cancel').catch(()=>{});});
    $('#review-check').onchange=e=>{$('#commit').disabled=!e.target.checked;};
    $('#review-cancel').onclick=()=>{$('#review-dialog').close();request('cancel').catch(()=>{});review=null;};
    $('#backup').onclick=()=>{if(review)download(`DC04U-写入前备份-${new Date().toISOString().replace(/[:.]/g,'-')}.json`,JSON.stringify(review.backups || review.snapshot || review,null,2));};
    $('#commit').onclick=async e=>{
      if(!e.isTrusted||!review||!$('#review-check').checked)return;
      const b=$('#commit');committing=true;b.disabled=true;$('#review-check').disabled=true;$('#review-cancel').disabled=true;
      try{const r=await request('commit',{reviewToken:review.reviewToken,digest:review.digest},30000);$('#review-dialog').close();notice(r.verified?'已写入并通过设备读回核对。':'写入请求已完成；设备读回验证未确认，请查看官网与设备显示。');review=null;refreshDevice();}
      catch(e){$('#review-dialog').close();review=null;notice(`写入未确认：${e.message}。不要自动重试，请先读取设备当前状态。`,true);}
      finally{committing=false;$('#review-check').disabled=false;$('#review-cancel').disabled=false;}
    };
  }
  if (globalThis.chrome?.runtime?.onMessage) chrome.runtime.onMessage.addListener((message,_sender,respond) => { if(message?.type==='DC04U_GUARD_POPUP_EQ_V1'){open();respond({opened:!!host});return false;} });
  let scheduled=false;
  function scheduleMount(){if(scheduled)return;scheduled=true;setTimeout(()=>{scheduled=false;mount();},100);}
  new MutationObserver(scheduleMount).observe(document.documentElement,{childList:true,subtree:true});
  window.addEventListener('hashchange',mount);window.addEventListener('resize',requestGraph);
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',mount,{once:true});else mount();
})();
