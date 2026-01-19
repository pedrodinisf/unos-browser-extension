# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build Commands

```bash
# Development with hot reload
npm run dev                    # Chrome (default)
npm run dev:firefox           # Firefox

# Production build
npm run build                 # Chrome
npm run build:firefox         # Firefox
# Output: .output/chrome-mv3/ or .output/firefox-mv3/

# Type checking
npm run typecheck

# Create distributable
npm run zip                   # Creates .output/chrome-mv3.zip
```

## Testing in Chrome

After building, load the unpacked extension:
1. Navigate to `chrome://extensions/`
2. Enable "Developer mode"
3. Click "Load unpacked"
4. Select `.output/chrome-mv3/` directory
5. After code changes, click the reload button on the extension card

## Critical Architecture Concepts

### 1. Hybrid Storage System

UNOS uses a two-tier storage architecture to handle Manifest V3 service worker limitations:

**chrome.storage.session** (Working State)
- Survives service worker terminations but not browser restarts
- Stores: current session ID, active tab tracking, Chrome ID → persistent ID mappings
- Managed by `StorageManager.workingState`
- Persisted via `persistWorkingState()` after every state change

**IndexedDB via Dexie** (Persistent Data)
- Survives browser restarts
- Stores: tabs, windows, sessions, visits, relationships, tags
- Write-batched via queue (500ms or 100 items triggers flush)
- Accessed through `getDatabase()` singleton

### 2. ID Mapping Strategy

Chrome assigns ephemeral numeric IDs (tab.id, window.id) that change on restart. UNOS uses:

**Persistent IDs**: UUIDs that survive restarts
- Generated via `generateUUID()` from `src/utils/uuid.ts`
- Stored in database records as `persistentId`

**ID Mapping Cache**: LRU cache (1000 entries) in `StorageManager`
- `tabIdCache`: chromeTabId → persistentId
- `windowIdCache`: chromeWindowId → persistentId
- Restored from `chrome.storage.session` on service worker restart

**URL-Based Matching**: On browser restart, tabs are matched by:
- SHA-256 hash of URL (via `hashUrl()` from `src/utils/hash.ts`)
- Query: `db.tabs.where('urlHash').equals(hash).filter(t => t.closedAt !== null)`
- Most recently closed tab with matching URL is reused

### 3. Service Worker Initialization Sequence

**CRITICAL**: Manifest V3 requires synchronous event listener registration at top level. The initialization flow is:

1. **Listener Registration** (`background.ts` top level)
   - All `chrome.tabs.*`, `chrome.windows.*`, `chrome.runtime.*` listeners registered synchronously
   - Services instantiated but NOT awaited

2. **Initialization Trigger** (`chrome.runtime.onInstalled` / `onStartup`)
   - `InitializationService.initialize()` called and AWAITED
   - Tests database accessibility
   - Creates or reuses session
   - Reconciles all open windows/tabs with database
   - Populates ID mapping caches
   - Initializes `StorageManager.workingState`

3. **Event Handling** (async handlers)
   - Tab/window events queued if initialization incomplete
   - Uses ID caches to resolve Chrome IDs to persistent IDs
   - Enqueues database writes (batched via `StorageManager.queueWrite()`)

**Never call `reconcileOnStartup()` twice** - it creates duplicate sessions. Use `InitializationService` as the single entry point.

### 4. Service Layer Responsibilities

**StorageManager** (`src/services/StorageManager.ts`)
- Orchestrates hybrid storage (session + IndexedDB)
- Manages ID mapping caches (LRU)
- Batches writes to IndexedDB (queue + flush timer)
- Handles startup reconciliation (via `InitializationService`)

**TabTracker** (`src/services/TabTracker.ts`)
- Responds to `chrome.tabs.*` events
- Creates/updates `TrackedTab` records
- Tracks visit history and active time
- Uses `StorageManager` for ID lookups and writes

**WindowTracker** (`src/services/WindowTracker.ts`)
- Responds to `chrome.windows.*` events
- Creates/updates `TrackedWindow` records
- Tracks window focus time

**RelationshipManager** (`src/services/RelationshipManager.ts`)
- Tracks opener chains (tab.openerTabId)
- Detects window siblings (same window, close in time)
- Calculates temporal proximity (sequential activations)
- Relationship strength decays over time

