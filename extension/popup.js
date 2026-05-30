const els = {
  targetLang: document.getElementById("targetLang"),
  voice: document.getElementById("voice"),
  speed: document.getElementById("speed"),
  steps: document.getElementById("steps"),
  srt: document.getElementById("srt"),
  pauseToSync: document.getElementById("pauseToSync"),
  status: document.getElementById("status"),
  startBtn: document.getElementById("startBtn"),
  stopBtn: document.getElementById("stopBtn"),
};

const DEFAULTS = {
  targetLang: "ar|Arabic",
  voice: "M1",
  speed: 1.0,
  steps: 8,
  pauseToSync: true,
};

chrome.storage.local.get(["settings", "srt"]).then(({ settings, srt }) => {
  const s = { ...DEFAULTS, ...(settings || {}) };
  els.targetLang.value = s.targetLang;
  els.voice.value = s.voice;
  els.speed.value = s.speed;
  els.steps.value = s.steps;
  els.pauseToSync.checked = s.pauseToSync;
  if (typeof srt === "string") els.srt.value = srt;
  refreshState();
});

// Persist the pasted SRT so it survives closing/reopening the popup.
els.srt.addEventListener("input", () => {
  chrome.storage.local.set({ srt: els.srt.value });
});

// On open, recover the live dubbing status from the content script so the
// popup reflects an in-progress run instead of starting blank.
async function refreshState() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return;
    const res = await chrome.tabs.sendMessage(tab.id, { type: "GET_STATE" });
    if (!res) return;
    if (res.active) {
      els.status.textContent =
        res.text || `audio ready ${res.ready}/${res.total}`;
      els.startBtn.textContent = "Dubbing… (restart)";
    } else if (res.text) {
      els.status.textContent = res.text;
    }
  } catch {
    // No content script on this tab (not a YouTube page) — leave it blank.
  }
}

function readSettings() {
  const [langCode, langName] = els.targetLang.value.split("|");
  const s = {
    targetLang: els.targetLang.value,
    targetLangCode: langCode,
    targetLangName: langName,
    voice: els.voice.value,
    speed: Number(els.speed.value) || 1.0,
    steps: Number(els.steps.value) || 8,
    pauseToSync: els.pauseToSync.checked,
  };
  chrome.storage.local.set({ settings: s }); // SRT persists separately (see input handler)
  return { ...s, srt: els.srt.value };
}

async function send(message) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error("No active tab.");
  if (!/^https:\/\/www\.youtube\.com\//.test(tab.url || "")) {
    throw new Error("Open a YouTube video tab first.");
  }
  return chrome.tabs.sendMessage(tab.id, message);
}

// Status updates streamed from the content script.
chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === "DUB_STATUS") els.status.textContent = msg.text;
});

els.startBtn.addEventListener("click", async () => {
  els.status.textContent = "Starting…";
  try {
    const res = await send({ type: "START_DUB", settings: readSettings() });
    if (res?.error) els.status.textContent = `Error: ${res.error}`;
  } catch (e) {
    els.status.textContent = `Error: ${e.message}`;
  }
});

els.stopBtn.addEventListener("click", async () => {
  try {
    await send({ type: "STOP_DUB" });
    els.status.textContent = "Stopped.";
  } catch (e) {
    els.status.textContent = `Error: ${e.message}`;
  }
});
