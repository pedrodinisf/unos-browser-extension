/**
 * Data retention policy constants
 */
export const RETENTION = {
  // Session retention
  /** Days before unsaved sessions expire (7 days) */
  UNSAVED_SESSION_TTL_DAYS: 7,
  /** Saved sessions never expire */
  SAVED_SESSION_TTL_DAYS: null,

  // Visit history retention
  /** Days to keep visit history (30 days) */
  VISIT_HISTORY_TTL_DAYS: 30,

  // Relationship retention
  /** Minimum strength to keep a relationship */
  WEAK_RELATIONSHIP_THRESHOLD: 0.2,
  /** Maximum relationships per tab */
  MAX_RELATIONSHIPS_PER_TAB: 100,

  // Temporal proximity window
  /** Minutes within which tabs are considered temporally related */
  TEMPORAL_PROXIMITY_MINUTES: 10,
} as const;

/**
 * Storage limits
 */
export const STORAGE_LIMITS = {
  // In-memory cache limits
  /** Maximum cached tab mappings (chromeId -> persistentId) */
  MAX_CACHED_TAB_MAPPINGS: 1000,
  /** Maximum cached window mappings */
  MAX_CACHED_WINDOW_MAPPINGS: 50,
  /** Maximum pending writes before forced flush */
  MAX_PENDING_WRITES: 100,

  // IndexedDB limits (soft limits for pruning)
  /** Maximum visits per tab before pruning */
  MAX_VISITS_PER_TAB: 10000,
} as const;

/**
 * Calculate expiration timestamp for an unsaved session
 */
export function calculateSessionExpiry(startedAt: number): number {
  return startedAt + RETENTION.UNSAVED_SESSION_TTL_DAYS * 24 * 60 * 60 * 1000;
}

/**
 * Calculate temporal proximity strength based on time difference
 * Returns 0-1 where 1 is closest (same time) and 0 is at the boundary
 */
export function calculateTemporalStrength(timeDiffMs: number): number {
  const maxDiffMs = RETENTION.TEMPORAL_PROXIMITY_MINUTES * 60 * 1000;
  if (timeDiffMs >= maxDiffMs) return 0;
  return 1 - timeDiffMs / maxDiffMs;
}
