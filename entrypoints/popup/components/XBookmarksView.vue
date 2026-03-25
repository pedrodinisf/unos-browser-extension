<script setup lang="ts">
import { ref, reactive, computed, onMounted, onUnmounted, watch, nextTick } from 'vue';
import type { XBookmark, XSyncState } from '../../../src/db/types';
import IngestionSettingsDialog from './IngestionSettingsDialog.vue';

// State
const bookmarks = ref<XBookmark[]>([]);
const syncState = ref<XSyncState | null>(null);
const syncing = ref(false);
const syncNewCount = ref(0);
const searchQuery = ref('');
const showArchived = ref(false);
const expandedTweetIds = reactive(new Set<string>());
const loading = ref(true);
const loadingMore = ref(false);
const page = ref(1);
const totalCount = ref(0);
const statusMsg = ref('');
const downloadStatus = ref<'idle' | 'downloading' | 'done' | 'error'>('idle');
const downloadTweetId = ref('');
const downloadError = ref('');

// Ingestion state
const showIngestionSettings = ref(false);
const ingestionStatus = ref<'idle' | 'ingesting' | 'done' | 'error'>('idle');
const ingestionProcessed = ref(0);
const ingestionTotal = ref(0);
const ingestingTweetId = ref('');

// Sort & filter state
const sortBy = ref<'firstSeenAt' | 'timestamp' | 'authorHandle'>('firstSeenAt');
const sortOrder = ref<'desc' | 'asc'>('desc');
const filterHasMedia = ref(false);
const filterHasVideo = ref(false);
const filterHasTags = ref(false);
const LIMIT = 100;

const sortOptions = [
  { value: 'firstSeenAt' as const, label: 'BKM' },
  { value: 'timestamp' as const, label: 'TWD' },
  { value: 'authorHandle' as const, label: 'AUT' },
];

// API helper
async function sendMessage<T>(message: Record<string, unknown>): Promise<T> {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      if (!response.success) {
        reject(new Error(response.error || 'Unknown error'));
        return;
      }
      resolve(response.data as T);
    });
  });
}

// Build filters object (only include active filters)
function buildFilters(): Record<string, boolean> | undefined {
  const f: Record<string, boolean> = {};
  if (filterHasMedia.value) f.hasMedia = true;
  if (filterHasVideo.value) f.hasVideo = true;
  if (filterHasTags.value) f.hasTags = true;
  return Object.keys(f).length > 0 ? f : undefined;
}

// Load bookmarks (reset mode - replaces list)
async function loadData() {
  try {
    loading.value = true;
    page.value = 1;
    const result = await sendMessage<{ bookmarks: XBookmark[]; totalCount: number }>({
      type: 'X_GET_BOOKMARKS',
      includeArchived: showArchived.value,
      page: 1,
      limit: LIMIT,
      search: searchQuery.value || undefined,
      sortBy: sortBy.value,
      sortOrder: sortOrder.value,
      filters: buildFilters(),
    });
    bookmarks.value = result.bookmarks;
    totalCount.value = result.totalCount;

    syncState.value = await sendMessage<XSyncState | null>({ type: 'X_GET_SYNC_STATE' });
  } catch (err) {
    console.error('Failed to load X bookmarks:', err);
  } finally {
    loading.value = false;
  }
}

// Load more bookmarks (append mode for infinite scroll)
async function loadMore() {
  if (loadingMore.value || !hasMore.value) return;
  try {
    loadingMore.value = true;
    page.value++;
    const result = await sendMessage<{ bookmarks: XBookmark[]; totalCount: number }>({
      type: 'X_GET_BOOKMARKS',
      includeArchived: showArchived.value,
      page: page.value,
      limit: LIMIT,
      search: searchQuery.value || undefined,
      sortBy: sortBy.value,
      sortOrder: sortOrder.value,
      filters: buildFilters(),
    });
    bookmarks.value = [...bookmarks.value, ...result.bookmarks];
    totalCount.value = result.totalCount;
  } catch (err) {
    console.error('Failed to load more bookmarks:', err);
    page.value--; // Revert on error
  } finally {
    loadingMore.value = false;
  }
}

// Start sync
async function startSync(fullSync = false) {
  try {
    syncing.value = true;
    syncNewCount.value = 0;
    await sendMessage({ type: 'X_SYNC_BOOKMARKS', options: { fullSync } });
  } catch (err) {
    console.error('Failed to start sync:', err);
    syncing.value = false;
  }
}

// Monitor sync progress via chrome.storage.onChanged
function onStorageChanged(changes: Record<string, chrome.storage.StorageChange>, area: string) {
  if (area !== 'local') return;

  if (changes.xBookmarks_syncStatus) {
    const status = changes.xBookmarks_syncStatus.newValue;
    if (status === 'syncing' || status === 'starting') {
      syncing.value = true;
    } else if (status === 'done') {
      syncing.value = false;
      loadData();
    } else if (status === 'error') {
      syncing.value = false;
      statusMsg.value = 'Sync failed';
      setTimeout(() => (statusMsg.value = ''), 3000);
    }
  }

  if (changes.xBookmarks_syncNewCount) {
    syncNewCount.value = changes.xBookmarks_syncNewCount.newValue || 0;
  }

  // Download state
  if (changes.xBookmarks_downloadStatus) {
    downloadStatus.value = changes.xBookmarks_downloadStatus.newValue || 'idle';
  }
  if (changes.xBookmarks_downloadTweetId) {
    downloadTweetId.value = changes.xBookmarks_downloadTweetId.newValue || '';
  }
  if (changes.xBookmarks_downloadError) {
    downloadError.value = changes.xBookmarks_downloadError.newValue || '';
  }

  // Ingestion state
  if (changes.ingestion_status) {
    ingestionStatus.value = changes.ingestion_status.newValue || 'idle';
    if (changes.ingestion_status.newValue === 'done') {
      loadData(); // Refresh to show ingested indicators
      ingestingTweetId.value = '';
    }
  }
  if (changes.ingestion_processed) {
    ingestionProcessed.value = changes.ingestion_processed.newValue || 0;
  }
  if (changes.ingestion_total) {
    ingestionTotal.value = changes.ingestion_total.newValue || 0;
  }
  if (changes.ingestion_currentTweetId) {
    ingestingTweetId.value = changes.ingestion_currentTweetId.newValue || '';
  }
}

