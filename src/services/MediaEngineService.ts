import { getDatabase } from '../db/schema';

const NATIVE_HOST_NAME = 'com.unos.video_downloader';
const DEFAULT_BASE_URL = 'http://127.0.0.1:8000';
const STORAGE_KEY_PROJECT = 'engine_projectPath';
const STORAGE_KEY_BASE_URL = 'engine_baseUrl';
const NATIVE_HOST_TIMEOUT_MS = 16 * 60 * 1000; // 16 minutes (host times out at 15)
const STALE_ENGINE_THRESHOLD_MS = 17 * 60 * 1000;

interface NativeHostResponse {
  success: boolean;
  error?: string;
  artifactId?: string;
  filePath?: string;
  kind?: string;
  metadata?: Record<string, unknown>;
  engineProject?: string;
  uvPath?: string;
  venvReady?: boolean;
}

export interface EngineSettings {
  projectPath: string;
  baseUrl: string;
  defaultBaseUrl: string;
}

interface EngineState {
  engine_status: 'idle' | 'sending' | 'done' | 'error';
  engine_tweetId: string;
  engine_error: string;
  engine_artifactId: string;
  engine_path: string;
  engine_startedAt: number;
}

interface EngineBatchState {
  engine_batchStatus: 'idle' | 'sending' | 'done' | 'error';
  engine_batchProcessed: number;
  engine_batchTotal: number;
  engine_batchCurrentTweetId: string;
  engine_batchError: string;
}

/**
 * MediaEngineService — hands bookmarked tweet videos to a local media_engine
 * installation via Chrome Native Messaging.
 *
 * The native host shells out to:
 *   uv run --no-sync --project <engine> med --json acquire-url <url> --cookies <jar>
 *
 * media_engine downloads into its content-addressed store and returns a typed
 * Video artifact; the artifact id + path are persisted on the XBookmark record.
 */
export class MediaEngineService {
  private sending = false;

  /**
   * Read configured engine settings (falls back to defaults).
   */
  async getSettings(): Promise<EngineSettings> {
    const data = await chrome.storage.local.get([STORAGE_KEY_PROJECT, STORAGE_KEY_BASE_URL]);
    return {
      projectPath: data[STORAGE_KEY_PROJECT] || '',
      baseUrl: this.normalizeBaseUrl(data[STORAGE_KEY_BASE_URL] || DEFAULT_BASE_URL),
      defaultBaseUrl: DEFAULT_BASE_URL,
    };
  }

  /**
   * Validate the media_engine project via the native host, then persist settings.
   * Validation also verifies uv + the project venv so failures surface here
   * instead of during the first download.
   */
  async setSettings(input: {
    projectPath?: string;
    baseUrl?: string;
  }): Promise<{ success: boolean; projectPath?: string; baseUrl?: string; error?: string }> {
    const current = await this.getSettings();
    const projectPath = (input.projectPath ?? current.projectPath).trim();
    const baseUrl = this.normalizeBaseUrl(input.baseUrl ?? current.baseUrl);

    if (!projectPath) {
      return { success: false, error: 'Engine project path is required' };
    }

    try {
      const response = await this.sendToNativeHost({
        action: 'validate_engine',
        engineProject: projectPath,
      });

      if (!response.success) {
        return { success: false, error: response.error || 'Engine validation failed' };
      }

      const resolvedProject = response.engineProject || projectPath;
      await chrome.storage.local.set({
        [STORAGE_KEY_PROJECT]: resolvedProject,
        [STORAGE_KEY_BASE_URL]: baseUrl,
      });

      return { success: true, projectPath: resolvedProject, baseUrl };
    } catch (err) {
      return { success: false, error: this.formatError(err) };
    }
  }

  /**
   * Send a single tweet video to media_engine.
   * Fire-and-forget from the caller's perspective; progress via chrome.storage.local.
   */
  async downloadToEngine(tweetUrl: string, tweetId?: string): Promise<NativeHostResponse> {
    if (this.sending) {
      return { success: false, error: 'An engine transfer is already in progress' };
    }

    this.sending = true;

    try {
      return await this.performDownload(tweetUrl, tweetId);
    } finally {
      this.sending = false;
    }
  }

