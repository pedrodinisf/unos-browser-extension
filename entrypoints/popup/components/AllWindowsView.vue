<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted } from 'vue';
import type { TrackedWindow, TrackedTab } from '../../../src/db/types';

const props = defineProps<{
  windows: TrackedWindow[];
  tabs: TrackedTab[];
}>();

const emit = defineEmits<{
  error: [message: string];
  dataChanged: [];
}>();

// Sort types
type SortField = 'index' | 'title' | 'url' | 'time' | 'created';

// State
const collapsedWindows = ref<Set<string>>(new Set());
const windowSortBy = ref<Map<string, SortField>>(new Map());
const windowSortAsc = ref<Map<string, boolean>>(new Map());
const windowSearch = ref<Map<string, string>>(new Map());
const draggedTab = ref<TrackedTab | null>(null);
const dropTarget = ref<{ windowPersistentId: string; insertBeforeTabId: string | null; position: 'before' | 'after' } | null>(null);
const showCompact = ref(true);
const isLoading = ref(false);

// Selection state
const selectedTabs = ref<Set<string>>(new Set());
const lastClickedTabId = ref<string | null>(null);
const bulkTagInput = ref('');

const hasSelection = computed(() => selectedTabs.value.size > 0);
const selectedCount = computed(() => selectedTabs.value.size);

const selectedTabObjects = computed(() => {
  return props.tabs.filter(t => selectedTabs.value.has(t.persistentId) && !t.closedAt);
});

// Ordered list of all visible tabs (across all windows) for shift+click range
const allVisibleTabsOrdered = computed(() => {
  const result: TrackedTab[] = [];
  for (const win of openWindows.value) {
    if (!collapsedWindows.value.has(win.persistentId)) {
      result.push(...getTabsForWindow(win.persistentId));
    }
  }
  return result;
});

// Prune stale selections when tabs change
watch(() => props.tabs, (newTabs) => {
  const validIds = new Set(newTabs.filter(t => !t.closedAt).map(t => t.persistentId));
  const pruned = new Set<string>();
  for (const id of selectedTabs.value) {
    if (validIds.has(id)) pruned.add(id);
  }
  if (pruned.size !== selectedTabs.value.size) {
    selectedTabs.value = pruned;
  }
});

function toggleTabSelection(tab: TrackedTab, event: MouseEvent) {
  const newSet = new Set(selectedTabs.value);

  if (event.shiftKey && lastClickedTabId.value) {
    // Range select
    const ordered = allVisibleTabsOrdered.value;
    const lastIdx = ordered.findIndex(t => t.persistentId === lastClickedTabId.value);
    const curIdx = ordered.findIndex(t => t.persistentId === tab.persistentId);
    if (lastIdx !== -1 && curIdx !== -1) {
      const start = Math.min(lastIdx, curIdx);
      const end = Math.max(lastIdx, curIdx);
      for (let i = start; i <= end; i++) {
        newSet.add(ordered[i].persistentId);
      }
    }
  } else if (event.ctrlKey || event.metaKey) {
    // Toggle single
    if (newSet.has(tab.persistentId)) {
      newSet.delete(tab.persistentId);
    } else {
      newSet.add(tab.persistentId);
    }
  } else {
    // Plain click on checkbox: toggle
    if (newSet.has(tab.persistentId)) {
      newSet.delete(tab.persistentId);
    } else {
      newSet.add(tab.persistentId);
    }
  }

  selectedTabs.value = newSet;
  lastClickedTabId.value = tab.persistentId;
}

function clearSelection() {
  selectedTabs.value = new Set();
  lastClickedTabId.value = null;
}

function toggleSelectAllInWindow(windowPersistentId: string, event: MouseEvent) {
  event.stopPropagation();
  const windowTabs = getTabsForWindow(windowPersistentId);
  const allSelected = windowTabs.every(t => selectedTabs.value.has(t.persistentId));
  const newSet = new Set(selectedTabs.value);

  if (allSelected) {
    for (const t of windowTabs) newSet.delete(t.persistentId);
  } else {
    for (const t of windowTabs) newSet.add(t.persistentId);
  }

  selectedTabs.value = newSet;
}

function isWindowAllSelected(windowPersistentId: string): boolean {
  const windowTabs = getTabsForWindow(windowPersistentId);
  return windowTabs.length > 0 && windowTabs.every(t => selectedTabs.value.has(t.persistentId));
}

function isWindowPartiallySelected(windowPersistentId: string): boolean {
  const windowTabs = getTabsForWindow(windowPersistentId);
  const someSelected = windowTabs.some(t => selectedTabs.value.has(t.persistentId));
  const allSelected = windowTabs.every(t => selectedTabs.value.has(t.persistentId));
  return someSelected && !allSelected;
}

// Escape key clears selection
function onKeyDown(e: KeyboardEvent) {
  if (e.key === 'Escape' && hasSelection.value) {
    clearSelection();
  }
}

onMounted(() => document.addEventListener('keydown', onKeyDown));
onUnmounted(() => document.removeEventListener('keydown', onKeyDown));

