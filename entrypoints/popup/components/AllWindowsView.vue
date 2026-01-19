<script setup lang="ts">
import { ref, computed } from 'vue';
import type { TrackedWindow, TrackedTab } from '../../../src/db/types';

const props = defineProps<{
  windows: TrackedWindow[];
  tabs: TrackedTab[];
}>();

const emit = defineEmits<{
  error: [message: string];
  tabClosed: [persistentId: string];
}>();

// State
const collapsedWindows = ref<Set<string>>(new Set());
const sortBy = ref<'index' | 'title' | 'url' | 'time' | 'created'>('index');
const sortAsc = ref(true);
const searchQuery = ref('');
const debouncedSearch = ref('');
const draggedTab = ref<TrackedTab | null>(null);
const dragOverWindow = ref<string | null>(null);
const showCompact = ref(true);
const isLoading = ref(false);

// Debounce search for performance with 1000+ tabs
let searchTimeout: ReturnType<typeof setTimeout> | null = null;
function updateSearch(query: string) {
  searchQuery.value = query;
  if (searchTimeout) clearTimeout(searchTimeout);
  searchTimeout = setTimeout(() => {
    debouncedSearch.value = query;
  }, 150);
}

// API helper
async function sendMessage<T>(message: Record<string, unknown>): Promise<T> {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      if (!response?.success) {
        reject(new Error(response?.error || 'Unknown error'));
        return;
      }
      resolve(response.data as T);
    });
  });
}

// Computed
const openWindows = computed(() => {
  return props.windows
    .filter(w => !w.closedAt)
    .sort((a, b) => b.lastFocusedAt - a.lastFocusedAt);
});

const filteredTabs = computed(() => {
  const query = debouncedSearch.value.toLowerCase().trim();
  if (!query) return props.tabs;
  return props.tabs.filter(t =>
    !t.closedAt && (
      t.title?.toLowerCase().includes(query) ||
      t.url?.toLowerCase().includes(query)
    )
  );
});

function getTabsForWindow(windowPersistentId: string) {
  let windowTabs = filteredTabs.value
    .filter(t => t.windowPersistentId === windowPersistentId && !t.closedAt);

  // Sort tabs
  windowTabs = [...windowTabs].sort((a, b) => {
    let cmp = 0;
    switch (sortBy.value) {
      case 'index':
        cmp = (a.index || 0) - (b.index || 0);
        break;
      case 'title':
        cmp = (a.title || '').localeCompare(b.title || '');
        break;
      case 'url':
        cmp = (a.url || '').localeCompare(b.url || '');
        break;
      case 'time':
        cmp = (b.totalActiveTime || 0) - (a.totalActiveTime || 0);
        break;
      case 'created':
        cmp = b.createdAt - a.createdAt;
        break;
    }
    return sortAsc.value ? cmp : -cmp;
  });

  return windowTabs;
}

function getWindowTabCount(windowPersistentId: string) {
  return props.tabs.filter(t => t.windowPersistentId === windowPersistentId && !t.closedAt).length;
}

function toggleWindow(windowId: string) {
  if (collapsedWindows.value.has(windowId)) {
    collapsedWindows.value.delete(windowId);
  } else {
    collapsedWindows.value.add(windowId);
  }
  collapsedWindows.value = new Set(collapsedWindows.value);
}

function collapseAll() {
  collapsedWindows.value = new Set(openWindows.value.map(w => w.persistentId));
}

function expandAll() {
  collapsedWindows.value = new Set();
}

function toggleSort(field: typeof sortBy.value) {
  if (sortBy.value === field) {
    sortAsc.value = !sortAsc.value;
  } else {
    sortBy.value = field;
    sortAsc.value = true;
  }
}

// Actions
async function switchToTab(tab: TrackedTab) {
  if (isLoading.value) return;
  isLoading.value = true;
  try {
    await sendMessage({
      type: 'SWITCH_TO_TAB',
      chromeTabId: tab.chromeTabId,
      chromeWindowId: tab.chromeWindowId,
    });
    window.close();
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to switch tab';
    console.error('Failed to switch to tab:', err);
    emit('error', message);
  } finally {
    isLoading.value = false;
  }
}

