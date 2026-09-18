import { describe, it, expect } from 'vitest';
import { backfillXBookmarkEngineFields } from '../db/schema';

describe('Dexie v3 → v4 migration', () => {
  it('should backfill engine fields on a v3 bookmark', () => {
    const v3Bookmark: Record<string, unknown> = {
      tweetId: '1234567890',
      authorHandle: '@tester',
      text: 'legacy bookmark',
      hasVideo: true,
      ingestedAt: 1234,
      ingestionPath: '/tmp/x-inbox/1234567890',
    };

    backfillXBookmarkEngineFields(v3Bookmark);

    expect(v3Bookmark.engineArtifactId).toBe('');
    expect(v3Bookmark.enginePath).toBe('');
    expect(v3Bookmark.engineIngestedAt).toBeNull();
    // Existing v3 data is untouched
    expect(v3Bookmark.ingestedAt).toBe(1234);
    expect(v3Bookmark.ingestionPath).toBe('/tmp/x-inbox/1234567890');
  });

  it('should preserve already-populated engine fields', () => {
    const v4Bookmark: Record<string, unknown> = {
      tweetId: '1234567890',
      engineArtifactId: 'abc123',
      enginePath: '/store/ab/abc123.mp4',
      engineIngestedAt: 5678,
    };

    backfillXBookmarkEngineFields(v4Bookmark);

    expect(v4Bookmark.engineArtifactId).toBe('abc123');
    expect(v4Bookmark.enginePath).toBe('/store/ab/abc123.mp4');
    expect(v4Bookmark.engineIngestedAt).toBe(5678);
  });
});