  /**
   * Core single-download implementation (no concurrency guard) so batch can reuse it.
   */
  private async performDownload(tweetUrl: string, tweetId?: string): Promise<NativeHostResponse> {
    const id = tweetId || tweetUrl.match(/\/status\/(\d+)/)?.[1] || '';

    try {
      await this.setState({
        engine_status: 'sending',
        engine_tweetId: id,
        engine_error: '',
        engine_artifactId: '',
        engine_path: '',
        engine_startedAt: Date.now(),
      });

      const settings = await this.getSettings();
      if (!settings.projectPath) {
        const err = 'media_engine not configured. Set the project path in Engine settings.';
        await this.setState({
          engine_status: 'error',
          engine_tweetId: id,
          engine_error: err,
          engine_artifactId: '',
          engine_path: '',
          engine_startedAt: 0,
        });
        return { success: false, error: err };
      }

      const cookies = await this.getXCookies();
      const cleanUrl = tweetUrl.split('?')[0];

      console.log('[MediaEngine] Sending to engine:', {
        url: cleanUrl,
        cookieCount: cookies.length,
        project: settings.projectPath,
      });

      const response = await this.sendToNativeHost({
        action: 'engine_download',
        url: cleanUrl,
        cookies: cookies.map((c) => ({
          name: c.name,
          value: c.value,
          domain: c.domain,
          path: c.path,
          secure: c.secure,
          expirationDate: c.expirationDate || 0,
        })),
        engineProject: settings.projectPath,
      });

      console.log('[MediaEngine] Engine response:', {
        success: response.success,
        artifactId: response.artifactId,
        error: response.error,
      });

      if (response.success) {
        if (id && response.artifactId) {
          const db = getDatabase();
          await db.xBookmarks.where('tweetId').equals(id).modify({
            engineArtifactId: response.artifactId,
            enginePath: response.filePath || '',
            engineIngestedAt: Date.now(),
          });
        }
        await this.setState({
          engine_status: 'done',
          engine_tweetId: id,
          engine_error: '',
          engine_artifactId: response.artifactId || '',
          engine_path: response.filePath || '',
          engine_startedAt: 0,
        });
      } else {
        await this.setState({
          engine_status: 'error',
          engine_tweetId: id,
          engine_error: response.error || 'Engine transfer failed',
          engine_artifactId: '',
          engine_path: '',
          engine_startedAt: 0,
        });
      }

      return response;
    } catch (err) {
      console.error('[MediaEngine] Error:', err);
      const errorMsg = this.formatError(err);
      await this.setState({
        engine_status: 'error',
        engine_tweetId: id,
        engine_error: errorMsg,
        engine_artifactId: '',
        engine_path: '',
        engine_startedAt: 0,
      });
      return { success: false, error: errorMsg };
    }
  }

  /**
   * Send multiple bookmarks to media_engine in sequence.
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
      await this.setBatchState({
        engine_batchStatus: 'sending',
        engine_batchProcessed: 0,
        engine_batchTotal: tweetIds.length,
        engine_batchCurrentTweetId: '',
        engine_batchError: '',
      });

      for (let i = 0; i < tweetIds.length; i++) {
        const tweetId = tweetIds[i]!;
        await this.setBatchState({ engine_batchCurrentTweetId: tweetId });

        try {
          const db = getDatabase();
          const bookmark = await db.xBookmarks.where('tweetId').equals(tweetId).first();
          if (!bookmark) {
            failed++;
          } else {
            const result = await this.performDownload(bookmark.tweetUrl, tweetId);
            if (result.success) {
              succeeded++;
            } else {
              failed++;
              console.warn(`[MediaEngine] Failed ${tweetId}:`, result.error);
            }
          }
        } catch (err) {
          failed++;
          console.error(`[MediaEngine] Error ${tweetId}:`, err);
        }

        await this.setBatchState({ engine_batchProcessed: i + 1 });
      }

      await this.setBatchState({ engine_batchStatus: 'done', engine_batchCurrentTweetId: '' });
      return { processed: tweetIds.length, succeeded, failed };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await this.setBatchState({ engine_batchStatus: 'error', engine_batchError: msg });
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
    const settings = await this.getSettings();
    return `${settings.baseUrl}/ui/catalog/${encodeURIComponent(artifactId)}`;
  }

  /**
   * Reset single-transfer state to idle.
   */
  async clearStatus(): Promise<void> {
    this.sending = false;
    await this.setState({
      engine_status: 'idle',
      engine_tweetId: '',
      engine_error: '',
      engine_artifactId: '',
      engine_path: '',
      engine_startedAt: 0,
    });
  }

  /**
   * Clear a stale "sending" state (e.g. after a service worker restart).
   */
  async clearStaleState(): Promise<boolean> {
    const data = await chrome.storage.local.get(['engine_status', 'engine_startedAt']);
    if (data.engine_status === 'sending') {
      const startedAt = data.engine_startedAt || 0;
      if (!startedAt || Date.now() - startedAt > STALE_ENGINE_THRESHOLD_MS) {
        console.log('[MediaEngine] Clearing stale engine state');
        await this.clearStatus();
        return true;
      }
    }
    return false;
  }

  // ── Private helpers ──

  private normalizeBaseUrl(url: string): string {
    const trimmed = (url || DEFAULT_BASE_URL).trim().replace(/\/+$/, '');
    return trimmed || DEFAULT_BASE_URL;
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

  private sendToNativeHost(message: Record<string, unknown>): Promise<NativeHostResponse> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('Engine transfer timed out after 16 minutes. Check native-host/native-host.log for details.'));
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
