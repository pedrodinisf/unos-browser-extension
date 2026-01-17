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
const recentTabs = computed(() => {
  return tabs.value
    .filter(t => !t.closedAt)
    .sort((a, b) => (b.lastActivatedAt || b.createdAt) - (a.lastActivatedAt || a.createdAt))
    .slice(0, 20);
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
        <h1 class="logo">UNOS</h1>
        <span class="version">v0.1</span>
      </div>
      <div class="header-center">
        <div class="stat-pill">
          <span class="stat-pill-icon">📊</span>
          <span class="stat-pill-text">{{ tabCount }} tabs</span>
        </div>
        <div class="stat-pill">
          <span class="stat-pill-icon">🪟</span>
          <span class="stat-pill-text">{{ windowCount }} windows</span>
        </div>
        <div class="stat-pill">
          <span class="stat-pill-icon">⏱️</span>
          <span class="stat-pill-text">{{ totalActiveTime }}</span>
        </div>
      </div>
      <div class="header-right">
        <button class="icon-btn" @click="showExportDialog = true" title="Export">
          📤
        </button>
        <button class="icon-btn" @click="handleShare" title="Share to PKM">
          🔗
        </button>
      </div>
    </header>

    <!-- Loading state -->
    <div v-if="loading" class="loading">
      <span class="spinner"></span>
      <p>Loading your browsing data...</p>
    </div>

    <!-- Error state -->
    <div v-else-if="error" class="error">
      <p>{{ error }}</p>
      <button @click="loadData" class="btn btn-sm">Retry</button>
    </div>

    <!-- Main content -->
    <main v-else class="main">
      <div class="content-grid">
        <!-- Left column: Current tab -->
        <div class="left-column">
          <section v-if="currentTab" class="current-tab-card">
            <div class="card-header">
              <h3 class="card-title">Current Tab</h3>
              <div class="card-actions">
                <button
                  v-if="!currentTab.isSaved"
                  class="action-btn save-btn"
                  @click="handleSaveTab"
                  title="Save tab"
                >
                  💾 Save
                </button>
                <span v-else class="saved-badge">✓ Saved</span>
              </div>
            </div>

            <div class="tab-main-info">
              <img
                v-if="currentTab.faviconUrl"
                :src="currentTab.faviconUrl"
                class="favicon-large"
                alt=""
              />
              <div class="tab-text">
                <h2 class="tab-title-large">{{ currentTab.title || 'Untitled' }}</h2>
                <p class="tab-url">{{ currentTab.url }}</p>
              </div>
            </div>

            <div class="stats-grid">
              <div class="stat-card">
                <div class="stat-icon">⏱️</div>
                <div class="stat-content">
                  <div class="stat-label">Active Time</div>
                  <div class="stat-value">{{ Math.round((currentTab.totalActiveTime || 0) / 60000) }}m</div>
                </div>
              </div>
              <div class="stat-card">
                <div class="stat-icon">🕐</div>
                <div class="stat-content">
                  <div class="stat-label">Created</div>
                  <div class="stat-value">{{ new Date(currentTab.createdAt).toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'}) }}</div>
                </div>
              </div>
              <div class="stat-card">
                <div class="stat-icon">👁️</div>
                <div class="stat-content">
                  <div class="stat-label">Last Active</div>
                  <div class="stat-value">{{ new Date(currentTab.lastActivatedAt || currentTab.createdAt).toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'}) }}</div>
                </div>
              </div>
            </div>

            <!-- Tags -->
            <div class="tags-section">
              <div class="tags-header">
                <span class="tags-label">Tags</span>
                <button class="add-tag-btn" @click="showMetadataPanel = !showMetadataPanel">
                  {{ showMetadataPanel ? '✕' : '+ Add' }}
                </button>
              </div>
              <div v-if="currentTab.tags && currentTab.tags.length > 0" class="tags">
                <span v-for="tag in currentTab.tags" :key="tag" class="tag">{{ tag }}</span>
              </div>
              <div v-else class="no-tags">No tags yet</div>
            </div>

            <!-- Notes preview -->
            <div v-if="currentTab.notes" class="notes-preview">
              <div class="notes-label">Notes</div>
              <div class="notes-text">{{ currentTab.notes }}</div>
            </div>
          </section>

          <!-- Metadata panel -->
          <MetadataPanel
            v-if="showMetadataPanel && currentTab"
            :tab="currentTab"
            @update="handleMetadataUpdate"
            @close="showMetadataPanel = false"
          />
        </div>

        <!-- Right column: Recent tabs -->
        <div class="right-column">
          <section class="recent-tabs-section">
            <h3 class="section-title">Recent Tabs ({{ recentTabs.length }})</h3>

            <div class="tabs-list">
              <div
                v-for="tab in recentTabs"
                :key="tab.persistentId"
                class="tab-item"
                :class="{ 'is-current': currentTab && tab.persistentId === currentTab.persistentId }"
              >
                <img
                  v-if="tab.faviconUrl"
                  :src="tab.faviconUrl"
                  class="tab-item-favicon"
                  alt=""
                />
                <div class="tab-item-favicon-placeholder" v-else>
                  🌐
                </div>
                <div class="tab-item-info">
                  <div class="tab-item-title">{{ tab.title || 'Untitled' }}</div>
                  <div class="tab-item-meta">
                    <span class="tab-item-time">{{ Math.round((tab.totalActiveTime || 0) / 60000) }}m</span>
                    <span v-if="tab.isSaved" class="tab-item-saved">💾</span>
                    <span v-if="tab.tags && tab.tags.length > 0" class="tab-item-tags">
                      🏷️ {{ tab.tags.length }}
                    </span>
                  </div>
                </div>
              </div>

              <div v-if="recentTabs.length === 0" class="empty-state">
                <div class="empty-icon">📭</div>
                <div class="empty-text">No tabs tracked yet</div>
              </div>
            </div>
          </section>
        </div>
      </div>
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
  width: 700px;
  height: 700px;
  overflow: hidden;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  background: linear-gradient(135deg, #0f0f1e 0%, #1a1a2e 50%, #16213e 100%);
  color: #eee;
  display: flex;
  flex-direction: column;
}

/* Header */
.header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 20px;
  background: rgba(26, 26, 46, 0.8);
  backdrop-filter: blur(10px);
  border-bottom: 1px solid rgba(99, 102, 241, 0.2);
  position: sticky;
  top: 0;
  z-index: 10;
}

.header-left {
  display: flex;
  align-items: baseline;
  gap: 10px;
}

.logo {
  font-size: 24px;
  font-weight: 700;
  background: linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%);
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  background-clip: text;
}

.version {
  font-size: 11px;
  color: #666;
  font-weight: 500;
}

.header-center {
  display: flex;
  gap: 12px;
}

.stat-pill {
  display: flex;
  align-items: center;
  gap: 6px;
  background: rgba(42, 42, 74, 0.6);
  padding: 6px 12px;
  border-radius: 20px;
  border: 1px solid rgba(99, 102, 241, 0.2);
}

.stat-pill-icon {
  font-size: 14px;
}

.stat-pill-text {
  font-size: 12px;
  font-weight: 500;
  color: #ddd;
}

.header-right {
  display: flex;
  gap: 8px;
}

.icon-btn {
  background: rgba(99, 102, 241, 0.2);
  border: 1px solid rgba(99, 102, 241, 0.3);
  padding: 8px 12px;
  border-radius: 8px;
  cursor: pointer;
  font-size: 16px;
  transition: all 0.2s;
}

.icon-btn:hover {
  background: rgba(99, 102, 241, 0.4);
  transform: translateY(-1px);
}

/* Loading & Error */
.loading, .error {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 60px 20px;
  gap: 16px;
  color: #888;
  flex: 1;
}

.spinner {
  width: 32px;
  height: 32px;
  border: 3px solid rgba(99, 102, 241, 0.2);
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

/* Main content */
.main {
  flex: 1;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

.content-grid {
  display: grid;
  grid-template-columns: 1.2fr 1fr;
  gap: 16px;
  padding: 16px 20px;
  height: 100%;
  overflow: hidden;
}

.left-column, .right-column {
  display: flex;
  flex-direction: column;
  gap: 16px;
  overflow-y: auto;
  overflow-x: hidden;
}

/* Scrollbar styling */
.left-column::-webkit-scrollbar, .right-column::-webkit-scrollbar {
  width: 6px;
}

.left-column::-webkit-scrollbar-track, .right-column::-webkit-scrollbar-track {
  background: rgba(42, 42, 74, 0.3);
  border-radius: 3px;
}

.left-column::-webkit-scrollbar-thumb, .right-column::-webkit-scrollbar-thumb {
  background: rgba(99, 102, 241, 0.5);
  border-radius: 3px;
}

.left-column::-webkit-scrollbar-thumb:hover, .right-column::-webkit-scrollbar-thumb:hover {
  background: rgba(99, 102, 241, 0.7);
}

/* Current tab card */
.current-tab-card {
  background: rgba(42, 42, 74, 0.6);
  border: 1px solid rgba(99, 102, 241, 0.2);
  border-radius: 16px;
  padding: 20px;
  backdrop-filter: blur(10px);
}

.card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 16px;
}

.card-title {
  font-size: 13px;
  font-weight: 600;
  color: #888;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.card-actions {
  display: flex;
  gap: 8px;
}

.action-btn {
  background: rgba(99, 102, 241, 0.2);
  border: 1px solid rgba(99, 102, 241, 0.3);
  padding: 6px 12px;
  border-radius: 8px;
  cursor: pointer;
  font-size: 12px;
  color: #ddd;
  transition: all 0.2s;
  font-weight: 500;
}

.action-btn:hover {
  background: rgba(99, 102, 241, 0.4);
  transform: translateY(-1px);
}

.save-btn {
  background: rgba(34, 197, 94, 0.2);
  border-color: rgba(34, 197, 94, 0.3);
}

.save-btn:hover {
  background: rgba(34, 197, 94, 0.4);
}

.saved-badge {
  background: rgba(34, 197, 94, 0.2);
  border: 1px solid rgba(34, 197, 94, 0.3);
  padding: 6px 12px;
  border-radius: 8px;
  font-size: 12px;
  color: #4ade80;
  font-weight: 500;
}

.tab-main-info {
  display: flex;
  gap: 16px;
  margin-bottom: 20px;
  align-items: flex-start;
}

.favicon-large {
  width: 48px;
  height: 48px;
  border-radius: 12px;
  background: rgba(58, 58, 90, 0.6);
  flex-shrink: 0;
  border: 1px solid rgba(99, 102, 241, 0.2);
}

.tab-text {
  flex: 1;
  overflow: hidden;
}

.tab-title-large {
  font-size: 16px;
  font-weight: 600;
  margin-bottom: 8px;
  color: #fff;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.tab-url {
  font-size: 12px;
  color: #888;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.stats-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 12px;
  margin-bottom: 20px;
}

.stat-card {
  background: rgba(58, 58, 90, 0.4);
  border: 1px solid rgba(99, 102, 241, 0.15);
  border-radius: 12px;
  padding: 12px;
  display: flex;
  align-items: center;
  gap: 10px;
}

.stat-icon {
  font-size: 20px;
}

.stat-content {
  flex: 1;
}

.stat-label {
  font-size: 10px;
  color: #888;
  text-transform: uppercase;
  margin-bottom: 4px;
}

.stat-value {
  font-size: 14px;
  font-weight: 600;
  color: #fff;
}

.tags-section {
  margin-bottom: 16px;
}

.tags-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 10px;
}

.tags-label {
  font-size: 11px;
  font-weight: 600;
  color: #888;
  text-transform: uppercase;
}

.add-tag-btn {
  background: rgba(99, 102, 241, 0.2);
  border: 1px solid rgba(99, 102, 241, 0.3);
  padding: 4px 10px;
  border-radius: 6px;
  cursor: pointer;
  font-size: 11px;
  color: #ddd;
  transition: all 0.2s;
}

.add-tag-btn:hover {
  background: rgba(99, 102, 241, 0.4);
}

.tags {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.tag {
  background: linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%);
  color: #fff;
  padding: 4px 10px;
  border-radius: 12px;
  font-size: 11px;
  font-weight: 500;
}

.no-tags {
  font-size: 12px;
  color: #666;
  font-style: italic;
}

.notes-preview {
  margin-top: 16px;
  padding-top: 16px;
  border-top: 1px solid rgba(99, 102, 241, 0.15);
}

.notes-label {
  font-size: 11px;
  font-weight: 600;
  color: #888;
  text-transform: uppercase;
  margin-bottom: 8px;
}

.notes-text {
  font-size: 12px;
  color: #bbb;
  line-height: 1.5;
  max-height: 60px;
  overflow-y: auto;
}

/* Recent tabs section */
.recent-tabs-section {
  background: rgba(42, 42, 74, 0.6);
  border: 1px solid rgba(99, 102, 241, 0.2);
  border-radius: 16px;
  padding: 20px;
  backdrop-filter: blur(10px);
  display: flex;
  flex-direction: column;
  height: 100%;
}

.section-title {
  font-size: 13px;
  font-weight: 600;
  color: #888;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  margin-bottom: 16px;
}

.tabs-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  overflow-y: auto;
  flex: 1;
}

.tab-item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px;
  background: rgba(58, 58, 90, 0.4);
  border: 1px solid rgba(99, 102, 241, 0.15);
  border-radius: 10px;
  cursor: pointer;
  transition: all 0.2s;
}

.tab-item:hover {
  background: rgba(58, 58, 90, 0.6);
  border-color: rgba(99, 102, 241, 0.3);
  transform: translateX(4px);
}

.tab-item.is-current {
  background: rgba(99, 102, 241, 0.2);
  border-color: rgba(99, 102, 241, 0.4);
}

.tab-item-favicon {
  width: 24px;
  height: 24px;
  border-radius: 6px;
  background: rgba(58, 58, 90, 0.6);
  flex-shrink: 0;
}

.tab-item-favicon-placeholder {
  width: 24px;
  height: 24px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 14px;
  flex-shrink: 0;
}

.tab-item-info {
  flex: 1;
  overflow: hidden;
}

.tab-item-title {
  font-size: 12px;
  font-weight: 500;
  color: #ddd;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  margin-bottom: 4px;
}

.tab-item-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 11px;
  color: #888;
}

.tab-item-time {
  color: #888;
}

.tab-item-saved, .tab-item-tags {
  font-size: 10px;
}

.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 40px 20px;
  gap: 12px;
}

.empty-icon {
  font-size: 48px;
  opacity: 0.5;
}

.empty-text {
  font-size: 13px;
  color: #666;
}

/* Button styles */
.btn {
  padding: 8px 16px;
  border: none;
  border-radius: 8px;
  background: rgba(42, 42, 74, 0.8);
  color: #eee;
  cursor: pointer;
  font-size: 13px;
  transition: all 0.2s;
}

.btn:hover {
  background: rgba(58, 58, 90, 0.8);
  transform: translateY(-1px);
}

.btn-sm {
  padding: 6px 12px;
  font-size: 12px;
}
</style>
