import { getDatabase } from '../db/schema';

const NATIVE_HOST_NAME = 'com.unos.video_downloader';
const DEFAULT_BASE_URL = 'http://127.0.0.1:8000';
const STORAGE_KEY_BASE_URL = 'engine_baseUrl';
const STORAGE_KEY_API_TOKEN = 'engine_apiToken';
const REQUEST_TIMEOUT_MS = 15 * 1000;
const NATIVE_HOST_TIMEOUT_MS = 30 * 1000;
const JOB_POLL_INTERVAL_MS = 2000;
const JOB_TIMEOUT_MS = 30 * 60 * 1000; // per-job cap
const STALE_ENGINE_THRESHOLD_MS = JOB_TIMEOUT_MS + 5 * 60 * 1000;
const ENGINE_CONCURRENCY = 5;
const ACQUIRE_OP = 'acquire.url';
const ACQUIRE_BACKEND = 'yt-dlp';

interface NativeHostResponse {
  success: boolean;
  error?: string;
  cookiePath?: string;
  cookieCount?: number;
}

export interface EngineSettings {
  baseUrl: string;
  defaultBaseUrl: string;
  hasToken: boolean;
}

interface EngineJob {
  id: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
  error?: { error_class?: string; message?: string } | null;
}

interface EngineJobDetail {
  job: EngineJob;
  outputs: Array<{ id: string; kind?: string | null }>;
}

interface EngineArtifact {
  id: string;
  kind: string;
  path: string;
  metadata?: Record<string, unknown>;
}

export interface EngineDownloadResult {
  success: boolean;
  artifactId?: string;
  filePath?: string;
  kind?: string;
  metadata?: Record<string, unknown>;
  error?: string;
}

interface DoctorReport {
  summary?: { ok?: number; degraded?: number; unavailable?: number };
  ops?: Array<{
    op_name: string;
    overall: string;
    default_backend_status?: string;
  }>;
}

interface EngineState {
  engine_status: 'idle' | 'sending' | 'done' | 'error';
  engine_tweetId: string;
  engine_error: string;
  engine_artifactId: string;
  engine_startedAt: number;
}

interface EngineBatchState {
  engine_batchStatus: 'idle' | 'sending' | 'done' | 'error';
  engine_batchProcessed: number;
  engine_batchTotal: number;
  engine_batchError: string;
  engine_batchStartedAt: number;
}

class EngineApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly detail: string,
  ) {
    super(detail);
    this.name = 'EngineApiError';
  }
}

class EngineNetworkError extends Error {
  constructor(
    public readonly baseUrl: string,
    cause: unknown,
  ) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = 'EngineNetworkError';
  }
}

class EngineTimeoutError extends Error {
  constructor(public readonly baseUrl: string) {
    super(`Request timed out at ${baseUrl}`);
    this.name = 'EngineTimeoutError';
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isAbortError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { name?: string }).name === 'AbortError';
}

/**
 * MediaEngineService — sends bookmarked tweet videos to a locally running
 * media_engine server ({@link DEFAULT_BASE_URL}) over its REST API.
 *
 * For each URL the service submits an `acquire.url` job (`POST /run`),
 * polls the job until terminal, then records the resulting Video artifact
 * (`engineArtifactId` / `enginePath` / `engineIngestedAt`) on the XBookmark.
 *
 * Batch transfers run {@link ENGINE_CONCURRENCY} jobs in parallel. The
 * downloads execute server-side, so a popup/service-worker restart cannot
 * strand an in-flight acquisition.
 *
 * X auth cookies are never sent over HTTP: the native host writes a
 * Netscape jar to disk (0600) and the job references its path via
 * `cookies_file`; the jar is deleted when the transfer finishes.
 */
export class MediaEngineService {
  private sending = false;

  /**
   * Public settings view (never exposes the token itself).
   */
  async getSettings(): Promise<EngineSettings> {
    const { baseUrl, apiToken } = await this.readStoredCredentials();
    return {
      baseUrl,
      defaultBaseUrl: DEFAULT_BASE_URL,
      hasToken: Boolean(apiToken),
    };
  }