// Archive/unarchive
async function archiveBookmark(tweetId: string) {
  await sendMessage({ type: 'X_ARCHIVE_BOOKMARK', tweetId });
  bookmarks.value = bookmarks.value.filter((b) => b.tweetId !== tweetId);
  totalCount.value--;
  expandedTweetIds.delete(tweetId);
}

async function unarchiveBookmark(tweetId: string) {
  await sendMessage({ type: 'X_UNARCHIVE_BOOKMARK', tweetId });
  loadData();
}

// Tag editing
async function addTag(tweetId: string, tag: string) {
  const bm = bookmarks.value.find((b) => b.tweetId === tweetId);
  if (!bm || bm.tags.includes(tag)) return;
  const newTags = [...bm.tags, tag];
  await sendMessage({ type: 'X_UPDATE_BOOKMARK_META', tweetId, tags: newTags });
  bm.tags = newTags;
}

async function removeTag(tweetId: string, tag: string) {
  const bm = bookmarks.value.find((b) => b.tweetId === tweetId);
  if (!bm) return;
  const newTags = bm.tags.filter((t) => t !== tag);
  await sendMessage({ type: 'X_UPDATE_BOOKMARK_META', tweetId, tags: newTags });
  bm.tags = newTags;
}

// Notes
async function updateNotes(tweetId: string, notes: string) {
  await sendMessage({ type: 'X_UPDATE_BOOKMARK_META', tweetId, notes });
  const bm = bookmarks.value.find((b) => b.tweetId === tweetId);
  if (bm) bm.notes = notes;
}

