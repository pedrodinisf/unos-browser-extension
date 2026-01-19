import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ExportService, getExportService } from '../services/ExportService';
import { mockSendMessage } from './setup';
import type { TrackedTab, TrackedWindow, Session, TabVisit, TabRelationship, Tag } from '../db/types';

// Mock data factories
function createMockTab(overrides: Partial<TrackedTab> = {}): TrackedTab {
  return {
    persistentId: 'tab-1',
    chromeTabId: 1,
    chromeWindowId: 1,
    windowPersistentId: 'win-1',
    sessionId: 'session-1',
    url: 'https://example.com',
    urlHash: 'hash123',
    title: 'Example Page',
    faviconUrl: 'https://example.com/favicon.ico',
    status: 'complete',
    index: 0,
    pinned: false,
    isPinned: false,
    groupId: -1,
    openerPersistentId: null,
    createdAt: Date.now(),
    lastActivatedAt: Date.now(),
    totalActiveTime: 60000, // 1 minute
    visitCount: 1,
    isSaved: false,
    tags: [],
    notes: '',
    customMetadata: {},
    closedAt: null,
    updatedAt: Date.now(),
    ...overrides,
  };
}

function createMockWindow(overrides: Partial<TrackedWindow> = {}): TrackedWindow {
  return {
    persistentId: 'win-1',
    chromeWindowId: 1,
    sessionId: 'session-1',
    type: 'normal',
    state: 'normal',
    incognito: false,
    left: 0,
    top: 0,
    width: 1920,
    height: 1080,
    createdAt: Date.now(),
    lastFocusedAt: Date.now(),
    totalFocusTime: 300000, // 5 minutes
    isSaved: false,
    tabCount: 5,
    activeTabPersistentId: 'tab-1',
    closedAt: null,
    updatedAt: Date.now(),
    ...overrides,
  };
}

function createMockSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 'session-1',
    name: 'Test Session',
    description: 'A test session',
    startedAt: Date.now() - 3600000,
    endedAt: null,
    isActive: true,
    isSaved: false,
    windowCount: 2,
    tabCount: 10,
    totalActiveTime: 1800000, // 30 minutes
    expiresAt: Date.now() + 604800000, // 7 days
    tags: ['work', 'research'],
    customMetadata: {},
    createdAt: Date.now() - 3600000,
    updatedAt: Date.now(),
    ...overrides,
  };
}

function createMockVisit(overrides: Partial<TabVisit> = {}): TabVisit {
  return {
    id: 1,
    tabPersistentId: 'tab-1',
    sessionId: 'session-1',
    url: 'https://example.com',
    urlHash: 'hash123',
    title: 'Example Page',
    activatedAt: Date.now() - 60000,
    deactivatedAt: Date.now(),
    duration: 60000,
    windowPersistentId: 'win-1',
    fromTabPersistentId: null,
    ...overrides,
  };
}

function createMockRelationship(overrides: Partial<TabRelationship> = {}): TabRelationship {
  return {
    id: 1,
    sourceTabPersistentId: 'tab-1',
    targetTabPersistentId: 'tab-2',
    relationshipType: 'opener',
    createdAt: Date.now(),
    strength: 1.0,
    metadata: {},
    ...overrides,
  };
}

function createMockTag(overrides: Partial<Tag> = {}): Tag {
  return {
    id: 1,
    name: 'work',
    color: '#6366f1',
    createdAt: Date.now(),
    usageCount: 5,
    ...overrides,
  };
}