  /**
   * Validate the server + token, then persist settings.
   * Validation calls `GET /health` (reachability) and
   * `GET /settings/doctor?op=acquire.url` with the token, so a bad token
   * or a server without a working yt-dlp backend fails here instead of
   * during the first download.
   */
  async setSettings(input: {
    baseUrl?: string;
    apiToken?: string;
  }): Promise<{ success: boolean; baseUrl?: string; error?: string }> {
    const current = await this.readStoredCredentials();
    const baseUrl = this.normalizeBaseUrl(input.baseUrl ?? current.baseUrl);
    const apiToken = (input.apiToken ?? '').trim() || current.apiToken;

    if (!apiToken) {
      return {
        success: false,
        error: 'API token is required. Create one with: med api token create --label unos-extension',
      };
    }

    try {
      await this.fetchJson<Record<string, unknown>>('/health', baseUrl);
    } catch (err) {
      return { success: false, error: this.formatError(err) };
    }

    try {
      const doctor = await this.fetchJson<DoctorReport>(
        `/settings/doctor?op=${encodeURIComponent(ACQUIRE_OP)}`,
        baseUrl,
        apiToken,
      );
      const op = doctor.ops?.find((o) => o.op_name === ACQUIRE_OP);
      if (!op || op.overall !== 'ok') {
        return {
          success: false,
          error:
            `media_engine has no working ${ACQUIRE_OP} backend. ` +
            'Install yt-dlp into the engine environment (uv sync --extra acquire-url) and restart the server.',
        };
      }
    } catch (err) {
      return { success: false, error: this.formatError(err) };
    }

    await chrome.storage.local.set({
      [STORAGE_KEY_BASE_URL]: baseUrl,
      [STORAGE_KEY_API_TOKEN]: apiToken,
    });

    return { success: true, baseUrl };
  }

  /**
   * Send a single tweet video to media_engine.
   * Fire-and-forget from the caller's perspective; progress via chrome.storage.local.
   */
  async downloadToEngine(tweetUrl: string, tweetId?: string): Promise<EngineDownloadResult> {
    if (this.sending) {
      return { success: false, error: 'An engine transfer is already in progress' };
    }

    this.sending = true;

    try {
      const id = tweetId || (typeof tweetUrl === 'string' ? tweetUrl.match(/\/status\/(\d+)/)?.[1] : '') || '';

      await this.setState({
        engine_status: 'sending',
        engine_tweetId: id,
        engine_error: '',
        engine_artifactId: '',
        engine_startedAt: Date.now(),
      });

      const cookiePath = await this.writeCookieJar();

      try {
        const result = await this.performDownload(tweetUrl, id, cookiePath);
        if (result.success) {
          await this.setState({
            engine_status: 'done',
            engine_tweetId: id,
            engine_error: '',
            engine_artifactId: result.artifactId || '',
            engine_startedAt: 0,
          });
        } else {
          await this.setState({
            engine_status: 'error',
            engine_tweetId: id,
            engine_error: result.error || 'Engine transfer failed',
            engine_artifactId: '',
            engine_startedAt: 0,
          });
        }
        return result;
      } finally {
        await this.clearCookieJar();
      }
    } catch (err) {
      const errorMsg = this.formatError(err);
      console.error('[MediaEngine] Error:', errorMsg);
      await this.setState({
        engine_status: 'error',
        engine_tweetId: '',
        engine_error: errorMsg,
        engine_artifactId: '',
        engine_startedAt: 0,
      });
      return { success: false, error: errorMsg };
    } finally {
      this.sending = false;
    }
  }

