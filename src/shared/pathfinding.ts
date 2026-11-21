import {
  GridPoint,
  PathResult,
  PathSegment,
  PlacedTower,
  RoundConfig,
  TOWER_SPECS,
} from './types.js';

export type PlacementFailCode =
  | 'OUT_OF_BOUNDS'
  | 'GATEWAY'
  | 'OCCUPIED_KEEP'
  | 'OCCUPIED_SPIRE'
  | 'OCCUPIED_PILLAR'
  | 'OCCUPIED_PAD'
  | 'BLOCKS_PATH'
  | 'NO_PILLARS';

export interface PlacementValidationResult {
  valid: boolean;
  reason?: string;
  reasonCode?: PlacementFailCode;
  pathResult?: PathResult;
}

export interface SmartPlacementOptions {
  mode: 'mouse' | 'touch';
  availableGold?: number;
}

export interface SmartPlacementResult {
  x: number;
  y: number;
  snapped: boolean;
  valid: boolean;
  reason?: string;
  reasonCode?: PlacementFailCode;
  pathResult?: PathResult;
}

export interface SpireConduitLink {
  spireIndex: number;
  spireX: number;
  spireY: number;
  fromX: number;
  fromY: number;
  overchargeTier: number;
}

export interface CitadelCircuitryResult {
  linkedKeeps: number;
  overchargedSpires: number;
  spireOverchargeTiers: number[];
  linkedKeepIndices: Set<number>;
  poweredNodeKeys: Set<string>;
  spireConduitLinks: SpireConduitLink[];
}

const MOUSE_SNAP_MAX_DIST = 1.42;
const TOUCH_SNAP_MAX_DIST = 1.75;
const HEURISTIC_TIE_SCALE = 0.9995;

const ASTAR_DIRS: ReadonlyArray<{ dx: number; dy: number; cost: number }> = [
  { dx: 0, dy: -1, cost: 1.0 },
  { dx: 1, dy: 0, cost: 1.0 },
  { dx: 0, dy: 1, cost: 1.0 },
  { dx: -1, dy: 0, cost: 1.0 },
  { dx: 1, dy: -1, cost: Math.SQRT2 },
  { dx: 1, dy: 1, cost: Math.SQRT2 },
  { dx: -1, dy: 1, cost: Math.SQRT2 },
  { dx: -1, dy: -1, cost: Math.SQRT2 },
];

// Reusable single-threaded A* TypedArray scratch buffers (zero per-call heap churn)
let scratchCapacity = 0;
let scratchGScore = new Float64Array(0);
let scratchFScore = new Float64Array(0);
let scratchCameFrom = new Int32Array(0);
let scratchClosed = new Uint8Array(0);
let scratchHeapNodes = new Int32Array(0);
let scratchHeapPos = new Int32Array(0);

function ensureAStarScratch(totalCells: number): void {
  if (scratchCapacity >= totalCells) return;
  scratchCapacity = Math.max(totalCells, 1024);
  scratchGScore = new Float64Array(scratchCapacity);
  scratchFScore = new Float64Array(scratchCapacity);
  scratchCameFrom = new Int32Array(scratchCapacity);
  scratchClosed = new Uint8Array(scratchCapacity);
  scratchHeapNodes = new Int32Array(scratchCapacity);
  scratchHeapPos = new Int32Array(scratchCapacity);
}

function overlapsRect(
  ax: number,
  ay: number,
  aw: number,
  ah: number,
  bx: number,
  by: number,
  bw: number,
  bh: number
): boolean {
  return ax < bx + bw && ax + aw > bx && ay < by + bh && ay + ah > by;
}

/**
 * Checks if a cell (cx, cy) is inside a 2x2 structure/pad at top-left (pad.x, pad.y).
 */
export function isCellIn2x2(cx: number, cy: number, pad: GridPoint): boolean {
  return cx >= pad.x && cx <= pad.x + 1 && cy >= pad.y && cy <= pad.y + 1;
}

/**
 * Checks if two 2x2 footprints at (ax, ay) and (bx, by) overlap.
 */
export function do2x2Overlap(
  ax: number,
  ay: number,
  bx: number,
  by: number
): boolean {
  return ax < bx + 2 && ax + 2 > bx && ay < by + 2 && ay + 2 > by;
}

/**
 * Checks whether a 2x2 footprint at (x, y) overlaps the protected North Gate entrance
 * (`2x1` at `y = 0`, or `2x2` if interior) or South Shrine exit (`2x1` at `y = gridHeight - 1`, or `2x2` if interior).
 */
