'use strict';

let captureInProgress = false;

// --- Utility ---

function sleep(ms) {
  return new Promise(function(resolve) { setTimeout(resolve, ms); });
}

// Send message to content script in a tab, targeting captureEngine
function sendToTab(tabId, action, data) {
  return new Promise(function(resolve, reject) {
    const msg = Object.assign({ target: 'captureEngine', action: action }, data || {});
    chrome.tabs.sendMessage(tabId, msg, function(response) {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else if (response && response.error) {
        reject(new Error(response.error));
      } else {
        resolve(response);
      }
    });
  });
}

// Ensure offscreen document exists
async function ensureOffscreenDocument() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT']
  });
  if (contexts.length === 0) {
    await chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: ['BLOBS'],
      justification: 'Stitch captured frames into a single PNG image'
    });
  }
}

// Send message to offscreen document
function sendToOffscreen(action, data) {
  return new Promise(function(resolve, reject) {
    const msg = Object.assign({ action: action }, data || {});
    chrome.runtime.sendMessage(msg, function(response) {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else if (response && response.error) {
        reject(new Error(response.error));
      } else {
        resolve(response);
      }
    });
  });
}

// --- Capture Orchestration ---

async function orchestrateCapture(tabId, options) {
  if (captureInProgress) {
    await chrome.storage.local.set({
      captureStatus: 'error',
      captureError: 'A capture is already in progress'
    });
    return;
  }

  captureInProgress = true;
  const scrollDelay = options.delay || 300;
  const MIN_CAPTURE_INTERVAL = 500; // Chrome rate limit: max 2 captureVisibleTab/sec
  const OVERLAP = 50; // CSS pixels overlap between frames
  const MAX_HEIGHT = 100000; // CSS pixels safety cap

  try {
    await chrome.storage.local.set({
      captureStatus: 'capturing',
      captureProgress: 0,
      captureError: null
    });

    // 1. Inject capture engine on demand
    await chrome.scripting.executeScript({
      target: { tabId: tabId },
      files: ['captureEngine.js']
    });

    // Small delay to let the script initialize
    await sleep(100);

    // 2. Get page dimensions
    const dims = await sendToTab(tabId, 'measure');
    let totalHeight = Math.min(dims.totalHeight, MAX_HEIGHT);
    var viewportHeight = dims.viewportHeight;
    var dpr = dims.dpr || 1;

    // 3. Single-frame shortcut: page fits in viewport
    if (totalHeight <= viewportHeight) {
      const dataUrl = await chrome.tabs.captureVisibleTab(null, { format: 'png' });
      const tab = await chrome.tabs.get(tabId);
      const pageUrl = tab.url || '';

      await ensureOffscreenDocument();
      const scrollY = await sendToTab(tabId, 'getScrollY');
      const result = await sendToOffscreen('stitch', {
        frames: [{ y: 0, actualY: scrollY.scrollY || 0, dataUrl: dataUrl }],
        pageUrl: pageUrl,
        dpr: dpr
      });

      await downloadResults(result);
      await chrome.storage.local.set({ captureStatus: 'done', captureProgress: 100 });
      return;
    }

    // 4. Hide sticky elements
    await sendToTab(tabId, 'hideStickyElements');

    // 5. Scroll to top
    await sendToTab(tabId, 'scrollTo', { y: 0 });
    await sleep(200);

    // 6. Capture loop
    var frames = [];
    var currentY = 0;
    var maxIterations = Math.ceil(totalHeight / (viewportHeight - OVERLAP)) + 5;

    for (var iteration = 0; iteration < maxIterations; iteration++) {
      // Scroll to position
      await sendToTab(tabId, 'scrollTo', { y: currentY });
      await sleep(scrollDelay);

      // Wait for content to load
      await sendToTab(tabId, 'waitForLoad');

      // Capture viewport
      var captureStart = Date.now();
      var dataUrl = await chrome.tabs.captureVisibleTab(null, { format: 'png' });

      // Get actual scroll position (may differ from requested)
      var scrollResult = await sendToTab(tabId, 'getScrollY');
      frames.push({
        y: currentY,
        actualY: scrollResult.scrollY,
        dataUrl: dataUrl
      });

      // Update progress
      var progress = Math.min(95, Math.round((currentY / totalHeight) * 100));
      await chrome.storage.local.set({ captureProgress: progress });

      // Re-check scrollHeight (may have grown from lazy loading)
      var newDims = await sendToTab(tabId, 'measure');
      totalHeight = Math.min(newDims.totalHeight, MAX_HEIGHT);

      // Advance scroll position
      currentY += viewportHeight - OVERLAP;

      // Check if we've reached the bottom
      if (currentY >= totalHeight) break;

      // Enforce capture rate limit
      var elapsed = Date.now() - captureStart;
      if (elapsed < MIN_CAPTURE_INTERVAL) {
        await sleep(MIN_CAPTURE_INTERVAL - elapsed);
      }
    }

    // 7. Restore sticky elements
    await sendToTab(tabId, 'restoreStickyElements');

    // 8. Stitch frames
    await chrome.storage.local.set({ captureStatus: 'stitching', captureProgress: 96 });

    var tab = await chrome.tabs.get(tabId);
    var pageUrl = tab.url || '';

    await ensureOffscreenDocument();
    var result = await sendToOffscreen('stitch', {
      frames: frames,
      pageUrl: pageUrl,
      dpr: dpr
    });

    // 9. Download
    await downloadResults(result);
    await chrome.storage.local.set({ captureStatus: 'done', captureProgress: 100 });

  } catch (error) {
    console.error('Capture failed:', error);
    await chrome.storage.local.set({
      captureStatus: 'error',
      captureError: error.message || 'Capture failed'
    });
    // Try to restore sticky elements on error
    try {
      await sendToTab(tabId, 'restoreStickyElements');
    } catch (e) { /* ignore */ }
  } finally {
    captureInProgress = false;
  }
}

async function downloadResults(result) {
  return new Promise(function(resolve, reject) {
    chrome.downloads.download({
      url: result.blobUrl,
      filename: result.filename + '.png',
      saveAs: false
    }, function(pngId) {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      chrome.downloads.download({
        url: result.jsonBlobUrl,
        filename: result.filename + '.json',
        saveAs: false
      }, function(jsonId) {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        resolve();
      });
    });
  });
}

// --- Message Listener ---

chrome.runtime.onMessage.addListener(function(msg, sender, sendResponse) {
  if (msg.action === 'startCapture') {
    // Get the active tab and start capture
    chrome.tabs.query({ active: true, currentWindow: true }, function(tabs) {
      if (!tabs || tabs.length === 0) {
        sendResponse({ error: 'No active tab found' });
        return;
      }
      orchestrateCapture(tabs[0].id, msg.options || {})
        .then(function() { sendResponse({ ok: true }); })
        .catch(function(err) { sendResponse({ error: err.message }); });
    });
    return true; // async response
  }
});
