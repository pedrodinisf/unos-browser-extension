<script setup lang="ts">
import { ref, onMounted } from 'vue';

const emit = defineEmits<{
  (e: 'close'): void;
  (e: 'ingest-all'): void;
}>();

const folder = ref('');
const os = ref('');
const defaultFolder = ref('');
const uningestedCount = ref(0);
const validating = ref(false);
const validated = ref(false);
const validationError = ref('');
const resolvedPath = ref('');

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

async function loadSettings() {
  try {
    const data = await sendMessage<{
      folder: string;
      os: string;
      defaultFolder: string;
      uningestedCount: number;
    }>({ type: 'X_GET_INGESTION_SETTINGS' });
    folder.value = data.folder;
    os.value = data.os;
    defaultFolder.value = data.defaultFolder;
    uningestedCount.value = data.uningestedCount;
  } catch (err) {
    console.error('Failed to load ingestion settings:', err);
  }
}

function useDefault() {
  folder.value = defaultFolder.value;
  validated.value = false;
  validationError.value = '';
}

async function validateAndSave() {
  if (!folder.value.trim()) return;
  validating.value = true;
  validated.value = false;
  validationError.value = '';
  try {
    const result = await sendMessage<{ success: boolean; resolvedPath?: string; error?: string }>({
      type: 'X_SET_INGESTION_FOLDER',
      folder: folder.value.trim(),
    });
    // result is in response.data but we also need to check response.success
    // sendMessage already checks response.success, so if we're here, it succeeded
    // but the result itself might indicate failure from the native host
    if (result.resolvedPath) {
      resolvedPath.value = result.resolvedPath;
      folder.value = result.resolvedPath;
      validated.value = true;
    } else {
      validationError.value = result.error || 'Validation failed';
    }
  } catch (err) {
    validationError.value = err instanceof Error ? err.message : String(err);
  } finally {
    validating.value = false;
  }
}

function startIngestAll() {
  emit('ingest-all');
  emit('close');
}

onMounted(loadSettings);
</script>

<template>
  <div class="igs-overlay" @click.self="emit('close')">
    <div class="igs-dialog">
      <div class="igs-header">
        <span class="igs-title">INGESTION SETTINGS</span>
        <button class="igs-close" @click="emit('close')">&times;</button>
      </div>

      <div class="igs-body">
        <!-- OS indicator -->
        <div class="igs-os-row">
          <span class="igs-label">DETECTED OS</span>
          <span class="igs-os-badge">{{ os.toUpperCase() }}</span>
        </div>

        <!-- Folder path -->
        <div class="igs-field">
          <label class="igs-label">INGESTION FOLDER</label>
          <div class="igs-input-row">
            <input
              v-model="folder"
              type="text"
              class="igs-input"
              :placeholder="defaultFolder"
              @input="validated = false; validationError = ''"
            />
            <button class="igs-default-btn" @click="useDefault" title="Use OS default">
              DEFAULT
            </button>
          </div>
          <div v-if="validated" class="igs-validation igs-ok">
            Validated: {{ resolvedPath }}
          </div>
          <div v-if="validationError" class="igs-validation igs-err">
            {{ validationError }}
          </div>
          <div class="igs-hint">
            Each bookmark creates a subfolder: <code>{tweetId}/metadata.json, content.txt, images, video</code>
          </div>
        </div>

        <!-- Validate + save button -->
        <button
          class="igs-save-btn"
          :disabled="validating || !folder.trim()"
          @click="validateAndSave"
        >
          <span v-if="validating" class="igs-spinner"></span>
          {{ validating ? 'Validating...' : validated ? 'Saved' : 'Validate & Save' }}
        </button>

        <!-- Batch ingest -->
        <div class="igs-batch-section">
          <span class="igs-bar-divider"></span>
          <div class="igs-batch-row">
            <span class="igs-label">UN-INGESTED</span>
            <span class="igs-batch-count">{{ uningestedCount }}</span>
            <button
              class="igs-ingest-btn"
              :disabled="uningestedCount === 0 || !validated"
              @click="startIngestAll"
            >
              INGEST ALL
            </button>
          </div>
          <div v-if="!validated && uningestedCount > 0" class="igs-hint">
            Validate folder first to enable batch ingestion
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.igs-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.4);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 100;
}

