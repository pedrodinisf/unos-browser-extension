import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MediaEngineService } from '../services/MediaEngineService';
import { getDatabase } from '../db/schema';
import type { XBookmark } from '../db/types';
import { mockCookies, mockSendNativeMessage, mockRuntime, localStorageData } from './setup';

vi.mock('../db/schema', () => ({
  getDatabase: vi.fn(),
}));

const PROJECT = '/Users/test/PROJECTS/media_engine';

function createBookmark(overrides: Partial<XBookmark> = {}): XBookmark {
  return {
    tweetId: '111',
    authorHandle: '@tester',
    authorName: 'Tester',
    text: 'video tweet',
    timestamp: '2026-01-01T00:00:00.000Z',
    tweetUrl: 'https://x.com/tester/status/111',
    mediaUrls: [],
    hasVideo: true,
    isQuoteTweet: false,
    firstSeenAt: Date.now(),
    lastSeenAt: Date.now(),
    categories: [],
    tags: [],
    notes: '',
    archived: false,
    ingestedAt: null,
    ingestionPath: '',
    engineArtifactId: '',
    enginePath: '',
    engineIngestedAt: null,
    ...overrides,
  };
}

function createFakeDb(bookmarks: XBookmark[]) {
  const modifications: Array<{ tweetId: string; changes: Partial<XBookmark> }> = [];
  const find = (tweetId: string) => bookmarks.find(b => b.tweetId === tweetId) ?? null;

  const db = {
    xBookmarks: {
      where: (_field: string) => ({
        equals: (tweetId: string) => ({
          first: () => Promise.resolve(find(tweetId)),
          modify: (changes: Partial<XBookmark>) => {
            modifications.push({ tweetId, changes });
            return Promise.resolve(1);
          },
        }),
      }),
      filter: (fn: (b: XBookmark) => boolean) => ({
        count: () => Promise.resolve(bookmarks.filter(fn).length),
      }),
    },
  };

  return { db, modifications };
}

function setFakeDb(bookmarks: XBookmark[]) {
  const fake = createFakeDb(bookmarks);
  vi.mocked(getDatabase).mockReturnValue(fake.db as unknown as ReturnType<typeof getDatabase>);
  return fake;
}

