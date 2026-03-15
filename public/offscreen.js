(function() {
  'use strict';

  // Load a data URL into an ImageBitmap
  async function loadImage(dataUrl) {
    const response = await fetch(dataUrl);
    const blob = await response.blob();
    return createImageBitmap(blob);
  }

  // Convert a Blob to a data URL
  function blobToDataUrl(blob) {
    return new Promise(function(resolve, reject) {
      var reader = new FileReader();
      reader.onloadend = function() { resolve(reader.result); };
      reader.onerror = function() { reject(new Error('Failed to read blob')); };
      reader.readAsDataURL(blob);
    });
  }

  // Stitch frames into a single PNG
  async function stitchFrames(frames, pageUrl, dpr) {
    if (!frames || frames.length === 0) {
      throw new Error('No frames to stitch');
    }

    // Decode first frame to get pixel dimensions
    var firstImg = await loadImage(frames[0].dataUrl);
    var width = firstImg.width;
    var frameHeight = firstImg.height;

    // Calculate total height from actual scroll positions
    // Frame 0 contributes its full height
    // Frames 1+ contribute the scroll delta (in physical pixels)
    var totalHeight = frameHeight;
    for (var i = 1; i < frames.length; i++) {
      var scrollDelta = (frames[i].actualY - frames[i - 1].actualY) * dpr;
      totalHeight += Math.round(scrollDelta);
    }

    // Enforce canvas size limits (32,767px per axis, 268M total pixels)
    var MAX_HEIGHT = Math.min(32767, Math.floor(268435456 / width));
    if (totalHeight > MAX_HEIGHT) {
      totalHeight = MAX_HEIGHT;
    }

    // Create canvas and draw frames
    var canvas = new OffscreenCanvas(width, totalHeight);
    var ctx = canvas.getContext('2d');

    var drawY = 0;
    for (var j = 0; j < frames.length; j++) {
      var img = (j === 0) ? firstImg : await loadImage(frames[j].dataUrl);

      if (j > 0) {
        var delta = (frames[j].actualY - frames[j - 1].actualY) * dpr;
        drawY += Math.round(delta);
      }

      // Don't draw beyond canvas bounds
      if (drawY >= totalHeight) break;

      if (drawY + img.height > totalHeight) {
        // Crop last frame
        var cropHeight = totalHeight - drawY;
        ctx.drawImage(img, 0, 0, width, cropHeight, 0, drawY, width, cropHeight);
      } else {
        ctx.drawImage(img, 0, drawY);
      }
    }

    // Export as PNG blob, then convert to data URL so it works cross-context
    var blob = await canvas.convertToBlob({ type: 'image/png' });
    var dataUrl = await blobToDataUrl(blob);

    // Generate filename from URL
    var hostname;
    try {
      hostname = new URL(pageUrl).hostname.replace(/^www\./, '');
    } catch (e) {
      hostname = 'capture';
    }
    var filename = 'capture_' + hostname + '_' + Date.now();

    return { dataUrl: dataUrl, filename: filename };
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
