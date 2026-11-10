import {
  GridPoint,
  PathResult,
  PathSegment,
  PlacedTower,
  RoundConfig,
  TOWER_SPECS,
} from './types.js';

/**
 * Checks if a cell (cx, cy) is inside a 2x2 structure/pad at top-left (pad.x, pad.y).
 */
export function isCellIn2x2(cx: number, cy: number, pad: GridPoint): boolean {
  return cx >= pad.x && cx <= pad.x + 1 && cy >= pad.y && cy <= pad.y + 1;
}

/**
 * Checks if two 2x2 footprints at (ax, ay) and (bx, by) overlap.
 */
export function do2x2Overlap(ax: number, ay: number, bx: number, by: number): boolean {
  return ax < bx + 2 && ax + 2 > bx && ay < by + 2 && ay + 2 > by;
}

/**
 * Builds a 2D boolean grid of walkable cells (true = walkable, false = blocked).
 * Pre-placed Set Structures (obstacles), pre-placed Storm Spires (preplacedSpires),
 * and player-placed Maze Walls (towers) block movement on their 2x2 footprint.
 * Frost Mires, Haste Rifts, Checkpoints, and Waygates remain walkable!
 */
export function buildWalkableGrid(round: RoundConfig, towers: PlacedTower[]): boolean[][] {
  const { gridWidth, gridHeight, obstacles, preplacedSpires } = round;
  const grid: boolean[][] = Array.from({ length: gridHeight }, () =>
    Array(gridWidth).fill(true)
  );

  const mark2x2Blocked = (pt: GridPoint) => {
    for (let dy = 0; dy < 2; dy++) {
      for (let dx = 0; dx < 2; dx++) {
        const cx = pt.x + dx;
        const cy = pt.y + dy;
        if (cy >= 0 && cy < gridHeight && cx >= 0 && cx < gridWidth) {
          grid[cy][cx] = false;
        }
      }
    }
  };

  for (const obs of obstacles) mark2x2Blocked(obs);
  for (const spire of preplacedSpires) mark2x2Blocked(spire);
  for (const tower of towers) mark2x2Blocked(tower);

  return grid;
}

/**
 * Checks if a 2x2 footprint at (x, y) overlaps any pre-placed obstacle or Storm Spire.
 */
export function overlapsPreplacedStructure(
  round: RoundConfig,
  x: number,
  y: number
): boolean {
  for (const obs of round.obstacles) {
    if (do2x2Overlap(x, y, obs.x, obs.y)) return true;
  }
  for (const spire of round.preplacedSpires) {
    if (do2x2Overlap(x, y, spire.x, spire.y)) return true;
  }
  return false;
}

/**
 * A* pathfinding between two 2x2 pads on the walkable grid.
 * When startPad is at the top border (y === 0), the character enters right at the top border edge (y = 0).
 * When goalPad is at the bottom border (y >= height - 2), the character exits right at the bottom border edge (y = height).
 * Uses 8-directional movement with strict WC3 no-corner-cutting rule.
 */
