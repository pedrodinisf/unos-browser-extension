# Continuous Scroll Capture - Design Document

## Goal

Add a full-page screenshot capture feature to the URL Grepper extension. Scrolls through content automatically, captures viewport frames, stitches them into a single seamless PNG image with a sidecar JSON metadata file.

Region capture (specific sections, X.com posts with URL extraction) is planned for v2.

## Phasing

- **v1 (this plan):** Full-page capture via popup button
- **v2 (future):** Region capture via context menu, smart container detection, URL extraction

## Architecture

```
TRIGGER
  Popup Button → "Capture Full Page"
        │
        ▼
BACKGROUND (background.js - service worker)
  Orchestrates the capture loop:
  1. Tells content script to scroll to position Y
  2. Waits for "ready" message
  3. Calls chrome.tabs.captureVisibleTab()
  4. Stores frame
  5. Repeats until done
  6. Sends frames to offscreen document for stitching
        │
        ▼
CONTENT SCRIPT (captureEngine.js - injected on demand)
  - Scrolls page to requested position
  - Hides/restores sticky elements
  - Waits for content to load
  - Reports "ready" back to background
        │
        ▼
OFFSCREEN DOCUMENT (offscreen.html/js)
  - Receives frames from background
  - Stitches into single canvas
  - Creates blob URL for download
  - Triggers download via background
```

### Why This Split

- **Background orchestrates** - holds the capture loop, calls `captureVisibleTab`, manages state
- **Content script** - only does DOM work (scroll, detect sticky elements, check load state)
- **Offscreen document** - handles stitching (canvas + blob URL unavailable in service workers)
- **On-demand injection** - `captureEngine.js` injected via `chrome.scripting.executeScript` only when capture starts, not loaded on every page

### Communication Flow

```
Popup ──message──▶ Background: "start capture"
                       │
                       ├──▶ Content Script: "scroll to Y"
                       │◀── Content Script: "ready"
                       ├──  captureVisibleTab() → store frame
                       │
                       ├──▶ Content Script: "scroll to next Y"
                       │◀── Content Script: "ready"
                       ├──  captureVisibleTab() → store frame
                       │    ... repeat ...
                       │
                       ├──▶ Offscreen Doc: "stitch frames"
                       │◀── Offscreen Doc: blob URL
                       ├──  chrome.downloads.download()
                       │
                       ├──▶ Storage: progress updates
Popup ◀─ storage ──────┘    (popup reads on open)
```

## Capture Loop Algorithm

The **background service worker** orchestrates the loop. The **content script** only scrolls and reports readiness.

### Background Orchestrator

```javascript
async function orchestrateCapture(tabId, options = {}) {
  if (captureInProgress) return; // Mutex guard
  captureInProgress = true;

  const scrollDelay = options.delay || 300;
  const MIN_CAPTURE_INTERVAL = 500; // Chrome rate limit: 2 calls/sec

  try {
    // 1. Inject capture engine on demand
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['captureEngine.js']
    });

    // 2. Get page dimensions from content script
    const { totalHeight, viewportHeight, dpr } = await sendMessage(tabId, 'measure');

    // 3. Tell content script to hide sticky elements
    await sendMessage(tabId, 'hideStickyElements');

    // 4. Capture loop
    const frames = [];
    const OVERLAP = 50;
    let currentY = 0;
    let maxIterations = Math.ceil(totalHeight / (viewportHeight - OVERLAP)) + 5;
    let iteration = 0;

    while (currentY < totalHeight && iteration < maxIterations) {
      // Scroll and wait for load
      await sendMessage(tabId, 'scrollTo', { y: currentY });
      await sleep(scrollDelay);
      await sendMessage(tabId, 'waitForLoad');

      // Capture viewport (respects 500ms minimum interval)
      const lastCapture = Date.now();
      const dataUrl = await chrome.tabs.captureVisibleTab(null, { format: 'png' });
      frames.push({ y: currentY, actualY: await sendMessage(tabId, 'getScrollY'), dataUrl });

      // Update progress in storage
      const progress = Math.min(100, Math.round((currentY / totalHeight) * 100));
      await chrome.storage.local.set({ captureProgress: progress });

      // Re-check scrollHeight (may have grown due to lazy loading)
      const { totalHeight: newHeight } = await sendMessage(tabId, 'measure');
      totalHeight = Math.min(newHeight, 100000); // Max 100k px safety cap

      currentY += viewportHeight - OVERLAP;
      iteration++;

      // Enforce rate limit
      const elapsed = Date.now() - lastCapture;
      if (elapsed < MIN_CAPTURE_INTERVAL) {
        await sleep(MIN_CAPTURE_INTERVAL - elapsed);
      }
    }

    // 5. Restore sticky elements
    await sendMessage(tabId, 'restoreStickyElements');

    // 6. Send to offscreen document for stitching
    const pageUrl = await getTabUrl(tabId);
    await ensureOffscreenDocument();
    const result = await chrome.runtime.sendMessage({
      action: 'stitch',
      frames,
      pageUrl,
      dpr
    });

    // 7. Download
    chrome.downloads.download({ url: result.blobUrl, filename: result.filename + '.png', saveAs: false });
    chrome.downloads.download({ url: result.jsonBlobUrl, filename: result.filename + '.json', saveAs: false });

    await chrome.storage.local.set({ captureProgress: 100, captureStatus: 'done' });

  } catch (error) {
    console.error('Capture failed:', error);
    await chrome.storage.local.set({ captureStatus: 'error', captureError: error.message });
  } finally {
    captureInProgress = false;
    await chrome.storage.local.remove(['captureProgress']);
  }
}
```

