# Continuous Scroll Capture - Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add full-page screenshot capture to the URL Grepper Chrome extension - auto-scroll, capture viewport frames, stitch into a single seamless PNG with JSON metadata sidecar.

**Architecture:** Background service worker orchestrates the capture loop (scroll commands + `captureVisibleTab`). Content script (`captureEngine.js`) handles DOM work (scrolling, sticky element hiding, load detection). Offscreen document handles stitching (canvas + blob URLs unavailable in service workers).

**Tech Stack:** Chrome Extension Manifest V3, `chrome.tabs.captureVisibleTab`, `chrome.scripting.executeScript`, OffscreenCanvas, `chrome.downloads`

**Design doc:** `docs/plans/2026-01-28-continuous-scroll-capture-design.md`

---

### Task 1: Update manifest.json

**Files:**
- Modify: `manifest.json`

**Step 1: Update manifest with new permissions and background worker**

Replace the entire contents of `manifest.json` with:

```json
{
  "manifest_version": 3,
  "name": "URL Grepper",
  "version": "1.1",
  "version_name": "1.1.0",
  "description": "Hover over hyperlinks to collect matching URLs. Capture full-page screenshots as seamless PNG images.",
  "icons": {
    "16": "icons/icon-16.png",
    "48": "icons/icon-48.png",
    "128": "icons/icon-128.png"
  },
  "permissions": ["storage", "downloads", "scripting", "offscreen"],
  "host_permissions": ["<all_urls>"],
  "background": {
    "service_worker": "background.js"
  },
  "action": {
    "default_popup": "popup.html",
    "default_title": "URL Grepper",
    "default_icon": {
      "16": "icons/icon-16.png",
      "48": "icons/icon-48.png",
      "128": "icons/icon-128.png"
    }
  },
  "content_scripts": [
    {
      "matches": ["<all_urls>"],
      "js": ["content.js"],
      "run_at": "document_idle"
    }
  ]
}
```

Key changes from previous manifest:
- Added `"scripting"` permission (for `chrome.scripting.executeScript` on-demand injection)
- Added `"offscreen"` permission (for offscreen document stitching)
- Added `"background": { "service_worker": "background.js" }`
- Bumped version to `1.1` / `1.1.0`
- Updated description
- `captureEngine.js` is NOT in `content_scripts` - injected on demand

**Step 2: Commit**

```bash
git add manifest.json
git commit -m "feat: update manifest for capture feature - add scripting, offscreen, background worker"
```

---

### Task 2: Create captureEngine.js (content script)

**Files:**
- Create: `captureEngine.js`

**Step 1: Create the capture engine content script**

This file is injected on demand via `chrome.scripting.executeScript` when a capture starts. It handles all DOM interaction: scrolling, sticky element detection, load waiting.

Create `captureEngine.js`:

```javascript
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
```

**Step 2: Commit**

```bash
git add captureEngine.js
git commit -m "feat: add captureEngine.js - on-demand content script for scroll/capture"
```

---

### Task 3: Create offscreen.html and offscreen.js (stitcher)

**Files:**
- Create: `offscreen.html`
- Create: `offscreen.js`

**Step 1: Create offscreen.html**

Minimal HTML page required by Chrome for the offscreen document API.

Create `offscreen.html`:

```html
<!DOCTYPE html>
<html>
<head><title>Capture Stitcher</title></head>
<body>
  <script src="offscreen.js"></script>
</body>
</html>
```

**Step 2: Create offscreen.js**

This handles stitching frames into a single PNG and creating blob URLs for download.

Create `offscreen.js`:

```javascript
(function() {
  'use strict';

  // Load a data URL into an ImageBitmap
  async function loadImage(dataUrl) {
    const response = await fetch(dataUrl);
    const blob = await response.blob();
    return createImageBitmap(blob);
  }

  // Stitch frames into a single PNG
  async function stitchFrames(frames, pageUrl, dpr) {
    if (!frames || frames.length === 0) {
      throw new Error('No frames to stitch');
    }

    // Decode first frame to get pixel dimensions
    const firstImg = await loadImage(frames[0].dataUrl);
    const width = firstImg.width;
    const frameHeight = firstImg.height;

    // Calculate total height from actual scroll positions
    // Frame 0 contributes its full height
    // Frames 1+ contribute the scroll delta (in physical pixels)
    let totalHeight = frameHeight;
    for (let i = 1; i < frames.length; i++) {
      const scrollDelta = (frames[i].actualY - frames[i - 1].actualY) * dpr;
      totalHeight += Math.round(scrollDelta);
    }

    // Enforce canvas size limits (32,767px per axis, 268M total pixels)
    const MAX_HEIGHT = Math.min(32767, Math.floor(268435456 / width));
    const truncated = totalHeight > MAX_HEIGHT;
    if (truncated) {
      totalHeight = MAX_HEIGHT;
    }

    // Create canvas and draw frames
    const canvas = new OffscreenCanvas(width, totalHeight);
    const ctx = canvas.getContext('2d');

    let drawY = 0;
    for (let i = 0; i < frames.length; i++) {
      const img = (i === 0) ? firstImg : await loadImage(frames[i].dataUrl);

      if (i > 0) {
        const scrollDelta = (frames[i].actualY - frames[i - 1].actualY) * dpr;
        drawY += Math.round(scrollDelta);
      }

      // Don't draw beyond canvas bounds
      if (drawY >= totalHeight) break;

      if (drawY + img.height > totalHeight) {
        // Crop last frame
        const cropHeight = totalHeight - drawY;
        ctx.drawImage(img, 0, 0, width, cropHeight, 0, drawY, width, cropHeight);
      } else {
        ctx.drawImage(img, 0, drawY);
      }
    }

    // Export as PNG blob
    const blob = await canvas.convertToBlob({ type: 'image/png' });
    const blobUrl = URL.createObjectURL(blob);

    // Sidecar metadata
    const metadata = {
      url: pageUrl,
      capturedAt: new Date().toISOString(),
      dimensions: { width: width, height: totalHeight },
      cssPixels: { width: Math.round(width / dpr), height: Math.round(totalHeight / dpr) },
      frameCount: frames.length,
      devicePixelRatio: dpr,
      truncated: truncated
    };
    const jsonBlob = new Blob([JSON.stringify(metadata, null, 2)], { type: 'application/json' });
    const jsonBlobUrl = URL.createObjectURL(jsonBlob);

    // Generate filename from URL
    var hostname;
    try {
      hostname = new URL(pageUrl).hostname.replace(/^www\./, '');
    } catch (e) {
      hostname = 'capture';
    }
    const filename = 'capture_' + hostname + '_' + Date.now();

    return { blobUrl: blobUrl, jsonBlobUrl: jsonBlobUrl, filename: filename };
  }

  // Listen for stitch requests from background
  chrome.runtime.onMessage.addListener(function(msg, sender, sendResponse) {
    if (msg.action !== 'stitch') return;

    stitchFrames(msg.frames, msg.pageUrl, msg.dpr)
      .then(function(result) {
        sendResponse(result);
      })
      .catch(function(error) {
        sendResponse({ error: error.message });
      });

    return true; // async response
  });
})();
```

**Step 3: Commit**

```bash
git add offscreen.html offscreen.js
git commit -m "feat: add offscreen document for frame stitching and PNG export"
```

---

### Task 4: Create background.js (service worker orchestrator)

**Files:**
- Create: `background.js`

**Step 1: Create the background service worker**

This is the orchestrator. It receives "startCapture" from the popup, injects the capture engine, runs the scroll/capture loop, then hands frames to the offscreen document for stitching.

Create `background.js`:

```javascript
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
      reasons: ['CANVAS'],
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
```

**Step 2: Commit**

```bash
git add background.js
git commit -m "feat: add background.js - service worker orchestrating capture loop"
```

---

### Task 5: Update popup.html with capture UI

**Files:**
- Modify: `popup.html`

**Step 1: Add capture section CSS and HTML**

Add the following CSS inside the `<style>` tag, after the existing scrollbar styles (after line 171 in current popup.html):

