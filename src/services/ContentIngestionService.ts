import { getDatabase } from '../db/schema';
import type { XBookmark } from '../db/types';

const NATIVE_HOST_NAME = 'com.unos.video_downloader';
const STORAGE_KEY_FOLDER = 'ingestion_folderPath';

interface NativeHostResponse {
  success: boolean;
  error?: string;
  resolvedPath?: string;
  tweetDir?: string;
  filesCreated?: string[];
  imagesDownloaded?: number;
  videoFile?: string | null;
}

interface IngestionProgress {
  ingestion_status: 'idle' | 'ingesting' | 'done' | 'error';
  ingestion_currentTweetId: string;
  ingestion_processed: number;
  ingestion_total: number;
  ingestion_error: string;
}

/**
 * ContentIngestionService — orchestrates local content ingestion for X bookmarks.
 *
 * For each bookmark, the native host:
 *   1. Creates {rootDir}/{tweetId}/ folder
 *   2. Downloads images at maximum quality (name=orig)
 *   3. Writes metadata.json + content.txt
 *   4. Downloads video+audio via yt-dlp (if hasVideo)
 *
 * Progress is tracked via chrome.storage.local for UI updates.
 */
export class ContentIngestionService {
  private ingesting = false;

  /**
   * Detect OS and return a sensible default ingestion folder path.
   */
  getDefaultFolder(): string {
    const ua = navigator.userAgent.toLowerCase();
    if (ua.includes('windows')) {
      return '%USERPROFILE%\\Documents\\UNOS\\x-inbox';
    }
    // macOS and Linux
    return '~/Documents/UNOS/x-inbox';
  }

  /**
   * Detect the current OS from user agent.
   */
  detectOS(): 'windows' | 'macos' | 'linux' {
    const ua = navigator.userAgent.toLowerCase();
    if (ua.includes('windows')) return 'windows';
    if (ua.includes('mac')) return 'macos';
    return 'linux';
  }

  /**
   * Get the configured ingestion folder, or the OS default.
   */
  async getIngestionFolder(): Promise<string> {
    const data = await chrome.storage.local.get(STORAGE_KEY_FOLDER);
    return data[STORAGE_KEY_FOLDER] || this.getDefaultFolder();
  }

  /**
   * Set and validate the ingestion folder via the native host.
   * Returns the resolved absolute path on success.
   */
  async setIngestionFolder(folder: string): Promise<{ success: boolean; resolvedPath?: string; error?: string }> {
    const response = await this.sendToNativeHost({
      action: 'validate_folder',
      folder,
    });

    if (response.success && response.resolvedPath) {
      await chrome.storage.local.set({ [STORAGE_KEY_FOLDER]: response.resolvedPath });
      return { success: true, resolvedPath: response.resolvedPath };
    }

    return { success: false, error: response.error || 'Failed to validate folder' };
  }

  /**
   * Ingest a single bookmark: download all content to local folder.
   */
  async ingestBookmark(tweetId: string): Promise<NativeHostResponse> {
    const db = getDatabase();
    const bookmark = await db.xBookmarks.where('tweetId').equals(tweetId).first();
    if (!bookmark) {
      return { success: false, error: `Bookmark not found: ${tweetId}` };
    }

    const rootDir = await this.getIngestionFolder();

    // Get cookies for video download
    const cookies = bookmark.hasVideo ? await this.getXCookies() : [];

    const response = await this.sendToNativeHost({
      action: 'ingest_bookmark',
      bookmark: {
        tweetId: bookmark.tweetId,
        authorHandle: bookmark.authorHandle,
        authorName: bookmark.authorName,
        text: bookmark.text,
        timestamp: bookmark.timestamp,
        tweetUrl: bookmark.tweetUrl,
        mediaUrls: bookmark.mediaUrls,
        hasVideo: bookmark.hasVideo,
        isQuoteTweet: bookmark.isQuoteTweet,
        tags: bookmark.tags,
        notes: bookmark.notes,
        categories: bookmark.categories,
      },
      rootDir,
      cookies: cookies.map((c) => ({
        name: c.name,
        value: c.value,
        domain: c.domain,
        path: c.path,
        secure: c.secure,
        expirationDate: c.expirationDate || 0,
      })),
    });

    // Update DB with ingestion status
    if (response.success) {
      await db.xBookmarks.where('tweetId').equals(tweetId).modify({
        ingestedAt: Date.now(),
        ingestionPath: response.tweetDir || '',
      });
    }

    return response;
  }

  /**
   * Ingest multiple bookmarks in sequence.
   * Fire-and-forget from the caller; progress via chrome.storage.local.
   */
  async ingestBatch(tweetIds: string[]): Promise<{ processed: number; succeeded: number; failed: number }> {
    if (this.ingesting) {
      return { processed: 0, succeeded: 0, failed: 0 };
    }

    this.ingesting = true;
    let succeeded = 0;
    let failed = 0;

    try {
      await this.setProgress('ingesting', '', 0, tweetIds.length);

      for (let i = 0; i < tweetIds.length; i++) {
        const tweetId = tweetIds[i]!;
        await this.setProgress('ingesting', tweetId, i, tweetIds.length);

        try {
          const result = await this.ingestBookmark(tweetId);
          if (result.success) {
            succeeded++;
          } else {
            failed++;
            console.warn(`[Ingestion] Failed ${tweetId}:`, result.error);
          }
        } catch (err) {
          failed++;
          console.error(`[Ingestion] Error ${tweetId}:`, err);
        }
      }

      await this.setProgress('done', '', tweetIds.length, tweetIds.length);
      return { processed: tweetIds.length, succeeded, failed };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await this.setProgress('error', '', 0, 0, msg);
      return { processed: succeeded + failed, succeeded, failed };
    } finally {
      this.ingesting = false;
    }
  }

  /**
   * Get all un-ingested bookmarks (for batch ingest).
   */
  async getUningestedCount(): Promise<number> {
    const db = getDatabase();
    return db.xBookmarks.filter((b) => !b.archived && !b.ingestedAt).count();
  }

  // ── Private helpers ──

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
      chrome.runtime.sendNativeMessage(NATIVE_HOST_NAME, message, (response) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else {
          resolve(response as NativeHostResponse);
        }
      });
    });
  }

  private async setProgress(
    status: IngestionProgress['ingestion_status'],
    currentTweetId: string,
    processed: number,
    total: number,
    error?: string,
  ): Promise<void> {
    const update: Record<string, unknown> = {
      ingestion_status: status,
      ingestion_currentTweetId: currentTweetId,
      ingestion_processed: processed,
      ingestion_total: total,
    };
    if (error) update.ingestion_error = error;
    await chrome.storage.local.set(update);
  }
}

// Singleton
let instance: ContentIngestionService | null = null;

export function getContentIngestionService(): ContentIngestionService {
  if (!instance) instance = new ContentIngestionService();
  return instance;
}
