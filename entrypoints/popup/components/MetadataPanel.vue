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
          rows="3"
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
  background: #1e1e38;
  border-radius: 12px;
  border: 1px solid #3a3a5a;
  overflow: hidden;
}

.panel-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 16px;
  border-bottom: 1px solid #2a2a4a;
}

.panel-header h3 {
  font-size: 14px;
  font-weight: 500;
}

.close-btn {
  background: none;
  border: none;
  color: #888;
  font-size: 20px;
  cursor: pointer;
  line-height: 1;
}

.close-btn:hover {
  color: #fff;
}

.panel-content {
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.field {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.field-label {
  font-size: 12px;
  font-weight: 500;
  color: #888;
  text-transform: uppercase;
}

.tags-input {
  background: #2a2a4a;
  border-radius: 8px;
  padding: 8px;
}

.tags-list {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: 8px;
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
  background: #6366f1;
  color: #fff;
  padding: 2px 8px;
  border-radius: 10px;
  font-size: 11px;
}

.tag-remove {
  background: none;
  border: none;
  color: rgba(255, 255, 255, 0.7);
  font-size: 14px;
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
  color: #eee;
  font-size: 13px;
  font-family: inherit;
  outline: none;
}

.input::placeholder, .textarea::placeholder {
  color: #666;
}

.textarea {
  background: #2a2a4a;
  border-radius: 8px;
  padding: 10px;
  resize: vertical;
  min-height: 60px;
}

.panel-footer {
  display: flex;
  gap: 8px;
  padding: 12px 16px;
  border-top: 1px solid #2a2a4a;
}

.btn {
  flex: 1;
  padding: 10px 16px;
  border: none;
  border-radius: 8px;
  font-size: 13px;
  cursor: pointer;
  transition: background 0.2s;
}

.btn-cancel {
  background: #2a2a4a;
  color: #eee;
}

.btn-cancel:hover {
  background: #3a3a5a;
}

.btn-save {
  background: #6366f1;
  color: #fff;
}

.btn-save:hover {
  background: #5254cc;
}
</style>
