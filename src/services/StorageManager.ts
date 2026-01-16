import { getDatabase } from '../db/schema';
import type {
  TrackedTab,
  TrackedWindow,
  TabVisit,
  Session,
  WorkingState,
} from '../db/types';
import { generateUUID } from '../utils/uuid';
import { hashUrl } from '../utils/hash';
import { TIMING, STORAGE_LIMITS, calculateSessionExpiry } from '../constants';

/**
 * Pending write operation
 */
interface PendingWrite {
  table: 'tabs' | 'windows' | 'tabVisits' | 'sessions' | 'tabRelationships';
  operation: 'put' | 'delete';
  key: string;
  data: unknown;
  timestamp: number;
}

/**
 * LRU Cache for ID mappings
 */
class LRUCache<K, V> {
  private cache = new Map<K, V>();
  private maxSize: number;

  constructor(maxSize: number) {
    this.maxSize = maxSize;
  }

  get(key: K): V | undefined {
    const value = this.cache.get(key);
    if (value !== undefined) {
      // Move to end (most recently used)
      this.cache.delete(key);
      this.cache.set(key, value);
    }
    return value;
  }

  set(key: K, value: V): void {
    if (this.cache.has(key)) {
      this.cache.delete(key);
    } else if (this.cache.size >= this.maxSize) {
      // Delete oldest (first) entry
      const firstKey = this.cache.keys().next().value;
      if (firstKey !== undefined) {
        this.cache.delete(firstKey);
      }
    }
    this.cache.set(key, value);
  }

  delete(key: K): boolean {
    return this.cache.delete(key);
  }

  clear(): void {
    this.cache.clear();
  }

  toObject(): Record<string, V> {
    const obj: Record<string, V> = {};
    for (const [key, value] of this.cache) {
      obj[String(key)] = value;
    }
    return obj;
  }

  fromObject(obj: Record<string, V>): void {
    this.cache.clear();
    for (const [key, value] of Object.entries(obj)) {
      this.cache.set(key as K, value);
    }
  }
}

/**
 * StorageManager - Orchestrates hybrid storage between IndexedDB and chrome.storage.session
 *
 * Responsibilities:
 * - Manages working state (survives service worker restarts)
 * - Batches writes to IndexedDB for performance
 * - Handles startup reconciliation
 * - Provides ID mapping between Chrome IDs and persistent IDs
 */
export class StorageManager {
  private initialized = false;
  private initPromise: Promise<void> | null = null;

  // Working state
  private workingState: WorkingState | null = null;

  // Write queue for batching
  private writeQueue = new Map<string, PendingWrite>();
  private flushTimer: ReturnType<typeof setTimeout> | null = null;

  // ID mapping caches
  private tabIdCache = new LRUCache<number, string>(STORAGE_LIMITS.MAX_CACHED_TAB_MAPPINGS);
  private windowIdCache = new LRUCache<number, string>(STORAGE_LIMITS.MAX_CACHED_WINDOW_MAPPINGS);

  /**
   * Ensure the storage manager is initialized
   */
  async ensureInitialized(): Promise<void> {
    if (this.initialized) return;
    if (this.initPromise) return this.initPromise;

    this.initPromise = this._initialize();
    return this.initPromise;
  }

  private async _initialize(): Promise<void> {
    console.log('[StorageManager] Initializing...');

    // Open database (Dexie handles this automatically on first access)
    const db = getDatabase();
    await db.open();

    // Load working state from chrome.storage.session
    const stored = await chrome.storage.session.get('workingState');
    if (stored.workingState) {
      this.workingState = stored.workingState as WorkingState;
      // Restore caches from working state
      if (this.workingState.chromeTabIdMap) {
        this.tabIdCache.fromObject(this.workingState.chromeTabIdMap);
      }
      if (this.workingState.chromeWindowIdMap) {
        this.windowIdCache.fromObject(this.workingState.chromeWindowIdMap);
      }
      console.log('[StorageManager] Restored working state from session storage');
    } else {
      // Fresh session - will be initialized during reconciliation
      console.log('[StorageManager] No existing working state, will create fresh');
    }

    this.initialized = true;
    console.log('[StorageManager] Initialized');
  }

