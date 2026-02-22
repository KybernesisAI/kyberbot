/**
 * KyberBot — Relationship Extractor
 *
 * Uses Claude to extract typed relationships between entities
 * from conversation text.
 *
 * Example outputs:
 * - "John founded Acme Corp" -> { source: "John", target: "Acme Corp", type: "founded" }
 * - "Mary works at Google" -> { source: "Mary", target: "Google", type: "works_at" }
 * - "Met with Nick yesterday" -> { source: "user", target: "Nick", type: "met_with" }
 */

import { getClaudeClient } from '../claude.js';
import { createLogger } from '../logger.js';
import type { EntityType, RelationshipType } from './entity-graph.js';

const logger = createLogger('relationship-extractor');

export interface ExtractedRelationship {
  source: {
    name: string;
    type: EntityType;
  };
  target: {
    name: string;
    type: EntityType;
  };
  relationship: RelationshipType;
  confidence: number;
  rationale: string;
}

export interface RelationshipExtractionResult {
  entities: Array<{
    name: string;
    type: EntityType;
  }>;
  relationships: ExtractedRelationship[];
}

const EXTRACTION_PROMPT = `You are an entity relationship extractor. Analyze the conversation text and extract:

1. **Entities**: People, companies, projects, places, and topics mentioned
2. **Relationships**: Explicit relationships between entities

## Entity Types
- person: Individual people (e.g., "John", "Dr. Smith", "my brother")
- company: Companies, organizations (e.g., "Google", "Acme Corp", "the university")
- project: Projects, products, apps (e.g., "the mobile app", "Project Alpha")
- place: Locations (e.g., "New York", "the office", "Thailand")
- topic: Topics, concepts (e.g., "AI", "funding", "the meeting")

## Relationship Types (only use these exact values)
- founded: Person founded company/project
- works_at: Person works at company
- invested_in: Person/company invested in company/project
- met_with: Person met with person
- created: Person created project
- manages: Person manages project/company
- partners_with: Company partners with company
- located_in: Company/project located in place
- discussed: Entities discussed together (topic-related)
- related_to: Generic relationship when specific type unclear

## Rules
- Only extract relationships that are EXPLICITLY stated or strongly implied
- Do NOT create relationships just because entities appear together
- The speaker is "user" unless otherwise specified
- Set confidence 0.8-0.95 for explicit statements, 0.5-0.7 for implied relationships
- Provide brief rationale explaining why you identified each relationship

Respond with JSON only:
{
  "entities": [
    { "name": "John Smith", "type": "person" },
    { "name": "Acme Corp", "type": "company" }
  ],
  "relationships": [
    {
      "source": { "name": "John Smith", "type": "person" },
      "target": { "name": "Acme Corp", "type": "company" },
      "relationship": "founded",
      "confidence": 0.9,
      "rationale": "Text explicitly states John founded Acme Corp"
    }
  ]
}

If no explicit relationships found, return empty relationships array but still list entities.`;

/**
 * Extract entities and typed relationships from conversation text.
 * Uses Claude Haiku for fast, cost-effective extraction.
 */
export async function extractRelationships(
  text: string,
  options: {
    maxTokens?: number;
    timeout?: number;
  } = {}
): Promise<RelationshipExtractionResult> {
  const client = getClaudeClient();
  const maxTokens = options.maxTokens || 1024;

  try {
    // Truncate very long texts
    const truncatedText = text.length > 4000
      ? text.slice(0, 4000) + '\n\n[Text truncated...]'
      : text;

    const response = await client.complete(
      `${EXTRACTION_PROMPT}\n\n## Conversation Text:\n${truncatedText}`,
      {
        model: 'haiku',
        maxTokens,
      }
    );

    // Parse JSON from response
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      logger.warn('No JSON found in extraction response');
      return { entities: [], relationships: [] };
    }

    const result = JSON.parse(jsonMatch[0]) as RelationshipExtractionResult;

    // Validate and normalize the result
    const validatedEntities = (result.entities || []).filter(
      (e) => e.name && e.type && isValidEntityType(e.type)
    );

    const validatedRelationships = (result.relationships || []).filter(
      (r) =>
        r.source?.name &&
        r.source?.type &&
        r.target?.name &&
        r.target?.type &&
        r.relationship &&
        isValidRelationshipType(r.relationship)
    );

    logger.debug('Extracted relationships', {
      entities: validatedEntities.length,
      relationships: validatedRelationships.length,
    });

    return {
      entities: validatedEntities,
      relationships: validatedRelationships,
    };
  } catch (error) {
    logger.error('Relationship extraction failed', { error });
    return { entities: [], relationships: [] };
  }
}

function isValidEntityType(type: string): type is EntityType {
  return ['person', 'company', 'project', 'place', 'topic'].includes(type);
}

function isValidRelationshipType(type: string): type is RelationshipType {
  return [
    'co-occurred',
    'founded',
    'works_at',
    'invested_in',
    'met_with',
    'created',
    'manages',
    'partners_with',
    'located_in',
    'discussed',
    'related_to',
  ].includes(type);
}

/**
 * Format relationship for display in recall output.
 */
export function formatRelationship(
  entityName: string,
  relationship: RelationshipType,
  direction: 'outgoing' | 'incoming'
): string {
  const formats: Record<RelationshipType, { outgoing: string; incoming: string }> = {
    founded: { outgoing: 'founded', incoming: 'was founded by' },
    works_at: { outgoing: 'works at', incoming: 'employs' },
    invested_in: { outgoing: 'invested in', incoming: 'received investment from' },
    met_with: { outgoing: 'met with', incoming: 'met with' },
    created: { outgoing: 'created', incoming: 'was created by' },
    manages: { outgoing: 'manages', incoming: 'is managed by' },
    partners_with: { outgoing: 'partners with', incoming: 'partners with' },
    located_in: { outgoing: 'is located in', incoming: 'is location of' },
    discussed: { outgoing: 'discussed', incoming: 'was discussed with' },
    related_to: { outgoing: 'related to', incoming: 'related to' },
    'co-occurred': { outgoing: 'mentioned with', incoming: 'mentioned with' },
  };

  const format = formats[relationship] || formats['related_to'];
  return direction === 'outgoing' ? format.outgoing : format.incoming;
}
