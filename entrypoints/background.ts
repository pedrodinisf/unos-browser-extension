// Service worker entry point for UNOS Tab Tracker
// CRITICAL: All event listeners MUST be registered synchronously at top level
// This is a Manifest V3 requirement - do NOT wrap in async functions

import { getStorageManager } from '../src/services/StorageManager';
import { getTabTracker } from '../src/services/TabTracker';
import { getWindowTracker } from '../src/services/WindowTracker';
import { getRelationshipManager } from '../src/services/RelationshipManager';
import { TIMING, ALARM_NAMES } from '../src/constants';

export default defineBackground(() => {
  console.log('[UNOS] Background service worker starting...');

  // Initialize services (don't await - register listeners first)
  const storageManager = getStorageManager();
  const tabTracker = getTabTracker();
  const windowTracker = getWindowTracker();
  const relationshipManager = getRelationshipManager();

  // ============================================
  // TAB EVENTS - Register synchronously
  // ============================================

  chrome.tabs.onCreated.addListener((tab) => {
    console.log('[UNOS] Tab created:', tab.id);
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

  chrome.runtime.onInstalled.addListener((details) => {
    console.log('[UNOS] Extension installed/updated:', details.reason);

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

    // Initialize storage and reconcile state
    storageManager.reconcileOnStartup().then((session) => {
      console.log('[UNOS] Reconciliation complete. Session:', session.id);
    }).catch(console.error);
  });

  chrome.runtime.onStartup.addListener(() => {
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

    // Reconcile state
    storageManager.reconcileOnStartup().then((session) => {
      console.log('[UNOS] Startup reconciliation complete. Session:', session.id);
    }).catch(console.error);
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
