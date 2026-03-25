import JSZip from 'jszip';
import type {
  TrackedTab,
  TrackedWindow,
  TabVisit,
  Session,
  TabRelationship,
  Tag,
  XBookmark,
  ExportData,
  ExportManifest,
  ExportEntitySelection,
} from '../db/types';

/**
 * Export options
 */
export interface ExportOptions {
  format: 'json' | 'csv' | 'zip';
  entities: ExportEntitySelection;
  /** For CSV: which single entity to export */
  csvEntity?: keyof Omit<ExportEntitySelection, 'manifest'>;
}

/** Entity key names (excluding manifest which is metadata, not a table) */
export const ENTITY_KEYS = ['sessions', 'windows', 'tabs', 'visits', 'relationships', 'tags', 'xBookmarks'] as const;
export type EntityKey = typeof ENTITY_KEYS[number];

/**
 * All data fetched from background script
 */
interface AllData {
  sessions: Session[];
  windows: TrackedWindow[];
  tabs: TrackedTab[];
  visits: TabVisit[];
  relationships: TabRelationship[];
  tags: Tag[];
  xBookmarks: XBookmark[];
}

/**
 * Send message to background script
 */
async function sendMessage<T>(message: Record<string, unknown>): Promise<T> {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      if (!response?.success) {
        reject(new Error(response?.error || 'Unknown error'));
        return;
      }
      resolve(response.data as T);
    });
  });
}

/**
 * Return the list of entity keys that are selected
 */
function selectedEntities(entities: ExportEntitySelection): EntityKey[] {
  return ENTITY_KEYS.filter(k => entities[k]);
}

/**
 * ExportService - Handles data export (runs in popup context)
 */
export class ExportService {
  /**
   * Export data based on options
   */
  async export(options: ExportOptions): Promise<string | Blob> {
    const selected = selectedEntities(options.entities);

    // Fetch only the tables we need
    const data = await sendMessage<AllData>({
      type: 'GET_ALL_DATA',
      entities: selected,
    });

    if (options.format === 'zip') {
      return this.toZip(data, options.entities);
    }

    if (options.format === 'csv') {
      const entity = options.csvEntity || selected[0] || 'tabs';
      return this.entityToCSV(data, entity);
    }

    return this.toJSON(data, options.entities);
  }

  /**
   * Convert to JSON string — only includes selected entities
   */
  private toJSON(data: AllData, entities: ExportEntitySelection): string {
    const selected = selectedEntities(entities);

    const exportData: ExportData = {};

    if (entities.manifest) {
      exportData.manifest = this.buildManifest(data, entities);
    }
    if (entities.sessions) exportData.sessions = data.sessions;
    if (entities.windows) exportData.windows = data.windows;
    if (entities.tabs) exportData.tabs = data.tabs;
    if (entities.visits) exportData.visits = data.visits;
    if (entities.relationships) exportData.relationships = data.relationships;
    if (entities.tags) exportData.tags = data.tags;
    if (entities.xBookmarks) exportData.xBookmarks = data.xBookmarks;

    return JSON.stringify(exportData, null, 2);
  }

  /**
   * Build export manifest
   */
  private buildManifest(data: AllData, entities: ExportEntitySelection): ExportManifest {
    const selected = selectedEntities(entities);
    const stats: ExportManifest['stats'] = {};

    if (entities.sessions) stats.sessionCount = data.sessions.length;
    if (entities.windows) stats.windowCount = data.windows.length;
    if (entities.tabs) stats.tabCount = data.tabs.length;
    if (entities.visits) stats.visitCount = data.visits.length;
    if (entities.relationships) stats.relationshipCount = data.relationships.length;
    if (entities.tags) stats.tagCount = data.tags.length;
    if (entities.xBookmarks) stats.xBookmarkCount = data.xBookmarks.length;

    return {
      version: '1.0.0',
      exportedAt: Date.now(),
      exportType: 'full',
      filters: { includeIncognito: true, includeVisitHistory: entities.visits },
      entities: selected,
      stats,
    };
  }

  /**
   * Route a single entity to its CSV converter
   */
  private entityToCSV(data: AllData, entity: EntityKey): string {
    switch (entity) {
      case 'sessions': return this.sessionsToCSV(data.sessions);
      case 'windows': return this.windowsToCSV(data.windows);
      case 'tabs': return this.tabsToCSV(data.tabs, data.windows);
      case 'visits': return this.visitsToCSV(data.visits);
      case 'relationships': return this.relationshipsToCSV(data.relationships);
      case 'tags': return this.tagsToCSV(data.tags);
      case 'xBookmarks': return this.xBookmarksToCSV(data.xBookmarks);
    }
  }

