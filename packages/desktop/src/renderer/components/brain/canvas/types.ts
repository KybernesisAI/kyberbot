/**
 * Brain graph type definitions.
 * Faithfully ported from Kybernesis Canvas arcana/types.ts.
 */

// Wire format from GET /brain/graph
export interface GraphNodeDTO {
  id: number;
  name: string;
  type: EntityType;
  mention_count: number;
  priority: number;
  decay_score: number;
  tier: string;
  last_seen: string;
}

export interface GraphEdgeDTO {
  source: number;
  target: number;
  relationship: string;
  strength: number;
  confidence: number;
}

export interface GraphResponse {
  nodes: GraphNodeDTO[];
  edges: GraphEdgeDTO[];
}

export type EntityType = 'person' | 'company' | 'project' | 'place' | 'topic';

export interface Camera {
  x: number;
  y: number;
  zoom: number;
  targetZoom: number;
}

export interface Physics {
  clusterStrength: number;
  repulsion: number;
  damping: number;
  springStrength: number;
  idealDistance: number;
}

export const DEFAULT_PHYSICS: Physics = {
  clusterStrength: 0.005,
  repulsion: 3.0,
  damping: 0.88,
  springStrength: 0.003,
  idealDistance: 250,
};

// Color schemes ported exactly from Kybernesis types.ts
export interface ColorScheme {
  bg: readonly number[];
  node: Record<string, readonly number[]>;
  source: Record<string, readonly number[]>;
  connection: readonly number[];
  glow: readonly number[];
  grid: readonly number[];
  ui: readonly number[];
}

export const darkColors: ColorScheme = {
  bg: [10, 10, 10],
  node: {
    document: [99, 102, 241],
    concept: [139, 92, 246],
    search: [236, 72, 153],
    recent: [16, 185, 129],
    default: [156, 163, 175],
    // Entity type colors for KyberBot
    person: [59, 130, 246],
    company: [34, 197, 94],
    project: [249, 115, 22],
    place: [239, 68, 68],
    topic: [168, 85, 247],
  },
  source: {
    upload: [59, 130, 246],
    chat: [34, 197, 94],
    connector: [168, 85, 247],
    'google-drive': [234, 179, 8],
    notion: [0, 0, 0],
    system: [148, 163, 184],
    api: [236, 72, 153],
    default: [100, 116, 139],
  },
  connection: [255, 255, 255, 30],
  glow: [255, 255, 255, 80],
  grid: [255, 255, 255, 8],
  ui: [255, 255, 255, 40],
};

export const lightColors: ColorScheme = {
  bg: [240, 239, 234],
  node: {
    document: [79, 82, 201],
    concept: [119, 72, 226],
    search: [216, 52, 133],
    recent: [14, 165, 109],
    default: [100, 116, 139],
    person: [37, 99, 235],
    company: [22, 163, 74],
    project: [234, 88, 12],
    place: [220, 38, 38],
    topic: [147, 51, 234],
  },
  source: {
    upload: [37, 99, 235],
    chat: [22, 163, 74],
    connector: [147, 51, 234],
    'google-drive': [202, 138, 4],
    notion: [30, 30, 30],
    system: [100, 116, 139],
    api: [219, 39, 119],
    default: [71, 85, 105],
  },
  connection: [0, 0, 0, 25],
  glow: [0, 0, 0, 60],
  grid: [0, 0, 0, 8],
  ui: [0, 0, 0, 30],
};