.igs-dialog {
  background: var(--bg-card);
  border: 1px solid var(--border-warm);
  border-radius: 6px;
  width: 380px;
  max-height: 90vh;
  overflow-y: auto;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.2);
}

.igs-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 14px;
  border-bottom: 1px solid var(--border-light);
}

.igs-title {
  font-family: var(--font-mono);
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.12em;
  color: var(--text-primary);
}

.igs-close {
  background: none;
  border: none;
  font-size: 16px;
  cursor: pointer;
  color: var(--text-muted);
  padding: 0 4px;
  line-height: 1;
}

.igs-close:hover {
  color: var(--accent-red);
}

.igs-body {
  padding: 14px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.igs-label {
  font-family: var(--font-mono);
  font-size: 9px;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--text-muted);
}

.igs-os-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.igs-os-badge {
  font-family: var(--font-mono);
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.06em;
  color: var(--accent-green);
  background: rgba(5, 150, 105, 0.1);
  padding: 2px 8px;
  border-radius: 3px;
  border: 1px solid rgba(5, 150, 105, 0.25);
}

.igs-field {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.igs-input-row {
  display: flex;
  gap: 4px;
}

.igs-input {
  flex: 1;
  padding: 5px 8px;
  border: 1px solid var(--border-light);
  border-radius: 3px;
  font-family: var(--font-mono);
  font-size: 10px;
  background: var(--bg-page);
  color: var(--text-primary);
  outline: none;
}

.igs-input:focus {
  border-color: var(--accent-green);
}

.igs-default-btn {
  padding: 4px 8px;
  background: var(--bg-alt);
  border: 1px solid var(--border-light);
  border-radius: 3px;
  font-family: var(--font-mono);
  font-size: 8px;
  font-weight: 700;
  letter-spacing: 0.06em;
  cursor: pointer;
  color: var(--text-secondary);
  transition: all 0.12s;
  white-space: nowrap;
}

.igs-default-btn:hover {
  border-color: var(--accent-green);
  color: var(--accent-green);
}

.igs-validation {
  font-family: var(--font-mono);
  font-size: 9px;
  padding: 3px 6px;
  border-radius: 3px;
}

.igs-ok {
  color: var(--accent-green);
  background: rgba(5, 150, 105, 0.06);
}

.igs-err {
  color: var(--accent-red);
  background: rgba(220, 38, 38, 0.06);
}

.igs-hint {
  font-size: 9px;
  color: var(--text-muted);
  line-height: 1.4;
}

.igs-hint code {
  font-family: var(--font-mono);
  font-size: 8.5px;
  background: var(--bg-alt);
  padding: 0 3px;
  border-radius: 2px;
}

.igs-save-btn {
  padding: 6px 14px;
  background: var(--accent-green);
  color: #fff;
  border: none;
  border-radius: 4px;
  font-family: var(--font-mono);
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.06em;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  transition: all 0.12s;
}

.igs-save-btn:hover:not(:disabled) {
  filter: brightness(1.1);
}

.igs-save-btn:disabled {
  opacity: 0.6;
  cursor: default;
}

.igs-bar-divider {
  display: block;
  height: 1px;
  background: var(--border-light);
}

.igs-batch-section {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.igs-batch-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.igs-batch-count {
  font-family: var(--font-mono);
  font-size: 12px;
  font-weight: 700;
  color: var(--accent-amber);
  flex: 1;
}

.igs-ingest-btn {
  padding: 4px 12px;
  background: var(--bg-alt);
  border: 1px solid var(--accent-amber);
  border-radius: 3px;
  font-family: var(--font-mono);
  font-size: 9px;
  font-weight: 700;
  letter-spacing: 0.06em;
  cursor: pointer;
  color: var(--accent-amber);
  transition: all 0.12s;
}

.igs-ingest-btn:hover:not(:disabled) {
  background: var(--accent-amber);
  color: #fff;
}

.igs-ingest-btn:disabled {
  opacity: 0.4;
  cursor: default;
}

.igs-spinner {
  display: inline-block;
  width: 10px;
  height: 10px;
  border: 2px solid rgba(255, 255, 255, 0.3);
  border-top-color: #fff;
  border-radius: 50%;
  animation: igs-spin 0.7s linear infinite;
}

@keyframes igs-spin {
  to { transform: rotate(360deg); }
}
</style>
