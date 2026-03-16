(function() {
    'use strict';
  
    let enabled = false;
    let grepStr = '';
    let grepStrLower = ''; // Cache lowercase version for case-insensitive matching
  
    // Normalize URL to avoid duplicates (e.g., trailing slash variations)
    function normalizeUrl(url) {
      try {
        const urlObj = new URL(url);
        // Remove trailing slash from pathname (except root)
        if (urlObj.pathname.length > 1 && urlObj.pathname.endsWith('/')) {
          urlObj.pathname = urlObj.pathname.slice(0, -1);
        }
        // Remove default ports
        if ((urlObj.protocol === 'http:' && urlObj.port === '80') ||
            (urlObj.protocol === 'https:' && urlObj.port === '443')) {
          urlObj.port = '';
        }
        return urlObj.href;
      } catch (e) {
        // If URL parsing fails, return original
        return url;
      }
    }
  
    // Check if URL should be processed
    function isValidUrl(url) {
      if (!url) return false;
      // Skip non-http/https protocols, fragments, and special protocols
      return url.startsWith('http://') || url.startsWith('https://');
    }
  
    // Initialize settings
    function initSettings() {
      chrome.storage.local.get(['enabled', 'grepStr'], function(data) {
        enabled = !!data.enabled;
        grepStr = data.grepStr || '';
        grepStrLower = grepStr.toLowerCase();
      });
    }
  
    // Listen for storage changes
    chrome.storage.onChanged.addListener(function(changes, area) {
      if (area === 'local') {
        if (changes.enabled !== undefined) {
          enabled = !!changes.enabled.newValue;
        }
        if (changes.grepStr !== undefined) {
          grepStr = changes.grepStr.newValue || '';
          grepStrLower = grepStr.toLowerCase();
        }
      }
    });
  
    initSettings();
  
    // Track currently hovered links to avoid duplicates during hover
    const hoveredLinks = new WeakSet();
    // Track URLs currently being processed to prevent race conditions
    const processingUrls = new Set();
  
    // Optimized mouseover handler with early returns
    document.addEventListener('mouseover', function(e) {
      // Early return if disabled
      if (!enabled) {
        return;
      }
  
      const link = e.target.closest('a[href]');
      if (!link || hoveredLinks.has(link)) {
        return;
      }
  
      const href = link.href;
      if (!isValidUrl(href)) {
        return;
      }
  
      hoveredLinks.add(link);
  
      // Case-insensitive matching (empty grep string matches everything)
      if (grepStr) {
        const hrefLower = href.toLowerCase();
        if (!hrefLower.includes(grepStrLower)) {
          return;
        }
      }

      const normalizedUrl = normalizeUrl(href);

      // Skip if this URL is already being processed
      if (processingUrls.has(normalizedUrl)) {
        return;
      }

      // Mark URL as being processed
      processingUrls.add(normalizedUrl);

      // Add to list if not already present
      chrome.storage.local.get('urlList', function(res) {
        // Handle errors and ensure cleanup
        const cleanup = () => processingUrls.delete(normalizedUrl);

        try {
          if (chrome.runtime.lastError) {
            console.error('Storage error:', chrome.runtime.lastError);
            cleanup();
            return;
          }

          const list = res.urlList || [];
          if (!list.includes(normalizedUrl)) {
            list.push(normalizedUrl);
            chrome.storage.local.set({ urlList: list }, function() {
              if (chrome.runtime.lastError) {
                console.error('Save error:', chrome.runtime.lastError);
              }
              cleanup();
            });
          } else {
            cleanup();
          }
        } catch (error) {
          console.error('Error processing URL:', error);
          cleanup();
        }
      });
    }, true);
  
    // Clear hover tracking on mouseout
    document.addEventListener('mouseout', function(e) {
      const link = e.target.closest('a[href]');
      if (link) {
        hoveredLinks.delete(link);
      }
    }, true);
  
  })();