async function closeTab(tab: TrackedTab, event: Event) {
  event.stopPropagation();
  if (isLoading.value) return;
  isLoading.value = true;
  try {
    await sendMessage({
      type: 'CLOSE_TAB',
      chromeTabId: tab.chromeTabId,
    });
    emit('tabClosed', tab.persistentId);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to close tab';
    console.error('Failed to close tab:', err);
    emit('error', message);
  } finally {
    isLoading.value = false;
  }
}

async function focusWindow(win: TrackedWindow) {
  if (isLoading.value) return;
  isLoading.value = true;
  try {
    await chrome.windows.update(win.chromeWindowId, { focused: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to focus window';
    console.error('Failed to focus window:', err);
    emit('error', message);
  } finally {
    isLoading.value = false;
  }
}

// Drag and drop
function onDragStart(event: DragEvent, tab: TrackedTab) {
  draggedTab.value = tab;
  if (event.dataTransfer) {
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', tab.persistentId);
  }
}

function onDragEnd() {
  draggedTab.value = null;
  dragOverWindow.value = null;
}

function onDragOver(event: DragEvent, windowId: string) {
  event.preventDefault();
  if (event.dataTransfer) {
    event.dataTransfer.dropEffect = 'move';
  }
  dragOverWindow.value = windowId;
}

function onDragLeave() {
  dragOverWindow.value = null;
}

async function onDrop(event: DragEvent, targetWindow: TrackedWindow) {
  event.preventDefault();
  dragOverWindow.value = null;

  if (!draggedTab.value) return;
  if (draggedTab.value.chromeWindowId === targetWindow.chromeWindowId) return;

  try {
    await sendMessage({
      type: 'MOVE_TAB_TO_WINDOW',
      chromeTabId: draggedTab.value.chromeTabId,
      targetWindowId: targetWindow.chromeWindowId,
    });
  } catch (err) {
    console.error('Failed to move tab:', err);
  }

  draggedTab.value = null;
}

function formatTime(ms: number) {
  const minutes = Math.floor(ms / 60000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h${minutes % 60}m`;
}

function getDomain(url: string) {
  try {
    return new URL(url).hostname.replace('www.', '');
  } catch {
    return url;
  }
}

// Total stats
const totalTabs = computed(() => props.tabs.filter(t => !t.closedAt).length);
</script>

<template>
  <div class="all-windows-view">
    <!-- Toolbar -->
    <div class="toolbar">
      <div class="toolbar-left">
        <input
          :value="searchQuery"
          @input="updateSearch(($event.target as HTMLInputElement).value)"
          type="text"
          class="search-input"
          placeholder="Search tabs..."
        />
      </div>
      <div class="toolbar-right">
        <button
          class="tool-btn"
          :class="{ active: showCompact }"
          @click="showCompact = !showCompact"
          title="Toggle compact view"
        >
          {{ showCompact ? '▤' : '▦' }}
        </button>
        <button class="tool-btn" @click="expandAll" title="Expand all">+</button>
        <button class="tool-btn" @click="collapseAll" title="Collapse all">−</button>
      </div>
    </div>

    <!-- Sort buttons -->
    <div class="sort-bar">
      <span class="sort-label">Sort:</span>
      <button
        v-for="s in (['index', 'title', 'url', 'time', 'created'] as const)"
        :key="s"
        class="sort-btn"
        :class="{ active: sortBy === s }"
        @click="toggleSort(s)"
      >
        {{ s === 'index' ? '#' : s === 'time' ? 'Active' : s.charAt(0).toUpperCase() + s.slice(1) }}
        <span v-if="sortBy === s" class="sort-dir">{{ sortAsc ? '↑' : '↓' }}</span>
      </button>
    </div>

    <!-- Stats -->
    <div class="stats-row">
      <span>{{ openWindows.length }} windows</span>
      <span>{{ totalTabs }} tabs</span>
      <span v-if="searchQuery">{{ filteredTabs.filter(t => !t.closedAt).length }} matching</span>
    </div>

    <!-- Windows list -->
    <div class="windows-container">
      <div
        v-for="win in openWindows"
        :key="win.persistentId"
        class="window-section"
        :class="{ 'drag-over': dragOverWindow === win.persistentId }"
        @dragover="onDragOver($event, win.persistentId)"
        @dragleave="onDragLeave"
        @drop="onDrop($event, win)"
      >
        <!-- Window header -->
        <div class="window-header" @click="toggleWindow(win.persistentId)">
          <span class="collapse-icon">{{ collapsedWindows.has(win.persistentId) ? '▶' : '▼' }}</span>
          <span class="window-id">W{{ win.chromeWindowId }}</span>
          <span class="window-count">{{ getWindowTabCount(win.persistentId) }} tabs</span>
          <span v-if="win.incognito" class="incognito-badge">🕶</span>
          <div class="window-actions">
            <button class="window-btn" @click.stop="focusWindow(win)" title="Focus window">↗</button>
          </div>
        </div>

        <!-- Tabs grid/list -->
        <div
          v-if="!collapsedWindows.has(win.persistentId)"
          class="tabs-container"
          :class="{ compact: showCompact }"
        >
          <div
            v-for="tab in getTabsForWindow(win.persistentId)"
            :key="tab.persistentId"
            class="tab-row"
            :class="{ dragging: draggedTab?.persistentId === tab.persistentId }"
            draggable="true"
            @dragstart="onDragStart($event, tab)"
            @dragend="onDragEnd"
            @click="switchToTab(tab)"
          >
            <span class="tab-idx">{{ tab.index + 1 }}</span>
            <img
              v-if="tab.faviconUrl"
              :src="tab.faviconUrl"
              class="tab-icon"
              alt=""
            />
            <span v-else class="tab-icon-placeholder">○</span>
            <span class="tab-title" :title="tab.title || ''">
              {{ tab.title || 'Untitled' }}
            </span>
            <span v-if="!showCompact" class="tab-domain">{{ getDomain(tab.url) }}</span>
            <span class="tab-time">{{ formatTime(tab.totalActiveTime || 0) }}</span>
            <span v-if="tab.isSaved" class="tab-badge saved">★</span>
            <span v-if="tab.tags?.length" class="tab-badge tags">{{ tab.tags.length }}</span>
            <button class="tab-close" @click="closeTab(tab, $event)" title="Close">×</button>
          </div>

          <div v-if="getTabsForWindow(win.persistentId).length === 0" class="empty-tabs">
            {{ searchQuery ? 'No matching tabs' : 'No tabs' }}
          </div>
        </div>
      </div>

      <div v-if="openWindows.length === 0" class="empty-state">
        No windows tracked
      </div>
    </div>
  </div>
</template>

<style scoped>
.all-windows-view {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: rgba(42, 42, 74, 0.6);
  border: 1px solid rgba(99, 102, 241, 0.2);
  border-radius: 12px;
  overflow: hidden;
}

.toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 12px;
  border-bottom: 1px solid rgba(99, 102, 241, 0.15);
  gap: 8px;
}

.toolbar-left {
  flex: 1;
}

.search-input {
  width: 100%;
  background: rgba(30, 30, 50, 0.8);
  border: 1px solid rgba(99, 102, 241, 0.2);
  border-radius: 6px;
  padding: 6px 10px;
  font-size: 12px;
  color: #ddd;
  outline: none;
}

.search-input:focus {
  border-color: rgba(99, 102, 241, 0.5);
}

.search-input::placeholder {
  color: #666;
}

.toolbar-right {
  display: flex;
  gap: 4px;
}

.tool-btn {
  background: rgba(58, 58, 90, 0.4);
  border: 1px solid rgba(99, 102, 241, 0.2);
  color: #888;
  padding: 4px 8px;
  border-radius: 4px;
  cursor: pointer;
  font-size: 12px;
  transition: all 0.15s;
}

.tool-btn:hover, .tool-btn.active {
  background: rgba(99, 102, 241, 0.3);
  color: #ddd;
}

.sort-bar {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 6px 12px;
  border-bottom: 1px solid rgba(99, 102, 241, 0.1);
  flex-wrap: wrap;
}

.sort-label {
  font-size: 10px;
  color: #666;
  text-transform: uppercase;
}

.sort-btn {
  background: none;
  border: none;
  color: #888;
  font-size: 10px;
  padding: 2px 6px;
  border-radius: 4px;
  cursor: pointer;
  transition: all 0.15s;
}

.sort-btn:hover {
  color: #ddd;
  background: rgba(99, 102, 241, 0.2);
}

.sort-btn.active {
  color: #6366f1;
  background: rgba(99, 102, 241, 0.15);
}

.sort-dir {
  margin-left: 2px;
  font-size: 9px;
}

.stats-row {
  display: flex;
  gap: 12px;
  padding: 4px 12px;
  font-size: 10px;
  color: #666;
  border-bottom: 1px solid rgba(99, 102, 241, 0.1);
}

.windows-container {
  flex: 1;
  overflow-y: auto;
  overflow-x: hidden;
}

.window-section {
  border-bottom: 1px solid rgba(99, 102, 241, 0.1);
}

.window-section.drag-over {
  background: rgba(99, 102, 241, 0.1);
}

.window-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  background: rgba(58, 58, 90, 0.3);
  cursor: pointer;
  user-select: none;
  transition: background 0.15s;
}

.window-header:hover {
  background: rgba(58, 58, 90, 0.5);
}

.collapse-icon {
  font-size: 10px;
  color: #666;
  width: 12px;
}

.window-id {
  font-size: 11px;
  font-weight: 600;
  color: #6366f1;
}

.window-count {
  font-size: 10px;
  color: #888;
  background: rgba(99, 102, 241, 0.15);
  padding: 1px 6px;
  border-radius: 8px;
}

.incognito-badge {
  font-size: 12px;
}

.window-actions {
  margin-left: auto;
  display: flex;
  gap: 4px;
}

.window-btn {
  background: rgba(99, 102, 241, 0.2);
  border: none;
  color: #888;
  padding: 2px 6px;
  border-radius: 4px;
  cursor: pointer;
  font-size: 11px;
  transition: all 0.15s;
}

.window-btn:hover {
  background: rgba(99, 102, 241, 0.4);
  color: #ddd;
}

.tabs-container {
  display: flex;
  flex-direction: column;
}

.tab-row {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 12px 4px 24px;
  cursor: pointer;
  transition: background 0.1s;
  min-height: 28px;
}

.tab-row:hover {
  background: rgba(99, 102, 241, 0.1);
}

.tab-row.dragging {
  opacity: 0.5;
}

.tab-idx {
  font-size: 9px;
  color: #555;
  width: 18px;
  text-align: right;
  flex-shrink: 0;
}

.tab-icon {
  width: 14px;
  height: 14px;
  border-radius: 2px;
  flex-shrink: 0;
}

.tab-icon-placeholder {
  width: 14px;
  height: 14px;
  font-size: 10px;
  color: #555;
  text-align: center;
  flex-shrink: 0;
}

.tab-title {
  flex: 1;
  font-size: 11px;
  color: #ccc;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  min-width: 0;
}

.tab-domain {
  font-size: 9px;
  color: #666;
  white-space: nowrap;
  max-width: 80px;
  overflow: hidden;
  text-overflow: ellipsis;
  flex-shrink: 0;
}

.tab-time {
  font-size: 9px;
  color: #666;
  flex-shrink: 0;
  width: 32px;
  text-align: right;
}

.tab-badge {
  font-size: 9px;
  padding: 0 4px;
  border-radius: 4px;
  flex-shrink: 0;
}

.tab-badge.saved {
  color: #fbbf24;
}

.tab-badge.tags {
  background: rgba(99, 102, 241, 0.2);
  color: #6366f1;
}

.tab-close {
  opacity: 0;
  background: none;
  border: none;
  color: #888;
  font-size: 14px;
  padding: 0 4px;
  cursor: pointer;
  transition: all 0.1s;
  flex-shrink: 0;
}

.tab-row:hover .tab-close {
  opacity: 1;
}

.tab-close:hover {
  color: #ef4444;
}

.tabs-container.compact .tab-row {
  padding: 2px 12px 2px 24px;
  min-height: 22px;
}

.tabs-container.compact .tab-title {
  font-size: 10px;
}

.tabs-container.compact .tab-icon {
  width: 12px;
  height: 12px;
}

.empty-tabs {
  padding: 12px 24px;
  font-size: 11px;
  color: #666;
  font-style: italic;
}

.empty-state {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  color: #666;
  font-size: 13px;
}

/* Scrollbar */
.windows-container::-webkit-scrollbar {
  width: 6px;
}

.windows-container::-webkit-scrollbar-track {
  background: rgba(42, 42, 74, 0.3);
}

.windows-container::-webkit-scrollbar-thumb {
  background: rgba(99, 102, 241, 0.4);
  border-radius: 3px;
}

.windows-container::-webkit-scrollbar-thumb:hover {
  background: rgba(99, 102, 241, 0.6);
}
</style>