// Export
async function exportBookmarks(format: 'json' | 'markdown') {
  try {
    const result = await sendMessage<{ data: string; filename: string }>({
      type: 'X_EXPORT_BOOKMARKS',
      format,
    });
    const blob = new Blob([result.data], { type: format === 'json' ? 'application/json' : 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = result.filename;
    a.click();
    URL.revokeObjectURL(url);
    statusMsg.value = `Exported ${result.filename}`;
    setTimeout(() => (statusMsg.value = ''), 3000);
  } catch (err) {
    console.error('Export failed:', err);
  }
}

// Persist view state (expanded cards + scroll position) across popup reopens
function saveViewState() {
  const scrollTop = listEl.value?.scrollTop ?? 0;
  chrome.storage.session.set({
    xMarks_expandedIds: [...expandedTweetIds],
    xMarks_scrollTop: scrollTop,
  });
}

let pendingScrollTop = 0;

async function restoreViewState() {
  const data = await chrome.storage.session.get(['xMarks_expandedIds', 'xMarks_scrollTop']);
  if (data.xMarks_expandedIds?.length) {
    expandedTweetIds.clear();
    for (const id of data.xMarks_expandedIds) {
      expandedTweetIds.add(id);
    }
  }
  pendingScrollTop = data.xMarks_scrollTop || 0;
}

// Expand/collapse a bookmark card and scroll it into view
function toggleExpand(tweetId: string, event: MouseEvent) {
  const collapsing = expandedTweetIds.has(tweetId);
  if (collapsing) {
    expandedTweetIds.delete(tweetId);
  } else {
    expandedTweetIds.add(tweetId);
  }
  tagInput.value = '';

  if (!collapsing) {
    nextTick(() => {
      const card = (event.currentTarget as HTMLElement)?.closest('.xbm-card');
      if (card) {
        card.scrollIntoView({ block: 'start', behavior: 'smooth' });
      }
    });
  }

  saveViewState();
}

// Download video via native host
async function downloadVideo(tweetUrl: string) {
  try {
    await sendMessage({ type: 'X_DOWNLOAD_VIDEO', tweetUrl });
  } catch (err) {
    console.error('Failed to start video download:', err);
    statusMsg.value = 'Download failed to start';
    setTimeout(() => (statusMsg.value = ''), 3000);
  }
}

// Clear download status
async function clearDownloadStatus() {
  try {
    await sendMessage({ type: 'X_CLEAR_DOWNLOAD_STATUS' });
    downloadStatus.value = 'idle';
    downloadTweetId.value = '';
    downloadError.value = '';
  } catch { /* ignore */ }
}

// Open URL in background tab (popup stays open)
function openInBackground(url: string) {
  chrome.tabs.create({ url, active: false });
}

// Copy tweet URL as fallback
async function copyTweetUrl(tweetUrl: string) {
  try {
    await navigator.clipboard.writeText(tweetUrl);
    statusMsg.value = 'Tweet URL copied';
    setTimeout(() => (statusMsg.value = ''), 2000);
  } catch {
    statusMsg.value = 'Copy failed';
    setTimeout(() => (statusMsg.value = ''), 2000);
  }
}

// Ingest a single bookmark
async function ingestBookmark(tweetId: string) {
  try {
    ingestingTweetId.value = tweetId;
    await sendMessage({ type: 'X_INGEST_BOOKMARK', tweetId });
  } catch (err) {
    console.error('Failed to start ingestion:', err);
    statusMsg.value = 'Ingestion failed to start';
    setTimeout(() => (statusMsg.value = ''), 3000);
  }
}

// Batch ingest all un-ingested bookmarks
async function ingestAll() {
  const allBookmarks = await sendMessage<{ bookmarks: XBookmark[]; totalCount: number }>({
    type: 'X_GET_BOOKMARKS',
    includeArchived: false,
    page: 1,
    limit: 99999,
  });
  const tweetIds = allBookmarks.bookmarks
    .filter((b) => !b.ingestedAt)
    .map((b) => b.tweetId);
  if (tweetIds.length === 0) {
    statusMsg.value = 'All bookmarks already ingested';
    setTimeout(() => (statusMsg.value = ''), 3000);
    return;
  }
  await sendMessage({ type: 'X_INGEST_BATCH', tweetIds });
}

// Helpers
function relativeTime(ts: number): string {
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function tweetAge(timestamp: string): string {
  if (!timestamp) return '';
  try {
    const diff = Date.now() - new Date(timestamp).getTime();
    const days = Math.floor(diff / 86400000);
    if (days < 1) return 'today';
    if (days < 30) return `${days}d`;
    const months = Math.floor(days / 30);
    if (months < 12) return `${months}mo`;
    const years = Math.floor(months / 12);
    return `${years}y`;
  } catch {
    return '';
  }
}

function bookmarkedAge(ts: number): string {
  const diff = Date.now() - ts;
  const days = Math.floor(diff / 86400000);
  if (days < 1) return 'today';
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  const years = Math.floor(months / 12);
  return `${years}y ago`;
}

// Format tweet text: preserve emojis, highlight @mentions and URLs
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatTweetHtml(text: string): string {
  let html = escapeHtml(text);
  // Highlight @mentions
  html = html.replace(/@(\w+)/g, '<span class="xbm-mention">@$1</span>');
  // Highlight URLs
  html = html.replace(/(https?:\/\/[^\s]+)/g, '<span class="xbm-url">$1</span>');
  // Highlight hashtags
  html = html.replace(/#(\w+)/g, '<span class="xbm-hashtag">#$1</span>');
  return html;
}

function formatTweetPreview(text: string): string {
  return formatTweetHtml(text);
}

function formatTweetFull(text: string): string {
  // Collapse multiple newlines into single line break for density
  let html = formatTweetHtml(text);
  html = html.replace(/\n{2,}/g, '<br>').replace(/\n/g, '<br>');
  return html;
}

function authorInitial(handle: string): string {
  return (handle.replace('@', '')[0] || '?').toUpperCase();
}

function authorColor(handle: string): string {
  let hash = 0;
  for (let i = 0; i < handle.length; i++) {
    hash = handle.charCodeAt(i) + ((hash << 5) - hash);
  }
  const hue = Math.abs(hash) % 360;
  return `hsl(${hue}, 45%, 40%)`;
}

// Which time label to show based on sort
const showBookmarkedTime = computed(() => sortBy.value === 'firstSeenAt');

const hasMore = computed(() => bookmarks.value.length < totalCount.value);

const anyFiltersActive = computed(() =>
  filterHasMedia.value || filterHasVideo.value || filterHasTags.value || showArchived.value
);

// Debounced search
let searchTimeout: ReturnType<typeof setTimeout> | null = null;
watch(searchQuery, () => {
  if (searchTimeout) clearTimeout(searchTimeout);
  searchTimeout = setTimeout(() => {
    loadData();
  }, 150);
});

// Reset and reload on filter/sort/archived changes
watch([showArchived, sortBy, sortOrder, filterHasMedia, filterHasVideo, filterHasTags], () => {
  loadData();
});

// Tag input state per expanded bookmark
const tagInput = ref('');

function handleTagKeydown(e: KeyboardEvent, tweetId: string) {
  if (e.key === 'Enter' && tagInput.value.trim()) {
    addTag(tweetId, tagInput.value.trim().toLowerCase());
    tagInput.value = '';
  }
}

// Toggle sort order
function toggleSortOrder() {
  sortOrder.value = sortOrder.value === 'desc' ? 'asc' : 'desc';
}

// Infinite scroll via IntersectionObserver
const sentinel = ref<HTMLElement | null>(null);
const listEl = ref<HTMLElement | null>(null);
let observer: IntersectionObserver | null = null;

function setupObserver() {
  if (observer) observer.disconnect();
  observer = new IntersectionObserver(
    (entries) => {
      if (entries[0].isIntersecting && hasMore.value && !loading.value && !loadingMore.value) {
        loadMore();
      }
    },
    { root: listEl.value, rootMargin: '200px' },
  );
  if (sentinel.value) observer.observe(sentinel.value);
}

// Save scroll position on scroll (debounced)
let scrollSaveTimer: ReturnType<typeof setTimeout> | null = null;
function onListScroll() {
  if (scrollSaveTimer) clearTimeout(scrollSaveTimer);
  scrollSaveTimer = setTimeout(saveViewState, 300);
}

// Lifecycle
onMounted(async () => {
  // Restore expanded IDs before loading data so cards render expanded
  await restoreViewState();
  loadData();
  chrome.storage.onChanged.addListener(onStorageChanged);

  // Check if sync or download is already in progress
  chrome.storage.local.get(
    ['xBookmarks_syncStatus', 'xBookmarks_downloadStatus', 'xBookmarks_downloadTweetId', 'xBookmarks_downloadError'],
    (data) => {
      if (data.xBookmarks_syncStatus === 'syncing' || data.xBookmarks_syncStatus === 'starting') {
        syncing.value = true;
      }
      if (data.xBookmarks_downloadStatus) {
        downloadStatus.value = data.xBookmarks_downloadStatus;
      }
      if (data.xBookmarks_downloadTweetId) {
        downloadTweetId.value = data.xBookmarks_downloadTweetId;
      }
      if (data.xBookmarks_downloadError) {
        downloadError.value = data.xBookmarks_downloadError;
      }
    },
  );

  nextTick(() => {
    setupObserver();
    // Attach scroll listener for persisting scroll position
    if (listEl.value) {
      listEl.value.removeEventListener('scroll', onListScroll);
      listEl.value.addEventListener('scroll', onListScroll, { passive: true });
    }
  });
});

onUnmounted(() => {
  chrome.storage.onChanged.removeListener(onStorageChanged);
  if (listEl.value) listEl.value.removeEventListener('scroll', onListScroll);
  if (scrollSaveTimer) clearTimeout(scrollSaveTimer);
  if (searchTimeout) clearTimeout(searchTimeout);
  if (observer) observer.disconnect();
});

// Re-observe sentinel after data loads and restore pending scroll position
watch(bookmarks, () => {
  nextTick(() => {
    if (sentinel.value && observer) {
      observer.disconnect();
      observer.observe(sentinel.value);
    }
    if (pendingScrollTop && listEl.value) {
      listEl.value.scrollTo(0, pendingScrollTop);
      pendingScrollTop = 0;
    }
  });
});

function reset() {
  searchQuery.value = '';
  filterHasMedia.value = false;
  filterHasVideo.value = false;
  filterHasTags.value = false;
  expandedTweetIds.clear();
  listEl.value?.scrollTo(0, 0);
  saveViewState();
}

defineExpose({ reset });
</script>

<template>
  <div class="xbm-container">
    <!-- Header bar -->
    <div class="xbm-header">
      <button
        class="xbm-sync-btn"
        :class="{ syncing: syncing }"
        :disabled="syncing"
        @click="startSync(false)"
        :title="syncing ? 'Sync in progress...' : 'Sync bookmarks from X'"
      >
        <span v-if="syncing" class="xbm-spinner"></span>
        <span v-else>
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
            <path d="M1 8a7 7 0 0113.27-3.17M15 8a7 7 0 01-13.27 3.17" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
            <path d="M14 1v4h-4M2 15v-4h4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
        </span>
        {{ syncing ? `Syncing... (+${syncNewCount})` : 'Sync' }}
      </button>

      <div class="xbm-stats">
        <span v-if="syncState" class="xbm-stat" :title="`Last sync: ${new Date(syncState.lastSyncAt).toLocaleString()}`">
          {{ relativeTime(syncState.lastSyncAt) }}
        </span>
        <span class="xbm-stat xbm-stat-count">{{ totalCount }} bookmarks</span>
      </div>

      <div class="xbm-export-btns">
        <button class="xbm-icon-btn" @click="exportBookmarks('json')" title="Export JSON">
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none"><path d="M4 2h5l4 4v8a1 1 0 01-1 1H4a1 1 0 01-1-1V3a1 1 0 011-1z" stroke="currentColor" stroke-width="1.3"/><path d="M9 2v4h4" stroke="currentColor" stroke-width="1.3"/></svg>
          <span class="xbm-icon-label">JSON</span>
        </button>
        <button class="xbm-icon-btn" @click="exportBookmarks('markdown')" title="Export Markdown">
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none"><path d="M4 2h5l4 4v8a1 1 0 01-1 1H4a1 1 0 01-1-1V3a1 1 0 011-1z" stroke="currentColor" stroke-width="1.3"/><path d="M9 2v4h4" stroke="currentColor" stroke-width="1.3"/></svg>
          <span class="xbm-icon-label">MD</span>
        </button>
        <button class="xbm-icon-btn" @click="showIngestionSettings = true" title="Ingestion settings (download all media to local folder)">
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none"><path d="M6.5 1.5h3L10 3.5l1.5.5 1.5-1 2 2-1 1.5.5 1.5 2 .5v3l-2 .5-.5 1.5 1 1.5-2 2-1.5-1-1.5.5-.5 2h-3l-.5-2-1.5-.5-1.5 1-2-2 1-1.5-.5-1.5-2-.5v-3l2-.5.5-1.5-1-1.5 2-2 1.5 1 1.5-.5z" stroke="currentColor" stroke-width="1.2"/><circle cx="8" cy="8" r="2" stroke="currentColor" stroke-width="1.2"/></svg>
        </button>
      </div>
    </div>

    <!-- Status message -->
    <div v-if="statusMsg" class="xbm-status">{{ statusMsg }}</div>

    <!-- Ingestion progress bar -->
    <div v-if="ingestionStatus === 'ingesting'" class="xbm-ingestion-bar">
      <span class="xbm-spinner"></span>
      <span>Ingesting {{ ingestionProcessed }}/{{ ingestionTotal }}</span>
    </div>
    <div v-else-if="ingestionStatus === 'done'" class="xbm-ingestion-bar xbm-ingestion-done" @click="ingestionStatus = 'idle'">
      Ingestion complete ({{ ingestionProcessed }} bookmarks)
    </div>

    <!-- Search bar -->
    <div class="xbm-filter-bar">
      <input
        v-model="searchQuery"
        type="text"
        class="xbm-search"
        placeholder="Search bookmarks..."
      />
    </div>

    <!-- Instrument bar -->
    <div class="xbm-instrument-bar">
      <span class="xbm-readout">{{ bookmarks.length }}<span class="xbm-readout-sep">/</span>{{ totalCount }}</span>

      <span class="xbm-bar-divider"></span>

      <!-- Sort segment group -->
      <div class="xbm-seg-group">
        <button
          v-for="opt in sortOptions"
          :key="opt.value"
          class="xbm-seg-btn"
          :class="{ active: sortBy === opt.value }"
          :title="'Sort by ' + opt.label"
          @click="sortBy = opt.value"
        >{{ opt.label }}</button>
        <button
          class="xbm-seg-btn xbm-seg-dir"
          :title="sortOrder === 'desc' ? 'Descending' : 'Ascending'"
          @click="toggleSortOrder"
        >{{ sortOrder === 'desc' ? '▼' : '▲' }}</button>
      </div>

      <span class="xbm-bar-divider"></span>

      <!-- Filter toggle group -->
      <div class="xbm-toggle-group">
        <button
          class="xbm-toggle-btn"
          :class="{ active: filterHasMedia }"
          title="Has images"
          @click="filterHasMedia = !filterHasMedia"
        >IMG</button>
        <button
          class="xbm-toggle-btn"
          :class="{ active: filterHasVideo }"
          title="Has video"
          @click="filterHasVideo = !filterHasVideo"
        >VID</button>
        <button
          class="xbm-toggle-btn"
          :class="{ active: filterHasTags }"
          title="Has tags"
          @click="filterHasTags = !filterHasTags"
        >TAG</button>
        <button
          class="xbm-toggle-btn xbm-toggle-arch"
          :class="{ active: showArchived }"
          title="Show archived"
          @click="showArchived = !showArchived"
        >ARCH</button>
      </div>

      <span class="xbm-bar-divider"></span>

      <!-- Reset button -->
      <button
        class="xbm-reset"
        :class="{ disabled: expandedTweetIds.size === 0 }"
        :disabled="expandedTweetIds.size === 0"
        title="Collapse all and scroll to top"
        @click="expandedTweetIds.clear(); listEl?.scrollTo(0, 0); saveViewState()"
      >
        <svg width="10" height="10" viewBox="0 0 16 16" fill="none">
          <path d="M4 6l4-4 4 4M4 10l4 4 4-4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
      </button>
    </div>

    <!-- Loading -->
    <div v-if="loading && bookmarks.length === 0" class="xbm-loading">
      <span class="xbm-spinner"></span>
      Loading...
    </div>

    <!-- Empty state -->
    <div v-else-if="bookmarks.length === 0 && !loading" class="xbm-empty">
      <template v-if="searchQuery || anyFiltersActive">
        <p>No matching bookmarks.</p>
        <button
          class="xbm-clear-filters-btn"
          @click="searchQuery = ''; filterHasMedia = false; filterHasVideo = false; filterHasTags = false"
        >
          Clear search &amp; filters
        </button>
      </template>
      <template v-else>
        <p>No bookmarks synced yet.</p>
        <p class="xbm-empty-hint">
          Open <strong>x.com/i/bookmarks</strong> in a tab and click <strong>Sync</strong>.
        </p>
        <button class="xbm-sync-btn" @click="startSync(false)" :disabled="syncing">
          {{ syncing ? 'Syncing...' : 'Sync Now' }}
        </button>
      </template>
    </div>

    <!-- Bookmark list -->
    <div v-else ref="listEl" class="xbm-list">
      <div
        v-for="bm in bookmarks"
        :key="bm.tweetId"
        class="xbm-card"
        :class="{ expanded: expandedTweetIds.has(bm.tweetId) }"
      >
        <!-- Collapsed row -->
        <div class="xbm-row" @click="toggleExpand(bm.tweetId, $event)">
          <div class="xbm-avatar" :style="{ background: authorColor(bm.authorHandle) }">
            {{ authorInitial(bm.authorHandle) }}
          </div>
          <div class="xbm-row-content">
            <div class="xbm-row-top">
              <span class="xbm-author-name">{{ bm.authorName }}</span>
              <span class="xbm-author-handle">{{ bm.authorHandle }}</span>
              <span class="xbm-tweet-age" :title="showBookmarkedTime ? `Bookmarked ${new Date(bm.firstSeenAt).toLocaleString()}` : `Tweet: ${bm.timestamp}`">
                {{ showBookmarkedTime ? bookmarkedAge(bm.firstSeenAt) : tweetAge(bm.timestamp) }}
              </span>
            </div>
            <div class="xbm-row-text" v-html="formatTweetPreview(bm.text)"></div>
          </div>
          <div class="xbm-row-meta">
            <span v-if="bm.mediaUrls.length > 0" class="xbm-media-badge" title="Has images">
              <svg width="10" height="10" viewBox="0 0 16 16" fill="none"><rect x="1" y="3" width="14" height="10" rx="1" stroke="currentColor" stroke-width="1.3"/><circle cx="5" cy="7" r="1.5" fill="currentColor"/><path d="M1 11l4-3 3 2 3-2 4 3" stroke="currentColor" stroke-width="1.3"/></svg>
              {{ bm.mediaUrls.length }}
            </span>
            <span v-if="bm.hasVideo" class="xbm-media-badge" title="Has video">
              <svg width="10" height="10" viewBox="0 0 16 16" fill="none"><polygon points="5,3 13,8 5,13" fill="currentColor"/></svg>
            </span>
            <span v-for="tag in bm.tags.slice(0, 2)" :key="tag" class="xbm-tag-pill">{{ tag }}</span>
            <span v-if="bm.tags.length > 2" class="xbm-tag-overflow">+{{ bm.tags.length - 2 }}</span>
          </div>
        </div>

        <!-- Expanded detail -->
        <div v-if="expandedTweetIds.has(bm.tweetId)" class="xbm-detail">
          <!-- Full text -->
          <div class="xbm-detail-text" v-html="formatTweetFull(bm.text)"></div>

          <!-- Timestamp info -->
          <div class="xbm-detail-timestamps">
            <span v-if="bm.timestamp" title="Tweet date">
              <svg width="10" height="10" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="6.5" stroke="currentColor" stroke-width="1.3"/><path d="M8 4.5V8l2.5 1.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>
              Tweet: {{ new Date(bm.timestamp).toLocaleDateString() }}
            </span>
            <span title="Bookmarked date">
              <svg width="10" height="10" viewBox="0 0 16 16" fill="none"><path d="M4 2h8v12l-4-2.5L4 14z" stroke="currentColor" stroke-width="1.3"/></svg>
              Saved: {{ new Date(bm.firstSeenAt).toLocaleDateString() }}
            </span>
          </div>

          <!-- Media thumbnails -->
          <div v-if="bm.mediaUrls.length > 0" :class="['xbm-media-grid', { 'xbm-media-grid--video': bm.hasVideo }]">
            <img v-for="(url, i) in bm.mediaUrls" :key="i" :src="url" :class="['xbm-media-thumb', { 'xbm-media-thumb--video': bm.hasVideo }]" />
          </div>

          <!-- Video download -->
          <div v-if="bm.hasVideo" class="xbm-video-section">
            <!-- Downloading this tweet -->
            <template v-if="downloadTweetId === bm.tweetId && downloadStatus === 'downloading'">
              <span class="xbm-video-status downloading">
                <span class="xbm-spinner"></span> Downloading...
              </span>
            </template>
            <!-- Download completed for this tweet -->
            <template v-else-if="downloadTweetId === bm.tweetId && downloadStatus === 'done'">
              <span class="xbm-video-status done" @click.stop="clearDownloadStatus()">
                Downloaded &#10003;
              </span>
            </template>
            <!-- Download error for this tweet -->
            <template v-else-if="downloadTweetId === bm.tweetId && downloadStatus === 'error'">
              <div class="xbm-video-error-wrap">
                <div class="xbm-video-error-msg">Failed: {{ downloadError }}</div>
                <button class="xbm-video-btn" @click.stop="downloadVideo(bm.tweetUrl)">Retry</button>
              </div>
            </template>
            <!-- Default: download button -->
            <template v-else>
              <button
                class="xbm-video-btn"
                :disabled="downloadStatus === 'downloading'"
                @click.stop="downloadVideo(bm.tweetUrl)"
              >
                Download Video
              </button>
            </template>
            <button class="xbm-copy-url-btn" @click.stop="copyTweetUrl(bm.tweetUrl)" title="Copy tweet URL">
              <svg width="10" height="10" viewBox="0 0 16 16" fill="none"><path d="M4 4H2v10h10v-2M6 2h8v8H6z" stroke="currentColor" stroke-width="1.3"/></svg>
            </button>
          </div>

          <!-- Tags + Actions row -->
          <div class="xbm-detail-tags-actions">
            <div class="xbm-detail-tags">
              <span v-for="tag in bm.tags" :key="tag" class="xbm-tag-pill removable" @click.stop="removeTag(bm.tweetId, tag)">
                {{ tag }} &times;
              </span>
              <input
                v-model="tagInput"
                class="xbm-tag-input"
                placeholder="Add tag..."
                @keydown.stop="handleTagKeydown($event, bm.tweetId)"
                @click.stop
              />
            </div>
            <div class="xbm-detail-actions">
              <!-- Ingest button -->
              <template v-if="ingestingTweetId === bm.tweetId">
                <span class="xbm-ingest-status"><span class="xbm-spinner"></span></span>
              </template>
              <template v-else-if="bm.ingestedAt">
                <span class="xbm-ingested-badge" :title="'Ingested ' + new Date(bm.ingestedAt).toLocaleDateString()">SAVED</span>
              </template>
              <template v-else>
                <button
                  class="xbm-ingest-btn"
                  @click.stop="ingestBookmark(bm.tweetId)"
                  title="Download images, video & metadata to local folder"
                >Ingest</button>
              </template>

              <button class="xbm-link-btn" @click.stop="openInBackground(bm.tweetUrl)">Open on X</button>
              <button
                v-if="!bm.archived"
                class="xbm-archive-btn"
                @click.stop="archiveBookmark(bm.tweetId)"
              >Archive</button>
              <button
                v-else
                class="xbm-unarchive-btn"
                @click.stop="unarchiveBookmark(bm.tweetId)"
              >Unarchive</button>
            </div>
          </div>

          <!-- Notes -->
          <textarea
            class="xbm-notes"
            :value="bm.notes"
            placeholder="Add notes..."
            @change="updateNotes(bm.tweetId, ($event.target as HTMLTextAreaElement).value)"
            @click.stop
          ></textarea>
        </div>
      </div>

      <!-- Infinite scroll sentinel -->
      <div ref="sentinel" class="xbm-sentinel">
        <div v-if="loadingMore" class="xbm-loading-more">
          <span class="xbm-spinner"></span>
        </div>
      </div>
    </div>

    <!-- Ingestion settings dialog -->
    <IngestionSettingsDialog
      v-if="showIngestionSettings"
      @close="showIngestionSettings = false"
      @ingest-all="ingestAll"
    />
  </div>
</template>

<style scoped>
.xbm-container {
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow: hidden;
}

/* -- Header -- */
.xbm-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  background: var(--bg-card);
  border-bottom: 1px solid var(--border-warm);
  flex-shrink: 0;
}

.xbm-sync-btn {
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 4px 12px;
  background: var(--accent-green);
  color: #fff;
  border: none;
  border-radius: 4px;
  font-size: 11px;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.15s;
  flex-shrink: 0;
}

.xbm-sync-btn:hover:not(:disabled) {
  filter: brightness(1.1);
}

.xbm-sync-btn:disabled {
  opacity: 0.7;
  cursor: default;
}

.xbm-sync-btn.syncing {
  background: var(--accent-amber);
}

.xbm-stats {
  display: flex;
  gap: 8px;
  flex: 1;
}

.xbm-stat {
  font-size: 10px;
  font-family: var(--font-mono);
  color: var(--text-muted);
}

.xbm-stat-count {
  background: rgba(5, 150, 105, 0.1);
  padding: 1px 6px;
  border-radius: 8px;
  color: var(--accent-green);
  font-weight: 600;
}

.xbm-export-btns {
  display: flex;
  gap: 4px;
}

.xbm-icon-btn {
  display: flex;
  align-items: center;
  gap: 3px;
  padding: 3px 8px;
  background: var(--bg-alt);
  border: 1px solid var(--border-light);
  border-radius: 3px;
  cursor: pointer;
  font-size: 10px;
  color: var(--text-secondary);
  transition: all 0.12s;
}

.xbm-icon-btn:hover {
  background: var(--accent-green);
  color: #fff;
  border-color: var(--accent-green);
}

.xbm-icon-label {
  font-family: var(--font-mono);
  font-weight: 600;
}

/* -- Status -- */
.xbm-status {
  padding: 4px 12px;
  font-size: 10px;
  font-family: var(--font-mono);
  color: var(--accent-green);
  background: rgba(5, 150, 105, 0.06);
  text-align: center;
}

/* -- Search bar -- */
.xbm-filter-bar {
  display: flex;
  align-items: center;
  padding: 6px 12px;
  background: var(--bg-page);
  border-bottom: 1px solid var(--border-light);
  flex-shrink: 0;
}

.xbm-search {
  flex: 1;
  padding: 4px 8px;
  border: 1px solid var(--border-light);
  border-radius: 3px;
  font-size: 11px;
  background: var(--bg-card);
  color: var(--text-primary);
  outline: none;
}

.xbm-search:focus {
  border-color: var(--accent-green);
}

/* -- Instrument bar -- */
.xbm-instrument-bar {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 12px;
  background: var(--bg-page);
  border-bottom: 1px solid var(--border-light);
  flex-shrink: 0;
}

.xbm-readout {
  font-size: 10px;
  font-family: var(--font-mono);
  font-weight: 700;
  color: var(--text-muted);
  letter-spacing: 0.04em;
  flex-shrink: 0;
}

.xbm-readout-sep {
  color: var(--border-warm);
  margin: 0 1px;
}

.xbm-bar-divider {
  width: 1px;
  height: 16px;
  background: var(--border-warm);
  flex-shrink: 0;
}

/* Segmented sort group */
.xbm-seg-group {
  display: flex;
  border: 1px solid var(--border-light);
  border-radius: 3px;
  overflow: hidden;
  flex-shrink: 0;
}

.xbm-seg-btn {
  padding: 2px 8px;
  background: var(--bg-card);
  border: none;
  border-right: 1px solid var(--border-light);
  cursor: pointer;
  font-family: var(--font-mono);
  font-size: 9px;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--text-secondary);
  transition: all 0.12s;
  line-height: 18px;
}

.xbm-seg-btn:last-child {
  border-right: none;
}

.xbm-seg-btn:hover:not(.active) {
  background: var(--bg-alt);
  color: var(--text-primary);
}

.xbm-seg-btn.active {
  background: var(--accent-green);
  color: #fff;
}

.xbm-seg-dir {
  font-size: 8px;
  padding: 2px 6px;
  letter-spacing: 0;
}

/* Filter toggle group */
.xbm-toggle-group {
  display: flex;
  gap: 3px;
  flex-shrink: 0;
}

.xbm-toggle-btn {
  padding: 2px 6px;
  background: transparent;
  border: 1px solid var(--border-light);
  border-radius: 3px;
  cursor: pointer;
  font-family: var(--font-mono);
  font-size: 9px;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--text-muted);
  transition: all 0.12s;
  line-height: 18px;
}

.xbm-toggle-btn:hover:not(.active) {
  color: var(--text-secondary);
  border-color: var(--text-muted);
}

.xbm-toggle-btn.active {
  color: var(--accent-green);
  border-color: var(--accent-green);
  background: rgba(5, 150, 105, 0.08);
}

/* ARCH toggle: amber variant */
.xbm-toggle-arch.active {
  color: var(--accent-amber);
  border-color: var(--accent-amber);
  background: rgba(217, 119, 6, 0.08);
}

/* Reset button */
.xbm-reset {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  padding: 0;
  background: transparent;
  border: none;
  cursor: pointer;
  color: var(--text-secondary);
  transition: all 0.12s;
  flex-shrink: 0;
}

.xbm-reset:hover:not(.disabled) {
  color: var(--accent-green);
}

.xbm-reset.disabled {
  opacity: 0.3;
  cursor: default;
}

/* -- Loading & Empty -- */
.xbm-loading, .xbm-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 40px 20px;
  gap: 8px;
  color: var(--text-muted);
  font-size: 12px;
  flex: 1;
}

