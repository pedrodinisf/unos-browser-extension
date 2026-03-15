# UNOS Web Extension

A Chrome extension for continuous tab tracking with relationship analysis, metadata tagging, and comprehensive export capabilities.

## Features

### Core Tracking
- **Continuous Tab Monitoring** - Track all tab activity with near-zero CPU overhead
- **Visit History** - Record every tab activation with timestamps and duration
- **Time Tracking** - Calculate total active time spent on each tab
- **Relationship Tracking** - Automatically detect opener chains, window siblings, and temporal proximity
- **Metadata Tagging** - Add custom tags and notes to any tab
- **Session Management** - Organize browsing into sessions with automatic 7-day retention
- **Persistence** - Data survives browser restarts via URL-based matching
- **Incognito Support** - Track incognito tabs with explicit flagging

### Interactive Tab Management
- **Double-click to Navigate** - Double-click any tab to switch to it (popup stays open)
- **Close Tabs** - Hover over tabs to reveal close button
- **Drag & Drop** - Move tabs between windows by dragging
- **Multi-Tab Selection** - Checkboxes on each tab row; Shift+click for range select, Ctrl/Cmd+click to toggle
- **Bulk Actions** - Floating action bar appears when tabs are selected:
  - Add tags to all selected tabs
  - Move selected to a new window
  - Move selected to an existing window (dropdown)
  - Close all selected tabs
  - Multi-drag: drag a selected tab to move all selected tabs together
- **Select All per Window** - Checkbox in window header with indeterminate state
- **Search & Filter** - Search across 1000+ tabs with debounced filtering
- **Sort Options** - Sort by index, title, URL, active time, or creation date
- **Compact View** - Toggle dense display for large tab counts
- **Collapsible Windows** - Expand/collapse windows with one click
- **Window Labels** - Human-readable "Window 1, 2, 3..." with Chrome IDs shown in grey
- **Quick Copy** - Hover over current tab title to copy title or URL to clipboard

### X/Twitter Bookmarks
- **Bookmark Sync** — Syncs bookmarks from `x.com/i/bookmarks` directly inside Chrome
- **Incremental Sync** — Stops early after finding 5 consecutive known bookmarks
- **Full Sync** — Scrolls through entire bookmarks page to capture everything
- **Search & Filter** — Debounced text search across tweet content and author handles
- **Sort** — Sort by bookmarked date (default), tweet date, or author; toggle asc/desc
- **Content Filters** — Filter by has images, has video, or has tags via dropdown
- **Infinite Scroll** — Auto-loads more bookmarks as you scroll (replaces manual "Load more" button)
- **Tag & Notes** — Add tags and notes to any bookmark, inline editing
- **Archive** — Soft-delete bookmarks without losing data
- **Export** — JSON or Markdown export (Markdown groups by month with stats)
- **Video Download** — Download videos from bookmarked tweets via yt-dlp (requires native host setup)
- **Quick Video Download** — Header toolbar button auto-detects bookmarked tweets with video on the active tab (uses `data-testid` for reliable detection)
- **Media Indicators** — Image count badges and video flags on each bookmark

### Tools Menu
- **TOOLS Dropdown** - Header button with NASA/DARPA styling
- **Export** - ZIP, JSON, or CSV export
- **URL Grepper** - Extract, filter, and download URLs from any page via regex
- **Scroll Screenshot** - Full-page scroll capture stitched into a single PNG

### Export
- **ZIP Export** (Recommended) - All tables as separate CSV files
  - sessions.csv, windows.csv, tabs.csv
  - visits.csv, relationships.csv, tags.csv
  - manifest.json with export metadata
- **JSON Export** - Complete data in single file
- **CSV Export** - Tabs only
- UTF-8 BOM included for Excel compatibility

## Tech Stack