  /**
   * Create ZIP with CSV files for each selected entity
   */
  private async toZip(data: AllData, entities: ExportEntitySelection): Promise<Blob> {
    const zip = new JSZip();
    const timestamp = new Date().toISOString().split('T')[0];

    if (entities.sessions) {
      zip.file(`sessions_${timestamp}.csv`, this.addBOM(this.sessionsToCSV(data.sessions)));
    }
    if (entities.windows) {
      zip.file(`windows_${timestamp}.csv`, this.addBOM(this.windowsToCSV(data.windows)));
    }
    if (entities.tabs) {
      zip.file(`tabs_${timestamp}.csv`, this.addBOM(this.tabsToCSV(data.tabs, data.windows)));
    }
    if (entities.visits) {
      zip.file(`visits_${timestamp}.csv`, this.addBOM(this.visitsToCSV(data.visits)));
    }
    if (entities.relationships) {
      zip.file(`relationships_${timestamp}.csv`, this.addBOM(this.relationshipsToCSV(data.relationships)));
    }
    if (entities.tags) {
      zip.file(`tags_${timestamp}.csv`, this.addBOM(this.tagsToCSV(data.tags)));
    }
    if (entities.xBookmarks) {
      zip.file(`xBookmarks_${timestamp}.csv`, this.addBOM(this.xBookmarksToCSV(data.xBookmarks)));
    }
    if (entities.manifest) {
      zip.file('manifest.json', JSON.stringify(this.buildManifest(data, entities), null, 2));
    }

    try {
      return await zip.generateAsync({ type: 'blob' });
    } catch (err) {
      console.error('[ExportService] Failed to generate ZIP:', err);
      throw new Error('Failed to generate ZIP file');
    }
  }

  /**
   * Convert sessions to CSV
   */
  private sessionsToCSV(sessions: Session[]): string {
    const headers = [
      'id', 'name', 'description', 'startedAt', 'endedAt', 'isActive', 'isSaved',
      'windowCount', 'tabCount', 'totalActiveTimeMinutes', 'expiresAt', 'tags', 'createdAt', 'updatedAt',
    ];

    const rows = sessions.map(s => [
      s.id,
      this.escapeCSV(s.name),
      this.escapeCSV(s.description),
      new Date(s.startedAt).toISOString(),
      s.endedAt ? new Date(s.endedAt).toISOString() : '',
      s.isActive,
      s.isSaved,
      s.windowCount,
      s.tabCount,
      Math.round(s.totalActiveTime / 60000),
      s.expiresAt ? new Date(s.expiresAt).toISOString() : '',
      this.escapeCSV(s.tags.join('; ')),
      new Date(s.createdAt).toISOString(),
      new Date(s.updatedAt).toISOString(),
    ].join(','));

    return [headers.join(','), ...rows].join('\n');
  }

  /**
   * Convert windows to CSV
   */
  private windowsToCSV(windows: TrackedWindow[]): string {
    const headers = [
      'persistentId', 'chromeWindowId', 'type', 'state', 'incognito',
      'left', 'top', 'width', 'height', 'createdAt', 'lastFocusedAt',
      'totalFocusTimeMinutes', 'sessionId', 'isSaved', 'tabCount',
      'activeTabPersistentId', 'closedAt', 'updatedAt',
    ];

    const rows = windows.map(w => [
      w.persistentId,
      w.chromeWindowId,
      w.type,
      w.state,
      w.incognito,
      w.left,
      w.top,
      w.width,
      w.height,
      new Date(w.createdAt).toISOString(),
      new Date(w.lastFocusedAt).toISOString(),
      Math.round(w.totalFocusTime / 60000),
      w.sessionId,
      w.isSaved,
      w.tabCount,
      w.activeTabPersistentId || '',
      w.closedAt ? new Date(w.closedAt).toISOString() : '',
      new Date(w.updatedAt).toISOString(),
    ].join(','));

    return [headers.join(','), ...rows].join('\n');
  }

  /**
   * Convert tabs to CSV
   */
  private tabsToCSV(tabs: TrackedTab[], windows: TrackedWindow[]): string {
    const headers = [
      'persistentId', 'chromeTabId', 'url', 'title', 'createdAt', 'lastActivatedAt',
      'totalActiveTimeMinutes', 'windowPersistentId', 'chromeWindowId', 'sessionId',
      'index', 'pinned', 'groupId', 'tags', 'notes', 'isIncognito', 'isSaved', 'closedAt',
    ];

    const windowMap = new Map(windows.map(w => [w.persistentId, w]));

    const rows = tabs.map(tab => {
      const window = windowMap.get(tab.windowPersistentId);
      return [
        tab.persistentId,
        tab.chromeTabId,
        this.escapeCSV(tab.url),
        this.escapeCSV(tab.title),
        new Date(tab.createdAt).toISOString(),
        new Date(tab.lastActivatedAt).toISOString(),
        Math.round(tab.totalActiveTime / 60000),
        tab.windowPersistentId,
        tab.chromeWindowId,
        tab.sessionId,
        tab.index,
        tab.pinned,
        tab.groupId,
        this.escapeCSV(tab.tags.join('; ')),
        this.escapeCSV(tab.notes || ''),
        window?.incognito ? 'true' : 'false',
        tab.isSaved ? 'true' : 'false',
        tab.closedAt ? new Date(tab.closedAt).toISOString() : '',
      ].join(',');
    });

    return [headers.join(','), ...rows].join('\n');
  }