// Bulk actions
async function bulkCloseTabs() {
  if (isLoading.value || !hasSelection.value) return;
  const count = selectedCount.value;
  if (count > 1 && !confirm(`Close ${count} tabs? This cannot be undone.`)) return;
  isLoading.value = true;
  try {
    const chromeTabIds = selectedTabObjects.value.map(t => t.chromeTabId);
    await sendMessage({ type: 'BULK_CLOSE_TABS', chromeTabIds });
    clearSelection();
    emit('dataChanged');
  } catch (err) {
    emit('error', err instanceof Error ? err.message : 'Failed to close tabs');
  } finally {
    isLoading.value = false;
  }
}

async function bulkMoveToNewWindow() {
  if (isLoading.value || !hasSelection.value) return;
  isLoading.value = true;
  try {
    const chromeTabIds = selectedTabObjects.value.map(t => t.chromeTabId);
    await sendMessage({ type: 'BULK_MOVE_TO_NEW_WINDOW', chromeTabIds });
    clearSelection();
    emit('dataChanged');
  } catch (err) {
    emit('error', err instanceof Error ? err.message : 'Failed to move tabs');
  } finally {
    isLoading.value = false;
  }
}

async function bulkMoveToWindow(targetWindowId: number) {
  if (isLoading.value || !hasSelection.value || !targetWindowId) return;
  isLoading.value = true;
  try {
    const chromeTabIds = selectedTabObjects.value.map(t => t.chromeTabId);
    await sendMessage({ type: 'BULK_MOVE_TO_WINDOW', chromeTabIds, targetWindowId });
    clearSelection();
    emit('dataChanged');
  } catch (err) {
    emit('error', err instanceof Error ? err.message : 'Failed to move tabs');
  } finally {
    isLoading.value = false;
  }
}

async function bulkAddTag() {
  const tag = bulkTagInput.value.trim();
  if (isLoading.value || !hasSelection.value || !tag) return;
  isLoading.value = true;
  try {
    const persistentIds = selectedTabObjects.value.map(t => t.persistentId);
    await sendMessage({ type: 'BULK_ADD_TAG', persistentIds, tag });
    bulkTagInput.value = '';
    clearSelection();
    emit('dataChanged');
  } catch (err) {
    emit('error', err instanceof Error ? err.message : 'Failed to add tag');
  } finally {
    isLoading.value = false;
  }
}

function onBulkMoveSelect(event: Event) {
  const value = (event.target as HTMLSelectElement).value;
  if (value) {
    bulkMoveToWindow(Number(value));
    (event.target as HTMLSelectElement).value = '';
  }
}

