/**
 * Timing constants for the extension
 */
export const TIMING = {
  // Debounce intervals (milliseconds)
  /** Debounce for tab update events (URL/title changes) */
  TAB_UPDATE_DEBOUNCE_MS: 100,
  /** Maximum wait before forcing tab update processing */
  TAB_UPDATE_MAX_WAIT_MS: 500,
  /** Debounce for window focus events */
  WINDOW_FOCUS_DEBOUNCE_MS: 50,

  // Write batching intervals
  /** Interval between batched writes to IndexedDB */
  WRITE_BATCH_INTERVAL_MS: 500,
  /** Force flush after this time regardless of batch size */
  WRITE_BATCH_FORCE_MS: 5000,
  /** Maximum items in write queue before forced flush */
  WRITE_BATCH_MAX_SIZE: 100,

  // Chrome alarm intervals (minimum is 0.5 minutes = 30 seconds)
  /** Interval for flushing pending writes */
  FLUSH_ALARM_MINUTES: 0.5,
  /** Interval for cleanup of expired sessions */
  CLEANUP_ALARM_MINUTES: 60,
  /** Interval for recalculating temporal relationships */
  RELATIONSHIP_ALARM_MINUTES: 10,

  // Timeouts
  /** Timeout for database operations */
  DB_OPERATION_TIMEOUT_MS: 5000,
  /** Timeout for startup reconciliation */
  STARTUP_RECONCILE_TIMEOUT_MS: 10000,
} as const;

/**
 * Alarm names for chrome.alarms
 */
export const ALARM_NAMES = {
  FLUSH_WRITES: 'unos-flush-writes',
  CLEANUP: 'unos-cleanup',
  RELATIONSHIPS: 'unos-relationships',
} as const;
