// Content script for X/Twitter bookmark DOM extraction
// Only runs on x.com/i/bookmarks — responds to messages from background service worker

import type { RawTweetData } from '../src/db/types';

export default defineContentScript({
  matches: ['*://x.com/i/bookmarks*', '*://twitter.com/i/bookmarks*'],
  runAt: 'document_idle',

  main(ctx) {
    /**
     * Extract data from a single tweet article element
     */
    function extractTweetData(article: Element): RawTweetData | null {
      try {
        // Tweet text
        const textEl = article.querySelector('[data-testid="tweetText"]');
        const text = textEl?.textContent || '';

        // Author info: multiline text with display name + @handle
        const userNameEl = article.querySelector('[data-testid="User-Name"]');
        let authorHandle = '';
        let authorName = '';
        if (userNameEl) {
          const parts = userNameEl.textContent?.split('\n') || [];
          // First non-empty part is the display name
          for (const part of parts) {
            const trimmed = part.trim();
            if (!trimmed) continue;
            if (trimmed.startsWith('@')) {
              // Handle may include · and timestamp suffix, take only the @part
              authorHandle = trimmed.split('·')[0]?.trim() || trimmed;
            } else if (!authorName) {
              authorName = trimmed;
            }
          }
        }

        // Timestamp and tweet link via the <time> element
        const timeEl = article.querySelector('time');
        const timestamp = timeEl?.getAttribute('datetime') || '';

        // Find the ancestor <a> of the time element to get the tweet URL
        let tweetUrl = '';
        let tweetId = '';
        const linkEl = timeEl?.closest('a');
        if (linkEl) {
          const href = linkEl.getAttribute('href') || '';
          tweetUrl = href.startsWith('http') ? href : `https://x.com${href}`;
          const match = href.match(/\/status\/(\d+)/);
          if (match && match[1]) {
            tweetId = match[1];
          }
        }

        // Skip if no tweet ID could be extracted
        if (!tweetId) return null;

        // Images (exclude profile images)
        const mediaUrls: string[] = [];
        const photoEls = article.querySelectorAll('[data-testid="tweetPhoto"] img');
        for (const img of photoEls) {
          const src = img.getAttribute('src');
          if (src && !src.includes('profile_images')) {
            mediaUrls.push(src);
          }
        }

        // Video flag
        const hasVideo = !!article.querySelector('[data-testid="videoPlayer"]');

        // Quote tweet flag
        const isQuoteTweet = !!article.querySelector('[data-testid="quoteTweet"]');

        return {
          tweetId,
          authorHandle,
          authorName,
          text,
          timestamp,
          tweetUrl,
          mediaUrls,
          hasVideo,
          isQuoteTweet,
        };
      } catch {
        return null;
      }
    }

    /**
     * Message handler — responds to commands from the background service worker
     */
    const messageHandler = (
      msg: { target?: string; action?: string; tweetId?: string },
      _sender: chrome.runtime.MessageSender,
      sendResponse: (response: unknown) => void,
    ) => {
      // Only handle messages targeted at this content script
      if (msg.target !== 'x-bookmarks-sync') return false;

      switch (msg.action) {
        case 'EXTRACT_TWEETS': {
          const articles = document.querySelectorAll('article[data-testid="tweet"]');
          const tweets: RawTweetData[] = [];
          for (const article of articles) {
            const data = extractTweetData(article);
            if (data) tweets.push(data);
          }
          sendResponse({ tweets });
          break;
        }

        case 'SCROLL_DOWN': {
          window.scrollTo(0, document.body.scrollHeight);
          // Return height after a small delay for scroll to take effect
          setTimeout(() => {
            sendResponse({ scrollHeight: document.body.scrollHeight });
          }, 100);
          return true; // async response
        }

        case 'GET_PAGE_INFO': {
          sendResponse({
            scrollY: window.scrollY,
            scrollHeight: document.body.scrollHeight,
            viewportHeight: window.innerHeight,
          });
          break;
        }

        case 'GET_VIDEO_URL': {
          const articles = document.querySelectorAll('article[data-testid="tweet"]');
          for (const article of articles) {
            const link = article.querySelector('time')?.closest('a');
            const href = link?.getAttribute('href') || '';
            if (href.includes(msg.tweetId || '')) {
              const video = article.querySelector('video');
              sendResponse({ videoUrl: video?.src || null });
              return true;
            }
          }
          sendResponse({ videoUrl: null });
          break;
        }

        default:
          sendResponse({ error: `Unknown action: ${msg.action}` });
      }

      return false;
    };

    chrome.runtime.onMessage.addListener(messageHandler);

    // Cleanup on WXT invalidation
    ctx.onInvalidated(() => {
      chrome.runtime.onMessage.removeListener(messageHandler);
    });
  },
});