function updateWindowSearch(windowId: string, query: string) {
  const newMap = new Map(windowSearch.value);
  if (query) {
    newMap.set(windowId, query);
  } else {
    newMap.delete(windowId);
  }
  windowSearch.value = newMap;
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

function getWindowSort(windowId: string): { field: SortField; asc: boolean } {
  return {
    field: windowSortBy.value.get(windowId) || 'index',
    asc: windowSortAsc.value.has(windowId) ? windowSortAsc.value.get(windowId)! : true,
  };
}

function getTabsForWindow(windowPersistentId: string) {
  let windowTabs = props.tabs
    .filter(t => t.windowPersistentId === windowPersistentId && !t.closedAt);

  const query = (windowSearch.value.get(windowPersistentId) || '').toLowerCase().trim();
  if (query) {
    windowTabs = windowTabs.filter(t =>
      t.title?.toLowerCase().includes(query) ||
      t.url?.toLowerCase().includes(query)
    );
  }

  const { field, asc } = getWindowSort(windowPersistentId);

  // Sort tabs
  windowTabs = [...windowTabs].sort((a, b) => {
    let cmp = 0;
    switch (field) {
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
    return asc ? cmp : -cmp;
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

function toggleSort(windowId: string, field: SortField) {
  const current = getWindowSort(windowId);
  if (current.field === field) {
    const newMap = new Map(windowSortAsc.value);
    newMap.set(windowId, !current.asc);
    windowSortAsc.value = newMap;
  } else {
    const newSortBy = new Map(windowSortBy.value);
    newSortBy.set(windowId, field);
    windowSortBy.value = newSortBy;
    const newAsc = new Map(windowSortAsc.value);
    newAsc.set(windowId, true);
    windowSortAsc.value = newAsc;
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
    emit('dataChanged');
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
  resetDragState();
}

function resetDragState() {
  draggedTab.value = null;
  dropTarget.value = null;
}

function getDropPosition(event: DragEvent): 'before' | 'after' {
  const el = (event.currentTarget as HTMLElement);
  const rect = el.getBoundingClientRect();
  const midY = rect.top + rect.height / 2;
  return event.clientY < midY ? 'before' : 'after';
}

function isDropTarget(tabId: string, position: 'before' | 'after'): boolean {
  return dropTarget.value?.insertBeforeTabId === tabId && dropTarget.value?.position === position;
}

function onTabDragOver(event: DragEvent, tab: TrackedTab, win: TrackedWindow) {
  event.preventDefault();
  event.stopPropagation();
  if (!draggedTab.value || draggedTab.value.persistentId === tab.persistentId) return;
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
  const position = getDropPosition(event);
  dropTarget.value = { windowPersistentId: win.persistentId, insertBeforeTabId: tab.persistentId, position };
}

async function onTabDrop(event: DragEvent, tab: TrackedTab, win: TrackedWindow) {
  event.preventDefault();
  event.stopPropagation();
  if (!draggedTab.value || draggedTab.value.persistentId === tab.persistentId) return;

  // Multi-drag: if dragged tab is in selection and multiple selected
  if (isDraggingMultiple.value) {
    await performBulkDrop(win);
    return;
  }

  const position = getDropPosition(event);
  const index = calculateInsertionIndex(draggedTab.value, tab, win, position);
  await performDrop(draggedTab.value, win, index);
}

function onContainerDragOver(event: DragEvent, win: TrackedWindow) {
  event.preventDefault();
  if (!draggedTab.value) return;
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
  dropTarget.value = { windowPersistentId: win.persistentId, insertBeforeTabId: null, position: 'after' };
}

async function onContainerDrop(event: DragEvent, win: TrackedWindow) {
  event.preventDefault();
  if (!draggedTab.value) return;

  if (isDraggingMultiple.value) {
    await performBulkDrop(win);
    return;
  }

  await performDrop(draggedTab.value, win, -1);
}

function onWindowHeaderDragOver(event: DragEvent, win: TrackedWindow) {
  event.preventDefault();
  event.stopPropagation();
  if (!draggedTab.value) return;
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
  dropTarget.value = { windowPersistentId: win.persistentId, insertBeforeTabId: null, position: 'after' };
}

async function onWindowHeaderDrop(event: DragEvent, win: TrackedWindow) {
  event.preventDefault();
  event.stopPropagation();
  if (!draggedTab.value) return;

  if (isDraggingMultiple.value) {
    await performBulkDrop(win);
    return;
  }

  await performDrop(draggedTab.value, win, -1);
}

// Multi-drag support
const isDraggingMultiple = computed(() => {
  return draggedTab.value &&
    selectedTabs.value.has(draggedTab.value.persistentId) &&
    selectedTabs.value.size > 1;
});

async function performBulkDrop(targetWindow: TrackedWindow) {
  try {
    const chromeTabIds = selectedTabObjects.value.map(t => t.chromeTabId);
    await sendMessage({
      type: 'BULK_MOVE_TO_WINDOW',
      chromeTabIds,
      targetWindowId: targetWindow.chromeWindowId,
    });
    clearSelection();
    emit('dataChanged');
  } catch (err) {
    emit('error', err instanceof Error ? err.message : 'Failed to move tabs');
  }
  resetDragState();
}

function calculateInsertionIndex(dragged: TrackedTab, target: TrackedTab, targetWin: TrackedWindow, position: 'before' | 'after'): number {
  let rawIndex = position === 'before' ? (target.index || 0) : (target.index || 0) + 1;
  const sameWindow = dragged.chromeWindowId === targetWin.chromeWindowId;
  if (sameWindow && (dragged.index || 0) < rawIndex) {
    rawIndex -= 1;
  }
  return Math.max(0, rawIndex);
}

async function performDrop(tab: TrackedTab, targetWindow: TrackedWindow, index: number) {
  const sameWindow = tab.chromeWindowId === targetWindow.chromeWindowId;

  // No-op check: same window, same position
  if (sameWindow && index === (tab.index || 0)) {
    resetDragState();
    return;
  }

  try {
    if (sameWindow) {
      await sendMessage({
        type: 'REORDER_TAB',
        chromeTabId: tab.chromeTabId,
        newIndex: index,
      });
    } else {
      await sendMessage({
        type: 'MOVE_TAB_TO_WINDOW',
        chromeTabId: tab.chromeTabId,
        targetWindowId: targetWindow.chromeWindowId,
        index: index >= 0 ? index : undefined,
      });
    }
    emit('dataChanged');
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to move tab';
    console.error('Failed to move tab:', err);
    emit('error', message);
  }

  resetDragState();
}

function isContainerDropEnd(win: TrackedWindow): boolean {
  return dropTarget.value?.windowPersistentId === win.persistentId && dropTarget.value?.insertBeforeTabId === null;
}

function isWindowHeaderDragTarget(win: TrackedWindow): boolean {
  return !!draggedTab.value && dropTarget.value?.windowPersistentId === win.persistentId && collapsedWindows.value.has(win.persistentId);
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

// ── Duplicate detection ──

const showDuplicates = ref(false);

// Per-window duplicate groups: windowPersistentId → url → tabs[]
const duplicateGroups = computed(() => {
  const result = new Map<string, Map<string, TrackedTab[]>>();

  for (const win of openWindows.value) {
    const urlMap = new Map<string, TrackedTab[]>();
    const windowTabs = props.tabs.filter(t =>
      t.windowPersistentId === win.persistentId && !t.closedAt
    );

    for (const tab of windowTabs) {
      if (!tab.url ||
          tab.url.startsWith('chrome://') ||
          tab.url.startsWith('chrome-extension://') ||
          tab.url.startsWith('about:')) continue;

      const existing = urlMap.get(tab.url) || [];
      existing.push(tab);
      urlMap.set(tab.url, existing);
    }

    const dupsOnly = new Map<string, TrackedTab[]>();
    for (const [url, tabs] of urlMap) {
      if (tabs.length >= 2) dupsOnly.set(url, tabs);
    }

    if (dupsOnly.size > 0) {
      result.set(win.persistentId, dupsOnly);
    }
  }

  return result;
});

// Total closable duplicates (extras beyond the keeper in each group)
const totalDuplicateCount = computed(() => {
  let count = 0;
  for (const [, windowDups] of duplicateGroups.value) {
    for (const [, tabs] of windowDups) {
      count += tabs.length - 1;
    }
  }
  return count;
});

// Duplicate count for a specific window
function getWindowDuplicateCount(windowPersistentId: string): number {
  const windowDups = duplicateGroups.value.get(windowPersistentId);
  if (!windowDups) return 0;
  let count = 0;
  for (const [, tabs] of windowDups) {
    count += tabs.length - 1;
  }
  return count;
}

// Total duplicate groups across all windows
const totalDuplicateGroups = computed(() => {
  let count = 0;
  for (const [, windowDups] of duplicateGroups.value) {
    count += windowDups.size;
  }
  return count;
});

// Select which tab to keep in a duplicate group (highest priority wins)
function selectKeeperTab(tabs: TrackedTab[]): TrackedTab {
  return [...tabs].sort((a, b) => {
    // Pinned tabs always win
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    // Saved tabs next
    if (a.isSaved !== b.isSaved) return a.isSaved ? -1 : 1;
    // Has metadata (tags or notes)
    const aMeta = (a.tags?.length || 0) + (a.notes ? 1 : 0);
    const bMeta = (b.tags?.length || 0) + (b.notes ? 1 : 0);
    if (aMeta !== bMeta) return bMeta - aMeta;
    // Most active time
    if ((a.totalActiveTime || 0) !== (b.totalActiveTime || 0)) {
      return (b.totalActiveTime || 0) - (a.totalActiveTime || 0);
    }
    // Lowest index (first in window)
    return (a.index || 0) - (b.index || 0);
  })[0];
}

// Check if a tab is the keeper in its duplicate group
function isKeeperTab(tab: TrackedTab): boolean {
  const windowDups = duplicateGroups.value.get(tab.windowPersistentId);
  if (!windowDups) return false;
  const group = windowDups.get(tab.url);
  if (!group) return false;
  return selectKeeperTab(group).persistentId === tab.persistentId;
}

// Check if a tab is a duplicate (in any group)
function isDuplicateTab(tab: TrackedTab): boolean {
  const windowDups = duplicateGroups.value.get(tab.windowPersistentId);
  if (!windowDups) return false;
  return windowDups.has(tab.url);
}

// Close all duplicate tabs (keep one per group)
async function closeDuplicates() {
  if (isLoading.value || totalDuplicateCount.value === 0) return;

  const windowCount = duplicateGroups.value.size;
  const msg = `Close ${totalDuplicateCount.value} duplicate tab${totalDuplicateCount.value > 1 ? 's' : ''} across ${windowCount} window${windowCount > 1 ? 's' : ''}?\n\nTabs with unsaved form data may lose changes.`;
  if (!confirm(msg)) return;

  isLoading.value = true;
  try {
    const chromeTabIds: number[] = [];
    for (const [, windowDups] of duplicateGroups.value) {
      for (const [, tabs] of windowDups) {
        const keeper = selectKeeperTab(tabs);
        for (const tab of tabs) {
          if (tab.persistentId !== keeper.persistentId) {
            chromeTabIds.push(tab.chromeTabId);
          }
        }
      }
    }

    if (chromeTabIds.length > 0) {
      await sendMessage({ type: 'BULK_CLOSE_TABS', chromeTabIds });
    }

    showDuplicates.value = false;
    emit('dataChanged');
  } catch (err) {
    emit('error', err instanceof Error ? err.message : 'Failed to close duplicates');
  } finally {
    isLoading.value = false;
  }
}

const containerEl = ref<HTMLElement | null>(null);

function reset() {
  windowSearch.value = new Map();
  selectedTabs.value = new Set();
  collapsedWindows.value = new Set();
  showDuplicates.value = false;
  containerEl.value?.scrollTo(0, 0);
}

defineExpose({ reset });
</script>

<template>
  <div class="all-windows-view" :class="{ 'has-selection': hasSelection }">
    <!-- Toolbar -->
    <div class="toolbar">
      <div class="toolbar-left">
        <span class="stats-inline">{{ openWindows.length }} win / {{ totalTabs }} tabs</span>
      </div>
      <div class="toolbar-right">
        <button
          class="tool-btn dup-btn"
          :class="{ active: showDuplicates, 'has-dupes': totalDuplicateCount > 0 }"
          :disabled="totalDuplicateCount === 0"
          @click="showDuplicates = !showDuplicates"
          :title="totalDuplicateCount > 0 ? `${totalDuplicateCount} duplicate tabs found — click to review` : 'No duplicate tabs'"
        >DUP {{ totalDuplicateCount }}</button>
        <button
          class="tool-btn"
          :class="{ active: showCompact }"
          @click="showCompact = !showCompact"
          :title="showCompact ? 'Switch to expanded view' : 'Switch to compact view'"
        >
          {{ showCompact ? '&#9636;' : '&#9638;' }}
        </button>
        <button class="tool-btn" @click="expandAll" title="Expand all windows">+</button>
        <button class="tool-btn" @click="collapseAll" title="Collapse all windows">&minus;</button>
      </div>
    </div>

    <!-- Windows list -->
    <div ref="containerEl" class="windows-container">
      <div
        v-for="win in openWindows"
        :key="win.persistentId"
        class="window-section"
      >
        <!-- Window header -->
        <div
          class="window-header"
          :class="{ 'drag-target': isWindowHeaderDragTarget(win) }"
          @click="toggleWindow(win.persistentId)"
          @dragover="onWindowHeaderDragOver($event, win)"
          @drop="onWindowHeaderDrop($event, win)"
        >
          <span class="collapse-icon">{{ collapsedWindows.has(win.persistentId) ? '&#9654;' : '&#9660;' }}</span>
          <input
            type="checkbox"
            class="window-select-all"
            :checked="isWindowAllSelected(win.persistentId)"
            :indeterminate="isWindowPartiallySelected(win.persistentId)"
            @click="toggleSelectAllInWindow(win.persistentId, $event)"
            @dblclick.stop
            title="Select all tabs in this window"
          />
          <span class="window-id">Window {{ openWindows.indexOf(win) + 1 }}</span>
          <span class="window-chrome-id">({{ win.chromeWindowId }})</span>
          <span class="window-count">{{ getWindowTabCount(win.persistentId) }} tabs</span>
          <span
            v-if="getWindowDuplicateCount(win.persistentId) > 0"
            class="window-dup-badge"
          >{{ getWindowDuplicateCount(win.persistentId) }} dup</span>
          <button class="window-btn" @click.stop="focusWindow(win)" title="Focus window">&#8599;</button>
          <span v-if="win.incognito" class="incognito-badge">incog</span>
          <input
            type="text"
            class="window-search"
            :value="windowSearch.get(win.persistentId) || ''"
            @input.stop="updateWindowSearch(win.persistentId, ($event.target as HTMLInputElement).value)"
            @click.stop
            placeholder="Search..."
          />
          <span class="window-sort">
            <button
              v-for="s in (['index', 'title', 'url', 'time', 'created'] as const)"
              :key="s"
              class="wsort-btn"
              :class="{ active: getWindowSort(win.persistentId).field === s }"
              @click.stop="toggleSort(win.persistentId, s)"
            >
              {{ s === 'index' ? '#' : s === 'time' ? 'Act' : s === 'created' ? 'New' : s.charAt(0).toUpperCase() + s.slice(1) }}
              <span v-if="getWindowSort(win.persistentId).field === s" class="wsort-dir">{{ getWindowSort(win.persistentId).asc ? '↑' : '↓' }}</span>
            </button>
          </span>
        </div>

        <!-- Tabs grid/list -->
        <div
          v-if="!collapsedWindows.has(win.persistentId)"
          class="tabs-container"
          :class="{ compact: showCompact, 'drop-end': isContainerDropEnd(win) }"
          @dragover="onContainerDragOver($event, win)"
          @drop="onContainerDrop($event, win)"
        >
          <div
            v-for="tab in getTabsForWindow(win.persistentId)"
            :key="tab.persistentId"
            class="tab-row"
            :class="{
              dragging: draggedTab?.persistentId === tab.persistentId,
              'drop-above': isDropTarget(tab.persistentId, 'before'),
              'drop-below': isDropTarget(tab.persistentId, 'after'),
              selected: selectedTabs.has(tab.persistentId),
              'dup-keeper': showDuplicates && isDuplicateTab(tab) && isKeeperTab(tab),
              'dup-closable': showDuplicates && isDuplicateTab(tab) && !isKeeperTab(tab),
            }"
            draggable="true"
            @dragstart="onDragStart($event, tab)"
            @dragend="onDragEnd"
            @dragover="onTabDragOver($event, tab, win)"
            @drop="onTabDrop($event, tab, win)"
            @dblclick="switchToTab(tab)"
          >
            <input
              type="checkbox"
              class="tab-checkbox"
              :checked="selectedTabs.has(tab.persistentId)"
              @click.stop="toggleTabSelection(tab, $event)"
              @dblclick.stop
            />
            <span class="tab-idx">{{ tab.index + 1 }}</span>
            <span v-if="tab.pinned" class="tab-badge pinned" title="Pinned">&#128204;</span>
            <img
              v-if="tab.faviconUrl"
              :src="tab.faviconUrl"
              class="tab-icon"
              alt=""
            />
            <span v-else class="tab-icon-placeholder">&#9675;</span>
            <span class="tab-title" :title="tab.title || ''">
              {{ tab.title || 'Untitled' }}
            </span>
            <span v-if="!showCompact" class="tab-domain">{{ getDomain(tab.url) }}</span>
            <span class="tab-time">{{ formatTime(tab.totalActiveTime || 0) }}</span>
            <span v-if="tab.isSaved" class="tab-badge saved">&#9733;</span>
            <span v-if="tab.tags?.length" class="tab-badge tags">{{ tab.tags.length }}</span>
            <span v-if="showDuplicates && isDuplicateTab(tab) && isKeeperTab(tab)" class="tab-badge dup-keep">KEEP</span>
            <span v-if="showDuplicates && isDuplicateTab(tab) && !isKeeperTab(tab)" class="tab-badge dup-close">DUP</span>
            <button class="tab-close" @click="closeTab(tab, $event)" title="Close">&times;</button>
          </div>

          <div v-if="getTabsForWindow(win.persistentId).length === 0" class="empty-tabs">
            {{ windowSearch.get(win.persistentId) ? 'No matching tabs' : 'No tabs' }}
          </div>
        </div>
      </div>

      <div v-if="openWindows.length === 0" class="empty-state">
        No windows tracked
      </div>
    </div>

    <!-- Floating bulk action bar -->
    <Transition name="slide-up">
      <div v-if="hasSelection && !showDuplicates" class="bulk-action-bar">
        <span class="bulk-count">{{ selectedCount }} selected</span>
        <button class="bulk-btn" @click="clearSelection" title="Clear selection">Clear</button>
        <span class="bulk-separator"></span>
        <input
          type="text"
          class="bulk-tag-input"
          v-model="bulkTagInput"
          placeholder="Tag..."
          @keydown.enter="bulkAddTag"
        />
        <button class="bulk-btn accent" @click="bulkAddTag" :disabled="!bulkTagInput.trim()" title="Add tag to selected tabs">Tag</button>
        <span class="bulk-separator"></span>
        <button class="bulk-btn accent" @click="bulkMoveToNewWindow" title="Move selected tabs to a new window">New Window</button>
        <select class="bulk-window-select" @change="onBulkMoveSelect" title="Move selected tabs to an existing window">
          <option value="">Move to...</option>
          <option
            v-for="win in openWindows"
            :key="win.persistentId"
            :value="win.chromeWindowId"
          >Window {{ openWindows.indexOf(win) + 1 }} ({{ getWindowTabCount(win.persistentId) }})</option>
        </select>
        <span class="bulk-separator"></span>
        <button class="bulk-btn danger" @click="bulkCloseTabs" title="Close all selected tabs">Close {{ selectedCount }}</button>
      </div>
    </Transition>

    <!-- Floating duplicate action bar -->
    <Transition name="slide-up">
      <div v-if="showDuplicates && totalDuplicateCount > 0" class="dup-action-bar">
        <span class="dup-action-count">{{ totalDuplicateCount }} duplicate{{ totalDuplicateCount > 1 ? 's' : '' }} &middot; {{ totalDuplicateGroups }} group{{ totalDuplicateGroups > 1 ? 's' : '' }}</span>
        <button class="bulk-btn danger" @click="closeDuplicates" title="Close all duplicate tabs, keeping one per URL">Close All Duplicates</button>
        <button class="bulk-btn" @click="showDuplicates = false" title="Exit duplicate mode">&times;</button>
      </div>
    </Transition>
  </div>
</template>

<style scoped>
.all-windows-view {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: var(--bg-card);
  border-top: 1px solid var(--border-light);
  overflow: hidden;
}

.toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 12px;
  border-bottom: 1px solid var(--border-light);
  gap: 8px;
}

.toolbar-left {
  display: flex;
  align-items: center;
}

.stats-inline {
  font-size: 10px;
  color: var(--text-muted);
  font-family: var(--font-mono);
}

.toolbar-right {
  display: flex;
  gap: 4px;
}

.tool-btn {
  background: var(--bg-alt);
  border: 1px solid var(--border-light);
  color: var(--text-secondary);
  padding: 3px 8px;
  border-radius: 3px;
  cursor: pointer;
  font-size: 12px;
  transition: all 0.15s;
}

.tool-btn:hover {
  background: var(--bg-page);
  color: var(--text-primary);
}

.tool-btn.active {
  background: var(--accent-green);
  color: #fff;
  border-color: var(--accent-green);
}

.windows-container {
  flex: 1;
  overflow-y: auto;
  overflow-x: hidden;
}

.window-section {
  border-bottom: 1px solid var(--border-light);
}

.window-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 12px;
  background: var(--bg-alt);
  cursor: pointer;
  user-select: none;
  transition: background 0.15s;
}

.window-header:hover {
  background: var(--border-warm);
}

.collapse-icon {
  font-size: 8px;
  color: var(--text-muted);
  width: 12px;
}

.window-id {
  font-size: 11px;
  font-weight: 600;
  color: var(--accent-green);
  font-family: var(--font-mono);
}

.window-chrome-id {
  font-size: 10px;
  color: var(--text-muted);
  font-family: var(--font-mono);
}

.window-count {
  font-size: 10px;
  color: var(--text-secondary);
  background: var(--bg-page);
  padding: 1px 6px;
  border-radius: 8px;
}

.incognito-badge {
  font-size: 9px;
  color: var(--text-muted);
  font-style: italic;
}

.window-btn {
  background: var(--bg-card);
  border: 1px solid var(--border-light);
  color: var(--text-secondary);
  padding: 2px 6px;
  border-radius: 3px;
  cursor: pointer;
  font-size: 11px;
  transition: all 0.15s;
}

.window-btn:hover {
  background: var(--accent-green);
  color: #fff;
  border-color: var(--accent-green);
}

.window-search {
  width: 90px;
  background: var(--bg-page);
  border: 1px solid var(--border-light);
  border-radius: 3px;
  padding: 1px 6px;
  font-size: 10px;
  color: var(--text-primary);
  outline: none;
  transition: width 0.15s, border-color 0.15s;
}

.window-search:focus {
  border-color: var(--accent-green);
  width: 130px;
}

.window-search::placeholder {
  color: var(--text-muted);
}

.window-sort {
  display: flex;
  gap: 2px;
  margin-left: auto;
}

.wsort-btn {
  background: none;
  border: none;
  color: var(--text-muted);
  font-size: 9px;
  padding: 1px 4px;
  border-radius: 3px;
  cursor: pointer;
  transition: all 0.15s;
  line-height: 1.2;
}

.wsort-btn:hover {
  color: var(--text-primary);
  background: var(--bg-page);
}

.wsort-btn.active {
  color: var(--accent-green);
  font-weight: 600;
}

.wsort-dir {
  font-size: 8px;
  margin-left: 1px;
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
  min-height: 26px;
  position: relative;
}

.tab-row:hover {
  background: var(--bg-alt);
}

.tab-row.selected {
  background: rgba(5, 150, 105, 0.08);
}

.tab-row.selected:hover {
  background: rgba(5, 150, 105, 0.13);
}

.tab-row.dragging {
  opacity: 0.5;
}

.tab-row.drop-above::before {
  content: '';
  position: absolute;
  top: 0;
  left: 12px;
  right: 12px;
  height: 2px;
  background: var(--accent-green);
  border-radius: 1px;
  z-index: 1;
}

.tab-row.drop-below::after {
  content: '';
  position: absolute;
  bottom: 0;
  left: 12px;
  right: 12px;
  height: 2px;
  background: var(--accent-green);
  border-radius: 1px;
  z-index: 1;
}

.tabs-container.drop-end::after {
  content: '';
  display: block;
  height: 2px;
  margin: 0 12px;
  background: var(--accent-green);
  border-radius: 1px;
}

.window-header.drag-target {
  outline: 2px dashed var(--accent-green);
  outline-offset: -2px;
}

/* Checkboxes */
.tab-checkbox {
  opacity: 0;
  width: 13px;
  height: 13px;
  flex-shrink: 0;
  cursor: pointer;
  margin: 0;
  transition: opacity 0.1s;
  accent-color: var(--accent-green);
}

.tab-row:hover .tab-checkbox,
.has-selection .tab-checkbox {
  opacity: 1;
}

.tab-checkbox:checked {
  opacity: 1;
}

.window-select-all {
  opacity: 0;
  width: 13px;
  height: 13px;
  flex-shrink: 0;
  cursor: pointer;
  margin: 0;
  transition: opacity 0.1s;
  accent-color: var(--accent-green);
}

.window-header:hover .window-select-all,
.has-selection .window-select-all {
  opacity: 1;
}

.window-select-all:checked,
.window-select-all:indeterminate {
  opacity: 1;
}

.tab-idx {
  font-size: 9px;
  color: var(--text-muted);
  width: 18px;
  text-align: right;
  flex-shrink: 0;
  font-family: var(--font-mono);
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
  color: var(--text-muted);
  text-align: center;
  flex-shrink: 0;
}

.tab-title {
  flex: 1;
  font-size: 11px;
  color: var(--text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  min-width: 0;
}

.tab-domain {
  font-size: 9px;
  color: var(--text-muted);
  white-space: nowrap;
  max-width: 80px;
  overflow: hidden;
  text-overflow: ellipsis;
  flex-shrink: 0;
}

.tab-time {
  font-size: 9px;
  font-family: var(--font-mono);
  color: var(--accent-amber);
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

.tab-badge.pinned {
  color: var(--accent-amber);
  font-size: 10px;
  padding: 0;
}

.tab-badge.saved {
  color: var(--accent-amber);
}

.tab-badge.tags {
  background: rgba(5, 150, 105, 0.1);
  color: var(--accent-green);
}

.tab-close {
  opacity: 0;
  background: #F3F4F6;
  border: none;
  color: var(--accent-red);
  font-size: 13px;
  font-weight: 700;
  width: 18px;
  height: 18px;
  padding: 0;
  border-radius: 3px;
  cursor: pointer;
  transition: all 0.1s;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  line-height: 1;
}

.tab-row:hover .tab-close {
  opacity: 1;
}

.tab-close:hover {
  background: #E5E7EB;
  color: #DC2626;
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
  color: var(--text-muted);
  font-style: italic;
}

.empty-state {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  color: var(--text-muted);
  font-size: 13px;
}

/* Bulk action bar */
.bulk-action-bar {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
  background: var(--bg-header, #2A3328);
  border-top: 2px solid var(--accent-green);
  flex-shrink: 0;
}

.bulk-count {
  font-size: 11px;
  font-weight: 600;
  color: #fff;
  font-family: var(--font-mono);
  white-space: nowrap;
}

.bulk-separator {
  width: 1px;
  height: 18px;
  background: rgba(255, 255, 255, 0.15);
  flex-shrink: 0;
}

.bulk-btn {
  background: rgba(255, 255, 255, 0.1);
  border: 1px solid rgba(255, 255, 255, 0.2);
  color: rgba(255, 255, 255, 0.85);
  padding: 3px 8px;
  border-radius: 3px;
  cursor: pointer;
  font-size: 10px;
  white-space: nowrap;
  transition: all 0.15s;
}

.bulk-btn:hover {
  background: rgba(255, 255, 255, 0.18);
  color: #fff;
}

.bulk-btn:disabled {
  opacity: 0.4;
  cursor: default;
}

.bulk-btn.accent {
  background: rgba(5, 150, 105, 0.3);
  border-color: rgba(5, 150, 105, 0.5);
  color: #6ee7b7;
}

.bulk-btn.accent:hover {
  background: rgba(5, 150, 105, 0.5);
  color: #a7f3d0;
}

.bulk-btn.danger {
  background: rgba(220, 38, 38, 0.3);
  border-color: rgba(220, 38, 38, 0.5);
  color: #fca5a5;
}

.bulk-btn.danger:hover {
  background: rgba(220, 38, 38, 0.5);
  color: #fecaca;
}

.bulk-tag-input {
  width: 60px;
  background: rgba(255, 255, 255, 0.1);
  border: 1px solid rgba(255, 255, 255, 0.2);
  border-radius: 3px;
  padding: 3px 6px;
  font-size: 10px;
  color: #fff;
  outline: none;
}

.bulk-tag-input::placeholder {
  color: rgba(255, 255, 255, 0.4);
}

.bulk-tag-input:focus {
  border-color: var(--accent-green);
}

.bulk-window-select {
  background: rgba(255, 255, 255, 0.1);
  border: 1px solid rgba(255, 255, 255, 0.2);
  border-radius: 3px;
  padding: 3px 4px;
  font-size: 10px;
  color: rgba(255, 255, 255, 0.85);
  outline: none;
  cursor: pointer;
  max-width: 100px;
}

.bulk-window-select option {
  background: #2A3328;
  color: #fff;
}

/* Slide-up transition */
.slide-up-enter-active,
.slide-up-leave-active {
  transition: transform 0.2s ease, opacity 0.2s ease;
}

.slide-up-enter-from,
.slide-up-leave-to {
  transform: translateY(100%);
  opacity: 0;
}

/* Scrollbar */
.windows-container::-webkit-scrollbar {
  width: 6px;
}

.windows-container::-webkit-scrollbar-track {
  background: var(--bg-alt);
}

.windows-container::-webkit-scrollbar-thumb {
  background: var(--border-warm);
  border-radius: 3px;
}

.windows-container::-webkit-scrollbar-thumb:hover {
  background: var(--text-muted);
}

/* ── Duplicate detection ── */

.dup-btn {
  font-family: var(--font-mono);
  font-size: 9px;
  font-weight: 700;
  letter-spacing: 0.5px;
  text-transform: uppercase;
}

.dup-btn.has-dupes {
  background: rgba(217, 119, 6, 0.15);
  border-color: rgba(217, 119, 6, 0.4);
  color: var(--accent-amber);
}

.dup-btn.has-dupes:hover {
  background: rgba(217, 119, 6, 0.25);
}

.dup-btn.active {
  background: var(--accent-amber) !important;
  color: #fff !important;
  border-color: var(--accent-amber) !important;
}

.dup-btn:disabled {
  opacity: 0.35;
  cursor: default;
}

.window-dup-badge {
  font-size: 9px;
  font-family: var(--font-mono);
  font-weight: 600;
  color: var(--accent-amber);
  background: rgba(217, 119, 6, 0.12);
  padding: 1px 5px;
  border-radius: 8px;
}

.tab-row.dup-keeper {
  border-left: 2px solid var(--accent-green);
}

.tab-row.dup-closable {
  border-left: 2px solid var(--accent-amber);
  opacity: 0.7;
}

.tab-badge.dup-keep {
  background: rgba(5, 150, 105, 0.15);
  color: var(--accent-green);
  font-size: 8px;
  font-weight: 700;
  font-family: var(--font-mono);
  letter-spacing: 0.3px;
}

.tab-badge.dup-close {
  background: rgba(217, 119, 6, 0.15);
  color: var(--accent-amber);
  font-size: 8px;
  font-weight: 700;
  font-family: var(--font-mono);
  letter-spacing: 0.3px;
}

.dup-action-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 12px;
  background: var(--bg-header, #2A3328);
  border-top: 2px solid var(--accent-amber);
  flex-shrink: 0;
}

.dup-action-count {
  font-size: 11px;
  font-weight: 600;
  color: var(--accent-amber);
  font-family: var(--font-mono);
  white-space: nowrap;
  flex: 1;
}
</style>
