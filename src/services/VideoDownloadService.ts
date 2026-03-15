const NATIVE_HOST_NAME = 'com.unos.video_downloader';
const DEFAULT_OUTPUT_DIR = '~/Downloads';

interface NativeHostResponse {
  success: boolean;
  filePath?: string;
  error?: string;
  note?: string;
}

interface DownloadState {
  xBookmarks_downloadStatus: 'idle' | 'downloading' | 'done' | 'error';
  xBookmarks_downloadTweetId: string;
  xBookmarks_downloadError: string;
  xBookmarks_downloadPath: string;
}

/**
 * VideoDownloadService — downloads X/Twitter videos via Chrome Native Messaging.
 *
 * Uses chrome.cookies.getAll to extract X auth cookies, then sends them along
 * with the tweet URL to a native Python host that runs yt-dlp.
 */
export class VideoDownloadService {
  private downloadInProgress = false;

  /**
   * Download a video from an X/Twitter tweet URL.
   * Fire-and-forget from the caller's perspective; progress via chrome.storage.local.
   */
  async downloadVideo(tweetUrl: string): Promise<NativeHostResponse> {
    if (this.downloadInProgress) {
      return { success: false, error: 'Download already in progress' };
    }

    this.downloadInProgress = true;

    // Extract tweet ID for tracking
    const tweetIdMatch = tweetUrl.match(/\/status\/(\d+)/);
    const tweetId = tweetIdMatch?.[1] || '';

    try {
      await this.setDownloadState({
        xBookmarks_downloadStatus: 'downloading',
        xBookmarks_downloadTweetId: tweetId,
        xBookmarks_downloadError: '',
        xBookmarks_downloadPath: '',
      });

      // Get cookies from both x.com and twitter.com
      const [xCookies, twitterCookies] = await Promise.all([
        this.getCookies('.x.com'),
        this.getCookies('.twitter.com'),
      ]);

      // Deduplicate cookies by name (prefer x.com)
      const cookieMap = new Map<string, chrome.cookies.Cookie>();
      for (const c of twitterCookies) cookieMap.set(c.name, c);
      for (const c of xCookies) cookieMap.set(c.name, c);
      const cookies = Array.from(cookieMap.values());

      if (cookies.length === 0) {
        const err = 'No X/Twitter cookies found. Make sure you are logged in to x.com.';
        await this.setDownloadState({
          xBookmarks_downloadStatus: 'error',
          xBookmarks_downloadTweetId: tweetId,
          xBookmarks_downloadError: err,
          xBookmarks_downloadPath: '',
        });
        return { success: false, error: err };
      }

      // Resolve home directory for output
      const outputDir = DEFAULT_OUTPUT_DIR;

      console.log('[VideoDownload] Sending to native host:', {
        url: tweetUrl.split('?')[0],
        cookieCount: cookies.length,
      });

      // Send to native host
      const response = await this.sendToNativeHost({
        action: 'download_video',
        url: tweetUrl.split('?')[0], // strip query string
        cookies: cookies.map((c) => ({
          name: c.name,
          value: c.value,
          domain: c.domain,
          path: c.path,
          secure: c.secure,
          expirationDate: c.expirationDate || 0,
        })),
        outputDir,
      });

      console.log('[VideoDownload] Native host response:', response);

      if (response.success) {
        await this.setDownloadState({
          xBookmarks_downloadStatus: 'done',
          xBookmarks_downloadTweetId: tweetId,
          xBookmarks_downloadError: '',
          xBookmarks_downloadPath: response.filePath || '',
        });
      } else {
        await this.setDownloadState({
          xBookmarks_downloadStatus: 'error',
          xBookmarks_downloadTweetId: tweetId,
          xBookmarks_downloadError: response.error || 'Download failed',
          xBookmarks_downloadPath: '',
        });
      }

      return response;
    } catch (err) {
      console.error('[VideoDownload] Error:', err);
      const errorMsg = this.formatError(err);
      await this.setDownloadState({
        xBookmarks_downloadStatus: 'error',
        xBookmarks_downloadTweetId: tweetId,
        xBookmarks_downloadError: errorMsg,
        xBookmarks_downloadPath: '',
      });
      return { success: false, error: errorMsg };
    } finally {
      this.downloadInProgress = false;
    }
  }

  /**
   * Clear download state (reset to idle)
   */
  async clearDownloadStatus(): Promise<void> {
    await this.setDownloadState({
      xBookmarks_downloadStatus: 'idle',
      xBookmarks_downloadTweetId: '',
      xBookmarks_downloadError: '',
      xBookmarks_downloadPath: '',
    });
  }

  // ── Private helpers ──

  private getCookies(domain: string): Promise<chrome.cookies.Cookie[]> {
    return chrome.cookies.getAll({ domain });
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

  private async setDownloadState(state: DownloadState): Promise<void> {
    await chrome.storage.local.set(state);
  }

  private formatError(err: unknown): string {
    const msg = err instanceof Error ? err.message : String(err);

    // Provide actionable messages for common native messaging errors
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
let instance: VideoDownloadService | null = null;

export function getVideoDownloadService(): VideoDownloadService {
  if (!instance) instance = new VideoDownloadService();
  return instance;
}
