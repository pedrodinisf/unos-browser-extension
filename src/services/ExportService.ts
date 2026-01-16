import { getDatabase } from '../db/schema';
import type {
  TrackedTab,
  TrackedWindow,
  TabVisit,
  Session,
  TabRelationship,
  Tag,
  ExportData,
  ExportManifest,
  ExportFilters,
  TabCSVRow,
} from '../db/types';
import { getStorageManager, type StorageManager } from './StorageManager';

/**
 * Export options
 */
export interface ExportOptions {
  format: 'json' | 'csv';
  scope: 'current-window' | 'all-windows' | 'session' | 'custom';
  filters?: Partial<ExportFilters>;
  includeVisitHistory?: boolean;
  includeRelationships?: boolean;
}

/**
 * ExportService - Handles data export and import
 */
export class ExportService {
  private storageManager: StorageManager;

  constructor(storageManager?: StorageManager) {
    this.storageManager = storageManager || getStorageManager();
  }

  /**
   * Export data based on options
   */
  async export(options: ExportOptions): Promise<string> {
    const data = await this.gatherExportData(options);

    if (options.format === 'csv') {
      return this.toCSV(data);
    }

    return this.toJSON(data);
  }

  /**
   * Gather data for export based on options
   */
  private async gatherExportData(options: ExportOptions): Promise<ExportData> {
    const db = getDatabase();
    const sessionId = this.storageManager.getCurrentSessionId();

    let tabs: TrackedTab[] = [];
    let windows: TrackedWindow[] = [];
    let sessions: Session[] = [];
    let visits: TabVisit[] = [];
    let relationships: TabRelationship[] = [];
    let tags: Tag[] = [];

    const includeIncognito = options.filters?.includeIncognito ?? true;

    switch (options.scope) {
      case 'current-window': {
        const activeWindowId = this.storageManager.getActiveWindowPersistentId();
        if (activeWindowId) {
          const window = await db.windows
            .where('persistentId')
            .equals(activeWindowId)
            .first();
          if (window && (includeIncognito || !window.incognito)) {
            windows = [window];
            tabs = await db.tabs
              .where('chromeWindowId')
              .equals(window.chromeWindowId)
              .toArray();
          }
        }
        break;
      }

      case 'all-windows': {
        if (sessionId) {
          windows = await db.windows
            .where('sessionId')
            .equals(sessionId)
            .filter((w) => includeIncognito || !w.incognito)
            .toArray();
          tabs = await db.tabs
            .where('sessionId')
            .equals(sessionId)
            .toArray();

          // Filter tabs to only include those from included windows
          if (!includeIncognito) {
            const windowIds = new Set(windows.map((w) => w.chromeWindowId));
            tabs = tabs.filter((t) => windowIds.has(t.chromeWindowId));
          }
        }
        break;
      }

      case 'session': {
        const targetSessionIds = options.filters?.sessionIds || (sessionId ? [sessionId] : []);
        for (const sid of targetSessionIds) {
          const session = await db.sessions.get(sid);
          if (session) sessions.push(session);

          const sessionWindows = await db.windows
            .where('sessionId')
            .equals(sid)
            .filter((w) => includeIncognito || !w.incognito)
            .toArray();
          windows.push(...sessionWindows);

          const sessionTabs = await db.tabs
            .where('sessionId')
            .equals(sid)
            .toArray();

          if (!includeIncognito) {
            const windowIds = new Set(sessionWindows.map((w) => w.chromeWindowId));
            tabs.push(...sessionTabs.filter((t) => windowIds.has(t.chromeWindowId)));
          } else {
            tabs.push(...sessionTabs);
          }
        }
        break;
      }

      case 'custom': {
        const filters = options.filters || {};

        // Start with all sessions if none specified
        const targetSessionIds = filters.sessionIds || [];
        if (targetSessionIds.length === 0 && sessionId) {
          targetSessionIds.push(sessionId);
        }

        for (const sid of targetSessionIds) {
          const session = await db.sessions.get(sid);
          if (session) sessions.push(session);
        }

        // Get windows
        if (filters.windowIds && filters.windowIds.length > 0) {
          for (const wid of filters.windowIds) {
            const window = await db.windows.where('persistentId').equals(wid).first();
            if (window && (includeIncognito || !window.incognito)) {
              windows.push(window);
            }
          }
        } else {
          for (const sid of targetSessionIds) {
            const sessionWindows = await db.windows
              .where('sessionId')
              .equals(sid)
              .filter((w) => includeIncognito || !w.incognito)
              .toArray();
            windows.push(...sessionWindows);
          }
        }

        // Get tabs
        const windowIds = new Set(windows.map((w) => w.chromeWindowId));
        for (const sid of targetSessionIds) {
          let sessionTabs = await db.tabs
            .where('sessionId')
            .equals(sid)
            .toArray();

          // Filter by window
          sessionTabs = sessionTabs.filter((t) => windowIds.has(t.chromeWindowId));

          // Filter by date range
          if (filters.dateRange) {
            sessionTabs = sessionTabs.filter(
              (t) =>
                t.createdAt >= filters.dateRange!.start &&
                t.createdAt <= filters.dateRange!.end
            );
          }

          // Filter by tags
          if (filters.tags && filters.tags.length > 0) {
            const tagSet = new Set(filters.tags);
            sessionTabs = sessionTabs.filter((t) =>
              t.tags.some((tag) => tagSet.has(tag))
            );
          }

          tabs.push(...sessionTabs);
        }
        break;
      }
    }

    // Get visit history if requested
    if (options.includeVisitHistory) {
      const tabIds = new Set(tabs.map((t) => t.persistentId));
      visits = await db.tabVisits
        .filter((v) => tabIds.has(v.tabPersistentId))
        .toArray();
    }

    // Get relationships if requested
    if (options.includeRelationships) {
      const tabIds = new Set(tabs.map((t) => t.persistentId));
      relationships = await db.tabRelationships
        .filter(
          (r) => tabIds.has(r.sourceTabPersistentId) || tabIds.has(r.targetTabPersistentId)
        )
        .toArray();
    }

    // Get all tags
    tags = await db.tags.toArray();

    // Build manifest
    const manifest: ExportManifest = {
      version: '1.0.0',
      exportedAt: Date.now(),
      exportType: options.scope === 'custom' ? 'filtered' : options.scope === 'session' ? 'session' :
                  options.scope === 'current-window' ? 'window' : 'full',
      filters: {
        sessionIds: sessions.map((s) => s.id),
        windowIds: windows.map((w) => w.persistentId),
        includeIncognito,
        includeVisitHistory: options.includeVisitHistory ?? false,
        ...options.filters,
      },
      stats: {
        sessionCount: sessions.length,
        windowCount: windows.length,
        tabCount: tabs.length,
        visitCount: visits.length,
      },
    };

    return {
      manifest,
      sessions,
      windows,
      tabs,
      visits: options.includeVisitHistory ? visits : undefined,
      relationships: options.includeRelationships ? relationships : undefined,
      tags: tags.length > 0 ? tags : undefined,
    };
  }

