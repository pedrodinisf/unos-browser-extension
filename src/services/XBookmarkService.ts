import { getDatabase } from '../db/schema';
import type { XBookmark, XBookmarkMetrics, XSyncState, RawTweetData } from '../db/types';

const SCROLL_DELAY_MS = 2000;
const CONSECUTIVE_KNOWN_THRESHOLD = 5;
const NO_NEW_CONTENT_MAX = 3;
const TAB_LOAD_TIMEOUT_MS = 30000;
const X_JS_RENDER_DELAY_MS = 3000;

/**
 * Send a message to the X bookmarks content script in a specific tab
 */
function sendToContentScript(
  tabId: number,
  action: string,
  data?: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(
      tabId,
      { target: 'x-bookmarks-sync', action, ...data },
      (response) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else if (response?.error) {
          reject(new Error(response.error as string));
        } else {
          resolve(response as Record<string, unknown>);
        }
      },
    );
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * XBookmarkService — orchestrates X/Twitter bookmark syncing
 *
 * Runs in the background service worker. Communicates with the content script
 * on x.com/i/bookmarks for DOM extraction and scroll commands.
 */
export class XBookmarkService {
  private syncInProgress = false;

  constructor() {
    // Clear stale sync state from a previous service worker lifecycle
    chrome.storage.local.get('xBookmarks_syncStatus', (data) => {
      if (data.xBookmarks_syncStatus === 'syncing' || data.xBookmarks_syncStatus === 'starting') {
        chrome.storage.local.set({ xBookmarks_syncStatus: 'idle' });
      }
    });
  }

