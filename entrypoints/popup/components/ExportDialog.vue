<script setup lang="ts">
import { ref } from 'vue';
import type { TrackedWindow } from '../../../src/db/types';
import { getExportService } from '../../../src/services/ExportService';

const props = defineProps<{
  windows: TrackedWindow[];
}>();

const emit = defineEmits<{
  close: [];
}>();

// State
const format = ref<'json' | 'csv' | 'zip'>('zip');
const includeVisitHistory = ref(true);
const includeRelationships = ref(true);
const includeIncognito = ref(false);
const exporting = ref(false);
const error = ref<string | null>(null);

// Methods
async function handleExport() {
  try {
    exporting.value = true;
    error.value = null;
    const exportService = getExportService();

    if (format.value === 'zip') {
      await exportService.exportAndDownloadZIP();
    } else if (format.value === 'json') {
      await exportService.exportAndDownloadJSON({
        scope: 'session',
        includeVisitHistory: includeVisitHistory.value,
        includeRelationships: includeRelationships.value,
        filters: {
          includeIncognito: includeIncognito.value,
        },
      });
    } else {
      await exportService.exportAndDownloadCSV({
        scope: 'session',
        filters: {
          includeIncognito: includeIncognito.value,
        },
      });
    }

    emit('close');
  } catch (err) {
    console.error('Export failed:', err);
    error.value = err instanceof Error ? err.message : 'Unknown error';
  } finally {
    exporting.value = false;
  }
}
</script>

<template>
  <div class="dialog-overlay" @click.self="$emit('close')">
    <div class="dialog">
      <div class="dialog-header">
        <h2>Export Data</h2>
        <button class="close-btn" @click="$emit('close')">&times;</button>
      </div>

      <div class="dialog-content">
        <!-- Format -->
        <div class="field">
          <label class="field-label">Format</label>
          <div class="radio-group">
            <label class="radio-option recommended">
              <input type="radio" v-model="format" value="zip" />
              <div class="radio-content">
                <span class="radio-title">ZIP (Recommended)</span>
                <span class="radio-desc">All tables as separate CSV files</span>
              </div>
            </label>
            <label class="radio-option">
              <input type="radio" v-model="format" value="json" />
              <div class="radio-content">
                <span class="radio-title">JSON</span>
                <span class="radio-desc">Complete data in single file</span>
              </div>
            </label>
            <label class="radio-option">
              <input type="radio" v-model="format" value="csv" />
              <div class="radio-content">
                <span class="radio-title">CSV</span>
                <span class="radio-desc">Tabs only</span>
              </div>
            </label>
          </div>
        </div>

        <!-- ZIP info -->
        <div v-if="format === 'zip'" class="info-box">
          <div class="info-title">ZIP contains:</div>
          <ul class="info-list">
            <li>sessions.csv - Session records</li>
            <li>windows.csv - Window records</li>
            <li>tabs.csv - Tab records</li>
            <li>visits.csv - Visit history</li>
            <li>relationships.csv - Tab relationships</li>
            <li>tags.csv - Tag definitions</li>
            <li>manifest.json - Export metadata</li>
          </ul>
        </div>

        <!-- JSON Options -->
        <div class="field" v-if="format === 'json'">
          <label class="field-label">Include</label>
          <div class="checkbox-group">
            <label class="checkbox-option">
              <input type="checkbox" v-model="includeVisitHistory" />
              <span>Visit history</span>
            </label>
            <label class="checkbox-option">
              <input type="checkbox" v-model="includeRelationships" />
              <span>Tab relationships</span>
            </label>
          </div>
        </div>

        <!-- Incognito (for JSON/CSV only) -->
        <div class="field" v-if="format !== 'zip'">
          <label class="checkbox-option">
            <input type="checkbox" v-model="includeIncognito" />
            <span>Include incognito windows</span>
          </label>
        </div>

        <!-- Error -->
        <div v-if="error" class="error-box">
          {{ error }}
        </div>
      </div>

      <div class="dialog-footer">
        <button class="btn btn-cancel" @click="$emit('close')">Cancel</button>
        <button
          class="btn btn-export"
          @click="handleExport"
          :disabled="exporting"
        >
          {{ exporting ? 'Exporting...' : 'Export' }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.dialog-overlay {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
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

.radio-group, .checkbox-group {
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

.radio-option.recommended {
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

.checkbox-option {
  display: flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
  font-size: 12px;
  color: var(--text-primary);
}

.checkbox-option input {
  accent-color: var(--accent-green);
  width: 14px;
  height: 14px;
  cursor: pointer;
}

.info-box {
  background: rgba(5, 150, 105, 0.06);
  border: 1px solid rgba(5, 150, 105, 0.2);
  border-radius: 6px;
  padding: 10px;
}

.info-title {
  font-size: 10px;
  font-weight: 600;
  color: var(--accent-green);
  margin-bottom: 6px;
  text-transform: uppercase;
}

.info-list {
  margin: 0;
  padding-left: 16px;
  font-size: 10px;
  color: var(--text-secondary);
  line-height: 1.6;
}

.error-box {
  background: rgba(220, 38, 38, 0.06);
  border: 1px solid rgba(220, 38, 38, 0.2);
  border-radius: 6px;
  padding: 10px;
  color: var(--accent-red);
  font-size: 11px;
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

.btn-export {
  background: var(--accent-green);
  color: #fff;
}

.btn-export:hover:not(:disabled) {
  background: #047857;
}
</style>