function findSegmentPath(
  walkable: boolean[][],
  width: number,
  height: number,
  startPad: GridPoint,
  goalPad: GridPoint
): { points: GridPoint[]; distance: number } | null {
  const startX = startPad.x;
  const startY = startPad.y;
  const goalX = goalPad.x;
  const goalY = goalPad.y;

  const isTopBorderStart = startY === 0;
  const isBottomBorderGoal = goalY >= height - 2;
  const goalTargetY = isBottomBorderGoal ? height - 1 : goalY + 0.5;

  const totalCells = width * height;
  const gScore = new Float64Array(totalCells).fill(Infinity);
  const fScore = new Float64Array(totalCells).fill(Infinity);
  const cameFrom = new Int32Array(totalCells).fill(-1);
  const closed = new Uint8Array(totalCells);
  const inOpen = new Uint8Array(totalCells);

  const openList: number[] = [];

  const startDyMax = isTopBorderStart ? 0 : 1;
  for (let dy = 0; dy <= startDyMax; dy++) {
    for (let dx = 0; dx <= 1; dx++) {
      const sx = startX + dx;
      const sy = startY + dy;
      if (sx >= 0 && sx < width && sy >= 0 && sy < height && walkable[sy][sx]) {
        const idx = sy * width + sx;
        gScore[idx] = 0;
        fScore[idx] = Math.hypot(goalX + 0.5 - sx, goalTargetY - sy);
        openList.push(idx);
        inOpen[idx] = 1;
      }
    }
  }

  const dirs = [
    { dx: 0, dy: -1, cost: 1.0 },
    { dx: 1, dy: 0, cost: 1.0 },
    { dx: 0, dy: 1, cost: 1.0 },
    { dx: -1, dy: 0, cost: 1.0 },
    { dx: 1, dy: -1, cost: Math.SQRT2 },
    { dx: 1, dy: 1, cost: Math.SQRT2 },
    { dx: -1, dy: 1, cost: Math.SQRT2 },
    { dx: -1, dy: -1, cost: Math.SQRT2 },
  ];

  let reachedGoalIdx = -1;

  while (openList.length > 0) {
    let bestPos = 0;
    let bestIdx = openList[0];
    let bestF = fScore[bestIdx];
    for (let i = 1; i < openList.length; i++) {
      const idx = openList[i];
      if (fScore[idx] < bestF) {
        bestF = fScore[idx];
        bestIdx = idx;
        bestPos = i;
      }
    }

    openList[bestPos] = openList[openList.length - 1];
    openList.pop();
    inOpen[bestIdx] = 0;

    if (closed[bestIdx]) continue;
    closed[bestIdx] = 1;

    const cx = bestIdx % width;
    const cy = (bestIdx - cx) / width;

    const reachedGoal = isBottomBorderGoal
      ? cx >= goalX && cx <= goalX + 1 && cy === height - 1
      : cx >= goalX && cx <= goalX + 1 && cy >= goalY && cy <= goalY + 1;
    if (reachedGoal) {
      reachedGoalIdx = bestIdx;
      break;
    }

    const currentG = gScore[bestIdx];

    for (const d of dirs) {
      const nx = cx + d.dx;
      const ny = cy + d.dy;

      if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
      if (!walkable[ny][nx]) continue;

      if (d.dx !== 0 && d.dy !== 0) {
        if (!walkable[cy][nx] || !walkable[ny][cx]) continue;
      }

      const nIdx = ny * width + nx;
      if (closed[nIdx]) continue;

      const tentativeG = currentG + d.cost;
      if (tentativeG < gScore[nIdx]) {
        cameFrom[nIdx] = bestIdx;
        gScore[nIdx] = tentativeG;
        const h = Math.hypot(goalX + 0.5 - nx, goalTargetY - ny) * 0.999;
        fScore[nIdx] = tentativeG + h;
        if (!inOpen[nIdx]) {
          openList.push(nIdx);
          inOpen[nIdx] = 1;
        }
      }
    }
  }

  if (reachedGoalIdx === -1) {
    return null;
  }

  const rawCells: GridPoint[] = [];
  let curr = reachedGoalIdx;
  while (curr !== -1) {
    const cx = curr % width;
    const cy = (curr - cx) / width;
    rawCells.push({ x: cx + 0.5, y: cy + 0.5 });
    curr = cameFrom[curr];
  }
  rawCells.reverse();

  const startPoint: GridPoint = {
    x: startPad.x + 1.0,
    y: isTopBorderStart ? 0.0 : startPad.y + 1.0,
  };
  const endPoint: GridPoint = {
    x: goalPad.x + 1.0,
    y: isBottomBorderGoal ? height : goalPad.y + 1.0,
  };

  const points: GridPoint[] = [startPoint, ...rawCells, endPoint];

  let distance = 0;
  for (let i = 1; i < points.length; i++) {
    distance += Math.hypot(
      points[i].x - points[i - 1].x,
      points[i].y - points[i - 1].y
    );
  }

  return { points, distance };
}

/**
 * Computes the complete path from the Top Border Entrance to the Bottom Border Exit.
 */
export function computeFullMazePath(
  round: RoundConfig,
  towers: PlacedTower[]
): PathResult {
  const walkable = buildWalkableGrid(round, towers);
  const waypoints: GridPoint[] = [
    round.spawn,
    ...round.checkpoints,
    round.exit,
  ];

  const segments: PathSegment[] = [];
  const allPoints: GridPoint[] = [];
  let totalDistance = 0;

  for (let i = 0; i < waypoints.length - 1; i++) {
    const seg = findSegmentPath(
      walkable,
      round.gridWidth,
      round.gridHeight,
      waypoints[i],
      waypoints[i + 1]
    );
    if (!seg) {
      return {
        valid: false,
        segments: [],
        allPoints: [],
        totalDistance: 0,
      };
    }

    segments.push({
      fromIndex: i,
      toIndex: i + 1,
      points: seg.points,
      distance: seg.distance,
    });

    if (i === 0) {
      allPoints.push(...seg.points);
    } else {
      allPoints.push(...seg.points.slice(1));
    }
    totalDistance += seg.distance;
  }

  return {
    valid: true,
    segments,
    allPoints,
    totalDistance,
  };
}

/**
 * Helper to find a dynamic path from any 2x2 pad to a target pad.
 */
export function computeSingleSegmentPath(
  round: RoundConfig,
  towers: PlacedTower[],
  fromPad: GridPoint,
  toPad: GridPoint
): { points: GridPoint[]; distance: number } | null {
  const walkable = buildWalkableGrid(round, towers);
  return findSegmentPath(walkable, round.gridWidth, round.gridHeight, fromPad, toPad);
}