**InitializationService** (`src/services/InitializationService.ts`)
- Single source of truth for startup initialization
- Tests database write capability
- Reconciles all Chrome state with database
- Populates ID mapping caches
- Must be called ONCE per service worker lifecycle
- **Note**: Not exported from `src/services/index.ts`; import directly:
  ```typescript
  import { getInitializationService } from '../src/services/InitializationService';
  ```

**ExportService** (`src/services/ExportService.ts`)
- Exports data to JSON, CSV, or ZIP (all tables)
- ZIP export includes: sessions, windows, tabs, visits, relationships, tags as CSVs
- CSV files include UTF-8 BOM for Excel compatibility
- Runs in popup context, fetches data via `GET_ALL_DATA` message
- Methods: `exportAndDownloadJSON()`, `exportAndDownloadCSV()`, `exportAndDownloadZIP()`

### 5. Database Schema (Dexie)

Key indexes for performance:

**tabs** table:
- `&persistentId` - unique lookup
- `chromeTabId` - event mapping (volatile)
- `[sessionId+chromeWindowId]` - compound for window queries
- `[urlHash+sessionId]` - URL-based restart matching
- `*tags` - multi-entry for tag filtering

**tabVisits** table:
- `[tabPersistentId+activatedAt]` - time-series per tab
- `[sessionId+activatedAt]` - session timeline

**sessions** table:
- Primary key is UUID string (not auto-increment)
- `isActive` - find current session
- `expiresAt` - cleanup query

**Compound indexes are critical** for performance. Always query using indexed fields when possible.

### 6. Event Debouncing

`chrome.tabs.onUpdated` fires rapidly for title/URL changes. Debouncing prevents database spam:

**Pattern**: Debounce 100ms, max wait 500ms
```typescript
// src/utils/debounce.ts provides debouncedUpdate utility
tabTracker.handleTabUpdated = debouncedUpdate(
  (tabId, changeInfo, tab) => { /* update logic */ },
  100,  // debounce delay
  500   // max wait
);
```

Applied to: tab updates, focus changes, relationship recalculation.

### 7. Write Batching

Database writes are queued and flushed in batches:

**Queue**: `Map<key, PendingWrite>` in `StorageManager`
- Key format: `${table}:${id}`
- Deduplicates rapid updates to same record

**Flush Triggers**:
- Timer: 500ms after first write (via `setTimeout`)
- Queue size: 100 items
- Alarm: `FLUSH_WRITES` every 5 minutes (fallback)

**Implementation**: `queueWrite()` → `scheduleFlush()` → `flushWrites()`

### 8. Popup → Background Communication

**Message passing** via `chrome.runtime.sendMessage`:

```typescript
// Popup sends request
chrome.runtime.sendMessage(
  { type: 'GET_CURRENT_TAB' },
  (response) => {
    if (response.success) {
      const tab = response.data;
    }
  }
);

// Background handles message
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    const data = await someAsyncOperation();
    sendResponse({ success: true, data });
  })();
  return true; // REQUIRED for async response
});
```

**Message types** (see `background.ts` switch statement):

*Data Retrieval:*
- `GET_CURRENT_TAB` - Get the currently active tab
- `GET_TABS_IN_SESSION` - Get all tabs in current/specified session
- `GET_WINDOWS_IN_SESSION` - Get all windows in current/specified session
- `GET_CURRENT_SESSION` - Get current session ID
- `GET_TAB_RELATIONSHIPS` - Get relationships for a tab
- `GET_TAB_VISITS` - Get visit history for a tab
- `GET_ALL_DATA` - Get all database tables (for export)

*Tab Actions:*
- `SWITCH_TO_TAB` - Focus window and activate tab (params: `chromeTabId`, `chromeWindowId`)
- `CLOSE_TAB` - Close a tab (params: `chromeTabId`)
- `MOVE_TAB_TO_WINDOW` - Move tab to different window (params: `chromeTabId`, `targetWindowId`, `index?`)
- `REORDER_TAB` - Change tab position within window (params: `chromeTabId`, `newIndex`)
- `UPDATE_TAB_METADATA` - Update tags/notes (params: `persistentId`, `tags`, `notes`)
- `SAVE_TAB` - Mark tab as saved (params: `persistentId`)

