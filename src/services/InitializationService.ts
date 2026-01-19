import { getDatabase } from '../db/schema';
import { getStorageManager } from './StorageManager';
import { generateUUID } from '../utils/uuid';
import { calculateSessionExpiry } from '../constants';
import type { Session, TrackedWindow, TrackedTab } from '../db/types';
import { hashUrl } from '../utils/hash';

/**
 * Robust initialization service that ensures data is properly stored
 */
export class InitializationService {
  private static instance: InitializationService | null = null;
  private initializationComplete = false;
  private initPromise: Promise<void> | null = null;

  static getInstance(): InitializationService {
    if (!InitializationService.instance) {
      InitializationService.instance = new InitializationService();
    }
    return InitializationService.instance;
  }

  async initialize(): Promise<void> {
    if (this.initializationComplete) {
      console.log('[Init] Already initialized');
      return;
    }

    if (this.initPromise) {
      console.log('[Init] Initialization in progress, waiting...');
      return this.initPromise;
    }

    this.initPromise = this.doInitialize();
    await this.initPromise;
  }

  private async doInitialize(): Promise<void> {
    console.log('[Init] Starting initialization...');

    try {
      const db = getDatabase();
      console.log('[Init] Database instance created');

      // Test database write
      await this.testDatabaseWrite();

      // Get or create session
      const session = await this.ensureSession();
      console.log('[Init] Session ready:', session.id);

      // Reconcile all open windows and tabs
      await this.reconcileAllTabsAndWindows(session.id);

      // Cleanup duplicate tabs (one-time operation on startup)
      await this.cleanupDuplicateTabs();

      // Initialize storage manager working state (but don't reconcile again)
      const storageManager = getStorageManager();
      await storageManager.initializeWorkingState(session.id);

      this.initializationComplete = true;
      console.log('[Init] ✓ Initialization complete');
    } catch (error) {
      console.error('[Init] ✗ Initialization failed:', error);
      throw error;
    }
  }

  private async testDatabaseWrite(): Promise<void> {
    console.log('[Init] Testing database write...');
    const db = getDatabase();

    try {
      // Try to count sessions
      const count = await db.sessions.count();
      console.log('[Init] Database accessible, session count:', count);
    } catch (error) {
      console.error('[Init] Database test failed:', error);
      throw new Error('Database not accessible: ' + (error instanceof Error ? error.message : String(error)));
    }
  }

  private async ensureSession(): Promise<Session> {
    const db = getDatabase();
    const now = Date.now();
    const oneHourAgo = now - 60 * 60 * 1000;

    // Find all active sessions sorted by start time (most recent first)
    const activeSessions = await db.sessions
      .where('isActive')
      .equals(1)
      .reverse()
      .sortBy('startedAt');

    const mostRecentSession = activeSessions.length > 0 ? activeSessions[activeSessions.length - 1] : null;

    // Continue recent session if < 1 hour old
    if (mostRecentSession && mostRecentSession.startedAt > oneHourAgo) {
      console.log('[Init] Continuing recent session:', mostRecentSession.id);

      // Mark all OTHER sessions as inactive
      for (const session of activeSessions) {
        if (session.id !== mostRecentSession.id) {
          await db.sessions.update(session.id, {
            isActive: false,
            endedAt: now,
            updatedAt: now,
          });
        }
      }

      return mostRecentSession;
    }

    // End all active sessions (they're all too old)
    for (const session of activeSessions) {
      await db.sessions.update(session.id, {
        isActive: false,
        endedAt: now,
        updatedAt: now,
      });
    }

    // Create new session
    const session: Session = {
      id: generateUUID(),
      name: `Session ${new Date(now).toLocaleString()}`,
      description: '',
      startedAt: now,
      endedAt: null,
      isActive: true,
      isSaved: false,
      windowCount: 0,
      tabCount: 0,
      totalActiveTime: 0,
      expiresAt: calculateSessionExpiry(now),
      tags: [],
      customMetadata: {},
      createdAt: now,
      updatedAt: now,
    };

    await db.sessions.add(session);
    console.log('[Init] Created new session:', session.id);

    // Verify it was written
    const written = await db.sessions.get(session.id);
    if (!written) {
      throw new Error('Session write verification failed');
    }

    return session;
  }

