# System Prompt: Integrate X Bookmark Features into UNOS_WEB_EXTENSION

You are working inside `/Users/pedro/Documents/PROJECTS/UNOS_WEB_EXTENSION`, a Chrome extension (Manifest V3) built with **WXT + Vue 3 + TypeScript + Dexie.js (IndexedDB)**.

## Objective

Integrate the features from the standalone Python CLI project `x_bookmark_exporter` (located at `/Users/pedro/Documents/PROJECTS/x_bookmark_exporter` — READ ONLY reference, do not modify) into UNOS_WEB_EXTENSION as a new native extension module. The Python project uses Playwright to automate a browser externally; since UNOS already runs *inside* Chrome, the extension can access X/Twitter pages directly — no Playwright, no external browser, no cookie export dance.

## What the Source Project Does (x_bookmark_exporter)

A CLI tool that:
1. **Syncs X/Twitter bookmarks** — navigates to `https://x.com/i/bookmarks`, scrolls through the page, extracts tweet data from DOM using `data-testid` selectors, and stores them locally
2. **Incremental sync** — stops scrolling after 5 consecutive already-known bookmarks (efficient re-sync)
3. **Video download** — uses yt-dlp + exported browser cookies to download the highest quality video from any X post
4. **Markdown generation** — produces README with stats, full bookmark listing, and monthly archive files
5. **Daemon/watch mode** — re-syncs every N minutes automatically

### Source Data Model (replicate in Dexie)

```typescript
interface XBookmark {
  // Core tweet data
  tweetId: string;              // Unique — extracted from /status/{id} in URL
  authorHandle: string;         // @username
  authorName: string;           // Display name
  text: string;                 // Full tweet content
  timestamp: string;            // ISO 8601 from <time datetime="">
  tweetUrl: string;             // https://x.com/{handle}/status/{id}

  // Media
  mediaUrls: string[];          // Image URLs from [data-testid="tweetPhoto"] img src
  hasVideo: boolean;            // True if [data-testid="videoPlayer"] exists
  isQuoteTweet: boolean;        // True if [data-testid="quoteTweet"] exists

  // Sync metadata
  firstSeenAt: number;          // Timestamp when first synced
  lastSeenAt: number;           // Timestamp of most recent sync encounter

  // Categorization (future AI integration)
  categories: string[];
  tags: string[];
  notes: string;

  // Status
  archived: boolean;            // Soft delete
}
```

### Source DOM Selectors (for scraping bookmarks page)

These are the `data-testid` selectors used on `https://x.com/i/bookmarks`:

| Element | Selector | Extracts |
|---------|----------|----------|
| Tweet container | `article[data-testid="tweet"]` | Parent wrapper per bookmark |
| Tweet text | `[data-testid="tweetText"]` | `.innerText` → full content |
| Author info | `[data-testid="User-Name"]` | `.innerText` → name + @handle (multiline) |
| Timestamp | `time` element | `.getAttribute('datetime')` → ISO 8601 |
| Tweet link | `<a>` ancestor of `time` | `.getAttribute('href')` → extract `/status/(\d+)` |
| Images | `[data-testid="tweetPhoto"] img` | `.src` → image URLs |
| Video flag | `[data-testid="videoPlayer"]` | Existence check → boolean |
| Quote flag | `[data-testid="quoteTweet"]` | Existence check → boolean |

### Source Incremental Sync Algorithm

```
1. Load known tweet IDs from storage
2. Navigate to https://x.com/i/bookmarks
3. Loop:
   a. Query all article[data-testid="tweet"] on page
   b. For each tweet:
      - Extract data using selectors above
      - If tweetId in knownIds: increment consecutiveKnown counter
      - If new: add to results, reset consecutiveKnown to 0
   c. If consecutiveKnown >= 5: STOP (incremental sync complete)
   d. Scroll to bottom: window.scrollTo(0, document.body.scrollHeight)
   e. Wait scrollDelay (2s)
   f. If page height unchanged 3 times: STOP (reached end)
4. Merge new bookmarks into storage (preserve firstSeenAt, update lastSeenAt)
```

