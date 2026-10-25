"use strict";
let tabId, panelVisible = false;
async function refresh() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    tabId = tab.id;
    const s = await chrome.tabs.sendMessage(tabId, { type: "DC04U_GUARD_POPUP_STATUS_V1" }, { frameId: 0 });
    if (!s?.hookReady || !s.installedAtStart) throw new Error("未确认");
    panelVisible = s.panelVisible === true;
    document.querySelector("#panel").textContent = panelVisible ? "隐藏状态条" : "显示状态条";
    document.querySelector("#state").textContent = s.baselineKnown ? "本页保护已启用 · 设备状态已读取" : "拦截器已启用 · 等待设备回报";
    document.querySelector("#volume").textContent = s.lastReport ? `设备上次回报 L ${s.lastReport.left} / R ${s.lastReport.right}` : "当前设备音量未知；禁止写音量";
    document.querySelector("#last").textContent = `${s.latest} · 拦截 ${s.blockCount} 次`;
    if (s.selfTest) document.querySelector("#test").textContent = `离线自检 ${s.selfTest.passed}/${s.selfTest.total} · 再检查`;
  } catch {
    document.querySelector("#state").textContent = "当前页未确认保护。打开或重载 iBasso 控制台。";
    document.querySelector("#test").disabled = true;
    document.querySelector("#panel").disabled = true;
  }
}
document.querySelector("#panel").addEventListener("click", async () => {
  await chrome.tabs.sendMessage(tabId, {
    type: "DC04U_GUARD_POPUP_PANEL_V1", visible: !panelVisible, expanded: false
  }, { frameId: 0 });
  refresh();
});
document.querySelector("#test").addEventListener("click", async () => {
  await chrome.tabs.sendMessage(tabId, { type: "DC04U_GUARD_POPUP_SELFTEST_V1" }, { frameId: 0 });
  setTimeout(refresh, 100);
});
refresh();

document.querySelector("#eq").addEventListener("click", async () => {
  try { await chrome.tabs.sendMessage(tabId, {type:"DC04U_GUARD_POPUP_EQ_V1"}, {frameId:0});window.close(); }
  catch {document.querySelector("#state").textContent="请重新加载 DC04U 网页以启用高级 EQ。";}
});
