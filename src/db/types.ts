// Database entity types for UNOS Web Extension

/**
 * Core tracked tab entity - the primary data structure
 */
export interface TrackedTab {
  /** Auto-increment primary key for IndexedDB */
  id?: number;
  /** UUID - persistent identifier that survives browser restart */
  persistentId: string;
  /** Chrome's session-specific tab ID (changes on restart) */
  chromeTabId: number;
  /** Chrome's session-specific window ID */
  chromeWindowId: number;
  /** Current URL */
  url: string;
  /** SHA-256 hash of normalized URL for matching */
  urlHash: string;
  /** Page title */
  title: string;
  /** Favicon URL */
  faviconUrl: string | null;
  /** Tab loading status */
  status: string;
  /** Whether tab is pinned */
  pinned: boolean;
  /** Tab position in window */
  index: number;
  /** Chrome tab group ID (-1 if none) */
  groupId: number;
  /** Persistent ID of opener tab (parent in opener chain) */
  openerPersistentId: string | null;
  /** Unix timestamp (ms) when tab was created */
  createdAt: number;
  /** Unix timestamp (ms) when tab was last activated */
  lastActivatedAt: number;
  /** Cumulative milliseconds spent as active tab */
  totalActiveTime: number;
  /** Foreign key to Session */
  sessionId: string;
  /** Persistent ID of the window this tab belongs to */
  windowPersistentId: string;
  /** Whether user has explicitly saved this tab */
  isSaved: boolean;
  /** Whether tab is pinned (denormalized from pinned field) */
  isPinned: boolean;
  /** Visit count (denormalized) */
  visitCount: number;
  /** User-defined tags */
  tags: string[];
  /** User notes */
  notes: string | null;
  /** Extensible metadata for future PKM integration */
  customMetadata: Record<string, unknown>;
  /** Unix timestamp (ms) when tab was closed (null if still open) */
  closedAt: number | null;
  /** Unix timestamp (ms) of last update */
  updatedAt: number;
}

/**
 * Tab visit/activation record - tracks each time a tab becomes active
 */
export interface TabVisit {
  /** Auto-increment primary key */
  id?: number;
  /** Foreign key to TrackedTab.persistentId */
  tabPersistentId: string;
  /** Foreign key to Session */
  sessionId: string;
  /** URL at time of visit */
  url: string;
  /** URL hash for indexing */
  urlHash: string;
  /** Page title at time of visit */
  title: string;
  /** Unix timestamp (ms) when tab became active */
  activatedAt: number;
  /** Unix timestamp (ms) when tab lost focus (null if still active) */
  deactivatedAt: number | null;
  /** Duration in ms (calculated: deactivatedAt - activatedAt) */
  duration: number;
  /** Window ID where activation occurred */
  windowPersistentId: string;
  /** Persistent ID of previously active tab */
  fromTabPersistentId: string | null;
}

/**
 * Tracked window entity
 */
export interface TrackedWindow {
  /** Auto-increment primary key */
  id?: number;
  /** UUID - persistent identifier */
  persistentId: string;
  /** Chrome's session-specific window ID */
  chromeWindowId: number;
  /** Window type */
  type: 'normal' | 'popup' | 'panel' | 'app' | 'devtools';
  /** Window state */
  state: string;
  /** Whether this is an incognito window */
  incognito: boolean;
  /** Window position */
  left: number;
  top: number;
  width: number;
  height: number;
  /** Unix timestamp (ms) when window was created */
  createdAt: number;
  /** Unix timestamp (ms) when window was last focused */
  lastFocusedAt: number;
  /** Cumulative milliseconds with focus */
  totalFocusTime: number;
  /** Foreign key to Session */
  sessionId: string;
  /** Whether user has explicitly saved this window */
  isSaved: boolean;
  /** Number of tabs (denormalized for quick access) */
  tabCount: number;
  /** Persistent ID of currently active tab */
  activeTabPersistentId: string | null;
  /** Unix timestamp (ms) when window was closed (null if still open) */
  closedAt: number | null;
  /** Unix timestamp (ms) of last update */
  updatedAt: number;
}

/**
 * Window focus event - tracks each time a window gains/loses focus
 */
