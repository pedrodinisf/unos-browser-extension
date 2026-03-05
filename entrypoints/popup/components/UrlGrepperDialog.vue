<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue';

const emit = defineEmits<{
  close: [];
}>();

const enabled = ref(false);
const grepStr = ref('');
const urlList = ref<string[]>([]);
const statusMsg = ref('');
const statusIsError = ref(false);

let debounceTimer: ReturnType<typeof setTimeout> | null = null;

function setStatus(message: string, isError = false) {
  statusMsg.value = message;
  statusIsError.value = isError;
  if (message) {
    setTimeout(() => {
      if (statusMsg.value === message) statusMsg.value = '';
    }, 3000);
  }
}

function loadData() {
  chrome.storage.local.get(
    ['urlGrepper_enabled', 'urlGrepper_grepStr', 'urlGrepper_urlList'],
    (data) => {
      if (chrome.runtime.lastError) {
        setStatus('Error loading data', true);
        return;
      }
      enabled.value = !!data.urlGrepper_enabled;
      grepStr.value = data.urlGrepper_grepStr || '';
      urlList.value = data.urlGrepper_urlList || [];
    },
  );
}

async function toggleEnabled() {
  enabled.value = !enabled.value;
  chrome.storage.local.set({ urlGrepper_enabled: enabled.value });

  // When enabling, inject the content script into the active tab.
  // Handles pages that were already open before the extension was installed/updated
  // (Chrome doesn't retroactively inject manifest content scripts).
  // WXT's dedup ensures safe re-injection if the script is already present.
  if (enabled.value) {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab?.id) {
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          files: ['content-scripts/url-grepper.js'],
        });
      }
    } catch {
      // Fails silently for restricted pages (chrome://, about:, etc.)
    }
  }
}

function onGrepInput() {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    chrome.storage.local.set({ urlGrepper_grepStr: grepStr.value });
  }, 300);
}

function clearList() {
  if (!confirm('Clear all collected URLs?')) return;
  chrome.storage.local.set({ urlGrepper_urlList: [] }, () => {
    if (chrome.runtime.lastError) {
      setStatus('Error clearing list', true);
    } else {
      urlList.value = [];
      setStatus('List cleared');
    }
  });
}

function downloadList() {
  if (urlList.value.length === 0) {
    setStatus('No URLs to download', true);
    return;
  }
  const text = urlList.value.join('\n');
  const blob = new Blob([text], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  chrome.downloads.download(
    { url, filename: 'unos/urls.txt', saveAs: false },
    () => {
      if (chrome.runtime.lastError) {
        setStatus('Download failed', true);
      } else {
        setStatus(`Downloaded ${urlList.value.length} URL${urlList.value.length !== 1 ? 's' : ''}`);
      }
      URL.revokeObjectURL(url);
    },
  );
}

function onStorageChanged(changes: { [key: string]: chrome.storage.StorageChange }, area: string) {
  if (area === 'local' && changes.urlGrepper_urlList) {
    urlList.value = changes.urlGrepper_urlList.newValue || [];
  }
}

onMounted(() => {
  loadData();
  chrome.storage.onChanged.addListener(onStorageChanged);
});

onUnmounted(() => {
  chrome.storage.onChanged.removeListener(onStorageChanged);
  if (debounceTimer) clearTimeout(debounceTimer);
});
</script>

<template>
  <div class="dialog-overlay" @click.self="$emit('close')">
    <div class="dialog">
      <div class="dialog-header">
        <h2>URL Grepper</h2>
        <button class="close-btn" @click="$emit('close')">&times;</button>
      </div>

      <div class="dialog-content">
        <!-- Toggle -->
        <button
          class="toggle-btn"
          :class="enabled ? 'toggle-on' : 'toggle-off'"
          @click="toggleEnabled"
        >
          {{ enabled ? 'Enabled' : 'Enable' }}
        </button>

        <!-- Grep input -->
        <div class="field">
          <label class="field-label">Filter</label>
          <input
            type="text"
            v-model="grepStr"
            @input="onGrepInput"
            placeholder="Filter substring..."
            class="grep-input"
          />
        </div>

        <!-- URL list -->
        <div class="field">
          <label class="field-label">Collected URLs ({{ urlList.length }})</label>
          <div class="url-list">
            <div v-if="urlList.length === 0" class="empty">No matching URLs yet.</div>
            <div v-for="(url, i) in urlList" :key="i" class="url-item">{{ url }}</div>
          </div>
        </div>

        <!-- Status -->
        <div
          v-if="statusMsg"
          class="status-msg"
          :class="statusIsError ? 'status-error' : 'status-success'"
        >
          {{ statusMsg }}
        </div>
      </div>

      <div class="dialog-footer">
        <button class="btn btn-cancel" @click="clearList">Clear</button>
        <button class="btn btn-primary" @click="downloadList">Download urls.txt</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.dialog-overlay {
  position: fixed;
  top: 0; left: 0; right: 0; bottom: 0;
  background: var(--bg-overlay);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 100;
}

.dialog {
  background: var(--bg-card);
  border-radius: 8px;
  width: 360px;
  max-height: 80vh;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  border: 1px solid var(--border-light);
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.2);
}

