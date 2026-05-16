// Shared constants and helpers exposed on window.SR for content scripts.
(function () {
  const SR = (window.SR = window.SR || {});

  SR.VOICES = [
    { id: 'alloy', label: 'Alloy — neutral' },
    { id: 'ash', label: 'Ash — warm' },
    { id: 'ballad', label: 'Ballad — expressive' },
    { id: 'coral', label: 'Coral — bright' },
    { id: 'echo', label: 'Echo — even' },
    { id: 'fable', label: 'Fable — storyteller' },
    { id: 'nova', label: 'Nova — energetic' },
    { id: 'onyx', label: 'Onyx — deep' },
    { id: 'sage', label: 'Sage — calm' },
    { id: 'shimmer', label: 'Shimmer — soft' },
  ];

  SR.MODELS = [
    { id: 'gpt-4o-mini-tts', label: 'gpt-4o-mini-tts (recommended)' },
    { id: 'tts-1', label: 'tts-1 (fast, cheap)' },
    { id: 'tts-1-hd', label: 'tts-1-hd (higher quality)' },
  ];

  SR.DEFAULTS = {
    voice: 'alloy',
    model: 'gpt-4o-mini-tts',
    speed: 1.0,
    autoScroll: true,
    highlightWords: true,
  };

  SR.SPEED_MIN = 0.5;
  SR.SPEED_MAX = 3.0;

  // OpenAI TTS char limit is 4096 — keep a margin.
  SR.MAX_CHUNK_CHARS = 3500;

  // Sentences longer than this are sub-split on clause/word boundaries so each
  // audio clip stays short (snappier start, finer highlight granularity).
  SR.MAX_SENTENCE_CHARS = 1000;

  SR.MSG = {
    START: 'sr/start',
    PAUSE: 'sr/pause',
    RESUME: 'sr/resume',
    STOP: 'sr/stop',
    SKIP_NEXT: 'sr/skipNext',
    SKIP_PREV: 'sr/skipPrev',
    SET_RATE: 'sr/setRate',
    SET_VOICE: 'sr/setVoice',
    STATE: 'sr/state',
    REQUEST_STATE: 'sr/requestState',
    TTS_REQUEST: 'sr/ttsRequest',
    TTS_RESPONSE: 'sr/ttsResponse',
  };

  SR.clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

  SR.debounce = (fn, ms) => {
    let t;
    return (...args) => {
      clearTimeout(t);
      t = setTimeout(() => fn(...args), ms);
    };
  };

  SR.log = (...args) => {
    if (SR._debug) console.log('[SuperReader]', ...args);
  };

  SR.warn = (...args) => console.warn('[SuperReader]', ...args);
  SR.error = (...args) => console.error('[SuperReader]', ...args);
})();