  /**
   * Reconcile Chrome state with database after startup/restart
   */
  async reconcileOnStartup(): Promise<Session> {
    await this.ensureInitialized();
    console.log('[StorageManager] Reconciling Chrome state...');

    const db = getDatabase();

    // End any previously active session
    const activeSession = await db.sessions.where('isActive').equals(1).first();
    if (activeSession) {
      await db.sessions.update(activeSession.id, {
        isActive: false,
        endedAt: Date.now(),
        updatedAt: Date.now(),
      });
    }

    // Create new session
    const session = await this.createSession();

    // Get all current windows and tabs from Chrome
    const windows = await chrome.windows.getAll({ populate: true });

    for (const window of windows) {
      // Create or match window record
      const windowRecord = await this.reconcileWindow(window, session.id);

      for (const tab of window.tabs || []) {
        // Create or match tab record
        await this.reconcileTab(tab, session.id, windowRecord.persistentId);
      }
    }

    // Initialize working state
    this.workingState = {
      currentSessionId: session.id,
      activeTabPersistentId: null,
      activeWindowPersistentId: null,
      tabActivationTimestamp: 0,
      windowFocusTimestamp: 0,
      chromeTabIdMap: this.tabIdCache.toObject(),
      chromeWindowIdMap: this.windowIdCache.toObject(),
    };

    await this.persistWorkingState();

    console.log(`[StorageManager] Reconciliation complete. Session: ${session.id}`);
    return session;
  }

  /**
   * Create a new session
   */
  async createSession(): Promise<Session> {
    const db = getDatabase();
    const now = Date.now();

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
    console.log(`[StorageManager] Created session: ${session.id}`);
    return session;
  }