export interface WindowFocusEvent {
  /** Auto-increment primary key */
  id?: number;
  /** Foreign key to TrackedWindow.persistentId */
  windowPersistentId: string;
  /** Foreign key to Session */
  sessionId: string;
  /** Unix timestamp (ms) when window gained focus */
  focusedAt: number;
  /** Unix timestamp (ms) when window lost focus (null if still focused) */
  unfocusedAt: number | null;
  /** Duration in ms */
  duration: number;
  /** Persistent ID of previously focused window */
  previousWindowPersistentId: string | null;
}

/**
 * Session entity - groups tabs and windows from a browser session
 */
export interface Session {
  /** UUID - primary key */
  id: string;
  /** User-defined or auto-generated name */
  name: string;
  /** Optional description */
  description: string;
  /** Unix timestamp (ms) when session started */
  startedAt: number;
  /** Unix timestamp (ms) when session ended (null if active) */
  endedAt: number | null;
  /** Whether this is the currently active session */
  isActive: boolean;
  /** Whether user has explicitly saved (never auto-purge) */
  isSaved: boolean;
  /** Number of windows (denormalized) */
  windowCount: number;
  /** Number of tabs (denormalized) */
  tabCount: number;
  /** Total active time across all tabs (denormalized) */
  totalActiveTime: number;
  /** Unix timestamp (ms) when session expires (null if saved) */
  expiresAt: number | null;
  /** User-defined tags */
  tags: string[];
  /** Extensible metadata */
  customMetadata: Record<string, unknown>;
  /** Unix timestamp (ms) of creation */
  createdAt: number;
  /** Unix timestamp (ms) of last update */
  updatedAt: number;
}

/**
 * Tab relationship types
 */
export type RelationshipType = 'opener' | 'sibling' | 'temporal';

/**
 * Tab relationship entity - tracks connections between tabs
 */
export interface TabRelationship {
  /** Auto-increment primary key */
  id?: number;
  /** Source tab persistent ID */
  sourceTabPersistentId: string;
  /** Target tab persistent ID */
  targetTabPersistentId: string;
  /** Type of relationship */
  relationshipType: RelationshipType;
  /** Unix timestamp (ms) when relationship was created */
  createdAt: number;
  /** Relationship strength (0-1) for ranking */
  strength: number;
  /** Additional metadata */
  metadata: Record<string, unknown>;
}

/**
 * User tag entity (normalized)
 */
export interface Tag {
  /** Auto-increment primary key */
  id?: number;
  /** Tag name (unique, lowercase, trimmed) */
  name: string;
  /** Display color (hex) */
  color: string;
  /** Unix timestamp (ms) of creation */
  createdAt: number;
  /** Usage count (denormalized for sorting) */
  usageCount: number;
}

/**
 * Working state stored in chrome.storage.session
 * Survives service worker restarts within a browser session
 */
export interface WorkingState {
  /** Current active session ID */
  currentSessionId: string;
  /** Currently active tab's persistent ID */
  activeTabPersistentId: string | null;
  /** Currently focused window's persistent ID */
  activeWindowPersistentId: string | null;
  /** Unix timestamp when current tab became active */
  tabActivationTimestamp: number;
  /** Unix timestamp when current window gained focus */
  windowFocusTimestamp: number;
  /** Chrome tab ID to persistent ID mapping cache */
  chromeTabIdMap: Record<number, string>;
  /** Chrome window ID to persistent ID mapping cache */
  chromeWindowIdMap: Record<number, string>;
}

/**
 * Which entities to include in an export
 */
export interface ExportEntitySelection {
  sessions: boolean;
  windows: boolean;
  tabs: boolean;
  visits: boolean;
  relationships: boolean;
  tags: boolean;
  xBookmarks: boolean;
  manifest: boolean;
}

/**
 * Export manifest for data export
 */
export interface ExportManifest {
  /** Schema version */
  version: string;
  /** Unix timestamp (ms) of export */
  exportedAt: number;
  /** Type of export */
  exportType: 'full' | 'session' | 'window' | 'filtered';
  /** Filters applied */
  filters: ExportFilters;
  /** Entities included */
  entities: string[];
  /** Statistics */
  stats: {
    sessionCount?: number;
    windowCount?: number;
    tabCount?: number;
    visitCount?: number;
    relationshipCount?: number;
    tagCount?: number;
    xBookmarkCount?: number;
  };
}

