import { getDatabase } from '../db/schema';
import type { TrackedWindow, WindowFocusEvent } from '../db/types';
import { getStorageManager, type StorageManager } from './StorageManager';
import { generateUUID } from '../utils/uuid';
import { debounce } from '../utils/debounce';
import { TIMING } from '../constants';

/**
 * WindowTracker - Handles all window-related Chrome events
 *
 * Responsibilities:
 * - Track window creation and removal
 * - Track window focus changes
 * - Calculate focus time
 */
export class WindowTracker {
  private storageManager: StorageManager;

  // Debounced handler for focus changes
  private debouncedHandleFocus = debounce(
    this._handleWindowFocusChanged.bind(this),
    TIMING.WINDOW_FOCUS_DEBOUNCE_MS
  );

  constructor(storageManager?: StorageManager) {
    this.storageManager = storageManager || getStorageManager();
  }

  /**
   * Handle window creation
   */
  async handleWindowCreated(window: chrome.windows.Window): Promise<TrackedWindow | null> {
    await this.storageManager.ensureInitialized();
    const sessionId = this.storageManager.getCurrentSessionId();
    if (!sessionId) {
      console.warn('[WindowTracker] No active session for window creation');
      return null;
    }

    const db = getDatabase();
    const now = Date.now();

    const persistentId = generateUUID();
    const windowRecord: TrackedWindow = {
      persistentId,
      chromeWindowId: window.id!,
      type: window.type || 'normal',
      state: window.state || 'normal',
      incognito: window.incognito,
      left: window.left || 0,
      top: window.top || 0,
      width: window.width || 0,
      height: window.height || 0,
      createdAt: now,
      lastFocusedAt: window.focused ? now : 0,
      totalFocusTime: 0,
      sessionId,
      isSaved: false,
      tabCount: window.tabs?.length || 0,
      activeTabPersistentId: null,
      closedAt: null,
      updatedAt: now,
    };

    await db.windows.add(windowRecord);
    this.storageManager.setWindowMapping(window.id!, persistentId);

    // Update session window count
    await db.sessions.where('id').equals(sessionId).modify((session) => {
      session.windowCount = (session.windowCount || 0) + 1;
      session.updatedAt = now;
    });

    console.log(`[WindowTracker] Created window: ${persistentId} (incognito: ${window.incognito})`);
    return windowRecord;
  }

  /**
   * Handle window removal
   */
  async handleWindowRemoved(windowId: number): Promise<void> {
    const now = Date.now();
    const persistentId = this.storageManager.getPersistentWindowId(windowId);

    if (!persistentId) {
      console.warn(`[WindowTracker] Unknown window removed: ${windowId}`);
      return;
    }

    const db = getDatabase();
    const sessionId = this.storageManager.getCurrentSessionId();

    // Close any active focus event
    await this.closeActiveFocusEvent(persistentId, now);

    // Calculate final focus time if this was the focused window
    if (this.storageManager.getActiveWindowPersistentId() === persistentId) {
      const focusTime = this.storageManager.getWindowFocusTimestamp();
      if (focusTime > 0) {
        const duration = now - focusTime;
        await db.windows.where('persistentId').equals(persistentId).modify((window) => {
          window.totalFocusTime = (window.totalFocusTime || 0) + duration;
        });
      }
      await this.storageManager.setActiveWindow(null, 0);
    }

    // Mark window as closed
    await db.windows.where('persistentId').equals(persistentId).modify((window) => {
      window.closedAt = now;
      window.updatedAt = now;
    });

    // Update session window count
    if (sessionId) {
      await db.sessions.where('id').equals(sessionId).modify((session) => {
        session.windowCount = Math.max(0, (session.windowCount || 0) - 1);
        session.updatedAt = now;
      });
    }

    // Remove from cache
    this.storageManager.removeWindowMapping(windowId);

    console.log(`[WindowTracker] Removed window: ${persistentId}`);
  }

  /**
   * Handle window focus change (debounced wrapper)
   */
  handleWindowFocusChanged(windowId: number): void {
    this.debouncedHandleFocus(windowId);
  }