.xbm-empty-hint {
  font-size: 11px;
  color: var(--text-muted);
  text-align: center;
}

.xbm-empty-hint strong {
  color: var(--text-secondary);
}

.xbm-clear-filters-btn {
  padding: 4px 12px;
  background: var(--bg-alt);
  border: 1px solid var(--border-light);
  border-radius: 3px;
  cursor: pointer;
  font-size: 11px;
  color: var(--text-secondary);
  transition: all 0.12s;
}

.xbm-clear-filters-btn:hover {
  border-color: var(--accent-green);
  color: var(--accent-green);
}

/* -- Spinner -- */
.xbm-spinner {
  display: inline-block;
  width: 12px;
  height: 12px;
  border: 2px solid var(--border-light);
  border-top-color: var(--accent-green);
  border-radius: 50%;
  animation: xbm-spin 0.7s linear infinite;
}

@keyframes xbm-spin {
  to { transform: rotate(360deg); }
}

/* -- Bookmark list -- */
.xbm-list {
  flex: 1;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
}

.xbm-list::-webkit-scrollbar {
  width: 6px;
}

.xbm-list::-webkit-scrollbar-track {
  background: var(--bg-alt);
}

.xbm-list::-webkit-scrollbar-thumb {
  background: var(--border-warm);
  border-radius: 3px;
}

