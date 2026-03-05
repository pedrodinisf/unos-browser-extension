export default defineContentScript({
  matches: ['<all_urls>'],
  runAt: 'document_idle',

  main(ctx) {
    let enabled = false;
    let grepStr = '';
    let grepStrLower = '';

    // O(1) dedup: tracks every normalized URL already committed to storage.
    // Pre-populated on init and kept in sync via storage.onChanged.
    const knownUrls = new Set<string>();

    // Guard against concurrent storage writes for the same URL.
    const pendingUrls = new Set<string>();

    function normalizeUrl(url: string): string {
      try {
        const urlObj = new URL(url);
        if (urlObj.pathname.length > 1 && urlObj.pathname.endsWith('/')) {
          urlObj.pathname = urlObj.pathname.slice(0, -1);
        }
        if ((urlObj.protocol === 'http:' && urlObj.port === '80') ||
            (urlObj.protocol === 'https:' && urlObj.port === '443')) {
          urlObj.port = '';
        }
        return urlObj.href;
      } catch {
        return url;
      }
    }

    function isValidUrl(url: string): boolean {
      if (!url) return false;
      return url.startsWith('http://') || url.startsWith('https://');
    }

    // Initialize settings + pre-populate knownUrls from storage
    chrome.storage.local.get(
      ['urlGrepper_enabled', 'urlGrepper_grepStr', 'urlGrepper_urlList'],
      (data) => {
        enabled = !!data.urlGrepper_enabled;
        grepStr = data.urlGrepper_grepStr || '';
        grepStrLower = grepStr.toLowerCase();
        const list: string[] = data.urlGrepper_urlList || [];
        for (const url of list) knownUrls.add(url);
      },
    );

    // Listen for storage changes (settings + cross-tab sync)
    const storageListener = (changes: { [key: string]: chrome.storage.StorageChange }, area: string) => {
      if (area !== 'local') return;
      if (changes.urlGrepper_enabled !== undefined) {
        enabled = !!changes.urlGrepper_enabled.newValue;
      }
      if (changes.urlGrepper_grepStr !== undefined) {
        grepStr = changes.urlGrepper_grepStr.newValue || '';
        grepStrLower = grepStr.toLowerCase();
      }
      if (changes.urlGrepper_urlList !== undefined) {
        // Sync knownUrls with the authoritative storage list.
        // Handles additions from other tabs and clears from the popup.
        const newList: string[] = changes.urlGrepper_urlList.newValue || [];
        knownUrls.clear();
        for (const url of newList) knownUrls.add(url);
      }
    };
    chrome.storage.onChanged.addListener(storageListener);

    const mouseoverHandler = (e: MouseEvent) => {
      if (!enabled) return;

      const link = (e.target as HTMLElement).closest('a[href]') as HTMLAnchorElement | null;
      if (!link) return;

      const href = link.href;
      if (!isValidUrl(href)) return;

      // Grep filter on raw href (empty grep matches everything)
      if (grepStr && !href.toLowerCase().includes(grepStrLower)) return;

      const normalizedUrl = normalizeUrl(href);

      // O(1) dedup — skip if already known or in-flight
      if (knownUrls.has(normalizedUrl) || pendingUrls.has(normalizedUrl)) return;

      pendingUrls.add(normalizedUrl);

      chrome.storage.local.get('urlGrepper_urlList', (res) => {
        pendingUrls.delete(normalizedUrl);

        if (chrome.runtime.lastError) return;

        const list: string[] = res.urlGrepper_urlList || [];
        // Safety net: storage may have been updated by another tab
        if (list.includes(normalizedUrl)) {
          knownUrls.add(normalizedUrl);
          return;
        }

        list.push(normalizedUrl);
        chrome.storage.local.set({ urlGrepper_urlList: list }, () => {
          if (!chrome.runtime.lastError) {
            knownUrls.add(normalizedUrl);
          }
        });
      });
    };

    document.addEventListener('mouseover', mouseoverHandler, true);

    // Cleanup on invalidation (WXT lifecycle)
    ctx.onInvalidated(() => {
      document.removeEventListener('mouseover', mouseoverHandler, true);
      chrome.storage.onChanged.removeListener(storageListener);
    });
  },
});
