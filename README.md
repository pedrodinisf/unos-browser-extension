# UNOS Tab Tracker

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

### Interactive Tab Management (NEW)
- **Click to Navigate** - Click any tab in the popup to instantly switch to it
- **Close Tabs** - Hover over tabs to reveal close button
- **Drag & Drop** - Move tabs between windows by dragging
- **Search & Filter** - Search across 1000+ tabs with debounced filtering
- **Sort Options** - Sort by index, title, URL, active time, or creation date
- **Compact View** - Toggle dense display for large tab counts
- **Collapsible Windows** - Expand/collapse windows with one click

### Export (NEW)
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
│   ├── background.ts           # Service worker - event handling
│   └── popup/
│       ├── index.html
│       ├── main.ts
│       ├── App.vue             # Main popup component
│       └── components/
│           ├── AllWindowsView.vue  # Tab management UI
│           ├── DebugPanel.vue      # Debug interface
│           ├── MetadataPanel.vue   # Tag/notes editor
│           └── ExportDialog.vue    # Export options
├── src/
│   ├── __tests__/              # Test files
│   │   ├── ExportService.test.ts
│   │   └── utils.test.ts
│   ├── db/
│   │   ├── schema.ts           # Dexie database schema
│   │   └── types.ts            # TypeScript interfaces
│   ├── services/
│   │   ├── StorageManager.ts   # Hybrid storage orchestration
│   │   ├── TabTracker.ts       # Tab event handling
│   │   ├── WindowTracker.ts    # Window event handling
│   │   ├── RelationshipManager.ts  # Relationship tracking
│   │   ├── InitializationService.ts # Startup coordination
│   │   └── ExportService.ts    # Export functionality (JSON/CSV/ZIP)
│   ├── utils/
│   │   ├── debounce.ts         # Debounce/throttle utilities
│   │   ├── hash.ts             # URL hashing for persistence
│   │   └── uuid.ts             # UUID generation
│   └── constants/
│       └── index.ts            # Timing, limits, retention policies
├── vitest.config.ts            # Test configuration
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

## Browser Permissions

- `tabs` - Monitor tab events
- `storage` - Persist working state
- `alarms` - Schedule cleanup tasks
- `<all_urls>` - Read tab URLs for tracking

## Future Plans

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
