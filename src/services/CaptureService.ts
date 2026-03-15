// Capture orchestration singleton for full-page scroll screenshots
// Ports background.js capture logic from the standalone URL grepper extension

let instance: CaptureService | null = null;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sendToTab(tabId: number, action: string, data?: Record<string, unknown>): Promise<any> {
  return new Promise((resolve, reject) => {
    const msg = { target: 'captureEngine', action, ...data };
    chrome.tabs.sendMessage(tabId, msg, (response) => {
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

async function ensureOffscreenDocument(): Promise<void> {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT' as chrome.runtime.ContextType],
  });
  if (contexts.length === 0) {
    await chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: [chrome.offscreen.Reason.BLOBS],
      justification: 'Stitch captured frames into a single PNG image',
    });
  }
}

function sendToOffscreen(action: string, data: Record<string, unknown>): Promise<any> {
  return new Promise((resolve, reject) => {
    const msg = { action, ...data };
    chrome.runtime.sendMessage(msg, (response) => {
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

interface CaptureFrame {
  y: number;
  actualY: number;
  dataUrl: string;
}

interface StitchResult {
  dataUrl: string;
  filename: string;
}

export interface CaptureOptions {
  delay?: number;
}

export class CaptureService {
  private captureInProgress = false;

  async startCapture(options: CaptureOptions = {}): Promise<void> {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) {
      await chrome.storage.local.set({
        capture_status: 'error',
        capture_error: 'No active tab found',
      });
      return;
    }
    await this.orchestrateCapture(tab.id, options);
  }

  private async orchestrateCapture(tabId: number, options: CaptureOptions): Promise<void> {
    if (this.captureInProgress) {
      await chrome.storage.local.set({
        capture_status: 'error',
        capture_error: 'A capture is already in progress',
      });
      return;
    }

    this.captureInProgress = true;
    const scrollDelay = options.delay || 300;
    const MIN_CAPTURE_INTERVAL = 500;
    const OVERLAP = 50;
    const MAX_HEIGHT = 100000;

    try {
      await chrome.storage.local.set({
        capture_status: 'capturing',
        capture_progress: 0,
        capture_error: null,
      });

      // Inject capture engine on demand
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ['captureEngine.js'],
      });
      await sleep(100);

      // Get page dimensions
      const dims = await sendToTab(tabId, 'measure');
      let totalHeight = Math.min(dims.totalHeight, MAX_HEIGHT);
      const viewportHeight = dims.viewportHeight;
      const dpr = dims.dpr || 1;

      // Single-frame shortcut
      if (totalHeight <= viewportHeight) {
        const dataUrl = await chrome.tabs.captureVisibleTab({ format: 'png' });
        const tab = await chrome.tabs.get(tabId);
        const pageUrl = tab.url || '';

        await ensureOffscreenDocument();
        const scrollY = await sendToTab(tabId, 'getScrollY');
        const result = await sendToOffscreen('stitch', {
          frames: [{ y: 0, actualY: scrollY.scrollY || 0, dataUrl }],
          pageUrl,
          dpr,
        });

        await this.downloadResults(result);
        await chrome.storage.local.set({ capture_status: 'done', capture_progress: 100 });
        return;
      }

      // Hide sticky elements
      await sendToTab(tabId, 'hideStickyElements');

      // Scroll to top
      await sendToTab(tabId, 'scrollTo', { y: 0 });
      await sleep(200);

      // Capture loop
      const frames: CaptureFrame[] = [];
      let currentY = 0;
      const maxIterations = Math.ceil(totalHeight / (viewportHeight - OVERLAP)) + 5;

      for (let iteration = 0; iteration < maxIterations; iteration++) {
        await sendToTab(tabId, 'scrollTo', { y: currentY });
        await sleep(scrollDelay);

        await sendToTab(tabId, 'waitForLoad');

        const captureStart = Date.now();
        const dataUrl = await chrome.tabs.captureVisibleTab({ format: 'png' });

        const scrollResult = await sendToTab(tabId, 'getScrollY');
        frames.push({
          y: currentY,
          actualY: scrollResult.scrollY,
          dataUrl,
        });

        const progress = Math.min(95, Math.round((currentY / totalHeight) * 100));
        await chrome.storage.local.set({ capture_progress: progress });

        // Re-check scrollHeight (lazy loading may grow it)
        const newDims = await sendToTab(tabId, 'measure');
        totalHeight = Math.min(newDims.totalHeight, MAX_HEIGHT);

        currentY += viewportHeight - OVERLAP;
        if (currentY >= totalHeight) break;

        const elapsed = Date.now() - captureStart;
        if (elapsed < MIN_CAPTURE_INTERVAL) {
          await sleep(MIN_CAPTURE_INTERVAL - elapsed);
        }
      }

      // Restore sticky elements
      await sendToTab(tabId, 'restoreStickyElements');

      // Stitch frames
      await chrome.storage.local.set({ capture_status: 'stitching', capture_progress: 96 });

      const tab = await chrome.tabs.get(tabId);
      const pageUrl = tab.url || '';

      await ensureOffscreenDocument();
      const result = await sendToOffscreen('stitch', {
        frames,
        pageUrl,
        dpr,
      });

      await this.downloadResults(result);
      await chrome.storage.local.set({ capture_status: 'done', capture_progress: 100 });
    } catch (error) {
      console.error('[UNOS] Capture failed:', error);
      await chrome.storage.local.set({
        capture_status: 'error',
        capture_error: error instanceof Error ? error.message : 'Capture failed',
      });
      try {
        await sendToTab(tabId, 'restoreStickyElements');
      } catch { /* ignore */ }
    } finally {
      this.captureInProgress = false;
    }
  }

  private async downloadResults(result: StitchResult): Promise<void> {
    return new Promise((resolve, reject) => {
      chrome.downloads.download(
        {
          url: result.dataUrl,
          filename: result.filename + '.png',
          saveAs: false,
        },
        (pngId) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
            return;
          }
          resolve();
        },
      );
    });
  }
}

export function getCaptureService(): CaptureService {
  if (!instance) {
    instance = new CaptureService();
  }
  return instance;
}
