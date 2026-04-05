/**
 * p5.js memory graph canvas — faithful port of Kybernesis Canvas.
 *
 * Uses p5 in instance mode with the exact physics, rendering, and
 * interaction code from kybernesis-brain/apps/web/app/arcana/page.tsx.
 */

import { useEffect, useRef, useState, useCallback } from 'react';
import p5 from 'p5';
import type { GraphNodeDTO, GraphEdgeDTO, Camera, Physics, ColorScheme } from './types';
import { DEFAULT_PHYSICS, darkColors, lightColors } from './types';

// Runtime canvas types (matching Kybernesis MemoryNode)
interface CanvasNode {
  pos: p5.Vector;
  vel: p5.Vector;
  targetPos: p5.Vector;
  size: number;
  type: 'document' | 'concept';
  cluster: number;
  lastAccessed: number;
  connections: CanvasNode[];
  pulsePhase: number;
  memoryId: string;
  memoryData: GraphNodeDTO;
  document: { name: string; type: string; connections: number };
}

interface CanvasEdge {
  from: CanvasNode;
  to: CanvasNode;
  strength: number;
  relation?: string;
}

interface Cluster {
  pos: p5.Vector;
  vel: p5.Vector;
  nodes: CanvasNode[];
  type: 'document' | 'concept';
  radius: number;
}

interface MemoryCanvasProps {
  nodes: GraphNodeDTO[];
  edges: GraphEdgeDTO[];
  isDark?: boolean;
  onNodeSelect?: (node: GraphNodeDTO | null) => void;
}

