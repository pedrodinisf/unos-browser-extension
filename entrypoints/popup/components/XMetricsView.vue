<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import type { XBookmarkMetrics } from '../../../src/db/types';

const metrics = ref<XBookmarkMetrics | null>(null);
const loading = ref(true);
const error = ref<string | null>(null);

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

async function loadMetrics() {
  loading.value = true;
  error.value = null;
  try {
    metrics.value = await sendMessage<XBookmarkMetrics>({ type: 'X_GET_BOOKMARK_METRICS' });
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Failed to load metrics';
  } finally {
    loading.value = false;
  }
}

// Chart scaling helpers
const maxAcquisitionCount = computed(() => {
  if (!metrics.value) return 1;
  return Math.max(1, ...metrics.value.acquisitionTimeline.map((w) => w.count));
});

const maxAuthorCount = computed(() => {
  if (!metrics.value || metrics.value.topAuthors.length === 0) return 1;
  return metrics.value.topAuthors[0].count;
});

const maxTweetAgeCount = computed(() => {
  if (!metrics.value) return 1;
  return Math.max(1, ...metrics.value.tweetAgeDistribution.map((m) => m.count));
});

const compositionTotal = computed(() => {
  if (!metrics.value) return 0;
  const c = metrics.value.contentComposition;
  return c.textOnly + c.withImages + c.withVideo;
});

const compositionGradient = computed(() => {
  if (!metrics.value || compositionTotal.value === 0) return 'var(--border-light)';
  const c = metrics.value.contentComposition;
  const total = compositionTotal.value;
  const textPct = (c.textOnly / total) * 100;
  const imgPct = (c.withImages / total) * 100;
  // video fills the rest
  const p1 = textPct;
  const p2 = textPct + imgPct;
  return `conic-gradient(var(--text-muted) 0% ${p1}%, var(--accent-green) ${p1}% ${p2}%, var(--accent-amber) ${p2}% 100%)`;
});

function reset() {
  loadMetrics();
}

defineExpose({ reset });
onMounted(() => loadMetrics());
</script>