  private async reconcileAllTabsAndWindows(sessionId: string): Promise<void> {
    console.log('[Init] Reconciling windows and tabs...');

    const db = getDatabase();
    const storageManager = getStorageManager();
    const windows = await chrome.windows.getAll({ populate: true });

    console.log(`[Init] Found ${windows.length} Chrome windows`);

    let totalTabs = 0;

    for (const chromeWindow of windows) {
      // Create window record
      const windowRecord = await this.createWindowRecord(chromeWindow, sessionId);
      console.log(`[Init] Created window ${chromeWindow.id} -> ${windowRecord.persistentId}`);

      // Map Chrome window ID to persistent ID
      storageManager.setChromeWindowId(chromeWindow.id!, windowRecord.persistentId);

      // Create or reuse tab records
      const tabs = chromeWindow.tabs || [];
      for (const chromeTab of tabs) {
        const tabRecord = await this.createOrReuseTabRecord(chromeTab, sessionId, windowRecord.persistentId);

        // Map Chrome tab ID to persistent ID
        storageManager.setChromeTabId(chromeTab.id!, tabRecord.persistentId);

        totalTabs++;
      }
    }

    console.log(`[Init] Reconciled ${windows.length} windows and ${totalTabs} tabs`);

    // Update session counts
    await db.sessions.update(sessionId, {
      windowCount: windows.length,
      tabCount: totalTabs,
      updatedAt: Date.now(),
    });

    // Verify data was written
    const tabCount = await db.tabs.where('sessionId').equals(sessionId).count();
    const windowCount = await db.windows.where('sessionId').equals(sessionId).count();
    console.log(`[Init] Verified: ${windowCount} windows, ${tabCount} tabs in database`);

    if (tabCount !== totalTabs) {
      console.error(`[Init] WARNING: Tab count mismatch! Expected ${totalTabs}, got ${tabCount}`);
    }
  }

  private async createWindowRecord(
    chromeWindow: chrome.windows.Window,
    sessionId: string
  ): Promise<TrackedWindow> {
    const db = getDatabase();
    const now = Date.now();

    const windowRecord: TrackedWindow = {
      persistentId: generateUUID(),
      chromeWindowId: chromeWindow.id!,
      type: chromeWindow.type || 'normal',
      state: chromeWindow.state || 'normal',
      incognito: chromeWindow.incognito,
      left: chromeWindow.left || 0,
      top: chromeWindow.top || 0,
      width: chromeWindow.width || 0,
      height: chromeWindow.height || 0,
      createdAt: now,
      lastFocusedAt: chromeWindow.focused ? now : 0,
      totalFocusTime: 0,
      sessionId,
      isSaved: false,
      tabCount: chromeWindow.tabs?.length || 0,
      activeTabPersistentId: null,
      closedAt: null,
      updatedAt: now,
    };

    await db.windows.add(windowRecord);
    return windowRecord;
  }

  /**
   * Find existing CLOSED tab by URL hash to reuse
   * Only matches tabs that were closed (not currently open tabs)
   */
  private async findExistingTabByUrl(
    urlHash: string,
    sessionId: string
  ): Promise<TrackedTab | undefined> {
    const db = getDatabase();
    const fiveMinutesAgo = Date.now() - 5 * 60 * 1000;

    // Only find CLOSED tabs with matching URL (recently closed within 5 minutes)
    // Don't match currently open tabs (closedAt === null) as those are different tabs
    const candidates = await db.tabs
      .where('urlHash')
      .equals(urlHash)
      .filter(t => t.closedAt !== null && t.closedAt > fiveMinutesAgo)
      .sortBy('lastActivatedAt'); // Most recently active first

    return candidates.length > 0 ? candidates[candidates.length - 1] : undefined;
  }