.dialog-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 16px;
  border-bottom: 1px solid var(--border-light);
}

.dialog-header h2 {
  font-size: 14px;
  font-weight: 600;
  color: var(--text-primary);
}

.close-btn {
  background: none;
  border: none;
  color: var(--text-muted);
  font-size: 20px;
  cursor: pointer;
  line-height: 1;
}

.close-btn:hover {
  color: var(--text-primary);
}

.dialog-content {
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 14px;
  overflow-y: auto;
  flex: 1;
  min-height: 0;
}

.toggle-btn {
  width: 100%;
  padding: 8px 12px;
  border: 1px solid var(--border-light);
  border-radius: 4px;
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.15s;
}

.toggle-off {
  background: var(--bg-alt);
  color: var(--text-primary);
}

.toggle-off:hover {
  background: var(--border-warm);
}

.toggle-on {
  background: var(--accent-green);
  color: #fff;
  border-color: var(--accent-green);
}

.toggle-on:hover {
  background: #047857;
  border-color: #047857;
}

.field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.field-label {
  font-size: 10px;
  font-weight: 600;
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.grep-input {
  width: 100%;
  padding: 6px 8px;
  border: 1px solid var(--border-light);
  border-radius: 4px;
  font-size: 12px;
  background: var(--bg-page);
  color: var(--text-primary);
  transition: border-color 0.15s;
}

.grep-input:focus {
  outline: none;
  border-color: var(--accent-green);
  box-shadow: 0 0 0 2px rgba(5, 150, 105, 0.1);
}

.url-list {
  max-height: 250px;
  overflow-y: auto;
  border: 1px solid var(--border-light);
  border-radius: 4px;
  padding: 6px;
  background: var(--bg-page);
  font-family: var(--font-mono);
  font-size: 11px;
}

.url-list::-webkit-scrollbar {
  width: 6px;
}

.url-list::-webkit-scrollbar-track {
  background: var(--bg-alt);
}

.url-list::-webkit-scrollbar-thumb {
  background: var(--border-warm);
  border-radius: 3px;
}

.empty {
  color: var(--text-muted);
  text-align: center;
  padding: 20px;
  font-style: italic;
  font-family: inherit;
}

.url-item {
  word-break: break-all;
  padding: 3px 4px;
  border-radius: 2px;
  line-height: 1.4;
  color: var(--text-primary);
}

.url-item:hover {
  background: var(--bg-alt);
}

.status-msg {
  font-size: 11px;
  padding: 6px 10px;
  border-radius: 4px;
}

.status-success {
  background: rgba(5, 150, 105, 0.08);
  color: var(--accent-green);
  border: 1px solid rgba(5, 150, 105, 0.2);
}

.status-error {
  background: rgba(220, 38, 38, 0.06);
  color: var(--accent-red);
  border: 1px solid rgba(220, 38, 38, 0.2);
}

.dialog-footer {
  display: flex;
  gap: 8px;
  padding: 14px 16px;
  border-top: 1px solid var(--border-light);
}

.btn {
  flex: 1;
  padding: 10px 14px;
  border: none;
  border-radius: 4px;
  font-size: 12px;
  cursor: pointer;
  transition: background 0.15s;
}

.btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.btn-cancel {
  background: var(--bg-alt);
  color: var(--text-primary);
  border: 1px solid var(--border-light);
}

.btn-cancel:hover:not(:disabled) {
  background: var(--border-warm);
}

.btn-primary {
  background: var(--accent-green);
  color: #fff;
}

.btn-primary:hover:not(:disabled) {
  background: #047857;
}
</style>