/**
 * Validates whether a 2x2 Castle Pillar ('BLOCK') can be placed at top-left cell (x, y).
 * The entire grassland arena is buildable unless occupied by a 3D structure or blocking the path.
 */
export function validateTowerPlacement(
  round: RoundConfig,
  existingTowers: PlacedTower[],
  x: number,
  y: number
): { valid: boolean; reason?: string; pathResult?: PathResult } {
  const fp = TOWER_SPECS.BLOCK.footprint;

  if (x < 0 || y < 0 || x + fp > round.gridWidth || y + fp > round.gridHeight) {
    return { valid: false, reason: 'Out of bounds' };
  }

  if (overlapsPreplacedStructure(round, x, y)) {
    return { valid: false, reason: 'Occupied' };
  }

  for (const existing of existingTowers) {
    if (do2x2Overlap(x, y, existing.x, existing.y)) {
      return { valid: false, reason: 'Occupied' };
    }
  }

  const testTowers: PlacedTower[] = [
    ...existingTowers,
    { id: '__preview__', type: 'BLOCK', x, y, createdAt: 0 },
  ];

  const pathResult = computeFullMazePath(round, testTowers);
  if (!pathResult.valid) {
    return {
      valid: false,
      reason: 'Path Blocked!',
    };
  }

  return { valid: true, pathResult };
}

/**
 * Computes the Citadel Circuitry network:
 * - Any pre-placed Red Keep Pillar (`obstacle`) connected via all-directional (`|dx|<=2 && |dy|<=2`)
 *   chains to at least one player Castle Pillar is counted as `linkedKeeps`.
 * - Any pre-placed Spire whose perimeter (`|dx|<=3 && |dy|<=3` — touching or wrapped by a 1-tile corridor)
 *   is reached by a player-connected wall chain gains +1 Overcharge Tier per Red Keep Pillar in that chain (up to Tier 3).
 */
export function computeCitadelCircuitry(
  round: RoundConfig,
  towers: PlacedTower[]
): {
  linkedKeeps: number;
  overchargedSpires: number;
  spireOverchargeTiers: number[];
  linkedKeepIndices: Set<number>;
} {
  interface WallNode {
    x: number;
    y: number;
    isPlayer: boolean;
    keepIdx: number;
  }

  const nodes: WallNode[] = [
    ...towers.map((t) => ({ x: t.x, y: t.y, isPlayer: true, keepIdx: -1 })),
    ...round.obstacles.map((o, idx) => ({
      x: o.x,
      y: o.y,
      isPlayer: false,
      keepIdx: idx,
    })),
  ];

  const visited = new Uint8Array(nodes.length);
  const linkedKeepIndices = new Set<number>();
  const spireKeepSets: Array<Set<number>> = round.preplacedSpires.map(
    () => new Set<number>()
  );

  for (let i = 0; i < nodes.length; i++) {
    if (visited[i]) continue;
    const comp: number[] = [];
    const queue: number[] = [i];
    visited[i] = 1;

    while (queue.length > 0) {
      const curr = queue.pop()!;
      comp.push(curr);
      const cn = nodes[curr];
      for (let j = 0; j < nodes.length; j++) {
        if (visited[j]) continue;
        const nn = nodes[j];
        if (Math.abs(cn.x - nn.x) <= 2 && Math.abs(cn.y - nn.y) <= 2) {
          visited[j] = 1;
          queue.push(j);
        }
      }
    }

    const hasPlayerPillar = comp.some((idx) => nodes[idx].isPlayer);
    if (!hasPlayerPillar) continue;

    const compKeeps: number[] = [];
    for (const idx of comp) {
      if (!nodes[idx].isPlayer && nodes[idx].keepIdx >= 0) {
        linkedKeepIndices.add(nodes[idx].keepIdx);
        compKeeps.push(nodes[idx].keepIdx);
      }
    }

    if (compKeeps.length > 0) {
      round.preplacedSpires.forEach((spire, sIdx) => {
        const reachesSpirePerimeter = comp.some(
          (idx) =>
            Math.abs(nodes[idx].x - spire.x) <= 3 &&
            Math.abs(nodes[idx].y - spire.y) <= 3
        );
        if (reachesSpirePerimeter) {
          for (const kIdx of compKeeps) {
            spireKeepSets[sIdx].add(kIdx);
          }
        }
      });
    }
  }

  const spireOverchargeTiers = spireKeepSets.map((set) =>
    Math.min(3, set.size)
  );
  const overchargedSpires = spireOverchargeTiers.reduce((sum, t) => sum + t, 0);

  return {
    linkedKeeps: linkedKeepIndices.size,
    overchargedSpires,
    spireOverchargeTiers,
    linkedKeepIndices,
  };
}