/* -- Bookmark card -- */
.xbm-card {
  border-bottom: 1px solid var(--border-light);
}

.xbm-card.expanded {
  background: var(--bg-card);
}

.xbm-card.expanded .xbm-row-text {
  display: none;
}

/* -- Collapsed row -- */
.xbm-row {
  display: flex;
  align-items: flex-start;
  gap: 7px;
  padding: 6px 12px;
  cursor: pointer;
  transition: background 0.1s;
}

.xbm-row:hover {
  background: var(--bg-alt);
}

.xbm-avatar {
  width: 24px;
  height: 24px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #fff;
  font-size: 10px;
  font-weight: 700;
  flex-shrink: 0;
  margin-top: 1px;
}

.xbm-row-content {
  flex: 1;
  min-width: 0;
  overflow: hidden;
}

.xbm-row-top {
  display: flex;
  align-items: baseline;
  gap: 4px;
  margin-bottom: 1px;
}

.xbm-author-name {
  font-size: 11px;
  font-weight: 700;
  color: var(--text-primary);
  text-transform: uppercase;
  letter-spacing: 0.03em;
}

.xbm-author-handle {
  font-size: 9.5px;
  font-family: var(--font-mono);
  color: var(--accent-green);
  white-space: nowrap;
  font-weight: 600;
}

