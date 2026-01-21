const DEFAULTS = {
  enabled: true,
  displayLen: 20,
  tooltipLen: 80,
  showPreviewText: true,
  autoRefreshOnAnswerDone: true,
  collapsed: false,
  positionMode: "default",
  panelPosition: { left: 0, top: 0 }
};

const storageArea = (chrome?.storage?.local) ? chrome.storage.local
                  : (chrome?.storage?.sync) ? chrome.storage.sync
                  : null;

function $(id) { return document.getElementById(id); }

function setStatus(msg) {
  const el = $("status");
  el.textContent = msg;
  if (!msg) return;
  setTimeout(() => { el.textContent = ""; }, 1600);
}

function readForm() {
  return {
    enabled: $("enabled").checked,
    displayLen: Number.parseInt($("displayLen").value, 10) || DEFAULTS.displayLen,
    tooltipLen: Number.parseInt($("tooltipLen").value, 10) || DEFAULTS.tooltipLen,
    showPreviewText: $("showPreviewText").checked,
    autoRefreshOnAnswerDone: $("autoRefreshOnAnswerDone").checked,
    collapsed: $("collapsed").checked
  };
}

function writeForm(v) {
  $("enabled").checked = !!v.enabled;
  $("displayLen").value = v.displayLen;
  $("tooltipLen").value = v.tooltipLen;
  $("showPreviewText").checked = !!v.showPreviewText;
  $("autoRefreshOnAnswerDone").checked = !!v.autoRefreshOnAnswerDone;
  $("collapsed").checked = !!v.collapsed;
}

function load() {
  if (!storageArea) { writeForm(DEFAULTS); return; }
  storageArea.get(DEFAULTS, (items) => writeForm(items || DEFAULTS));
}

function save(values) {
  if (!storageArea) return setStatus("保存失敗（storage APIがありません）");
  storageArea.set(values, () => setStatus("保存しました。"));
}

function resetAll() {
  if (!storageArea) return setStatus("リセット失敗（storage APIがありません）");
  storageArea.set(DEFAULTS, () => {
    writeForm(DEFAULTS);
    setStatus("初期値に戻しました。");
  });
}

function resetPos() {
  if (!storageArea) return setStatus("位置リセット失敗（storage APIがありません）");
  storageArea.set(
    { positionMode: "default", panelPosition: { left: 0, top: 0 } },
    () => setStatus("パネル位置をリセットしました。")
  );
}

document.addEventListener("DOMContentLoaded", () => {
  load();
  $("save").addEventListener("click", () => save(readForm()));
  $("reset").addEventListener("click", () => resetAll());
  $("resetPos").addEventListener("click", () => resetPos());
});
