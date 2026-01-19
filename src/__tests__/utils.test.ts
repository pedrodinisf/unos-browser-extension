import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { generateUUID } from '../utils/uuid';
import { normalizeUrl, hashUrlSync } from '../utils/hash';
import { debounce, throttle } from '../utils/debounce';

describe('UUID Utils', () => {
  describe('generateUUID', () => {
    it('should generate a valid UUID v4 format', () => {
      const uuid = generateUUID();
      // UUID v4 format: xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx
      const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
      expect(uuid).toMatch(uuidRegex);
    });

    it('should generate unique UUIDs', () => {
      const uuids = new Set<string>();
      for (let i = 0; i < 1000; i++) {
        uuids.add(generateUUID());
      }
      expect(uuids.size).toBe(1000);
    });

    it('should have correct version number (4)', () => {
      const uuid = generateUUID();
      const versionChar = uuid.charAt(14);
      expect(versionChar).toBe('4');
    });

    it('should have correct variant bits (8, 9, a, or b)', () => {
      const uuid = generateUUID();
      const variantChar = uuid.charAt(19).toLowerCase();
      expect(['8', '9', 'a', 'b']).toContain(variantChar);
    });
  });
});

describe('Hash Utils', () => {
  describe('normalizeUrl', () => {
    it('should remove URL fragments', () => {
      const url = 'https://example.com/page#section';
      const normalized = normalizeUrl(url);
      expect(normalized).toBe('https://example.com/page');
    });

    it('should lowercase hostname', () => {
      const url = 'https://EXAMPLE.COM/Page';
      const normalized = normalizeUrl(url);
      expect(normalized).toContain('example.com');
    });

    it('should remove trailing slash from paths', () => {
      const url = 'https://example.com/page/';
      const normalized = normalizeUrl(url);
      expect(normalized).toBe('https://example.com/page');
    });

    it('should keep trailing slash for root path', () => {
      const url = 'https://example.com/';
      const normalized = normalizeUrl(url);
      expect(normalized).toBe('https://example.com/');
    });

    it('should return invalid URLs as-is', () => {
      const url = 'not a valid url';
      const normalized = normalizeUrl(url);
      expect(normalized).toBe(url);
    });

    it('should preserve query parameters', () => {
      const url = 'https://example.com/search?q=test&page=1';
      const normalized = normalizeUrl(url);
      expect(normalized).toContain('q=test');
      expect(normalized).toContain('page=1');
    });
  });

  describe('hashUrlSync', () => {
    it('should return consistent hash for same URL', () => {
      const url = 'https://example.com/page';
      const hash1 = hashUrlSync(url);
      const hash2 = hashUrlSync(url);
      expect(hash1).toBe(hash2);
    });

    it('should return different hash for different URLs', () => {
      const hash1 = hashUrlSync('https://example.com/page1');
      const hash2 = hashUrlSync('https://example.com/page2');
      expect(hash1).not.toBe(hash2);
    });

    it('should return 8-character hex string', () => {
      const hash = hashUrlSync('https://example.com');
      expect(hash).toMatch(/^[0-9a-f]{8}$/);
    });

    it('should normalize URLs before hashing', () => {
      const hash1 = hashUrlSync('https://EXAMPLE.COM/page#section');
      const hash2 = hashUrlSync('https://example.com/page');
      expect(hash1).toBe(hash2);
    });

    it('should handle empty string', () => {
      const hash = hashUrlSync('');
      expect(hash).toMatch(/^[0-9a-f]{8}$/);
    });
  });
});

