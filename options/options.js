// Options page: API key management + default settings.
(function () {
  const SR = window.SR;
  const $ = (id) => document.getElementById(id);

  const els = {
    apiKey: $('apiKey'),
    toggleKey: $('toggleKey'),
    testKey: $('testKey'),
    voice: $('voice'),
    model: $('model'),
    speed: $('speed'),
    speedVal: $('speedVal'),
    autoScroll: $('autoScroll'),
    highlightWords: $('highlightWords'),
    status: $('status'),
  };

  els.voice.innerHTML = SR.VOICES.map(v => `<option value="${v.id}">${v.label}</option>`).join('');
  els.model.innerHTML = SR.MODELS.map(m => `<option value="${m.id}">${m.label}</option>`).join('');

  function setStatus(text, kind) {
    els.status.textContent = text || '';
    els.status.className = kind || '';
  }

  // ── load ───────────────────────────────────────────────────────────────
  async function load() {
    const s = await chrome.storage.local.get([
      'apiKey', 'voice', 'model', 'speed', 'autoScroll', 'highlightWords',
    ]);
    if (s.apiKey) els.apiKey.value = s.apiKey;
    els.voice.value = s.voice || SR.DEFAULTS.voice;
    els.model.value = s.model || SR.DEFAULTS.model;
    const speed = s.speed != null ? s.speed : SR.DEFAULTS.speed;
    els.speed.value = speed;
    els.speedVal.textContent = Number(speed).toFixed(2) + '×';
    els.autoScroll.checked = s.autoScroll != null ? s.autoScroll : SR.DEFAULTS.autoScroll;
    els.highlightWords.checked = s.highlightWords != null ? s.highlightWords : SR.DEFAULTS.highlightWords;
  }

  // ── persist defaults on change ─────────────────────────────────────────
  els.voice.addEventListener('change', () => chrome.storage.local.set({ voice: els.voice.value }));
  els.model.addEventListener('change', () => chrome.storage.local.set({ model: els.model.value }));
  els.speed.addEventListener('input', () => {
    els.speedVal.textContent = Number(els.speed.value).toFixed(2) + '×';
    chrome.storage.local.set({ speed: parseFloat(els.speed.value) });
  });
  els.autoScroll.addEventListener('change', () => chrome.storage.local.set({ autoScroll: els.autoScroll.checked }));
  els.highlightWords.addEventListener('change', () => chrome.storage.local.set({ highlightWords: els.highlightWords.checked }));

  // ── key visibility toggle ──────────────────────────────────────────────
  els.toggleKey.addEventListener('click', () => {
    const showing = els.apiKey.type === 'text';
    els.apiKey.type = showing ? 'password' : 'text';
    els.toggleKey.textContent = showing ? 'Show' : 'Hide';
  });

  // ── test + save key ────────────────────────────────────────────────────
  els.testKey.addEventListener('click', async () => {
    const key = els.apiKey.value.trim();
    if (!key) {
      setStatus('Enter a key first.', 'err');
      return;
    }
    if (!/^sk-/.test(key)) {
      setStatus('That does not look like an OpenAI key (should start with "sk-").', 'err');
      return;
    }
    setStatus('Testing key…', '');
    els.testKey.disabled = true;
    try {
      const resp = await fetch('https://api.openai.com/v1/audio/speech', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${key}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: els.model.value || 'gpt-4o-mini-tts',
          voice: els.voice.value || 'alloy',
          input: 'SuperReader is ready.',
          response_format: 'mp3',
        }),
      });
      if (resp.ok) {
        await chrome.storage.local.set({ apiKey: key });
        setStatus('Key works and was saved. ✓', 'ok');
      } else {
        let detail = `HTTP ${resp.status}`;
        try {
          const j = await resp.json();
          detail = j?.error?.message || detail;
        } catch (e) {}
        setStatus(`Key test failed: ${detail}`, 'err');
      }
    } catch (e) {
      setStatus(`Network error: ${e.message || e}`, 'err');
    } finally {
      els.testKey.disabled = false;
    }
  });

  load();
})();