  /**
   * Create new tab record or reuse existing one based on URL matching
   */
  private async createOrReuseTabRecord(
    chromeTab: chrome.tabs.Tab,
    sessionId: string,
    windowPersistentId: string
  ): Promise<TrackedTab> {
    const db = getDatabase();
    const now = Date.now();
    const url = chromeTab.url || chromeTab.pendingUrl || '';
    const urlHash = await hashUrl(url);

    // Try to find existing tab
    const existingTab = await this.findExistingTabByUrl(urlHash, sessionId);

    if (existingTab) {
      // REUSE existing tab
      console.log(`[Init] Reusing tab ${existingTab.persistentId} for URL: ${url.slice(0, 50)}`);

      await db.tabs.update(existingTab.id!, {
        chromeTabId: chromeTab.id!,
        chromeWindowId: chromeTab.windowId,
        sessionId, // Update to current session
        windowPersistentId,
        closedAt: null, // Resurrect if it was closed
        lastActivatedAt: chromeTab.active ? now : existingTab.lastActivatedAt,
        title: chromeTab.title || existingTab.title,
        faviconUrl: chromeTab.favIconUrl || existingTab.faviconUrl,
        status: chromeTab.status || 'complete',
        pinned: chromeTab.pinned,
        index: chromeTab.index,
        updatedAt: now,
      });

      // Return updated tab
      return (await db.tabs.get(existingTab.id!))!;
    } else {
      // CREATE new tab (genuinely new)
      console.log(`[Init] Creating NEW tab for URL: ${url.slice(0, 50)}`);

      const tabRecord: TrackedTab = {
        persistentId: generateUUID(),
        chromeTabId: chromeTab.id!,
        chromeWindowId: chromeTab.windowId,
        url,
        urlHash,
        title: chromeTab.title || '',
        faviconUrl: chromeTab.favIconUrl || null,
        status: chromeTab.status || 'complete',
        pinned: chromeTab.pinned,
        index: chromeTab.index,
        groupId: chromeTab.groupId ?? -1,
        openerPersistentId: null,
        createdAt: now,
        lastActivatedAt: chromeTab.active ? now : 0,
        totalActiveTime: 0,
        sessionId,
        windowPersistentId,
        isSaved: false,
        isPinned: false,
        visitCount: 0,
        notes: null,
        tags: [],
        customMetadata: {},
        closedAt: null,
        updatedAt: now,
      };

      await db.tabs.add(tabRecord);
      return tabRecord;
    }
  }

  private async createTabRecord(
    chromeTab: chrome.tabs.Tab,
    sessionId: string,
    windowPersistentId: string
  ): Promise<TrackedTab> {
    const db = getDatabase();
    const now = Date.now();
    const url = chromeTab.url || chromeTab.pendingUrl || '';
    const urlHash = await hashUrl(url);

    const tabRecord: TrackedTab = {
      persistentId: generateUUID(),
      chromeTabId: chromeTab.id!,
      chromeWindowId: chromeTab.windowId,
      url,
      urlHash,
      title: chromeTab.title || '',
      faviconUrl: chromeTab.favIconUrl || null,
      status: chromeTab.status || 'complete',
      pinned: chromeTab.pinned,
      index: chromeTab.index,
      groupId: chromeTab.groupId ?? -1,
      openerPersistentId: null,
      createdAt: now,
      lastActivatedAt: chromeTab.active ? now : 0,
      totalActiveTime: 0,
      sessionId,
      windowPersistentId,
      isSaved: false,
      isPinned: false,
      visitCount: 0,
      notes: null,
      tags: [],
      customMetadata: {},
      closedAt: null,
      updatedAt: now,
    };

    await db.tabs.add(tabRecord);
    return tabRecord;
  }

  /**
   * Cleanup duplicate CLOSED tab records by keeping only the most recently active one per URL
   * NOTE: Does NOT remove currently open tabs - multiple tabs with same URL are legitimate
   */
  private async cleanupDuplicateTabs(): Promise<void> {
    console.log('[Init] Starting duplicate tab cleanup...');
    const db = getDatabase();

    // Get only CLOSED tabs
    const closedTabs = await db.tabs.filter(t => t.closedAt !== null).toArray();
    const byUrl = new Map<string, TrackedTab[]>();

    // Group closed tabs by URL hash
    for (const tab of closedTabs) {
      if (!byUrl.has(tab.urlHash)) {
        byUrl.set(tab.urlHash, []);
      }
      byUrl.get(tab.urlHash)!.push(tab);
    }

    // For each URL, keep only the most recent closed tab, delete older ones
    let deletedCount = 0;
    for (const [urlHash, tabs] of byUrl) {
      if (tabs.length > 1) {
        // Sort by most recent activity (most recent first)
        tabs.sort((a, b) => b.lastActivatedAt - a.lastActivatedAt);

        // Keep first (most recent), delete rest
        for (let i = 1; i < tabs.length; i++) {
          const tab = tabs[i];
          if (tab && tab.id) {
            await db.tabs.delete(tab.id);
            deletedCount++;
          }
        }
      }
    }

    console.log(`[Init] Cleaned up ${deletedCount} duplicate closed tab records`);
  }

  async getStatus(): Promise<{
    initialized: boolean;
    sessionCount: number;
    windowCount: number;
    tabCount: number;
  }> {
    try {
      const db = getDatabase();
      const sessionCount = await db.sessions.count();
      const windowCount = await db.windows.count();
      const tabCount = await db.tabs.count();

      return {
        initialized: this.initializationComplete,
        sessionCount,
        windowCount,
        tabCount,
      };
    } catch (error) {
      return {
        initialized: false,
        sessionCount: 0,
        windowCount: 0,
        tabCount: 0,
      };
    }
  }
}

export function getInitializationService(): InitializationService {
  return InitializationService.getInstance();
}
