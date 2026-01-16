import Dexie, { type Table } from 'dexie';
import type {
  TrackedTab,
  TabVisit,
  TrackedWindow,
  WindowFocusEvent,
  Session,
  TabRelationship,
  Tag,
} from './types';

/**
 * UNOS Tab Tracker Database
 *
 * Uses Dexie.js for IndexedDB access with:
 * - Type-safe tables
 * - Compound indexes for efficient queries
 * - Multi-entry indexes for tag filtering
 */
export class TabTrackerDatabase extends Dexie {
  tabs!: Table<TrackedTab, number>;
  tabVisits!: Table<TabVisit, number>;
  windows!: Table<TrackedWindow, number>;
  windowFocusEvents!: Table<WindowFocusEvent, number>;
  sessions!: Table<Session, string>;
  tabRelationships!: Table<TabRelationship, number>;
  tags!: Table<Tag, number>;

  constructor() {
    super('TabTrackerDB');

    // Schema version 1
    this.version(1).stores({
      // TrackedTab indexes:
      // - ++id: auto-increment primary key
      // - persistentId: unique lookup
      // - chromeTabId: map Chrome events to our records
      // - chromeWindowId: get all tabs in window
      // - urlHash: URL-based matching on restart
      // - sessionId: get all tabs in session
      // - [sessionId+chromeWindowId]: compound for window queries
      // - [urlHash+sessionId]: compound for URL matching in session
      // - *tags: multi-entry for tag filtering
      tabs: `
        ++id,
        &persistentId,
        chromeTabId,
        chromeWindowId,
        urlHash,
        sessionId,
        createdAt,
        lastActivatedAt,
        isSaved,
        closedAt,
        [sessionId+chromeWindowId],
        [urlHash+sessionId],
        *tags
      `.replace(/\s+/g, ''),

      // TabVisit indexes:
      // - ++id: auto-increment
      // - tabPersistentId: get visits for a tab
      // - sessionId: get all visits in session
      // - activatedAt: time-based queries
      // - [tabPersistentId+activatedAt]: compound for time-series per tab
      // - [sessionId+activatedAt]: compound for session timeline
      tabVisits: `
        ++id,
        tabPersistentId,
        sessionId,
        urlHash,
        activatedAt,
        [tabPersistentId+activatedAt],
        [sessionId+activatedAt]
      `.replace(/\s+/g, ''),

      // TrackedWindow indexes:
      // - ++id: auto-increment
      // - persistentId: unique lookup
      // - chromeWindowId: map Chrome events
      // - sessionId: get all windows in session
      // - [sessionId+incognito]: filter by session and incognito status
      windows: `
        ++id,
        &persistentId,
        chromeWindowId,
        sessionId,
        incognito,
        createdAt,
        closedAt,
        [sessionId+incognito]
      `.replace(/\s+/g, ''),

      // WindowFocusEvent indexes:
      windowFocusEvents: `
        ++id,
        windowPersistentId,
        sessionId,
        focusedAt
      `.replace(/\s+/g, ''),

      // Session indexes:
      // - id: UUID primary key
      // - isActive: find active session
      // - isSaved: find saved sessions
      // - expiresAt: cleanup expired sessions
      // - *tags: multi-entry for tag filtering
      sessions: `
        id,
        isActive,
        isSaved,
        startedAt,
        expiresAt,
        *tags
      `.replace(/\s+/g, ''),

      // TabRelationship indexes:
      // - ++id: auto-increment
      // - [sourceTabPersistentId+relationshipType]: find relationships from a tab
      // - [targetTabPersistentId+relationshipType]: find relationships to a tab
      tabRelationships: `
        ++id,
        sourceTabPersistentId,
        targetTabPersistentId,
        relationshipType,
        [sourceTabPersistentId+relationshipType],
        [targetTabPersistentId+relationshipType]
      `.replace(/\s+/g, ''),

      // Tag indexes:
      // - ++id: auto-increment
      // - &name: unique tag name
      // - usageCount: for sorting by popularity
      tags: `
        ++id,
        &name,
        usageCount
      `.replace(/\s+/g, ''),
    });
  }
}

// Singleton database instance
let db: TabTrackerDatabase | null = null;

/**
 * Get the database instance (lazy initialization)
 */
export function getDatabase(): TabTrackerDatabase {
  if (!db) {
    db = new TabTrackerDatabase();
  }
  return db;
}

/**
 * Close the database connection
 */
export async function closeDatabase(): Promise<void> {
  if (db) {
    db.close();
    db = null;
  }
}
