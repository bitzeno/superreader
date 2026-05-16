// Content script entry point. Hosts a single Reader instance per page and
// routes messages from the popup / background to it.
(function () {
  // Guard against double-injection: the manifest declares this script for all
  // pages, but the service worker may also inject it via chrome.scripting on
  // pages that predate the extension. Running twice would register duplicate
  // message listeners.
  if (window.__superReaderLoaded) return;
  window.__superReaderLoaded = true;

  const SR = window.SR;
  const MSG = SR.MSG;

  // Lazily construct a Reader so pages we never read on don't pay the cost.
  let reader = null;
  function getReader() {
    if (!reader) reader = new SR.Reader();
    return reader;
  }

  // ── SPA navigation handling ────────────────────────────────────────────
  // Many SPAs swap content without a full reload. If the URL changes while
  // we're reading, the precomputed Ranges no longer match the page, so we
  // stop. The observer only runs *while reading* — we don't want a permanent
  // MutationObserver on every page the extension is loaded into.
  let lastUrl = location.href;
  let urlObserver = null;

  function startUrlWatch() {
    if (urlObserver) return;
    lastUrl = location.href;
    urlObserver = new MutationObserver(SR.debounce(() => {
      if (location.href !== lastUrl) {
        lastUrl = location.href;
        if (reader && (reader.state === 'playing' || reader.state === 'paused' || reader.state === 'loading')) {
          reader.stop();
        }
      }
      // Self-disconnect once reading has finished.
      if (!reader || reader.state === 'idle') stopUrlWatch();
    }, 400));
    const target = document.body || document.documentElement;
    if (target) urlObserver.observe(target, { subtree: true, childList: true });
  }

  function stopUrlWatch() {
    if (urlObserver) {
      urlObserver.disconnect();
      urlObserver = null;
    }
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || typeof msg !== 'object') return false;
    const r = getReader();
    switch (msg.type) {
      case MSG.START:
        r.start();
        startUrlWatch();
        sendResponse({ ok: true });
        return true;
      case MSG.PAUSE:
        r.pause();
        sendResponse({ ok: true, state: r.state });
        return true;
      case MSG.RESUME:
        r.resume();
        sendResponse({ ok: true, state: r.state });
        return true;
      case MSG.STOP:
        r.stop();
        stopUrlWatch();
        sendResponse({ ok: true, state: r.state });
        return true;
      case MSG.SKIP_NEXT:
        r.skipNext();
        sendResponse({ ok: true });
        return true;
      case MSG.SKIP_PREV:
        r.skipPrev();
        sendResponse({ ok: true });
        return true;
      case MSG.SET_RATE:
        r.setRate(msg.rate);
        sendResponse({ ok: true, rate: r.settings.speed });
        return true;
      case MSG.SET_VOICE:
        r.setVoice(msg.voice);
        sendResponse({ ok: true, voice: r.settings.voice });
        return true;
      case MSG.REQUEST_STATE:
        sendResponse({
          ok: true,
          state: r.state,
          idx: r.idx,
          total: r.sentences.length,
          settings: r.settings,
        });
        return true;
      default:
        return false;
    }
  });

  // Clean up highlights / widget when the page is unloaded or bfcached.
  window.addEventListener('pagehide', () => {
    stopUrlWatch();
    if (reader) {
      reader.destroy();
      reader = null;
    }
  });
})();