  /**
   * Sync bookmarks from X. Fire-and-forget from the caller's perspective;
   * progress is reported via chrome.storage.local.
   */
  async syncBookmarks(options?: { fullSync?: boolean }): Promise<{ newCount: number; total: number }> {
    if (this.syncInProgress) {
      return { newCount: 0, total: 0 };
    }

    this.syncInProgress = true;
    const startTime = Date.now();

    try {
      await this.setProgress('starting', 0);

      // Find or create the bookmarks tab
      const tabId = await this.findOrCreateBookmarksTab();
      await this.waitForTabLoad(tabId);
      await sleep(X_JS_RENDER_DELAY_MS);

      // Load known tweet IDs from Dexie
      const db = getDatabase();
      const existingBookmarks = await db.xBookmarks.toArray();
      const knownIds = options?.fullSync
        ? new Set<string>()
        : new Set(existingBookmarks.map((b) => b.tweetId));

      // Sync loop
      let consecutiveKnown = 0;
      let lastHeight = 0;
      let noNewContentCount = 0;
      const extracted = new Map<string, RawTweetData>();

      // Track which tweet IDs we've already processed this sync to avoid
      // double-counting when X keeps old articles in the DOM after scrolling
      const processedThisSync = new Set<string>();

      while (true) {
        // Extract visible tweets
        let result: Record<string, unknown>;
        try {
          result = await sendToContentScript(tabId, 'EXTRACT_TWEETS');
        } catch (err) {
          console.error('[UNOS] X Bookmarks: Failed to extract tweets:', err);
          break;
        }

        const tweets = (result.tweets || []) as RawTweetData[];

        for (const tweet of tweets) {
          if (!tweet.tweetId) continue;

          // Skip tweets we already processed in this sync (still in DOM from earlier scroll)
          if (processedThisSync.has(tweet.tweetId)) continue;
          processedThisSync.add(tweet.tweetId);

          if (knownIds.has(tweet.tweetId)) {
            consecutiveKnown++;
          } else {
            extracted.set(tweet.tweetId, tweet);
            consecutiveKnown = 0;
          }
        }

        // Update progress
        await this.setProgress('syncing', extracted.size);

        // Incremental stop: found N consecutive known bookmarks
        if (!options?.fullSync && consecutiveKnown >= CONSECUTIVE_KNOWN_THRESHOLD) {
          console.log(`[UNOS] X Bookmarks: Incremental stop after ${consecutiveKnown} consecutive known`);
          break;
        }

        // Scroll down
        try {
          await sendToContentScript(tabId, 'SCROLL_DOWN');

          // Wait for X to load new content BEFORE measuring height
          await sleep(SCROLL_DELAY_MS);

          // Measure height AFTER the delay so new content is reflected
          const pageInfo = await sendToContentScript(tabId, 'GET_PAGE_INFO');
          const newHeight = pageInfo.scrollHeight as number;

          // Check if page grew
          if (newHeight === lastHeight) {
            noNewContentCount++;
            if (noNewContentCount >= NO_NEW_CONTENT_MAX) {
              console.log('[UNOS] X Bookmarks: Reached bottom of page');
              break;
            }
          } else {
            noNewContentCount = 0;
          }
          lastHeight = newHeight;
        } catch (err) {
          console.error('[UNOS] X Bookmarks: Scroll failed:', err);
          break;
        }
      }

      // Merge results into Dexie
      const now = Date.now();
      let newCount = 0;

      for (const [tweetId, tweet] of extracted) {
        const existing = await db.xBookmarks.where('tweetId').equals(tweetId).first();

        if (existing) {
          // Update lastSeenAt and content — preserve user metadata (tags, notes, categories)
          await db.xBookmarks.where('tweetId').equals(tweetId).modify({
            lastSeenAt: now,
            // Backfill author info if newly extracted (fixes empty handles from older syncs)
            ...(tweet.authorHandle ? { authorHandle: tweet.authorHandle } : {}),
            ...(tweet.authorName ? { authorName: tweet.authorName } : {}),
            // Update content in case tweet was edited
            text: tweet.text,
            mediaUrls: tweet.mediaUrls,
            hasVideo: tweet.hasVideo,
            isQuoteTweet: tweet.isQuoteTweet,
          });
        } else {
          await db.xBookmarks.add({
            tweetId: tweet.tweetId,
            authorHandle: tweet.authorHandle,
            authorName: tweet.authorName,
            text: tweet.text,
            timestamp: tweet.timestamp,
            tweetUrl: tweet.tweetUrl,
            mediaUrls: tweet.mediaUrls,
            hasVideo: tweet.hasVideo,
            isQuoteTweet: tweet.isQuoteTweet,
            firstSeenAt: now,
            lastSeenAt: now,
            categories: [],
            tags: [],
            notes: '',
            archived: false,
          });
          newCount++;
        }
      }

      // Update sync state
      const totalBookmarks = await db.xBookmarks.count();
      const prevState = await db.xSyncState.get(1);
      await db.xSyncState.put({
        id: 1,
        lastSyncAt: now,
        totalBookmarks,
        lastSyncNewCount: newCount,
        lastSyncDurationMs: Date.now() - startTime,
        syncCount: (prevState?.syncCount || 0) + 1,
      });

      await this.setProgress('done', newCount);
      console.log(`[UNOS] X Bookmarks: Sync complete. ${newCount} new, ${totalBookmarks} total`);

      return { newCount, total: totalBookmarks };
    } catch (err) {
      console.error('[UNOS] X Bookmarks: Sync error:', err);
      await this.setProgress('error', 0, err instanceof Error ? err.message : String(err));
      return { newCount: 0, total: 0 };
    } finally {
      this.syncInProgress = false;
    }
  }