describe('Debounce Utils', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('debounce', () => {
    it('should delay function execution', () => {
      const fn = vi.fn();
      const debounced = debounce(fn, 100);

      debounced();
      expect(fn).not.toHaveBeenCalled();

      vi.advanceTimersByTime(50);
      expect(fn).not.toHaveBeenCalled();

      vi.advanceTimersByTime(50);
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('should only call once for rapid calls', () => {
      const fn = vi.fn();
      const debounced = debounce(fn, 100);

      debounced();
      debounced();
      debounced();

      vi.advanceTimersByTime(100);
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('should pass latest arguments', () => {
      const fn = vi.fn();
      const debounced = debounce(fn, 100);

      debounced(1);
      debounced(2);
      debounced(3);

      vi.advanceTimersByTime(100);
      expect(fn).toHaveBeenCalledWith(3);
    });

    it('should call on leading edge when option set', () => {
      const fn = vi.fn();
      const debounced = debounce(fn, 100, { leading: true, trailing: false });

      debounced();
      expect(fn).toHaveBeenCalledTimes(1);

      debounced();
      vi.advanceTimersByTime(100);
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('should cancel pending call', () => {
      const fn = vi.fn();
      const debounced = debounce(fn, 100);

      debounced();
      debounced.cancel();

      vi.advanceTimersByTime(100);
      expect(fn).not.toHaveBeenCalled();
    });

    it('should flush pending call immediately', () => {
      const fn = vi.fn();
      const debounced = debounce(fn, 100);

      debounced();
      debounced.flush();

      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('should report pending status', () => {
      const fn = vi.fn();
      const debounced = debounce(fn, 100);

      expect(debounced.pending()).toBe(false);

      debounced();
      expect(debounced.pending()).toBe(true);

      vi.advanceTimersByTime(100);
      expect(debounced.pending()).toBe(false);
    });

    it('should respect maxWait option', () => {
      const fn = vi.fn();
      const debounced = debounce(fn, 100, { maxWait: 150 });

      debounced();
      vi.advanceTimersByTime(50);
      debounced();
      vi.advanceTimersByTime(50);
      debounced();
      vi.advanceTimersByTime(50);

      // Should have been called due to maxWait
      expect(fn).toHaveBeenCalledTimes(1);
    });
  });

  describe('throttle', () => {
    it('should call immediately on first call (leading edge)', () => {
      const fn = vi.fn();
      const throttled = throttle(fn, 100);

      throttled();
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('should throttle subsequent calls', () => {
      const fn = vi.fn();
      const throttled = throttle(fn, 100);

      throttled();
      throttled();
      throttled();

      expect(fn).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(100);
      expect(fn).toHaveBeenCalledTimes(2); // trailing call
    });

    it('should call again after wait period', () => {
      const fn = vi.fn();
      const throttled = throttle(fn, 100);

      throttled();
      vi.advanceTimersByTime(100);

      throttled();
      expect(fn).toHaveBeenCalledTimes(2);
    });

    it('should respect trailing option', () => {
      const fn = vi.fn();
      const throttled = throttle(fn, 100, { trailing: false });

      throttled();
      throttled();
      throttled();

      vi.advanceTimersByTime(100);
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('should respect leading option', () => {
      const fn = vi.fn();
      const throttled = throttle(fn, 100, { leading: false });

      throttled();
      expect(fn).not.toHaveBeenCalled();

      vi.advanceTimersByTime(100);
      expect(fn).toHaveBeenCalledTimes(1);
    });
  });
});

describe('AllWindowsView Helpers', () => {
  // Test helper functions used in AllWindowsView
  describe('formatTime', () => {
    function formatTime(ms: number): string {
      const minutes = Math.floor(ms / 60000);
      if (minutes < 60) return `${minutes}m`;
      const hours = Math.floor(minutes / 60);
      return `${hours}h${minutes % 60}m`;
    }

    it('should format minutes correctly', () => {
      expect(formatTime(60000)).toBe('1m');
      expect(formatTime(300000)).toBe('5m');
      expect(formatTime(0)).toBe('0m');
    });

    it('should format hours and minutes', () => {
      expect(formatTime(3600000)).toBe('1h0m');
      expect(formatTime(5400000)).toBe('1h30m');
      expect(formatTime(7200000)).toBe('2h0m');
    });

    it('should handle large values', () => {
      expect(formatTime(86400000)).toBe('24h0m'); // 24 hours
    });
  });

  describe('getDomain', () => {
    function getDomain(url: string): string {
      try {
        return new URL(url).hostname.replace('www.', '');
      } catch {
        return url;
      }
    }

    it('should extract domain from URL', () => {
      expect(getDomain('https://example.com/page')).toBe('example.com');
      expect(getDomain('https://www.example.com/page')).toBe('example.com');
    });

    it('should handle subdomains', () => {
      expect(getDomain('https://sub.example.com')).toBe('sub.example.com');
    });

    it('should return original for invalid URLs', () => {
      expect(getDomain('not a url')).toBe('not a url');
    });

    it('should handle chrome:// URLs', () => {
      expect(getDomain('chrome://extensions/')).toBe('extensions');
    });
  });
});