```css
    /* Capture section */
    .separator {
      border: none;
      border-top: 1px solid #ddd;
      margin: 16px 0 12px;
    }

    .section-title {
      font-size: 14px;
      font-weight: 600;
      color: #1a1a1a;
      margin: 0 0 10px 0;
    }

    .capture-controls {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 10px;
    }

    .capture-controls label {
      margin: 0;
      font-size: 12px;
      color: #555;
      white-space: nowrap;
    }

    .capture-controls select {
      padding: 4px 6px;
      border: 1px solid #ccc;
      border-radius: 4px;
      font-size: 12px;
      background: white;
    }

    #captureFullPage {
      width: 100%;
      padding: 10px;
      background: #2ecc71;
      color: white;
      border: 1px solid #2ecc71;
      border-radius: 4px;
      font-size: 13px;
      font-weight: 500;
      cursor: pointer;
      transition: background-color 0.2s;
    }

    #captureFullPage:hover:not(:disabled) {
      background: #27ae60;
      border-color: #27ae60;
    }

    #captureFullPage:disabled {
      opacity: 0.6;
      cursor: not-allowed;
    }

    .progress-container {
      display: none;
      margin-top: 10px;
    }

    .progress-container.active {
      display: block;
    }

    .progress-bar-bg {
      width: 100%;
      height: 6px;
      background: #e0e0e0;
      border-radius: 3px;
      overflow: hidden;
    }

    .progress-bar-fill {
      height: 100%;
      width: 0%;
      background: #4a90e2;
      border-radius: 3px;
      transition: width 0.3s ease;
    }

    .progress-text {
      font-size: 11px;
      color: #666;
      margin-top: 4px;
      text-align: center;
    }
```

Add the following HTML before the `<script>` tag (after the status div, before line 196):

```html
  <hr class="separator">
  <h2 class="section-title">Capture</h2>

  <div class="capture-controls">
    <label for="scrollDelay">Scroll delay:</label>
    <select id="scrollDelay" aria-label="Scroll delay between captures">
      <option value="300">300ms (default)</option>
      <option value="500">500ms (thorough)</option>
      <option value="1000">1000ms (slow)</option>
    </select>
  </div>

  <button id="captureFullPage" aria-label="Capture full page screenshot">Capture Full Page</button>

  <div class="progress-container" id="progressContainer">
    <div class="progress-bar-bg">
      <div class="progress-bar-fill" id="progressBar"></div>
    </div>
    <div class="progress-text" id="progressText"></div>
  </div>
```

**Step 2: Commit**

```bash
git add popup.html
git commit -m "feat: add capture section UI to popup - button, delay selector, progress bar"
```

---

### Task 6: Update popup.js with capture logic

**Files:**
- Modify: `popup.js`

**Step 1: Add capture functionality to popup.js**

Add the following code inside the IIFE, after the `loadData()` call (before the closing `})();` on line 167):

```javascript
    // --- Capture Section ---

    const captureBtn = document.getElementById('captureFullPage');
    const scrollDelayEl = document.getElementById('scrollDelay');
    const progressContainer = document.getElementById('progressContainer');
    const progressBar = document.getElementById('progressBar');
    const progressText = document.getElementById('progressText');

    // Load capture status on popup open
    function loadCaptureStatus() {
      chrome.storage.local.get(['captureStatus', 'captureProgress', 'captureError'], function(data) {
        if (chrome.runtime.lastError) return;
        updateCaptureUI(data.captureStatus, data.captureProgress, data.captureError);
      });
    }

    // Listen for capture progress updates
    chrome.storage.onChanged.addListener(function(changes, area) {
      if (area !== 'local') return;

      var status = null;
      var progress = null;
      var error = null;

      if (changes.captureStatus) status = changes.captureStatus.newValue;
      if (changes.captureProgress) progress = changes.captureProgress.newValue;
      if (changes.captureError) error = changes.captureError.newValue;

      if (status !== null || progress !== null) {
        // Get full state to render correctly
        chrome.storage.local.get(['captureStatus', 'captureProgress', 'captureError'], function(data) {
          if (chrome.runtime.lastError) return;
          updateCaptureUI(data.captureStatus, data.captureProgress, data.captureError);
        });
      }
    });

    function updateCaptureUI(status, progress, error) {
      if (!status || status === 'done' || status === 'error') {
        // Not capturing
        captureBtn.disabled = false;
        captureBtn.textContent = 'Capture Full Page';

        if (status === 'done') {
          progressContainer.classList.add('active');
          progressBar.style.width = '100%';
          progressText.textContent = 'Done! Saved to Downloads.';
          setStatus('Capture saved to Downloads');
          // Clear status after showing
          setTimeout(function() {
            chrome.storage.local.remove(['captureStatus', 'captureProgress', 'captureError']);
            progressContainer.classList.remove('active');
          }, 5000);
        } else if (status === 'error') {
          progressContainer.classList.add('active');
          progressBar.style.width = '0%';
          progressText.textContent = 'Error: ' + (error || 'Capture failed');
          setStatus(error || 'Capture failed', true);
          setTimeout(function() {
            chrome.storage.local.remove(['captureStatus', 'captureProgress', 'captureError']);
            progressContainer.classList.remove('active');
          }, 5000);
        } else {
          progressContainer.classList.remove('active');
        }
      } else {
        // Capturing or stitching
        captureBtn.disabled = true;

        if (status === 'capturing') {
          captureBtn.textContent = 'Capturing...';
          progressContainer.classList.add('active');
          progressBar.style.width = (progress || 0) + '%';
          progressText.textContent = 'Capturing... ' + (progress || 0) + '%';
        } else if (status === 'stitching') {
          captureBtn.textContent = 'Stitching...';
          progressContainer.classList.add('active');
          progressBar.style.width = '96%';
          progressText.textContent = 'Stitching frames...';
        }
      }
    }

    // Start capture
    captureBtn.addEventListener('click', function() {
      captureBtn.disabled = true;
      captureBtn.textContent = 'Starting...';
      progressContainer.classList.add('active');
      progressBar.style.width = '0%';
      progressText.textContent = 'Starting capture...';

      var delay = parseInt(scrollDelayEl.value, 10) || 300;

      chrome.runtime.sendMessage({
        action: 'startCapture',
        options: { delay: delay }
      }, function(response) {
        if (chrome.runtime.lastError) {
          console.error('Failed to start capture:', chrome.runtime.lastError);
          setStatus('Failed to start capture', true);
          captureBtn.disabled = false;
          captureBtn.textContent = 'Capture Full Page';
          progressContainer.classList.remove('active');
        }
        // Response handling is done via storage change listener
      });
    });

    loadCaptureStatus();
```

