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
  background: rgba(0, 0, 0, 0.6);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 100;
}

.dialog {
  background: #1e1e38;
  border-radius: 12px;
  width: 360px;
  max-height: 80vh;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  border: 1px solid #3a3a5a;
}

.dialog-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px;
  border-bottom: 1px solid #2a2a4a;
}

.dialog-header h2 {
  font-size: 16px;
  font-weight: 600;
}

.close-btn {
  background: none;
  border: none;
  color: #888;
  font-size: 24px;
  cursor: pointer;
  line-height: 1;
}

.close-btn:hover {
  color: #fff;
}

.dialog-content {
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 16px;
  overflow-y: auto;
  flex: 1;
  min-height: 0;
}

.field {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.field-label {
  font-size: 12px;
  font-weight: 500;
  color: #888;
  text-transform: uppercase;
}

.radio-group, .checkbox-group {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.radio-option {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  cursor: pointer;
  padding: 10px;
  border-radius: 8px;
  border: 1px solid #2a2a4a;
  transition: all 0.2s;
}

.radio-option:hover {
  border-color: #3a3a5a;
  background: rgba(99, 102, 241, 0.05);
}

.radio-option.recommended {
  border-color: rgba(99, 102, 241, 0.3);
  background: rgba(99, 102, 241, 0.1);
}

.radio-option input {
  accent-color: #6366f1;
  width: 16px;
  height: 16px;
  cursor: pointer;
  margin-top: 2px;
}

.radio-content {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.radio-title {
  font-size: 13px;
  font-weight: 500;
  color: #ddd;
}

.radio-desc {
  font-size: 11px;
  color: #888;
}

.checkbox-option {
  display: flex;
  align-items: center;
  gap: 10px;
  cursor: pointer;
  font-size: 13px;
}

.checkbox-option input {
  accent-color: #6366f1;
  width: 16px;
  height: 16px;
  cursor: pointer;
}

.info-box {
  background: rgba(99, 102, 241, 0.1);
  border: 1px solid rgba(99, 102, 241, 0.2);
  border-radius: 8px;
  padding: 12px;
}

.info-title {
  font-size: 11px;
  font-weight: 600;
  color: #6366f1;
  margin-bottom: 8px;
  text-transform: uppercase;
}

.info-list {
  margin: 0;
  padding-left: 16px;
  font-size: 11px;
  color: #999;
  line-height: 1.6;
}

.error-box {
  background: rgba(239, 68, 68, 0.1);
  border: 1px solid rgba(239, 68, 68, 0.3);
  border-radius: 8px;
  padding: 12px;
  color: #ef4444;
  font-size: 12px;
}

.dialog-footer {
  display: flex;
  gap: 8px;
  padding: 16px;
  border-top: 1px solid #2a2a4a;
}

.btn {
  flex: 1;
  padding: 12px 16px;
  border: none;
  border-radius: 8px;
  font-size: 14px;
  cursor: pointer;
  transition: background 0.2s;
}

.btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.btn-cancel {
  background: #2a2a4a;
  color: #eee;
}

.btn-cancel:hover:not(:disabled) {
  background: #3a3a5a;
}

.btn-export {
  background: #6366f1;
  color: #fff;
}

.btn-export:hover:not(:disabled) {
  background: #5254cc;
}
</style>
