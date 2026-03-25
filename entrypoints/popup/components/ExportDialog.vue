<script setup lang="ts">
import { ref, computed, watch } from 'vue';
import type { ExportEntitySelection } from '../../../src/db/types';
import { getExportService, ENTITY_KEYS, type EntityKey, type ExportOptions } from '../../../src/services/ExportService';

const emit = defineEmits<{
  close: [];
}>();

const format = ref<'json' | 'csv' | 'zip'>('zip');
const exporting = ref(false);
const error = ref<string | null>(null);

// Entity selection state
const entities = ref<ExportEntitySelection>({
  sessions: true,
  windows: true,
  tabs: true,
  visits: true,
  relationships: true,
  tags: true,
  xBookmarks: true,
  manifest: true,
});

// For CSV mode: which single entity is selected
const csvEntity = ref<EntityKey>('tabs');

// Entity display labels
const entityLabels: Record<EntityKey, string> = {
  sessions: 'Sessions',
  windows: 'Windows',
  tabs: 'Tabs',
  visits: 'Visits',
  relationships: 'Relationships',
  tags: 'Tags',
  xBookmarks: 'X Bookmarks',
};

const isCSV = computed(() => format.value === 'csv');
const showManifest = computed(() => format.value !== 'csv');

const selectedCount = computed(() =>
  ENTITY_KEYS.filter(k => entities.value[k]).length + (entities.value.manifest && showManifest.value ? 1 : 0)
);

const canExport = computed(() => {
  if (isCSV.value) return true; // csvEntity always has a value
  return ENTITY_KEYS.some(k => entities.value[k]);
});

function selectAll() {
  for (const k of ENTITY_KEYS) entities.value[k] = true;
  entities.value.manifest = true;
}

function deselectAll() {
  for (const k of ENTITY_KEYS) entities.value[k] = false;
  entities.value.manifest = false;
}

async function handleExport() {
  try {
    exporting.value = true;
    error.value = null;
    const exportService = getExportService();

    let options: ExportOptions;

    if (isCSV.value) {
      // CSV: build entities with only the single selected entity
      const csvEntities: ExportEntitySelection = {
        sessions: false, windows: false, tabs: false,
        visits: false, relationships: false, tags: false,
        xBookmarks: false, manifest: false,
      };
      csvEntities[csvEntity.value] = true;
      options = { format: 'csv', entities: csvEntities, csvEntity: csvEntity.value };
    } else {
      options = { format: format.value, entities: entities.value };
    }

    await exportService.exportAndDownload(options);
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
            <label class="radio-option" :class="{ recommended: format === 'zip' }">
              <input type="radio" v-model="format" value="zip" />
              <div class="radio-content">
                <span class="radio-title">ZIP</span>
                <span class="radio-desc">Each entity as a separate CSV file</span>
              </div>
            </label>
            <label class="radio-option">
              <input type="radio" v-model="format" value="json" />
              <div class="radio-content">
                <span class="radio-title">JSON</span>
                <span class="radio-desc">All selected entities in a single file</span>
              </div>
            </label>
            <label class="radio-option">
              <input type="radio" v-model="format" value="csv" />
              <div class="radio-content">
                <span class="radio-title">CSV</span>
                <span class="radio-desc">Single entity as one CSV file</span>
              </div>
            </label>
          </div>
        </div>

        <!-- Entity selection: checkboxes for ZIP/JSON, radio for CSV -->
        <div class="field">
          <div class="field-label-row">
            <label class="field-label">{{ isCSV ? 'Entity' : 'Entities' }}</label>
            <div v-if="!isCSV" class="select-links">
              <button class="link-btn" @click="selectAll">All</button>
              <span class="link-sep">/</span>
              <button class="link-btn" @click="deselectAll">None</button>
            </div>
          </div>

          <!-- CSV: radio group (single entity) -->
          <div v-if="isCSV" class="entity-list">
            <label
              v-for="key in ENTITY_KEYS"
              :key="key"
              class="entity-option"
            >
              <input type="radio" v-model="csvEntity" :value="key" />
              <span>{{ entityLabels[key] }}</span>
            </label>
          </div>

          <!-- ZIP/JSON: checkbox group (multi entity) -->
          <div v-else class="entity-list">
            <label
              v-for="key in ENTITY_KEYS"
              :key="key"
              class="entity-option"
            >
              <input type="checkbox" v-model="entities[key]" />
              <span>{{ entityLabels[key] }}</span>
            </label>
            <label v-if="showManifest" class="entity-option entity-manifest">
              <input type="checkbox" v-model="entities.manifest" />
              <span>Manifest</span>
            </label>
          </div>
        </div>

        <!-- CSV note -->
        <div v-if="isCSV" class="info-box info-muted">
          CSV exports one entity at a time. Use ZIP for multiple.
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
          :disabled="exporting || !canExport"
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

.field-label-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.select-links {
  display: flex;
  align-items: center;
  gap: 4px;
}

.link-btn {
  background: none;
  border: none;
  color: var(--accent-green);
  font-size: 10px;
  cursor: pointer;
  padding: 0;
  text-transform: uppercase;
  font-weight: 600;
  letter-spacing: 0.3px;
}

.link-btn:hover {
  text-decoration: underline;
}

.link-sep {
  color: var(--text-muted);
  font-size: 10px;
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

.entity-list {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 4px 12px;
}

.entity-option {
  display: flex;
  align-items: center;
  gap: 6px;
  cursor: pointer;
  font-size: 11.5px;
  color: var(--text-primary);
  padding: 3px 0;
}

.entity-option input {
  accent-color: var(--accent-green);
  width: 13px;
  height: 13px;
  cursor: pointer;
}

.entity-manifest {
  color: var(--text-muted);
  font-style: italic;
}

.info-box {
  border-radius: 6px;
  padding: 8px 10px;
  font-size: 10px;
}

.info-muted {
  background: var(--bg-alt);
  border: 1px solid var(--border-light);
  color: var(--text-muted);
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
