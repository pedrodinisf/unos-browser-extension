<script setup lang="ts">
import { ref, onMounted, onUnmounted, computed } from 'vue';
import type { TrackedTab, TrackedWindow } from '../../src/db/types';
import MetadataPanel from './components/MetadataPanel.vue';
import ExportDialog from './components/ExportDialog.vue';
import UrlGrepperDialog from './components/UrlGrepperDialog.vue';
import ScrollCaptureDialog from './components/ScrollCaptureDialog.vue';
import DebugPanel from './components/DebugPanel.vue';
import AllWindowsView from './components/AllWindowsView.vue';
import XBookmarksView from './components/XBookmarksView.vue';

// State
const currentTab = ref<TrackedTab | null>(null);
const tabs = ref<TrackedTab[]>([]);
const windows = ref<TrackedWindow[]>([]);
const loading = ref(true);
const error = ref<string | null>(null);
const showMetadataPanel = ref(false);
const showExportDialog = ref(false);
const showUrlGrepperDialog = ref(false);
const showScrollCaptureDialog = ref(false);
const activeView = ref<'recent' | 'windows' | 'xbookmarks' | 'debug'>('xbookmarks');
const chromeMemoryMB = ref<number | null>(null);

// View refs for reset
const xBookmarksRef = ref<InstanceType<typeof XBookmarksView> | null>(null);
const recentSectionRef = ref<HTMLElement | null>(null);
const windowsRef = ref<InstanceType<typeof AllWindowsView> | null>(null);
const debugRef = ref<InstanceType<typeof DebugPanel> | null>(null);

type ViewName = 'recent' | 'windows' | 'xbookmarks' | 'debug';

function switchView(view: ViewName) {
  if (activeView.value === view) {
    // Already on this tab — reset the view
    resetView(view);
  } else {
    activeView.value = view;
  }
}

function resetView(view: ViewName) {
  switch (view) {
    case 'xbookmarks':
      xBookmarksRef.value?.reset?.();
      break;
    case 'recent':
      recentSectionRef.value?.scrollTo(0, 0);
      break;
    case 'windows':
      windowsRef.value?.reset?.();
      break;
    case 'debug':
      debugRef.value?.reset?.();
      break;
  }
}

// Tweet page detection state
const isTweetPage = ref(false);
const tweetHasVideo = ref(false);
const tweetIsBookmarked = ref(false);
const tweetUrl = ref('');
const tweetDownloadStatus = ref<'idle' | 'downloading' | 'done' | 'error'>('idle');
const tweetDownloadError = ref('');

// Fetch Chrome RAM usage
async function loadMemory() {
  try {
    // Try per-process memory via chrome.processes (most accurate for Chrome RAM)
    if (chrome.processes?.getProcessInfo) {
      const processes: Record<number, chrome.processes.Process> = await new Promise((resolve) => {
        chrome.processes.getProcessInfo([], true, resolve);
      });
      let totalBytes = 0;
      for (const proc of Object.values(processes)) {
        totalBytes += proc.privateMemory || 0;
      }
      if (totalBytes > 0) {
        chromeMemoryMB.value = Math.round(totalBytes / (1024 * 1024));
        return;
      }
    }
  } catch { /* processes API not available, fall through */ }

  try {
    // Fallback: system memory (total - available = used by all apps)
    if (chrome.system?.memory?.getInfo) {
      const info = await chrome.system.memory.getInfo();
      const usedBytes = info.capacity - info.availableCapacity;
      chromeMemoryMB.value = Math.round(usedBytes / (1024 * 1024));
    }
  } catch { /* ignore */ }
}

function formatMemory(mb: number): string {
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
  return `${mb} MB`;
}

// Computed
const tabCount = computed(() => tabs.value.filter(t => !t.closedAt).length);
const windowCount = computed(() => windows.value.filter(w => !w.closedAt).length);
const totalActiveTime = computed(() => {
  const totalMs = tabs.value.reduce((sum, t) => sum + (t.totalActiveTime || 0), 0);
  const minutes = Math.floor(totalMs / 60000);
  const hours = Math.floor(minutes / 60);
  if (hours > 0) {
    return `${hours}h ${minutes % 60}m`;
  }
  return `${minutes}m`;
});
const recentTabs = computed(() => {
  return tabs.value
    .filter(t => !t.closedAt)
    .sort((a, b) => (b.lastActivatedAt || b.createdAt) - (a.lastActivatedAt || a.createdAt))
    .slice(0, 30);
});