*Debugging:*
- `PING` - Health check (returns `{ pong: true, timestamp }`)
- `GET_DEBUG_STATS` - Get initialization status and DB counts
- `GET_RECENT_EVENTS` - Fetch logged events
- `FORCE_INIT` / `FORCE_RECONCILE` - Re-run initialization

### 9. Debugging

**Debug Panel** in popup (`🔧 Debug` tab):
- Shows initialization status
- Database record counts
- Recent events log
- "Force Init" button triggers re-initialization

**Service Worker Console**:
```
chrome://extensions/ → UNOS → "service worker" link
```
Look for logs prefixed with `[UNOS]` and `[Init]`

**Critical logs to check**:
- `[Init] Verified: X windows, Y tabs in database` - confirms data written
- `[UNOS] ✓ Initialization complete: {...}` - shows final counts
- `[UNOS] Tab created: X` followed by `[Init] Created tab X -> Y` - confirms ID mapping

**Debug command** (run in Service Worker console):
```javascript
console.log('Session ID:', await chrome.storage.session.get('currentSessionId'));
console.log('Chrome ID Map:', await chrome.storage.session.get('chromeIdToPersistentIdMap'));
```

### 10. Common Pitfalls

**❌ Creating duplicate sessions**
```typescript
// DON'T: Call reconcileOnStartup() multiple times
storageManager.reconcileOnStartup();
storageManager.reconcileOnStartup(); // Creates 2nd session!
```
✅ Use `InitializationService.initialize()` - it's idempotent

**❌ Forgetting async return**
```typescript
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  doAsyncWork().then(sendResponse);
  // Missing return true - response won't be sent!
});
```
✅ Always `return true` for async handlers

**❌ Not checking for null IDs**
```typescript
const persistentId = storageManager.getPersistentTabId(chromeTabId);
await db.tabs.get(persistentId); // ERROR if null!
```
✅ Check cache misses: `if (!persistentId) return;`

**❌ Direct IndexedDB writes bypassing queue**
```typescript
await db.tabs.update(id, { ... }); // Bypasses batching!
```
✅ Use `storageManager.queueWrite()` for all writes

**❌ Modifying working state without persisting**
```typescript
storageManager.workingState.currentSessionId = newId;
// Not saved to chrome.storage.session!
```
✅ Always call `persistWorkingState()` after changes

## File Organization

**Entry points**:
- `entrypoints/background.ts` - Service worker (event handling)
- `entrypoints/popup/` - Extension popup UI (Vue 3)

**Core services** (`src/services/`):
- Each service is a singleton (via `getInstance()` pattern)
- Services depend on `StorageManager` for data access
- Import via `getServiceName()` functions (e.g., `getTabTracker()`)

**Database** (`src/db/`):
- `schema.ts` - Dexie table definitions and indexes
- `types.ts` - TypeScript interfaces for all records

**Constants** (`src/constants/`):
- Timing values (debounce, flush, alarm intervals)
- Storage limits (LRU cache sizes, queue thresholds)
- Retention policies (session expiry, visit pruning)

## UI Components

**App.vue** - Main popup with three view tabs:
- **Recent**: Scrollable list of 20 most recent tabs (click to switch, hover for close button)
- **Windows**: All windows with tabs - fully interactive management view
- **Debug**: Initialization status and diagnostic tools

**AllWindowsView.vue** - High-performance window/tab manager:
- Search bar with debounced filtering (150ms) for 1000+ tabs
- Collapsible windows (expand/collapse all buttons)
- Sort by: index, title, URL, active time, created date
- Compact/expanded view toggle
- Click tab to switch, hover for close button
- Drag-and-drop tabs between windows
- Focus window button (↗)
- Emits: `error`, `tabClosed` events

**DebugPanel.vue** - Diagnostic interface for troubleshooting

**MetadataPanel.vue** - Tag/note editor (slide-out panel)

**ExportDialog.vue** - Export configuration modal:
- **ZIP** (recommended): All tables as separate CSV files with UTF-8 BOM
- **JSON**: Complete data in single file
- **CSV**: Tabs only

## Data Retention & Cleanup

**Alarms** (registered in `background.ts`):
- `FLUSH_WRITES` - Every 5 minutes, flush pending writes
- `CLEANUP` - Every 24 hours, delete expired sessions and prune relationships
- `RELATIONSHIPS` - Every 60 minutes, recalculate temporal relationships

