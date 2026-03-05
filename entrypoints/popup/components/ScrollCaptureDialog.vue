<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue';

const emit = defineEmits<{
  close: [];
}>();

const delay = ref(500);
const status = ref<string | null>(null);
const progress = ref(0);
const errorMsg = ref<string | null>(null);
const capturing = ref(false);

let clearTimer: ReturnType<typeof setTimeout> | null = null;

function loadCaptureStatus() {
  chrome.storage.local.get(
    ['capture_status', 'capture_progress', 'capture_error'],
    (data) => {
      if (chrome.runtime.lastError) return;
      updateUI(data.capture_status, data.capture_progress, data.capture_error);
    },
  );
}

function updateUI(s: string | null, p: number | null, e: string | null) {
  status.value = s || null;
  progress.value = p || 0;
  errorMsg.value = e || null;

  if (s === 'capturing' || s === 'stitching') {
    capturing.value = true;
  } else {
    capturing.value = false;
  }

  if (s === 'done' || s === 'error') {
    if (clearTimer) clearTimeout(clearTimer);
    clearTimer = setTimeout(() => {
      chrome.storage.local.remove(['capture_status', 'capture_progress', 'capture_error']);
      status.value = null;
      progress.value = 0;
      errorMsg.value = null;
    }, 5000);
  }
}

function onStorageChanged(changes: { [key: string]: chrome.storage.StorageChange }, area: string) {
  if (area !== 'local') return;
  if (changes.capture_status || changes.capture_progress || changes.capture_error) {
    loadCaptureStatus();
  }
}

async function startCapture() {
  capturing.value = true;
  status.value = 'capturing';
  progress.value = 0;
  errorMsg.value = null;

  chrome.runtime.sendMessage(
    { type: 'START_CAPTURE', options: { delay: delay.value } },
    (response) => {
      if (chrome.runtime.lastError) {
        errorMsg.value = chrome.runtime.lastError.message || 'Failed to start capture';
        capturing.value = false;
        status.value = 'error';
      }
    },
  );
}

function getStatusText(): string {
  if (status.value === 'capturing') return `Capturing... ${progress.value}%`;
  if (status.value === 'stitching') return 'Stitching frames...';
  if (status.value === 'done') return 'Done! Saved to Downloads.';
  if (status.value === 'error') return `Error: ${errorMsg.value || 'Capture failed'}`;
  return '';
}

function getProgressWidth(): string {
  if (status.value === 'stitching') return '96%';
  if (status.value === 'done') return '100%';
  return progress.value + '%';
}

onMounted(() => {
  loadCaptureStatus();
  chrome.storage.onChanged.addListener(onStorageChanged);
});

onUnmounted(() => {
  chrome.storage.onChanged.removeListener(onStorageChanged);
  if (clearTimer) clearTimeout(clearTimer);
});
</script>

<template>
  <div class="dialog-overlay" @click.self="$emit('close')">
    <div class="dialog">
      <div class="dialog-header">
        <h2>Scroll Screenshot</h2>
        <button class="close-btn" @click="$emit('close')">&times;</button>
      </div>

      <div class="dialog-content">
        <!-- Scroll delay -->
        <div class="field">
          <label class="field-label">Scroll Delay</label>
          <div class="radio-group">
            <label class="radio-option" :class="{ selected: delay === 300 }">
              <input type="radio" v-model.number="delay" :value="300" :disabled="capturing" />
              <div class="radio-content">
                <span class="radio-title">300ms</span>
                <span class="radio-desc">Fast</span>
              </div>
            </label>
            <label class="radio-option" :class="{ selected: delay === 500 }">
              <input type="radio" v-model.number="delay" :value="500" :disabled="capturing" />
              <div class="radio-content">
                <span class="radio-title">500ms</span>
                <span class="radio-desc">Normal</span>
              </div>
            </label>
            <label class="radio-option" :class="{ selected: delay === 1000 }">
              <input type="radio" v-model.number="delay" :value="1000" :disabled="capturing" />
              <div class="radio-content">
                <span class="radio-title">1000ms</span>
                <span class="radio-desc">Slow (for heavy pages)</span>
              </div>
            </label>
          </div>
        </div>

        <!-- Info -->
        <div class="info-box">
          Scrolls the active tab from top to bottom, capturing each viewport and stitching into a single full-page PNG. Sticky elements are temporarily hidden.
        </div>

        <!-- Progress -->
        <div v-if="status" class="progress-section">
          <div class="progress-bar-bg">
            <div class="progress-bar-fill" :style="{ width: getProgressWidth() }"></div>
          </div>
          <div
            class="progress-text"
            :class="{ 'progress-error': status === 'error', 'progress-done': status === 'done' }"
          >
            {{ getStatusText() }}
          </div>
        </div>
      </div>

      <div class="dialog-footer">
        <button class="btn btn-cancel" @click="$emit('close')">Cancel</button>
        <button
          class="btn btn-primary"
          @click="startCapture"
          :disabled="capturing"
        >
          {{ capturing ? 'Capturing...' : 'Capture Full Page' }}
        </button>
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

.field {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.field-label {
  font-size: 10px;
  font-weight: 600;
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.radio-group {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.radio-option {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  cursor: pointer;
  padding: 8px 10px;
  border-radius: 6px;
  border: 1px solid var(--border-light);
  transition: all 0.15s;
}

.radio-option:hover {
  border-color: var(--border-warm);
  background: var(--bg-alt);
}

.radio-option.selected {
  border-color: var(--accent-green);
  background: rgba(5, 150, 105, 0.06);
}

.radio-option input {
  accent-color: var(--accent-green);
  width: 14px;
  height: 14px;
  cursor: pointer;
  margin-top: 2px;
}

.radio-content {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.radio-title {
  font-size: 12px;
  font-weight: 500;
  color: var(--text-primary);
}

.radio-desc {
  font-size: 10px;
  color: var(--text-muted);
}

.info-box {
  background: rgba(5, 150, 105, 0.06);
  border: 1px solid rgba(5, 150, 105, 0.2);
  border-radius: 6px;
  padding: 10px;
  font-size: 11px;
  color: var(--text-secondary);
  line-height: 1.5;
}

.progress-section {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.progress-bar-bg {
  width: 100%;
  height: 6px;
  background: var(--bg-alt);
  border-radius: 3px;
  overflow: hidden;
}

.progress-bar-fill {
  height: 100%;
  width: 0%;
  background: var(--accent-green);
  border-radius: 3px;
  transition: width 0.3s ease;
}

.progress-text {
  font-size: 11px;
  color: var(--text-secondary);
  text-align: center;
}

.progress-error {
  color: var(--accent-red);
}

.progress-done {
  color: var(--accent-green);
  font-weight: 500;
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
