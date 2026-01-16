import { getDatabase } from '../db/schema';
import type { TrackedTab, TabVisit } from '../db/types';
import { getStorageManager, type StorageManager } from './StorageManager';
import { generateUUID } from '../utils/uuid';
import { hashUrl } from '../utils/hash';
import { debounce } from '../utils/debounce';
import { TIMING } from '../constants';

/**
 * TabTracker - Handles all tab-related Chrome events
 *
 * Responsibilities:
 * - Track tab creation, removal, activation
 * - Update tab metadata on changes
 * - Calculate and record time spent on tabs
 * - Create visit records
 */
export class TabTracker {
  private storageManager: StorageManager;

  // Debounced handler for tab updates
  private debouncedHandleUpdate = debounce(
    this._handleTabUpdated.bind(this),
    TIMING.TAB_UPDATE_DEBOUNCE_MS,
    { maxWait: TIMING.TAB_UPDATE_MAX_WAIT_MS }
  );

  constructor(storageManager?: StorageManager) {
    this.storageManager = storageManager || getStorageManager();
  }

  /**
   * Handle tab creation
   */
  async handleTabCreated(tab: chrome.tabs.Tab): Promise<TrackedTab | null> {
    await this.storageManager.ensureInitialized();
    const sessionId = this.storageManager.getCurrentSessionId();
    if (!sessionId) {
      console.warn('[TabTracker] No active session for tab creation');
      return null;
    }

    const db = getDatabase();
    const now = Date.now();
    const url = tab.url || tab.pendingUrl || '';
    const urlHash = await hashUrl(url);

    // Get window's persistent ID
    const windowPersistentId = this.storageManager.getPersistentWindowId(tab.windowId);
    if (!windowPersistentId) {
      console.warn(`[TabTracker] Unknown window ${tab.windowId} for new tab`);
    }

    // Get opener's persistent ID if available
    let openerPersistentId: string | null = null;
    if (tab.openerTabId) {
      openerPersistentId = this.storageManager.getPersistentTabId(tab.openerTabId) || null;
    }

    const persistentId = generateUUID();
    const tabRecord: TrackedTab = {
      persistentId,
      chromeTabId: tab.id!,
      chromeWindowId: tab.windowId,
      url,
      urlHash,
      title: tab.title || '',
      faviconUrl: tab.favIconUrl || null,
      status: tab.status || 'loading',
      pinned: tab.pinned,
      index: tab.index,
      groupId: tab.groupId ?? -1,
      openerPersistentId,
      createdAt: now,
      lastActivatedAt: tab.active ? now : 0,
      totalActiveTime: 0,
      sessionId,
      isSaved: false,
      tags: [],
      notes: '',
      customMetadata: {},
      closedAt: null,
      updatedAt: now,
    };

    await db.tabs.add(tabRecord);
    this.storageManager.setTabMapping(tab.id!, persistentId);

    // Update session tab count
    await db.sessions.where('id').equals(sessionId).modify((session) => {
      session.tabCount = (session.tabCount || 0) + 1;
      session.updatedAt = now;
    });

    // Update window tab count
    if (windowPersistentId) {
      await db.windows.where('persistentId').equals(windowPersistentId).modify((window) => {
        window.tabCount = (window.tabCount || 0) + 1;
        window.updatedAt = now;
      });
    }

    console.log(`[TabTracker] Created tab: ${persistentId} (${url.substring(0, 50)}...)`);
    return tabRecord;
  }

  /**
   * Handle tab removal
   */
  async handleTabRemoved(
    tabId: number,
    removeInfo: chrome.tabs.TabRemoveInfo
  ): Promise<void> {
    const now = Date.now();
    const persistentId = this.storageManager.getPersistentTabId(tabId);

    if (!persistentId) {
      console.warn(`[TabTracker] Unknown tab removed: ${tabId}`);
      return;
    }

    const db = getDatabase();
    const sessionId = this.storageManager.getCurrentSessionId();

    // Close any active visit for this tab
    await this.closeActiveVisit(persistentId, now);

    // Calculate final active time if this was the active tab
    if (this.storageManager.getActiveTabPersistentId() === persistentId) {
      const activationTime = this.storageManager.getTabActivationTimestamp();
      if (activationTime > 0) {
        const duration = now - activationTime;
        await db.tabs.where('persistentId').equals(persistentId).modify((tab) => {
          tab.totalActiveTime = (tab.totalActiveTime || 0) + duration;
        });
      }
      await this.storageManager.setActiveTab(null, 0);
    }

    // Mark tab as closed
    await db.tabs.where('persistentId').equals(persistentId).modify((tab) => {
      tab.closedAt = now;
      tab.updatedAt = now;
    });

    // Update session tab count
    if (sessionId) {
      await db.sessions.where('id').equals(sessionId).modify((session) => {
        session.tabCount = Math.max(0, (session.tabCount || 0) - 1);
        session.updatedAt = now;
      });
    }

    // Remove from cache
    this.storageManager.removeTabMapping(tabId);

    console.log(`[TabTracker] Removed tab: ${persistentId}`);
  }