  /**
   * Reconcile a window with database
   */
  private async reconcileWindow(
    chromeWindow: chrome.windows.Window,
    sessionId: string
  ): Promise<TrackedWindow> {
    const db = getDatabase();
    const now = Date.now();

    // Check if we have a cached mapping
    let persistentId = this.windowIdCache.get(chromeWindow.id!);
    let windowRecord: TrackedWindow | undefined;

    if (persistentId) {
      windowRecord = await db.windows.where('persistentId').equals(persistentId).first();
    }

    if (!windowRecord) {
      // Create new window record
      persistentId = generateUUID();
      windowRecord = {
        persistentId,
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
    } else {
      // Update existing record with new session and Chrome ID
      await db.windows.update(windowRecord.id!, {
        chromeWindowId: chromeWindow.id!,
        sessionId,
        state: chromeWindow.state || 'normal',
        tabCount: chromeWindow.tabs?.length || 0,
        closedAt: null,
        updatedAt: now,
      });
    }

    // Update cache
    this.windowIdCache.set(chromeWindow.id!, persistentId!);

    return windowRecord as TrackedWindow;
  }

  /**
   * Reconcile a tab with database (URL-based matching)
   */
  private async reconcileTab(
    chromeTab: chrome.tabs.Tab,
    sessionId: string,
    windowPersistentId: string
  ): Promise<TrackedTab> {
    const db = getDatabase();
    const now = Date.now();
    const url = chromeTab.url || chromeTab.pendingUrl || '';
    const urlHash = await hashUrl(url);

    // Check if we have a cached mapping
    let persistentId = this.tabIdCache.get(chromeTab.id!);
    let tabRecord: TrackedTab | undefined;

    if (persistentId) {
      tabRecord = await db.tabs.where('persistentId').equals(persistentId).first();
    }

    if (!tabRecord) {
      // Try URL-based matching - find most recent tab with same URL hash
      const candidates = await db.tabs
        .where('urlHash')
        .equals(urlHash)
        .filter((t) => t.closedAt !== null) // Only match closed tabs
        .reverse()
        .sortBy('lastActivatedAt');

      if (candidates.length > 0 && candidates[0]) {
        tabRecord = candidates[0];
        persistentId = tabRecord.persistentId;
      }
    }

    // Get opener's persistent ID if available
    let openerPersistentId: string | null = null;
    if (chromeTab.openerTabId) {
      openerPersistentId = this.tabIdCache.get(chromeTab.openerTabId) || null;
    }

    if (!tabRecord) {
      // Create new tab record
      persistentId = generateUUID();
      tabRecord = {
        persistentId,
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
        openerPersistentId,
        createdAt: now,
        lastActivatedAt: chromeTab.active ? now : 0,
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
    } else {
      // Update existing record with new session and Chrome ID
      await db.tabs.update(tabRecord.id!, {
        chromeTabId: chromeTab.id!,
        chromeWindowId: chromeTab.windowId,
        sessionId,
        url,
        urlHash,
        title: chromeTab.title || tabRecord.title,
        faviconUrl: chromeTab.favIconUrl || tabRecord.faviconUrl,
        status: chromeTab.status || 'complete',
        pinned: chromeTab.pinned,
        index: chromeTab.index,
        closedAt: null,
        updatedAt: now,
      });
    }

    // Update cache
    this.tabIdCache.set(chromeTab.id!, persistentId!);

    return tabRecord as TrackedTab;
  }

  // ============================================
  // ID Mapping Methods
  // ============================================

  /**
   * Get persistent ID for a Chrome tab ID
   */
  getPersistentTabId(chromeTabId: number): string | undefined {
    return this.tabIdCache.get(chromeTabId);
  }

  /**
   * Get persistent ID for a Chrome window ID
   */
  getPersistentWindowId(chromeWindowId: number): string | undefined {
    return this.windowIdCache.get(chromeWindowId);
  }

  /**
   * Set mapping for a tab
   */
  setTabMapping(chromeTabId: number, persistentId: string): void {
    this.tabIdCache.set(chromeTabId, persistentId);
    this.updateWorkingStateMappings();
  }

  /**
   * Set mapping for a window
   */
  setWindowMapping(chromeWindowId: number, persistentId: string): void {
    this.windowIdCache.set(chromeWindowId, persistentId);
    this.updateWorkingStateMappings();
  }

  /**
   * Remove tab mapping
   */
  removeTabMapping(chromeTabId: number): void {
    this.tabIdCache.delete(chromeTabId);
    this.updateWorkingStateMappings();
  }

  /**
   * Remove window mapping
   */
  removeWindowMapping(chromeWindowId: number): void {
    this.windowIdCache.delete(chromeWindowId);
    this.updateWorkingStateMappings();
  }

  // ============================================
  // Working State Methods
  // ============================================

  /**
   * Get current session ID
   */
  getCurrentSessionId(): string | null {
    return this.workingState?.currentSessionId || null;
  }

  /**
   * Get active tab's persistent ID
   */
  getActiveTabPersistentId(): string | null {
    return this.workingState?.activeTabPersistentId || null;
  }

  /**
   * Get active window's persistent ID
   */
  getActiveWindowPersistentId(): string | null {
    return this.workingState?.activeWindowPersistentId || null;
  }

  /**
   * Get tab activation timestamp
   */
  getTabActivationTimestamp(): number {
    return this.workingState?.tabActivationTimestamp || 0;
  }

  /**
   * Get window focus timestamp
   */
  getWindowFocusTimestamp(): number {
    return this.workingState?.windowFocusTimestamp || 0;
  }

  /**
   * Update active tab state
   */
  async setActiveTab(persistentId: string | null, timestamp: number): Promise<void> {
    if (!this.workingState) return;
    this.workingState.activeTabPersistentId = persistentId;
    this.workingState.tabActivationTimestamp = timestamp;
    await this.persistWorkingState();
  }

  /**
   * Update active window state
   */
  async setActiveWindow(persistentId: string | null, timestamp: number): Promise<void> {
    if (!this.workingState) return;
    this.workingState.activeWindowPersistentId = persistentId;
    this.workingState.windowFocusTimestamp = timestamp;
    await this.persistWorkingState();
  }

  /**
   * Update working state mappings
   */
  private updateWorkingStateMappings(): void {
    if (!this.workingState) return;
    this.workingState.chromeTabIdMap = this.tabIdCache.toObject();
    this.workingState.chromeWindowIdMap = this.windowIdCache.toObject();
    // Don't await - fire and forget for performance
    this.persistWorkingState().catch(console.error);
  }

  /**
   * Persist working state to chrome.storage.session
   */
  private async persistWorkingState(): Promise<void> {
    if (!this.workingState) return;
    await chrome.storage.session.set({ workingState: this.workingState });
  }

  // ============================================
  // Write Queue Methods
  // ============================================

  /**
   * Enqueue a write operation
   */
  enqueueWrite(
    table: PendingWrite['table'],
    key: string,
    operation: 'put' | 'delete',
    data: unknown
  ): void {
    const queueKey = `${table}:${key}`;

    // Latest write wins for same entity
    this.writeQueue.set(queueKey, {
      table,
      operation,
      key,
      data,
      timestamp: Date.now(),
    });

    // Flush immediately if queue is full
    if (this.writeQueue.size >= STORAGE_LIMITS.MAX_PENDING_WRITES) {
      this.flushWrites().catch(console.error);
      return;
    }

    // Schedule flush
    this.scheduleFlush();
  }

  /**
   * Schedule a write flush
   */
  private scheduleFlush(): void {
    if (this.flushTimer !== null) return;

    this.flushTimer = setTimeout(() => {
      this.flushWrites().catch(console.error);
      this.flushTimer = null;
    }, TIMING.WRITE_BATCH_INTERVAL_MS);
  }

  /**
   * Flush all pending writes to IndexedDB
   */
  async flushWrites(): Promise<void> {
    if (this.writeQueue.size === 0) return;

    const operations = Array.from(this.writeQueue.values());
    this.writeQueue.clear();

    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }

    const db = getDatabase();

    // Group by table for efficient transactions
    const byTable: Record<string, PendingWrite[]> = {};
    for (const op of operations) {
      if (!byTable[op.table]) {
        byTable[op.table] = [];
      }
      byTable[op.table]!.push(op);
    }

    // Execute writes per table
    for (const [tableName, ops] of Object.entries(byTable)) {
      const table = db.table(tableName);

      const puts = ops.filter((o) => o.operation === 'put').map((o) => o.data);
      const deletes = ops.filter((o) => o.operation === 'delete').map((o) => o.key);

      if (puts.length > 0) {
        await table.bulkPut(puts);
      }
      if (deletes.length > 0) {
        // For deletes, we need to find records by persistentId and delete them
        for (const key of deletes) {
          await table.where('persistentId').equals(key).delete();
        }
      }
    }

    console.log(`[StorageManager] Flushed ${operations.length} writes`);
  }

  // ============================================
  // Cleanup Methods
  // ============================================

  /**
   * Cleanup expired sessions and related data
   */
  async cleanupExpiredSessions(): Promise<number> {
    const db = getDatabase();
    const now = Date.now();
    let deletedCount = 0;

    // Find expired, unsaved sessions
    const expiredSessions = await db.sessions
      .where('expiresAt')
      .below(now)
      .filter((s) => !s.isSaved)
      .toArray();

    for (const session of expiredSessions) {
      // Get tab IDs for relationship cleanup
      const sessionTabs = await db.tabs
        .where('sessionId')
        .equals(session.id)
        .toArray();
      const tabIds = sessionTabs.map((t) => t.persistentId);

      // Delete relationships for these tabs
      if (tabIds.length > 0) {
        await db.tabRelationships
          .filter(
            (r) =>
              tabIds.includes(r.sourceTabPersistentId) ||
              tabIds.includes(r.targetTabPersistentId)
          )
          .delete();
      }

      // Delete related data
      await db.tabVisits.where('sessionId').equals(session.id).delete();
      await db.tabs.where('sessionId').equals(session.id).delete();
      await db.windows.where('sessionId').equals(session.id).delete();
      await db.sessions.delete(session.id);
      deletedCount++;
    }

    if (deletedCount > 0) {
      console.log(`[StorageManager] Cleaned up ${deletedCount} expired sessions`);
    }

    return deletedCount;
  }
}

// Singleton instance
let storageManager: StorageManager | null = null;

/**
 * Get the StorageManager singleton
 */
export function getStorageManager(): StorageManager {
  if (!storageManager) {
    storageManager = new StorageManager();
  }
  return storageManager;
}