  /**
   * Convert visits to CSV
   */
  private visitsToCSV(visits: TabVisit[]): string {
    const headers = [
      'id', 'tabPersistentId', 'sessionId', 'url', 'urlHash', 'title',
      'activatedAt', 'deactivatedAt', 'durationMinutes', 'windowPersistentId', 'fromTabPersistentId',
    ];

    const rows = visits.map(v => [
      v.id || '',
      v.tabPersistentId,
      v.sessionId,
      this.escapeCSV(v.url),
      v.urlHash,
      this.escapeCSV(v.title),
      new Date(v.activatedAt).toISOString(),
      v.deactivatedAt ? new Date(v.deactivatedAt).toISOString() : '',
      Math.round(v.duration / 60000),
      v.windowPersistentId,
      v.fromTabPersistentId || '',
    ].join(','));

    return [headers.join(','), ...rows].join('\n');
  }

  /**
   * Convert relationships to CSV
   */
  private relationshipsToCSV(relationships: TabRelationship[]): string {
    const headers = [
      'id', 'sourceTabPersistentId', 'targetTabPersistentId',
      'relationshipType', 'createdAt', 'strength',
    ];

    const rows = relationships.map(r => [
      r.id || '',
      r.sourceTabPersistentId,
      r.targetTabPersistentId,
      r.relationshipType,
      new Date(r.createdAt).toISOString(),
      r.strength,
    ].join(','));

    return [headers.join(','), ...rows].join('\n');
  }

  /**
   * Convert tags to CSV
   */
  private tagsToCSV(tags: Tag[]): string {
    const headers = ['id', 'name', 'color', 'createdAt', 'usageCount'];

    const rows = tags.map(t => [
      t.id || '',
      this.escapeCSV(t.name),
      t.color,
      new Date(t.createdAt).toISOString(),
      t.usageCount,
    ].join(','));

    return [headers.join(','), ...rows].join('\n');
  }

  /**
   * Convert X bookmarks to CSV
   */
  private xBookmarksToCSV(bookmarks: XBookmark[]): string {
    const headers = [
      'tweetId', 'authorHandle', 'authorName', 'text', 'timestamp',
      'tweetUrl', 'mediaUrls', 'hasVideo', 'isQuoteTweet',
      'firstSeenAt', 'lastSeenAt', 'categories', 'tags', 'notes',
    ];

    const rows = bookmarks.map(b => [
      b.tweetId,
      this.escapeCSV(b.authorHandle),
      this.escapeCSV(b.authorName),
      this.escapeCSV(b.text),
      b.timestamp,
      this.escapeCSV(b.tweetUrl),
      this.escapeCSV(b.mediaUrls.join('; ')),
      b.hasVideo,
      b.isQuoteTweet,
      new Date(b.firstSeenAt).toISOString(),
      new Date(b.lastSeenAt).toISOString(),
      this.escapeCSV(b.categories.join('; ')),
      this.escapeCSV(b.tags.join('; ')),
      this.escapeCSV(b.notes || ''),
    ].join(','));

    return [headers.join(','), ...rows].join('\n');
  }

  /**
   * Escape CSV value
   */
  private escapeCSV(value: string): string {
    if (!value) return '';
    if (value.includes(',') || value.includes('"') || value.includes('\n') || value.includes('\r') || value.includes(';')) {
      return `"${value.replace(/"/g, '""')}"`;
    }
    return value;
  }

  /**
   * Add UTF-8 BOM for Excel compatibility
   */
  private addBOM(csv: string): string {
    return '\uFEFF' + csv;
  }

  /**
   * Download data as a file
   */
  downloadFile(content: string | Blob, filename: string, mimeType?: string): void {
    const blob = content instanceof Blob ? content : new Blob([content], { type: mimeType || 'text/plain' });
    const url = URL.createObjectURL(blob);

    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();

    URL.revokeObjectURL(url);
  }

  /**
   * Export and download with the given options
   */
  async exportAndDownload(options: ExportOptions): Promise<void> {
    const date = new Date().toISOString().split('T')[0];
    const data = await this.export(options);

    if (options.format === 'zip') {
      this.downloadFile(data as Blob, `unos-export-${date}.zip`, 'application/zip');
    } else if (options.format === 'json') {
      this.downloadFile(data as string, `unos-export-${date}.json`, 'application/json');
    } else {
      const entity = options.csvEntity || 'tabs';
      const csv = this.addBOM(data as string);
      this.downloadFile(csv, `unos-${entity}-${date}.csv`, 'text/csv;charset=utf-8');
    }
  }
}

// Singleton instance
let exportService: ExportService | null = null;

/**
 * Get the ExportService singleton
 */
export function getExportService(): ExportService {
  if (!exportService) {
    exportService = new ExportService();
  }
  return exportService;
}
