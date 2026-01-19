<script setup lang="ts">
import { ref, onMounted } from 'vue';

const debugInfo = ref<any>(null);
const loading = ref(true);
const error = ref<string | null>(null);
const logs = ref<string[]>([]);

async function loadDebugInfo() {
  try {
    loading.value = true;
    error.value = null;

    // Get session info
    const sessionResponse = await sendMessage({ type: 'GET_CURRENT_SESSION' });

    // Get database stats
    const statsResponse = await sendMessage({ type: 'GET_DEBUG_STATS' });

    // Get recent events
    const eventsResponse = await sendMessage({ type: 'GET_RECENT_EVENTS' });

    debugInfo.value = {
      session: sessionResponse.data,
      stats: statsResponse.data,
      events: eventsResponse.data || [],
      timestamp: new Date().toISOString(),
    };

    loading.value = false;
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Failed to load debug info';
    loading.value = false;
  }
}

async function sendMessage<T>(message: Record<string, unknown>): Promise<T> {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else if (response?.success) {
        resolve(response as T);
      } else {
        reject(new Error(response?.error || 'Unknown error'));
      }
    });
  });
}

function copyDebugInfo() {
  const text = JSON.stringify(debugInfo.value, null, 2);
  navigator.clipboard.writeText(text);
  alert('Debug info copied to clipboard!');
}

function copyConsoleCommand() {
  const command = `
// Run this in the Service Worker console (chrome://extensions -> UNOS -> service worker)
console.log('=== UNOS DEBUG INFO ===');
console.log('Session ID:', await chrome.storage.session.get('currentSessionId'));
console.log('Active Tab:', await chrome.storage.session.get('activeTabPersistentId'));
console.log('Chrome ID Map:', await chrome.storage.session.get('chromeIdToPersistentIdMap'));
  `.trim();

  navigator.clipboard.writeText(command);
  alert('Console command copied! Paste it in the Service Worker console.');
}

async function testServiceWorker() {
  logs.value.push('Testing service worker...');
  try {
    const response = await sendMessage({ type: 'PING' });
    logs.value.push('✓ Service worker responded: ' + JSON.stringify(response));
  } catch (err) {
    logs.value.push('✗ Service worker error: ' + (err instanceof Error ? err.message : String(err)));
  }
  await loadDebugInfo();
}

async function forceReconcile() {
  logs.value.push('Forcing reconciliation...');
  try {
    const response = await sendMessage({ type: 'FORCE_RECONCILE' });
    logs.value.push('✓ Reconciliation complete: ' + JSON.stringify(response));
  } catch (err) {
    logs.value.push('✗ Reconciliation error: ' + (err instanceof Error ? err.message : String(err)));
  }
  await loadDebugInfo();
}

async function forceInit() {
  logs.value.push('Forcing initialization...');
  try {
    const response = await sendMessage({ type: 'FORCE_INIT' });
    logs.value.push('✓ Initialization complete: ' + JSON.stringify(response));
  } catch (err) {
    logs.value.push('✗ Initialization error: ' + (err instanceof Error ? err.message : String(err)));
  }
  await loadDebugInfo();
}

onMounted(() => {
  loadDebugInfo();
});
</script>