/**
 * Export filter options
 */
export interface ExportFilters {
  sessionIds?: string[];
  windowIds?: string[];
  dateRange?: { start: number; end: number };
  tags?: string[];
  includeIncognito: boolean;
  includeVisitHistory: boolean;
}

/**
 * Complete export data structure
 */
export interface ExportData {
  manifest?: ExportManifest;
  sessions?: Session[];
  windows?: TrackedWindow[];
  tabs?: TrackedTab[];
  visits?: TabVisit[];
  relationships?: TabRelationship[];
  tags?: Tag[];
  xBookmarks?: XBookmark[];
}

// ============================================
// X/Twitter Bookmark Types
// ============================================

/**
 * X/Twitter bookmark entity - synced from x.com/i/bookmarks
 */
export interface XBookmark {
  /** Auto-increment primary key */
  id?: number;
  /** Unique tweet ID extracted from /status/{id} */
  tweetId: string;
  /** Author @username */
  authorHandle: string;
  /** Author display name */
  authorName: string;
  /** Full tweet text content */
  text: string;
  /** ISO 8601 timestamp from the tweet */
  timestamp: string;
  /** Full tweet URL: https://x.com/{handle}/status/{id} */
  tweetUrl: string;
  /** Image URLs from the tweet */
  mediaUrls: string[];
  /** Whether tweet contains a video */
  hasVideo: boolean;
  /** Whether tweet is a quote tweet */
  isQuoteTweet: boolean;
  /** Unix timestamp (ms) when first synced */
  firstSeenAt: number;
  /** Unix timestamp (ms) of most recent sync encounter */
  lastSeenAt: number;
  /** Categories for future AI integration */
  categories: string[];
  /** User-defined tags */
  tags: string[];
  /** User notes */
  notes: string;
  /** Soft delete flag */
  archived: boolean;
  /** Unix timestamp (ms) when content was ingested to local folder (null if not ingested) */
  ingestedAt: number | null;
  /** Local folder path where ingested content lives */
  ingestionPath: string;
}

/**
 * X bookmark sync state - single-row config table (id=1)
 */
export interface XSyncState {
  /** Always 1 - single-row config */
  id?: number;
  /** Unix timestamp (ms) of last sync */
  lastSyncAt: number;
  /** Total bookmarks in database */
  totalBookmarks: number;
  /** New bookmarks found in last sync */
  lastSyncNewCount: number;
  /** Duration of last sync in ms */
  lastSyncDurationMs: number;
  /** Total number of syncs performed */
  syncCount: number;
}

/**
 * Aggregated metrics for X bookmark analytics
 */
export interface XBookmarkMetrics {
  summary: {
    totalBookmarks: number;
    totalArchived: number;
    uniqueAuthors: number;
    bookmarksPerWeek: number;
    mediaPercent: number;
    videoPercent: number;
    taggedPercent: number;
    quoteTweetPercent: number;
  };
  acquisitionTimeline: Array<{ weekLabel: string; count: number }>;
  topAuthors: Array<{ handle: string; name: string; count: number }>;
  contentComposition: { textOnly: number; withImages: number; withVideo: number };
  tweetAgeDistribution: Array<{ monthLabel: string; count: number }>;
}

/**
 * Raw tweet data extracted from DOM by the content script
 */
export interface RawTweetData {
  tweetId: string;
  authorHandle: string;
  authorName: string;
  text: string;
  timestamp: string;
  tweetUrl: string;
  mediaUrls: string[];
  hasVideo: boolean;
  isQuoteTweet: boolean;
}

/**
 * CSV row format for tab export
 */
export interface TabCSVRow {
  persistentId: string;
  url: string;
  title: string;
  createdAt: string;
  lastActivatedAt: string;
  totalActiveTimeMinutes: number;
  windowPersistentId: string;
  sessionId: string;
  tags: string;
  notes: string | null;
  isIncognito: string;
  isSaved: string;
}
