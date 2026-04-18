/**
 * KyberBot — User Profile
 *
 * Auto-generated profile from the fact store. Updated by the sleep agent.
 * Cached as JSON for instant (~1ms) access. Injected into system prompts
 * so agents always have key context about the user.
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import Database from 'libsql';
import { createLogger } from '../logger.js';
import { getTimelineDb } from './timeline.js';
import { ensureFactsTable } from './fact-store.js';

const logger = createLogger('user-profile');

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export interface UserProfile {
  generated_at: string;
  fact_count: number;
  sections: {
    identity: string[];
    preferences: string[];
    relationships: string[];
    current_plans: string[];
    recent_events: string[];
  };
  top_entities: Array<{ name: string; type: string; mention_count: number }>;
}

// ═══════════════════════════════════════════════════════════════════════════════
// PROFILE GENERATION
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Generate a fresh user profile by querying the fact store for each category.
 * Optionally enriches with top entities from the entity graph.
 */
export async function generateUserProfile(root: string): Promise<UserProfile> {
  await ensureFactsTable(root);
  const timeline = await getTimelineDb(root);

  const identity = queryFacts(timeline, 'biographical', 15);
  const preferences = queryFacts(timeline, 'preference', 10);
  const relationships = queryFacts(timeline, 'relationship', 10);
  const current_plans = queryFacts(timeline, 'plan', 5);
  const recent_events = queryRecentFacts(timeline, 'event', 5);

  const totalFacts = identity.length + preferences.length + relationships.length
    + current_plans.length + recent_events.length;

  const top_entities = queryTopEntities(root);

  const profile: UserProfile = {
    generated_at: new Date().toISOString(),
    fact_count: totalFacts,
    sections: {
      identity,
      preferences,
      relationships,
      current_plans,
      recent_events,
    },
    top_entities,
  };

  logger.debug('Generated user profile', {
    facts: totalFacts,
    entities: top_entities.length,
  });

  return profile;
}

/**
 * Query facts by category, ordered by confidence and access count.
 * Excludes expired facts and facts that are no longer current.
 */
function queryFacts(db: Database.Database, category: string, limit: number): string[] {
  try {
    const rows = db.prepare(`
      SELECT content FROM facts
      WHERE category = ?
        AND is_latest = 1
        AND (expires_at IS NULL OR expires_at > datetime('now'))
      ORDER BY confidence DESC, access_count DESC
      LIMIT ?
    `).all(category, limit) as Array<{ content: string }>;

    return rows.map(r => r.content);
  } catch {
    // access_count column may not exist yet
    try {
      const rows = db.prepare(`
        SELECT content FROM facts
        WHERE category = ?
          AND is_latest = 1
          AND (expires_at IS NULL OR expires_at > datetime('now'))
        ORDER BY confidence DESC
        LIMIT ?
      `).all(category, limit) as Array<{ content: string }>;

      return rows.map(r => r.content);
    } catch {
      return [];
    }
  }
}

/**
 * Query recent facts by category, ordered by timestamp descending.
 */
function queryRecentFacts(db: Database.Database, category: string, limit: number): string[] {
  try {
    const rows = db.prepare(`
      SELECT content FROM facts
      WHERE category = ?
        AND is_latest = 1
        AND (expires_at IS NULL OR expires_at > datetime('now'))
      ORDER BY timestamp DESC
      LIMIT ?
    `).all(category, limit) as Array<{ content: string }>;

    return rows.map(r => r.content);
  } catch {
    return [];
  }
}

/**
 * Query top entities from the entity graph database (if it exists).
 * Uses a separate connection to avoid interfering with the singleton.
 */
function queryTopEntities(root: string): Array<{ name: string; type: string; mention_count: number }> {
  const entityDbPath = join(root, 'data', 'entity-graph.db');

  if (!existsSync(entityDbPath)) {
    return [];
  }

  let entityDb: Database.Database | null = null;
  try {
    entityDb = new Database(entityDbPath, { readonly: true });
    const rows = entityDb.prepare(
      'SELECT name, type, mention_count FROM entities ORDER BY mention_count DESC LIMIT 10'
    ).all() as Array<{ name: string; type: string; mention_count: number }>;

    return rows;
  } catch (err) {
    logger.debug('Failed to query entity graph for profile', { error: String(err) });
    return [];
  } finally {
    if (entityDb) {
      try { entityDb.close(); } catch { /* ignore */ }
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// CACHE OPERATIONS
// ═══════════════════════════════════════════════════════════════════════════════

function profilePath(root: string): string {
  return join(root, 'data', 'user-profile.json');
}

/**
 * Read the cached profile from disk. Returns null if no cache exists or
 * the cache cannot be parsed.
 */
export function getCachedProfile(root: string): UserProfile | null {
  const path = profilePath(root);
  if (!existsSync(path)) return null;

  try {
    const raw = readFileSync(path, 'utf-8');
    return JSON.parse(raw) as UserProfile;
  } catch {
    return null;
  }
}

/**
 * Write the profile to disk as a JSON cache file.
 */
export function cacheProfile(root: string, profile: UserProfile): void {
  const path = profilePath(root);
  try {
    writeFileSync(path, JSON.stringify(profile, null, 2), 'utf-8');
    logger.debug('Cached user profile', { path });
  } catch (err) {
    logger.warn('Failed to cache user profile', { error: String(err) });
  }
}

/**
 * Calculate the age of the cached profile in minutes.
 * Returns Infinity if there is no cached profile.
 */
export function getProfileAge(root: string): number {
  const cached = getCachedProfile(root);
  if (!cached || !cached.generated_at) return Infinity;

  const generatedAt = new Date(cached.generated_at).getTime();
  if (isNaN(generatedAt)) return Infinity;

  return (Date.now() - generatedAt) / (1000 * 60);
}

// ═══════════════════════════════════════════════════════════════════════════════
// PROMPT FORMATTING
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Format the profile as markdown suitable for system prompt injection.
 */
export function formatProfileForPrompt(profile: UserProfile): string {
  const sections: string[] = [];

  sections.push('## Auto-Generated User Profile');

  if (profile.sections.identity.length > 0) {
    sections.push('');
    sections.push('### Identity');
    for (const fact of profile.sections.identity) {
      sections.push(`- ${fact}`);
    }
  }

  if (profile.sections.preferences.length > 0) {
    sections.push('');
    sections.push('### Preferences');
    for (const fact of profile.sections.preferences) {
      sections.push(`- ${fact}`);
    }
  }

  if (profile.sections.relationships.length > 0) {
    sections.push('');
    sections.push('### Key Relationships');
    for (const fact of profile.sections.relationships) {
      sections.push(`- ${fact}`);
    }
  }

  if (profile.sections.current_plans.length > 0) {
    sections.push('');
    sections.push('### Current Plans');
    for (const fact of profile.sections.current_plans) {
      sections.push(`- ${fact}`);
    }
  }

  if (profile.sections.recent_events.length > 0) {
    sections.push('');
    sections.push('### Recent Events');
    for (const fact of profile.sections.recent_events) {
      sections.push(`- ${fact}`);
    }
  }

  return sections.join('\n');
}