  /**
   * Get bookmarks with optional filtering, sorting, and pagination
   */
  async getBookmarks(options?: {
    includeArchived?: boolean;
    page?: number;
    limit?: number;
    search?: string;
    sortBy?: 'firstSeenAt' | 'timestamp' | 'authorHandle';
    sortOrder?: 'asc' | 'desc';
    filters?: {
      hasMedia?: boolean;
      hasVideo?: boolean;
      hasTags?: boolean;
    };
  }): Promise<XBookmark[]> {
    const db = getDatabase();
    const limit = options?.limit || 100;
    const page = options?.page || 1;
    const offset = (page - 1) * limit;

    let results = await db.xBookmarks.toArray();

    // Filter archived
    if (!options?.includeArchived) {
      results = results.filter((b) => !b.archived);
    }

    // Search filter
    if (options?.search) {
      const query = options.search.toLowerCase();
      results = results.filter(
        (b) =>
          b.text.toLowerCase().includes(query) ||
          b.authorHandle.toLowerCase().includes(query) ||
          b.authorName.toLowerCase().includes(query),
      );
    }

    // Content filters
    if (options?.filters) {
      if (options.filters.hasMedia) {
        results = results.filter((b) => b.mediaUrls.length > 0);
      }
      if (options.filters.hasVideo) {
        results = results.filter((b) => b.hasVideo);
      }
      if (options.filters.hasTags) {
        results = results.filter((b) => b.tags.length > 0);
      }
    }

    // Sort
    const sortBy = options?.sortBy || 'firstSeenAt';
    const sortOrder = options?.sortOrder || 'desc';
    results.sort((a, b) => {
      let cmp = 0;
      switch (sortBy) {
        case 'firstSeenAt':
          cmp = a.firstSeenAt - b.firstSeenAt;
          break;
        case 'timestamp':
          cmp = (a.timestamp || '').localeCompare(b.timestamp || '');
          break;
        case 'authorHandle':
          cmp = a.authorHandle.toLowerCase().localeCompare(b.authorHandle.toLowerCase());
          break;
      }
      return sortOrder === 'desc' ? -cmp : cmp;
    });

    // Paginate
    return results.slice(offset, offset + limit);
  }

  /**
   * Get total bookmark count (for pagination)
   */
  async getBookmarkCount(options?: {
    includeArchived?: boolean;
    search?: string;
    filters?: {
      hasMedia?: boolean;
      hasVideo?: boolean;
      hasTags?: boolean;
    };
  }): Promise<number> {
    const db = getDatabase();
    let results = await db.xBookmarks.toArray();

    if (!options?.includeArchived) {
      results = results.filter((b) => !b.archived);
    }

    if (options?.search) {
      const query = options.search.toLowerCase();
      results = results.filter(
        (b) =>
          b.text.toLowerCase().includes(query) ||
          b.authorHandle.toLowerCase().includes(query) ||
          b.authorName.toLowerCase().includes(query),
      );
    }

    if (options?.filters) {
      if (options.filters.hasMedia) {
        results = results.filter((b) => b.mediaUrls.length > 0);
      }
      if (options.filters.hasVideo) {
        results = results.filter((b) => b.hasVideo);
      }
      if (options.filters.hasTags) {
        results = results.filter((b) => b.tags.length > 0);
      }
    }

    return results.length;
  }

  /**
   * Soft-delete a bookmark
   */
  async archiveBookmark(tweetId: string): Promise<void> {
    const db = getDatabase();
    await db.xBookmarks.where('tweetId').equals(tweetId).modify({ archived: true });
  }

  /**
   * Restore an archived bookmark
   */
  async unarchiveBookmark(tweetId: string): Promise<void> {
    const db = getDatabase();
    await db.xBookmarks.where('tweetId').equals(tweetId).modify({ archived: false });
  }

  /**
   * Update bookmark metadata (tags, notes, categories)
   */
  async updateBookmarkMeta(
    tweetId: string,
    data: { tags?: string[]; notes?: string; categories?: string[] },
  ): Promise<void> {
    const db = getDatabase();
    const updates: Partial<XBookmark> = {};
    if (data.tags !== undefined) updates.tags = data.tags;
    if (data.notes !== undefined) updates.notes = data.notes;
    if (data.categories !== undefined) updates.categories = data.categories;
    await db.xBookmarks.where('tweetId').equals(tweetId).modify(updates);
  }

  /**
   * Get current sync state
   */
  async getSyncState(): Promise<XSyncState | null> {
    const db = getDatabase();
    return (await db.xSyncState.get(1)) || null;
  }

  /**
   * Export bookmarks as JSON
   */
  async exportAsJSON(): Promise<{ data: string; filename: string }> {
    const db = getDatabase();
    const bookmarks = await db.xBookmarks.filter((b) => !b.archived).toArray();
    const data = JSON.stringify(bookmarks, null, 2);
    const date = new Date().toISOString().split('T')[0];
    return { data, filename: `x-bookmarks-${date}.json` };
  }