  /**
   * Convert export data to JSON string
   */
  private toJSON(data: ExportData): string {
    return JSON.stringify(data, null, 2);
  }

  /**
   * Convert export data to CSV string (tabs only)
   */
  private toCSV(data: ExportData): string {
    // Handle empty data case
    if (data.tabs.length === 0) {
      const defaultHeaders: (keyof TabCSVRow)[] = [
        'persistentId',
        'url',
        'title',
        'createdAt',
        'lastActivatedAt',
        'totalActiveTimeMinutes',
        'windowPersistentId',
        'sessionId',
        'tags',
        'notes',
        'isIncognito',
        'isSaved',
      ];
      return defaultHeaders.join(',');
    }

    const rows: TabCSVRow[] = data.tabs.map((tab) => {
      // Find the window for incognito status
      const window = data.windows.find((w) => w.chromeWindowId === tab.chromeWindowId);

      return {
        persistentId: tab.persistentId,
        url: tab.url,
        title: tab.title,
        createdAt: new Date(tab.createdAt).toISOString(),
        lastActivatedAt: new Date(tab.lastActivatedAt).toISOString(),
        totalActiveTimeMinutes: Math.round(tab.totalActiveTime / 60000),
        windowPersistentId: window?.persistentId || '',
        sessionId: tab.sessionId,
        tags: tab.tags.join(', '),
        notes: tab.notes,
        isIncognito: window?.incognito ? 'true' : 'false',
        isSaved: tab.isSaved ? 'true' : 'false',
      };
    });

    // Build CSV
    const headers = Object.keys(rows[0]!) as (keyof TabCSVRow)[];
    const headerLine = headers.join(',');

    const dataLines = rows.map((row) => {
      return headers
        .map((h) => {
          const value = String(row[h] ?? '');
          // Escape quotes and wrap in quotes if contains comma, quote, or newline
          if (value.includes(',') || value.includes('"') || value.includes('\n')) {
            return `"${value.replace(/"/g, '""')}"`;
          }
          return value;
        })
        .join(',');
    });

    return [headerLine, ...dataLines].join('\n');
  }

