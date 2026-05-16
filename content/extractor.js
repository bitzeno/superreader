// Article extraction + sentence/word segmentation that produces live DOM Ranges.
// We deliberately do NOT mutate the page — we walk text nodes and remember
// (textNode, offset) pairs. The reader then turns those into Range objects
// for the CSS Custom Highlight API.
(function () {
  const SR = (window.SR = window.SR || {});

  // Tags whose textual content is junk for reading: scripts, code, UI chrome, etc.
  const SKIP_TAGS = new Set([
    'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'IFRAME', 'OBJECT', 'EMBED',
    'CANVAS', 'SVG', 'MATH', 'AUDIO', 'VIDEO', 'PICTURE', 'SOURCE', 'TRACK',
    'INPUT', 'TEXTAREA', 'SELECT', 'OPTION', 'BUTTON',
    'CODE', 'PRE', 'KBD', 'SAMP', 'VAR',
    'NAV', 'ASIDE', 'HEADER', 'FOOTER', 'FORM', 'DIALOG',
    'FIGCAPTION',
  ]);

  // Attribute / class hints that indicate non-content regions.
  const SKIP_SELECTOR = [
    '[aria-hidden="true"]',
    '[role="navigation"]', '[role="banner"]', '[role="complementary"]',
    '[role="contentinfo"]', '[role="dialog"]', '[role="alert"]',
    '[hidden]',
    '.sr-only', '.visually-hidden', '.screen-reader-only',
    '.ad', '.ads', '.advert', '.advertisement', '[id*="advert" i]', '[class*="advert" i]',
    '[id*="comment" i][class*="list" i]', '.comments',
    '.share', '.social', '.social-share',
    '.cookie', '.cookie-banner', '.gdpr',
    '.related', '.related-posts', '.recommended',
    '.newsletter', '.subscribe',
    '.nav', '.menu', '.sidebar', '.toolbar', '.breadcrumb',
  ].join(',');

  // ── Computed-style cache ──────────────────────────────────────────────────
  // getComputedStyle forces a style recalc; the walker would otherwise call it
  // once per element AND per ancestor chain. We memoize for the lifetime of a
  // single extract() pass (the DOM doesn't change underneath us mid-pass).
  let csCache = null;
  function getCS(el) {
    if (!csCache) return window.getComputedStyle(el);
    let cs = csCache.get(el);
    if (!cs) {
      cs = window.getComputedStyle(el);
      csCache.set(el, cs);
    }
    return cs;
  }

  // ── Content root selection ────────────────────────────────────────────────
  function isHidden(el) {
    if (!el || !(el instanceof Element)) return false;
    const cs = getCS(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') return true;
    if (parseFloat(cs.opacity) === 0) return true;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0 && el.offsetParent === null) {
      return true; // not laid out at all
    }
    return false;
  }

  function shouldSkipElement(el) {
    if (!(el instanceof Element)) return false;
    if (SKIP_TAGS.has(el.tagName)) return true;
    if (el.id === 'sr-widget' || el.closest('#sr-widget')) return true; // our own UI
    if (el.matches && el.matches(SKIP_SELECTOR)) return true;
    if (el.closest && el.closest('[contenteditable="true"]')) return true;
    if (isHidden(el)) return true;
    return false;
  }

  function textDensityScore(el) {
    if (!el) return 0;
    const text = el.innerText || '';
    if (text.length < 100) return 0;
    let linkText = 0;
    el.querySelectorAll('a').forEach((a) => { linkText += (a.innerText || '').length; });
    const linkDensity = linkText / Math.max(1, text.length);
    if (linkDensity > 0.5) return 0; // probably a list of links / nav
    const pCount = el.querySelectorAll('p').length;
    const paragraphBoost = Math.min(20, pCount) * 50;
    const lengthBoost = Math.sqrt(text.length);
    return lengthBoost + paragraphBoost - linkText * 0.5;
  }

  function findContentRoot(doc = document) {
    // 1. Honor explicit semantic roots.
    const candidates = [
      doc.querySelector('article'),
      doc.querySelector('main'),
      doc.querySelector('[role="main"]'),
      doc.querySelector('[itemprop="articleBody"]'),
      doc.querySelector('.post-content, .article-content, .entry-content, .article-body, .post-body'),
    ].filter(Boolean);

    const all = new Set(candidates);
    // Also consider divs/sections under body. Use textContent (no reflow) for
    // the cheap pre-filter; innerText (which reflows) is only used later in
    // textDensityScore on the small surviving candidate set.
    if (doc.body) {
      const possibles = doc.body.querySelectorAll('div, section');
      let count = 0;
      for (const el of possibles) {
        if (count++ > 400) break; // bound work on pathologically large pages
        if (shouldSkipElement(el)) continue;
        if ((el.textContent || '').length < 500) continue;
        all.add(el);
      }
    }

    let best = null;
    let bestScore = 0;
    for (const el of all) {
      if (shouldSkipElement(el)) continue;
      const score = textDensityScore(el);
      if (score > bestScore) {
        bestScore = score;
        best = el;
      }
    }
    return best || doc.body;
  }

  // ── Text node walking ─────────────────────────────────────────────────────
  // Walk a subtree; produce an array of {node, start, end} index entries and
  // the concatenated text. start/end are offsets into the concatenated text.
  function collectTextNodes(root) {
    const nodes = [];
    let buffer = '';

    const walker = document.createTreeWalker(
      root,
      NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT,
      {
        acceptNode(n) {
          if (n.nodeType === Node.ELEMENT_NODE) {
            return shouldSkipElement(n) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_SKIP;
          }
          // Text node. Its element parent already passed the walker's element
          // filter (rejected subtrees are never descended into), so no need to
          // re-run shouldSkipElement here.
          if (!/\S/.test(n.nodeValue || '')) return NodeFilter.FILTER_REJECT;
          return NodeFilter.FILTER_ACCEPT;
        },
      }
    );

    let node;
    let prevBlock = null;
    while ((node = walker.nextNode())) {
      const raw = node.nodeValue || '';
      // Insert a sentence boundary when text crosses into a new block-level
      // ancestor, so segmentation doesn't bleed across paragraphs/headings.
      const blockAncestor = nearestBlock(node);
      const needsBoundary = blockAncestor !== prevBlock;
      prevBlock = blockAncestor;

      if (needsBoundary && buffer.length > 0 && !buffer.endsWith('\n')) {
        const last = buffer[buffer.length - 1];
        if (!/[.!?…。！？]/.test(last)) buffer += '.';
        buffer += '\n';
      }

      const start = buffer.length;
      buffer += raw;
      const end = buffer.length;
      nodes.push({ node, start, end });
    }

    return { text: buffer, nodes };
  }

  const BLOCK_DISPLAYS = new Set([
    'block', 'flex', 'grid', 'list-item', 'table', 'table-row',
    'table-cell', 'flow-root',
  ]);

  function nearestBlock(node) {
    let el = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
    while (el && el !== document.body) {
      if (BLOCK_DISPLAYS.has(getCS(el).display)) return el;
      el = el.parentElement;
    }
    return el || document.body;
  }

  // ── Sentence + word segmentation ──────────────────────────────────────────
  function segment(text, granularity = 'sentence') {
    // Use Intl.Segmenter when available (locale-aware; great for ja/zh too).
    if (typeof Intl !== 'undefined' && Intl.Segmenter) {
      try {
        const seg = new Intl.Segmenter(navigator.language || 'en', { granularity });
        const out = [];
        for (const s of seg.segment(text)) {
          out.push({ start: s.index, end: s.index + s.segment.length, text: s.segment });
        }
        return out;
      } catch (e) {
        // fall through to regex
      }
    }
    if (granularity === 'word') {
      const out = [];
      const re = /\S+/g;
      let m;
      while ((m = re.exec(text))) {
        out.push({ start: m.index, end: m.index + m[0].length, text: m[0] });
      }
      return out;
    }
    // Sentence regex fallback
    const out = [];
    const re = /[^.!?…。！？\n]+[.!?…。！？]+["')\]]*|\S[^.!?…。！？\n]*$/g;
    let m;
    while ((m = re.exec(text))) {
      out.push({ start: m.index, end: m.index + m[0].length, text: m[0] });
    }
    return out;
  }

  // Split an over-long [start,end) span into chunks <= maxLen. Prefers clause
  // boundaries (, ; : — ) then whitespace then a hard cut, so each TTS clip
  // stays short. Returns an array of {start, end} (offsets into `text`).
  function splitLongSpan(text, start, end, maxLen) {
    if (end - start <= maxLen) return [{ start, end }];
    const out = [];
    let cur = start;
    while (end - cur > maxLen) {
      const windowEnd = cur + maxLen;
      // Look for the last clause break, then the last whitespace, in-window.
      let cut = -1;
      for (let i = windowEnd; i > cur + Math.floor(maxLen / 3); i--) {
        const ch = text[i];
        if (ch === ',' || ch === ';' || ch === ':' || ch === '—' || ch === '–') {
          cut = i + 1;
          break;
        }
      }
      if (cut < 0) {
        for (let i = windowEnd; i > cur + Math.floor(maxLen / 3); i--) {
          if (/\s/.test(text[i])) { cut = i + 1; break; }
        }
      }
      if (cut < 0) cut = windowEnd; // no boundary found — hard cut
      out.push({ start: cur, end: cut });
      cur = cut;
    }
    if (cur < end) out.push({ start: cur, end });
    return out;
  }

  // ── Selection-based extraction ────────────────────────────────────────────
  // Extract from a Range by collecting contained text nodes in original DOM.
  function collectFromRange(range) {
    const nodes = [];
    let buffer = '';
    const walker = document.createTreeWalker(
      range.commonAncestorContainer,
      NodeFilter.SHOW_TEXT,
      {
        acceptNode(n) {
          if (!range.intersectsNode(n)) return NodeFilter.FILTER_REJECT;
          const parent = n.parentElement;
          if (!parent || shouldSkipElement(parent)) return NodeFilter.FILTER_REJECT;
          if (!/\S/.test(n.nodeValue || '')) return NodeFilter.FILTER_REJECT;
          return NodeFilter.FILTER_ACCEPT;
        },
      }
    );
    let n;
    while ((n = walker.nextNode())) {
      const raw = n.nodeValue || '';
      // Clip to the selection bounds for the first/last node.
      let from = 0, to = raw.length;
      if (n === range.startContainer) from = range.startOffset;
      if (n === range.endContainer) to = range.endOffset;
      if (from >= to) continue;
      // `_shift` records the offset within the live node that buffer position
      // `entry.start` corresponds to, so range building stays accurate.
      const start = buffer.length;
      buffer += raw.slice(from, to);
      const end = buffer.length;
      nodes.push({ node: n, start, end, _shift: from });
    }
    return { text: buffer, nodes };
  }

  // ── Public API ────────────────────────────────────────────────────────────
  SR.extract = function extract() {
    csCache = new Map();
    try {
      return doExtract();
    } finally {
      csCache = null; // release cached CSSStyleDeclaration refs
    }
  };

  function doExtract() {
    // Prefer user selection if substantive.
    const sel = window.getSelection();
    let collected;
    let source = 'article';
    if (sel && sel.rangeCount > 0 && !sel.isCollapsed && sel.toString().trim().length > 20) {
      collected = collectFromRange(sel.getRangeAt(0));
      source = 'selection';
    } else {
      collected = collectTextNodes(findContentRoot(document));
    }

    if (!collected.text || collected.text.replace(/\s+/g, '').length < 20) {
      return null;
    }

    const maxLen = SR.MAX_SENTENCE_CHARS || 1000;

    // Segment into sentences, then sub-split any that are too long.
    const spans = [];
    for (const s of segment(collected.text, 'sentence')) {
      let start = s.start;
      let end = s.end;
      // Trim leading/trailing whitespace from the span.
      while (start < end && /\s/.test(collected.text[start])) start++;
      while (end > start && /\s/.test(collected.text[end - 1])) end--;
      if (end - start < 1) continue;
      for (const sub of splitLongSpan(collected.text, start, end, maxLen)) {
        // Re-trim sub-span edges (clause cuts can land on whitespace).
        let ss = sub.start, se = sub.end;
        while (ss < se && /\s/.test(collected.text[ss])) ss++;
        while (se > ss && /\s/.test(collected.text[se - 1])) se--;
        if (se > ss) spans.push({ start: ss, end: se });
      }
    }

    const sentences = [];
    for (const span of spans) {
      const { start, end } = span;
      const sentenceText = collected.text.slice(start, end);
      const spokenText = cleanForSpeech(sentenceText);
      // A span that cleans to nothing (URL-only, punctuation-only, emoji-only)
      // is skipped — never spoken — so it can't stall the reader.
      if (!spokenText) continue;

      const range = buildRangeFromCollected(collected.nodes, start, end);
      if (!range) continue;

      const rawWords = segment(sentenceText, 'word').filter(w => /\p{L}|\p{N}/u.test(w.text));
      const words = rawWords.map(w => {
        const ws = start + w.start;
        const we = start + w.end;
        return { text: w.text, start: ws, end: we, range: buildRangeFromCollected(collected.nodes, ws, we) };
      }).filter(w => w.range);

      sentences.push({ text: sentenceText, spokenText, start, end, range, words });
    }

    if (!sentences.length) return null;
    return { source, sentences, fullText: collected.text };
  }

  // Range builder that understands the `_shift` field used by selection mode.
  function buildRangeFromCollected(nodes, textStart, textEnd) {
    if (textStart >= textEnd) return null;
    let startNode = null, startOffset = 0;
    let endNode = null, endOffset = 0;

    for (let i = 0; i < nodes.length; i++) {
      const entry = nodes[i];
      const shift = entry._shift || 0;
      if (startNode === null && textStart >= entry.start && textStart < entry.end) {
        startNode = entry.node;
        startOffset = (textStart - entry.start) + shift;
      }
      if (textEnd > entry.start && textEnd <= entry.end) {
        endNode = entry.node;
        endOffset = (textEnd - entry.start) + shift;
        break;
      }
    }

    if (!startNode) return null;
    if (!endNode) {
      // textEnd landed past the last node or inside a synthesized boundary
      // gap — clamp to the end of the last entry that starts before textEnd.
      for (let i = nodes.length - 1; i >= 0; i--) {
        if (nodes[i].start < textEnd) {
          endNode = nodes[i].node;
          endOffset = Math.min((nodes[i].node.nodeValue || '').length,
                                textEnd - nodes[i].start + (nodes[i]._shift || 0));
          break;
        }
      }
    }
    if (!endNode) return null;

    try {
      const r = document.createRange();
      const sLen = (startNode.nodeValue || '').length;
      const eLen = (endNode.nodeValue || '').length;
      r.setStart(startNode, Math.max(0, Math.min(startOffset, sLen)));
      r.setEnd(endNode, Math.max(0, Math.min(endOffset, eLen)));
      if (r.collapsed) return null; // degenerate — nothing to highlight
      return r;
    } catch (e) {
      return null;
    }
  }

  // Make text more pleasant for TTS: collapse whitespace, drop bare URLs that
  // the model reads awkwardly.
  function cleanForSpeech(text) {
    let t = text.replace(/\s+/g, ' ').trim();
    t = t.replace(/\bhttps?:\/\/\S+/g, '');
    t = t.replace(/\s{2,}/g, ' ').trim();
    return t;
  }

  SR.extractor = {
    findContentRoot,
    collectTextNodes,
    collectFromRange,
    segment,
    splitLongSpan,
    cleanForSpeech,
  };
})();
