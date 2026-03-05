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