.xbm-tweet-age {
  font-size: 9.5px;
  font-family: var(--font-mono);
  font-weight: 700;
  color: var(--accent-amber);
  margin-left: auto;
  flex-shrink: 0;
}

.xbm-row-text {
  font-size: 11px;
  color: #4A4A4A;
  overflow: hidden;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  line-height: 1.35;
  letter-spacing: 0.01em;
  padding-left: 7px;
  border-left: 2px solid rgba(5, 150, 105, 0.2);
  margin-top: 2px;
}

.xbm-row-meta {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 3px;
  flex-shrink: 0;
  padding-top: 2px;
}

.xbm-media-badge {
  display: flex;
  align-items: center;
  gap: 2px;
  font-size: 9px;
  color: var(--text-muted);
}

.xbm-tag-pill {
  font-size: 9px;
  background: rgba(5, 150, 105, 0.12);
  color: var(--accent-green);
  padding: 1px 5px;
  border-radius: 6px;
  border: 1px solid rgba(5, 150, 105, 0.25);
  white-space: nowrap;
}

.xbm-tag-pill.removable {
  cursor: pointer;
}

.xbm-tag-pill.removable:hover {
  background: rgba(220, 38, 38, 0.1);
  color: var(--accent-red);
  border-color: rgba(220, 38, 38, 0.3);
}