## UNOS_WEB_EXTENSION Architecture (must follow these patterns)

### Build & Dev

```bash
npm run dev          # Dev with hot reload (Chrome)
npm run build        # Production build → .output/chrome-mv3/
npm run typecheck    # Type checking
```

### Tab/View System (how the popup UI works)

In `entrypoints/popup/App.vue`:
- A `ref` controls active view: `const activeView = ref<'recent' | 'windows' | 'debug'>('recent')`
- Tab buttons in `.view-tabs` div toggle the ref
- `v-if` / `v-else-if` conditionally renders the matching component
- View components live in `entrypoints/popup/components/`

**To add the new "X BOOKMARKS" tab:**
1. Extend the type: `'recent' | 'windows' | 'debug' | 'xbookmarks'`
2. Add a tab button in the `.view-tabs` container
3. Create `XBookmarksView.vue` in `entrypoints/popup/components/`
4. Add `v-else-if="activeView === 'xbookmarks'"` rendering block

### Message Passing (popup ↔ background)

Popup uses a helper:
```typescript
async function sendMessage<T>(message: Record<string, unknown>): Promise<T> {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      if (!response.success) {
        reject(new Error(response.error || 'Unknown error'));
        return;
      }
      resolve(response.data as T);
    });
  });
}
```

Background handles in `entrypoints/background.ts` via a switch on `message.type`. Always `return true` for async handlers.

### Database (Dexie + IndexedDB)

- Schema defined in `src/db/schema.ts` — add new tables there
- Types in `src/db/types.ts` — add interfaces there
- Singleton via `getDatabase()` from `src/db/index.ts`
- Write batching via `StorageManager.queueWrite()` for high-frequency updates
- Direct `db.table.put()` / `db.table.add()` is fine for low-frequency operations like bookmark sync

### Service Pattern

Services in `src/services/` use singleton pattern:
```typescript
let instance: MyService | null = null;
export function getMyService(): MyService {
  if (!instance) instance = new MyService();
  return instance;
}
```

### CSS Theme (must match)

```css
--bg-page: #F5F4EE;        /* Off-white page */
--bg-card: #F5F5F0;        /* Card background */
--bg-alt: #EEEDE8;         /* Alternate background */
--bg-header: #2A3328;      /* Dark olive header */
--text-primary: #2D2D2D;
--text-secondary: #6B7280;
--text-muted: #9CA3AF;
--accent-green: #059669;   /* Primary action */
--accent-amber: #D97706;   /* Time/duration */
--accent-red: #DC2626;     /* Destructive */
--border-light: #D1D5DB;
--border-warm: #C9C5B8;
--font-mono: 'Monaco', 'Menlo', 'Consolas', monospace;
```

Popup is 700x600px. Use existing CSS variables. NASA/DARPA minimal aesthetic.

### File Organization

```
entrypoints/
  popup/
    App.vue                         # Main popup
    components/
      AllWindowsView.vue            # Existing tab view
      DebugPanel.vue                # Existing tab view
      ExportDialog.vue              # Dialog pattern
      XBookmarksView.vue            # ← NEW: create this
  background.ts                     # Service worker — add message handlers here
  x-bookmarks-sync.content.ts       # ← NEW: content script for DOM scraping

src/
  db/
    schema.ts                       # ← MODIFY: add xBookmarks table
    types.ts                        # ← MODIFY: add XBookmark interface
  services/
    XBookmarkService.ts             # ← NEW: sync logic, storage, export
```

## Implementation Plan

### Phase 1: Database & Types

