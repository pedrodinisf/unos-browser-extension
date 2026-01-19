// Service worker entry point for UNOS Tab Tracker
// CRITICAL: All event listeners MUST be registered synchronously at top level
// This is a Manifest V3 requirement - do NOT wrap in async functions

import { getStorageManager } from '../src/services/StorageManager';
import { getTabTracker } from '../src/services/TabTracker';
import { getWindowTracker } from '../src/services/WindowTracker';
import { getRelationshipManager } from '../src/services/RelationshipManager';
import { getInitializationService } from '../src/services/InitializationService';
import { TIMING, ALARM_NAMES } from '../src/constants';

export default defineBackground(() => {
  console.log('[UNOS] Background service worker starting...');

  // Initialize services (don't await - register listeners first)
  const storageManager = getStorageManager();
  const tabTracker = getTabTracker();
  const windowTracker = getWindowTracker();
  const relationshipManager = getRelationshipManager();

  // Event logging helper for debugging
  const recentEvents: Array<{ type: string; data: string; timestamp: number }> = [];
  const MAX_EVENTS = 50;

  function logEvent(type: string, data: any) {
    const event = {
      type,
      data: typeof data === 'object' ? JSON.stringify(data).slice(0, 100) : String(data),
      timestamp: Date.now(),
    };
    recentEvents.unshift(event);
    if (recentEvents.length > MAX_EVENTS) {
      recentEvents.pop();
    }
    // Store in chrome.storage.local for persistence
    chrome.storage.local.set({ recentEvents: recentEvents.slice(0, 10) }).catch(console.error);
  }

  // ============================================
  // TAB EVENTS - Register synchronously
  // ============================================

  chrome.tabs.onCreated.addListener((tab) => {
    console.log('[UNOS] Tab created:', tab.id);
    logEvent('TAB_CREATED', `id:${tab.id} url:${tab.url?.slice(0, 50)}`);
    tabTracker.handleTabCreated(tab).then(async (tabRecord) => {
      if (tabRecord && tabRecord.openerPersistentId) {
        // Track opener relationship
        await relationshipManager.trackOpenerRelationship(
          tabRecord.persistentId,
          tabRecord.openerPersistentId
        );
      }

      if (tabRecord) {
        // Track sibling relationships
        const sessionId = storageManager.getCurrentSessionId();
        if (sessionId) {
          await relationshipManager.trackSiblingRelationships(
            tabRecord.persistentId,
            sessionId,
            tab.windowId
          );
        }
      }
    }).catch(console.error);
  });

  chrome.tabs.onRemoved.addListener((tabId, removeInfo) => {
    console.log('[UNOS] Tab removed:', tabId);
    tabTracker.handleTabRemoved(tabId, removeInfo).catch(console.error);
  });

  chrome.tabs.onActivated.addListener((activeInfo) => {
    console.log('[UNOS] Tab activated:', activeInfo.tabId);
    logEvent('TAB_ACTIVATED', `id:${activeInfo.tabId} window:${activeInfo.windowId}`);
    tabTracker.handleTabActivated(activeInfo).catch(console.error);
  });

  chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    // Only process meaningful changes
    if (changeInfo.url || changeInfo.title || changeInfo.favIconUrl || changeInfo.status === 'complete') {
      tabTracker.handleTabUpdated(tabId, changeInfo, tab);
    }
  });

  chrome.tabs.onMoved.addListener((tabId, moveInfo) => {
    tabTracker.handleTabMoved(tabId, moveInfo).catch(console.error);
  });

  chrome.tabs.onAttached.addListener((tabId, attachInfo) => {
    tabTracker.handleTabAttached(tabId, attachInfo).catch(console.error);
  });

  chrome.tabs.onDetached.addListener((tabId, detachInfo) => {
    tabTracker.handleTabDetached(tabId, detachInfo).catch(console.error);
  });

  // ============================================
  // WINDOW EVENTS - Register synchronously
  // ============================================

  chrome.windows.onCreated.addListener((window) => {
    console.log('[UNOS] Window created:', window.id);
    windowTracker.handleWindowCreated(window).catch(console.error);
  });

  chrome.windows.onRemoved.addListener((windowId) => {
    console.log('[UNOS] Window removed:', windowId);
    windowTracker.handleWindowRemoved(windowId).catch(console.error);
  });

  chrome.windows.onFocusChanged.addListener((windowId) => {
    windowTracker.handleWindowFocusChanged(windowId);
  });

  // ============================================
  // LIFECYCLE EVENTS
  // ============================================

  chrome.runtime.onInstalled.addListener(async (details) => {
    console.log('[UNOS] Extension installed/updated:', details.reason);
    logEvent('EXTENSION_INSTALLED', details.reason);

    // Create alarms for periodic tasks
    chrome.alarms.create(ALARM_NAMES.FLUSH_WRITES, {
      periodInMinutes: TIMING.FLUSH_ALARM_MINUTES,
    });

    chrome.alarms.create(ALARM_NAMES.CLEANUP, {
      periodInMinutes: TIMING.CLEANUP_ALARM_MINUTES,
    });

    chrome.alarms.create(ALARM_NAMES.RELATIONSHIPS, {
      periodInMinutes: TIMING.RELATIONSHIP_ALARM_MINUTES,
    });

    // CRITICAL: Wait for initialization to complete
    try {
      const initService = getInitializationService();
      await initService.initialize();
      const status = await initService.getStatus();
      console.log('[UNOS] ✓ Initialization complete:', status);
      logEvent('INIT_COMPLETE', JSON.stringify(status));
    } catch (err) {
      console.error('[UNOS] ✗ Initialization failed:', err);
      logEvent('INIT_FAILED', err instanceof Error ? err.message : String(err));
    }
  });

  chrome.runtime.onStartup.addListener(async () => {
    console.log('[UNOS] Browser startup detected');

    // Ensure alarms exist
    chrome.alarms.get(ALARM_NAMES.FLUSH_WRITES, (alarm) => {
      if (!alarm) {
        chrome.alarms.create(ALARM_NAMES.FLUSH_WRITES, {
          periodInMinutes: TIMING.FLUSH_ALARM_MINUTES,
        });
      }
    });

    chrome.alarms.get(ALARM_NAMES.CLEANUP, (alarm) => {
      if (!alarm) {
        chrome.alarms.create(ALARM_NAMES.CLEANUP, {
          periodInMinutes: TIMING.CLEANUP_ALARM_MINUTES,
        });
      }
    });

    chrome.alarms.get(ALARM_NAMES.RELATIONSHIPS, (alarm) => {
      if (!alarm) {
        chrome.alarms.create(ALARM_NAMES.RELATIONSHIPS, {
          periodInMinutes: TIMING.RELATIONSHIP_ALARM_MINUTES,
        });
      }
    });

    // CRITICAL: Wait for initialization to complete
    try {
      const initService = getInitializationService();
      await initService.initialize();
      const status = await initService.getStatus();
      console.log('[UNOS] ✓ Startup reconciliation complete:', status);
    } catch (err) {
      console.error('[UNOS] ✗ Startup reconciliation failed:', err);
    }
  });

  // ============================================
  // ALARMS - For periodic tasks
  // ============================================

  chrome.alarms.onAlarm.addListener((alarm) => {
    console.log('[UNOS] Alarm fired:', alarm.name);

    switch (alarm.name) {
      case ALARM_NAMES.FLUSH_WRITES:
        storageManager.flushWrites().catch(console.error);
        break;

      case ALARM_NAMES.CLEANUP:
        storageManager.cleanupExpiredSessions().catch(console.error);
        relationshipManager.pruneWeakRelationships().catch(console.error);
        break;

      case ALARM_NAMES.RELATIONSHIPS:
        relationshipManager.recalculateTemporalRelationships().catch(console.error);
        break;
    }
  });

  // ============================================
  // MESSAGE HANDLING (for popup communication)
  // ============================================

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    console.log('[UNOS] Message received:', message.type);

    // Handle async operations
    (async () => {
      try {
        switch (message.type) {
          case 'GET_CURRENT_TAB': {
            const persistentId = storageManager.getActiveTabPersistentId();
            if (persistentId) {
              const tab = await tabTracker.getTab(persistentId);
              sendResponse({ success: true, data: tab });
            } else {
              sendResponse({ success: false, error: 'No active tab' });
            }
            break;
          }

          case 'GET_CURRENT_SESSION': {
            const sessionId = storageManager.getCurrentSessionId();
            sendResponse({ success: true, data: { sessionId } });
            break;
          }

          case 'GET_TABS_IN_SESSION': {
            const sessionId = message.sessionId || storageManager.getCurrentSessionId();
            if (sessionId) {
              const tabs = await tabTracker.getTabsInSession(sessionId);
              sendResponse({ success: true, data: tabs });
            } else {
              sendResponse({ success: false, error: 'No session' });
            }
            break;
          }

          case 'GET_WINDOWS_IN_SESSION': {
            const sessionId = message.sessionId || storageManager.getCurrentSessionId();
            if (sessionId) {
              const windows = await windowTracker.getWindowsInSession(sessionId);
              sendResponse({ success: true, data: windows });
            } else {
              sendResponse({ success: false, error: 'No session' });
            }
            break;
          }

          case 'UPDATE_TAB_METADATA': {
            const { persistentId, tags, notes, customMetadata } = message;
            await tabTracker.updateTabMetadata(persistentId, { tags, notes, customMetadata });
            sendResponse({ success: true });
            break;
          }

          case 'SAVE_TAB': {
            const { persistentId } = message;
            await tabTracker.saveTab(persistentId);
            sendResponse({ success: true });
            break;
          }

          case 'GET_TAB_RELATIONSHIPS': {
            const { persistentId } = message;
            const relationships = await relationshipManager.getAllRelationships(persistentId);
            sendResponse({ success: true, data: relationships });
            break;
          }

          case 'GET_TAB_VISITS': {
            const { persistentId, limit } = message;
            const visits = await tabTracker.getTabVisits(persistentId, limit);
            sendResponse({ success: true, data: visits });
            break;
          }

          case 'PING': {
            sendResponse({ success: true, data: { pong: true, timestamp: Date.now() } });
            break;
          }

          case 'SWITCH_TO_TAB': {
            const { chromeTabId, chromeWindowId } = message;
            // Focus the window first, then activate the tab
            await chrome.windows.update(chromeWindowId, { focused: true });
            await chrome.tabs.update(chromeTabId, { active: true });
            sendResponse({ success: true });
            break;
          }

          case 'CLOSE_TAB': {
            const { chromeTabId } = message;
            await chrome.tabs.remove(chromeTabId);
            sendResponse({ success: true });
            break;
          }

          case 'MOVE_TAB_TO_WINDOW': {
            const { chromeTabId, targetWindowId, index } = message;
            await chrome.tabs.move(chromeTabId, { windowId: targetWindowId, index: index ?? -1 });
            sendResponse({ success: true });
            break;
          }

          case 'REORDER_TAB': {
            const { chromeTabId, newIndex } = message;
            await chrome.tabs.move(chromeTabId, { index: newIndex });
            sendResponse({ success: true });
            break;
          }

          case 'GET_ALL_DATA': {
            // Get all data for export - runs in background context with full DB access
            const db = storageManager.getDB();
            const sessionId = message.sessionId || storageManager.getCurrentSessionId();

            const [sessions, windows, tabs, visits, relationships, tags] = await Promise.all([
              sessionId ? db.sessions.where('id').equals(sessionId).toArray() : db.sessions.toArray(),
              sessionId ? db.windows.where('sessionId').equals(sessionId).toArray() : db.windows.toArray(),
              sessionId ? db.tabs.where('sessionId').equals(sessionId).toArray() : db.tabs.toArray(),
              db.tabVisits.toArray(),
              db.tabRelationships.toArray(),
              db.tags.toArray(),
            ]);

            sendResponse({
              success: true,
              data: { sessions, windows, tabs, visits, relationships, tags }
            });
            break;
          }

          case 'GET_DEBUG_STATS': {
            const db = storageManager.getDB();
            const initService = getInitializationService();
            const initStatus = await initService.getStatus();
            const stats = {
              ...initStatus,
              visitCount: await db.tabVisits.count(),
              relationshipCount: await db.tabRelationships.count(),
            };
            sendResponse({ success: true, data: stats });
            break;
          }

          case 'GET_RECENT_EVENTS': {
            // Get recent events from storage if available
            const events = (await chrome.storage.local.get('recentEvents')).recentEvents || [];
            sendResponse({ success: true, data: events });
            break;
          }

          case 'FORCE_RECONCILE': {
            const initService = getInitializationService();
            await initService.initialize();
            const status = await initService.getStatus();
            sendResponse({ success: true, data: status });
            break;
          }

          case 'FORCE_INIT': {
            const initService = getInitializationService();
            await initService.initialize();
            const status = await initService.getStatus();
            sendResponse({ success: true, data: status });
            break;
          }

          default:
            sendResponse({ success: false, error: `Unknown message type: ${message.type}` });
        }
      } catch (error) {
        console.error('[UNOS] Message handling error:', error);
        sendResponse({ success: false, error: String(error) });
      }
    })();

    // Return true to indicate we'll send response asynchronously
    return true;
  });

  console.log('[UNOS] Background service worker initialized');
});