  /**
   * Handle tab activation (user switches to a tab)
   */
  async handleTabActivated(
    activeInfo: chrome.tabs.TabActiveInfo
  ): Promise<void> {
    const now = Date.now();
    const { tabId, windowId } = activeInfo;

    await this.storageManager.ensureInitialized();
    const sessionId = this.storageManager.getCurrentSessionId();
    if (!sessionId) return;

    const db = getDatabase();

    // Close previous active visit and update total time
    const previousTabId = this.storageManager.getActiveTabPersistentId();
    const activationTime = this.storageManager.getTabActivationTimestamp();

    if (previousTabId && activationTime > 0) {
      const duration = now - activationTime;

      // Update total active time for previous tab
      await db.tabs.where('persistentId').equals(previousTabId).modify((tab) => {
        tab.totalActiveTime = (tab.totalActiveTime || 0) + duration;
        tab.updatedAt = now;
      });

      // Close the visit record
      await this.closeActiveVisit(previousTabId, now);

      // Update session total active time
      await db.sessions.where('id').equals(sessionId).modify((session) => {
        session.totalActiveTime = (session.totalActiveTime || 0) + duration;
        session.updatedAt = now;
      });
    }

    // Get persistent ID for new active tab
    const newPersistentId = this.storageManager.getPersistentTabId(tabId);
    if (!newPersistentId) {
      console.warn(`[TabTracker] Unknown tab activated: ${tabId}`);
      await this.storageManager.setActiveTab(null, 0);
      return;
    }

    // Update the tab's last activated time
    await db.tabs.where('persistentId').equals(newPersistentId).modify((tab) => {
      tab.lastActivatedAt = now;
      tab.updatedAt = now;
    });

    // Update window's active tab
    const windowPersistentId = this.storageManager.getPersistentWindowId(windowId);
    if (windowPersistentId) {
      await db.windows.where('persistentId').equals(windowPersistentId).modify((window) => {
        window.activeTabPersistentId = newPersistentId;
        window.updatedAt = now;
      });
    }

    // Create a new visit record
    await this.createVisit(newPersistentId, previousTabId, windowPersistentId || null, now);

    // Update working state
    await this.storageManager.setActiveTab(newPersistentId, now);

    console.log(`[TabTracker] Activated tab: ${newPersistentId}`);
  }

  /**
   * Handle tab update (URL, title, etc. changes)
   */
  handleTabUpdated(
    tabId: number,
    changeInfo: chrome.tabs.TabChangeInfo,
    tab: chrome.tabs.Tab
  ): void {
    // Debounce updates - rapid changes during page load
    this.debouncedHandleUpdate(tabId, changeInfo, tab);
  }

  /**
   * Internal handler for tab updates (debounced)
   */
  private async _handleTabUpdated(
    tabId: number,
    changeInfo: chrome.tabs.TabChangeInfo,
    tab: chrome.tabs.Tab
  ): Promise<void> {
    const persistentId = this.storageManager.getPersistentTabId(tabId);
    if (!persistentId) return;

    const db = getDatabase();
    const now = Date.now();

    const updates: Partial<TrackedTab> = {
      updatedAt: now,
    };

    if (changeInfo.url !== undefined) {
      updates.url = changeInfo.url;
      updates.urlHash = await hashUrl(changeInfo.url);
    }

    if (changeInfo.title !== undefined) {
      updates.title = changeInfo.title;
    }

    if (changeInfo.favIconUrl !== undefined) {
      updates.faviconUrl = changeInfo.favIconUrl;
    }

    if (changeInfo.status !== undefined) {
      updates.status = changeInfo.status;
    }

    if (changeInfo.pinned !== undefined) {
      updates.pinned = changeInfo.pinned;
    }

    await db.tabs.where('persistentId').equals(persistentId).modify(updates);

    console.log(`[TabTracker] Updated tab: ${persistentId}`);
  }

  /**
   * Handle tab moved within a window
   */
  async handleTabMoved(
    tabId: number,
    moveInfo: chrome.tabs.TabMoveInfo
  ): Promise<void> {
    const persistentId = this.storageManager.getPersistentTabId(tabId);
    if (!persistentId) return;

    const db = getDatabase();
    await db.tabs.where('persistentId').equals(persistentId).modify({
      index: moveInfo.toIndex,
      updatedAt: Date.now(),
    });
  }