<template>
  <div class="debug-panel">
    <div class="debug-header">
      <h2>🔧 Debug Panel</h2>
      <div class="debug-actions">
        <button class="debug-btn" @click="loadDebugInfo">Refresh</button>
        <button class="debug-btn" @click="copyDebugInfo" v-if="debugInfo">Copy JSON</button>
        <button class="debug-btn" @click="copyConsoleCommand">Copy Console Cmd</button>
      </div>
    </div>

    <div v-if="loading" class="debug-loading">Loading debug info...</div>
    <div v-else-if="error" class="debug-error">{{ error }}</div>
    <div v-else-if="debugInfo" class="debug-content">
      <!-- Service Worker Status -->
      <div class="debug-section">
        <h3>Service Worker</h3>
        <div class="debug-info">
          <div class="debug-row">
            <span class="debug-label">Status:</span>
            <span class="debug-value">Active</span>
          </div>
          <div class="debug-row">
            <span class="debug-label">Initialized:</span>
            <span class="debug-value" :class="{ 'status-success': debugInfo.stats?.initialized, 'status-error': !debugInfo.stats?.initialized }">
              {{ debugInfo.stats?.initialized ? '✓ Yes' : '✗ No' }}
            </span>
          </div>
          <div class="debug-row">
            <span class="debug-label">Last Check:</span>
            <span class="debug-value">{{ new Date().toLocaleTimeString() }}</span>
          </div>
        </div>
        <div class="debug-buttons">
          <button class="debug-btn-sm" @click="testServiceWorker">Test Ping</button>
          <button class="debug-btn-sm" @click="forceInit">Force Init</button>
          <button class="debug-btn-sm" @click="forceReconcile">Force Reconcile</button>
        </div>
      </div>

      <!-- Session Info -->
      <div class="debug-section">
        <h3>Session</h3>
        <div class="debug-info">
          <div class="debug-row">
            <span class="debug-label">Session ID:</span>
            <span class="debug-value mono">{{ debugInfo.session?.sessionId || 'None' }}</span>
          </div>
        </div>
      </div>

      <!-- Database Stats -->
      <div class="debug-section">
        <h3>Database Stats</h3>
        <div class="debug-info">
          <div class="debug-row">
            <span class="debug-label">Sessions:</span>
            <span class="debug-value">{{ debugInfo.stats?.sessionCount || 0 }}</span>
          </div>
          <div class="debug-row">
            <span class="debug-label">Windows:</span>
            <span class="debug-value">{{ debugInfo.stats?.windowCount || 0 }}</span>
          </div>
          <div class="debug-row">
            <span class="debug-label">Tabs:</span>
            <span class="debug-value">{{ debugInfo.stats?.tabCount || 0 }}</span>
          </div>
          <div class="debug-row">
            <span class="debug-label">Visits:</span>
            <span class="debug-value">{{ debugInfo.stats?.visitCount || 0 }}</span>
          </div>
          <div class="debug-row">
            <span class="debug-label">Relationships:</span>
            <span class="debug-value">{{ debugInfo.stats?.relationshipCount || 0 }}</span>
          </div>
        </div>
      </div>

      <!-- Recent Events -->
      <div class="debug-section">
        <h3>Recent Events (last 10)</h3>
        <div class="debug-events">
          <div v-if="debugInfo.events && debugInfo.events.length > 0">
            <div v-for="(event, idx) in debugInfo.events" :key="idx" class="debug-event">
              <span class="event-time">{{ new Date(event.timestamp).toLocaleTimeString() }}</span>
              <span class="event-type">{{ event.type }}</span>
              <span class="event-data">{{ event.data }}</span>
            </div>
          </div>
          <div v-else class="debug-empty">No events tracked yet</div>
        </div>
      </div>

      <!-- Test Log -->
      <div class="debug-section" v-if="logs.length > 0">
        <h3>Test Log</h3>
        <div class="debug-log">
          <div v-for="(log, idx) in logs" :key="idx" class="log-entry">{{ log }}</div>
        </div>
      </div>

      <!-- Instructions -->
      <div class="debug-section">
        <h3>📋 How to Debug</h3>
        <ol class="debug-instructions">
          <li>Click "Copy Console Cmd" and paste in Service Worker console</li>
          <li>Go to <code>chrome://extensions/</code></li>
          <li>Find UNOS → Click "service worker" (or "Inspect views")</li>
          <li>Look for console logs starting with <code>[UNOS]</code></li>
          <li>Open/close tabs and watch for tracking events</li>
          <li>Copy any errors and share them</li>
        </ol>
      </div>
    </div>
  </div>