<template>
  <div class="xmt-container">
    <!-- Loading -->
    <div v-if="loading" class="xmt-loading">Loading metrics...</div>

    <!-- Error -->
    <div v-else-if="error" class="xmt-loading">{{ error }}</div>

    <!-- Empty -->
    <div v-else-if="!metrics || metrics.summary.totalBookmarks === 0" class="xmt-empty">
      <p>No bookmark data yet.</p>
      <p class="xmt-empty-hint">Sync from <strong>X</strong> to see metrics.</p>
    </div>

    <!-- Metrics content -->
    <div v-else class="xmt-scroll">

      <!-- 1. Summary Readout Strip -->
      <div class="xmt-readout-grid">
        <div class="xmt-cell">
          <span class="xmt-cell-value xmt-green">{{ metrics.summary.totalBookmarks }}</span>
          <span class="xmt-cell-label">TOTAL</span>
        </div>
        <div class="xmt-cell">
          <span class="xmt-cell-value xmt-green">{{ metrics.summary.uniqueAuthors }}</span>
          <span class="xmt-cell-label">AUTHORS</span>
        </div>
        <div class="xmt-cell">
          <span class="xmt-cell-value xmt-green">{{ metrics.summary.bookmarksPerWeek }}</span>
          <span class="xmt-cell-label">/WEEK</span>
        </div>
        <div class="xmt-cell">
          <span class="xmt-cell-value xmt-amber">{{ metrics.summary.mediaPercent }}%</span>
          <span class="xmt-cell-label">MEDIA</span>
        </div>
        <div class="xmt-cell">
          <span class="xmt-cell-value xmt-amber">{{ metrics.summary.videoPercent }}%</span>
          <span class="xmt-cell-label">VIDEO</span>
        </div>
        <div class="xmt-cell">
          <span class="xmt-cell-value xmt-amber">{{ metrics.summary.taggedPercent }}%</span>
          <span class="xmt-cell-label">TAGGED</span>
        </div>
      </div>

      <!-- 2. Acquisition Timeline -->
      <div class="xmt-section">
        <div class="xmt-section-label">ACQUISITION TIMELINE</div>
        <div class="xmt-timeline">
          <div
            v-for="week in metrics.acquisitionTimeline"
            :key="week.weekLabel"
            class="xmt-timeline-col"
          >
            <span v-if="week.count > 0" class="xmt-timeline-count">{{ week.count }}</span>
            <div
              class="xmt-timeline-bar"
              :style="{ height: (week.count / maxAcquisitionCount) * 48 + 'px' }"
            ></div>
            <span class="xmt-timeline-label">{{ week.weekLabel }}</span>
          </div>
        </div>
      </div>

      <!-- 3. Two-column: Composition + Top Authors -->
      <div class="xmt-two-col">
        <!-- Content Composition -->
        <div class="xmt-section">
          <div class="xmt-section-label">COMPOSITION</div>
          <div class="xmt-composition">
            <div class="xmt-donut" :style="{ background: compositionGradient }">
              <div class="xmt-donut-hole"></div>
            </div>
            <div class="xmt-legend">
              <div class="xmt-legend-row">
                <span class="xmt-legend-dot" style="background: var(--text-muted)"></span>
                <span class="xmt-legend-text">TEXT</span>
                <span class="xmt-legend-val">{{ metrics.contentComposition.textOnly }}</span>
              </div>
              <div class="xmt-legend-row">
                <span class="xmt-legend-dot" style="background: var(--accent-green)"></span>
                <span class="xmt-legend-text">IMG</span>
                <span class="xmt-legend-val">{{ metrics.contentComposition.withImages }}</span>
              </div>
              <div class="xmt-legend-row">
                <span class="xmt-legend-dot" style="background: var(--accent-amber)"></span>
                <span class="xmt-legend-text">VID</span>
                <span class="xmt-legend-val">{{ metrics.contentComposition.withVideo }}</span>
              </div>
            </div>
          </div>
        </div>

        <!-- Top Authors -->
        <div class="xmt-section">
          <div class="xmt-section-label">TOP AUTHORS</div>
          <div class="xmt-authors">
            <div v-for="author in metrics.topAuthors" :key="author.handle" class="xmt-author-row">
              <span class="xmt-author-handle">{{ author.handle }}</span>
              <div class="xmt-author-bar-track">
                <div
                  class="xmt-author-bar-fill"
                  :style="{ width: (author.count / maxAuthorCount) * 100 + '%' }"
                ></div>
              </div>
              <span class="xmt-author-count">{{ author.count }}</span>
            </div>
          </div>
        </div>
      </div>

      <!-- 4. Tweet Age Distribution -->
      <div class="xmt-section">
        <div class="xmt-section-label">TWEET AGE</div>
        <div class="xmt-age">
          <div
            v-for="month in metrics.tweetAgeDistribution"
            :key="month.monthLabel"
            class="xmt-age-row"
          >
            <span class="xmt-age-label">{{ month.monthLabel }}</span>
            <div class="xmt-age-bar-track">
              <div
                class="xmt-age-bar-fill"
                :style="{ width: (month.count / maxTweetAgeCount) * 100 + '%' }"
              ></div>
            </div>
            <span class="xmt-age-count">{{ month.count }}</span>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.xmt-container {
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow: hidden;
}

.xmt-scroll {
  flex: 1;
  overflow-y: auto;
  padding-bottom: 4px;
}

.xmt-scroll::-webkit-scrollbar { width: 6px; }
.xmt-scroll::-webkit-scrollbar-track { background: var(--bg-alt); }
.xmt-scroll::-webkit-scrollbar-thumb { background: var(--border-warm); border-radius: 3px; }

/* Loading & Empty */
.xmt-loading, .xmt-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 40px 20px;
  text-align: center;
  color: var(--text-secondary);
  font-size: 13px;
  flex: 1;
}

.xmt-empty-hint {
  font-size: 12px;
  color: var(--text-secondary);
  margin-top: 4px;
}

.xmt-empty-hint strong {
  color: var(--text-primary);
}

/* Readout Grid */
.xmt-readout-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 1px;
  background: var(--border-warm);
  border-bottom: 1px solid var(--border-warm);
}

.xmt-cell {
  background: var(--bg-card);
  padding: 6px 4px 5px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 1px;
}

.xmt-cell-value {
  font-family: var(--font-mono);
  font-size: 16px;
  font-weight: 700;
  line-height: 1.15;
  -webkit-font-smoothing: antialiased;
}

.xmt-cell-label {
  font-family: var(--font-mono);
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--text-primary);
  -webkit-font-smoothing: antialiased;
}

.xmt-green { color: var(--accent-green); }
.xmt-amber { color: var(--accent-amber); }

/* Section */
.xmt-section {
  padding: 0 10px;
}

