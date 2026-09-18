import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MediaEngineService } from '../services/MediaEngineService';
import { getDatabase } from '../db/schema';
import type { XBookmark } from '../db/types';
import { mockCookies, mockSendNativeMessage, mockRuntime, localStorageData } from './setup';

vi.mock('../db/schema', () => ({
  getDatabase: vi.fn(),
}));

const BASE = 'http://127.0.0.1:8000';
const TOKEN = 'test-token-secret';
const COOKIE_PATH = '/Users/test/Library/Application Support/UNOS/native-host/engine-cookies.txt';

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

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    json: async () => body,
  } as unknown as Response;
}

/** Configure fetched paths → responses; unmatched paths reject like a dead server. */
function mockFetchRoutes(routes: Record<string, (init?: RequestInit) => Response>) {
  mockFetch.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
    const parsed = new URL(String(input));
    const route = routes[parsed.pathname + parsed.search];
    if (!route) return Promise.reject(new TypeError('Failed to fetch'));
    return Promise.resolve(route(init));
  });
}

const mockFetch = vi.fn();

function setCredentials(withToken = true) {
  localStorageData.engine_baseUrl = BASE;
  if (withToken) localStorageData.engine_apiToken = TOKEN;
}

function defaultNativeResponses() {
  mockSendNativeMessage.mockImplementation((_host, message, callback) => {
    if (message.action === 'write_engine_cookies') {
      callback({ success: true, cookiePath: COOKIE_PATH, cookieCount: 1 });
    } else if (message.action === 'clear_engine_cookies') {
      callback({ success: true });
    } else {
      callback({ success: false, error: `unexpected action ${message.action}` });
    }
  });
}

function defaultCookies() {
  mockCookies.getAll.mockImplementation(() => Promise.resolve([
    {
      name: 'auth_token', value: 'value', domain: '.x.com', path: '/',
      secure: true, httpOnly: true, hostOnly: false, session: false, sameSite: 'unspecified', storeId: '0',
    },
  ]));
}