  /**
   * Send multiple bookmarks to media_engine with a bounded worker pool
   * ({@link ENGINE_CONCURRENCY} jobs in flight).
   * Fire-and-forget from the caller; progress via chrome.storage.local.
   */
  async sendBatch(tweetIds: string[]): Promise<{ processed: number; succeeded: number; failed: number }> {
    if (this.sending) {
      return { processed: 0, succeeded: 0, failed: 0 };
    }

    this.sending = true;
    let succeeded = 0;
    let failed = 0;

    try {
      const db = getDatabase();
      const items: Array<{ tweetId: string; tweetUrl: string | null }> = [];
      for (const tweetId of tweetIds) {
        const bookmark = await db.xBookmarks.where('tweetId').equals(tweetId).first();
        items.push({
          tweetId,
          tweetUrl: bookmark && bookmark.hasVideo ? bookmark.tweetUrl : null,
        });
      }

      await this.setBatchState({
        engine_batchStatus: 'sending',
        engine_batchProcessed: 0,
        engine_batchTotal: items.length,
        engine_batchError: '',
        engine_batchStartedAt: Date.now(),
      });

      const downloadable = items.filter((item) => item.tweetUrl);
      if (downloadable.length === 0) {
        // Nothing to acquire — do not touch the cookie jar or the server.
        await this.setBatchState({
          engine_batchStatus: 'done',
          engine_batchProcessed: items.length,
          engine_batchStartedAt: 0,
        });
        return { processed: items.length, succeeded: 0, failed: items.length };
      }

      const cookiePath = await this.writeCookieJar();

      try {
        let cursor = 0;
        let processed = 0;
        const workerCount = Math.max(1, Math.min(ENGINE_CONCURRENCY, items.length));

        const workers = Array.from({ length: workerCount }, async () => {
          while (true) {
            const index = cursor++;
            if (index >= items.length) return;

            const item = items[index]!;
            try {
              if (!item.tweetUrl) {
                failed++;
                console.warn(`[MediaEngine] Skipping ${item.tweetId}: no video bookmark found`);
              } else {
                const result = await this.performDownload(item.tweetUrl, item.tweetId, cookiePath);
                if (result.success) {
                  succeeded++;
                } else {
                  failed++;
                  console.warn(`[MediaEngine] Failed ${item.tweetId}:`, result.error);
                }
              }
            } catch (err) {
              failed++;
              console.error(`[MediaEngine] Error ${item.tweetId}:`, this.formatError(err));
            }

            processed++;
            await this.setBatchState({ engine_batchProcessed: processed });
          }
        });

        await Promise.all(workers);

        await this.setBatchState({
          engine_batchStatus: 'done',
          engine_batchStartedAt: 0,
        });
        return { processed: items.length, succeeded, failed };
      } finally {
        await this.clearCookieJar();
      }
    } catch (err) {
      const msg = this.formatError(err);
      console.error('[MediaEngine] Batch error:', msg);
      await this.setBatchState({
        engine_batchStatus: 'error',
        engine_batchError: msg,
        engine_batchStartedAt: 0,
      });
      return { processed: succeeded + failed, succeeded, failed };
    } finally {
      this.sending = false;
    }
  }

  /**
   * Count bookmarks with videos not yet sent to media_engine.
   */
  async getUnsentVideoCount(): Promise<number> {
    const db = getDatabase();
    return db.xBookmarks.filter((b) => !b.archived && b.hasVideo && !b.engineIngestedAt).count();
  }

  /**
   * Build the media_engine Web UI catalog URL for an artifact.
   */
  async getCatalogUrl(artifactId: string): Promise<string> {
    const { baseUrl } = await this.readStoredCredentials();
    return `${baseUrl}/ui/catalog/${encodeURIComponent(artifactId)}`;
  }

  /**
   * Reset single-transfer state to idle.
   */
  async clearStatus(): Promise<void> {
    // Note: deliberately does NOT clear the in-memory `sending` guard —
    // dismissing the UI must never allow a second concurrent transfer.
    await this.setState({
      engine_status: 'idle',
      engine_tweetId: '',
      engine_error: '',
      engine_artifactId: '',
      engine_startedAt: 0,
    });
  }

  /**
   * Clear a stale "sending" state from a previous service worker lifecycle.
   */
  async clearStaleState(): Promise<boolean> {
    const data = await chrome.storage.local.get([
      'engine_status',
      'engine_startedAt',
      'engine_batchStatus',
      'engine_batchStartedAt',
    ]);

    // If no transfer is running in THIS service worker instance, any stored
    // "sending" state is necessarily from a previous lifecycle — clear it
    // immediately instead of waiting for the staleness threshold.
    let cleared = false;
    if (data.engine_status === 'sending' && (!this.sending || this.isStale(data.engine_startedAt))) {
      console.log('[MediaEngine] Clearing stale engine state');
      await this.clearStatus();
      cleared = true;
    }
    if (data.engine_batchStatus === 'sending' && (!this.sending || this.isStale(data.engine_batchStartedAt))) {
      console.log('[MediaEngine] Clearing stale engine batch state');
      await this.setBatchState({
        engine_batchStatus: 'idle',
        engine_batchProcessed: 0,
        engine_batchTotal: 0,
        engine_batchError: '',
        engine_batchStartedAt: 0,
      });
      cleared = true;
    }
    return cleared;
  }

  // ── Private helpers ──