1. Add `XBookmark` interface to `src/db/types.ts` (see data model above, add `id?: number` auto-increment)
2. Add `XSyncState` interface: `{ lastSyncAt: number; totalBookmarks: number; lastSyncNewCount: number; syncCount: number }`
3. Add `xBookmarks` and `xSyncState` tables to Dexie schema in `src/db/schema.ts`:
   - `xBookmarks`: indexes on `&tweetId`, `timestamp`, `authorHandle`, `*tags`, `archived`
   - `xSyncState`: single-row config table

### Phase 2: Content Script for DOM Scraping

Create `entrypoints/x-bookmarks-sync.content.ts` — a content script that:
- Only activates on `https://x.com/i/bookmarks` and `https://twitter.com/i/bookmarks`
- Exposes functions via message passing to:
  - Extract all visible tweets from DOM using the selectors listed above
  - Scroll the page programmatically
  - Report scroll position and page height
- Does NOT auto-run — only responds to messages from the background service worker
- Register in `wxt.config.ts` with `matches: ['https://x.com/i/bookmarks*', 'https://twitter.com/i/bookmarks*']`

### Phase 3: XBookmarkService

Create `src/services/XBookmarkService.ts`:
- `syncBookmarks(tabId: number, fullSync?: boolean)`: orchestrates the sync
  - Sends messages to the content script in the bookmarks tab to extract + scroll
  - Implements the incremental sync algorithm (stop after 5 consecutive known)
  - Merges results into Dexie (preserve firstSeenAt, update lastSeenAt)
  - Updates sync state
- `getBookmarks(options?: { includeArchived?: boolean })`: query from Dexie
- `getBookmarksByMonth()`: group by YYYY-MM
- `archiveBookmark(tweetId: string)`: soft delete
- `updateBookmarkMeta(tweetId: string, tags: string[], notes: string, categories: string[])`: metadata editing
- `getSyncState()`: return current sync stats
- `exportAsMarkdown()`: generate markdown string (stats + bookmark listing)
- `exportAsJSON()`: full data export

### Phase 4: Background Message Handlers

Add these message types to the switch in `entrypoints/background.ts`:

| Message Type | Params | Returns |
|-------------|--------|---------|
| `X_SYNC_BOOKMARKS` | `{ fullSync?: boolean }` | `{ newCount: number, total: number }` |
| `X_GET_BOOKMARKS` | `{ includeArchived?: boolean, page?: number, limit?: number }` | `XBookmark[]` |
| `X_GET_SYNC_STATE` | — | `XSyncState` |
| `X_ARCHIVE_BOOKMARK` | `{ tweetId: string }` | `{ success: boolean }` |
| `X_UPDATE_BOOKMARK_META` | `{ tweetId, tags, notes, categories }` | `{ success: boolean }` |
| `X_EXPORT_BOOKMARKS` | `{ format: 'json' \| 'markdown' }` | `{ data: string, filename: string }` |

For `X_SYNC_BOOKMARKS`: the background must first find or create a tab on `x.com/i/bookmarks`, then use `chrome.tabs.sendMessage(tabId, ...)` to communicate with the content script for DOM extraction and scrolling.

### Phase 5: XBookmarksView.vue (the new tab)

Create `entrypoints/popup/components/XBookmarksView.vue`:

**Layout:**
- **Header bar**: Sync button (with spinner during sync), last sync timestamp, bookmark count, export dropdown (JSON/Markdown)
- **Search/filter bar**: Text search across tweet content + author, filter by tags, toggle archived visibility
- **Bookmark list**: Scrollable list of bookmarks, newest first
  - Each row: author avatar area (handle initial), author name + @handle, truncated tweet text, timestamp, media indicators (image count, video badge), tag pills
  - Click to expand: full tweet text, media preview thumbnails, tag editor, notes field, archive button
  - If `hasVideo`: show a "Download Video" button (see Phase 6)
- **Empty state**: "No bookmarks synced yet. Open x.com/i/bookmarks in a tab and click Sync."
- **Sync progress indicator**: When sync is running, show progress (e.g., "Syncing... 47 bookmarks found")

