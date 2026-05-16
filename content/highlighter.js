// Highlighting via the CSS Custom Highlight API. Two highlight registers:
//   - 'sr-sentence' : the sentence currently being read
//   - 'sr-word'     : the word currently being spoken
//
// We rely on the Highlight API because it highlights *without mutating the
// DOM* — essential here, since every sentence/word Range is precomputed
// against the page's DOM up front. Any DOM mutation (e.g. wrapping text in
// <span>s) would invalidate every other precomputed Range. There is therefore
// no span-wrapping fallback: on a browser without the API we degrade to
// audio-only and report it, rather than corrupting the page.
(function () {
  const SR = (window.SR = window.SR || {});

  const SUPPORTS_CSS_HIGHLIGHTS = typeof CSS !== 'undefined' &&
    typeof CSS.highlights !== 'undefined' &&
    typeof Highlight === 'function';

  SR.HIGHLIGHT_SUPPORTED = SUPPORTS_CSS_HIGHLIGHTS;

  class Highlighter {
    constructor() {
      this.supported = SUPPORTS_CSS_HIGHLIGHTS;
      this.sentenceHL = null;
      this.wordHL = null;
      if (this.supported) {
        this.sentenceHL = new Highlight();
        this.wordHL = new Highlight();
        // Registered names are global; re-registering is harmless and keeps
        // us robust if a stale registration lingers from a prior instance.
        CSS.highlights.set('sr-sentence', this.sentenceHL);
        CSS.highlights.set('sr-word', this.wordHL);
      }
    }

    setSentence(range) {
      if (!this.supported || !range) return;
      this.sentenceHL.clear();
      try { this.sentenceHL.add(range); } catch (e) { /* detached range */ }
    }

    setWord(range) {
      if (!this.supported) return;
      this.wordHL.clear();
      if (!range) return;
      try { this.wordHL.add(range); } catch (e) { /* detached range */ }
    }

    clear() {
      if (!this.supported) return;
      this.sentenceHL.clear();
      this.wordHL.clear();
    }

    destroy() {
      this.clear();
      if (this.supported) {
        CSS.highlights.delete('sr-sentence');
        CSS.highlights.delete('sr-word');
      }
    }
  }

  SR.Highlighter = Highlighter;

  // Find the nearest scrollable ancestor of a node (handles articles rendered
  // inside an inner overflow:auto container, not just the document scroller).
  function scrollableAncestor(node) {
    let el = node && node.nodeType === Node.ELEMENT_NODE ? node : (node && node.parentElement);
    while (el && el !== document.body && el !== document.documentElement) {
      const cs = window.getComputedStyle(el);
      const oy = cs.overflowY;
      if ((oy === 'auto' || oy === 'scroll') && el.scrollHeight > el.clientHeight + 1) {
        return el;
      }
      el = el.parentElement;
    }
    return null;
  }

  // Scroll the highlighted range into view if it isn't already comfortably
  // visible. Handles both the document scroller and inner scroll containers.
  SR.scrollRangeIntoView = function scrollRangeIntoView(range, opts = {}) {
    if (!range) return;
    let rect;
    try { rect = range.getBoundingClientRect(); } catch (e) { return; }
    if (!rect || (rect.width === 0 && rect.height === 0)) return;

    const behavior = opts.smooth === false ? 'auto' : 'smooth';
    const container = scrollableAncestor(range.startContainer);

    if (container) {
      const cRect = container.getBoundingClientRect();
      const margin = Math.min(100, cRect.height * 0.2);
      const above = rect.top < cRect.top + margin;
      const below = rect.bottom > cRect.bottom - margin;
      if (!above && !below) return;
      const delta = rect.top - cRect.top - cRect.height * 0.35;
      container.scrollBy({ top: delta, behavior });
      return;
    }

    const viewportH = window.innerHeight || document.documentElement.clientHeight;
    const margin = 100;
    const above = rect.top < margin;
    const below = rect.bottom > viewportH - margin;
    if (!above && !below) return;
    window.scrollTo({
      top: window.scrollY + rect.top - viewportH * 0.35,
      behavior,
    });
  };
})();