.xmt-section-label {
  font-family: var(--font-mono);
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--text-primary);
  padding: 6px 0 3px;
  border-bottom: 1px solid var(--border-light);
  margin-bottom: 4px;
  -webkit-font-smoothing: antialiased;
}

/* Acquisition Timeline */
.xmt-timeline {
  display: flex;
  align-items: flex-end;
  gap: 2px;
  height: 68px;
  padding-bottom: 18px;
}

.xmt-timeline-col {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: flex-end;
  gap: 1px;
  height: 100%;
  position: relative;
}

.xmt-timeline-count {
  font-family: var(--font-mono);
  font-size: 9px;
  font-weight: 700;
  color: var(--text-primary);
  line-height: 1;
  -webkit-font-smoothing: antialiased;
}

.xmt-timeline-bar {
  width: 100%;
  min-height: 2px;
  background: var(--accent-green);
  border-radius: 2px 2px 0 0;
  opacity: 0.9;
}

.xmt-timeline-label {
  font-family: var(--font-mono);
  font-size: 9px;
  font-weight: 600;
  color: var(--text-secondary);
  white-space: nowrap;
  transform: rotate(-45deg);
  position: absolute;
  bottom: -4px;
  -webkit-font-smoothing: antialiased;
}

/* Two-column layout */
.xmt-two-col {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 0;
}

/* Content Composition (donut) */
.xmt-composition {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 4px 0 4px;
}

.xmt-donut {
  width: 68px;
  height: 68px;
  border-radius: 50%;
  position: relative;
  flex-shrink: 0;
}

.xmt-donut-hole {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  width: 36px;
  height: 36px;
  border-radius: 50%;
  background: var(--bg-page);
}

.xmt-legend {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.xmt-legend-row {
  display: flex;
  align-items: center;
  gap: 6px;
}

.xmt-legend-dot {
  width: 10px;
  height: 10px;
  border-radius: 2px;
  flex-shrink: 0;
}

.xmt-legend-text {
  font-family: var(--font-mono);
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--text-primary);
  -webkit-font-smoothing: antialiased;
}

.xmt-legend-val {
  font-family: var(--font-mono);
  font-size: 12px;
  font-weight: 700;
  color: var(--text-secondary);
  -webkit-font-smoothing: antialiased;
}

/* Top Authors */
.xmt-authors {
  display: flex;
  flex-direction: column;
  gap: 1px;
  padding: 3px 0 4px;
}

.xmt-author-row {
  display: flex;
  align-items: center;
  gap: 4px;
  height: 20px;
}

.xmt-author-handle {
  font-family: var(--font-mono);
  font-size: 11px;
  font-weight: 700;
  color: #046B4D;
  white-space: nowrap;
  text-align: right;
  flex-shrink: 0;
  -webkit-font-smoothing: antialiased;
}

.xmt-author-bar-track {
  flex: 1;
  height: 14px;
  background: var(--bg-alt);
  border-radius: 2px;
  overflow: hidden;
}

.xmt-author-bar-fill {
  height: 100%;
  background: var(--accent-green);
  border-radius: 2px;
  opacity: 0.85;
}

.xmt-author-count {
  font-family: var(--font-mono);
  font-size: 11px;
  font-weight: 700;
  color: var(--text-primary);
  width: 32px;
  text-align: right;
  -webkit-font-smoothing: antialiased;
}

/* Tweet Age Distribution */
.xmt-age {
  display: flex;
  flex-direction: column;
  gap: 1px;
  padding: 3px 0 4px;
}

.xmt-age-row {
  display: flex;
  align-items: center;
  gap: 5px;
  height: 20px;
}

.xmt-age-label {
  font-family: var(--font-mono);
  font-size: 11px;
  font-weight: 700;
  color: var(--text-primary);
  width: 58px;
  text-align: right;
  flex-shrink: 0;
  -webkit-font-smoothing: antialiased;
}

.xmt-age-bar-track {
  flex: 1;
  height: 14px;
  background: var(--bg-alt);
  border-radius: 2px;
  overflow: hidden;
}

.xmt-age-bar-fill {
  height: 100%;
  background: var(--accent-amber);
  border-radius: 2px;
  opacity: 0.85;
}

.xmt-age-count {
  font-family: var(--font-mono);
  font-size: 11px;
  font-weight: 700;
  color: var(--text-primary);
  width: 34px;
  text-align: right;
  -webkit-font-smoothing: antialiased;
}
</style>