**Step 2: Commit**

```bash
git add popup.js
git commit -m "feat: add capture controls to popup - trigger, progress display, status updates"
```

---

### Task 7: Manual smoke test

**Steps:**

1. Open Chrome and go to `chrome://extensions/`
2. Enable "Developer mode" (toggle in top right)
3. Click "Load unpacked" and select the extension directory
4. If already loaded, click the refresh icon on the extension card
5. Verify no errors appear on the extension card

**Test full-page capture:**

1. Navigate to a long page (e.g., a Wikipedia article)
2. Click the extension icon to open the popup
3. Verify the "Capture" section appears below the URL grepper section
4. Leave scroll delay at 300ms (default)
5. Click "Capture Full Page"
6. Observe:
   - Button changes to "Capturing..."
   - Progress bar fills as capture proceeds
   - Status changes to "Stitching..."
   - Status changes to "Done! Saved to Downloads"
7. Check Downloads folder for `capture_{hostname}_{timestamp}.png` and `.json`
8. Open the PNG - verify it's a seamless full-page screenshot
9. Open the JSON - verify it contains URL, dimensions, frame count

**Test single-frame capture:**

1. Navigate to a short page that fits in one viewport
2. Click "Capture Full Page"
3. Should complete almost instantly with a single-frame PNG

**Test error case:**

1. Navigate to `chrome://extensions/` (a chrome:// URL)
2. Click "Capture Full Page"
3. Should show an error (content scripts can't run on chrome:// pages)

**Test existing URL grepper still works:**

1. Navigate to any page
2. Enable URL grepper, set a grep string
3. Hover over matching links
4. Verify URLs are still collected as before

**Step: Commit (if any fixes needed)**

```bash
git add -A
git commit -m "fix: address issues found during smoke testing"
```

---

### Task 8: Final commit - update README

**Files:**
- Modify: `README.md`

**Step 1: Update README to document capture feature**

Add the following section after the existing "## Features" list in README.md:

```markdown
- **Full-page capture** - Automatically scroll and capture entire pages as a single seamless PNG screenshot
- **OCR-friendly output** - Lossless PNG format with JSON sidecar containing URL and metadata
- **Smart capture** - Handles sticky headers/footers, lazy-loaded images, and Retina displays
- **User-controllable speed** - Adjustable scroll delay (300ms default, 500ms thorough, 1000ms slow)
```

Add a new usage section for capture:

```markdown
## Page Capture

1. Click the extension icon to open the popup
2. Scroll down to the **Capture** section
3. Choose a scroll delay (300ms is usually fine)
4. Click **Capture Full Page**
5. Wait for progress to complete
6. Find `capture_{hostname}_{timestamp}.png` and `.json` in Downloads
```

**Step 2: Commit**

```bash
git add README.md
git commit -m "docs: update README with capture feature documentation"
```