function overlapsGateThreshold(
  round: RoundConfig,
  x: number,
  y: number,
  fp = 2
): boolean {
  const spawnIsTop = round.spawn.y === 0;
  const spawnY = spawnIsTop ? 0 : round.spawn.y;
  const spawnH = spawnIsTop ? 1 : 2;
  if (overlapsRect(x, y, fp, fp, round.spawn.x, spawnY, 2, spawnH)) {
    return true;
  }

  const exitIsBottom = round.exit.y >= round.gridHeight - 2;
  const exitY = exitIsBottom ? round.gridHeight - 1 : round.exit.y;
  const exitH = exitIsBottom ? 1 : 2;
  if (overlapsRect(x, y, fp, fp, round.exit.x, exitY, 2, exitH)) {
    return true;
  }

  return false;
}

function isCellInGateThreshold(
  round: RoundConfig,
  cx: number,
  cy: number
): boolean {
  const spawnIsTop = round.spawn.y === 0;
  if (spawnIsTop) {
    if (cy === 0 && cx >= round.spawn.x && cx <= round.spawn.x + 1) return true;
  } else if (isCellIn2x2(cx, cy, round.spawn)) {
    return true;
  }

  const exitIsBottom = round.exit.y >= round.gridHeight - 2;
  if (exitIsBottom) {
    if (
      cy === round.gridHeight - 1 &&
      cx >= round.exit.x &&
      cx <= round.exit.x + 1
    ) {
      return true;
    }
  } else if (isCellIn2x2(cx, cy, round.exit)) {
    return true;
  }

  return false;
}

function overlapsReservedPad(round: RoundConfig, x: number, y: number): boolean {
  for (let i = 0; i < round.checkpoints.length; i++) {
    const cp = round.checkpoints[i];
    if (do2x2Overlap(x, y, cp.x, cp.y)) return true;
  }
  if (round.waygate) {
    if (
      do2x2Overlap(x, y, round.waygate.entry.x, round.waygate.entry.y) ||
      do2x2Overlap(x, y, round.waygate.exit.x, round.waygate.exit.y)
    ) {
      return true;
    }
  }
  return false;
}

function mark2x2Cells(
  grid: boolean[][],
  gridWidth: number,
  gridHeight: number,
  x: number,
  y: number,
  walkableValue: boolean
): void {
  if (!Number.isInteger(x) || !Number.isInteger(y)) return;
  for (let dy = 0; dy < 2; dy++) {
    const cy = y + dy;
    if (cy < 0 || cy >= gridHeight) continue;
    const row = grid[cy];
    for (let dx = 0; dx < 2; dx++) {
      const cx = x + dx;
      if (cx >= 0 && cx < gridWidth) {
        row[cx] = walkableValue;
      }
    }
  }
}

/**
 * Builds a 2D boolean grid of walkable cells (true = walkable, false = blocked).
 * Pre-placed Crimson Keeps (`obstacles`), Elemental Spires (`preplacedSpires`),
 * and player-placed Stone Walls (`towers`) block movement on their 2x2 footprint.
 * Frost Mires, Haste Rifts, Checkpoints, and Waygates remain walkable.
 */
export function buildWalkableGrid(
  round: RoundConfig,
  towers: PlacedTower[]
): boolean[][] {
  const { gridWidth, gridHeight, obstacles, preplacedSpires } = round;
  const grid: boolean[][] = Array.from({ length: gridHeight }, () =>
    Array<boolean>(gridWidth).fill(true)
  );

  for (let i = 0; i < obstacles.length; i++) {
    const obs = obstacles[i];
    mark2x2Cells(grid, gridWidth, gridHeight, obs.x, obs.y, false);
  }
  for (let i = 0; i < preplacedSpires.length; i++) {
    const spire = preplacedSpires[i];
    mark2x2Cells(grid, gridWidth, gridHeight, spire.x, spire.y, false);
  }
  for (let i = 0; i < towers.length; i++) {
    const tower = towers[i];
    mark2x2Cells(grid, gridWidth, gridHeight, tower.x, tower.y, false);
  }

  return grid;
}

/**
 * Checks if a 2x2 footprint at (x, y) overlaps any pre-placed Crimson Keep, Elemental Spire,
 * Gate threshold, Checkpoint, or Waygate pad.
 */