describe('MediaEngineService', () => {
  let service: MediaEngineService;

  beforeEach(() => {
    service = new MediaEngineService();
    mockCookies.getAll.mockImplementation(() => Promise.resolve([]));
  });

  afterEach(() => {
    mockRuntime.lastError = null;
  });

  describe('getSettings', () => {
    it('should return defaults when nothing is configured', async () => {
      const settings = await service.getSettings();
      expect(settings.projectPath).toBe('');
      expect(settings.baseUrl).toBe('http://127.0.0.1:8000');
      expect(settings.defaultBaseUrl).toBe('http://127.0.0.1:8000');
    });

    it('should read persisted settings and strip trailing slashes from the base URL', async () => {
      localStorageData.engine_projectPath = PROJECT;
      localStorageData.engine_baseUrl = 'http://127.0.0.1:9000/';

      const settings = await service.getSettings();
      expect(settings.projectPath).toBe(PROJECT);
      expect(settings.baseUrl).toBe('http://127.0.0.1:9000');
    });
  });

  describe('setSettings', () => {
    it('should validate via the native host and persist the resolved values', async () => {
      mockSendNativeMessage.mockImplementation((_app, _msg, callback) => {
        callback({ success: true, engineProject: PROJECT, uvPath: '/usr/local/bin/uv', venvReady: true });
      });

      const result = await service.setSettings({
        projectPath: PROJECT,
        baseUrl: 'http://localhost:8123/',
      });

      expect(result.success).toBe(true);
      expect(result.projectPath).toBe(PROJECT);
      expect(result.baseUrl).toBe('http://localhost:8123');
      expect(mockSendNativeMessage).toHaveBeenCalledWith(
        'com.unos.video_downloader',
        expect.objectContaining({ action: 'validate_engine', engineProject: PROJECT }),
        expect.any(Function),
      );
      expect(localStorageData.engine_projectPath).toBe(PROJECT);
      expect(localStorageData.engine_baseUrl).toBe('http://localhost:8123');
    });

    it('should surface native host validation errors', async () => {
      mockSendNativeMessage.mockImplementation((_app, _msg, callback) => {
        callback({ success: false, error: 'media_engine venv not ready' });
      });

      const result = await service.setSettings({ projectPath: PROJECT });
      expect(result.success).toBe(false);
      expect(result.error).toBe('media_engine venv not ready');
      expect(localStorageData.engine_projectPath).toBeUndefined();
    });

    it('should reject an empty project path without calling the host', async () => {
      const result = await service.setSettings({ projectPath: '   ' });
      expect(result.success).toBe(false);
      expect(mockSendNativeMessage).not.toHaveBeenCalled();
    });
  });

  describe('downloadToEngine', () => {
    it('should error without calling the native host when unconfigured', async () => {
      const response = await service.downloadToEngine('https://x.com/tester/status/111', '111');

      expect(response.success).toBe(false);
      expect(response.error).toContain('not configured');
      expect(mockSendNativeMessage).not.toHaveBeenCalled();
      expect(localStorageData.engine_status).toBe('error');
    });

    it('should send the engine_download message with sanitized URL and cookies', async () => {
      localStorageData.engine_projectPath = PROJECT;
      mockCookies.getAll.mockImplementation((query?: unknown) => {
        const domain = (query as { domain?: string } | undefined)?.domain;
        if (domain === '.twitter.com') {
          return Promise.resolve([
            {
              name: 'auth_token', value: 'twitter-value', domain: '.twitter.com', path: '/',
              secure: true, httpOnly: true, hostOnly: false, session: false, sameSite: 'unspecified', storeId: '0',
            },
          ]);
        }
        return Promise.resolve([
          {
            name: 'auth_token', value: 'x-value', domain: '.x.com', path: '/',
            secure: true, httpOnly: true, hostOnly: false, session: false, sameSite: 'unspecified', storeId: '0',
            expirationDate: 123,
          },
        ]);
      });
      mockSendNativeMessage.mockImplementation((_app, _msg, callback) => {
        callback({
          success: true,
          artifactId: 'abc123',
          filePath: '/store/ab/abc123.mp4',
          kind: 'video',
          metadata: { duration: 9.5 },
        });
      });
      const { modifications } = setFakeDb([createBookmark()]);

      const response = await service.downloadToEngine('https://x.com/tester/status/111?s=20', '111');

      expect(response.success).toBe(true);
      expect(response.artifactId).toBe('abc123');
      expect(mockSendNativeMessage).toHaveBeenCalledTimes(1);

      const [host, payload] = mockSendNativeMessage.mock.calls[0]!;
      expect(host).toBe('com.unos.video_downloader');
      expect(payload).toMatchObject({
        action: 'engine_download',
        url: 'https://x.com/tester/status/111',
        engineProject: PROJECT,
      });
      // x.com cookies win the dedup over twitter.com
      expect(payload.cookies).toHaveLength(1);
      expect(payload.cookies[0].value).toBe('x-value');

      expect(modifications).toHaveLength(1);
      expect(modifications[0]!.tweetId).toBe('111');
      expect(modifications[0]!.changes.engineArtifactId).toBe('abc123');
      expect(modifications[0]!.changes.enginePath).toBe('/store/ab/abc123.mp4');
      expect(modifications[0]!.changes.engineIngestedAt).toBeTypeOf('number');
      expect(localStorageData.engine_status).toBe('done');
      expect(localStorageData.engine_artifactId).toBe('abc123');
    });

    it('should set an error state and skip the DB update when the engine fails', async () => {
      localStorageData.engine_projectPath = PROJECT;
      mockSendNativeMessage.mockImplementation((_app, _msg, callback) => {
        callback({ success: false, error: 'yt-dlp failed (exit 1)' });
      });
      const { modifications } = setFakeDb([createBookmark()]);

      const response = await service.downloadToEngine('https://x.com/tester/status/111', '111');

      expect(response.success).toBe(false);
      expect(modifications).toHaveLength(0);
      expect(localStorageData.engine_status).toBe('error');
      expect(localStorageData.engine_error).toBe('yt-dlp failed (exit 1)');
    });

    it('should translate native messaging host errors into actionable messages', async () => {
      localStorageData.engine_projectPath = PROJECT;
      mockSendNativeMessage.mockImplementation((_app, _msg, callback) => {
        mockRuntime.lastError = { message: 'Specified native messaging host not found.' };
        callback(undefined);
      });

      const response = await service.downloadToEngine('https://x.com/tester/status/111', '111');
      expect(response.success).toBe(false);
      expect(response.error).toContain('Native host not installed');
      mockRuntime.lastError = null;
    });
  });

  describe('sendBatch', () => {
    it('should process each bookmark sequentially and count successes', async () => {
      localStorageData.engine_projectPath = PROJECT;
      const bookmarks = [
        createBookmark({ tweetId: '1', tweetUrl: 'https://x.com/a/status/1' }),
        createBookmark({ tweetId: '2', tweetUrl: 'https://x.com/a/status/2' }),
      ];
      setFakeDb(bookmarks);

      let call = 0;
      mockSendNativeMessage.mockImplementation((_app, _msg, callback) => {
        call++;
        callback(
          call === 1
            ? { success: true, artifactId: 'a1', filePath: '/store/a1.mp4' }
            : { success: false, error: 'boom' },
        );
      });

      const result = await service.sendBatch(['1', '2']);

      expect(result).toEqual({ processed: 2, succeeded: 1, failed: 1 });
      expect(mockSendNativeMessage).toHaveBeenCalledTimes(2);
      expect(localStorageData.engine_batchStatus).toBe('done');
      expect(localStorageData.engine_batchProcessed).toBe(2);
      expect(localStorageData.engine_batchTotal).toBe(2);
    });

    it('should count missing bookmarks as failures', async () => {
      localStorageData.engine_projectPath = PROJECT;
      setFakeDb([]);

      const result = await service.sendBatch(['does-not-exist']);
      expect(result).toEqual({ processed: 1, succeeded: 0, failed: 1 });
      expect(mockSendNativeMessage).not.toHaveBeenCalled();
    });
  });

  describe('getUnsentVideoCount', () => {
    it('should count only active video bookmarks not yet sent', async () => {
      setFakeDb([
        createBookmark({ tweetId: '1' }),
        createBookmark({ tweetId: '2', engineIngestedAt: Date.now() }),
        createBookmark({ tweetId: '3', hasVideo: false }),
        createBookmark({ tweetId: '4', archived: true }),
      ]);

      expect(await service.getUnsentVideoCount()).toBe(1);
    });
  });

  describe('getCatalogUrl', () => {
    it('should build the catalog URL from the configured base URL', async () => {
      localStorageData.engine_baseUrl = 'http://127.0.0.1:9000';
      const url = await service.getCatalogUrl('abc123');
      expect(url).toBe('http://127.0.0.1:9000/ui/catalog/abc123');
    });
  });

  describe('clearStaleState', () => {
    it('should clear a stale sending state', async () => {
      localStorageData.engine_status = 'sending';
      localStorageData.engine_startedAt = Date.now() - 20 * 60 * 1000;

      expect(await service.clearStaleState()).toBe(true);
      expect(localStorageData.engine_status).toBe('idle');
    });

    it('should leave a fresh sending state alone', async () => {
      localStorageData.engine_status = 'sending';
      localStorageData.engine_startedAt = Date.now();

      expect(await service.clearStaleState()).toBe(false);
      expect(localStorageData.engine_status).toBe('sending');
    });
  });
});