### Content Script Commands

```javascript
// captureEngine.js - injected on demand via chrome.scripting.executeScript
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  switch (msg.action) {
    case 'measure':
      sendResponse({
        totalHeight: document.documentElement.scrollHeight,
        viewportHeight: window.innerHeight,
        dpr: window.devicePixelRatio
      });
      break;

    case 'scrollTo':
      window.scrollTo(0, msg.y);
      sendResponse({ ok: true });
      break;

    case 'getScrollY':
      sendResponse({ scrollY: window.scrollY });
      break;

    case 'waitForLoad':
      waitForContentLoad().then(() => sendResponse({ ok: true }));
      return true; // async response

    case 'hideStickyElements':
      hiddenElements = detectAndHideStickyElements();
      sendResponse({ ok: true });
      break;

    case 'restoreStickyElements':
      restoreStickyElements(hiddenElements);
      sendResponse({ ok: true });
      break;
  }
});
```

### Key Techniques

| Problem | Solution |
|---------|----------|
| Sticky headers/footers duplicated | Detect `position: fixed/sticky`, temporarily set `visibility: hidden` |
| Lazy-loaded images missing | `waitForContentLoad()` checks all `<img>` in viewport have `complete === true` + fixed delay |
| Misaligned stitches | Track actual `window.scrollY` after each scroll, compute exact overlap from position delta |
| Infinite scroll / growing pages | Re-check `scrollHeight` each iteration + 100,000px max height safety cap |
| `captureVisibleTab` rate limit (2/sec) | Enforce minimum 500ms between capture calls |
| Retina / HiDPI displays | Read `devicePixelRatio`, multiply all pixel math accordingly |
| Service worker termination | `chrome.storage.local.set` heartbeat on each iteration keeps worker alive |
| Concurrent captures | `captureInProgress` boolean mutex checked before starting |
| Pages that block scrolling | Pre-check: if `scrollHeight <= viewportHeight`, skip scroll loop, capture single frame |

### Load Detection

Pragmatic approach (no unreliable network idle detection):

```javascript
async function waitForContentLoad() {
  // Wait for all images in viewport to load
  const images = document.querySelectorAll('img');
  const visible = Array.from(images).filter(img => {
    const rect = img.getBoundingClientRect();
    return rect.top < window.innerHeight && rect.bottom > 0;
  });

  await Promise.all(visible.map(img =>
    img.complete ? Promise.resolve() :
    new Promise(resolve => {
      img.addEventListener('load', resolve, { once: true });
      img.addEventListener('error', resolve, { once: true });
      setTimeout(resolve, 2000); // 2s timeout per image
    })
  ));

  // Small fixed delay for CSS transitions / rendering
  await new Promise(r => setTimeout(r, 100));
}
```

## Stitching (Offscreen Document)

### offscreen.html

Minimal HTML page that loads the stitching logic.

### Stitching Algorithm

