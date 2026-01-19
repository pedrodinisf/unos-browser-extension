import JSZip from 'jszip';
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
} from '../db/types';

/**
 * Export options
 */
export interface ExportOptions {
  format: 'json' | 'csv' | 'zip';
  scope: 'current-window' | 'all-windows' | 'session' | 'custom';
  filters?: Partial<ExportFilters>;
  includeVisitHistory?: boolean;
  includeRelationships?: boolean;
}

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
 * ExportService - Handles data export (runs in popup context)
 */
export class ExportService {
  /**
   * Export data based on options
   */
  async export(options: ExportOptions): Promise<string | Blob> {
    // Get all data from background script
    const data = await sendMessage<AllData>({ type: 'GET_ALL_DATA' });

    if (options.format === 'zip') {
      return this.toZip(data);
    }

    if (options.format === 'csv') {
      return this.tabsToCSV(data.tabs, data.windows);
    }

    return this.toJSON(data, options);
  }

  /**
   * Convert to JSON string
   */
  private toJSON(data: AllData, options: ExportOptions): string {
    const manifest: ExportManifest = {
      version: '1.0.0',
      exportedAt: Date.now(),
      exportType: options.scope === 'session' ? 'session' : 'full',
      filters: {
        includeIncognito: options.filters?.includeIncognito ?? true,
        includeVisitHistory: options.includeVisitHistory ?? true,
      },
      stats: {
        sessionCount: data.sessions.length,
        windowCount: data.windows.length,
        tabCount: data.tabs.length,
        visitCount: data.visits.length,
      },
    };

    const exportData: ExportData = {
      manifest,
      sessions: data.sessions,
      windows: data.windows,
      tabs: data.tabs,
      visits: options.includeVisitHistory ? data.visits : undefined,
      relationships: options.includeRelationships ? data.relationships : undefined,
      tags: data.tags.length > 0 ? data.tags : undefined,
    };

    return JSON.stringify(exportData, null, 2);
  }

  /**
   * Convert tabs to CSV string
   */
  private tabsToCSV(tabs: TrackedTab[], windows: TrackedWindow[]): string {
    const headers = [
      'persistentId',
      'chromeTabId',
      'url',
      'title',
      'createdAt',
      'lastActivatedAt',
      'totalActiveTimeMinutes',
      'windowPersistentId',
      'chromeWindowId',
      'sessionId',
      'index',
      'pinned',
      'groupId',
      'tags',
      'notes',
      'isIncognito',
      'isSaved',
      'closedAt',
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
   * Create ZIP with all tables as CSV files
   */
  private async toZip(data: AllData): Promise<Blob> {
    const zip = new JSZip();
    const timestamp = new Date().toISOString().split('T')[0];

    // Sessions CSV (with BOM for Excel compatibility)
    zip.file(`sessions_${timestamp}.csv`, this.addBOM(this.sessionsToCSV(data.sessions)));

    // Windows CSV
    zip.file(`windows_${timestamp}.csv`, this.addBOM(this.windowsToCSV(data.windows)));

    // Tabs CSV
    zip.file(`tabs_${timestamp}.csv`, this.addBOM(this.tabsToCSV(data.tabs, data.windows)));

    // Visits CSV
    zip.file(`visits_${timestamp}.csv`, this.addBOM(this.visitsToCSV(data.visits)));

    // Relationships CSV
    zip.file(`relationships_${timestamp}.csv`, this.addBOM(this.relationshipsToCSV(data.relationships)));

    // Tags CSV
    zip.file(`tags_${timestamp}.csv`, this.addBOM(this.tagsToCSV(data.tags)));

    // Manifest JSON for reference
    zip.file('manifest.json', JSON.stringify({
      exportedAt: new Date().toISOString(),
      version: '1.0.0',
      stats: {
        sessions: data.sessions.length,
        windows: data.windows.length,
        tabs: data.tabs.length,
        visits: data.visits.length,
        relationships: data.relationships.length,
        tags: data.tags.length,
      }
    }, null, 2));

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
      'id',
      'name',
      'description',
      'startedAt',
      'endedAt',
      'isActive',
      'isSaved',
      'windowCount',
      'tabCount',
      'totalActiveTime',
      'expiresAt',
      'tags',
      'createdAt',
      'updatedAt',
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
      'persistentId',
      'chromeWindowId',
      'type',
      'state',
      'incognito',
      'left',
      'top',
      'width',
      'height',
      'createdAt',
      'lastFocusedAt',
      'totalFocusTimeMinutes',
      'sessionId',
      'isSaved',
      'tabCount',
      'activeTabPersistentId',
      'closedAt',
      'updatedAt',
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
   * Convert visits to CSV
   */
  private visitsToCSV(visits: TabVisit[]): string {
    const headers = [
      'id',
      'tabPersistentId',
      'sessionId',
      'url',
      'urlHash',
      'title',
      'activatedAt',
      'deactivatedAt',
      'durationMinutes',
      'windowPersistentId',
      'fromTabPersistentId',
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
      'id',
      'sourceTabPersistentId',
      'targetTabPersistentId',
      'relationshipType',
      'createdAt',
      'strength',
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
    const headers = [
      'id',
      'name',
      'color',
      'createdAt',
      'usageCount',
    ];

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
   * Escape CSV value
   */
  private escapeCSV(value: string): string {
    if (!value) return '';
    // Always quote strings that could be misinterpreted
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
   * Export and download as JSON
   */
  async exportAndDownloadJSON(options: Omit<ExportOptions, 'format'>): Promise<void> {
    const data = await this.export({ ...options, format: 'json' });
    const filename = `unos-export-${new Date().toISOString().split('T')[0]}.json`;
    this.downloadFile(data as string, filename, 'application/json');
  }

  /**
   * Export and download as CSV
   */
  async exportAndDownloadCSV(options: Omit<ExportOptions, 'format'>): Promise<void> {
    const data = await this.export({ ...options, format: 'csv' });
    const filename = `unos-tabs-${new Date().toISOString().split('T')[0]}.csv`;
    // Add BOM for Excel compatibility
    this.downloadFile(this.addBOM(data as string), filename, 'text/csv;charset=utf-8');
  }

  /**
   * Export and download as ZIP (all tables)
   */
  async exportAndDownloadZIP(): Promise<void> {
    const data = await this.export({ format: 'zip', scope: 'session' });
    const filename = `unos-export-${new Date().toISOString().split('T')[0]}.zip`;
    this.downloadFile(data as Blob, filename, 'application/zip');
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