// Helpers
function getDomain(url: string): string {
  try {
    return new URL(url).hostname.replace('www.', '');
  } catch {
    return url;
  }
}

function formatUTCTime(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false }) + ' UTC';
}

function formatDuration(ms: number): string {
  const minutes = Math.floor(ms / 60000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h${minutes % 60}m`;
}

// API helpers
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

// Detect if active tab is an X/Twitter tweet with video + bookmark status
async function checkTweetPage() {
  isTweetPage.value = false;
  tweetHasVideo.value = false;
  tweetIsBookmarked.value = false;
  tweetUrl.value = '';

  // Get the actual active Chrome tab
  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!activeTab?.id || !activeTab.url) return;

  const match = activeTab.url.match(/^https:\/\/(x\.com|twitter\.com)\/[^/]+\/status\/\d+/);
  if (!match) return;

  isTweetPage.value = true;
  tweetUrl.value = activeTab.url.split('?')[0];

  try {
    const [result] = await chrome.scripting.executeScript({
      target: { tabId: activeTab.id },
      func: () => {
        const hasVideo = !!document.querySelector('video') ||
                         !!document.querySelector('[data-testid="videoPlayer"]');
        const isBookmarked = !!document.querySelector('[data-testid="removeBookmark"]');
        return { hasVideo, isBookmarked };
      },
    });
    if (result?.result) {
      tweetHasVideo.value = result.result.hasVideo;
      tweetIsBookmarked.value = result.result.isBookmarked;
    }
  } catch {
    // Content script injection failed (e.g. page not fully loaded)
  }
}

// Download video from current tweet
async function downloadCurrentTweetVideo() {
  if (!tweetUrl.value || tweetDownloadStatus.value === 'downloading') return;
  try {
    tweetDownloadStatus.value = 'downloading';
    tweetDownloadError.value = '';
    await sendMessage({ type: 'X_DOWNLOAD_VIDEO', tweetUrl: tweetUrl.value });
  } catch (err) {
    tweetDownloadStatus.value = 'error';
    tweetDownloadError.value = err instanceof Error ? err.message : String(err);
  }
}

// Monitor download progress for the toolbar button
function onDownloadStorageChanged(changes: Record<string, chrome.storage.StorageChange>, area: string) {
  if (area !== 'local') return;
  if (changes.xBookmarks_downloadStatus) {
    const status = changes.xBookmarks_downloadStatus.newValue;
    if (status === 'done' || status === 'error' || status === 'idle') {
      tweetDownloadStatus.value = status;
    }
  }
  if (changes.xBookmarks_downloadError) {
    tweetDownloadError.value = changes.xBookmarks_downloadError.newValue || '';
  }
}

async function loadData() {
  try {
    // Only show loading spinner on initial load, not refreshes.
    // Setting loading=true unmounts AllWindowsView, losing scroll/drag state.
    if (!tabs.value.length && !windows.value.length) loading.value = true;
    error.value = null;

    // Load current tab
    try {
      currentTab.value = await sendMessage<TrackedTab>({ type: 'GET_CURRENT_TAB' });
    } catch {
      currentTab.value = null;
    }

    // Load all tabs in session
    tabs.value = await sendMessage<TrackedTab[]>({ type: 'GET_TABS_IN_SESSION' });

    // Load all windows in session
    windows.value = await sendMessage<TrackedWindow[]>({ type: 'GET_WINDOWS_IN_SESSION' });
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Failed to load data';
    console.error('Failed to load data:', err);
  } finally {
    loading.value = false;
  }
}

async function handleMetadataUpdate(data: { tags: string[]; notes: string }) {
  if (!currentTab.value) return;

  try {
    await sendMessage({
      type: 'UPDATE_TAB_METADATA',
      persistentId: currentTab.value.persistentId,
      tags: data.tags,
      notes: data.notes,
    });

    // Update local state
    currentTab.value = {
      ...currentTab.value,
      tags: data.tags,
      notes: data.notes,
    };

    showMetadataPanel.value = false;
  } catch (err) {
    console.error('Failed to update metadata:', err);
    alert('Failed to update metadata');
  }
}

async function handleSaveTab() {
  if (!currentTab.value) return;

  try {
    await sendMessage({
      type: 'SAVE_TAB',
      persistentId: currentTab.value.persistentId,
    });

    currentTab.value = {
      ...currentTab.value,
      isSaved: true,
    };
  } catch (err) {
    console.error('Failed to save tab:', err);
  }
}

async function switchToTab(tab: TrackedTab) {
  try {
    await sendMessage({
      type: 'SWITCH_TO_TAB',
      chromeTabId: tab.chromeTabId,
      chromeWindowId: tab.chromeWindowId,
    });
  } catch (err) {
    console.error('Failed to switch to tab:', err);
  }
}

async function closeTab(tab: TrackedTab, event: Event) {
  event.stopPropagation();
  try {
    await sendMessage({
      type: 'CLOSE_TAB',
      chromeTabId: tab.chromeTabId,
    });
    // Remove from local state
    tabs.value = tabs.value.filter(t => t.persistentId !== tab.persistentId);
  } catch (err) {
    console.error('Failed to close tab:', err);
  }
}

// Clipboard helpers
async function copyTitle() {
  if (!currentTab.value) return;
  await navigator.clipboard.writeText(currentTab.value.title || 'Untitled');
}

async function copyUrl() {
  if (!currentTab.value) return;
  await navigator.clipboard.writeText(currentTab.value.url);
}

// Auto-refresh when background reports data changes
let refreshTimeout: ReturnType<typeof setTimeout> | null = null;

function onBackgroundMessage(message: any) {
  if (message?.type === 'DATA_CHANGED') {
    // Debounce rapid changes (e.g. multiple tabs moved at once)
    if (refreshTimeout) clearTimeout(refreshTimeout);
    refreshTimeout = setTimeout(() => loadData(), 300);
  }
}

// Lifecycle
onMounted(() => {
  loadData();
  loadMemory();
  checkTweetPage();
  chrome.runtime.onMessage.addListener(onBackgroundMessage);
  chrome.storage.onChanged.addListener(onDownloadStorageChanged);
});

onUnmounted(() => {
  chrome.runtime.onMessage.removeListener(onBackgroundMessage);
  chrome.storage.onChanged.removeListener(onDownloadStorageChanged);
  if (refreshTimeout) clearTimeout(refreshTimeout);
});
</script>

<template>
  <div class="popup">
    <!-- Header -->
    <header class="header">
      <div class="header-left">
        <span class="logo">UNOS</span>
        <span class="version">v0.1</span>
        <span class="stat-pill">{{ tabCount }} tabs</span>
        <span class="stat-pill">{{ windowCount }} win</span>
        <span class="stat-pill">{{ totalActiveTime }}</span>
        <span v-if="chromeMemoryMB !== null" class="stat-pill">{{ formatMemory(chromeMemoryMB) }} RAM</span>
      </div>
      <div class="header-separator"></div>
      <div class="header-tools">
        <!-- Video download button: visible when on a bookmarked X tweet with video -->
        <button
          v-if="isTweetPage && tweetHasVideo && tweetIsBookmarked"
          class="tool-btn tool-btn-video"
          :class="{
            downloading: tweetDownloadStatus === 'downloading',
            done: tweetDownloadStatus === 'done',
            error: tweetDownloadStatus === 'error',
          }"
          :disabled="tweetDownloadStatus === 'downloading'"
          :title="tweetDownloadStatus === 'downloading' ? 'Downloading video...' :
                  tweetDownloadStatus === 'done' ? 'Download complete!' :
                  tweetDownloadStatus === 'error' ? `Error: ${tweetDownloadError}` :
                  'Download video from this tweet'"
          @click="downloadCurrentTweetVideo"
        >
          <!-- Spinner when downloading -->
          <span v-if="tweetDownloadStatus === 'downloading'" class="tool-spinner"></span>
          <!-- Checkmark when done -->
          <svg v-else-if="tweetDownloadStatus === 'done'" width="14" height="14" viewBox="0 0 16 16" fill="none">
            <path d="M3 8.5l3.5 3.5L13 4" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
          <!-- Download icon (default + error) -->
          <svg v-else width="14" height="14" viewBox="0 0 16 16" fill="none">
            <polygon points="6,1 10,1 10,7 13,7 8,13 3,7 6,7" fill="currentColor"/>
            <rect x="2" y="13.5" width="12" height="1.5" rx="0.5" fill="currentColor"/>
          </svg>
        </button>
        <button class="tool-btn" @click="showExportDialog = true" title="Export">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M8 1v9M8 1L4.5 4.5M8 1l3.5 3.5M2 11v2.5a1 1 0 001 1h10a1 1 0 001-1V11" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </button>
        <button class="tool-btn" @click="showUrlGrepperDialog = true" title="URL Grepper">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M2 3h12M2 6.5h8M2 10h10M2 13.5h6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
        </button>
        <button class="tool-btn" @click="showScrollCaptureDialog = true" title="Scroll Screenshot">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none"><rect x="2.5" y="1.5" width="11" height="13" rx="1.5" stroke="currentColor" stroke-width="1.3"/><path d="M5.5 5h5M5.5 8h5M5.5 11h3" stroke="currentColor" stroke-width="1" stroke-linecap="round" opacity="0.5"/><path d="M8 4v8M8 12l-2-2M8 12l2-2" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </button>
      </div>
    </header>

    <!-- Loading state -->
    <div v-if="loading" class="loading">
      <span class="spinner"></span>
      <p>Loading...</p>
    </div>

    <!-- Error state -->
    <div v-else-if="error" class="error-state">
      <p>{{ error }}</p>
      <button @click="loadData" class="btn btn-sm">Retry</button>
    </div>

    <!-- Main content -->
    <main v-else class="main">
      <!-- Current tab bar -->
      <div v-if="currentTab" class="current-tab-bar">
        <img
          v-if="currentTab.faviconUrl"
          :src="currentTab.faviconUrl"
          class="ctb-favicon"
          alt=""
        />
        <span v-else class="ctb-favicon-placeholder">&#9675;</span>
        <span class="ctb-title-group">
          <span class="ctb-title">{{ currentTab.title || 'Untitled' }}</span>
          <button class="ctb-copy" @click="copyTitle" title="Copy title">&#128203;</button>
          <button class="ctb-copy" @click="copyUrl" title="Copy URL">&#128279;</button>
        </span>
        <span class="ctb-domain">{{ getDomain(currentTab.url) }}</span>
        <span class="ctb-time">{{ formatDuration(currentTab.totalActiveTime || 0) }}</span>
        <span class="ctb-created">{{ formatUTCTime(currentTab.createdAt) }}</span>
        <span v-if="currentTab.tags && currentTab.tags.length > 0" class="ctb-tags">
          <span v-for="tag in currentTab.tags.slice(0, 3)" :key="tag" class="ctb-tag">{{ tag }}</span>
          <span v-if="currentTab.tags.length > 3" class="ctb-tag-overflow">+{{ currentTab.tags.length - 3 }}</span>
        </span>
        <button class="ctb-action" @click="showMetadataPanel = !showMetadataPanel" title="Edit tags/notes">+</button>
        <button
          v-if="!currentTab.isSaved"
          class="ctb-action"
          @click="handleSaveTab"
          title="Save tab"
        >Save</button>
        <span v-else class="ctb-saved">Saved</span>
      </div>

      <!-- Metadata panel overlay -->
      <div v-if="showMetadataPanel && currentTab" class="metadata-overlay">
        <MetadataPanel
          :tab="currentTab"
          @update="handleMetadataUpdate"
          @close="showMetadataPanel = false"
        />
      </div>

      <!-- View tabs (click to switch, double-click active tab to reset view) -->
      <div class="view-tabs">
        <button
          class="view-tab"
          :class="{ active: activeView === 'xbookmarks' }"
          @click="switchView('xbookmarks')"
        ><span class="view-tab-icon">&#x2715;</span>MARKS</button>
        <button
          class="view-tab"
          :class="{ active: activeView === 'recent' }"
          @click="switchView('recent')"
        ><span class="view-tab-icon">&#x25F7;</span>RECENT</button>
        <button
          class="view-tab"
          :class="{ active: activeView === 'windows' }"
          @click="switchView('windows')"
        ><span class="view-tab-icon">&#x2317;</span>WINDOWS</button>
        <button
          class="view-tab"
          :class="{ active: activeView === 'debug' }"
          @click="switchView('debug')"
        ><span class="view-tab-icon">&#x2699;</span>DIAG</button>
      </div>

      <!-- X Bookmarks View -->
      <XBookmarksView
        v-show="activeView === 'xbookmarks'"
        ref="xBookmarksRef"
        class="view-content"
      />

      <!-- Recent Tabs View -->
      <section v-show="activeView === 'recent'" ref="recentSectionRef" class="view-content">
        <div class="tabs-list">
          <div
            v-for="tab in recentTabs"
            :key="tab.persistentId"
            class="tab-row"
            :class="{ 'is-current': currentTab && tab.persistentId === currentTab.persistentId }"
            @dblclick="switchToTab(tab)"
            title="Double-click to switch"
          >
            <img
              v-if="tab.faviconUrl"
              :src="tab.faviconUrl"
              class="tab-row-favicon"
              alt=""
            />
            <span v-else class="tab-row-favicon-ph">&#9675;</span>
            <span class="tab-row-title">{{ tab.title || 'Untitled' }}</span>
            <span class="tab-row-domain">{{ getDomain(tab.url) }}</span>
            <span class="tab-row-time">{{ formatDuration(tab.totalActiveTime || 0) }}</span>
            <button
              class="tab-row-close"
              @click="closeTab(tab, $event)"
              title="Close tab"
            >&times;</button>
          </div>

          <div v-if="recentTabs.length === 0" class="empty-state">
            No tabs tracked yet
          </div>
        </div>
      </section>

      <!-- All Windows View -->
      <AllWindowsView
        v-show="activeView === 'windows'"
        ref="windowsRef"
        :windows="windows"
        :tabs="tabs"
        class="view-content"
        @dataChanged="loadData"
      />

      <!-- Debug Panel -->
      <DebugPanel
        v-show="activeView === 'debug'"
        ref="debugRef"
        class="view-content"
      />
    </main>

    <!-- Export dialog -->
    <ExportDialog
      v-if="showExportDialog"
      :windows="windows"
      @close="showExportDialog = false"
    />

    <!-- URL Grepper dialog -->
    <UrlGrepperDialog
      v-if="showUrlGrepperDialog"
      @close="showUrlGrepperDialog = false"
    />

    <!-- Scroll Capture dialog -->
    <ScrollCaptureDialog
      v-if="showScrollCaptureDialog"
      @close="showScrollCaptureDialog = false"
    />
  </div>
</template>

<style>
html, body {
  width: 700px;
  height: 600px;
  margin: 0;
  padding: 0;
}

* {
  margin: 0;
  padding: 0;
  box-sizing: border-box;
}

.popup {
  width: 700px;
  height: 600px;
  overflow: hidden;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  background: var(--bg-page);
  color: var(--text-primary);
  display: flex;
  flex-direction: column;

  /* Theme: Off-white + Green/Amber */
  --bg-page: #F5F4EE;
  --bg-card: #F5F5F0;
  --bg-alt: #EEEDE8;
  --bg-header: #2A3328;
  --bg-overlay: rgba(0, 0, 0, 0.5);

  --text-primary: #2D2D2D;
  --text-secondary: #555D66;
  --text-muted: #7B8490;
  --text-inverse: #F5F5F0;

  --accent-green: #059669;
  --accent-amber: #D97706;
  --accent-red: #DC2626;

  --border-light: #D1D5DB;
  --border-warm: #C9C5B8;

  --font-mono: 'Monaco', 'Menlo', 'Consolas', monospace;
}

/* ── Header ── */
.header {
  display: flex;
  align-items: center;
  padding: 0 16px;
  height: 44px;
  background: var(--bg-header);
  color: var(--text-inverse);
  flex-shrink: 0;
  gap: 12px;
}

.header-left {
  display: flex;
  align-items: center;
  gap: 10px;
}

.logo {
  font-size: 16px;
  font-weight: 700;
  letter-spacing: 1px;
  color: var(--text-inverse);
}

.version {
  font-size: 10px;
  color: var(--text-muted);
  font-weight: 500;
  margin-right: 2px;
}

.stat-pill {
  font-size: 11px;
  font-family: var(--font-mono);
  color: rgba(245, 245, 240, 0.8);
  background: rgba(255, 255, 255, 0.1);
  padding: 3px 10px;
  border-radius: 10px;
}

.header-separator {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
}

.header-separator::after {
  content: '';
  width: 1px;
  height: 22px;
  background: rgba(255, 255, 255, 0.15);
  border-radius: 1px;
}

.header-tools {
  display: flex;
  gap: 6px;
}

.tool-btn {
  width: 30px;
  height: 30px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(255, 255, 255, 0.07);
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 5px;
  cursor: pointer;
  color: rgba(245, 245, 240, 0.7);
  transition: all 0.15s;
}

.tool-btn:hover {
  background: rgba(5, 150, 105, 0.2);
  border-color: rgba(5, 150, 105, 0.45);
  color: var(--text-inverse);
}

.tool-btn-video {
  background: rgba(5, 150, 105, 0.25);
  border-color: rgba(5, 150, 105, 0.5);
  color: #4ade80;
}

.tool-btn-video:hover:not(:disabled) {
  background: rgba(5, 150, 105, 0.4);
  border-color: rgba(5, 150, 105, 0.7);
  color: #fff;
}

.tool-btn-video.downloading {
  background: rgba(217, 119, 6, 0.25);
  border-color: rgba(217, 119, 6, 0.5);
  color: #fbbf24;
  cursor: wait;
}

.tool-btn-video.done {
  background: rgba(5, 150, 105, 0.3);
  border-color: rgba(5, 150, 105, 0.6);
  color: #4ade80;
}

.tool-btn-video.error {
  background: rgba(220, 38, 38, 0.2);
  border-color: rgba(220, 38, 38, 0.4);
  color: #f87171;
}

.tool-spinner {
  display: inline-block;
  width: 12px;
  height: 12px;
  border: 2px solid rgba(255, 255, 255, 0.2);
  border-top-color: #fbbf24;
  border-radius: 50%;
  animation: spin 0.7s linear infinite;
}

/* ── Loading & Error ── */
.loading, .error-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 60px 20px;
  gap: 12px;
  color: var(--text-muted);
  flex: 1;
}

.spinner {
  width: 24px;
  height: 24px;
  border: 2px solid var(--border-light);
  border-top-color: var(--accent-green);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

.error-state {
  color: var(--accent-red);
}

/* ── Main ── */
.main {
  flex: 1;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  position: relative;
}

/* ── Current Tab Bar ── */
.current-tab-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 44px;
  padding: 0 12px;
  background: var(--bg-card);
  border-bottom: 1px solid var(--border-warm);
  flex-shrink: 0;
  overflow: hidden;
}

.ctb-favicon {
  width: 24px;
  height: 24px;
  border-radius: 4px;
  flex-shrink: 0;
}

.ctb-favicon-placeholder {
  width: 24px;
  height: 24px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 14px;
  color: var(--text-muted);
  flex-shrink: 0;
}

.ctb-title {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 180px;
  flex-shrink: 1;
}

.ctb-title-group {
  display: flex;
  align-items: center;
  gap: 2px;
  min-width: 0;
  flex-shrink: 1;
  overflow: hidden;
}

.ctb-copy {
  display: none;
  background: none;
  border: none;
  cursor: pointer;
  font-size: 11px;
  padding: 1px 3px;
  border-radius: 3px;
  color: var(--text-muted);
  flex-shrink: 0;
  transition: all 0.12s;
  line-height: 1;
}

.ctb-title-group:hover .ctb-copy {
  display: inline-flex;
}

.ctb-copy:hover {
  background: var(--bg-alt);
  color: var(--accent-green);
}

.ctb-domain {
  font-size: 11px;
  color: var(--text-secondary);
  white-space: nowrap;
  flex-shrink: 0;
}

.ctb-time {
  font-size: 11px;
  font-family: var(--font-mono);
  color: var(--accent-amber);
  flex-shrink: 0;
}

.ctb-created {
  font-size: 10px;
  font-family: var(--font-mono);
  color: var(--text-muted);
  flex-shrink: 0;
}

.ctb-tags {
  display: flex;
  gap: 4px;
  flex-shrink: 0;
}

.ctb-tag {
  font-size: 10px;
  background: rgba(5, 150, 105, 0.12);
  color: var(--accent-green);
  padding: 1px 6px;
  border-radius: 8px;
  border: 1px solid rgba(5, 150, 105, 0.25);
}

.ctb-tag-overflow {
  font-size: 10px;
  color: var(--text-muted);
}

.ctb-action {
  background: var(--bg-alt);
  border: 1px solid var(--border-light);
  padding: 2px 8px;
  border-radius: 4px;
  cursor: pointer;
  font-size: 11px;
  color: var(--text-secondary);
  transition: all 0.15s;
  flex-shrink: 0;
}

.ctb-action:hover {
  background: var(--accent-green);
  color: #fff;
  border-color: var(--accent-green);
}

.ctb-saved {
  font-size: 10px;
  color: var(--accent-green);
  font-weight: 600;
  flex-shrink: 0;
}

/* ── Metadata Overlay ── */
.metadata-overlay {
  position: absolute;
  top: 44px;
  right: 12px;
  width: 280px;
  z-index: 20;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.15);
  border-radius: 6px;
  overflow: hidden;
}

/* ── View Tabs ── */
.view-tabs {
  display: flex;
  height: 36px;
  border-bottom: 1px solid var(--border-light);
  background: var(--bg-card);
  flex-shrink: 0;
}

.view-tab {
  flex: 1;
  background: none;
  border: none;
  border-bottom: 2px solid transparent;
  padding: 0 12px;
  cursor: pointer;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 1.2px;
  font-family: var(--font-mono);
  color: var(--text-secondary);
  -webkit-font-smoothing: antialiased;
  transition: all 0.15s;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
}

.view-tab:hover {
  color: var(--text-primary);
  background: var(--bg-alt);
}

.view-tab.active {
  color: var(--accent-green);
  border-bottom-color: var(--accent-green);
  font-weight: 800;
}

.view-tab-icon {
  font-size: 12px;
  line-height: 1;
  opacity: 0.7;
}

.view-tab.active .view-tab-icon {
  opacity: 1;
}

/* ── View Content ── */
.view-content {
  flex: 1;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

/* ── Recent Tab Rows ── */
.tabs-list {
  display: flex;
  flex-direction: column;
  overflow-y: auto;
  flex: 1;
}

.tab-row {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 26px;
  min-height: 26px;
  padding: 0 12px;
  cursor: pointer;
  transition: background 0.1s;
  border-bottom: 1px solid transparent;
}

.tab-row:hover {
  background: var(--bg-alt);
}

.tab-row.is-current {
  background: rgba(5, 150, 105, 0.06);
  border-left: 2px solid var(--accent-green);
}

.tab-row-favicon {
  width: 16px;
  height: 16px;
  border-radius: 2px;
  flex-shrink: 0;
}

.tab-row-favicon-ph {
  width: 16px;
  height: 16px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 10px;
  color: var(--text-muted);
  flex-shrink: 0;
}

.tab-row-title {
  flex: 1;
  font-size: 12px;
  color: var(--text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  min-width: 0;
}

.tab-row-domain {
  font-size: 10px;
  color: var(--text-muted);
  white-space: nowrap;
  max-width: 120px;
  overflow: hidden;
  text-overflow: ellipsis;
  flex-shrink: 0;
}

.tab-row-time {
  font-size: 10px;
  font-family: var(--font-mono);
  color: var(--accent-amber);
  flex-shrink: 0;
  min-width: 28px;
  text-align: right;
}

.tab-row-close {
  opacity: 0;
  background: none;
  border: none;
  color: var(--text-muted);
  width: 18px;
  height: 18px;
  border-radius: 3px;
  cursor: pointer;
  font-size: 14px;
  line-height: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all 0.1s;
  flex-shrink: 0;
}

.tab-row:hover .tab-row-close {
  opacity: 1;
}

.tab-row-close:hover {
  background: rgba(220, 38, 38, 0.1);
  color: var(--accent-red);
}

.empty-state {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 40px 20px;
  font-size: 12px;
  color: var(--text-muted);
}

/* ── Buttons ── */
.btn {
  padding: 8px 16px;
  border: 1px solid var(--border-light);
  border-radius: 4px;
  background: var(--bg-card);
  color: var(--text-primary);
  cursor: pointer;
  font-size: 12px;
  transition: all 0.15s;
}

.btn:hover {
  background: var(--bg-alt);
}

.btn-sm {
  padding: 4px 10px;
  font-size: 11px;
}

/* ── Scrollbar ── */
.tabs-list::-webkit-scrollbar,
.view-content::-webkit-scrollbar {
  width: 6px;
}

.tabs-list::-webkit-scrollbar-track,
.view-content::-webkit-scrollbar-track {
  background: var(--bg-alt);
}

.tabs-list::-webkit-scrollbar-thumb,
.view-content::-webkit-scrollbar-thumb {
  background: var(--border-warm);
  border-radius: 3px;
}

.tabs-list::-webkit-scrollbar-thumb:hover,
.view-content::-webkit-scrollbar-thumb:hover {
  background: var(--text-muted);
}
</style>
