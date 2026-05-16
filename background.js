// Service worker: OpenAI TTS proxy + command/context-menu routing.
//
// The API key lives here (chrome.storage.local) and never touches page
// context. The content script sends text; we return base64-encoded audio.

const MSG = {
  START: 'sr/start',
  PAUSE: 'sr/pause',
  RESUME: 'sr/resume',
  STOP: 'sr/stop',
  TTS_REQUEST: 'sr/ttsRequest',
  REQUEST_STATE: 'sr/requestState',
};

const OPENAI_TTS_URL = 'https://api.openai.com/v1/audio/speech';
const MAX_CHUNK_CHARS = 3500;
const TTS_TIMEOUT_MS = 30000;

// ── lifecycle ───────────────────────────────────────────────────────────────
chrome.runtime.onInstalled.addListener(() => {
  // removeAll first: onInstalled fires on update too, and re-creating a menu
  // with an existing id throws "duplicate id".
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: 'sr-read-selection',
      title: 'Read selection with SuperReader',
      contexts: ['selection'],
    });
    chrome.contextMenus.create({
      id: 'sr-read-page',
      title: 'Read this page with SuperReader',
      contexts: ['page'],
    });
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (!tab || !tab.id) return;
  ensureContentScript(tab.id).then(() => {
    chrome.tabs.sendMessage(tab.id, { type: MSG.START }).catch(() => {});
  });
});

chrome.commands.onCommand.addListener(async (command) => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id) return;
  await ensureContentScript(tab.id);
  if (command === 'toggle-read') {
    // Ask the content script to toggle; START handles idle→play and
    // paused→resume. For playing→pause we need an explicit toggle.
    const state = await safeSendMessage(tab.id, { type: MSG.REQUEST_STATE });
    if (state && state.state === 'playing') {
      chrome.tabs.sendMessage(tab.id, { type: MSG.PAUSE }).catch(() => {});
    } else if (state && state.state === 'paused') {
      chrome.tabs.sendMessage(tab.id, { type: MSG.RESUME }).catch(() => {});
    } else {
      chrome.tabs.sendMessage(tab.id, { type: MSG.START }).catch(() => {});
    }
  } else if (command === 'stop-read') {
    chrome.tabs.sendMessage(tab.id, { type: MSG.STOP }).catch(() => {});
  }
});

// ── message handling ────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg) return false;
  if (msg.type === MSG.TTS_REQUEST) {
    handleTTS(msg)
      .then((result) => sendResponse(result))
      .catch((err) => sendResponse({ ok: false, error: String(err && err.message || err) }));
    return true; // async response
  }
  if (msg.type === 'sr/ensureInject') {
    const tabId = msg.tabId || (sender.tab && sender.tab.id);
    if (tabId == null) { sendResponse({ ok: false }); return true; }
    ensureContentScript(tabId)
      .then((ok) => {
        if (ok) chrome.tabs.sendMessage(tabId, { type: MSG.START }).catch(() => {});
        sendResponse({ ok });
      })
      .catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true;
  }
  return false;
});

async function handleTTS({ text, voice, model }) {
  const { apiKey } = await chrome.storage.local.get('apiKey');
  if (!apiKey) {
    return { ok: false, error: 'No API key set. Open SuperReader options to add one.' };
  }

  let speakText = (text || '').trim();
  if (!speakText) return { ok: false, error: 'Empty text' };
  if (speakText.length > MAX_CHUNK_CHARS) {
    // Hard safety clamp — the reader splits by sentence, so this is rare.
    speakText = speakText.slice(0, MAX_CHUNK_CHARS);
  }

  const body = {
    model: model || 'gpt-4o-mini-tts',
    voice: voice || 'alloy',
    input: speakText,
    response_format: 'mp3',
  };

  let resp;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TTS_TIMEOUT_MS);
  try {
    resp = await fetch(OPENAI_TTS_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (e) {
    if (e.name === 'AbortError') {
      return { ok: false, error: `Request timed out after ${TTS_TIMEOUT_MS / 1000}s` };
    }
    return { ok: false, error: `Network error: ${e.message || e}` };
  } finally {
    clearTimeout(timer);
  }

  if (!resp.ok) {
    let detail = `HTTP ${resp.status}`;
    try {
      const errJson = await resp.json();
      detail = errJson?.error?.message || detail;
    } catch (e) { /* non-JSON error body */ }
    if (resp.status === 401) detail = 'Invalid API key (401). Check SuperReader options.';
    if (resp.status === 429) detail = 'Rate limited or quota exceeded (429).';
    return { ok: false, error: detail };
  }

  const buf = await resp.arrayBuffer();
  const base64 = arrayBufferToBase64(buf);
  return { ok: true, audio: base64, mime: 'audio/mpeg' };
}

// ── helpers ─────────────────────────────────────────────────────────────────
function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

async function safeSendMessage(tabId, msg) {
  try {
    return await chrome.tabs.sendMessage(tabId, msg);
  } catch (e) {
    return null;
  }
}

// Inject the content script if it isn't already there (e.g. the extension was
// just installed/updated and the page predates it). Returns true if the
// content script is present afterwards, false if the page can't be injected
// (chrome:// pages, the Web Store, the PDF viewer, etc.).
async function ensureContentScript(tabId) {
  const ping = await safeSendMessage(tabId, { type: MSG.REQUEST_STATE });
  if (ping && ping.ok) return true;
  try {
    await chrome.scripting.insertCSS({
      target: { tabId },
      files: ['content/styles.css'],
    });
    await chrome.scripting.executeScript({
      target: { tabId },
      files: [
        'lib/utils.js',
        'content/extractor.js',
        'content/highlighter.js',
        'content/widget.js',
        'content/reader.js',
        'content/content.js',
      ],
    });
    return true;
  } catch (e) {
    console.warn('[SuperReader] Cannot inject into this page:', e.message);
    return false;
  }
}