  /**
   * Export bookmarks as Markdown
   */
  async exportAsMarkdown(): Promise<{ data: string; filename: string }> {
    const db = getDatabase();
    const bookmarks = await db.xBookmarks.orderBy('timestamp').reverse().toArray();
    const activeBookmarks = bookmarks.filter((b) => !b.archived);

    // Group by month
    const byMonth = new Map<string, XBookmark[]>();
    for (const bm of activeBookmarks) {
      const month = bm.timestamp ? bm.timestamp.substring(0, 7) : 'unknown';
      if (!byMonth.has(month)) byMonth.set(month, []);
      byMonth.get(month)!.push(bm);
    }

    // Build markdown
    const lines: string[] = [];
    lines.push('# X Bookmarks Export');
    lines.push('');
    lines.push(`**Total bookmarks:** ${activeBookmarks.length}`);
    lines.push(`**Archived:** ${bookmarks.length - activeBookmarks.length}`);
    lines.push(`**Export date:** ${new Date().toISOString()}`);
    lines.push('');
    lines.push('---');
    lines.push('');

    for (const [month, bms] of byMonth) {
      lines.push(`## ${month}`);
      lines.push('');
      for (const bm of bms) {
        lines.push(`### ${bm.authorName} (${bm.authorHandle})`);
        lines.push('');
        lines.push(bm.text);
        lines.push('');
        if (bm.mediaUrls.length > 0) {
          for (const url of bm.mediaUrls) {
            lines.push(`![media](${url})`);
          }
          lines.push('');
        }
        if (bm.hasVideo) lines.push('*Contains video*');
        if (bm.tags.length > 0) lines.push(`Tags: ${bm.tags.join(', ')}`);
        if (bm.notes) lines.push(`Notes: ${bm.notes}`);
        lines.push(`[View on X](${bm.tweetUrl}) | ${bm.timestamp}`);
        lines.push('');
        lines.push('---');
        lines.push('');
      }
    }

    const date = new Date().toISOString().split('T')[0];
    return { data: lines.join('\n'), filename: `x-bookmarks-${date}.md` };
  }