**Key interactions:**
- **Sync button**: Sends `X_SYNC_BOOKMARKS` message. If no tab is open on x.com/i/bookmarks, prompt user to open one (or open it programmatically via `chrome.tabs.create`)
- **Search**: Debounced (300ms) client-side filtering
- **Tag editing**: Inline tag pills with add/remove, same pattern as MetadataPanel.vue
- **Export**: Download via `chrome.downloads.download()` or Blob URL

### Phase 6: Video Download (Extension-Native Approach)

The Python project uses yt-dlp which is unavailable in a browser extension. Instead:

**Option A — Simple (recommended for v1):**
- For tweets with video, provide a "Copy video URL" button
- Use the content script to extract the video source URL from the tweet's `<video>` element or intercept the blob/m3u8 URL
- User can paste into yt-dlp or another tool externally

**Option B — Direct download (stretch goal):**
- Use `chrome.webRequest` or `chrome.declarativeNetRequest` to intercept `.mp4` / `.m3u8` requests when a video tweet is loaded
- Capture the highest-quality video URL from X's CDN (usually `video.twimg.com`)
- Download via `chrome.downloads.download({ url: videoUrl })`
- Note: This may require additional permissions (`webRequest`, `webRequestBlocking`) and host permissions for `video.twimg.com`

Start with Option A. Add a note in the UI: "Open tweet → right-click video → Save" as fallback.

### Phase 7: Periodic Auto-Sync (Optional Enhancement)

- Register a `chrome.alarms` alarm (e.g., `X_BOOKMARK_SYNC` every 30 minutes)
- On alarm fire, check if a tab with `x.com/i/bookmarks` is open
- If yes, perform incremental sync silently
- If no, skip (don't force-open tabs)
- Add a toggle in the XBookmarksView header: "Auto-sync: ON/OFF"
- Store preference in `chrome.storage.local`

## Critical Rules

1. **Follow existing patterns exactly** — singleton services, message passing, Dexie schema, Vue component structure, CSS variables
2. **No external dependencies** — no Playwright, no yt-dlp, no new npm packages unless absolutely necessary
3. **Content script isolation** — the DOM scraping content script should be minimal and only respond to messages; all business logic lives in the service
4. **Incremental by default** — always use incremental sync unless user explicitly requests full sync
5. **No data loss** — merging bookmarks must preserve existing metadata (tags, notes, categories, firstSeenAt)
6. **Match the aesthetic** — dark olive header, warm beige body, monospace accents, NASA/DARPA feel
7. **Performance** — the popup must load fast; lazy-load bookmark data, paginate if > 100 bookmarks
8. **Type safety** — full TypeScript, no `any` types, proper interfaces for all data structures
9. **Test the content script selectors** — X/Twitter changes their DOM; the `data-testid` selectors are stable but verify they still work before assuming
10. **Read the existing CLAUDE.md** in the project root for additional architectural context and patterns

## Reference Files (read these first)

- `CLAUDE.md` — comprehensive architecture guide (already in the project)
- `entrypoints/popup/App.vue` — main popup, tab switching pattern
- `entrypoints/popup/components/AllWindowsView.vue` — complex view component example
- `entrypoints/popup/components/ExportDialog.vue` — dialog pattern example
- `entrypoints/background.ts` — message handler switch statement
- `src/db/schema.ts` — database table definitions
- `src/db/types.ts` — TypeScript interfaces
- `src/services/StorageManager.ts` — service pattern example
- `/Users/pedro/Documents/PROJECTS/x_bookmark_exporter/extract_bookmarks.py` — DOM extraction reference (READ ONLY)
- `/Users/pedro/Documents/PROJECTS/x_bookmark_exporter/storage.py` — data model reference (READ ONLY)
- `/Users/pedro/Documents/PROJECTS/x_bookmark_exporter/sync.py` — sync orchestration reference (READ ONLY)