.xbm-tag-overflow {
  font-size: 9px;
  color: var(--text-muted);
}

/* -- Expanded detail -- */
.xbm-detail {
  padding: 0 12px 6px 43px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.xbm-detail-text {
  font-size: 11.5px;
  color: #1A1A1A;
  line-height: 1.3;
  word-break: break-word;
  letter-spacing: 0.01em;
  padding: 5px 9px;
  background: rgba(245, 244, 238, 0.6);
  border-left: 3px solid var(--accent-green);
  border-radius: 0 3px 3px 0;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
}

/* Tweet text inline highlights */
.xbm-detail-text :deep(.xbm-mention) {
  color: var(--accent-green);
  font-weight: 600;
  font-family: var(--font-mono);
  font-size: 0.92em;
}

.xbm-detail-text :deep(.xbm-url) {
  color: var(--accent-amber);
  font-family: var(--font-mono);
  font-size: 0.88em;
  word-break: break-all;
}

.xbm-detail-text :deep(.xbm-hashtag) {
  color: var(--accent-green);
  font-weight: 500;
}

/* Same highlights for collapsed preview */
.xbm-row-text :deep(.xbm-mention) {
  color: var(--accent-green);
  font-weight: 600;
  font-size: 0.92em;
}

.xbm-row-text :deep(.xbm-url) {
  color: var(--accent-amber);
  font-size: 0.9em;
}

.xbm-row-text :deep(.xbm-hashtag) {
  color: var(--accent-green);
}

.xbm-detail-timestamps {
  display: flex;
  gap: 10px;
  font-size: 8.5px;
  font-family: var(--font-mono);
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.xbm-detail-timestamps span {
  display: flex;
  align-items: center;
  gap: 3px;
}

.xbm-media-grid {
  display: flex;
  gap: 4px;
  flex-wrap: wrap;
}

.xbm-media-thumb {
  width: 52px;
  height: 38px;
  object-fit: cover;
  border-radius: 3px;
  border: 1px solid var(--border-light);
  cursor: pointer;
}

.xbm-media-thumb--video {
  width: 200px;
  height: 150px;
  border-radius: 4px;
}

.xbm-video-section {
  display: flex;
  align-items: center;
  gap: 6px;
}

.xbm-video-btn {
  padding: 2px 8px;
  background: var(--bg-alt);
  border: 1px solid var(--border-light);
  border-radius: 3px;
  cursor: pointer;
  font-size: 9px;
  font-family: var(--font-mono);
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: #3D3D3D;
  transition: all 0.12s;
}

.xbm-video-btn:hover:not(:disabled) {
  background: var(--accent-green);
  color: #fff;
  border-color: var(--accent-green);
}

.xbm-video-btn:disabled {
  opacity: 0.5;
  cursor: default;
}

.xbm-copy-url-btn {
  padding: 3px 5px;
  background: none;
  border: 1px solid var(--border-light);
  border-radius: 3px;
  cursor: pointer;
  color: var(--text-muted);
  transition: all 0.12s;
  display: flex;
  align-items: center;
}

.xbm-copy-url-btn:hover {
  color: var(--accent-green);
  border-color: var(--accent-green);
}

.xbm-video-status {
  font-size: 10px;
  font-family: var(--font-mono);
  display: flex;
  align-items: center;
  gap: 4px;
}

.xbm-video-status.downloading {
  color: var(--accent-amber);
}

.xbm-video-status.done {
  color: var(--accent-green);
  cursor: pointer;
}

.xbm-video-status.error {
  color: var(--accent-red);
  font-size: 9px;
  max-width: 200px;
}

.xbm-video-error-wrap {
  display: flex;
  flex-direction: column;
  gap: 4px;
  width: 100%;
}

.xbm-video-error-msg {
  font-size: 10px;
  font-family: var(--font-mono);
  color: var(--accent-red);
  word-break: break-word;
  line-height: 1.4;
  padding: 4px 6px;
  background: rgba(220, 38, 38, 0.06);
  border-radius: 3px;
  border: 1px solid rgba(220, 38, 38, 0.15);
}

.xbm-detail-tags-actions {
  display: flex;
  align-items: center;
  gap: 6px;
}

.xbm-detail-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 3px;
  align-items: center;
  flex: 1;
  min-width: 0;
}

.xbm-tag-input {
  padding: 1px 5px;
  border: 1px dashed var(--border-light);
  border-radius: 3px;
  font-size: 9px;
  font-family: var(--font-mono);
  width: 70px;
  background: transparent;
  color: #1A1A1A;
  outline: none;
}

.xbm-tag-input:focus {
  border-color: var(--accent-green);
}

.xbm-notes {
  width: 100%;
  min-height: 26px;
  max-height: 52px;
  padding: 3px 7px;
  border: 1px solid var(--border-light);
  border-radius: 3px;
  font-size: 10px;
  font-family: var(--font-mono);
  color: #1A1A1A;
  background: var(--bg-page);
  resize: vertical;
  outline: none;
}

.xbm-notes:focus {
  border-color: var(--accent-green);
}

.xbm-detail-actions {
  display: flex;
  gap: 4px;
  align-items: center;
  flex-shrink: 0;
}

.xbm-link-btn {
  font-size: 9px;
  font-family: var(--font-mono);
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--accent-green);
  text-decoration: none;
  padding: 2px 7px;
  border: 1px solid var(--accent-green);
  border-radius: 3px;
  transition: all 0.12s;
  cursor: pointer;
  background: none;
}

