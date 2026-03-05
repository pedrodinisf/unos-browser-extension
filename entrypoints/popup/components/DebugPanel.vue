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
    logs.value.push('OK Service worker responded: ' + JSON.stringify(response));
  } catch (err) {
    logs.value.push('ERR Service worker error: ' + (err instanceof Error ? err.message : String(err)));
  }
  await loadDebugInfo();
}

async function forceReconcile() {
  logs.value.push('Forcing reconciliation...');
  try {
    const response = await sendMessage({ type: 'FORCE_RECONCILE' });
    logs.value.push('OK Reconciliation complete: ' + JSON.stringify(response));
  } catch (err) {
    logs.value.push('ERR Reconciliation error: ' + (err instanceof Error ? err.message : String(err)));
  }
  await loadDebugInfo();
}

async function forceInit() {
  logs.value.push('Forcing initialization...');
  try {
    const response = await sendMessage({ type: 'FORCE_INIT' });
    logs.value.push('OK Initialization complete: ' + JSON.stringify(response));
  } catch (err) {
    logs.value.push('ERR Initialization error: ' + (err instanceof Error ? err.message : String(err)));
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
      <h2>Debug Panel</h2>
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
              {{ debugInfo.stats?.initialized ? 'Yes' : 'No' }}
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
        <h3>How to Debug</h3>
        <ol class="debug-instructions">
          <li>Click "Copy Console Cmd" and paste in Service Worker console</li>
          <li>Go to <code>chrome://extensions/</code></li>
          <li>Find UNOS - Click "service worker" (or "Inspect views")</li>
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
  padding: 16px;
  overflow-y: auto;
  height: 100%;
}

.debug-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 16px;
}

.debug-header h2 {
  font-size: 14px;
  font-weight: 600;
  color: var(--text-primary);
}

.debug-actions {
  display: flex;
  gap: 6px;
}

.debug-btn {
  background: var(--bg-alt);
  border: 1px solid var(--border-light);
  padding: 4px 10px;
  border-radius: 4px;
  cursor: pointer;
  font-size: 11px;
  color: var(--text-secondary);
  transition: all 0.15s;
}

.debug-btn:hover {
  background: var(--accent-green);
  color: #fff;
  border-color: var(--accent-green);
}

.debug-btn-sm {
  background: var(--bg-card);
  border: 1px solid var(--border-light);
  padding: 3px 8px;
  border-radius: 4px;
  cursor: pointer;
  font-size: 10px;
  color: var(--text-secondary);
  transition: all 0.15s;
}

.debug-btn-sm:hover {
  background: var(--accent-green);
  color: #fff;
  border-color: var(--accent-green);
}

.debug-buttons {
  display: flex;
  gap: 6px;
  margin-top: 10px;
}

.debug-loading,
.debug-error {
  padding: 40px;
  text-align: center;
  color: var(--text-muted);
}

.debug-error {
  color: var(--accent-red);
}

.debug-content {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.debug-section {
  background: var(--bg-card);
  border: 1px solid var(--border-light);
  border-radius: 6px;
  padding: 12px;
}

.debug-section h3 {
  font-size: 11px;
  font-weight: 600;
  color: var(--text-secondary);
  text-transform: uppercase;
  letter-spacing: 0.5px;
  margin-bottom: 10px;
}

.debug-info {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.debug-row {
  display: flex;
  align-items: center;
  gap: 12px;
  font-size: 12px;
}

.debug-label {
  color: var(--text-muted);
  min-width: 110px;
}

.debug-value {
  color: var(--text-primary);
  font-weight: 500;
}

.mono {
  font-family: var(--font-mono);
  font-size: 10px;
  word-break: break-all;
}

.debug-events {
  max-height: 180px;
  overflow-y: auto;
}

.debug-event {
  display: flex;
  gap: 10px;
  padding: 4px 0;
  font-size: 11px;
  border-bottom: 1px solid var(--border-light);
}

.event-time {
  color: var(--text-muted);
  min-width: 70px;
  font-family: var(--font-mono);
  font-size: 10px;
}

.event-type {
  color: var(--accent-green);
  min-width: 90px;
  font-weight: 500;
}

.event-data {
  color: var(--text-primary);
  flex: 1;
}

.debug-empty {
  color: var(--text-muted);
  font-size: 11px;
  font-style: italic;
  padding: 8px 0;
}

.debug-log {
  max-height: 180px;
  overflow-y: auto;
  background: var(--bg-alt);
  border-radius: 4px;
  padding: 8px;
}

.log-entry {
  font-size: 10px;
  font-family: var(--font-mono);
  color: var(--text-primary);
  padding: 3px 0;
  border-bottom: 1px solid var(--border-light);
}

.log-entry:last-child {
  border-bottom: none;
}

.debug-instructions {
  margin: 0;
  padding-left: 18px;
}

.debug-instructions li {
  margin-bottom: 6px;
  font-size: 11px;
  color: var(--text-primary);
  line-height: 1.5;
}

.debug-instructions code {
  background: var(--bg-alt);
  border: 1px solid var(--border-light);
  padding: 1px 4px;
  border-radius: 3px;
  font-size: 10px;
  font-family: var(--font-mono);
}

.status-success {
  color: var(--accent-green) !important;
  font-weight: 600;
}

.status-error {
  color: var(--accent-red) !important;
  font-weight: 600;
}
</style>