  /**
   * Handle tab attached to a different window
   */
  async handleTabAttached(
    tabId: number,
    attachInfo: chrome.tabs.TabAttachInfo
  ): Promise<void> {
    const persistentId = this.storageManager.getPersistentTabId(tabId);
    if (!persistentId) return;

    const newWindowPersistentId = this.storageManager.getPersistentWindowId(
      attachInfo.newWindowId
    );

    const db = getDatabase();
    const now = Date.now();

    await db.tabs.where('persistentId').equals(persistentId).modify({
      chromeWindowId: attachInfo.newWindowId,
      index: attachInfo.newPosition,
      updatedAt: now,
    });

    // Update window tab counts
    if (newWindowPersistentId) {
      await db.windows.where('persistentId').equals(newWindowPersistentId).modify((window) => {
        window.tabCount = (window.tabCount || 0) + 1;
        window.updatedAt = now;
      });
    }

    console.log(`[TabTracker] Tab ${persistentId} attached to window ${newWindowPersistentId}`);
  }

  /**
   * Handle tab detached from a window
   */
  async handleTabDetached(
    tabId: number,
    detachInfo: chrome.tabs.TabDetachInfo
  ): Promise<void> {
    const oldWindowPersistentId = this.storageManager.getPersistentWindowId(
      detachInfo.oldWindowId
    );

    if (oldWindowPersistentId) {
      const db = getDatabase();
      await db.windows.where('persistentId').equals(oldWindowPersistentId).modify((window) => {
        window.tabCount = Math.max(0, (window.tabCount || 0) - 1);
        window.updatedAt = Date.now();
      });
    }
  }

  /**
   * Create a visit record for tab activation
   */
  private async createVisit(
    tabPersistentId: string,
    fromTabPersistentId: string | null,
    windowPersistentId: string | null,
    activatedAt: number
  ): Promise<void> {
    const sessionId = this.storageManager.getCurrentSessionId();
    if (!sessionId) return;

    const db = getDatabase();

    // Get tab details for the visit
    const tab = await db.tabs.where('persistentId').equals(tabPersistentId).first();
    if (!tab) return;

    const visit: TabVisit = {
      tabPersistentId,
      sessionId,
      url: tab.url,
      urlHash: tab.urlHash,
      title: tab.title,
      activatedAt,
      deactivatedAt: null,
      duration: 0,
      windowPersistentId: windowPersistentId || '',
      fromTabPersistentId,
    };

    await db.tabVisits.add(visit);
  }

  /**
   * Close the active visit for a tab
   */
  private async closeActiveVisit(tabPersistentId: string, deactivatedAt: number): Promise<void> {
    const db = getDatabase();

    // Find the most recent unclosed visit for this tab
    const openVisit = await db.tabVisits
      .where('tabPersistentId')
      .equals(tabPersistentId)
      .filter((v) => v.deactivatedAt === null)
      .last();

    if (openVisit && openVisit.id) {
      const duration = deactivatedAt - openVisit.activatedAt;
      await db.tabVisits.update(openVisit.id, {
        deactivatedAt,
        duration,
      });
    }
  }

  /**
   * Get tab by persistent ID
   */
  async getTab(persistentId: string): Promise<TrackedTab | undefined> {
    const db = getDatabase();
    return db.tabs.where('persistentId').equals(persistentId).first();
  }

  /**
   * Get all tabs in a session
   */
  async getTabsInSession(sessionId: string): Promise<TrackedTab[]> {
    const db = getDatabase();
    return db.tabs.where('sessionId').equals(sessionId).toArray();
  }

  /**
   * Get tabs in a window
   */
  async getTabsInWindow(sessionId: string, windowId: number): Promise<TrackedTab[]> {
    const db = getDatabase();
    return db.tabs
      .where('[sessionId+chromeWindowId]')
      .equals([sessionId, windowId])
      .toArray();
  }

  /**
   * Update tab metadata (tags, notes)
   */
  async updateTabMetadata(
    persistentId: string,
    updates: { tags?: string[]; notes?: string; customMetadata?: Record<string, unknown> }
  ): Promise<void> {
    const db = getDatabase();
    await db.tabs.where('persistentId').equals(persistentId).modify({
      ...updates,
      updatedAt: Date.now(),
    });
  }

  /**
   * Save a tab (prevent auto-deletion)
   */
  async saveTab(persistentId: string): Promise<void> {
    const db = getDatabase();
    await db.tabs.where('persistentId').equals(persistentId).modify({
      isSaved: true,
      updatedAt: Date.now(),
    });
  }

  /**
   * Get visit history for a tab
   */
  async getTabVisits(persistentId: string, limit = 100): Promise<TabVisit[]> {
    const db = getDatabase();
    return db.tabVisits
      .where('tabPersistentId')
      .equals(persistentId)
      .reverse()
      .limit(limit)
      .toArray();
  }
}

// Singleton instance
let tabTracker: TabTracker | null = null;

/**
 * Get the TabTracker singleton
 */
export function getTabTracker(): TabTracker {
  if (!tabTracker) {
    tabTracker = new TabTracker();
  }
  return tabTracker;
}