describe('ExportService', () => {
  let exportService: ExportService;

  beforeEach(() => {
    exportService = new ExportService();
  });

  describe('getExportService', () => {
    it('should return singleton instance', () => {
      const service1 = getExportService();
      const service2 = getExportService();
      expect(service1).toBe(service2);
    });
  });

  describe('escapeCSV', () => {
    it('should return empty string for null/undefined', () => {
      // Access private method via any cast for testing
      const escape = (exportService as unknown as { escapeCSV: (v: string) => string }).escapeCSV.bind(exportService);
      expect(escape('')).toBe('');
      expect(escape(null as unknown as string)).toBe('');
      expect(escape(undefined as unknown as string)).toBe('');
    });

    it('should escape strings with commas', () => {
      const escape = (exportService as unknown as { escapeCSV: (v: string) => string }).escapeCSV.bind(exportService);
      expect(escape('hello, world')).toBe('"hello, world"');
    });

    it('should escape strings with quotes', () => {
      const escape = (exportService as unknown as { escapeCSV: (v: string) => string }).escapeCSV.bind(exportService);
      expect(escape('say "hello"')).toBe('"say ""hello"""');
    });

    it('should escape strings with newlines', () => {
      const escape = (exportService as unknown as { escapeCSV: (v: string) => string }).escapeCSV.bind(exportService);
      expect(escape('line1\nline2')).toBe('"line1\nline2"');
    });

    it('should escape strings with semicolons', () => {
      const escape = (exportService as unknown as { escapeCSV: (v: string) => string }).escapeCSV.bind(exportService);
      expect(escape('a;b;c')).toBe('"a;b;c"');
    });

    it('should not escape plain strings', () => {
      const escape = (exportService as unknown as { escapeCSV: (v: string) => string }).escapeCSV.bind(exportService);
      expect(escape('hello world')).toBe('hello world');
    });
  });

  describe('addBOM', () => {
    it('should add UTF-8 BOM to string', () => {
      const addBOM = (exportService as unknown as { addBOM: (v: string) => string }).addBOM.bind(exportService);
      const result = addBOM('test');
      expect(result).toBe('\uFEFFtest');
      expect(result.charCodeAt(0)).toBe(0xFEFF);
    });
  });

  describe('tabsToCSV', () => {
    it('should generate CSV with headers', () => {
      const tabs = [createMockTab()];
      const windows = [createMockWindow()];
      const toCSV = (exportService as unknown as { tabsToCSV: (t: TrackedTab[], w: TrackedWindow[]) => string }).tabsToCSV.bind(exportService);
      const csv = toCSV(tabs, windows);

      expect(csv).toContain('persistentId');
      expect(csv).toContain('chromeTabId');
      expect(csv).toContain('url');
      expect(csv).toContain('title');
    });

    it('should include tab data', () => {
      const tabs = [createMockTab({ title: 'Test Tab', url: 'https://test.com' })];
      const windows = [createMockWindow()];
      const toCSV = (exportService as unknown as { tabsToCSV: (t: TrackedTab[], w: TrackedWindow[]) => string }).tabsToCSV.bind(exportService);
      const csv = toCSV(tabs, windows);

      expect(csv).toContain('Test Tab');
      expect(csv).toContain('https://test.com');
    });

    it('should handle tabs with special characters', () => {
      const tabs = [createMockTab({ title: 'Title, with "quotes"' })];
      const windows = [createMockWindow()];
      const toCSV = (exportService as unknown as { tabsToCSV: (t: TrackedTab[], w: TrackedWindow[]) => string }).tabsToCSV.bind(exportService);
      const csv = toCSV(tabs, windows);

      expect(csv).toContain('"Title, with ""quotes"""');
    });

    it('should calculate active time in minutes', () => {
      const tabs = [createMockTab({ totalActiveTime: 120000 })]; // 2 minutes
      const windows = [createMockWindow()];
      const toCSV = (exportService as unknown as { tabsToCSV: (t: TrackedTab[], w: TrackedWindow[]) => string }).tabsToCSV.bind(exportService);
      const csv = toCSV(tabs, windows);
      const lines = csv.split('\n');

      // Check that the active time column has value 2
      expect(lines[1]).toContain(',2,');
    });
  });

  describe('sessionsToCSV', () => {
    it('should generate session CSV', () => {
      const sessions = [createMockSession()];
      const toCSV = (exportService as unknown as { sessionsToCSV: (s: Session[]) => string }).sessionsToCSV.bind(exportService);
      const csv = toCSV(sessions);

      expect(csv).toContain('id');
      expect(csv).toContain('name');
      expect(csv).toContain('Test Session');
    });

    it('should handle session tags', () => {
      const sessions = [createMockSession({ tags: ['tag1', 'tag2'] })];
      const toCSV = (exportService as unknown as { sessionsToCSV: (s: Session[]) => string }).sessionsToCSV.bind(exportService);
      const csv = toCSV(sessions);

      expect(csv).toContain('tag1; tag2');
    });
  });

  describe('windowsToCSV', () => {
    it('should generate window CSV', () => {
      const windows = [createMockWindow()];
      const toCSV = (exportService as unknown as { windowsToCSV: (w: TrackedWindow[]) => string }).windowsToCSV.bind(exportService);
      const csv = toCSV(windows);

      expect(csv).toContain('persistentId');
      expect(csv).toContain('chromeWindowId');
      expect(csv).toContain('type');
    });

    it('should handle incognito windows', () => {
      const windows = [createMockWindow({ incognito: true })];
      const toCSV = (exportService as unknown as { windowsToCSV: (w: TrackedWindow[]) => string }).windowsToCSV.bind(exportService);
      const csv = toCSV(windows);

      expect(csv).toContain('true');
    });
  });

  describe('visitsToCSV', () => {
    it('should generate visit CSV', () => {
      const visits = [createMockVisit()];
      const toCSV = (exportService as unknown as { visitsToCSV: (v: TabVisit[]) => string }).visitsToCSV.bind(exportService);
      const csv = toCSV(visits);

      expect(csv).toContain('tabPersistentId');
      expect(csv).toContain('activatedAt');
      expect(csv).toContain('durationMinutes');
    });
  });

  describe('relationshipsToCSV', () => {
    it('should generate relationship CSV', () => {
      const relationships = [createMockRelationship()];
      const toCSV = (exportService as unknown as { relationshipsToCSV: (r: TabRelationship[]) => string }).relationshipsToCSV.bind(exportService);
      const csv = toCSV(relationships);

      expect(csv).toContain('sourceTabPersistentId');
      expect(csv).toContain('targetTabPersistentId');
      expect(csv).toContain('relationshipType');
      expect(csv).toContain('opener');
    });
  });

  describe('tagsToCSV', () => {
    it('should generate tag CSV', () => {
      const tags = [createMockTag()];
      const toCSV = (exportService as unknown as { tagsToCSV: (t: Tag[]) => string }).tagsToCSV.bind(exportService);
      const csv = toCSV(tags);

      expect(csv).toContain('name');
      expect(csv).toContain('color');
      expect(csv).toContain('work');
      expect(csv).toContain('#6366f1');
    });
  });

  describe('export', () => {
    beforeEach(() => {
      // Mock the sendMessage to return test data
      mockSendMessage.mockImplementation((message, callback) => {
        if (message.type === 'GET_ALL_DATA') {
          callback({
            success: true,
            data: {
              sessions: [createMockSession()],
              windows: [createMockWindow()],
              tabs: [createMockTab()],
              visits: [createMockVisit()],
              relationships: [createMockRelationship()],
              tags: [createMockTag()],
            },
          });
        }
      });
    });

    it('should export as JSON', async () => {
      const result = await exportService.export({ format: 'json', scope: 'session' });
      expect(typeof result).toBe('string');

      const parsed = JSON.parse(result as string);
      expect(parsed.manifest).toBeDefined();
      expect(parsed.sessions).toBeDefined();
      expect(parsed.tabs).toBeDefined();
    });

    it('should export as CSV', async () => {
      const result = await exportService.export({ format: 'csv', scope: 'session' });
      expect(typeof result).toBe('string');
      expect(result).toContain('persistentId');
    });

    it('should export as ZIP', async () => {
      const result = await exportService.export({ format: 'zip', scope: 'session' });
      expect(result).toBeInstanceOf(Blob);
    });
  });

  describe('downloadFile', () => {
    it('should create download link', () => {
      const mockCreateObjectURL = vi.fn().mockReturnValue('blob:url');
      const mockRevokeObjectURL = vi.fn();
      const mockClick = vi.fn();

      globalThis.URL.createObjectURL = mockCreateObjectURL;
      globalThis.URL.revokeObjectURL = mockRevokeObjectURL;

      const mockAnchor = {
        href: '',
        download: '',
        click: mockClick,
      };
      vi.spyOn(document, 'createElement').mockReturnValue(mockAnchor as unknown as HTMLAnchorElement);

      exportService.downloadFile('test content', 'test.txt', 'text/plain');

      expect(mockCreateObjectURL).toHaveBeenCalled();
      expect(mockAnchor.download).toBe('test.txt');
      expect(mockClick).toHaveBeenCalled();
      expect(mockRevokeObjectURL).toHaveBeenCalled();
    });
  });
});
