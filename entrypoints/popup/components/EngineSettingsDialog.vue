<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';

const emit = defineEmits<{
  (e: 'close'): void;
  (e: 'send-all'): void;
}>();

const projectPath = ref('');
const baseUrl = ref('');
const defaultBaseUrl = ref('http://127.0.0.1:8000');
const unsentVideoCount = ref(0);
const validating = ref(false);
const validated = ref(false);
const validationError = ref('');
const resolvedPath = ref('');

const configured = computed(() => projectPath.value.trim().length > 0);

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
      projectPath: string;
      baseUrl: string;
      defaultBaseUrl: string;
      unsentVideoCount: number;
    }>({ type: 'X_GET_ENGINE_SETTINGS' });
    projectPath.value = data.projectPath;
    baseUrl.value = data.baseUrl;
    defaultBaseUrl.value = data.defaultBaseUrl;
    unsentVideoCount.value = data.unsentVideoCount;
  } catch (err) {
    console.error('Failed to load engine settings:', err);
  }
}

function useDefaultUrl() {
  baseUrl.value = defaultBaseUrl.value;
  validated.value = false;
  validationError.value = '';
}

async function validateAndSave() {
  if (!projectPath.value.trim()) return;
  validating.value = true;
  validated.value = false;
  validationError.value = '';
  try {
    const result = await sendMessage<{ success: boolean; projectPath?: string; baseUrl?: string; error?: string }>({
      type: 'X_SET_ENGINE_SETTINGS',
      projectPath: projectPath.value.trim(),
      baseUrl: baseUrl.value.trim(),
    });
    if (result.projectPath) {
      resolvedPath.value = result.projectPath;
      projectPath.value = result.projectPath;
      if (result.baseUrl) baseUrl.value = result.baseUrl;
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

function startSendAll() {
  emit('send-all');
  emit('close');
}

onMounted(loadSettings);
</script>

<template>
  <div class="egs-overlay" @click.self="emit('close')">
    <div class="egs-dialog">
      <div class="egs-header">
        <span class="egs-title">ENGINE SETTINGS</span>
        <button class="egs-close" @click="emit('close')">&times;</button>
      </div>

      <div class="egs-body">
        <!-- Project path -->
        <div class="egs-field">
          <label class="egs-label">MEDIA_ENGINE PROJECT</label>
          <input
            v-model="projectPath"
            type="text"
            class="egs-input"
            placeholder="/path/to/media_engine"
            @input="validated = false; validationError = ''"
          />
          <div v-if="validated" class="egs-validation egs-ok">
            Validated: {{ resolvedPath }}
          </div>
          <div v-if="validationError" class="egs-validation egs-err">
            {{ validationError }}
          </div>
          <div class="egs-hint">
            Videos are sent via<br />
            <code>uv run --no-sync --project &lt;path&gt; med --json acquire-url &lt;url&gt;</code>
          </div>
        </div>

        <!-- Base URL -->
        <div class="egs-field">
          <label class="egs-label">ENGINE BASE URL</label>
          <div class="egs-input-row">
            <input
              v-model="baseUrl"
              type="text"
              class="egs-input"
              :placeholder="defaultBaseUrl"
              @input="validated = false; validationError = ''"
            />
            <button class="egs-default-btn" @click="useDefaultUrl" title="Use default URL">
              DEFAULT
            </button>
          </div>
          <div class="egs-hint">
            Catalog links open at <code>&lt;base&gt;/ui/catalog/&lt;id&gt;</code>
          </div>
        </div>

        <!-- Validate + save button -->
        <button
          class="egs-save-btn"
          :disabled="validating || !projectPath.trim()"
          @click="validateAndSave"
        >
          <span v-if="validating" class="egs-spinner"></span>
          {{ validating ? 'Validating...' : validated ? 'Saved' : 'Validate & Save' }}
        </button>

        <!-- Batch send -->
        <div class="egs-batch-section">
          <span class="egs-bar-divider"></span>
          <div class="egs-batch-row">
            <span class="egs-label">UNSENT VIDEO</span>
            <span class="egs-batch-count">{{ unsentVideoCount }}</span>
            <button
              class="egs-send-btn"
              :disabled="unsentVideoCount === 0 || !configured"
              @click="startSendAll"
            >
              SEND ALL
            </button>
          </div>
          <div v-if="!configured && unsentVideoCount > 0" class="egs-hint">
            Set the media_engine project path to enable batch sending
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.egs-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.4);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 100;
}

.egs-dialog {
  background: var(--bg-card);
  border: 1px solid var(--border-warm);
  border-radius: 6px;
  width: 400px;
  max-height: 90vh;
  overflow-y: auto;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.2);
}

.egs-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 14px;
  border-bottom: 1px solid var(--border-light);
}

.egs-title {
  font-family: var(--font-mono);
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.12em;
  color: var(--text-primary);
}

.egs-close {
  background: none;
  border: none;
  font-size: 16px;
  cursor: pointer;
  color: var(--text-muted);
  padding: 0 4px;
  line-height: 1;
}

.egs-close:hover {
  color: var(--accent-red);
}

.egs-body {
  padding: 14px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.egs-label {
  font-family: var(--font-mono);
  font-size: 9px;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--text-muted);
}

.egs-field {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.egs-input-row {
  display: flex;
  gap: 4px;
}

.egs-input {
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

.egs-input:focus {
  border-color: var(--accent-green);
}

.egs-default-btn {
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

.egs-default-btn:hover {
  border-color: var(--accent-green);
  color: var(--accent-green);
}

.egs-validation {
  font-family: var(--font-mono);
  font-size: 9px;
  padding: 3px 6px;
  border-radius: 3px;
  word-break: break-all;
}

.egs-ok {
  color: var(--accent-green);
  background: rgba(5, 150, 105, 0.06);
}

.egs-err {
  color: var(--accent-red);
  background: rgba(220, 38, 38, 0.06);
}

.egs-hint {
  font-size: 9px;
  color: var(--text-muted);
  line-height: 1.4;
}

.egs-hint code {
  font-family: var(--font-mono);
  font-size: 8.5px;
  background: var(--bg-alt);
  padding: 0 3px;
  border-radius: 2px;
  word-break: break-all;
}

.egs-save-btn {
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

.egs-save-btn:hover:not(:disabled) {
  filter: brightness(1.1);
}

.egs-save-btn:disabled {
  opacity: 0.6;
  cursor: default;
}

.egs-bar-divider {
  display: block;
  height: 1px;
  background: var(--border-light);
}

.egs-batch-section {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.egs-batch-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.egs-batch-count {
  font-family: var(--font-mono);
  font-size: 12px;
  font-weight: 700;
  color: var(--accent-green);
  flex: 1;
}

.egs-send-btn {
  padding: 4px 12px;
  background: var(--bg-alt);
  border: 1px solid var(--accent-green);
  border-radius: 3px;
  font-family: var(--font-mono);
  font-size: 9px;
  font-weight: 700;
  letter-spacing: 0.06em;
  cursor: pointer;
  color: var(--accent-green);
  transition: all 0.12s;
}

.egs-send-btn:hover:not(:disabled) {
  background: var(--accent-green);
  color: #fff;
}

.egs-send-btn:disabled {
  opacity: 0.4;
  cursor: default;
}

.egs-spinner {
  display: inline-block;
  width: 10px;
  height: 10px;
  border: 2px solid rgba(255, 255, 255, 0.3);
  border-top-color: #fff;
  border-radius: 50%;
  animation: egs-spin 0.7s linear infinite;
}

@keyframes egs-spin {
  to { transform: rotate(360deg); }
}
</style>
