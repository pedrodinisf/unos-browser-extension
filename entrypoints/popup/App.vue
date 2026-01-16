<script setup lang="ts">
import { ref, onMounted, computed } from 'vue';
import type { TrackedTab, TrackedWindow } from '../../src/db/types';
import MetadataPanel from './components/MetadataPanel.vue';
import ExportDialog from './components/ExportDialog.vue';

// State
const currentTab = ref<TrackedTab | null>(null);
const tabs = ref<TrackedTab[]>([]);
const windows = ref<TrackedWindow[]>([]);
const loading = ref(true);
const error = ref<string | null>(null);
const showMetadataPanel = ref(false);
const showExportDialog = ref(false);

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

async function loadData() {
  try {
    loading.value = true;
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

function handleShare() {
  // Placeholder for PKM integration
  alert('PKM integration coming soon!');
}

// Lifecycle
onMounted(() => {
  loadData();
});
</script>

<template>
  <div class="popup">
    <!-- Header -->
    <header class="header">
      <div class="header-left">
        <h1>UNOS</h1>
        <span class="version">v0.1</span>
      </div>
      <div class="header-right">
        <span class="badge">{{ tabCount }} tabs</span>
        <span class="badge">{{ windowCount }} windows</span>
      </div>
    </header>

    <!-- Loading state -->
    <div v-if="loading" class="loading">
      <span class="spinner"></span>
      Loading...
    </div>

    <!-- Error state -->
    <div v-else-if="error" class="error">
      <p>{{ error }}</p>
      <button @click="loadData" class="btn btn-sm">Retry</button>
    </div>

    <!-- Main content -->
    <main v-else class="main">
      <!-- Current tab info -->
      <section v-if="currentTab" class="current-tab">
        <div class="tab-info">
          <img
            v-if="currentTab.faviconUrl"
            :src="currentTab.faviconUrl"
            class="favicon"
            alt=""
          />
          <div class="tab-details">
            <h2 class="tab-title">{{ currentTab.title || 'Untitled' }}</h2>
            <p class="tab-url">{{ currentTab.url }}</p>
          </div>
        </div>

        <div class="tab-stats">
          <div class="stat">
            <span class="stat-label">Active time</span>
            <span class="stat-value">{{ Math.round((currentTab.totalActiveTime || 0) / 60000) }}m</span>
          </div>
          <div class="stat">
            <span class="stat-label">Created</span>
            <span class="stat-value">{{ new Date(currentTab.createdAt).toLocaleTimeString() }}</span>
          </div>
        </div>

        <!-- Tags -->
        <div v-if="currentTab.tags && currentTab.tags.length > 0" class="tags">
          <span v-for="tag in currentTab.tags" :key="tag" class="tag">{{ tag }}</span>
        </div>

        <!-- Saved badge -->
        <div v-if="currentTab.isSaved" class="saved-badge">
          Saved
        </div>
      </section>

      <!-- Actions -->
      <section class="actions">
        <button
          class="btn btn-primary"
          @click="showMetadataPanel = !showMetadataPanel"
          title="Add metadata/tags"
        >
          +
        </button>
        <button
          class="btn"
          @click="handleShare"
          title="Share to PKM"
        >
          Share
        </button>
        <button
          class="btn"
          @click="showExportDialog = true"
          title="Export tabs"
        >
          Export
        </button>
        <button
          v-if="currentTab && !currentTab.isSaved"
          class="btn btn-save"
          @click="handleSaveTab"
          title="Save tab (prevent auto-deletion)"
        >
          Save
        </button>
      </section>

      <!-- Metadata panel -->
      <MetadataPanel
        v-if="showMetadataPanel && currentTab"
        :tab="currentTab"
        @update="handleMetadataUpdate"
        @close="showMetadataPanel = false"
      />

      <!-- Session summary -->
      <section class="session-summary">
        <h3>Session Summary</h3>
        <div class="summary-stats">
          <div class="summary-stat">
            <span class="summary-label">Total active time</span>
            <span class="summary-value">{{ totalActiveTime }}</span>
          </div>
          <div class="summary-stat">
            <span class="summary-label">Open tabs</span>
            <span class="summary-value">{{ tabCount }}</span>
          </div>
          <div class="summary-stat">
            <span class="summary-label">Windows</span>
            <span class="summary-value">{{ windowCount }}</span>
          </div>
        </div>
      </section>
    </main>

    <!-- Export dialog -->
    <ExportDialog
      v-if="showExportDialog"
      :windows="windows"
      @close="showExportDialog = false"
    />
  </div>
</template>

<style>
* {
  margin: 0;
  padding: 0;
  box-sizing: border-box;
}

.popup {
  width: 360px;
  min-height: 300px;
  max-height: 500px;
  overflow-y: auto;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  background: #1a1a2e;
  color: #eee;
}

.header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 16px;
  border-bottom: 1px solid #2a2a4a;
  position: sticky;
  top: 0;
  background: #1a1a2e;
  z-index: 10;
}

.header-left {
  display: flex;
  align-items: baseline;
  gap: 8px;
}

.header h1 {
  font-size: 18px;
  font-weight: 600;
  color: #fff;
}

.version {
  font-size: 11px;
  color: #888;
}

.header-right {
  display: flex;
  gap: 8px;
}

.badge {
  background: #2a2a4a;
  padding: 4px 8px;
  border-radius: 12px;
  font-size: 11px;
  color: #aaa;
}

.loading, .error {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 40px 20px;
  gap: 12px;
  color: #888;
}

.spinner {
  width: 24px;
  height: 24px;
  border: 2px solid #3a3a5a;
  border-top-color: #6366f1;
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

.error {
  color: #ef4444;
}

.main {
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.current-tab {
  background: #2a2a4a;
  border-radius: 12px;
  padding: 12px;
}

.tab-info {
  display: flex;
  gap: 12px;
  margin-bottom: 12px;
}

.favicon {
  width: 32px;
  height: 32px;
  border-radius: 6px;
  background: #3a3a5a;
  flex-shrink: 0;
}

.tab-details {
  overflow: hidden;
  flex: 1;
}

.tab-title {
  font-size: 14px;
  font-weight: 500;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  margin-bottom: 4px;
}

.tab-url {
  font-size: 11px;
  color: #888;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.tab-stats {
  display: flex;
  gap: 16px;
}

.stat {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.stat-label {
  font-size: 10px;
  color: #666;
  text-transform: uppercase;
}

.stat-value {
  font-size: 13px;
  font-weight: 500;
}

.tags {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 12px;
}

.tag {
  background: #6366f1;
  color: #fff;
  padding: 2px 8px;
  border-radius: 10px;
  font-size: 11px;
}

.saved-badge {
  display: inline-block;
  margin-top: 8px;
  background: #22c55e;
  color: #fff;
  padding: 2px 8px;
  border-radius: 10px;
  font-size: 11px;
}

.actions {
  display: flex;
  gap: 8px;
}

.btn {
  flex: 1;
  padding: 10px 12px;
  border: none;
  border-radius: 8px;
  background: #2a2a4a;
  color: #eee;
  cursor: pointer;
  font-size: 13px;
  transition: background 0.2s;
}

.btn:hover {
  background: #3a3a5a;
}

.btn-sm {
  padding: 6px 12px;
  font-size: 12px;
}

.btn-primary {
  background: #6366f1;
  font-size: 18px;
  font-weight: bold;
  flex: 0 0 48px;
}

.btn-primary:hover {
  background: #5254cc;
}

.btn-save {
  background: #22c55e;
}

.btn-save:hover {
  background: #16a34a;
}

.session-summary {
  background: #2a2a4a;
  border-radius: 12px;
  padding: 12px;
}

.session-summary h3 {
  font-size: 12px;
  font-weight: 500;
  color: #888;
  margin-bottom: 12px;
  text-transform: uppercase;
}

.summary-stats {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 8px;
}

.summary-stat {
  text-align: center;
}

.summary-label {
  display: block;
  font-size: 10px;
  color: #666;
  margin-bottom: 4px;
}

.summary-value {
  font-size: 16px;
  font-weight: 600;
  color: #fff;
}
</style>