export function overlapsPreplacedStructure(
  round: RoundConfig,
  x: number,
  y: number
): boolean {
  if (overlapsGateThreshold(round, x, y, 2)) return true;

  for (let i = 0; i < round.obstacles.length; i++) {
    const obs = round.obstacles[i];
    if (do2x2Overlap(x, y, obs.x, obs.y)) return true;
  }
  for (let i = 0; i < round.preplacedSpires.length; i++) {
    const spire = round.preplacedSpires[i];
    if (do2x2Overlap(x, y, spire.x, spire.y)) return true;
  }
  if (overlapsReservedPad(round, x, y)) return true;

  return false;
}

/**
 * Admissible & consistent clamped Euclidean distance from cell (nx, ny) to the rectangular goal cell set
 * `[gx0, gx1] x [gy0, gy1]`. Never overestimates multi-cell 2x1 / 2x2 targets.
 */
function goalBoxHeuristic(
  nx: number,
  ny: number,
  gx0: number,
  gx1: number,
  gy0: number,
  gy1: number
): number {
  const dx = nx < gx0 ? gx0 - nx : nx > gx1 ? nx - gx1 : 0;
  const dy = ny < gy0 ? gy0 - ny : ny > gy1 ? ny - gy1 : 0;
  return Math.hypot(dx, dy) * HEURISTIC_TIE_SCALE;
}

/**
 * A* pathfinding between two 2x2 pads on the walkable grid using an inline binary min-heap,
 * admissible clamped goal-box heuristic, and strict 8-directional no-corner-cutting rule.
 */
