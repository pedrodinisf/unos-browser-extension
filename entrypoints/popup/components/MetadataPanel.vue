<script setup lang="ts">
import { ref, computed } from 'vue';
import type { TrackedTab } from '../../../src/db/types';

const props = defineProps<{
  tab: TrackedTab;
}>();

const emit = defineEmits<{
  update: [data: { tags: string[]; notes: string }];
  close: [];
}>();

// State
const tagInput = ref('');
const tags = ref<string[]>([...props.tab.tags]);
const notes = ref(props.tab.notes || '');

// Methods
function addTag() {
  const tag = tagInput.value.trim().toLowerCase();
  if (tag && !tags.value.includes(tag)) {
    tags.value.push(tag);
    tagInput.value = '';
  }
}

function removeTag(tag: string) {
  tags.value = tags.value.filter((t) => t !== tag);
}

function handleKeydown(e: KeyboardEvent) {
  if (e.key === 'Enter') {
    e.preventDefault();
    addTag();
  }
}

function handleSave() {
  emit('update', {
    tags: tags.value,
    notes: notes.value,
  });
}
</script>

<template>
  <div class="metadata-panel">
    <div class="panel-header">
      <h3>Edit Metadata</h3>
      <button class="close-btn" @click="$emit('close')">&times;</button>
    </div>

    <div class="panel-content">
      <!-- Tags -->
      <div class="field">
        <label class="field-label">Tags</label>
        <div class="tags-input">
          <div class="tags-list">
            <span
              v-for="tag in tags"
              :key="tag"
              class="tag"
            >
              {{ tag }}
              <button class="tag-remove" @click="removeTag(tag)">&times;</button>
            </span>
          </div>
          <input
            v-model="tagInput"
            type="text"
            placeholder="Add tag..."
            class="input"
            @keydown="handleKeydown"
            @blur="addTag"
          />
        </div>
      </div>

      <!-- Notes -->
      <div class="field">
        <label class="field-label">Notes</label>
        <textarea
          v-model="notes"
          class="textarea"
          placeholder="Add notes..."
          rows="2"
        ></textarea>
      </div>
    </div>

    <div class="panel-footer">
      <button class="btn btn-cancel" @click="$emit('close')">Cancel</button>
      <button class="btn btn-save" @click="handleSave">Save</button>
    </div>
  </div>
</template>

<style scoped>
.metadata-panel {
  background: var(--bg-card);
  border: 1px solid var(--border-light);
  border-radius: 6px;
  overflow: hidden;
}

.panel-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 10px;
  border-bottom: 1px solid var(--border-light);
}

.panel-header h3 {
  font-size: 11px;
  font-weight: 600;
  color: var(--text-primary);
}

.close-btn {
  background: none;
  border: none;
  color: var(--text-muted);
  font-size: 18px;
  cursor: pointer;
  line-height: 1;
}

.close-btn:hover {
  color: var(--text-primary);
}

.panel-content {
  padding: 8px 10px;
  display: flex;
  flex-direction: column;
  gap: 8px;
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

.tags-input {
  background: var(--bg-alt);
  border: 1px solid var(--border-light);
  border-radius: 4px;
  padding: 6px;
}

.tags-list {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-bottom: 6px;
}

.tags-list:empty {
  display: none;
}

.tags-list + .input {
  margin-top: 0;
}

.tag {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  background: var(--accent-green);
  color: #fff;
  padding: 1px 8px;
  border-radius: 10px;
  font-size: 11px;
}

.tag-remove {
  background: none;
  border: none;
  color: rgba(255, 255, 255, 0.7);
  font-size: 13px;
  cursor: pointer;
  line-height: 1;
  padding: 0;
  margin-left: 2px;
}

.tag-remove:hover {
  color: #fff;
}

.input, .textarea {
  width: 100%;
  background: transparent;
  border: none;
  color: var(--text-primary);
  font-size: 12px;
  font-family: inherit;
  outline: none;
}

.input::placeholder, .textarea::placeholder {
  color: var(--text-muted);
}

.textarea {
  background: var(--bg-alt);
  border: 1px solid var(--border-light);
  border-radius: 4px;
  padding: 6px;
  resize: vertical;
  min-height: 36px;
  font-size: 11px;
}

.panel-footer {
  display: flex;
  gap: 6px;
  padding: 8px 10px;
  border-top: 1px solid var(--border-light);
}

.btn {
  flex: 1;
  padding: 5px 10px;
  border: none;
  border-radius: 4px;
  font-size: 11px;
  cursor: pointer;
  transition: background 0.15s;
}

.btn-cancel {
  background: var(--bg-alt);
  color: var(--text-primary);
  border: 1px solid var(--border-light);
}

.btn-cancel:hover {
  background: var(--border-warm);
}

.btn-save {
  background: var(--accent-green);
  color: #fff;
}

.btn-save:hover {
  background: #047857;
}
</style>
