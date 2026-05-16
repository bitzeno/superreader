// Floating in-page control widget. Stays out of the way when reading isn't
// active and never appears unless start() is called.
(function () {
  const SR = (window.SR = window.SR || {});

  class Widget {
    constructor({ onPlayPause, onStop, onPrev, onNext, onRate, onVoice, onClose }) {
      this.handlers = { onPlayPause, onStop, onPrev, onNext, onRate, onVoice, onClose };
      this.el = null;
      this.errorEl = null;
      this.statusEl = null;
      this.playBtn = null;
      this.rateLabel = null;
      this.rateSlider = null;
      this.voiceSelect = null;
      this.state = 'idle'; // idle | playing | paused | loading
      this.idx = -1;
      this.total = 0;
    }

    mount(initial = {}) {
      if (this.el) return;
      const el = document.createElement('div');
      el.id = 'sr-widget';
      el.dir = 'ltr';
      el.innerHTML = `
        <div class="sr-widget-header">
          <span class="sr-widget-title">SuperReader</span>
          <span class="sr-widget-status" data-sr="status">idle</span>
          <button class="sr-widget-close" data-sr="close" aria-label="Close">×</button>
        </div>
        <div class="sr-controls">
          <button class="sr-btn" data-sr="prev" title="Previous sentence">⏮</button>
          <button class="sr-btn sr-btn-primary" data-sr="playpause" title="Play / Pause">▶</button>
          <button class="sr-btn" data-sr="next" title="Next sentence">⏭</button>
          <button class="sr-btn" data-sr="stop" title="Stop">■</button>
        </div>
        <div class="sr-row">
          <label>Speed</label>
          <input class="sr-slider" data-sr="rate" type="range"
                 min="${SR.SPEED_MIN}" max="${SR.SPEED_MAX}" step="0.05"
                 value="${initial.rate || 1.0}">
          <span class="sr-value" data-sr="rateLabel">${(initial.rate || 1.0).toFixed(2)}×</span>
        </div>
        <div class="sr-row">
          <label>Voice</label>
          <select class="sr-select" data-sr="voice">
            ${SR.VOICES.map(v => `<option value="${v.id}" ${v.id === initial.voice ? 'selected' : ''}>${v.label}</option>`).join('')}
          </select>
        </div>
        <div class="sr-error" data-sr="error" style="display:none"></div>
      `;
      document.documentElement.appendChild(el);

      this.el = el;
      this.statusEl = el.querySelector('[data-sr="status"]');
      this.errorEl = el.querySelector('[data-sr="error"]');
      this.playBtn = el.querySelector('[data-sr="playpause"]');
      this.rateLabel = el.querySelector('[data-sr="rateLabel"]');
      this.rateSlider = el.querySelector('[data-sr="rate"]');
      this.voiceSelect = el.querySelector('[data-sr="voice"]');

      el.querySelector('[data-sr="prev"]').addEventListener('click', () => this.handlers.onPrev?.());
      el.querySelector('[data-sr="next"]').addEventListener('click', () => this.handlers.onNext?.());
      el.querySelector('[data-sr="stop"]').addEventListener('click', () => this.handlers.onStop?.());
      el.querySelector('[data-sr="close"]').addEventListener('click', () => this.handlers.onClose?.());
      this.playBtn.addEventListener('click', () => this.handlers.onPlayPause?.());

      this.rateSlider.addEventListener('input', () => {
        const v = parseFloat(this.rateSlider.value);
        this.rateLabel.textContent = v.toFixed(2) + '×';
        this.handlers.onRate?.(v);
      });
      this.voiceSelect.addEventListener('change', () => {
        this.handlers.onVoice?.(this.voiceSelect.value);
      });
    }

    _renderStatus() {
      if (!this.statusEl) return;
      if (this.total > 0 && this.idx >= 0) {
        this.statusEl.textContent = `${this.state} · ${this.idx + 1}/${this.total}`;
      } else {
        this.statusEl.textContent = this.state;
      }
    }

    setState(state) {
      this.state = state;
      this._renderStatus();
      if (this.playBtn) {
        this.playBtn.textContent = state === 'playing' ? '❚❚' : '▶';
        this.playBtn.title = state === 'playing' ? 'Pause' : 'Play';
      }
    }

    setProgress(idx, total) {
      this.idx = idx;
      this.total = total;
      this._renderStatus();
    }

    setRate(rate) {
      if (this.rateSlider) this.rateSlider.value = String(rate);
      if (this.rateLabel) this.rateLabel.textContent = rate.toFixed(2) + '×';
    }

    setVoice(voice) {
      if (this.voiceSelect) this.voiceSelect.value = voice;
    }

    showError(msg) {
      if (!this.errorEl) return;
      this.errorEl.textContent = msg;
      this.errorEl.style.display = msg ? 'block' : 'none';
    }

    hide() {
      if (this.el) this.el.classList.add('sr-hidden');
    }

    show() {
      if (this.el) this.el.classList.remove('sr-hidden');
    }

    destroy() {
      if (this.el && this.el.parentNode) {
        this.el.parentNode.removeChild(this.el);
      }
      this.el = null;
    }
  }

  SR.Widget = Widget;
})();