  /**
   * Submit one acquire.url job and wait for it to finish.
   */
  private async performDownload(
    tweetUrl: string,
    tweetId: string,
    cookiePath: string,
  ): Promise<EngineDownloadResult> {
    const cleanUrl = tweetUrl.split('?')[0];

    const ack = await this.apiRequest<{ job_id: string }>('/run', {
      method: 'POST',
      body: JSON.stringify({
        op: ACQUIRE_OP,
        inputs: [],
        backend: ACQUIRE_BACKEND,
        params: {
          url: cleanUrl,
          quality: 'best',
          cookies_file: cookiePath,
        },
      }),
    });

    console.log('[MediaEngine] Job submitted:', ack.job_id, cleanUrl);

    const detail = await this.pollJob(ack.job_id);
    const output = detail.outputs.find((o) => o.kind === 'video') || detail.outputs[0];
    if (!output) {
      throw new Error('media_engine job completed without an output artifact');
    }

    let artifact: EngineArtifact | undefined;
    try {
      artifact = await this.apiRequest<EngineArtifact>(`/artifacts/${output.id}`);
    } catch {
      // Artifact lookup is best-effort; the id/kind from the job are enough.
    }

    const result: EngineDownloadResult = {
      success: true,
      artifactId: output.id,
      filePath: artifact?.path || '',
      kind: artifact?.kind || output.kind || 'video',
      metadata: artifact?.metadata || {},
    };

    if (tweetId) {
      const db = getDatabase();
      await db.xBookmarks.where('tweetId').equals(tweetId).modify({
        engineArtifactId: output.id,
        enginePath: result.filePath,
        engineIngestedAt: Date.now(),
      });
    }

    console.log('[MediaEngine] Job completed:', {
      tweetId,
      artifactId: output.id,
      path: result.filePath,
    });

    return result;
  }

  /**
   * Poll `GET /jobs/{id}` until the job reaches a terminal state.
   */
  private async pollJob(jobId: string): Promise<EngineJobDetail> {
    const deadline = Date.now() + JOB_TIMEOUT_MS;

    while (Date.now() < deadline) {
      const detail = await this.apiRequest<EngineJobDetail>(`/jobs/${jobId}`);
      const status = detail.job.status;

      if (status === 'completed') return detail;
      if (status === 'failed') {
        const error = detail.job.error;
        throw new Error(`media_engine job failed: ${error?.message || error?.error_class || 'unknown error'}`);
      }
      if (status === 'cancelled') {
        throw new Error('media_engine job was cancelled');
      }

      await sleep(JOB_POLL_INTERVAL_MS);
    }

    // Timed out client-side; ask the server to cancel so it stops downloading.
    await this.apiRequest(`/jobs/${jobId}`, { method: 'DELETE' }).catch(() => {});
    throw new Error(`media_engine job timed out after ${JOB_TIMEOUT_MS / 60000} minutes`);
  }

  private async apiRequest<T>(path: string, init?: RequestInit): Promise<T> {
    const { baseUrl, apiToken } = await this.readStoredCredentials();
    if (!apiToken) {
      throw new EngineApiError(401, 'No API token configured');
    }
    return this.fetchJson<T>(path, baseUrl, apiToken, init);
  }

  private async fetchJson<T>(
    path: string,
    baseUrl: string,
    apiToken?: string,
    init?: RequestInit,
  ): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const headers: Record<string, string> = {
        ...((init?.headers as Record<string, string> | undefined) || {}),
      };
      if (init?.body) headers['Content-Type'] = 'application/json';
      if (apiToken) headers['Authorization'] = `Bearer ${apiToken}`;

      let response: Response;
      try {
        response = await fetch(`${baseUrl}${path}`, { ...init, headers, signal: controller.signal });
      } catch (err) {
        if (isAbortError(err)) throw new EngineTimeoutError(baseUrl);
        throw new EngineNetworkError(baseUrl, err);
      }

      if (!response.ok) {
        let detail = `${response.status} ${response.statusText}`;
        try {
          const body = (await response.json()) as { detail?: unknown };
          if (typeof body?.detail === 'string') detail = body.detail;
          else if (body?.detail) detail = JSON.stringify(body.detail).slice(0, 300);
        } catch { /* non-JSON error body */ }
        throw new EngineApiError(response.status, detail);
      }