  /**
   * Internal handler for window focus changes
   */
  private async _handleWindowFocusChanged(windowId: number): Promise<void> {
    const now = Date.now();

    await this.storageManager.ensureInitialized();
    const sessionId = this.storageManager.getCurrentSessionId();
    if (!sessionId) return;

    const db = getDatabase();

    // Handle focus loss for previous window
    const previousWindowId = this.storageManager.getActiveWindowPersistentId();
    const focusTime = this.storageManager.getWindowFocusTimestamp();

    if (previousWindowId && focusTime > 0) {
      const duration = now - focusTime;

      // Update total focus time
      await db.windows.where('persistentId').equals(previousWindowId).modify((window) => {
        window.totalFocusTime = (window.totalFocusTime || 0) + duration;
        window.updatedAt = now;
      });

      // Close the focus event
      await this.closeActiveFocusEvent(previousWindowId, now);
    }

    // chrome.windows.WINDOW_ID_NONE means no window has focus
    if (windowId === chrome.windows.WINDOW_ID_NONE) {
      await this.storageManager.setActiveWindow(null, 0);
      console.log('[WindowTracker] All windows lost focus');
      return;
    }

    // Get persistent ID for new focused window
    const newPersistentId = this.storageManager.getPersistentWindowId(windowId);
    if (!newPersistentId) {
      console.warn(`[WindowTracker] Unknown window focused: ${windowId}`);
      await this.storageManager.setActiveWindow(null, 0);
      return;
    }

    // Update window's last focused time
    await db.windows.where('persistentId').equals(newPersistentId).modify((window) => {
      window.lastFocusedAt = now;
      window.updatedAt = now;
    });

    // Create a new focus event
    await this.createFocusEvent(newPersistentId, previousWindowId, now);

    // Update working state
    await this.storageManager.setActiveWindow(newPersistentId, now);

    console.log(`[WindowTracker] Focused window: ${newPersistentId}`);
  }

  /**
   * Create a focus event record
   */
  private async createFocusEvent(
    windowPersistentId: string,
    previousWindowPersistentId: string | null,
    focusedAt: number
  ): Promise<void> {
    const sessionId = this.storageManager.getCurrentSessionId();
    if (!sessionId) return;

    const db = getDatabase();

    const focusEvent: WindowFocusEvent = {
      windowPersistentId,
      sessionId,
      focusedAt,
      unfocusedAt: null,
      duration: 0,
      previousWindowPersistentId,
    };

    await db.windowFocusEvents.add(focusEvent);
  }

  /**
   * Close the active focus event for a window
   */
  private async closeActiveFocusEvent(
    windowPersistentId: string,
    unfocusedAt: number
  ): Promise<void> {
    const db = getDatabase();

    // Find the most recent unclosed focus event for this window
    const openEvent = await db.windowFocusEvents
      .where('windowPersistentId')
      .equals(windowPersistentId)
      .filter((e) => e.unfocusedAt === null)
      .last();

    if (openEvent && openEvent.id) {
      const duration = unfocusedAt - openEvent.focusedAt;
      await db.windowFocusEvents.update(openEvent.id, {
        unfocusedAt,
        duration,
      });
    }
  }

  /**
   * Get window by persistent ID
   */
  async getWindow(persistentId: string): Promise<TrackedWindow | undefined> {
    const db = getDatabase();
    return db.windows.where('persistentId').equals(persistentId).first();
  }

  /**
   * Get all windows in a session
   */
  async getWindowsInSession(sessionId: string): Promise<TrackedWindow[]> {
    const db = getDatabase();
    return db.windows.where('sessionId').equals(sessionId).toArray();
  }

  /**
   * Get open windows (not closed)
   */
  async getOpenWindows(sessionId: string): Promise<TrackedWindow[]> {
    const db = getDatabase();
    return db.windows
      .where('sessionId')
      .equals(sessionId)
      .filter((w) => w.closedAt === null)
      .toArray();
  }

  /**
   * Save a window (prevent auto-deletion)
   */
  async saveWindow(persistentId: string): Promise<void> {
    const db = getDatabase();
    await db.windows.where('persistentId').equals(persistentId).modify({
      isSaved: true,
      updatedAt: Date.now(),
    });
  }

  /**
   * Get focus history for a window
   */
  async getWindowFocusHistory(persistentId: string, limit = 100): Promise<WindowFocusEvent[]> {
    const db = getDatabase();
    return db.windowFocusEvents
      .where('windowPersistentId')
      .equals(persistentId)
      .reverse()
      .limit(limit)
      .toArray();
  }
}

// Singleton instance
let windowTracker: WindowTracker | null = null;

/**
 * Get the WindowTracker singleton
 */
export function getWindowTracker(): WindowTracker {
  if (!windowTracker) {
    windowTracker = new WindowTracker();
  }
  return windowTracker;
}
