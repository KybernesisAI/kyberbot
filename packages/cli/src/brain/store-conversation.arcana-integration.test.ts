import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtemp, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import type { StructuredStore } from '@kybernesisai/arcana-contracts';
import {
  createFakeStructuredStore,
  createFakeVectorStore,
  createFakeEmbeddingProvider,
  createFakeLLMProvider,
} from '@kybernesisai/arcana-testkit/fakes';

vi.mock('../logger.js', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

// Mock external IO that store-conversation orchestrates.
vi.mock('./embeddings.js', () => ({
  indexDocument: vi.fn(async () => 0),
  isChromaAvailable: vi.fn(() => false),
}));

vi.mock('./relationship-extractor.js', () => ({
  extractRelationships: vi.fn(async () => ({ entities: [], relationships: [] })),
}));

vi.mock('./entity-graph.js', () => ({
  findOrCreateEntity: vi.fn(async () => ({ id: 1, name: 'X', type: 'person' })),
  addEntityMention: vi.fn(async () => undefined),
  linkEntitiesWithType: vi.fn(async () => undefined),
}));

vi.mock('./fact-extractor.js', () => ({
  extractFactsRealtime: vi.fn(async () => 0),
}));

const { storeConversation } = await import('./store-conversation.js');
const { getTimelineDb, resetTimelineDb } = await import('./timeline.js');
const { initArcana, resetArcanaForTests } = await import('./arcana-singleton.js');

let root: string;
let structured: StructuredStore;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'kyberbot-store-conv-arcana-'));

  structured = createFakeStructuredStore();
  await structured.connect();
  initArcana({
    structured,
    vector: createFakeVectorStore(),
    embed: createFakeEmbeddingProvider(),
    llm: createFakeLLMProvider(),
  });
});

afterAll(async () => {
  resetTimelineDb(root);
  resetArcanaForTests();
  await rm(root, { recursive: true, force: true });
});

describe('store-conversation → Arcana Memory mirror (module #10)', () => {
  it('one conversation = one Arcana Memory with FULL content; timeline row references same id', async () => {
    await storeConversation(root, {
      prompt: 'What did Alice say at the planning meeting?',
      response: 'Alice committed to the Q3 roadmap and confirmed the budget allocation for Project Atlas.',
      channel: 'telegram',
      timestamp: '2026-05-18T10:00:00Z',
    });

    const memories = await structured.listMemories();
    expect(memories).toHaveLength(1);

    const memory = memories[0];
    // Full conversation text — both prompt and response, with role prefixes
    expect(memory.content).toContain('User: What did Alice say');
    expect(memory.content).toContain('Assistant: Alice committed to the Q3 roadmap');
    expect(memory.source).toBe('chat');

    // Timeline row links to the SAME memory id (no duplicate mirror)
    const db = await getTimelineDb(root);
    const row = db
      .prepare('SELECT arcana_memory_id FROM timeline_events ORDER BY id DESC LIMIT 1')
      .get() as { arcana_memory_id: string };
    expect(row.arcana_memory_id).toBe(memory.id);
  });

  it('terminal channel → Arcana source = "cli"', async () => {
    await storeConversation(root, {
      prompt: 'Terminal prompt unique-token-A',
      response: 'Terminal response',
      channel: 'terminal',
      timestamp: '2026-05-18T10:05:00Z',
    });

    const memories = await structured.listMemories();
    const cliMemory = memories.find(m => m.content.includes('unique-token-A'));
    expect(cliMemory).toBeDefined();
    expect(cliMemory!.source).toBe('cli');
  });

  it('heartbeat channel → Arcana source = "connector"', async () => {
    await storeConversation(root, {
      prompt: 'Heartbeat prompt unique-token-B',
      response: 'Heartbeat response',
      channel: 'heartbeat',
      timestamp: '2026-05-18T10:10:00Z',
    });

    const memories = await structured.listMemories();
    const hbMemory = memories.find(m => m.content.includes('unique-token-B'));
    expect(hbMemory).toBeDefined();
    expect(hbMemory!.source).toBe('connector');
  });

  it('propagates ARP scopes from input.metadata into the Memory', async () => {
    await storeConversation(root, {
      prompt: 'Project Atlas planning unique-token-C',
      response: 'Discussed the launch timeline',
      channel: 'web',
      timestamp: '2026-05-18T10:15:00Z',
      metadata: {
        project_id: 'proj-atlas',
        classification: 'internal',
        connection_id: 'conn-123',
        source_did: 'did:example:xyz',
        tags: ['roadmap', 'q3'],
      },
    });

    const memories = await structured.listMemories();
    const m = memories.find(mem => mem.content.includes('unique-token-C'));
    expect(m).toBeDefined();
    expect(m!.scopes).toEqual({
      project_id: 'proj-atlas',
      classification: 'internal',
      connection_id: 'conn-123',
      source_did: 'did:example:xyz',
    });
    // Custom ARP tags also flow through
    expect(m!.tags).toEqual(expect.arrayContaining(['type:conversation', 'roadmap', 'q3']));
  });

  it('tags include the type:conversation namespace marker', async () => {
    await storeConversation(root, {
      prompt: 'Type namespace check unique-token-D',
      response: 'Just verifying tags',
      channel: 'whatsapp',
      timestamp: '2026-05-18T10:20:00Z',
    });

    const memories = await structured.listMemories();
    const m = memories.find(mem => mem.content.includes('unique-token-D'));
    expect(m).toBeDefined();
    expect(m!.tags).toContain('type:conversation');
  });
});
