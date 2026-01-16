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
const scope = ref<'current-window' | 'all-windows' | 'session'>('all-windows');
const format = ref<'json' | 'csv'>('json');
const includeVisitHistory = ref(true);
const includeRelationships = ref(true);
const includeIncognito = ref(false);
const exporting = ref(false);

// Methods
async function handleExport() {
  try {
    exporting.value = true;
    const exportService = getExportService();

    if (format.value === 'json') {
      await exportService.exportAndDownloadJSON({
        scope: scope.value,
        includeVisitHistory: includeVisitHistory.value,
        includeRelationships: includeRelationships.value,
        filters: {
          includeIncognito: includeIncognito.value,
        },
      });
    } else {
      await exportService.exportAndDownloadCSV({
        scope: scope.value,
        filters: {
          includeIncognito: includeIncognito.value,
        },
      });
    }

    emit('close');
  } catch (err) {
    console.error('Export failed:', err);
    alert('Export failed: ' + (err instanceof Error ? err.message : 'Unknown error'));
  } finally {
    exporting.value = false;
  }
}
</script>

<template>
  <div class="dialog-overlay" @click.self="$emit('close')">
    <div class="dialog">
      <div class="dialog-header">
        <h2>Export Tabs</h2>
        <button class="close-btn" @click="$emit('close')">&times;</button>
      </div>

      <div class="dialog-content">
        <!-- Scope -->
        <div class="field">
          <label class="field-label">Scope</label>
          <div class="radio-group">
            <label class="radio-option">
              <input type="radio" v-model="scope" value="current-window" />
              <span>Current window only</span>
            </label>
            <label class="radio-option">
              <input type="radio" v-model="scope" value="all-windows" />
              <span>All windows</span>
            </label>
            <label class="radio-option">
              <input type="radio" v-model="scope" value="session" />
              <span>Entire session</span>
            </label>
          </div>
        </div>

        <!-- Format -->
        <div class="field">
          <label class="field-label">Format</label>
          <div class="radio-group">
            <label class="radio-option">
              <input type="radio" v-model="format" value="json" />
              <span>JSON (complete data)</span>
            </label>
            <label class="radio-option">
              <input type="radio" v-model="format" value="csv" />
              <span>CSV (tabs only)</span>
            </label>
          </div>
        </div>

        <!-- Options -->
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

        <!-- Incognito -->
        <div class="field">
          <label class="checkbox-option">
            <input type="checkbox" v-model="includeIncognito" />
            <span>Include incognito windows</span>
          </label>
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
  width: 320px;
  max-height: 80vh;
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
  gap: 20px;
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

.radio-option, .checkbox-option {
  display: flex;
  align-items: center;
  gap: 10px;
  cursor: pointer;
  font-size: 13px;
}

.radio-option input, .checkbox-option input {
  accent-color: #6366f1;
  width: 16px;
  height: 16px;
  cursor: pointer;
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
