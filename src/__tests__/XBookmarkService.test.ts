import { describe, it, expect } from 'vitest';
import { isBookmarksUrl, pickBookmarksTab, BOOKMARKS_URL, BOOKMARKS_MATCH_PATTERNS } from '../services/XBookmarkService';

describe('XBookmarkService URL helpers', () => {
  describe('isBookmarksUrl', () => {
    it('should accept the current bookmarks route', () => {
      expect(isBookmarksUrl('https://x.com/i/history')).toBe(true);
      expect(isBookmarksUrl('https://x.com/i/history/')).toBe(true);
      expect(isBookmarksUrl('https://x.com/i/history?foo=1')).toBe(true);
      expect(isBookmarksUrl('https://twitter.com/i/history')).toBe(true);
    });

    it('should accept the legacy bookmarks route', () => {
      expect(isBookmarksUrl('https://x.com/i/bookmarks')).toBe(true);
      expect(isBookmarksUrl('https://x.com/i/bookmarks/')).toBe(true);
      expect(isBookmarksUrl('https://twitter.com/i/bookmarks')).toBe(true);
    });

    it('should reject sibling history tabs', () => {
      expect(isBookmarksUrl('https://x.com/i/history/likes')).toBe(false);
      expect(isBookmarksUrl('https://x.com/i/history/history')).toBe(false);
      expect(isBookmarksUrl('https://x.com/i/history/tweets')).toBe(false);
    });

    it('should reject other pages and invalid input', () => {
      expect(isBookmarksUrl('https://x.com/home')).toBe(false);
      expect(isBookmarksUrl('https://example.com/i/history')).toBe(false);
      expect(isBookmarksUrl('not a url')).toBe(false);
      expect(isBookmarksUrl('')).toBe(false);
      expect(isBookmarksUrl(null)).toBe(false);
      expect(isBookmarksUrl(undefined)).toBe(false);
    });

    it('should match every URL pattern used for tab discovery', () => {
      expect(BOOKMARKS_MATCH_PATTERNS.some(p => p === '*://x.com/i/history*')).toBe(true);
      expect(BOOKMARKS_MATCH_PATTERNS.some(p => p === '*://x.com/i/bookmarks*')).toBe(true);
    });

    it('should use the /i/history route as the canonical fallback URL', () => {
      expect(isBookmarksUrl(BOOKMARKS_URL)).toBe(true);
    });
  });

  describe('pickBookmarksTab', () => {
    it('should pick the tab on the Bookmarks timeline', () => {
      expect(pickBookmarksTab([
        { id: 1, url: 'https://x.com/home' },
        { id: 2, url: 'https://x.com/i/history' },
      ])).toBe(2);
    });

    it('should skip Likes and History sub-tabs', () => {
      expect(pickBookmarksTab([
        { id: 1, url: 'https://x.com/i/history/likes' },
        { id: 2, url: 'https://x.com/i/history/history' },
      ])).toBeNull();
    });

    it('should accept the legacy bookmarks route', () => {
      expect(pickBookmarksTab([
        { id: 7, url: 'https://twitter.com/i/bookmarks' },
      ])).toBe(7);
    });

    it('should return null when no tab has an id', () => {
      expect(pickBookmarksTab([{ url: 'https://x.com/i/history' }])).toBeNull();
    });

    it('should return null for an empty tab list', () => {
      expect(pickBookmarksTab([])).toBeNull();
    });
  });
});
