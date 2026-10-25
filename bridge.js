(() => {
  "use strict";
  const PREF = "dc04uJumpGuardPanelV2";
  let state = null, received = 0, panel, root, detail, current, result, testButton, content, expandButton;
  let ui = { visible: false, expanded: false, x: null, y: null };
  let drag = null;
  try {
    const saved = JSON.parse(sessionStorage.getItem(PREF));
    if (saved && typeof saved === "object") {
      ui.visible = saved.visible === true; ui.expanded = saved.expanded === true;
      if (Number.isFinite(saved.x) && Number.isFinite(saved.y)) { ui.x = saved.x; ui.y = saved.y; }
    }
  } catch {}
  const validStatus = s => s && s.version === "1.1.3" && s.jumpThreshold === 30 && s.fixedCap === null;
  function summary() { return state && Date.now() - received < 6500 ? state : null; }
  function saveUI() { try { sessionStorage.setItem(PREF, JSON.stringify(ui)); } catch {} }
  function place(x, y) {
    if (!panel) return;
    const box = panel.getBoundingClientRect();
    const margin = 8;
    ui.x = Math.max(margin, Math.min(x, Math.max(margin, innerWidth - box.width - margin)));
    ui.y = Math.max(margin, Math.min(y, Math.max(margin, innerHeight - box.height - margin)));
    panel.style.setProperty("left", `${ui.x}px`, "important");
    panel.style.setProperty("top", `${ui.y}px`, "important");
    panel.style.setProperty("right", "auto", "important");
    panel.style.setProperty("bottom", "auto", "important");
  }
  function layout() {
    if (!panel) return;
    panel.style.setProperty("display", ui.visible ? "block" : "none", "important");
    panel.style.setProperty("width", ui.expanded ? "320px" : "230px", "important");
    content.hidden = !ui.expanded;
    expandButton.textContent = ui.expanded ? "收起" : "展开";
    expandButton.setAttribute("aria-expanded", String(ui.expanded));
    if (ui.visible) {
      if (Number.isFinite(ui.x) && Number.isFinite(ui.y)) place(ui.x, ui.y);
      else {
        panel.style.setProperty("left", "16px", "important");
        panel.style.setProperty("bottom", "16px", "important");
        panel.style.setProperty("right", "auto", "important");
        panel.style.setProperty("top", "auto", "important");
      }
    }
  }
  function render() {
    if (window !== window.top || !root) return;
    const s = summary();
    const ok = s?.hookReady && s.installedAtStart;
    root.querySelector(".title").textContent = ok ? "保护已启用 · >30" : "保护未确认";
    root.querySelector(".dot").className = `dot ${ok ? "ok" : "bad"}`;
    detail.textContent = !s ? "等待拦截器响应；不要依赖此页保护" : !ok ? (s.hookError || "请重新加载控制台") : s.baselineKnown ? "只拦音量档位跳变；其他设置可正常操作" : "等待设备音量回报；其他设置可正常操作";
    const v = s?.lastReport;
    current.textContent = v ? `设备上次回报：L ${v.left} / R ${v.right}` : "设备音量未知，音量写入暂被阻止";
    result.textContent = s ? `${s.latest} · 拦截 ${s.blockCount} 次` : "尚未取得状态";
    const test = s?.selfTest;
    testButton.textContent = test ? `离线自检 ${test.passed}/${test.total} · 再检查` : "离线自检（不写设备）";
    panel.style.setProperty("border-color", ok ? "#4c8576" : "#b66c59", "important");
  }
  function mount() {
    if (window !== window.top || panel || !document.documentElement) return;
    panel = document.createElement("aside");
    panel.id = "dc04u-jump-guard-panel";
    panel.style.cssText = "position:fixed!important;bottom:16px!important;left:16px!important;z-index:2147483647!important;width:230px!important;max-width:calc(100vw - 16px)!important;border:1px solid #64748b!important;border-radius:12px!important;box-shadow:0 6px 24px #0006!important;background:#101c2e!important;color:#edf4ff!important;display:none!important;";
    root = panel.attachShadow({ mode: "closed" });
    root.innerHTML = `<style>:host{font:12px/1.5 -apple-system,BlinkMacSystemFont,sans-serif}*{box-sizing:border-box}[hidden]{display:none!important}header{display:flex;align-items:center;gap:7px;padding:8px 10px;cursor:move;touch-action:none;user-select:none}.title{font-weight:650;flex:1;white-space:nowrap}.dot{width:8px;height:8px;border-radius:50%;background:#edb85d}.dot.ok{background:#65d7b3}.dot.bad{background:#ef9b7e}.body{padding:0 13px 12px}.rule{font-size:13px;color:#fff}.muted{color:#b7c8df;font-size:12px}.current{font-variant-numeric:tabular-nums;color:#9fe0ca}.result{color:#f3ce91;overflow-wrap:anywhere;font-size:12px}button{border:1px solid #52708c;border-radius:6px;background:#1d334b;color:#eaf3ff;padding:4px 7px;cursor:pointer;font:inherit}header button{font-size:11px;padding:2px 5px}p{margin:7px 0}details{margin-top:8px;color:#aebfd5;font-size:11px}summary{cursor:pointer}</style><section aria-label="DC04U 跳变保护状态"><header title="拖动可移动状态条"><span class="dot"></span><span class="title">保护状态</span><button class="expand" type="button" aria-label="展开或收起保护面板">展开</button><button class="hide" type="button" aria-label="隐藏保护面板">×</button></header><div class="body" hidden><p class="rule">向上跳变 &gt;30 档拦截 · 无固定上限</p><p class="muted detail"></p><p class="current"></p><p class="result" aria-live="polite"></p><button class="test" type="button">离线自检（不写设备）</button><details><summary>保护范围与规则</summary><p>增加30档允许；31档才拦。同次拖动累计比较，下调不限制。</p><p>增益、EQ、滤波、耳放电压等设置恢复官网原有行为；这些设置本身可改变响度，不属于音量档位跳变。</p><p>只保护本页WebHID音量命令；不覆盖本体按键、其他应用、音源突响或插拔爆音。不代表安全声压。</p><p>可拖动标题栏、收起或隐藏面板。隐藏后从Chrome工具栏图标重新显示；隐藏不关闭保护。</p></details></div></section>`;
    detail = root.querySelector(".detail"); current = root.querySelector(".current"); result = root.querySelector(".result");
    testButton = root.querySelector(".test"); content = root.querySelector(".body"); expandButton = root.querySelector(".expand");
    testButton.addEventListener("click", () => window.postMessage({ type: "DC04U_GUARD_SELFTEST_V1" }, "*"));
    expandButton.addEventListener("click", () => { ui.expanded = !ui.expanded; layout(); saveUI(); });
    root.querySelector(".hide").addEventListener("click", () => { ui.visible = false; layout(); saveUI(); });
    root.querySelector("details").addEventListener("toggle", () => { if (ui.visible) { layout(); saveUI(); } });
    const header = root.querySelector("header");
    header.addEventListener("pointerdown", event => {
      if (event.button !== 0 || event.target.closest("button")) return;
      const box = panel.getBoundingClientRect();
      drag = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, left: box.left, top: box.top };
      header.setPointerCapture(event.pointerId); event.preventDefault();
    });
    header.addEventListener("pointermove", event => {
      if (!drag || drag.pointerId !== event.pointerId) return;
      place(drag.left + event.clientX - drag.x, drag.top + event.clientY - drag.y); event.preventDefault();
    });
    function stopDrag(event) {
      if (!drag || event.pointerId !== drag.pointerId) return;
      if (header.hasPointerCapture(event.pointerId)) header.releasePointerCapture(event.pointerId);
      drag = null; saveUI();
    }
    header.addEventListener("pointerup", stopDrag); header.addEventListener("pointercancel", stopDrag);
    window.addEventListener("resize", () => { if (ui.visible) { layout(); saveUI(); } });
    document.documentElement.appendChild(panel); layout(); render();
  }
  window.addEventListener("message", event => {
    if (event.source !== window || event.data?.type !== "DC04U_GUARD_STATUS_V1" || !validStatus(event.data.status)) return;
    state = event.data.status; received = Date.now(); mount(); render();
  });
  chrome.runtime.onMessage.addListener((message, _sender, respond) => {
    if (message?.type === "DC04U_GUARD_POPUP_STATUS_V1") {
      const s = summary(); respond(s ? { ...s, panelVisible: ui.visible, panelExpanded: ui.expanded } : null); return false;
    }
    if (message?.type === "DC04U_GUARD_POPUP_PANEL_V1") {
      mount(); ui.visible = message.visible === true;
      if (message.expanded !== undefined) ui.expanded = message.expanded === true;
      layout(); saveUI(); respond({ visible: ui.visible, expanded: ui.expanded }); return false;
    }
    if (message?.type === "DC04U_GUARD_POPUP_SELFTEST_V1") {
      window.postMessage({ type: "DC04U_GUARD_SELFTEST_V1" }, "*"); respond({ requested: true }); return false;
    }
  });
  document.addEventListener("DOMContentLoaded", mount, { once: true }); mount();
  window.postMessage({ type: "DC04U_GUARD_PING_V1" }, "*");
  setInterval(() => { if (!chrome.runtime.id) { state = null; received = 0; } render(); }, 2000);
})();