export default function MemoryCanvas({ nodes, edges, isDark = true, onNodeSelect }: MemoryCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const p5Ref = useRef<p5 | null>(null);
  const [hoveredNode, setHoveredNode] = useState<CanvasNode | null>(null);
  const [selectedNode, setSelectedNode] = useState<CanvasNode | null>(null);
  const [isDragging, setIsDragging] = useState(false);

  // Refs for p5 data (matching Kybernesis exactly)
  const memoryNodesRef = useRef<CanvasNode[]>([]);
  const connectionsRef = useRef<CanvasEdge[]>([]);
  const clustersRef = useRef<Cluster[]>([]);
  const cameraRef = useRef<Camera>({ x: 0, y: 0, zoom: 1.0, targetZoom: 1.0 });
  const dragStartRef = useRef({ x: 0, y: 0 });
  const timeRef = useRef(0);
  const colorsRef = useRef<ColorScheme>(isDark ? darkColors : lightColors);
  const hoveredNodeRef = useRef<CanvasNode | null>(null);
  const isDraggingRef = useRef(false);
  const nodesDataRef = useRef(nodes);
  const onNodeSelectRef = useRef(onNodeSelect);

  // Keep refs in sync
  useEffect(() => { colorsRef.current = isDark ? darkColors : lightColors; }, [isDark]);
  useEffect(() => { nodesDataRef.current = nodes; }, [nodes]);
  useEffect(() => { onNodeSelectRef.current = onNodeSelect; }, [onNodeSelect]);

  const physics = DEFAULT_PHYSICS;

  useEffect(() => {
    if (!containerRef.current || nodes.length === 0) return;

    const sketch = (p: p5) => {
      // ── screenToWorld (from arcana page.tsx:710-716) ──
      const screenToWorld = (x: number, y: number) => {
        const camera = cameraRef.current;
        return {
          x: (x - camera.x) / camera.zoom,
          y: (y - camera.y) / camera.zoom,
        };
      };

      // ── isInViewport (frustum culling) ──
      const isInViewport = (x: number, y: number, margin = 0) => {
        const camera = cameraRef.current;
        const sx = x * camera.zoom + camera.x;
        const sy = y * camera.zoom + camera.y;
        return sx > -margin && sx < p.width + margin && sy > -margin && sy < p.height + margin;
      };

      // ── getNodeColor (from arcana page.tsx:718-723) ──
      const getNodeColor = (node: CanvasNode): readonly number[] => {
        const type = node.memoryData?.type || 'default';
        const nodeColors = colorsRef.current.node as Record<string, readonly number[]>;
        return nodeColors[type] || nodeColors.default || [156, 163, 175];
      };

      // ── initializeNeuralTopology (from arcana page.tsx:734-886) ──
      const initializeNeuralTopology = () => {
        memoryNodesRef.current = [];
        connectionsRef.current = [];
        clustersRef.current = [];

        const numClusters = Math.max(1, Math.min(8, Math.ceil(nodes.length / 12)));
        for (let i = 0; i < numClusters; i++) {
          const angle = (i / numClusters) * p.TWO_PI;
          const dist = 600;
          clustersRef.current.push({
            pos: p.createVector(p.cos(angle) * dist, p.sin(angle) * dist),
            vel: p.createVector(0, 0),
            nodes: [],
            type: i % 2 === 0 ? 'document' : 'concept',
            radius: 200,
          });
        }

        const nodeMap = new Map<number, CanvasNode>();

        nodes.forEach((mem, idx) => {
          const clusterIndex = idx % numClusters;
          const cluster = clustersRef.current[clusterIndex];
          const angle = p.random(p.TWO_PI);
          const magnitude = p.random(150, 300);
          const offset = p.createVector(p.cos(angle) * magnitude, p.sin(angle) * magnitude);
          const pos = cluster.pos.copy().add(offset);
          const importanceScore = (mem.priority * 0.7) + (mem.decay_score * 0.3);
          const baseSize = p.map(importanceScore, 0, 1, 10, 20);

          const node: CanvasNode = {
            pos: pos.copy(),
            vel: p.createVector(0, 0),
            targetPos: pos.copy(),
            document: { name: mem.name, type: mem.type, connections: 0 },
            size: baseSize,
            type: mem.type === 'topic' ? 'concept' : 'document',
            cluster: clusterIndex,
            lastAccessed: Date.now(),
            connections: [],
            pulsePhase: p.random(p.TWO_PI),
            memoryId: String(mem.id),
            memoryData: mem,
          };

          memoryNodesRef.current.push(node);
          cluster.nodes.push(node);
          nodeMap.set(mem.id, node);
        });

        edges.forEach(edge => {
          const fromNode = nodeMap.get(edge.source);
          const toNode = nodeMap.get(edge.target);
          if (fromNode && toNode && !fromNode.connections.includes(toNode)) {
            const strength = Math.min(edge.confidence ?? 0.5, 1);
            connectionsRef.current.push({ from: fromNode, to: toNode, strength, relation: edge.relationship });
            fromNode.connections.push(toNode);
            toNode.connections.push(fromNode);
          }
        });

        // Update node sizes based on connection count
        memoryNodesRef.current.forEach(node => {
          const connectionCount = node.connections.length;
          node.document.connections = connectionCount;
          if (connectionCount > 0) {
            node.size = p.map(connectionCount, 0, 15, 4.48, 10.08);
          }
        });
      };

      // ── applyForces (from arcana page.tsx:888-930) ──
      const applyForces = () => {
        memoryNodesRef.current.forEach(node => node.vel.mult(physics.damping));

        // Cluster attraction
        memoryNodesRef.current.forEach(node => {
          const cluster = clustersRef.current[node.cluster];
          if (cluster && cluster.nodes.length > 0) {
            const avgPos = p.createVector(0, 0);
            cluster.nodes.forEach(n => avgPos.add(n.pos));
            avgPos.div(cluster.nodes.length);
            const attraction = avgPos.copy().sub(node.pos);
            attraction.setMag(physics.clusterStrength);
            node.vel.add(attraction);
          }
        });

        // Repulsion
        for (let i = 0; i < memoryNodesRef.current.length; i++) {
          for (let j = i + 1; j < memoryNodesRef.current.length; j++) {
            const nodeA = memoryNodesRef.current[i];
            const nodeB = memoryNodesRef.current[j];
            const dist = p.dist(nodeA.pos.x, nodeA.pos.y, nodeB.pos.x, nodeB.pos.y);
            if (dist < 200) {
              const repulsion = nodeA.pos.copy().sub(nodeB.pos);
              repulsion.setMag(physics.repulsion / (dist + 1));
              nodeA.vel.add(repulsion);
              nodeB.vel.sub(repulsion);
            }
          }
        }

        // Spring forces
        connectionsRef.current.forEach(conn => {
          const spring = conn.to.pos.copy().sub(conn.from.pos);
          const dist = spring.mag();
          if (dist > physics.idealDistance) {
            spring.setMag((dist - physics.idealDistance) * physics.springStrength * conn.strength);
            conn.from.vel.add(spring.copy().mult(0.5));
            conn.to.vel.sub(spring.copy().mult(0.5));
          }
        });
      };

      // ── updateNodes ──
      const updateNodes = () => {
        memoryNodesRef.current.forEach(node => {
          node.pos.add(node.vel);
        });
      };

      // ── drawGrid (from arcana page.tsx:936-947) ──
      const drawGrid = () => {
        const gridSize = 100;
        p.stroke(...colorsRef.current.grid);
        p.strokeWeight(0.5);
        for (let x = -p.width; x < p.width * 2; x += gridSize) {
          p.line(x, -p.height, x, p.height * 2);
        }
        for (let y = -p.height; y < p.height * 2; y += gridSize) {
          p.line(-p.width, y, p.width * 2, y);
        }
      };

      // ── drawConnections (from arcana page.tsx:957-1054) ──
      const drawConnections = () => {
        const camera = cameraRef.current;
        let renderedCount = 0;
        const maxConnections = camera.zoom < 0.5 ? 500 : 2000;

        connectionsRef.current.forEach(conn => {
          if (camera.zoom < 0.5 && renderedCount >= maxConnections) return;
          const { from, to, strength } = conn;
          if (!isInViewport(from.pos.x, from.pos.y, 200) && !isInViewport(to.pos.x, to.pos.y, 200)) return;
          renderedCount++;

          let isHighlighted = false;
          const hovId = hoveredNodeRef.current?.memoryId;
          if (hovId && (from.memoryId === hovId || to.memoryId === hovId)) {
            isHighlighted = true;
            const fromColor = getNodeColor(from);
            const toColor = getNodeColor(to);
            p.stroke((fromColor[0] + toColor[0]) / 2, (fromColor[1] + toColor[1]) / 2, (fromColor[2] + toColor[2]) / 2, 150);
            p.strokeWeight(p.map(strength, 0, 1, 1.5, 2.5));
          }

          if (!isHighlighted) {
            const alpha = p.map(strength, 0, 1, 10, 35);
            const weight = p.map(strength, 0, 1, 0.4, 1.2);
            const isLightBg = colorsRef.current.bg[0] > 128;
            let r: number, g: number, b: number;
            if (strength > 0.7) { r = isLightBg ? 25 : 230; g = isLightBg ? 15 : 240; b = isLightBg ? 0 : 255; }
            else if (strength > 0.4) { r = isLightBg ? 15 : 240; g = isLightBg ? 20 : 235; b = isLightBg ? 5 : 250; }
            else { r = isLightBg ? 0 : 255; g = isLightBg ? 0 : 255; b = isLightBg ? 0 : 255; }

            p.stroke(r, g, b, alpha);
            p.strokeWeight(weight);
            if (strength > 0.6) {
              p.drawingContext.setLineDash([]);
            } else if (strength > 0.3) {
              p.drawingContext.setLineDash([4, 6]);
            } else {
              p.drawingContext.setLineDash([1, 7]);
            }
            p.line(from.pos.x, from.pos.y, to.pos.x, to.pos.y);
            p.drawingContext.setLineDash([]);
            return;
          }

          p.line(from.pos.x, from.pos.y, to.pos.x, to.pos.y);
        });
      };

      // ── drawClusters (from arcana page.tsx:1056-1091) ──
      const drawClusters = () => {
        clustersRef.current.forEach(cluster => {
          if (cluster.nodes.length === 0) return;
          p.noFill();
          p.stroke(colorsRef.current.node.search[0], colorsRef.current.node.search[1], colorsRef.current.node.search[2], 35);
          p.strokeWeight(1);

          const avgPos = p.createVector(0, 0);
          cluster.nodes.forEach(node => avgPos.add(node.pos));
          avgPos.div(cluster.nodes.length);

          let totalDist = 0;
          cluster.nodes.forEach(node => { totalDist += p.dist(avgPos.x, avgPos.y, node.pos.x, node.pos.y); });
          const avgDist = totalDist / cluster.nodes.length;
          const radius = avgDist * 0.7 + 20;

          p.beginShape();
          const points = 16;
          for (let j = 0; j <= points; j++) {
            const angle = (j / points) * p.TWO_PI;
            const r = radius + p.sin(timeRef.current * 2 + angle * 3) * 8;
            p.vertex(avgPos.x + p.cos(angle) * r, avgPos.y + p.sin(angle) * r);
          }
          p.endShape();
        });
      };

      // ── drawMemoryNodes (from arcana page.tsx:1093-1181) ──
      const drawMemoryNodes = () => {
        const camera = cameraRef.current;
        const useHighDetail = camera.zoom > 0.6;
        const useGlowEffects = camera.zoom > 0.4;

        memoryNodesRef.current.forEach(node => {
          const { pos, size, pulsePhase } = node;
          if (!isInViewport(pos.x, pos.y, size * 3)) return;

          const nodeColor = getNodeColor(node);
          let displaySize = size;

          // Hover glow
          if (hoveredNodeRef.current && node.memoryId === hoveredNodeRef.current.memoryId && useGlowEffects) {
            p.noStroke();
            p.fill(nodeColor[0], nodeColor[1], nodeColor[2], 60);
            p.circle(pos.x, pos.y, displaySize * 3.5);
          }

          // Main node circle
          p.fill(nodeColor[0], nodeColor[1], nodeColor[2], 200);
          p.noStroke();
          p.circle(pos.x, pos.y, displaySize);

          // Outer glow ring (high detail only)
          if (useHighDetail) {
            p.noFill();
            const ringSize = displaySize + p.sin(timeRef.current + pulsePhase) * 2 + 4;
            p.stroke(nodeColor[0], nodeColor[1], nodeColor[2], 100);
            p.strokeWeight(1.5);
            p.circle(pos.x, pos.y, ringSize);
          }

          // Inner core for high-priority nodes
          if (node.memoryData && node.memoryData.priority > 0.7) {
            const isLightBg = colorsRef.current.bg[0] > 128;
            p.fill(isLightBg ? 50 : 255, isLightBg ? 50 : 255, isLightBg ? 50 : 255, 180);
            p.noStroke();
            p.circle(pos.x, pos.y, displaySize * 0.3);
          }

          // Connection indicator dots
          if (node.connections.length > 3) {
            const numDots = p.min(node.connections.length, 8);
            for (let i = 0; i < numDots; i++) {
              const angle = (i / numDots) * p.TWO_PI + timeRef.current * 0.5;
              const dotDist = displaySize / 2 + 8;
              p.fill(nodeColor[0], nodeColor[1], nodeColor[2], 150);
              p.noStroke();
              p.circle(pos.x + p.cos(angle) * dotDist, pos.y + p.sin(angle) * dotDist, 2.5);
            }
          }

          // Labels at sufficient zoom
          if (camera.zoom > 0.5) {
            p.fill(...colorsRef.current.glow.slice(0, 3) as [number, number, number], 180);
            p.noStroke();
            p.textAlign(p.CENTER);
            p.textSize(Math.max(9, 11 / camera.zoom));
            p.textFont('Space Mono, monospace');
            p.text(node.document.name, pos.x, pos.y + displaySize / 2 + 12 / camera.zoom);
          }
        });
      };

      // ── checkHover (from arcana page.tsx:1200-1219) ──
      const checkHover = () => {
        const worldPos = screenToWorld(p.mouseX, p.mouseY);
        let found: CanvasNode | null = null;
        for (const node of memoryNodesRef.current) {
          const d = p.dist(worldPos.x, worldPos.y, node.pos.x, node.pos.y);
          if (d < node.size * 2) { found = node; break; }
        }
        const currentId = hoveredNodeRef.current?.memoryId;
        const foundId = found?.memoryId;
        if (foundId !== currentId) {
          hoveredNodeRef.current = found;
          setHoveredNode(found);
        }
      };

      // ── p5 setup (from arcana page.tsx:1221-1235) ──
      p.setup = () => {
        const container = containerRef.current!;
        const rect = container.getBoundingClientRect();
        p.createCanvas(rect.width, rect.height);
        p.smooth();
        cameraRef.current.x = p.width / 2;
        cameraRef.current.y = p.height / 2;
        initializeNeuralTopology();
      };

      // ── p5 draw (from arcana page.tsx:1237-1267) ──
      p.draw = () => {
        p.background(...colorsRef.current.bg);
        const camera = cameraRef.current;
        camera.zoom = p.lerp(camera.zoom, camera.targetZoom, 0.1);
        p.push();
        p.translate(camera.x, camera.y);
        p.scale(camera.zoom);
        drawGrid();
        timeRef.current += 0.01;
        if (!isDraggingRef.current) {
          applyForces();
          updateNodes();
        }
        drawConnections();
        drawClusters();
        drawMemoryNodes();
        p.pop();
        checkHover();
      };

      // ── mousePressed (from arcana page.tsx:1269-1290) ──
      p.mousePressed = () => {
        const worldPos = screenToWorld(p.mouseX, p.mouseY);
        let clickedNode: CanvasNode | null = null;
        for (const node of memoryNodesRef.current) {
          const d = p.dist(worldPos.x, worldPos.y, node.pos.x, node.pos.y);
          if (d < node.size * 2) { clickedNode = node; break; }
        }
        if (clickedNode) {
          setSelectedNode(clickedNode);
          clickedNode.lastAccessed = Date.now();
          const dto = nodesDataRef.current.find(n => n.id === clickedNode!.memoryData.id);
          onNodeSelectRef.current?.(dto ?? null);
        } else {
          isDraggingRef.current = true;
          setIsDragging(true);
          dragStartRef.current = { x: p.mouseX - cameraRef.current.x, y: p.mouseY - cameraRef.current.y };
        }
      };

      // ── mouseDragged (from arcana page.tsx:1292-1297) ──
      p.mouseDragged = () => {
        if (isDraggingRef.current && !hoveredNodeRef.current) {
          cameraRef.current.x = p.mouseX - dragStartRef.current.x;
          cameraRef.current.y = p.mouseY - dragStartRef.current.y;
        }
      };

      // ── mouseReleased ──
      p.mouseReleased = () => {
        isDraggingRef.current = false;
        setIsDragging(false);
      };

      // ── mouseWheel (from arcana page.tsx:1303-1309) ──
      (p as any).mouseWheel = (event: any) => {
        const zoomSensitivity = 0.001;
        const zoomDelta = -event.delta * zoomSensitivity;
        cameraRef.current.targetZoom *= (1 + zoomDelta);
        cameraRef.current.targetZoom = p.constrain(cameraRef.current.targetZoom, 0.3, 3.0);
        return false;
      };

      // ── windowResized ──
      p.windowResized = () => {
        const container = containerRef.current;
        if (container) {
          const rect = container.getBoundingClientRect();
          p.resizeCanvas(rect.width, rect.height);
        }
      };
    };

    const p5Instance = new p5(sketch, containerRef.current);
    p5Ref.current = p5Instance;

    // Also handle resize via ResizeObserver for more reliable sizing
    const observer = new ResizeObserver(() => {
      if (p5Ref.current && containerRef.current) {
        const rect = containerRef.current.getBoundingClientRect();
        p5Ref.current.resizeCanvas(rect.width, rect.height);
      }
    });
    observer.observe(containerRef.current);

    return () => {
      observer.disconnect();
      p5Instance.remove();
      p5Ref.current = null;
    };
  }, [nodes, edges, physics]);

  return (
    <div
      ref={containerRef}
      className="w-full h-full"
      style={{ cursor: isDragging ? 'grabbing' : 'grab' }}
    />
  );
}
