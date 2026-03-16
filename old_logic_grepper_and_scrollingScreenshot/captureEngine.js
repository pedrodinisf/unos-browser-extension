(function() {
  'use strict';

  // Guard against double-injection
  if (window.__captureEngineInjected) return;
  window.__captureEngineInjected = true;

  // State for hidden sticky elements
  let hiddenElements = [];

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
