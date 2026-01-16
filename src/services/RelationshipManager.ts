import { getDatabase } from '../db/schema';
import type { TabRelationship, TrackedTab } from '../db/types';
import { getStorageManager, type StorageManager } from './StorageManager';
import { RETENTION, calculateTemporalStrength } from '../constants';

/**
 * RelationshipManager - Tracks connections between tabs
 *
 * Relationship types:
 * - opener: Parent-child relationship (which tab opened which)
 * - sibling: Tabs that coexisted in the same window at creation time
 * - temporal: Tabs created within a 10-minute window
 */
export class RelationshipManager {
  private storageManager: StorageManager;

  constructor(storageManager?: StorageManager) {
    this.storageManager = storageManager || getStorageManager();
  }

  /**
   * Track opener relationship when a tab is created
   */
  async trackOpenerRelationship(
    newTabPersistentId: string,
    openerPersistentId: string
  ): Promise<void> {
    const db = getDatabase();

    // Check if relationship already exists
    const existing = await db.tabRelationships
      .where('[sourceTabPersistentId+relationshipType]')
      .equals([openerPersistentId, 'opener'])
      .filter((r) => r.targetTabPersistentId === newTabPersistentId)
      .first();

    if (existing) return;

    const relationship: TabRelationship = {
      sourceTabPersistentId: openerPersistentId,
      targetTabPersistentId: newTabPersistentId,
      relationshipType: 'opener',
      createdAt: Date.now(),
      strength: 1.0, // Opener relationships are always strong
      metadata: {},
    };

    await db.tabRelationships.add(relationship);
    console.log(`[RelationshipManager] Created opener relationship: ${openerPersistentId} -> ${newTabPersistentId}`);
  }

  /**
   * Track sibling relationships for a new tab with existing tabs in the same window
   */
  async trackSiblingRelationships(
    newTabPersistentId: string,
    sessionId: string,
    chromeWindowId: number
  ): Promise<void> {
    const db = getDatabase();

    // Get all other tabs in the same window
    const siblings = await db.tabs
      .where('[sessionId+chromeWindowId]')
      .equals([sessionId, chromeWindowId])
      .filter((tab) => tab.persistentId !== newTabPersistentId && tab.closedAt === null)
      .toArray();

    const relationships: TabRelationship[] = [];
    const now = Date.now();

    for (const sibling of siblings) {
      // Check if relationship already exists
      const existing = await db.tabRelationships
        .where('[sourceTabPersistentId+relationshipType]')
        .equals([newTabPersistentId, 'sibling'])
        .filter((r) => r.targetTabPersistentId === sibling.persistentId)
        .first();

      if (!existing) {
        relationships.push({
          sourceTabPersistentId: newTabPersistentId,
          targetTabPersistentId: sibling.persistentId,
          relationshipType: 'sibling',
          createdAt: now,
          strength: 0.5, // Default sibling strength
          metadata: { windowId: chromeWindowId },
        });
      }
    }

    if (relationships.length > 0) {
      await db.tabRelationships.bulkAdd(relationships);
      console.log(`[RelationshipManager] Created ${relationships.length} sibling relationships`);
    }
  }

  /**
   * Recalculate temporal relationships for recently created tabs
   * Called periodically via chrome.alarms
   */
  async recalculateTemporalRelationships(): Promise<void> {
    const db = getDatabase();
    const temporalWindowMs = RETENTION.TEMPORAL_PROXIMITY_MINUTES * 60 * 1000;

    // Get tabs created in the last hour (for efficiency)
    const oneHourAgo = Date.now() - 60 * 60 * 1000;
    const recentTabs = await db.tabs
      .where('createdAt')
      .above(oneHourAgo)
      .filter((tab) => tab.closedAt === null) // Only open tabs
      .toArray();

    // Sort by creation time
    recentTabs.sort((a, b) => a.createdAt - b.createdAt);

    const newRelationships: TabRelationship[] = [];
    const now = Date.now();

    for (let i = 0; i < recentTabs.length; i++) {
      const tab = recentTabs[i];
      if (!tab) continue;

      // Find tabs within temporal window
      for (let j = i + 1; j < recentTabs.length; j++) {
        const otherTab = recentTabs[j];
        if (!otherTab) continue;

        const timeDiff = otherTab.createdAt - tab.createdAt;

        // Stop if outside temporal window
        if (timeDiff > temporalWindowMs) break;

        // Check if relationship already exists
        const existing = await db.tabRelationships
          .where('[sourceTabPersistentId+relationshipType]')
          .equals([tab.persistentId, 'temporal'])
          .filter((r) => r.targetTabPersistentId === otherTab.persistentId)
          .first();

        if (!existing) {
          const strength = calculateTemporalStrength(timeDiff);

          newRelationships.push({
            sourceTabPersistentId: tab.persistentId,
            targetTabPersistentId: otherTab.persistentId,
            relationshipType: 'temporal',
            createdAt: now,
            strength,
            metadata: { timeDiffMs: timeDiff },
          });
        }
      }
    }

    if (newRelationships.length > 0) {
      await db.tabRelationships.bulkAdd(newRelationships);
      console.log(`[RelationshipManager] Created ${newRelationships.length} temporal relationships`);
    }
  }