      if (response.status === 204) return undefined as T;
      return (await response.json()) as T;
    } finally {
      clearTimeout(timer);
    }
  }

  private async readStoredCredentials(): Promise<{ baseUrl: string; apiToken: string }> {
    const data = await chrome.storage.local.get([STORAGE_KEY_BASE_URL, STORAGE_KEY_API_TOKEN]);
    return {
      baseUrl: this.normalizeBaseUrl(data[STORAGE_KEY_BASE_URL] || DEFAULT_BASE_URL),
      apiToken: (data[STORAGE_KEY_API_TOKEN] || '').trim(),
    };
  }

  private normalizeBaseUrl(url: string): string {
    const trimmed = (url || DEFAULT_BASE_URL).trim().replace(/\/+$/, '');
    return trimmed || DEFAULT_BASE_URL;
  }

  private isStale(startedAt: unknown): boolean {
    const ts = typeof startedAt === 'number' ? startedAt : 0;
    return !ts || Date.now() - ts > STALE_ENGINE_THRESHOLD_MS;
  }

  private async getXCookies(): Promise<chrome.cookies.Cookie[]> {
    const [xCookies, twitterCookies] = await Promise.all([
      chrome.cookies.getAll({ domain: '.x.com' }),
      chrome.cookies.getAll({ domain: '.twitter.com' }),
    ]);
    const cookieMap = new Map<string, chrome.cookies.Cookie>();
    for (const c of twitterCookies) cookieMap.set(c.name, c);
    for (const c of xCookies) cookieMap.set(c.name, c);
    return Array.from(cookieMap.values());
  }

  /**
   * Ask the native host to write a 0600 Netscape cookie jar for the engine.
   * Cookie values never touch HTTP or the logs.
   */
  private async writeCookieJar(): Promise<string> {
    const cookies = await this.getXCookies();
    if (cookies.length === 0) {
      throw new Error('No X/Twitter cookies found. Make sure you are logged in to x.com.');
    }

    const response = await this.sendToNativeHost({
      action: 'write_engine_cookies',
      cookies: cookies.map((c) => ({
        name: c.name,
        value: c.value,
        domain: c.domain,
        path: c.path,
        secure: c.secure,
        expirationDate: c.expirationDate || 0,
      })),
    });

    if (!response.success || !response.cookiePath) {
      throw new Error(response.error || 'Could not write cookie jar via native host');
    }
    return response.cookiePath;
  }

  private async clearCookieJar(): Promise<void> {
    try {
      await this.sendToNativeHost({ action: 'clear_engine_cookies' });
    } catch {
      // Best effort — the jar is 0600 and will be overwritten next run.
    }
  }

  private sendToNativeHost(message: Record<string, unknown>): Promise<NativeHostResponse> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('Native host timed out. Check native-host/native-host.log for details.'));
      }, NATIVE_HOST_TIMEOUT_MS);

      chrome.runtime.sendNativeMessage(NATIVE_HOST_NAME, message, (response) => {
        clearTimeout(timer);
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else {
          resolve(response as NativeHostResponse);
        }
      });
    });
  }

  private async setState(state: EngineState): Promise<void> {
    await chrome.storage.local.set(state);
  }

  private async setBatchState(partial: Partial<EngineBatchState>): Promise<void> {
    await chrome.storage.local.set(partial);
  }

  private formatError(err: unknown): string {
    if (err instanceof EngineNetworkError) {
      return `media_engine server not reachable at ${err.baseUrl}. Start it with: med web start`;
    }
    if (err instanceof EngineTimeoutError) {
      return `media_engine request timed out at ${err.baseUrl}. Is the server healthy?`;
    }
    if (err instanceof EngineApiError) {
      if (err.status === 401) {
        return 'Invalid media_engine API token. Create a new one with: med api token create --label unos-extension';
      }
      if (err.status === 403) {
        return `media_engine denied the request (namespace mismatch?): ${err.detail}`;
      }
      return `media_engine API error (${err.status}): ${err.detail}`;
    }

    const msg = err instanceof Error ? err.message : String(err);

    if (msg.includes('Specified native messaging host not found') || msg.includes('not found')) {
      return 'Native host not installed. Run: cd native-host && ./install.sh';
    }
    if (msg.includes('Native host has exited')) {
      return 'Native host crashed. Check native-host/native-host.log for details. Try: cd native-host && ./install.sh';
    }
    if (msg.includes('Access to the specified native messaging host is forbidden')) {
      return 'Extension ID mismatch. Re-run: cd native-host && ./install.sh';
    }

    return msg;
  }
}

// Singleton
let instance: MediaEngineService | null = null;

export function getMediaEngineService(): MediaEngineService {
  if (!instance) instance = new MediaEngineService();
  return instance;
}