```javascript
async function stitchFrames(frames, pageUrl, dpr) {
  // 1. Calculate dimensions from actual scroll positions
  const viewportHeight = frames.length > 1
    ? (frames[1].actualY - frames[0].actualY) * dpr
    : frames[0].height;

  // Decode first frame to get pixel width
  const firstImg = await loadImage(frames[0].dataUrl);
  const width = firstImg.width; // Already in physical pixels from captureVisibleTab

  // 2. Calculate total height from scroll positions
  let totalHeight = 0;
  for (let i = 0; i < frames.length; i++) {
    if (i === 0) {
      totalHeight += firstImg.height;
    } else {
      const scrollDelta = (frames[i].actualY - frames[i-1].actualY) * dpr;
      totalHeight += scrollDelta;
    }
  }

  // 3. Enforce canvas size limits (32,767px per axis, 268M total pixels)
  const MAX_HEIGHT = Math.min(32767, Math.floor(268435456 / width));
  if (totalHeight > MAX_HEIGHT) {
    totalHeight = MAX_HEIGHT; // Truncate with warning
  }

  // 4. Create canvas and draw
  const canvas = new OffscreenCanvas(width, totalHeight);
  const ctx = canvas.getContext('2d');

  let drawY = 0;
  for (let i = 0; i < frames.length; i++) {
    const img = await loadImage(frames[i].dataUrl);

    if (i > 0) {
      // Deterministic overlap: use actual scroll positions
      const scrollDelta = (frames[i].actualY - frames[i - 1].actualY) * dpr;
      drawY = (frames[0].actualY === 0 ? 0 : drawY) + scrollDelta;
      // Simpler: drawY for frame i = sum of all scroll deltas
    }

    if (drawY + img.height > totalHeight) {
      // Crop last frame if it exceeds canvas
      const cropHeight = totalHeight - drawY;
      ctx.drawImage(img, 0, 0, width, cropHeight, 0, drawY, width, cropHeight);
    } else {
      ctx.drawImage(img, 0, drawY);
    }

    if (i === 0) drawY = img.height - ((frames.length > 1 ? (frames[1].actualY - frames[0].actualY) : 0) * dpr - (img.height - (frames.length > 1 ? (frames[1].actualY - frames[0].actualY) * dpr : 0)));
    // Simplified: just track drawY = sum of scroll deltas * dpr for frames 1+
  }

  // Simplified draw logic:
  drawY = 0;
  for (let i = 0; i < frames.length; i++) {
    const img = await loadImage(frames[i].dataUrl);
    if (i > 0) {
      drawY += (frames[i].actualY - frames[i-1].actualY) * dpr;
    }
    ctx.drawImage(img, 0, drawY);
  }

  // 5. Export
  const blob = await canvas.convertToBlob({ type: 'image/png' });
  const blobUrl = URL.createObjectURL(blob);

  // 6. Sidecar metadata
  const metadata = {
    url: pageUrl,
    capturedAt: new Date().toISOString(),
    dimensions: { width, height: totalHeight },
    frameCount: frames.length,
    devicePixelRatio: dpr
  };
  const jsonBlob = new Blob([JSON.stringify(metadata, null, 2)], { type: 'application/json' });
  const jsonBlobUrl = URL.createObjectURL(jsonBlob);

  // 7. Generate filename from URL
  const hostname = new URL(pageUrl).hostname.replace(/^www\./, '');
  const filename = `capture_${hostname}_${Date.now()}`;

  return { blobUrl, jsonBlobUrl, filename };
}
```

## Popup UI Changes

Add a "Capture" section below existing URL grepper controls:

- **Separator** between URL grepper and capture section
- **Scroll delay dropdown** - 300ms (default), 500ms (thorough) - minimum 500ms enforced internally
- **"Capture Full Page" button** - disabled during capture
- **Progress bar** - reads `captureProgress` from storage, updates in real-time
- **Status text** - "Capturing...", "Stitching...", "Done! Saved to Downloads", or error message

Since the popup closes on blur, progress is stored in `chrome.storage.local` so the popup can display current status when re-opened.

## File Changes

### New Files

| File | Purpose |
|------|---------|
| `captureEngine.js` | Content script (injected on demand) - scrolling, sticky detection, load waiting |
| `background.js` | Service worker - capture orchestration, message routing |
| `offscreen.html` | Minimal page for offscreen document |
| `offscreen.js` | Stitching logic with canvas + blob URL creation |

### Modified Files

| File | Change |
|------|--------|
| `manifest.json` | Add service worker, `offscreen` + `contextMenus` + `scripting` permissions |
| `popup.html` | Add capture section (delay, button, progress) |
| `popup.js` | Add capture trigger, progress display |

### Manifest Updates

```json
{
  "manifest_version": 3,
  "name": "URL Grepper",
  "version": "1.1",
  "version_name": "1.1.0",
  "permissions": ["storage", "downloads", "scripting", "offscreen"],
  "host_permissions": ["<all_urls>"],
  "background": {
    "service_worker": "background.js"
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

Note: `captureEngine.js` is NOT in `content_scripts` - it is injected on demand via `chrome.scripting.executeScript`. The `scripting` permission enables this. `host_permissions: ["<all_urls>"]` is preserved (not `activeTab`) so captures work after popup closes.

## Output

- **PNG image** - Lossless, OCR-friendly, physical pixel resolution
- **JSON sidecar** - URL, timestamp, dimensions, frame count, DPR
- **Filename** - `capture_{hostname}_{timestamp}.png` + `.json`

## Known Limitations (v1)

- No region capture (v2)
- No horizontal scroll support (vertical only)
- Max capture height ~100,000 CSS pixels (canvas limits)
- Cross-origin iframes render in capture but cannot be interacted with
- Pages that fully block scrolling (`overflow: hidden` on body) produce single-frame capture

## v2 Roadmap

- Region capture via context menu
- Smart container detection (`<article>`, `[data-testid="tweet"]`, etc.)
- Click-to-select with resize handles
- Post URL extraction for social media
- Keyboard shortcut trigger