  /**
   * Get opener chain (ancestors) for a tab
   */
  async getOpenerChain(tabPersistentId: string): Promise<TrackedTab[]> {
    const db = getDatabase();
    const chain: TrackedTab[] = [];
    let currentId = tabPersistentId;
    const visited = new Set<string>();

    while (currentId && !visited.has(currentId)) {
      visited.add(currentId);

      // Find opener relationship where current tab is the target
      const relationship = await db.tabRelationships
        .where('[targetTabPersistentId+relationshipType]')
        .equals([currentId, 'opener'])
        .first();

      if (!relationship) break;

      const parentTab = await db.tabs
        .where('persistentId')
        .equals(relationship.sourceTabPersistentId)
        .first();

      if (parentTab) {
        chain.push(parentTab);
        currentId = relationship.sourceTabPersistentId;
      } else {
        break;
      }
    }

    return chain;
  }

  /**
   * Get children (tabs opened by) for a tab
   */
  async getChildren(tabPersistentId: string): Promise<TrackedTab[]> {
    const db = getDatabase();

    const relationships = await db.tabRelationships
      .where('[sourceTabPersistentId+relationshipType]')
      .equals([tabPersistentId, 'opener'])
      .toArray();

    const childIds = relationships.map((r) => r.targetTabPersistentId);
    const children: TrackedTab[] = [];

    for (const childId of childIds) {
      const tab = await db.tabs.where('persistentId').equals(childId).first();
      if (tab) children.push(tab);
    }

    return children;
  }

  /**
   * Get siblings (tabs in same window at creation) for a tab
   */
  async getSiblings(tabPersistentId: string): Promise<TrackedTab[]> {
    const db = getDatabase();

    const relationships = await db.tabRelationships
      .where('[sourceTabPersistentId+relationshipType]')
      .equals([tabPersistentId, 'sibling'])
      .toArray();

    const siblingIds = relationships.map((r) => r.targetTabPersistentId);
    const siblings: TrackedTab[] = [];

    for (const siblingId of siblingIds) {
      const tab = await db.tabs.where('persistentId').equals(siblingId).first();
      if (tab) siblings.push(tab);
    }

    return siblings;
  }

  /**
   * Get temporally related tabs
   */
  async getTemporallyRelated(
    tabPersistentId: string,
    minStrength = 0
  ): Promise<{ tab: TrackedTab; strength: number }[]> {
    const db = getDatabase();

    const relationships = await db.tabRelationships
      .where('[sourceTabPersistentId+relationshipType]')
      .equals([tabPersistentId, 'temporal'])
      .filter((r) => r.strength >= minStrength)
      .toArray();

    const results: { tab: TrackedTab; strength: number }[] = [];

    for (const rel of relationships) {
      const tab = await db.tabs.where('persistentId').equals(rel.targetTabPersistentId).first();
      if (tab) {
        results.push({ tab, strength: rel.strength });
      }
    }

    // Sort by strength (highest first)
    results.sort((a, b) => b.strength - a.strength);

    return results;
  }

  /**
   * Get all relationships for a tab
   */
  async getAllRelationships(tabPersistentId: string): Promise<{
    openerChain: TrackedTab[];
    children: TrackedTab[];
    siblings: TrackedTab[];
    temporallyRelated: { tab: TrackedTab; strength: number }[];
  }> {
    const [openerChain, children, siblings, temporallyRelated] = await Promise.all([
      this.getOpenerChain(tabPersistentId),
      this.getChildren(tabPersistentId),
      this.getSiblings(tabPersistentId),
      this.getTemporallyRelated(tabPersistentId),
    ]);

    return { openerChain, children, siblings, temporallyRelated };
  }

  /**
   * Prune weak relationships
   */
  async pruneWeakRelationships(): Promise<number> {
    const db = getDatabase();
    const threshold = RETENTION.WEAK_RELATIONSHIP_THRESHOLD;

    // Delete temporal relationships below threshold
    const deleted = await db.tabRelationships
      .where('relationshipType')
      .equals('temporal')
      .filter((r) => r.strength < threshold)
      .delete();

    if (deleted > 0) {
      console.log(`[RelationshipManager] Pruned ${deleted} weak relationships`);
    }

    return deleted;
  }

  /**
   * Delete all relationships for a tab (called when tab is permanently deleted)
   */
  async deleteRelationshipsForTab(tabPersistentId: string): Promise<void> {
    const db = getDatabase();

    // Delete where tab is source
    await db.tabRelationships
      .where('sourceTabPersistentId')
      .equals(tabPersistentId)
      .delete();

    // Delete where tab is target
    await db.tabRelationships
      .where('targetTabPersistentId')
      .equals(tabPersistentId)
      .delete();
  }
}

// Singleton instance
let relationshipManager: RelationshipManager | null = null;

/**
 * Get the RelationshipManager singleton
 */
export function getRelationshipManager(): RelationshipManager {
  if (!relationshipManager) {
    relationshipManager = new RelationshipManager();
  }
  return relationshipManager;
}