**Retention rules**:
- Unsaved sessions: 7 days (via `expiresAt` field)
- Saved sessions: Forever (set `isSaved = true`)
- Visit history: 30 days (hardcoded in cleanup)
- Weak relationships: Pruned when strength < 0.2

## Performance Targets

- Tab event handling: < 10ms (debounced)
- Database write: < 50ms (batched)
- Popup load: < 100ms
- Export (1000 tabs): < 2s

## Key Dependencies

- **WXT** (0.20.x): Extension framework, wraps Vite
- **Vue** (3.5.x): Popup UI framework (Composition API)
- **Dexie** (4.0.x): IndexedDB wrapper with type-safe queries
- **JSZip** (3.10.x): ZIP file creation for export
- **TypeScript** (5.7.x): Type checking
- **Vitest** (dev): Unit testing framework

## Extension Manifest (Manifest V3)

**Permissions required**:
- `tabs` - Read tab state and events
- `storage` - Access chrome.storage.session
- `alarms` - Schedule periodic tasks
- `<all_urls>` - Read tab URLs for tracking

**Service worker** runs in `background.js` (generated by WXT)
**Popup** runs in isolated context with CSP restrictions

## Testing

### Commands

```bash
# Run all tests once
npm test

# Run tests in watch mode (re-runs on file changes)
npm run test:watch

# Run tests with coverage report
npm run test:coverage
```

### Test Framework

- **Vitest** - Fast unit test framework compatible with Vite
- **happy-dom** - Lightweight DOM implementation for testing
- **Configuration**: `vitest.config.ts`

### Test Structure

```
src/__tests__/
├── setup.ts              # Global mocks (Chrome APIs)
├── ExportService.test.ts # Service tests
└── utils.test.ts         # Utility function tests
```

### Chrome API Mocking

Tests run outside the browser, so Chrome APIs must be mocked. The setup file (`src/__tests__/setup.ts`) provides:

```typescript
// Available mocks (imported from setup.ts)
import { mockSendMessage, mockTabs, mockWindows } from './setup';

// Example: Mock a message response
mockSendMessage.mockImplementation((message, callback) => {
  if (message.type === 'GET_ALL_DATA') {
    callback({ success: true, data: { tabs: [], windows: [] } });
  }
});

// Example: Verify a Chrome API was called
expect(mockTabs.update).toHaveBeenCalledWith(1, { active: true });
```

### Writing Tests

**Service tests** - Test business logic in isolation:
```typescript
describe('ExportService', () => {
  it('should escape CSV values with commas', () => {
    const service = new ExportService();
    // Access private method for testing
    const escape = (service as any).escapeCSV.bind(service);
    expect(escape('hello, world')).toBe('"hello, world"');
  });
});
```

**Utility tests** - Test pure functions:
```typescript
describe('hashUrlSync', () => {
  it('should return consistent hash for same URL', () => {
    const hash1 = hashUrlSync('https://example.com');
    const hash2 = hashUrlSync('https://example.com');
    expect(hash1).toBe(hash2);
  });
});
```

**Async tests with timers** - Use fake timers for debounce/throttle:
```typescript
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

it('should debounce calls', () => {
  const fn = vi.fn();
  const debounced = debounce(fn, 100);

  debounced();
  debounced();
  expect(fn).not.toHaveBeenCalled();

  vi.advanceTimersByTime(100);
  expect(fn).toHaveBeenCalledTimes(1);
});
```

### Test Coverage

Run `npm run test:coverage` to generate a coverage report. Output:
- Terminal summary
- `coverage/` directory with HTML report

Target coverage areas:
- `src/services/` - Core business logic
- `src/utils/` - Utility functions
- Excluded: `src/db/types.ts` (type definitions only)

### Mock Data Factories

Create consistent test data using factory functions:

```typescript
function createMockTab(overrides: Partial<TrackedTab> = {}): TrackedTab {
  return {
    persistentId: 'tab-1',
    chromeTabId: 1,
    url: 'https://example.com',
    title: 'Example',
    // ... other required fields
    ...overrides,
  };
}

// Usage
const tab = createMockTab({ title: 'Custom Title' });
```