  /**
   * Import data from JSON
   */
  async importJSON(jsonString: string, options: { merge?: boolean } = {}): Promise<{
    sessions: number;
    windows: number;
    tabs: number;
  }> {
    const data: ExportData = JSON.parse(jsonString);
    const db = getDatabase();

    // Validate version
    if (!data.manifest?.version) {
      throw new Error('Invalid export format: missing version');
    }

    let importedSessions = 0;
    let importedWindows = 0;
    let importedTabs = 0;

    // Import sessions
    for (const session of data.sessions) {
      if (!options.merge) {
        // Check if session already exists
        const existing = await db.sessions.get(session.id);
        if (existing) continue;
      }

      await db.sessions.put({
        ...session,
        isActive: false, // Imported sessions are never active
        updatedAt: Date.now(),
      });
      importedSessions++;
    }

    // Import windows
    for (const window of data.windows) {
      if (!options.merge) {
        const existing = await db.windows.where('persistentId').equals(window.persistentId).first();
        if (existing) continue;
      }

      await db.windows.put({
        ...window,
        chromeWindowId: -1, // Imported windows don't have a Chrome ID
        closedAt: window.closedAt || Date.now(),
        updatedAt: Date.now(),
      });
      importedWindows++;
    }

    // Import tabs
    for (const tab of data.tabs) {
      if (!options.merge) {
        const existing = await db.tabs.where('persistentId').equals(tab.persistentId).first();
        if (existing) continue;
      }

      await db.tabs.put({
        ...tab,
        chromeTabId: -1, // Imported tabs don't have a Chrome ID
        closedAt: tab.closedAt || Date.now(),
        updatedAt: Date.now(),
      });
      importedTabs++;
    }

    // Import visits if present
    if (data.visits) {
      for (const visit of data.visits) {
        await db.tabVisits.put(visit);
      }
    }

    // Import relationships if present
    if (data.relationships) {
      for (const rel of data.relationships) {
        const existing = await db.tabRelationships
          .where('[sourceTabPersistentId+relationshipType]')
          .equals([rel.sourceTabPersistentId, rel.relationshipType])
          .filter((r) => r.targetTabPersistentId === rel.targetTabPersistentId)
          .first();

        if (!existing) {
          await db.tabRelationships.add(rel);
        }
      }
    }

    // Import tags if present
    if (data.tags) {
      for (const tag of data.tags) {
        const existing = await db.tags.where('name').equals(tag.name).first();
        if (!existing) {
          await db.tags.add(tag);
        }
      }
    }

    console.log(`[ExportService] Imported ${importedSessions} sessions, ${importedWindows} windows, ${importedTabs} tabs`);

    return {
      sessions: importedSessions,
      windows: importedWindows,
      tabs: importedTabs,
    };
  }

  /**
   * Download data as a file
   */
  downloadFile(content: string, filename: string, mimeType: string): void {
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);

    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();

    URL.revokeObjectURL(url);
  }

  /**
   * Export and download as JSON
   */
  async exportAndDownloadJSON(options: Omit<ExportOptions, 'format'>): Promise<void> {
    const data = await this.export({ ...options, format: 'json' });
    const filename = `unos-export-${new Date().toISOString().split('T')[0]}.json`;
    this.downloadFile(data, filename, 'application/json');
  }

  /**
   * Export and download as CSV
   */
  async exportAndDownloadCSV(options: Omit<ExportOptions, 'format'>): Promise<void> {
    const data = await this.export({ ...options, format: 'csv' });
    const filename = `unos-tabs-${new Date().toISOString().split('T')[0]}.csv`;
    this.downloadFile(data, filename, 'text/csv');
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