.xbm-link-btn:hover {
  background: var(--accent-green);
  color: #fff;
}

.xbm-archive-btn {
  font-size: 9px;
  font-family: var(--font-mono);
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--accent-red);
  padding: 2px 7px;
  border: 1px solid rgba(220, 38, 38, 0.3);
  border-radius: 3px;
  background: none;
  cursor: pointer;
  transition: all 0.12s;
}

.xbm-archive-btn:hover {
  background: var(--accent-red);
  color: #fff;
}

.xbm-unarchive-btn {
  font-size: 9px;
  font-family: var(--font-mono);
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--accent-amber);
  padding: 2px 7px;
  border: 1px solid rgba(217, 119, 6, 0.3);
  border-radius: 3px;
  background: none;
  cursor: pointer;
  transition: all 0.12s;
}

.xbm-unarchive-btn:hover {
  background: var(--accent-amber);
  color: #fff;
}

/* -- Infinite scroll sentinel -- */
.xbm-sentinel {
  min-height: 1px;
  flex-shrink: 0;
}

.xbm-loading-more {
  display: flex;
  justify-content: center;
  padding: 12px;
}

/* -- Ingestion progress bar -- */
.xbm-ingestion-bar {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 12px;
  font-size: 10px;
  font-family: var(--font-mono);
  color: var(--accent-amber);
  background: rgba(217, 119, 6, 0.06);
  text-align: center;
  justify-content: center;
  flex-shrink: 0;
}

.xbm-ingestion-done {
  color: var(--accent-green);
  background: rgba(5, 150, 105, 0.06);
  cursor: pointer;
}

/* -- Ingest button in detail actions -- */
.xbm-ingest-btn {
  font-size: 9px;
  font-family: var(--font-mono);
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--accent-amber);
  padding: 2px 7px;
  border: 1px solid rgba(217, 119, 6, 0.4);
  border-radius: 3px;
  background: none;
  cursor: pointer;
  transition: all 0.12s;
}

.xbm-ingest-btn:hover {
  background: var(--accent-amber);
  color: #fff;
}

.xbm-ingested-badge {
  font-size: 8px;
  font-family: var(--font-mono);
  font-weight: 700;
  letter-spacing: 0.06em;
  color: var(--accent-green);
  background: rgba(5, 150, 105, 0.1);
  padding: 2px 6px;
  border-radius: 3px;
  border: 1px solid rgba(5, 150, 105, 0.25);
}

.xbm-ingest-status {
  display: flex;
  align-items: center;
}
</style>
