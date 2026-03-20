(function() {
  'use strict';

  // Guard against double-injection
  if (window.__captureEngineInjected) return;
  window.__captureEngineInjected = true;

  // State for hidden sticky elements
  let hiddenElements = [];

  // State for unrolled scroll containers
  let savedScrollContainerStyles = [];

  // --- Scroll Container Detection & Unrolling ---

  function findScrollContainers() {
    var containers = [];
    var viewportWidth = window.innerWidth;
    var all = document.querySelectorAll('*');

    for (var i = 0; i < all.length; i++) {
      var el = all[i];
      if (el === document.documentElement || el === document.body) continue;

      var style = window.getComputedStyle(el);
      var overflowY = style.overflowY;

      if (overflowY !== 'auto' && overflowY !== 'scroll') continue;

      var scrollableAmount = el.scrollHeight - el.clientHeight;
      if (scrollableAmount <= 5) continue;

      var rect = el.getBoundingClientRect();
      // Skip narrow elements (sidebars, small scroll areas)
      if (rect.width < viewportWidth * 0.3) continue;

      containers.push({ el: el, scrollableAmount: scrollableAmount });
    }

    // Largest scrollable area first
    containers.sort(function(a, b) { return b.scrollableAmount - a.scrollableAmount; });
    return containers.map(function(c) { return c.el; });
  }

  function unrollScrollContainers() {
    var containers = findScrollContainers();
    if (containers.length === 0) return 0;

    var saved = [];
    var processed = new Set();

    for (var i = 0; i < containers.length; i++) {
      var el = containers[i];
      if (processed.has(el)) continue;
      processed.add(el);

      // Reset scroll position before unrolling
      el.scrollTop = 0;

      saved.push({
        el: el,
        overflow: el.style.overflow,
        overflowY: el.style.overflowY,
        height: el.style.height,
        maxHeight: el.style.maxHeight,
      });

      el.style.overflow = 'visible';
      el.style.overflowY = 'visible';
      el.style.height = 'auto';
      el.style.maxHeight = 'none';

      // Walk up ancestors and fix any constraining overflow/height
      var parent = el.parentElement;
      while (parent && parent !== document.documentElement) {
        if (processed.has(parent)) {
          parent = parent.parentElement;
          continue;
        }

        var pStyle = window.getComputedStyle(parent);
        var needsFix =
          pStyle.overflow === 'hidden' || pStyle.overflow === 'auto' || pStyle.overflow === 'scroll' ||
          pStyle.overflowY === 'hidden' || pStyle.overflowY === 'auto' || pStyle.overflowY === 'scroll';

        if (needsFix) {
          processed.add(parent);
          saved.push({
            el: parent,
            overflow: parent.style.overflow,
            overflowY: parent.style.overflowY,
            height: parent.style.height,
            maxHeight: parent.style.maxHeight,
          });
          parent.style.overflow = 'visible';
          parent.style.overflowY = 'visible';
          parent.style.height = 'auto';
          parent.style.maxHeight = 'none';
        }

        parent = parent.parentElement;
      }
    }

    // Fix html and body if they block document-level scrolling
    var roots = [document.documentElement, document.body];
    for (var r = 0; r < roots.length; r++) {
      var tag = roots[r];
      if (processed.has(tag)) continue;

      var tagStyle = window.getComputedStyle(tag);
      if (tagStyle.overflow !== 'visible' || tagStyle.overflowY !== 'visible') {
        processed.add(tag);
        saved.push({
          el: tag,
          overflow: tag.style.overflow,
          overflowY: tag.style.overflowY,
          height: tag.style.height,
          maxHeight: tag.style.maxHeight,
        });
        tag.style.overflow = 'visible';
        tag.style.overflowY = 'visible';
        tag.style.height = 'auto';
        tag.style.maxHeight = 'none';
      }
    }

    savedScrollContainerStyles = saved;
    return containers.length;
  }

  function restoreScrollContainers() {
    for (var i = 0; i < savedScrollContainerStyles.length; i++) {
      var s = savedScrollContainerStyles[i];
      s.el.style.overflow = s.overflow;
      s.el.style.overflowY = s.overflowY;
      s.el.style.height = s.height;
      s.el.style.maxHeight = s.maxHeight;
    }
    savedScrollContainerStyles = [];
  }

  // --- Sticky Element Detection ---

  function detectAndHideStickyElements() {
    const hidden = [];
    const allElements = document.querySelectorAll('*');

    for (const el of allElements) {
      const style = window.getComputedStyle(el);
      if (style.position === 'fixed' || style.position === 'sticky') {
        const original = el.style.visibility;
        el.style.visibility = 'hidden';
        hidden.push({ el, original });
      }
    }

    return hidden;
  }

  function restoreElements(elements) {
    for (const { el, original } of elements) {
      el.style.visibility = original;
    }
  }

  // --- Load Detection ---

  async function waitForContentLoad() {
    // Wait for all images in viewport to finish loading
    const images = document.querySelectorAll('img');
    const visible = Array.from(images).filter(function(img) {
      const rect = img.getBoundingClientRect();
      return rect.top < window.innerHeight && rect.bottom > 0;
    });

    await Promise.all(visible.map(function(img) {
      if (img.complete) return Promise.resolve();
      return new Promise(function(resolve) {
        img.addEventListener('load', resolve, { once: true });
        img.addEventListener('error', resolve, { once: true });
        setTimeout(resolve, 2000); // 2s timeout per image
      });
    }));

    // Small fixed delay for CSS transitions / rendering
    await new Promise(function(r) { setTimeout(r, 100); });
  }

  // --- Message Handler ---

  chrome.runtime.onMessage.addListener(function(msg, sender, sendResponse) {
    if (msg.target !== 'captureEngine') return;

    switch (msg.action) {
      case 'measure':
        sendResponse({
          totalHeight: document.documentElement.scrollHeight,
          viewportHeight: window.innerHeight,
          dpr: window.devicePixelRatio || 1
        });
        break;

      case 'scrollTo':
        window.scrollTo(0, msg.y);
        sendResponse({ ok: true });
        break;

      case 'getScrollY':
        sendResponse({ scrollY: Math.round(window.scrollY) });
        break;

      case 'waitForLoad':
        waitForContentLoad().then(function() {
          sendResponse({ ok: true });
        });
        return true; // async response

      case 'unrollScrollContainers':
        var unrolledCount = unrollScrollContainers();
        sendResponse({ count: unrolledCount });
        break;

      case 'restoreScrollContainers':
        restoreScrollContainers();
        sendResponse({ ok: true });
        break;

      case 'hideStickyElements':
        hiddenElements = detectAndHideStickyElements();
        sendResponse({ count: hiddenElements.length });
        break;

      case 'restoreStickyElements':
        restoreElements(hiddenElements);
        hiddenElements = [];
        sendResponse({ ok: true });
        break;

      default:
        sendResponse({ error: 'Unknown action: ' + msg.action });
    }
  });
})();