describe('MediaEngineService', () => {
  let service: MediaEngineService;

  beforeEach(() => {
    service = new MediaEngineService();
    vi.stubGlobal('fetch', mockFetch);
    defaultCookies();
    defaultNativeResponses();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    mockRuntime.lastError = null;
  });

  describe('getSettings', () => {
    it('should return defaults when nothing is configured', async () => {
      const settings = await service.getSettings();
      expect(settings.baseUrl).toBe(BASE);
      expect(settings.defaultBaseUrl).toBe(BASE);
      expect(settings.hasToken).toBe(false);
    });

    it('should report a stored token and strip trailing slashes', async () => {
      localStorageData.engine_baseUrl = 'http://127.0.0.1:9000/';
      localStorageData.engine_apiToken = TOKEN;

      const settings = await service.getSettings();
      expect(settings.baseUrl).toBe('http://127.0.0.1:9000');
      expect(settings.hasToken).toBe(true);
    });
  });

  describe('setSettings', () => {
    it('should reject an empty token without calling the server', async () => {
      const result = await service.setSettings({ baseUrl: BASE });
      expect(result.success).toBe(false);
      expect(result.error).toContain('API token is required');
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('should surface an unreachable server', async () => {
      mockFetch.mockRejectedValue(new TypeError('Failed to fetch'));
      const result = await service.setSettings({ baseUrl: BASE, apiToken: TOKEN });
      expect(result.success).toBe(false);
      expect(result.error).toContain('not reachable');
    });

    it('should reject an invalid token (401 from doctor)', async () => {
      mockFetchRoutes({
        '/health': () => jsonResponse(200, { status: 'ok' }),
        '/settings/doctor?op=acquire.url': () => jsonResponse(401, { detail: 'invalid bearer' }),
      });

      const result = await service.setSettings({ baseUrl: BASE, apiToken: TOKEN });
      expect(result.success).toBe(false);
      expect(result.error).toContain('Invalid media_engine API token');
      expect(localStorageData.engine_apiToken).toBeUndefined();
    });

    it('should reject a server without a working acquire.url backend', async () => {
      mockFetchRoutes({
        '/health': () => jsonResponse(200, { status: 'ok' }),
        '/settings/doctor?op=acquire.url': () => jsonResponse(200, {
          summary: { ok: 0, degraded: 0, unavailable: 1 },
          ops: [{ op_name: 'acquire.url', overall: 'unavailable' }],
        }),
      });

      const result = await service.setSettings({ baseUrl: BASE, apiToken: TOKEN });
      expect(result.success).toBe(false);
      expect(result.error).toContain('uv sync --extra acquire-url');
    });

    it('should persist base URL and token after successful validation', async () => {
      mockFetchRoutes({
        '/health': () => jsonResponse(200, { status: 'ok' }),
        '/settings/doctor?op=acquire.url': (init) => {
          const headers = (init?.headers || {}) as Record<string, string>;
          expect(headers.Authorization).toBe(`Bearer ${TOKEN}`);
          return jsonResponse(200, {
            summary: { ok: 1, degraded: 0, unavailable: 0 },
            ops: [{ op_name: 'acquire.url', overall: 'ok' }],
          });
        },
      });

      const result = await service.setSettings({ baseUrl: 'http://localhost:9000/', apiToken: TOKEN });
      expect(result.success).toBe(true);
      expect(result.baseUrl).toBe('http://localhost:9000');
      expect(localStorageData.engine_baseUrl).toBe('http://localhost:9000');
      expect(localStorageData.engine_apiToken).toBe(TOKEN);
    });
  });

  describe('downloadToEngine', () => {
    it('should fail when no X cookies are available', async () => {
      setCredentials();
      mockCookies.getAll.mockImplementation(() => Promise.resolve([]));

      const response = await service.downloadToEngine('https://x.com/tester/status/111', '111');
      expect(response.success).toBe(false);
      expect(response.error).toContain('cookies');
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('should submit a job, poll it, persist the artifact and clear the jar', async () => {
      vi.useFakeTimers();
      setCredentials();
      const { modifications } = setFakeDb([createBookmark()]);

      let pollCount = 0;
      mockFetchRoutes({
        '/run': (init) => {
          const body = JSON.parse(String(init?.body));
          expect(body.op).toBe('acquire.url');
          expect(body.backend).toBe('yt-dlp');
          expect(body.params.url).toBe('https://x.com/tester/status/111');
          expect(body.params.cookies_file).toBe(COOKIE_PATH);
          return jsonResponse(202, { job_id: 'job-1' });
        },
        '/jobs/job-1': () => {
          pollCount++;
          return jsonResponse(200, pollCount < 2
            ? { job: { id: 'job-1', status: 'running' }, outputs: [] }
            : { job: { id: 'job-1', status: 'completed' }, outputs: [{ id: 'art-1', kind: 'video' }] });
        },
        '/artifacts/art-1': () => jsonResponse(200, {
          id: 'art-1', kind: 'video', path: '/store/art-1.mp4', metadata: { duration: 9.5 },
        }),
      });

      const pending = service.downloadToEngine('https://x.com/tester/status/111?s=20', '111');
      await vi.advanceTimersByTimeAsync(2000);
      const response = await pending;
      vi.useRealTimers();

      expect(response.success).toBe(true);
      expect(response.artifactId).toBe('art-1');
      expect(response.filePath).toBe('/store/art-1.mp4');
      expect(response.metadata).toEqual({ duration: 9.5 });

      expect(modifications).toHaveLength(1);
      expect(modifications[0]!.changes.engineArtifactId).toBe('art-1');
      expect(modifications[0]!.changes.enginePath).toBe('/store/art-1.mp4');
      expect(modifications[0]!.changes.engineIngestedAt).toBeTypeOf('number');
      expect(localStorageData.engine_status).toBe('done');

      const actions = mockSendNativeMessage.mock.calls.map(c => (c[1] as { action: string }).action);
      expect(actions).toEqual(['write_engine_cookies', 'clear_engine_cookies']);
    });

    it('should map a failed job to an error state without a DB write', async () => {
      setCredentials();
      const { modifications } = setFakeDb([createBookmark()]);

      mockFetchRoutes({
        '/run': () => jsonResponse(202, { job_id: 'job-2' }),
        '/jobs/job-2': () => jsonResponse(200, {
          job: {
            id: 'job-2',
            status: 'failed',
            error: { error_class: 'RuntimeError', message: 'yt-dlp failed (exit 1)' },
          },
          outputs: [],
        }),
      });

      const response = await service.downloadToEngine('https://x.com/tester/status/111', '111');

      expect(response.success).toBe(false);
      expect(response.error).toContain('yt-dlp failed');
      expect(modifications).toHaveLength(0);
      expect(localStorageData.engine_status).toBe('error');
    });

    it('should cancel the job and report a timeout when polling exceeds the cap', async () => {
      vi.useFakeTimers();
      setCredentials();
      setFakeDb([createBookmark()]);

      const deletes: string[] = [];
      mockFetch.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
        const parsed = new URL(String(input));
        if (parsed.pathname === '/run') {
          return Promise.resolve(jsonResponse(202, { job_id: 'job-t' }));
        }
        if (parsed.pathname === '/jobs/job-t' && init?.method === 'DELETE') {
          deletes.push(parsed.pathname);
          return Promise.resolve(jsonResponse(200, { job_id: 'job-t', cancelled: true }));
        }
        if (parsed.pathname === '/jobs/job-t') {
          return Promise.resolve(jsonResponse(200, {
            job: { id: 'job-t', status: 'running' },
            outputs: [],
          }));
        }
        return Promise.reject(new TypeError('Failed to fetch'));
      });

      const pending = service.downloadToEngine('https://x.com/tester/status/111', '111');
      await vi.advanceTimersByTimeAsync(31 * 60 * 1000);
      const response = await pending;
      vi.useRealTimers();

      expect(response.success).toBe(false);
      expect(response.error).toContain('timed out');
      expect(deletes).toEqual(['/jobs/job-t']);
      expect(localStorageData.engine_status).toBe('error');
    });

    it('should map a missing token to an actionable 401 message', async () => {
      setCredentials(false);
      const response = await service.downloadToEngine('https://x.com/tester/status/111', '111');
      expect(response.success).toBe(false);
      expect(response.error).toContain('Invalid media_engine API token');
    });

    it('should translate native host errors', async () => {
      setCredentials();
      mockSendNativeMessage.mockImplementation((_host, _message, callback) => {
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
    it('should process items with at most 5 concurrent jobs', async () => {
      setCredentials();
      const bookmarks = Array.from({ length: 12 }, (_, i) =>
        createBookmark({ tweetId: String(i), tweetUrl: `https://x.com/a/status/${i}` }));
      setFakeDb(bookmarks);

      let activeRuns = 0;
      let maxActiveRuns = 0;

      mockFetch.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const path = url.slice(BASE.length);
        if (path === '/run') {
          const body = JSON.parse(String(init?.body));
          const tweetId = body.params.url.split('/').pop();
          activeRuns++;
          maxActiveRuns = Math.max(maxActiveRuns, activeRuns);
          return new Promise((resolve) => {
            setTimeout(() => {
              activeRuns--;
              resolve(jsonResponse(202, { job_id: `job-${tweetId}` }));
            }, 5);
          });
        }
        if (path.startsWith('/jobs/')) {
          const jobId = path.split('/').pop()!;
          const artifactId = `art-${jobId}`;
          return Promise.resolve(jsonResponse(200, {
            job: { id: jobId, status: 'completed' },
            outputs: [{ id: artifactId, kind: 'video' }],
          }));
        }
        if (path.startsWith('/artifacts/')) {
          const artifactId = path.split('/').pop()!;
          return Promise.resolve(jsonResponse(200, {
            id: artifactId, kind: 'video', path: `/store/${artifactId}.mp4`, metadata: {},
          }));
        }
        return Promise.reject(new TypeError('Failed to fetch'));
      });

      const result = await service.sendBatch(bookmarks.map(b => b.tweetId));

      expect(result).toEqual({ processed: 12, succeeded: 12, failed: 0 });
      expect(maxActiveRuns).toBeLessThanOrEqual(5);
      expect(maxActiveRuns).toBeGreaterThan(1);
      expect(localStorageData.engine_batchStatus).toBe('done');
      expect(localStorageData.engine_batchProcessed).toBe(12);
      expect(localStorageData.engine_batchTotal).toBe(12);
    });

    it('should count missing bookmarks as failures without touching cookies or the server', async () => {
      setCredentials();
      setFakeDb([]);

      const result = await service.sendBatch(['does-not-exist']);
      expect(result).toEqual({ processed: 1, succeeded: 0, failed: 1 });
      expect(mockFetch).not.toHaveBeenCalled();
      expect(mockSendNativeMessage).not.toHaveBeenCalled();
      expect(localStorageData.engine_batchStatus).toBe('done');
    });

    it('should no-op an empty batch', async () => {
      setCredentials();
      setFakeDb([]);

      const result = await service.sendBatch([]);
      expect(result).toEqual({ processed: 0, succeeded: 0, failed: 0 });
      expect(mockFetch).not.toHaveBeenCalled();
      expect(mockSendNativeMessage).not.toHaveBeenCalled();
    });

    it('should not require a logged-in session when no bookmark has video', async () => {
      setCredentials();
      setFakeDb([createBookmark({ tweetId: '1', hasVideo: false })]);
      mockCookies.getAll.mockImplementation(() => Promise.resolve([]));

      const result = await service.sendBatch(['1']);
      expect(result).toEqual({ processed: 1, succeeded: 0, failed: 1 });
      expect(mockFetch).not.toHaveBeenCalled();
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
    it('should clear a stale single-transfer state', async () => {
      localStorageData.engine_status = 'sending';
      localStorageData.engine_startedAt = Date.now() - 40 * 60 * 1000;

      expect(await service.clearStaleState()).toBe(true);
      expect(localStorageData.engine_status).toBe('idle');
    });

    it('should clear leftover state immediately after a service worker restart', async () => {
      localStorageData.engine_status = 'sending';
      localStorageData.engine_startedAt = Date.now();
      localStorageData.engine_batchStatus = 'sending';
      localStorageData.engine_batchStartedAt = Date.now();

      // A fresh service instance has no in-flight transfer, so both states
      // must be leftovers from a previous lifecycle.
      expect(await service.clearStaleState()).toBe(true);
      expect(localStorageData.engine_status).toBe('idle');
      expect(localStorageData.engine_batchStatus).toBe('idle');
    });

    it('should not clear state while a transfer is active in this instance', async () => {
      setCredentials();
      let runStarted = false;
      let resolveRun: (r: Response) => void = () => {};
      mockFetch.mockImplementation((input: RequestInfo | URL) => {
        const path = new URL(String(input)).pathname;
        if (path === '/run') {
          runStarted = true;
          return new Promise<Response>((resolve) => { resolveRun = resolve; });
        }
        if (path.startsWith('/jobs/')) {
          return Promise.resolve(jsonResponse(200, {
            job: { id: 'job-x', status: 'cancelled' },
            outputs: [],
          }));
        }
        return Promise.reject(new TypeError('Failed to fetch'));
      });

      const pending = service.downloadToEngine('https://x.com/tester/status/111', '111');
      while (!runStarted) await new Promise((r) => setTimeout(r, 0));

      expect(await service.clearStaleState()).toBe(false);
      expect(localStorageData.engine_status).toBe('sending');

      resolveRun(jsonResponse(202, { job_id: 'job-x' }));
      const response = await pending;
      expect(response.success).toBe(false);
      expect(localStorageData.engine_status).toBe('error');
    });

    it('should clear a stale batch state', async () => {
      localStorageData.engine_batchStatus = 'sending';
      localStorageData.engine_batchStartedAt = Date.now() - 40 * 60 * 1000;

      expect(await service.clearStaleState()).toBe(true);
      expect(localStorageData.engine_batchStatus).toBe('idle');
    });
  });
});
