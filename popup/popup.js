// Popup controller. Mirrors and drives the content script's Reader.
(function () {
  const SR = window.SR;
  const MSG = SR.MSG;

  const $ = (id) => document.getElementById(id);
  const els = {
    status: $('status'),
    needsKey: $('needs-key'),
    main: $('main'),
    prev: $('prev'),
    playpause: $('playpause'),
    next: $('next'),
    stop: $('stop'),
    speed: $('speed'),
    speedVal: $('speed-val'),
    voice: $('voice'),
    model: $('model'),
    error: $('error'),
    openOptions: $('open-options'),
    footerOptions: $('footer-options'),
  };

  let activeTabId = null;
  let currentState = 'idle';

  // ── populate selects ───────────────────────────────────────────────────
  els.voice.innerHTML = SR.VOICES.map(v => `<option value="${v.id}">${v.label}</option>`).join('');
  els.model.innerHTML = SR.MODELS.map(m => `<option value="${m.id}">${m.label}</option>`).join('');

  // ── messaging helpers ──────────────────────────────────────────────────
  async function getActiveTab() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return tab;
  }

  async function sendToTab(msg) {
    if (activeTabId == null) return null;
    try {
      return await chrome.tabs.sendMessage(activeTabId, msg);
    } catch (e) {
      // Content script not present (fresh install, restricted page).
      return null;
    }
  }

  function setError(text) {
    els.error.textContent = text || '';
    els.error.style.display = text ? 'block' : 'none';
  }

  function renderState(state, idx, total) {
    currentState = state || 'idle';
    if (total > 0 && (state === 'playing' || state === 'paused' || state === 'loading')) {
      els.status.textContent = `${state} · ${idx + 1}/${total}`;
    } else {
      els.status.textContent = state || 'idle';
    }
    if (state === 'playing') {
      els.playpause.textContent = '❚❚ Pause';
    } else if (state === 'paused') {
      els.playpause.textContent = '▶ Resume';
    } else {
      els.playpause.textContent = '▶ Read page';
    }
  }

  // ── init ───────────────────────────────────────────────────────────────
  async function init() {
    const tab = await getActiveTab();
    activeTabId = tab ? tab.id : null;

    const stored = await chrome.storage.local.get(['apiKey', 'speed', 'voice', 'model']);
    if (!stored.apiKey) {
      els.needsKey.style.display = 'block';
    }

    const speed = stored.speed || SR.DEFAULTS.speed;
    els.speed.value = speed;
    els.speedVal.textContent = Number(speed).toFixed(2) + '×';
    els.voice.value = stored.voice || SR.DEFAULTS.voice;
    els.model.value = stored.model || SR.DEFAULTS.model;

    // Ask the content script for live state.
    const state = await sendToTab({ type: MSG.REQUEST_STATE });
    if (state && state.ok) {
      renderState(state.state, state.idx, state.total);
      if (state.settings) {
        els.speed.value = state.settings.speed;
        els.speedVal.textContent = Number(state.settings.speed).toFixed(2) + '×';
        els.voice.value = state.settings.voice;
        els.model.value = state.settings.model;
      }
    } else {
      renderState('idle', 0, 0);
    }
  }

  // ── control wiring ─────────────────────────────────────────────────────
  els.playpause.addEventListener('click', async () => {
    setError('');
    if (currentState === 'playing') {
      await sendToTab({ type: MSG.PAUSE });
      await refresh();
    } else if (currentState === 'paused') {
      await sendToTab({ type: MSG.RESUME });
      await refresh();
    } else {
      // idle → start. Inject if needed via background.
      const resp = await sendToTab({ type: MSG.START });
      if (resp == null) {
        // Content script missing — ask background to inject, then retry.
        const injected = await chrome.runtime
          .sendMessage({ type: 'sr/ensureInject', tabId: activeTabId })
          .catch(() => null);
        if (!injected || !injected.ok) {
          setError("This page can't be read (browser-restricted page).");
          return;
        }
      }
      renderState('loading', 0, 0);
      // The first TTS request can take a couple of seconds; poll a few times
      // so the popup reflects real state if it's still open.
      pollRefresh();
    }
  });

  els.stop.addEventListener('click', async () => {
    await sendToTab({ type: MSG.STOP });
    renderState('idle', 0, 0);
  });

  els.prev.addEventListener('click', () => sendToTab({ type: MSG.SKIP_PREV }));
  els.next.addEventListener('click', () => sendToTab({ type: MSG.SKIP_NEXT }));

  els.speed.addEventListener('input', () => {
    const v = parseFloat(els.speed.value);
    els.speedVal.textContent = v.toFixed(2) + '×';
    chrome.storage.local.set({ speed: v });
    sendToTab({ type: MSG.SET_RATE, rate: v });
  });

  els.voice.addEventListener('change', () => {
    chrome.storage.local.set({ voice: els.voice.value });
    sendToTab({ type: MSG.SET_VOICE, voice: els.voice.value });
  });

  els.model.addEventListener('change', () => {
    chrome.storage.local.set({ model: els.model.value });
  });

  function openOptions(e) {
    e.preventDefault();
    chrome.runtime.openOptionsPage();
  }
  els.openOptions.addEventListener('click', openOptions);
  els.footerOptions.addEventListener('click', openOptions);

  async function refresh() {
    const state = await sendToTab({ type: MSG.REQUEST_STATE });
    if (state && state.ok) renderState(state.state, state.idx, state.total);
  }

  // Poll a handful of times after starting so the popup catches the
  // loading → playing transition while it's still open.
  function pollRefresh() {
    [400, 1000, 2000, 3500].forEach((ms) => setTimeout(refresh, ms));
  }

  init();
})();