- **Framework**: [WXT](https://wxt.dev/) - Next-gen web extension framework with Vite
- **Language**: TypeScript
- **UI**: Vue 3 with Composition API
- **Storage**: IndexedDB via [Dexie.js](https://dexie.org/) + chrome.storage.session
- **Export**: [JSZip](https://stuk.github.io/jszip/) for ZIP file creation
- **Testing**: Vitest
- **Target**: Chrome Extension Manifest V3

## Installation

### From Source

```bash
# Clone the repository
git clone https://github.com/pedrodinisf/unos-browser-extension.git
cd unos-browser-extension

# Install dependencies
npm install

# Build for production
npm run build
```

### Load in Chrome

1. Open Chrome and navigate to `chrome://extensions/`
2. Enable "Developer mode" in the top right
3. Click "Load unpacked"
4. Select the `.output/chrome-mv3/` directory

## Video Download Setup (Optional)

The X Bookmarks video download feature uses a **native messaging host** to invoke `yt-dlp` locally. This requires one-time setup:

### Prerequisites

```bash
# macOS — install yt-dlp and ffmpeg
brew install yt-dlp ffmpeg
```

### Install the Native Host

```bash
cd native-host
./install.sh
```

The install script will:
1. Create a local `.venv/` and install `yt-dlp` into it
2. Prompt for your extension ID (find it at `chrome://extensions`)
3. Register the native messaging host with Chrome

After installing, **restart Chrome** for the native host to take effect.

### How It Works

```
Popup "Download Video" → Background service worker → chrome.cookies.getAll (X auth)
    → chrome.runtime.sendNativeMessage → native-host/unos_video_host.py
    → yt-dlp subprocess (from .venv) → ~/Downloads/{tweet_id}.mp4
```

- The extension extracts your X/Twitter auth cookies directly (no Playwright/browser launch needed)
- Cookies are sent to the native host via Chrome's native messaging protocol
- The native host converts cookies to Netscape format, runs yt-dlp, and returns the file path
- Videos are saved to `~/Downloads/` as `{tweet_id}.mp4`

### Troubleshooting

| Error | Fix |
|-------|-----|
| "Native host not installed" | Run `cd native-host && ./install.sh` |
| "yt-dlp not found" | Run `brew install yt-dlp` or re-run `./install.sh` |
| "Native host crashed" | Check that `python3` is available and `.venv/` exists |
| Auth/login errors | Make sure you're logged in to `x.com` in Chrome |

## Development

```bash
# Start development server with hot reload
npm run dev

# Type check
npm run typecheck

# Build for production
npm run build

# Create distributable zip
npm run zip

# Run tests
npm test

# Run tests in watch mode
npm run test:watch

# Run tests with coverage
npm run test:coverage
```

## Project Structure

```
unos_browser_extension/
├── entrypoints/
│   ├── background.ts                  # Service worker - event handling
│   ├── url-grepper.content.ts         # Content script for URL extraction
│   ├── x-bookmarks-sync.content.ts    # Content script for X bookmark DOM extraction
│   └── popup/
│       ├── index.html
│       ├── main.ts
│       ├── App.vue                    # Main popup component
│       └── components/
│           ├── AllWindowsView.vue     # Tab management UI
│           ├── XBookmarksView.vue     # X/Twitter bookmark manager
│           ├── DebugPanel.vue         # Debug interface
│           ├── MetadataPanel.vue      # Tag/notes editor
│           ├── ExportDialog.vue       # Export options
│           ├── UrlGrepperDialog.vue   # URL grepper UI
│           └── ScrollCaptureDialog.vue # Scroll screenshot UI
├── native-host/
│   ├── unos_video_host.py             # Native messaging host (yt-dlp)
│   ├── install.sh                     # macOS installer
│   ├── requirements.txt               # Python dependencies
│   └── .venv/                         # Local venv (gitignored, created by install.sh)
├── public/
│   ├── captureEngine.js               # Injected into pages for scroll capture
│   ├── offscreen.html                 # Offscreen document for frame stitching
│   └── offscreen.js                   # Canvas stitching logic
├── src/
│   ├── __tests__/                     # Test files
│   │   ├── ExportService.test.ts
│   │   └── utils.test.ts
│   ├── db/
│   │   ├── schema.ts                  # Dexie database schema (v1 + v2)
│   │   └── types.ts                   # TypeScript interfaces
│   ├── services/
│   │   ├── StorageManager.ts          # Hybrid storage orchestration
│   │   ├── TabTracker.ts              # Tab event handling
│   │   ├── WindowTracker.ts           # Window event handling
│   │   ├── RelationshipManager.ts     # Relationship tracking
│   │   ├── InitializationService.ts   # Startup coordination
│   │   ├── ExportService.ts           # Export functionality (JSON/CSV/ZIP)
│   │   ├── CaptureService.ts          # Scroll screenshot orchestration
│   │   ├── XBookmarkService.ts        # X bookmark sync & management
│   │   └── VideoDownloadService.ts    # Video download via native messaging
│   ├── utils/
│   │   ├── debounce.ts                # Debounce/throttle utilities
│   │   ├── hash.ts                    # URL hashing for persistence
│   │   └── uuid.ts                    # UUID generation
│   └── constants/
│       └── index.ts                   # Timing, limits, retention policies
├── vitest.config.ts                   # Test configuration
├── wxt.config.ts
├── tsconfig.json
└── package.json
```

## Architecture

### Data Flow

```
Chrome Events → Service Worker → StorageManager → IndexedDB
                     ↓
              TabTracker / WindowTracker
                     ↓
              RelationshipManager
```

### Storage Strategy

UNOS uses a hybrid storage approach:

1. **Working State** (`chrome.storage.session`)
   - Current session ID
   - Active tab tracking
   - Chrome ID to persistent ID mappings
   - Survives service worker restarts

2. **Persistent Data** (IndexedDB via Dexie)
   - All tab, window, and session records
   - Visit history
   - Relationships
   - Tags and metadata

### Performance Optimizations

| Technique | Implementation |
|-----------|----------------|
| Write Batching | Queue writes, flush every 500ms or 100 items |
| Event Debouncing | Tab updates debounced 100ms, max 500ms |
| LRU Cache | Chrome ID → persistent ID map (1000 entries) |
| Compound Indexes | `[sessionId+chromeWindowId]`, `[urlHash+sessionId]` |
| Lazy Initialization | Database opens on first access |

## Data Model

### TrackedTab
```typescript
{
  persistentId: string;       // UUID - survives browser restart
  chromeTabId: number;        // Runtime only
  url: string;
  urlHash: string;            // SHA-256 for URL matching
  title: string;
  openerPersistentId: string | null;
  createdAt: number;
  lastActivatedAt: number;
  totalActiveTime: number;    // Cumulative milliseconds
  sessionId: string;
  isSaved: boolean;
  tags: string[];
  notes: string;
}
```

### TabRelationship
```typescript
{
  sourceTabPersistentId: string;
  targetTabPersistentId: string;
  relationshipType: 'opener' | 'sibling' | 'temporal';
  strength: number;           // 0-1, decays over time
}
```

### Session
```typescript
{
  id: string;
  name: string;
  startedAt: number;
  endedAt: number | null;
  isActive: boolean;
  isSaved: boolean;           // Saved sessions persist forever
  expiresAt: number | null;   // 7 days for unsaved sessions
}
```

### XBookmark
```typescript
{
  tweetId: string;            // Unique — from /status/{id}
  authorHandle: string;       // @username
  authorName: string;         // Display name
  text: string;               // Full tweet content
  timestamp: string;          // ISO 8601 from tweet
  tweetUrl: string;           // https://x.com/{handle}/status/{id}
  mediaUrls: string[];        // Image URLs
  hasVideo: boolean;
  isQuoteTweet: boolean;
  firstSeenAt: number;        // Set once on first sync
  lastSeenAt: number;         // Updated each sync
  tags: string[];
  notes: string;
  archived: boolean;          // Soft delete
}
```

## Export Formats

### ZIP Export (Recommended)
Downloads a ZIP file containing separate CSV files for each table:
- `sessions_YYYY-MM-DD.csv` - Session records
- `windows_YYYY-MM-DD.csv` - Window records
- `tabs_YYYY-MM-DD.csv` - Tab records with all metadata
- `visits_YYYY-MM-DD.csv` - Visit history
- `relationships_YYYY-MM-DD.csv` - Tab relationships
- `tags_YYYY-MM-DD.csv` - Tag definitions
- `manifest.json` - Export metadata and stats

All CSV files include UTF-8 BOM for Excel compatibility.

### JSON Export
Complete data export in a single JSON file including:
- Sessions, Windows, Tabs
- Visit history (optional)
- Relationships (optional)
- Tags

### CSV Export
Single CSV file with tab data:
- persistentId, chromeTabId, url, title
- createdAt, lastActivatedAt, totalActiveTimeMinutes
- windowPersistentId, chromeWindowId, sessionId
- index, pinned, groupId
- tags, notes, isIncognito, isSaved, closedAt

## Testing

UNOS uses [Vitest](https://vitest.dev/) for unit testing with [happy-dom](https://github.com/nickytonline/happy-dom) for DOM simulation.

### Running Tests

```bash
# Run all tests once
npm test

# Run tests in watch mode (re-runs on file changes)
npm run test:watch

# Run tests with coverage report
npm run test:coverage
```

### Test Structure

```
src/__tests__/
├── setup.ts              # Chrome API mocks
├── ExportService.test.ts # Export functionality tests
└── utils.test.ts         # Utility function tests (UUID, hash, debounce)
```

### What's Tested

| Category | Tests | Description |
|----------|-------|-------------|
| ExportService | 23 | CSV generation, escaping, ZIP creation, JSON export |
| UUID Utils | 4 | UUID v4 format validation, uniqueness |
| Hash Utils | 9 | URL normalization, consistent hashing |
| Debounce/Throttle | 14 | Timing, cancellation, leading/trailing edge |
| View Helpers | 8 | formatTime, getDomain functions |

### Chrome API Mocking

Since tests run in Node.js, Chrome extension APIs are mocked in `src/__tests__/setup.ts`:

- `chrome.runtime.sendMessage` - Message passing
- `chrome.tabs.*` - Tab operations
- `chrome.windows.*` - Window operations
- `chrome.storage.session` - Session storage

### Adding New Tests

1. Create test file in `src/__tests__/` with `.test.ts` extension
2. Import mocks from `./setup` if needed
3. Use factory functions for mock data (see `ExportService.test.ts`)

```typescript
import { describe, it, expect } from 'vitest';
import { mockSendMessage } from './setup';

describe('MyFeature', () => {
  it('should do something', () => {
    // Test implementation
  });
});
```

## Data Retention

- **Unsaved sessions**: Automatically deleted after 7 days
- **Saved sessions**: Retained indefinitely
- **Visit history**: Pruned after 30 days
- **Weak relationships**: Pruned when strength < 0.2

### URL Grepper
- Toggle URL collection on/off per browsing session
- Regex filter — live-filter the collected URL list
- Content script scans all `<a href>` links on the active page
- Copy filtered URLs to clipboard or download as `.txt`
- State persisted in `chrome.storage.local`

### Scroll Screenshot
- Captures full-page screenshots by scrolling from top to bottom
- Configurable scroll delay (300ms / 500ms / 1000ms) for heavy pages
- Automatically hides sticky/fixed elements during capture
- Stitches viewport frames into a single PNG via an offscreen document
- Saves directly to the user's Downloads folder (no save dialog)
- Progress bar with status updates in the popup UI
- Handles lazy-loading pages (re-checks scroll height after each frame)

## Browser Permissions

- `tabs` - Monitor tab events and capture visible tab
- `storage` - Persist working state
- `alarms` - Schedule cleanup tasks
- `downloads` - Save scroll screenshots and URL exports
- `scripting` - Inject capture engine into pages
- `offscreen` - Stitch screenshot frames off-screen
- `cookies` - Read X/Twitter auth cookies for video download
- `nativeMessaging` - Communicate with local yt-dlp host for video download
- `<all_urls>` - Read tab URLs for tracking

## Future Plans

- **Keyboard shortcuts** - Open UNOS as a persistent panel window
- PKM (Personal Knowledge Management) integration interface
- Firefox support
- Advanced search and filtering
- Tab grouping visualization
- Relationship graph view

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## License

MIT License - see [LICENSE](LICENSE) file for details.

## Acknowledgments

- [WXT](https://wxt.dev/) for the excellent extension framework
- [Dexie.js](https://dexie.org/) for the IndexedDB wrapper
- [Vue.js](https://vuejs.org/) for the reactive UI framework