</template>

<style scoped>
.debug-panel {
  padding: 20px;
  max-width: 800px;
  margin: 0 auto;
}

.debug-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 24px;
}

.debug-header h2 {
  font-size: 18px;
  font-weight: 600;
}

.debug-actions {
  display: flex;
  gap: 8px;
}

.debug-btn {
  background: rgba(99, 102, 241, 0.2);
  border: 1px solid rgba(99, 102, 241, 0.3);
  padding: 6px 12px;
  border-radius: 6px;
  cursor: pointer;
  font-size: 12px;
  color: #ddd;
  transition: all 0.2s;
}

.debug-btn:hover {
  background: rgba(99, 102, 241, 0.4);
}

.debug-btn-sm {
  background: rgba(99, 102, 241, 0.15);
  border: 1px solid rgba(99, 102, 241, 0.25);
  padding: 4px 10px;
  border-radius: 6px;
  cursor: pointer;
  font-size: 11px;
  color: #ddd;
  transition: all 0.2s;
}

.debug-btn-sm:hover {
  background: rgba(99, 102, 241, 0.3);
}

.debug-buttons {
  display: flex;
  gap: 8px;
  margin-top: 12px;
}

.debug-loading,
.debug-error {
  padding: 40px;
  text-align: center;
  color: #888;
}

.debug-error {
  color: #ef4444;
}

.debug-content {
  display: flex;
  flex-direction: column;
  gap: 20px;
}

.debug-section {
  background: rgba(42, 42, 74, 0.4);
  border: 1px solid rgba(99, 102, 241, 0.2);
  border-radius: 12px;
  padding: 16px;
}

.debug-section h3 {
  font-size: 13px;
  font-weight: 600;
  color: #888;
  text-transform: uppercase;
  margin-bottom: 12px;
}

.debug-info {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.debug-row {
  display: flex;
  align-items: center;
  gap: 12px;
  font-size: 13px;
}

.debug-label {
  color: #888;
  min-width: 120px;
}

.debug-value {
  color: #ddd;
  font-weight: 500;
}

.mono {
  font-family: 'Monaco', 'Menlo', monospace;
  font-size: 11px;
  word-break: break-all;
}

.debug-events {
  max-height: 200px;
  overflow-y: auto;
}

.debug-event {
  display: flex;
  gap: 12px;
  padding: 6px 0;
  font-size: 12px;
  border-bottom: 1px solid rgba(99, 102, 241, 0.1);
}

.event-time {
  color: #888;
  min-width: 80px;
}

.event-type {
  color: #6366f1;
  min-width: 100px;
  font-weight: 500;
}

.event-data {
  color: #ddd;
  flex: 1;
}

.debug-empty {
  color: #666;
  font-size: 12px;
  font-style: italic;
  padding: 12px 0;
}

.debug-log {
  max-height: 200px;
  overflow-y: auto;
  background: rgba(0, 0, 0, 0.3);
  border-radius: 8px;
  padding: 12px;
}

.log-entry {
  font-size: 11px;
  font-family: 'Monaco', 'Menlo', monospace;
  color: #ddd;
  padding: 4px 0;
  border-bottom: 1px solid rgba(99, 102, 241, 0.1);
}

.log-entry:last-child {
  border-bottom: none;
}

.debug-instructions {
  margin: 0;
  padding-left: 20px;
}

.debug-instructions li {
  margin-bottom: 8px;
  font-size: 12px;
  color: #ddd;
  line-height: 1.6;
}

.debug-instructions code {
  background: rgba(99, 102, 241, 0.2);
  padding: 2px 6px;
  border-radius: 4px;
  font-size: 11px;
  font-family: 'Monaco', 'Menlo', monospace;
}

.status-success {
  color: #4ade80 !important;
  font-weight: 600;
}

.status-error {
  color: #ef4444 !important;
  font-weight: 600;
}
</style>
