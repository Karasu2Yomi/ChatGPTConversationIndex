
(() => {
  "use strict";

  const PANEL_ID = "cidx-panel";

  const DEFAULTS = {
    enabled: true,
    displayLen: 20,
    tooltipLen: 80,
    showPreviewText: true,
    collapsed: false,
    positionMode: "default",
    panelPosition: { left: 0, top: 0 },
    autoRefreshOnAnswerDone: true
  };

  const storageArea = (chrome?.storage?.local) ? chrome.storage.local
                    : (chrome?.storage?.sync) ? chrome.storage.sync
                    : null;

  const storageGet = (defaults) => new Promise((resolve) => {
    if (!storageArea) return resolve({ ...defaults });
    storageArea.get(defaults, (items) => resolve(items || { ...defaults }));
  });

  const storageSet = (patch) => new Promise((resolve) => {
    if (!storageArea) return resolve();
    storageArea.set(patch, () => resolve());
  });

  let settings = { ...DEFAULTS };

  let panel = null;
  let filterInput = null;
  let listEl = null;

  // in-panel settings
  let settingsEl = null;
  let settingsVisible = false;
  let settingsInputs = {};

  // auto refresh
  let genPollTimer = null;
  let prevGenerating = false;
  let rebuildTimer = null;

  // drag state
  let dragActive = false;
  let dragPointerId = null;
  let dragStart = null;

  // url watch (slow)
  let urlWatchTimer = null;
  let lastUrl = location.href;

  // ---------- utils ----------
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const clampInt = (v, min, max, fallback) => {
    const n = Number.parseInt(String(v), 10);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(min, Math.min(max, n));
  };

  const shortenByChars = (text, maxChars) => {
    const s = (text || "").trim();
    if (s.length <= maxChars) return s;
    return s.slice(0, maxChars) + "…";
  };

  const cleanText = (s) => (s || "")
    .replace(/\r/g, "")
    .replace(/\t/g, " ")
    .replace(/[ \u00A0]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  function isConversationUrl(url = location.href) {
    try {
      const u = new URL(url);
      const hostOk = (u.hostname === "chatgpt.com" || u.hostname === "chat.openai.com");
      if (!hostOk) return false;
      const p = u.pathname || "";
      return p.startsWith("/share/") || p.startsWith("/c/") || p.includes("/c/");
    } catch {
      return false;
    }
  }

  function findTurns() {
    const main = document.querySelector("main");
    if (!main) return [];
    let turns = Array.from(main.querySelectorAll('[data-testid="conversation-turn"]'));
    if (turns.length) return turns;
    turns = Array.from(main.querySelectorAll("article")).filter((a) =>
      a.querySelector("[data-message-author-role]")
    );
    return turns;
  }

  function getRole(turn) {
    const roleEl = turn.querySelector("[data-message-author-role]");
    const role = roleEl?.getAttribute?.("data-message-author-role");
    if (role === "user") return "U";
    if (role === "assistant") return "A";
    return "•";
  }

  // use textContent (avoid forced layout)
  function getBestText(turn) {
    const roleRoot = turn.querySelector("[data-message-author-role]") || turn;
    const candidates = [];
    roleRoot.querySelectorAll(".markdown, .prose, [data-testid='message-content']").forEach((n) => {
      const t = cleanText(n.textContent || "");
      if (t) candidates.push(t);
    });
    if (candidates.length) {
      candidates.sort((a, b) => b.length - a.length);
      return candidates[0];
    }
    return cleanText(roleRoot.textContent || "");
  }

  function highlightTurn(turn) {
    turn.classList.add("cidx-highlight");
    setTimeout(() => turn.classList.remove("cidx-highlight"), 900);
  }

  function isGenerating() {
    return !!(
      document.querySelector('button[aria-label*="Stop"]') ||
      document.querySelector('button[aria-label*="停止"]') ||
      document.querySelector('button[data-testid*="stop"]')
    );
  }

  function applySettings(raw) {
    settings = { ...DEFAULTS, ...(raw || {}) };
    settings.displayLen = clampInt(settings.displayLen, 1, 200, DEFAULTS.displayLen);
    settings.tooltipLen = clampInt(settings.tooltipLen, 1, 500, DEFAULTS.tooltipLen);
    if (!settings.panelPosition || typeof settings.panelPosition !== "object") {
      settings.panelPosition = { ...DEFAULTS.panelPosition };
    }
  }

  // ---------- position ----------
  function setDefaultPosition() {
    const el = document.getElementById(PANEL_ID);
    if (!el) return;
    el.style.top = "88px";
    el.style.right = "12px";
    el.style.left = "auto";
    el.style.bottom = "auto";
  }

  function setCustomPosition(left, top) {
    const el = document.getElementById(PANEL_ID);
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const maxLeft = Math.max(0, window.innerWidth - rect.width);
    const maxTop = Math.max(0, window.innerHeight - rect.height);
    const clampedLeft = Math.max(0, Math.min(left, maxLeft));
    const clampedTop = Math.max(0, Math.min(top, maxTop));
    el.style.left = `${clampedLeft}px`;
    el.style.top = `${clampedTop}px`;
    el.style.right = "auto";
    el.style.bottom = "auto";
    settings.positionMode = "custom";
    settings.panelPosition = { left: clampedLeft, top: clampedTop };
  }

  function applyPosition() {
    if (!panel) return;
    if (settings.positionMode === "custom") setCustomPosition(settings.panelPosition.left, settings.panelPosition.top);
    else setDefaultPosition();
  }

  let resizeTimer = null;
  window.addEventListener("resize", () => {
    if (!panel) return;
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (settings.positionMode === "custom") applyPosition();
    }, 250);
  });

  // ---------- UI ----------
  function applyCollapse() {
    const el = document.getElementById(PANEL_ID);
    if (!el) return;
    el.classList.toggle("cidx-collapsed", !!settings.collapsed);
  }

  function toggleSettingsDrawer(force) {
    settingsVisible = (typeof force === "boolean") ? force : !settingsVisible;
    if (!settingsEl) return;
    settingsEl.classList.toggle("cidx-hidden", !settingsVisible);
  }

  function syncSettingsDrawerFromState() {
    if (!settingsInputs.displayLen) return;
    settingsInputs.displayLen.value = settings.displayLen;
    settingsInputs.tooltipLen.value = settings.tooltipLen;
    settingsInputs.showPreviewText.checked = !!settings.showPreviewText;
    settingsInputs.autoRefreshOnAnswerDone.checked = !!settings.autoRefreshOnAnswerDone;
  }

  async function applySettingsFromDrawer() {
    const displayLen = clampInt(settingsInputs.displayLen.value, 1, 200, settings.displayLen);
    const tooltipLen = clampInt(settingsInputs.tooltipLen.value, 1, 500, settings.tooltipLen);
    const showPreviewText = !!settingsInputs.showPreviewText.checked;
    const autoRefreshOnAnswerDone = !!settingsInputs.autoRefreshOnAnswerDone.checked;

    settings.displayLen = displayLen;
    settings.tooltipLen = tooltipLen;
    settings.showPreviewText = showPreviewText;
    settings.autoRefreshOnAnswerDone = autoRefreshOnAnswerDone;

    await storageSet({ displayLen, tooltipLen, showPreviewText, autoRefreshOnAnswerDone });

    if (!settings.collapsed) buildIndex(true);
    stopGenPoll();
    maybeStartGenPoll();
  }

  function ensurePanel() {
    if (panel && document.getElementById(PANEL_ID)) return;

    panel = document.createElement("div");
    panel.id = PANEL_ID;

    const header = document.createElement("div");
    header.id = "cidx-header";

    const drag = document.createElement("div");
    drag.id = "cidx-drag";
    drag.textContent = "≡";
    drag.title = "ドラッグして移動（ダブルクリックで右上へ）";

    const title = document.createElement("div");
    title.id = "cidx-title";
    title.textContent = "Index";

    filterInput = document.createElement("input");
    filterInput.id = "cidx-filter";
    filterInput.placeholder = "filter…（部分一致）";

    const btnRefresh = document.createElement("button");
    btnRefresh.className = "cidx-btn";
    btnRefresh.id = "cidx-refresh";
    btnRefresh.textContent = "↻";
    btnRefresh.title = "再生成";

    const btnOptions = document.createElement("button");
    btnOptions.className = "cidx-btn";
    btnOptions.id = "cidx-options";
    btnOptions.textContent = "⚙";
    btnOptions.title = "設定（パネル内）";

    const btnCollapse = document.createElement("button");
    btnCollapse.className = "cidx-btn";
    btnCollapse.id = "cidx-collapse";
    btnCollapse.textContent = "⟷";
    btnCollapse.title = "折りたたみ/展開";

    header.appendChild(drag);
    header.appendChild(title);
    header.appendChild(filterInput);
    header.appendChild(btnRefresh);
    header.appendChild(btnOptions);
    header.appendChild(btnCollapse);

    // settings drawer
    settingsEl = document.createElement("div");
    settingsEl.id = "cidx-settings";
    settingsEl.classList.add("cidx-hidden");

    const makeRow = (labelText, inputEl) => {
      const r = document.createElement("div");
      r.className = "cidx-setting-row";
      const l = document.createElement("label");
      l.textContent = labelText;
      r.appendChild(l);
      r.appendChild(inputEl);
      return r;
    };

    const inDisplay = document.createElement("input");
    inDisplay.type = "number"; inDisplay.min = "1"; inDisplay.max = "200";
    const inTooltip = document.createElement("input");
    inTooltip.type = "number"; inTooltip.min = "1"; inTooltip.max = "500";
    const inShow = document.createElement("input");
    inShow.type = "checkbox";
    const inAuto = document.createElement("input");
    inAuto.type = "checkbox";

    settingsInputs = {
      displayLen: inDisplay,
      tooltipLen: inTooltip,
      showPreviewText: inShow,
      autoRefreshOnAnswerDone: inAuto
    };

    settingsEl.appendChild(makeRow("表示文字数", inDisplay));
    settingsEl.appendChild(makeRow("ツールチップ文字数", inTooltip));
    settingsEl.appendChild(makeRow("タイトル表示", inShow));
    settingsEl.appendChild(makeRow("自動更新（完了時）", inAuto));

    const actions = document.createElement("div");
    actions.id = "cidx-settings-actions";

    const btnApply = document.createElement("button");
    btnApply.className = "cidx-btn";
    btnApply.textContent = "適用";

    const btnResetPos = document.createElement("button");
    btnResetPos.className = "cidx-btn";
    btnResetPos.textContent = "位置リセット";

    actions.appendChild(btnApply);
    actions.appendChild(btnResetPos);
    settingsEl.appendChild(actions);

    const hint = document.createElement("div");
    hint.className = "cidx-mini";
    hint.textContent = "折りたたみ中は自動更新しません。展開時に1回更新します。";
    settingsEl.appendChild(hint);

    // body
    const body = document.createElement("div");
    body.id = "cidx-body";
    listEl = document.createElement("div");
    listEl.id = "cidx-list";
    body.appendChild(listEl);

    panel.appendChild(header);
    panel.appendChild(settingsEl);
    panel.appendChild(body);
    document.body.appendChild(panel);

    // events
    filterInput.addEventListener("input", () => buildIndex());
    btnRefresh.addEventListener("click", () => buildIndex(true));
    btnOptions.addEventListener("click", () => { toggleSettingsDrawer(); syncSettingsDrawerFromState(); });
    btnApply.addEventListener("click", () => applySettingsFromDrawer());
    btnResetPos.addEventListener("click", async () => {
      settings.positionMode = "default";
      settings.panelPosition = { left: 0, top: 0 };
      applyPosition();
      await storageSet({ positionMode: settings.positionMode, panelPosition: settings.panelPosition });
    });

    btnCollapse.addEventListener("click", async () => {
      settings.collapsed = !settings.collapsed;
      applyCollapse();
      applyPosition();
      toggleSettingsDrawer(false);

      if (settings.collapsed) stopGenPoll();
      else { buildIndex(true); maybeStartGenPoll(); }

      await storageSet({ collapsed: settings.collapsed });
    });

    // drag: pointer events with cleanup
    const endDrag = async () => {
      if (!dragActive) return;
      dragActive = false;
      try { if (dragPointerId !== null) drag.releasePointerCapture(dragPointerId); } catch {}
      dragPointerId = null;
      dragStart = null;
      window.removeEventListener("blur", endDrag);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      await storageSet({ positionMode: settings.positionMode, panelPosition: settings.panelPosition });
    };

    const onVisibilityChange = () => { if (document.hidden) endDrag(); };

    drag.addEventListener("pointerdown", (ev) => {
      if (ev.button !== 0) return;
      ev.preventDefault();

      const el = document.getElementById(PANEL_ID);
      if (!el) return;

      const rect = el.getBoundingClientRect();
      el.style.left = `${rect.left}px`;
      el.style.top = `${rect.top}px`;
      el.style.right = "auto";
      el.style.bottom = "auto";

      dragActive = true;
      dragPointerId = ev.pointerId;
      dragStart = { x: ev.clientX, y: ev.clientY, left: rect.left, top: rect.top };

      try { drag.setPointerCapture(ev.pointerId); } catch {}
      window.addEventListener("blur", endDrag);
      document.addEventListener("visibilitychange", onVisibilityChange);
    });

    drag.addEventListener("pointermove", (ev) => {
            if (!dragActive || dragPointerId !== ev.pointerId || !dragStart) return;
      const dx = ev.clientX - dragStart.x;
      const dy = ev.clientY - dragStart.y;
      setCustomPosition(dragStart.left + dx, dragStart.top + dy);
    });

    drag.addEventListener("pointerup", (ev) => { if (dragPointerId === ev.pointerId) endDrag(); });
    drag.addEventListener("pointercancel", (ev) => { if (dragPointerId === ev.pointerId) endDrag(); });

    drag.addEventListener("dblclick", async () => {
      settings.positionMode = "default";
      settings.panelPosition = { left: 0, top: 0 };
      applyPosition();
      await storageSet({ positionMode: settings.positionMode, panelPosition: settings.panelPosition });
    });

    applyCollapse();
    applyPosition();
    syncSettingsDrawerFromState();
  }

  function removePanel() {
    const el = document.getElementById(PANEL_ID);
    if (el) el.remove();
    panel = null;
    filterInput = null;
    listEl = null;
    settingsEl = null;
    settingsVisible = false;
    stopGenPoll();
  }

  // ---------- build index ----------
  function buildIndex() {
    if (!panel || !listEl) return;
    if (!isConversationUrl()) return;

    const turns = findTurns();
    const q = (filterInput?.value || "").trim().toLowerCase();

    listEl.innerHTML = "";

    if (!turns.length) {
      const empty = document.createElement("div");
      empty.className = "cidx-empty";
      empty.textContent = "会話ターンが見つかりません（読み込み後に↻）。";
      listEl.appendChild(empty);
      return;
    }

    let shown = 0;
    for (let idx = 0; idx < turns.length; idx++) {
      const turn = turns[idx];
      const role = getRole(turn);
      const full = getBestText(turn);
      const displayText = shortenByChars(full, settings.displayLen);
      const tooltipText = shortenByChars(full, settings.tooltipLen);

      const label = settings.showPreviewText ? `${idx + 1}. ${displayText || "(empty)"}` : `${idx + 1}.`;
      const hay = (settings.showPreviewText ? `${role} ${displayText} ${full}` : `${role} ${idx + 1}`).toLowerCase();
      if (q && !hay.includes(q)) continue;

      const item = document.createElement("div");
      item.className = "cidx-item";
      item.title = tooltipText || "";

      const badge = document.createElement("div");
      badge.className = "cidx-badge";
      badge.textContent = role;

      const text = document.createElement("div");
      text.className = "cidx-text";
      text.textContent = label;

      item.appendChild(badge);
      item.appendChild(text);

      item.addEventListener("click", () => {
        turn.scrollIntoView({ behavior: "smooth", block: "start" });
        highlightTurn(turn);
      });

      listEl.appendChild(item);
      shown++;
    }

    if (!shown) {
      const empty = document.createElement("div");
      empty.className = "cidx-empty";
      empty.textContent = "該当なし（または、まだDOMに読み込まれていません。上へスクロール→↻）";
      listEl.appendChild(empty);
    }
  }

  // ---------- auto refresh ----------
  function scheduleRebuildOnce() {
    if (settings.collapsed) return;
    clearTimeout(rebuildTimer);
    rebuildTimer = setTimeout(() => {
      if (isGenerating()) return;
      const doBuild = () => buildIndex(true);
      if ("requestIdleCallback" in window) window.requestIdleCallback(doBuild, { timeout: 1000 });
      else doBuild();
    }, 900);
  }

  function maybeStartGenPoll() {
    if (!settings.autoRefreshOnAnswerDone) return;
    if (!panel) return;
    if (settings.collapsed) return;
    if (genPollTimer) return;

    prevGenerating = isGenerating();
    genPollTimer = setInterval(() => {
      if (!panel || settings.collapsed || !settings.autoRefreshOnAnswerDone) return;
      const now = isGenerating();
      if (prevGenerating && !now) scheduleRebuildOnce();
      prevGenerating = now;
    }, 900);
  }

  function stopGenPoll() {
    if (genPollTimer) { clearInterval(genPollTimer); genPollTimer = null; }
    clearTimeout(rebuildTimer); rebuildTimer = null;
  }

  // ---------- init / teardown ----------
  async function waitForMainReady() {
    for (let i = 0; i < 80; i++) {
      if (document.querySelector("main")) return true;
      await sleep(100);
    }
    return false;
  }

  async function initOrTeardown() {
    if (!settings.enabled || !isConversationUrl()) { removePanel(); return; }
    const ok = await waitForMainReady();
    if (!ok) return;
    ensurePanel();
    if (!settings.collapsed) buildIndex(true);
    stopGenPoll();
    maybeStartGenPoll();
  }

  function startUrlWatch() {
    if (urlWatchTimer) return;
    urlWatchTimer = setInterval(() => {
      if (location.href === lastUrl) return;
      lastUrl = location.href;
      initOrTeardown();
    }, 1200);
  }

  function listenSettingsChanges() {
    chrome?.storage?.onChanged?.addListener?.((changes, area) => {
      if (area !== "local" && area !== "sync") return;
      const patch = {};
      for (const k of Object.keys(changes)) patch[k] = changes[k].newValue;
      applySettings({ ...settings, ...patch });

      if (panel) {
        applyCollapse();
        applyPosition();
        syncSettingsDrawerFromState();
        if (settings.collapsed) stopGenPoll();
        else { buildIndex(true); stopGenPoll(); maybeStartGenPoll(); }
      } else {
        initOrTeardown();
      }
    });
  }

  (async function main() {
    const raw = await storageGet(DEFAULTS);
    applySettings(raw);
    listenSettingsChanges();
    startUrlWatch();
    await initOrTeardown();
  })();
})();