  /**
   * Compute aggregated metrics for the LOG tab
   */
  async getMetrics(): Promise<XBookmarkMetrics> {
    const db = getDatabase();
    const all = await db.xBookmarks.toArray();
    const active = all.filter((b) => !b.archived);
    const totalArchived = all.length - active.length;

    // Single-pass aggregation
    const authorMap = new Map<string, { name: string; count: number }>();
    const weekBuckets = new Map<string, number>();
    const monthBuckets = new Map<string, number>();
    let mediaCount = 0;
    let videoCount = 0;
    let taggedCount = 0;
    let quoteCount = 0;
    let textOnly = 0;
    let withImages = 0;
    let withVideo = 0;
    let earliestSeen = Infinity;

    for (const b of active) {
      // Authors (skip empty or @-only handles)
      const handle = b.authorHandle?.trim();
      if (handle && handle !== '@') {
        const existing = authorMap.get(handle);
        if (existing) {
          existing.count++;
        } else {
          authorMap.set(handle, { name: b.authorName, count: 1 });
        }
      }

      // Counters
      const hasMedia = b.mediaUrls.length > 0;
      if (hasMedia) mediaCount++;
      if (b.hasVideo) videoCount++;
      if (b.tags.length > 0) taggedCount++;
      if (b.isQuoteTweet) quoteCount++;

      // Content composition (mutually exclusive: video > images > text)
      if (b.hasVideo) {
        withVideo++;
      } else if (hasMedia) {
        withImages++;
      } else {
        textOnly++;
      }

      // Acquisition week bucket (by firstSeenAt)
      if (b.firstSeenAt < earliestSeen) earliestSeen = b.firstSeenAt;
      const wk = getWeekStart(b.firstSeenAt);
      weekBuckets.set(wk, (weekBuckets.get(wk) || 0) + 1);

      // Tweet age month bucket (by timestamp ISO string)
      if (b.timestamp) {
        const month = b.timestamp.substring(0, 7); // "YYYY-MM"
        monthBuckets.set(month, (monthBuckets.get(month) || 0) + 1);
      }
    }

    const total = active.length;
    const pct = (n: number) => (total > 0 ? Math.round((n / total) * 1000) / 10 : 0);

    // Weeks since first bookmark
    const weeksSinceFirst =
      total > 0 ? Math.max(1, (Date.now() - earliestSeen) / (7 * 24 * 60 * 60 * 1000)) : 1;

    // Acquisition timeline: last 12 weeks
    const acquisitionTimeline: XBookmarkMetrics['acquisitionTimeline'] = [];
    const now = new Date();
    for (let i = 11; i >= 0; i--) {
      const d = new Date(now);
      d.setUTCDate(d.getUTCDate() - i * 7);
      const wk = getWeekStart(d.getTime());
      const label = formatWeekLabel(wk);
      acquisitionTimeline.push({ weekLabel: label, count: weekBuckets.get(wk) || 0 });
    }

    // Top 8 authors
    const topAuthors = [...authorMap.entries()]
      .map(([handle, { name, count }]) => ({ handle, name, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 8);

    // Tweet age: last 12 months with data, newest first
    const tweetAgeDistribution = [...monthBuckets.entries()]
      .sort((a, b) => b[0].localeCompare(a[0]))
      .slice(0, 12)
      .map(([monthLabel, count]) => ({ monthLabel, count }));

    return {
      summary: {
        totalBookmarks: total,
        totalArchived,
        uniqueAuthors: authorMap.size,
        bookmarksPerWeek: Math.round((total / weeksSinceFirst) * 10) / 10,
        mediaPercent: pct(mediaCount),
        videoPercent: pct(videoCount),
        taggedPercent: pct(taggedCount),
        quoteTweetPercent: pct(quoteCount),
      },
      acquisitionTimeline,
      topAuthors,
      contentComposition: { textOnly, withImages, withVideo },
      tweetAgeDistribution,
    };
  }

  // ── Private helpers ──

  private async findOrCreateBookmarksTab(): Promise<number> {
    const tabs = await chrome.tabs.query({
      url: ['*://x.com/i/bookmarks*', '*://twitter.com/i/bookmarks*'],
    });

    const firstTab = tabs[0];
    if (firstTab && firstTab.id) {
      return firstTab.id;
    }

    // Create a new tab (not active so it doesn't steal focus)
    const newTab = await chrome.tabs.create({
      url: 'https://x.com/i/bookmarks',
      active: false,
    });

    if (!newTab.id) throw new Error('Failed to create bookmarks tab');
    return newTab.id;
  }

  private async waitForTabLoad(tabId: number): Promise<void> {
    const deadline = Date.now() + TAB_LOAD_TIMEOUT_MS;

    while (Date.now() < deadline) {
      const tab = await chrome.tabs.get(tabId);
      if (tab.status === 'complete') return;
      await sleep(500);
    }

    console.warn('[UNOS] X Bookmarks: Tab load timed out, proceeding anyway');
  }

  private async setProgress(
    status: string,
    newCount: number,
    error?: string,
  ): Promise<void> {
    const update: Record<string, unknown> = {
      xBookmarks_syncStatus: status,
      xBookmarks_syncNewCount: newCount,
    };
    if (error) update.xBookmarks_syncError = error;
    await chrome.storage.local.set(update);
  }
}

/** Get ISO date string (YYYY-MM-DD) of the Monday of the week containing `ms` (UTC) */
function getWeekStart(ms: number): string {
  const d = new Date(ms);
  const day = d.getUTCDay(); // 0=Sun..6=Sat
  d.setUTCDate(d.getUTCDate() - ((day + 6) % 7));
  return d.toISOString().substring(0, 10);
}

/** Format a YYYY-MM-DD week start as "Mon DD" */
function formatWeekLabel(isoDate: string): string {
  const d = new Date(isoDate + 'T00:00:00Z');
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${months[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

// Singleton
let instance: XBookmarkService | null = null;

export function getXBookmarkService(): XBookmarkService {
  if (!instance) instance = new XBookmarkService();
  return instance;
}
