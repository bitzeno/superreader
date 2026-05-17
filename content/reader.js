// Reading orchestrator: owns the sentence queue, prefetch pipeline, audio
// playback, and synchronized highlighting.
//
// Sync strategy
// -------------
// OpenAI TTS gives us audio with no timing data. We split text into sentences
// and request one audio clip per sentence. While a clip plays, we map
// `audio.currentTime` → word index by the word's character offset within the
// sentence (so the position accounts for spaces and punctuation, not just
// letter counts). This produces a smooth, accurate-enough word follower
// without per-word API calls.
//
// Prefetch
// --------
// While sentence N plays, we eagerly fetch N+1 and N+2 in the background so
// transitions are gapless.
//
// Concurrency
// -----------
// A monotonic generation counter (`_gen`) is bumped on every reset. Async
// continuations (fetch resolutions, audio events, the RAF word loop) capture
// the generation they were started under and bail if it no longer matches —
// this prevents a stopped/restarted session from being driven by stale work.
(function () {
  const SR = (window.SR = window.SR || {});
  const MSG = SR.MSG;

  const PREFETCH_AHEAD = 2;

  class Reader {
    constructor() {
      this.sentences = [];      // [{text, spokenText, range, words}]
      this.idx = 0;
      this.audio = null;
      this.audioCache = new Map();   // idx → { url, blob } | { promise }
      this.highlighter = null;
      this.widget = null;
      this.state = 'idle';      // idle | loading | playing | paused
      this.settings = { ...SR.DEFAULTS };
      this.currentWordIdx = -1;
      this._rafId = null;
      this._gen = 0;
      this._consecutiveErrors = 0;
      this._lastFetchSig = null; // invalidates in-flight when settings change
      this._jumpHandlers = null; // {click, keydown, keyup, blur} for alt-click jump
    }

    // ── lifecycle ──────────────────────────────────────────────────────────
    async start() {
      if (this.state === 'paused') return this.resume();
      // Synchronous re-entrancy guard: set state before the first `await` so a
      // second start() (double-click, shortcut + popup) can't race in.
      if (this.state !== 'idle') return;
      this.state = 'loading';

      try {
        await this._loadSettings();
        if (this.state !== 'loading') return; // stopped while awaiting
        this._ensureWidget();
        this.widget.show();
        this.widget.showError('');
        this.widget.setState('loading');

        if (!this.highlighter.supported) {
          this.widget.showError('Heads up: text highlighting needs a newer browser — playing audio only.');
        }

        const { apiKey } = await chrome.storage.local.get('apiKey');
        // If stop()/destroy() ran while we were awaiting, abandon this start.
        if (this.state !== 'loading') return;
        if (!apiKey) {
          this.widget.showError('OpenAI API key not set. Open the extension options to add one.');
          this.widget.setState('idle');
          this.state = 'idle';
          return;
        }

        const extracted = SR.extract();
        if (!extracted || !extracted.sentences.length) {
          this.widget.showError('Could not find readable text on this page. Try selecting some text first.');
          this.widget.setState('idle');
          this.state = 'idle';
          return;
        }

        this._reset();                 // bumps _gen
        const gen = this._gen;
        this.sentences = extracted.sentences;
        this.idx = 0;
        this._consecutiveErrors = 0;
        this.state = 'playing';
        this.widget.setProgress(this.idx, this.sentences.length);

        this._kickPrefetch();
        await this._playCurrent(gen);
      } catch (e) {
        SR.error('start() failed', e);
        this.widget?.showError(`SuperReader couldn't start: ${e.message || e}`);
        this.widget?.setState('idle');
        this.state = 'idle';
      }
    }

    pause() {
      if (this.state !== 'playing') return;
      this.state = 'paused';
      if (this.audio) this.audio.pause();
      this._stopWordTimer();
      this.widget?.setState('paused');
    }

    resume() {
      if (this.state !== 'paused') return;
      this.state = 'playing';
      this.widget?.setState('playing');
      if (this.audio) {
        this.audio.play().catch(() => {
          this.widget?.showError('Browser blocked audio. Click the page, then press Play.');
        });
        this._startWordTimer(this._gen);
      } else {
        // Paused before audio loaded — restart current sentence.
        this._playCurrent(this._gen);
      }
    }

    togglePlayPause() {
      if (this.state === 'playing') this.pause();
      else if (this.state === 'paused') this.resume();
      else this.start();
    }

    stop() {
      this._reset();
      this.widget?.setState('idle');
      this.widget?.setProgress(-1, 0);
      this.widget?.showError('');
      this.state = 'idle';
      document.documentElement?.classList.remove('sr-jump-mode');
    }

    destroy() {
      this._reset();
      this.state = 'idle';
      this._removeJumpHandlers();
      this.widget?.destroy();
      this.widget = null;
      this.highlighter?.destroy();
      this.highlighter = null;
    }

    skipNext() {
      if (!this.sentences.length) return;
      if (this.idx + 1 >= this.sentences.length) {
        this.stop();
        return;
      }
      this._goto(this.idx + 1);
    }

    skipPrev() {
      if (!this.sentences.length) return;
      this._goto(Math.max(0, this.idx - 1));
    }

    jumpToPoint(x, y) {
      if (!this.sentences.length) return false;
      if (this.state !== 'playing' && this.state !== 'paused') return false;
      const i = this._findSentenceAtPoint(x, y);
      if (i < 0 || i === this.idx) return false;
      const wasPaused = this.state === 'paused';
      this._goto(i).then(() => {
        if (wasPaused) this.pause();
      });
      return true;
    }

    setRate(rate) {
      this.settings.speed = SR.clamp(rate, SR.SPEED_MIN, SR.SPEED_MAX);
      if (this.audio) this.audio.playbackRate = this.settings.speed;
      this._saveSettings();
      this.widget?.setRate(this.settings.speed);
    }

    setVoice(voice) {
      if (voice === this.settings.voice) return;
      this.settings.voice = voice;
      this._saveSettings();
      this._invalidateCache();          // cached audio used the old voice
      this.widget?.setVoice(voice);
      if (this.state === 'playing' || this.state === 'paused') {
        const wasPaused = this.state === 'paused';
        this._goto(this.idx).then(() => {
          if (wasPaused) this.pause();
        });
      }
    }

    // ── internals ──────────────────────────────────────────────────────────
    _ensureWidget() {
      if (this.widget) return;
      this.highlighter = new SR.Highlighter();
      this.widget = new SR.Widget({
        onPlayPause: () => this.togglePlayPause(),
        onStop: () => this.stop(),
        onPrev: () => this.skipPrev(),
        onNext: () => this.skipNext(),
        onRate: (r) => this.setRate(r),
        onVoice: (v) => this.setVoice(v),
        onClose: () => this.destroy(),
      });
      this.widget.mount({ rate: this.settings.speed, voice: this.settings.voice });
      this._installJumpHandlers();
    }

    // Alt-click anywhere on a sentence to restart reading from there.
    // Plain click is left alone so links, buttons, and text selection still work.
    _installJumpHandlers() {
      if (this._jumpHandlers) return;

      const setJumpMode = (on) => {
        const root = document.documentElement;
        if (!root) return;
        if (on && (this.state === 'playing' || this.state === 'paused')) {
          root.classList.add('sr-jump-mode');
        } else {
          root.classList.remove('sr-jump-mode');
        }
      };

      const onKeyDown = (e) => { if (e.altKey) setJumpMode(true); };
      const onKeyUp = (e) => { if (!e.altKey) setJumpMode(false); };
      const onBlur = () => setJumpMode(false);

      const onClick = (e) => {
        if (!e.altKey) return;
        // Don't hijack clicks on our own widget.
        if (e.target && e.target.closest && e.target.closest('#sr-widget')) return;
        if (this.jumpToPoint(e.clientX, e.clientY)) {
          // Prevent the alt-click from also activating a link/button underneath.
          e.preventDefault();
          e.stopPropagation();
        }
      };

      // Capture phase so we beat page handlers (and pages that stopPropagation).
      window.addEventListener('keydown', onKeyDown, true);
      window.addEventListener('keyup', onKeyUp, true);
      window.addEventListener('blur', onBlur);
      document.addEventListener('click', onClick, true);

      this._jumpHandlers = { onKeyDown, onKeyUp, onBlur, onClick };
    }

    _removeJumpHandlers() {
      const h = this._jumpHandlers;
      if (!h) return;
      window.removeEventListener('keydown', h.onKeyDown, true);
      window.removeEventListener('keyup', h.onKeyUp, true);
      window.removeEventListener('blur', h.onBlur);
      document.removeEventListener('click', h.onClick, true);
      document.documentElement?.classList.remove('sr-jump-mode');
      this._jumpHandlers = null;
    }

    // Map a viewport point to a sentence index by asking the browser for the
    // caret position under the point, then finding which sentence range
    // contains that (node, offset) pair.
    _findSentenceAtPoint(x, y) {
      let node = null, offset = 0;
      if (document.caretPositionFromPoint) {
        const p = document.caretPositionFromPoint(x, y);
        if (p) { node = p.offsetNode; offset = p.offset; }
      } else if (document.caretRangeFromPoint) {
        const r = document.caretRangeFromPoint(x, y);
        if (r) { node = r.startContainer; offset = r.startOffset; }
      }
      if (!node) return -1;
      for (let i = 0; i < this.sentences.length; i++) {
        const r = this.sentences[i].range;
        if (!r) continue;
        try {
          if (r.comparePoint(node, offset) === 0) return i;
        } catch (e) { /* point not comparable to this range */ }
      }
      return -1;
    }

    async _loadSettings() {
      const stored = await chrome.storage.local.get(['speed', 'voice', 'model', 'autoScroll', 'highlightWords']);
      this.settings = {
        ...SR.DEFAULTS,
        ...Object.fromEntries(Object.entries(stored).filter(([_, v]) => v !== undefined)),
      };
    }

    _saveSettings() {
      chrome.storage.local.set({
        speed: this.settings.speed,
        voice: this.settings.voice,
        model: this.settings.model,
        autoScroll: this.settings.autoScroll,
        highlightWords: this.settings.highlightWords,
      });
    }

    // Tear down all playback state and invalidate in-flight async work.
    _reset() {
      this._gen++;
      this._stopWordTimer();
      if (this.audio) {
        try { this.audio.pause(); } catch (e) {}
        this.audio.src = '';
        this.audio = null;
      }
      this._invalidateCache();
      if (this.highlighter) this.highlighter.clear();
      this.sentences = [];
      this.idx = 0;
      this.currentWordIdx = -1;
    }

    _invalidateCache() {
      for (const entry of this.audioCache.values()) {
        if (entry.url) URL.revokeObjectURL(entry.url);
      }
      this.audioCache.clear();
    }

    // Revoke blob URLs for sentences we've moved well past, so a long article
    // doesn't accumulate every clip in memory. Keep idx-1 so skipPrev is snappy.
    _evictPlayedAudio(idx) {
      for (const [key, entry] of this.audioCache) {
        if (key < idx - 1) {
          if (entry.url) URL.revokeObjectURL(entry.url);
          this.audioCache.delete(key);
        }
      }
    }

    async _goto(idx) {
      const gen = this._gen;
      this._stopWordTimer();
      if (this.audio) {
        try { this.audio.pause(); } catch (e) {}
      }
      this.idx = idx;
      this.currentWordIdx = -1;
      this.state = 'playing';
      this.widget?.setState('loading');
      this.widget?.setProgress(this.idx, this.sentences.length);
      this._kickPrefetch();
      await this._playCurrent(gen);
    }

    async _playCurrent(gen) {
      if (this._gen !== gen) return;
      const idx = this.idx;
      const sentence = this.sentences[idx];
      if (!sentence) {
        this.stop();
        return;
      }

      // Highlight the sentence immediately (before audio loads) so the user
      // sees where we're about to read.
      this.highlighter.setSentence(sentence.range);
      this.highlighter.setWord(null);
      this.currentWordIdx = -1;
      if (this.settings.autoScroll !== false) {
        SR.scrollRangeIntoView(sentence.range);
      }
      this.widget?.setProgress(idx, this.sentences.length);

      let audioUrl;
      try {
        audioUrl = await this._fetchAudio(idx);
      } catch (e) {
        if (this._gen !== gen || this.idx !== idx) return;
        SR.error('TTS fetch failed', e);
        this._consecutiveErrors++;
        // A run of failures means something systemic (bad key, quota, offline)
        // — surface it and stop. A lone failure is treated as a skippable
        // sentence so one hiccup doesn't end the whole session.
        if (this._consecutiveErrors >= 3 || this.idx + 1 >= this.sentences.length) {
          this.widget?.showError(`TTS error: ${e.message || e}`);
          this.widget?.setState('idle');
          this.state = 'idle';
          return;
        }
        this.widget?.showError(`Skipped a sentence (${e.message || e})`);
        this.idx += 1;
        this.currentWordIdx = -1;
        this.widget?.setProgress(this.idx, this.sentences.length);
        this._kickPrefetch();
        return this._playCurrent(gen);
      }
      if (this._gen !== gen || this.idx !== idx) return;
      this._consecutiveErrors = 0;
      this._evictPlayedAudio(idx);

      this.widget?.showError('');
      this.widget?.setState('playing');
      this.state = 'playing';

      const audio = new Audio();
      audio.preload = 'auto';
      audio.src = audioUrl;
      audio.playbackRate = this.settings.speed;
      this.audio = audio;

      audio.addEventListener('ended', () => {
        if (this._gen !== gen || this.audio !== audio) return;
        this.highlighter.setWord(null);
        if (this.idx + 1 >= this.sentences.length) {
          this.stop();
          return;
        }
        this.idx += 1;
        this.currentWordIdx = -1;
        this.widget?.setProgress(this.idx, this.sentences.length);
        this._kickPrefetch();
        this._playCurrent(gen);
      });

      audio.addEventListener('error', () => {
        if (this._gen !== gen || this.audio !== audio) return;
        SR.warn('Audio playback error, skipping sentence', audio.error);
        this.highlighter.setWord(null);
        if (this.idx + 1 >= this.sentences.length) {
          this.stop();
        } else {
          this.idx += 1;
          this.currentWordIdx = -1;
          this.widget?.setProgress(this.idx, this.sentences.length);
          this._kickPrefetch();
          this._playCurrent(gen);
        }
      });

      try {
        await audio.play();
      } catch (e) {
        if (this._gen !== gen || this.audio !== audio) return;
        SR.warn('audio.play() rejected', e);
        // Almost always the autoplay policy: there was no user gesture in the
        // page. The in-page widget's Play button *is* a page gesture, so the
        // user can recover by pressing it.
        this.widget?.showError('Browser blocked autoplay — press Play on this widget to start.');
        this.state = 'paused';
        this.widget?.setState('paused');
        return;
      }

      this._startWordTimer(gen);
    }

    // ── word follower (RAF loop) ──────────────────────────────────────────
    _startWordTimer(gen) {
      this._stopWordTimer();
      if (!this.settings.highlightWords) return;
      const tick = () => {
        if (this._gen !== gen || !this.audio || this.audio.paused) {
          this._rafId = null;
          return;
        }
        this._updateWordHighlight();
        this._rafId = requestAnimationFrame(tick);
      };
      this._rafId = requestAnimationFrame(tick);
    }

    _stopWordTimer() {
      if (this._rafId) cancelAnimationFrame(this._rafId);
      this._rafId = null;
    }

    // Pick the word whose character offset within the sentence matches the
    // current playback fraction. Approximate, but reads as "tracking" to a
    // viewer — and offset-based anchoring accounts for the time spent on
    // spaces and punctuation between words.
    _updateWordHighlight() {
      const sentence = this.sentences[this.idx];
      if (!sentence || !sentence.words.length || !this.audio) return;
      const dur = this.audio.duration;
      if (!isFinite(dur) || dur <= 0) return;
      const t = SR.clamp(this.audio.currentTime / dur, 0, 1);

      const span = Math.max(1, sentence.end - sentence.start);
      let pickedIdx = 0;
      for (let i = 0; i < sentence.words.length; i++) {
        const anchor = (sentence.words[i].start - sentence.start) / span;
        if (anchor <= t) pickedIdx = i;
        else break;
      }
      if (pickedIdx === this.currentWordIdx) return;
      this.currentWordIdx = pickedIdx;
      const word = sentence.words[pickedIdx];
      if (word && word.range) this.highlighter.setWord(word.range);
    }

    // ── prefetch pipeline ─────────────────────────────────────────────────
    _kickPrefetch() {
      for (let i = 1; i <= PREFETCH_AHEAD; i++) {
        const j = this.idx + i;
        if (j < this.sentences.length) this._fetchAudio(j).catch(() => {});
      }
    }

    _fetchAudio(idx) {
      const cached = this.audioCache.get(idx);
      if (cached) {
        if (cached.promise) return cached.promise;
        return Promise.resolve(cached.url);
      }
      const sentence = this.sentences[idx];
      if (!sentence) return Promise.reject(new Error('No such sentence'));
      const text = sentence.spokenText || sentence.text;
      if (!text || !text.trim()) return Promise.reject(new Error('Empty text'));

      const sig = `${this.settings.voice}|${this.settings.model}`;
      this._lastFetchSig = sig;

      const promise = (async () => {
        const resp = await chrome.runtime.sendMessage({
          type: MSG.TTS_REQUEST,
          text,
          voice: this.settings.voice,
          model: this.settings.model,
        });
        if (!resp || !resp.ok) {
          throw new Error(resp?.error || 'TTS request failed');
        }
        const bytes = base64ToBytes(resp.audio);
        const blob = new Blob([bytes], { type: resp.mime || 'audio/mpeg' });
        const url = URL.createObjectURL(blob);
        // If voice/model changed mid-flight, this audio is stale.
        if (this._lastFetchSig !== sig) {
          URL.revokeObjectURL(url);
          throw new Error('settings changed');
        }
        this.audioCache.set(idx, { url, blob });
        return url;
      })();

      this.audioCache.set(idx, { promise });
      promise.catch(() => {
        // Only delete if this rejected promise is still the cached entry.
        const e = this.audioCache.get(idx);
        if (e && e.promise === promise) this.audioCache.delete(idx);
      });
      return promise;
    }
  }

  function base64ToBytes(b64) {
    const bin = atob(b64);
    const len = bin.length;
    const out = new Uint8Array(len);
    for (let i = 0; i < len; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  SR.Reader = Reader;
})();