function findSegmentPath(
  walkable: boolean[][],
  width: number,
  height: number,
  startPad: GridPoint,
  goalPad: GridPoint
): { points: GridPoint[]; distance: number } | null {
  if (width <= 0 || height <= 0) return null;

  const startX = startPad.x;
  const startY = startPad.y;
  const goalX = goalPad.x;
  const goalY = goalPad.y;

  const isTopBorderStart = startY === 0;
  const isBottomBorderGoal = goalY >= height - 2;

  const gx0 = goalX;
  const gx1 = goalX + 1;
  const gy0 = isBottomBorderGoal ? height - 1 : goalY;
  const gy1 = isBottomBorderGoal ? height - 1 : goalY + 1;

  const totalCells = width * height;
  ensureAStarScratch(totalCells);

  const gScore = scratchGScore;
  const fScore = scratchFScore;
  const cameFrom = scratchCameFrom;
  const closed = scratchClosed;
  const heapNodes = scratchHeapNodes;
  const heapPos = scratchHeapPos;

  gScore.fill(Infinity, 0, totalCells);
  fScore.fill(Infinity, 0, totalCells);
  cameFrom.fill(-1, 0, totalCells);
  closed.fill(0, 0, totalCells);
  heapPos.fill(-1, 0, totalCells);

  let heapSize = 0;

  const heapPushOrUpdate = (nodeIdx: number): void => {
    let pos = heapPos[nodeIdx];
    if (pos === -1) {
      pos = heapSize++;
      heapNodes[pos] = nodeIdx;
      heapPos[nodeIdx] = pos;
    }
    const nodeF = fScore[nodeIdx];
    while (pos > 0) {
      const parentPos = (pos - 1) >> 1;
      const parentIdx = heapNodes[parentPos];
      const parentF = fScore[parentIdx];
      if (nodeF < parentF || (nodeF === parentF && nodeIdx < parentIdx)) {
        heapNodes[pos] = parentIdx;
        heapPos[parentIdx] = pos;
        pos = parentPos;
      } else {
        break;
      }
    }
    heapNodes[pos] = nodeIdx;
    heapPos[nodeIdx] = pos;
  };

  const heapPop = (): number => {
    const topIdx = heapNodes[0];
    heapPos[topIdx] = -1;
    heapSize--;
    if (heapSize > 0) {
      const lastIdx = heapNodes[heapSize];
      const lastF = fScore[lastIdx];
      let pos = 0;
      const half = heapSize >> 1;
      while (pos < half) {
        let bestChildPos = (pos << 1) + 1;
        let bestChildIdx = heapNodes[bestChildPos];
        let bestChildF = fScore[bestChildIdx];
        const rightPos = bestChildPos + 1;
        if (rightPos < heapSize) {
          const rightIdx = heapNodes[rightPos];
          const rightF = fScore[rightIdx];
          if (
            rightF < bestChildF ||
            (rightF === bestChildF && rightIdx < bestChildIdx)
          ) {
            bestChildPos = rightPos;
            bestChildIdx = rightIdx;
            bestChildF = rightF;
          }
        }
        if (
          bestChildF < lastF ||
          (bestChildF === lastF && bestChildIdx < lastIdx)
        ) {
          heapNodes[pos] = bestChildIdx;
          heapPos[bestChildIdx] = pos;
          pos = bestChildPos;
        } else {
          break;
        }
      }
      heapNodes[pos] = lastIdx;
      heapPos[lastIdx] = pos;
    }
    return topIdx;
  };

  const startDyMax = isTopBorderStart ? 0 : 1;
  for (let dy = 0; dy <= startDyMax; dy++) {
    const sy = startY + dy;
    if (sy < 0 || sy >= height) continue;
    const row = walkable[sy];
    for (let dx = 0; dx <= 1; dx++) {
      const sx = startX + dx;
      if (sx >= 0 && sx < width && row[sx]) {
        const idx = sy * width + sx;
        gScore[idx] = 0;
        fScore[idx] = goalBoxHeuristic(sx, sy, gx0, gx1, gy0, gy1);
        heapPushOrUpdate(idx);
      }
    }
  }

  let reachedGoalIdx = -1;

  while (heapSize > 0) {
    const bestIdx = heapPop();
    if (closed[bestIdx]) continue;
    closed[bestIdx] = 1;

    const cx = bestIdx % width;
    const cy = (bestIdx - cx) / width;

    if (cx >= gx0 && cx <= gx1 && cy >= gy0 && cy <= gy1) {
      reachedGoalIdx = bestIdx;
      break;
    }

    const currentG = gScore[bestIdx];

    for (let dirIdx = 0; dirIdx < ASTAR_DIRS.length; dirIdx++) {
      const d = ASTAR_DIRS[dirIdx];
      const nx = cx + d.dx;
      const ny = cy + d.dy;

      if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
      if (!walkable[ny][nx]) continue;

      // Strict no-corner-cutting rule: diagonal step requires both orthogonal neighbors walkable
      if (d.dx !== 0 && d.dy !== 0) {
        if (!walkable[cy][nx] || !walkable[ny][cx]) continue;
      }

      const nIdx = ny * width + nx;
      if (closed[nIdx]) continue;

      const tentativeG = currentG + d.cost;
      if (tentativeG < gScore[nIdx]) {
        cameFrom[nIdx] = bestIdx;
        gScore[nIdx] = tentativeG;
        fScore[nIdx] =
          tentativeG + goalBoxHeuristic(nx, ny, gx0, gx1, gy0, gy1);
        heapPushOrUpdate(nIdx);
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

function computeMazePathOnWalkable(
  round: RoundConfig,
  walkable: boolean[][]
): PathResult {
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
 * Computes the complete path from the North Gate entrance to the South Shrine exit.
 */
export function computeFullMazePath(
  round: RoundConfig,
  towers: PlacedTower[]
): PathResult {
  const walkable = buildWalkableGrid(round, towers);
  return computeMazePathOnWalkable(round, walkable);
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
  return findSegmentPath(
    walkable,
    round.gridWidth,
    round.gridHeight,
    fromPad,
    toPad
  );
}

/**
 * Fast static check (bounds, gate mouth, Keep, Spire, Pad, or existing Stone Wall overlap)
 * prior to running A* path validation.
 */
function checkStaticFootprint(
  round: RoundConfig,
  existingTowers: PlacedTower[],
  x: number,
  y: number
): PlacementValidationResult | null {
  const fp = TOWER_SPECS.BLOCK.footprint;

  if (
    !Number.isInteger(x) ||
    !Number.isInteger(y) ||
    x < 0 ||
    y < 0 ||
    x + fp > round.gridWidth ||
    y + fp > round.gridHeight
  ) {
    return {
      valid: false,
      reason: 'Out of bounds',
      reasonCode: 'OUT_OF_BOUNDS',
    };
  }

  if (overlapsGateThreshold(round, x, y, fp)) {
    return {
      valid: false,
      reason: 'Gate threshold',
      reasonCode: 'GATEWAY',
    };
  }

  for (let i = 0; i < round.obstacles.length; i++) {
    const obs = round.obstacles[i];
    if (do2x2Overlap(x, y, obs.x, obs.y)) {
      return {
        valid: false,
        reason: 'Needs 2×2 space',
        reasonCode: 'OCCUPIED_KEEP',
      };
    }
  }

  for (let i = 0; i < round.preplacedSpires.length; i++) {
    const spire = round.preplacedSpires[i];
    if (do2x2Overlap(x, y, spire.x, spire.y)) {
      return {
        valid: false,
        reason: 'Needs 2×2 space',
        reasonCode: 'OCCUPIED_SPIRE',
      };
    }
  }

  if (overlapsReservedPad(round, x, y)) {
    return {
      valid: false,
      reason: 'Needs 2×2 space',
      reasonCode: 'OCCUPIED_PAD',
    };
  }

  for (let i = 0; i < existingTowers.length; i++) {
    const existing = existingTowers[i];
    if (do2x2Overlap(x, y, existing.x, existing.y)) {
      return {
        valid: false,
        reason: 'Needs 2×2 space',
        reasonCode: 'OCCUPIED_PILLAR',
      };
    }
  }

  return null;
}

function validatePathWithCandidateOnWalkable(
  round: RoundConfig,
  walkable: boolean[][],
  x: number,
  y: number
): PlacementValidationResult {
  const { gridWidth, gridHeight } = round;
  mark2x2Cells(walkable, gridWidth, gridHeight, x, y, false);

  const pathResult = computeMazePathOnWalkable(round, walkable);
  let waygateReachable = true;
  if (pathResult.valid && round.waygate) {
    const waygateTarget =
      round.checkpoints.length > 0 ? round.checkpoints[0] : round.exit;
    const wgSeg = findSegmentPath(
      walkable,
      gridWidth,
      gridHeight,
      round.waygate.exit,
      waygateTarget
    );
    const wgToExit =
      waygateTarget === round.exit
        ? wgSeg
        : findSegmentPath(
            walkable,
            gridWidth,
            gridHeight,
            round.waygate.exit,
            round.exit
          );
    if (!wgSeg || !wgToExit) {
      waygateReachable = false;
    }
  }

  mark2x2Cells(walkable, gridWidth, gridHeight, x, y, true);

  if (!pathResult.valid || !waygateReachable) {
    return {
      valid: false,
      reason: 'Blocks exit path',
      reasonCode: 'BLOCKS_PATH',
    };
  }

  return { valid: true, pathResult };
}

/**
 * Validates whether a 2x2 Stone Wall ('BLOCK') can be placed at integer top-left cell (x, y).
 * Guards against non-integer/NaN payloads, protects 2x1 gate mouths & reserved pads,
 * and ensures a valid path (including Waygate exit reachability when active) remains open.
 */
export function validateTowerPlacement(
  round: RoundConfig,
  existingTowers: PlacedTower[],
  x: number,
  y: number
): PlacementValidationResult {
  const staticErr = checkStaticFootprint(round, existingTowers, x, y);
  if (staticErr) return staticErr;

  const walkable = buildWalkableGrid(round, existingTowers);
  return validatePathWithCandidateOnWalkable(round, walkable, x, y);
}

function isSingleCellOpenGrass(
  round: RoundConfig,
  existingTowers: PlacedTower[],
  cx: number,
  cy: number
): boolean {
  if (cx < 0 || cy < 0 || cx >= round.gridWidth || cy >= round.gridHeight) {
    return false;
  }
  if (isCellInGateThreshold(round, cx, cy)) return false;

  for (let i = 0; i < round.obstacles.length; i++) {
    if (isCellIn2x2(cx, cy, round.obstacles[i])) return false;
  }
  for (let i = 0; i < round.preplacedSpires.length; i++) {
    if (isCellIn2x2(cx, cy, round.preplacedSpires[i])) return false;
  }
  for (let i = 0; i < existingTowers.length; i++) {
    if (isCellIn2x2(cx, cy, existingTowers[i])) return false;
  }
  for (let i = 0; i < round.checkpoints.length; i++) {
    if (isCellIn2x2(cx, cy, round.checkpoints[i])) return false;
  }
  if (round.waygate) {
    if (
      isCellIn2x2(cx, cy, round.waygate.entry) ||
      isCellIn2x2(cx, cy, round.waygate.exit)
    ) {
      return false;
    }
  }
  return true;
}

/**
 * Resolves continuous island-space coordinates `(wx, wy)` to an accurate `2x2` top-left cell `(x, y)`
 * with flush-snap assist around Keeps, Spires, Walls, and Gates:
 * - Eliminates the `0.5m` `'Occupied'` dead-moat (`r <= 1.42m` in `'mouse'` mode when cursor cell is open grass;
 *   `r <= 1.75m` in `'touch'` mode).
 * - Never jumps across walls when `(rawX, rawY)` is open grass that fails `'BLOCKS_PATH'`.
 */
export function resolveSmart2x2Placement(
  round: RoundConfig,
  existingTowers: PlacedTower[],
  wx: number,
  wy: number,
  options?: SmartPlacementOptions
): SmartPlacementResult {
  const mode = options?.mode ?? 'mouse';
  const noPillarsLeft =
    options?.availableGold !== undefined &&
    options.availableGold < TOWER_SPECS.BLOCK.goldCost;

  if (!Number.isFinite(wx) || !Number.isFinite(wy)) {
    return {
      x: 0,
      y: 0,
      snapped: false,
      valid: false,
      reason: 'Out of bounds',
      reasonCode: 'OUT_OF_BOUNDS',
    };
  }

  const maxApron = mode === 'touch' ? 1.6 : 0.85;
  if (
    wx < -maxApron ||
    wx > round.gridWidth + maxApron ||
    wy < -maxApron ||
    wy > round.gridHeight + maxApron
  ) {
    const clampedOutX = Math.max(
      0,
      Math.min(Math.max(0, round.gridWidth - 2), Math.round(wx - 1))
    );
    const clampedOutY = Math.max(
      0,
      Math.min(Math.max(0, round.gridHeight - 2), Math.round(wy - 1))
    );
    return {
      x: clampedOutX,
      y: clampedOutY,
      snapped: false,
      valid: false,
      reason: 'Out of bounds',
      reasonCode: 'OUT_OF_BOUNDS',
    };
  }

  const maxX = Math.max(0, round.gridWidth - 2);
  const maxY = Math.max(0, round.gridHeight - 2);
  const rawX = Math.max(0, Math.min(maxX, Math.round(wx - 1)));
  const rawY = Math.max(0, Math.min(maxY, Math.round(wy - 1)));

  const walkable = buildWalkableGrid(round, existingTowers);

  const rawStaticErr = checkStaticFootprint(round, existingTowers, rawX, rawY);
  const rawValidation =
    rawStaticErr ??
    validatePathWithCandidateOnWalkable(round, walkable, rawX, rawY);

  const finalizeResult = (
    x: number,
    y: number,
    snapped: boolean,
    val: PlacementValidationResult
  ): SmartPlacementResult => {
    if (noPillarsLeft && val.valid) {
      return {
        x,
        y,
        snapped,
        valid: false,
        reason: 'No walls left',
        reasonCode: 'NO_PILLARS',
      };
    }
    return {
      x,
      y,
      snapped,
      valid: val.valid,
      reason: val.reason,
      reasonCode: val.reasonCode,
      pathResult: val.pathResult,
    };
  };

  // 1. Exact raw 2x2 slot is already valid (or genuinely blocks an open corridor) -> never snap away!
  if (rawValidation.valid || rawValidation.reasonCode === 'BLOCKS_PATH') {
    return finalizeResult(rawX, rawY, false, rawValidation);
  }

  // 2. Raw 2x2 slot overlapped a Keep, Spire, Wall, Gate, or Pad -> check flush-snap eligibility
  const clampedCellX = Math.max(
    0,
    Math.min(round.gridWidth - 1, Math.floor(wx))
  );
  const clampedCellY = Math.max(
    0,
    Math.min(round.gridHeight - 1, Math.floor(wy))
  );

  const canAssistSnap =
    mode === 'touch' ||
    isSingleCellOpenGrass(round, existingTowers, clampedCellX, clampedCellY);

  if (!canAssistSnap) {
    return finalizeResult(rawX, rawY, false, rawValidation);
  }

  const maxDist = mode === 'touch' ? TOUCH_SNAP_MAX_DIST : MOUSE_SNAP_MAX_DIST;
  const maxDistSq = maxDist * maxDist;
  const searchSpan = mode === 'touch' ? 2 : 1;

  const candidates: Array<{ x: number; y: number; distSq: number }> = [];
  for (let dy = -searchSpan; dy <= searchSpan; dy++) {
    const ny = rawY + dy;
    if (ny < 0 || ny > maxY) continue;
    for (let dx = -searchSpan; dx <= searchSpan; dx++) {
      if (dx === 0 && dy === 0) continue;
      const nx = rawX + dx;
      if (nx < 0 || nx > maxX) continue;

      const centerDx = nx + 1.0 - wx;
      const centerDy = ny + 1.0 - wy;
      const distSq = centerDx * centerDx + centerDy * centerDy;
      if (distSq > maxDistSq) continue;

      if (checkStaticFootprint(round, existingTowers, nx, ny) !== null) {
        continue;
      }
      candidates.push({ x: nx, y: ny, distSq });
    }
  }

  candidates.sort((a, b) => a.distSq - b.distSq || a.y - b.y || a.x - b.x);

  for (let i = 0; i < candidates.length; i++) {
    const cand = candidates[i];
    const candVal = validatePathWithCandidateOnWalkable(
      round,
      walkable,
      cand.x,
      cand.y
    );
    if (candVal.valid) {
      return finalizeResult(cand.x, cand.y, true, candVal);
    }
  }

  // If no valid slot exists nearby, surface 'No walls left' in touch mode if out of budget, else raw overlap error
  if (noPillarsLeft && mode === 'touch') {
    return {
      x: rawX,
      y: rawY,
      snapped: false,
      valid: false,
      reason: 'No walls left',
      reasonCode: 'NO_PILLARS',
    };
  }

  return finalizeResult(rawX, rawY, false, rawValidation);
}

/**
 * Computes the Citadel Circuitry network:
 * - Player Stone Walls, Crimson Keeps (`obstacles`), and touching Elemental Spires (`|dx|<=2 && |dy|<=2`)
 *   form conductive masonry components when at least one Player Stone Wall and one Crimson Keep are linked.
 * - Any Elemental Spire within `|dx|<=3 && |dy|<=3 && dx^2 + dy^2 <= 13` (touching or wrapped by a 1-tile corridor,
 *   excluding far `(±3, ±3)` corners outside Spire AoE) of a powered Wall/Keep chain gains +1 Overcharge Tier
 *   per distinct Crimson Keep in that chain (capped at Tier 3 ◆◆◆).
 * - Emits `poweredNodeKeys` and deduplicated `spireConduitLinks` for inlaid gold ground ley-line rendering.
 */
export function computeCitadelCircuitry(
  round: RoundConfig,
  towers: PlacedTower[]
): CitadelCircuitryResult {
  interface CircuitNode {
    x: number;
    y: number;
    kind: 'PLAYER' | 'KEEP' | 'SPIRE';
    keepIdx: number;
    spireIdx: number;
  }

  const nodes: CircuitNode[] = [];
  for (let i = 0; i < towers.length; i++) {
    const t = towers[i];
    nodes.push({ x: t.x, y: t.y, kind: 'PLAYER', keepIdx: -1, spireIdx: -1 });
  }
  for (let i = 0; i < round.obstacles.length; i++) {
    const o = round.obstacles[i];
    nodes.push({ x: o.x, y: o.y, kind: 'KEEP', keepIdx: i, spireIdx: -1 });
  }
  for (let i = 0; i < round.preplacedSpires.length; i++) {
    const s = round.preplacedSpires[i];
    nodes.push({ x: s.x, y: s.y, kind: 'SPIRE', keepIdx: -1, spireIdx: i });
  }

  const nodeCount = nodes.length;
  const visited = new Uint8Array(nodeCount);
  const linkedKeepIndices = new Set<number>();
  const poweredNodeKeys = new Set<string>();
  const spireCount = round.preplacedSpires.length;
  const spireKeepSets: Array<Set<number>> = Array.from(
    { length: spireCount },
    () => new Set<number>()
  );
  const pendingConduits: Array<{
    spireIndex: number;
    spireX: number;
    spireY: number;
    fromX: number;
    fromY: number;
  }> = [];

  for (let i = 0; i < nodeCount; i++) {
    if (visited[i]) continue;
    const comp: number[] = [];
    const queue: number[] = [i];
    visited[i] = 1;

    let head = 0;
    while (head < queue.length) {
      const curr = queue[head++];
      comp.push(curr);
      const cn = nodes[curr];
      for (let j = 0; j < nodeCount; j++) {
        if (visited[j]) continue;
        const nn = nodes[j];
        if (Math.abs(cn.x - nn.x) <= 2 && Math.abs(cn.y - nn.y) <= 2) {
          visited[j] = 1;
          queue.push(j);
        }
      }
    }

    let hasPlayerWall = false;
    const compKeeps: number[] = [];
    for (let c = 0; c < comp.length; c++) {
      const n = nodes[comp[c]];
      if (n.kind === 'PLAYER') {
        hasPlayerWall = true;
      } else if (n.kind === 'KEEP' && n.keepIdx >= 0) {
        compKeeps.push(n.keepIdx);
      }
    }

    if (!hasPlayerWall || compKeeps.length === 0) continue;

    for (let k = 0; k < compKeeps.length; k++) {
      linkedKeepIndices.add(compKeeps[k]);
    }

    const compWallAndKeepIndices: number[] = [];
    for (let c = 0; c < comp.length; c++) {
      const idx = comp[c];
      const n = nodes[idx];
      if (n.kind === 'PLAYER' || n.kind === 'KEEP') {
        poweredNodeKeys.add(`${n.x},${n.y}`);
        compWallAndKeepIndices.push(idx);
      }
    }

    for (let sIdx = 0; sIdx < spireCount; sIdx++) {
      const spire = round.preplacedSpires[sIdx];
      let bestSourceIdx = -1;
      let bestDistSq = Infinity;
      let bestIsPlayer = false;

      // Primary check: closest powered Wall/Keep in this component within |dx|<=3, |dy|<=3, dx^2+dy^2<=13
      for (let w = 0; w < compWallAndKeepIndices.length; w++) {
        const candIdx = compWallAndKeepIndices[w];
        const wn = nodes[candIdx];
        const dx = wn.x - spire.x;
        const dy = wn.y - spire.y;
        if (Math.abs(dx) > 3 || Math.abs(dy) > 3) continue;
        const distSq = dx * dx + dy * dy;
        if (distSq > 13) continue;

        const isPlayer = wn.kind === 'PLAYER';
        if (
          distSq < bestDistSq ||
          (distSq === bestDistSq && isPlayer && !bestIsPlayer)
        ) {
          bestDistSq = distSq;
          bestSourceIdx = candIdx;
          bestIsPlayer = isPlayer;
        }
      }

      // Fallback if Spire itself was directly part of the <=2 touching component via another Spire
      if (bestSourceIdx === -1) {
        for (let c = 0; c < comp.length; c++) {
          const candIdx = comp[c];
          const cn = nodes[candIdx];
          if (cn.kind === 'SPIRE' && cn.spireIdx === sIdx) {
            // Find closest non-self node in component touching this Spire
            for (let c2 = 0; c2 < comp.length; c2++) {
              const otherIdx = comp[c2];
              const on = nodes[otherIdx];
              if (on.kind === 'SPIRE' && on.spireIdx === sIdx) continue;
              const dx = on.x - spire.x;
              const dy = on.y - spire.y;
              const distSq = dx * dx + dy * dy;
              if (distSq <= 13 && distSq < bestDistSq) {
                bestDistSq = distSq;
                bestSourceIdx = otherIdx;
              }
            }
            break;
          }
        }
      }

      if (bestSourceIdx !== -1) {
        for (let k = 0; k < compKeeps.length; k++) {
          spireKeepSets[sIdx].add(compKeeps[k]);
        }
        const src = nodes[bestSourceIdx];
        pendingConduits.push({
          spireIndex: sIdx,
          spireX: spire.x,
          spireY: spire.y,
          fromX: src.x,
          fromY: src.y,
        });
      }
    }
  }

  const spireOverchargeTiers = spireKeepSets.map((set) =>
    Math.min(3, set.size)
  );
  const overchargedSpires = spireOverchargeTiers.reduce((sum, t) => sum + t, 0);

  const spireConduitLinks: SpireConduitLink[] = [];
  const seenConduitPairs = new Set<string>();
  for (let i = 0; i < pendingConduits.length; i++) {
    const pc = pendingConduits[i];
    const tier = spireOverchargeTiers[pc.spireIndex] || 0;
    if (tier <= 0) continue;
    const dedupKey = `${pc.spireIndex}:${pc.fromX},${pc.fromY}`;
    if (seenConduitPairs.has(dedupKey)) continue;
    seenConduitPairs.add(dedupKey);
    spireConduitLinks.push({
      spireIndex: pc.spireIndex,
      spireX: pc.spireX,
      spireY: pc.spireY,
      fromX: pc.fromX,
      fromY: pc.fromY,
      overchargeTier: tier,
    });
  }

  return {
    linkedKeeps: linkedKeepIndices.size,
    overchargedSpires,
    spireOverchargeTiers,
    linkedKeepIndices,
    poweredNodeKeys,
    spireConduitLinks,
  };
}
