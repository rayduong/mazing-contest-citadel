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
  searchSpanOverride?: 0 | 1 | 2;
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
  keepPoweredSpireCounts: number[];
  poweredNodeKeys: Set<string>;
  overchargedNodeKeys: Set<string>;
  spireConduitLinks: SpireConduitLink[];
}

const MOUSE_SNAP_MAX_DIST = 1.42;
const TOUCH_MOAT_SNAP_MAX_DIST = 1.75;
const TOUCH_OBSTACLE_CORE_SNAP_MAX_DIST = 2.15;
const FLUSH_ALIGNMENT_DIST_SQ_BIAS = 0.06;
const HEURISTIC_TIE_SCALE = 0.999;

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

// Reusable single-threaded A* TypedArray scratch buffers (+1 slot for virtual terminal sink node)
let scratchCapacity = 0;
let scratchGScore = new Float64Array(0);
let scratchFScore = new Float64Array(0);
let scratchCameFrom = new Int32Array(0);
let scratchOriginSeed = new Int32Array(0);
let scratchClosed = new Uint8Array(0);
let scratchHeapNodes = new Int32Array(0);
let scratchHeapPos = new Int32Array(0);

function ensureAStarScratch(requiredSlots: number): void {
  if (scratchCapacity >= requiredSlots) return;
  scratchCapacity = Math.max(requiredSlots, 1024);
  scratchGScore = new Float64Array(scratchCapacity);
  scratchFScore = new Float64Array(scratchCapacity);
  scratchCameFrom = new Int32Array(scratchCapacity);
  scratchOriginSeed = new Int32Array(scratchCapacity);
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
 * Single source of truth for 1x1 sub-cell reticle collision masks (Keeps, Spires,
 * Player Walls, 2x1 Gate mouths, Checkpoints, and Waygate pads).
 */
export function isCellPlacementBlocked(
  round: RoundConfig,
  existingTowers: PlacedTower[],
  cx: number,
  cy: number
): boolean {
  if (
    !Number.isInteger(cx) ||
    !Number.isInteger(cy) ||
    cx < 0 ||
    cy < 0 ||
    cx >= round.gridWidth ||
    cy >= round.gridHeight
  ) {
    return true;
  }
  if (isCellInGateThreshold(round, cx, cy)) return true;

  for (let i = 0; i < round.obstacles.length; i++) {
    if (isCellIn2x2(cx, cy, round.obstacles[i])) return true;
  }
  for (let i = 0; i < round.preplacedSpires.length; i++) {
    if (isCellIn2x2(cx, cy, round.preplacedSpires[i])) return true;
  }
  for (let i = 0; i < existingTowers.length; i++) {
    if (isCellIn2x2(cx, cy, existingTowers[i])) return true;
  }
  for (let i = 0; i < round.checkpoints.length; i++) {
    if (isCellIn2x2(cx, cy, round.checkpoints[i])) return true;
  }
  if (round.waygate) {
    if (
      isCellIn2x2(cx, cy, round.waygate.entry) ||
      isCellIn2x2(cx, cy, round.waygate.exit)
    ) {
      return true;
    }
  }
  return false;
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
 * `[gx0, gx1] x [gy0, gy1]`, with a tiny strictly-admissible lateral hint toward `hintX`.
 */
function goalBoxHeuristic(
  nx: number,
  ny: number,
  gx0: number,
  gx1: number,
  gy0: number,
  gy1: number,
  hintX: number
): number {
  const dx = nx < gx0 ? gx0 - nx : nx > gx1 ? nx - gx1 : 0;
  const dy = ny < gy0 ? gy0 - ny : ny > gy1 ? ny - gy1 : 0;
  if (dx === 0 && dy === 0) return 0;
  const lateralTie = Math.min(0.0004, Math.abs(nx + 0.5 - hintX) * 1e-5);
  return Math.hypot(dx, dy) * HEURISTIC_TIE_SCALE + lateralTie;
}

interface SeedCellEntry {
  x: number;
  y: number;
  initialCost: number;
}

interface WaystoneArrivalBranch {
  cell: GridPoint;
  points: GridPoint[];
  distance: number;
  cumulativeCost: number;
  originSeedIndex: number;
}

interface SegmentQueryOptions {
  startIsTopGate?: boolean;
  goalIsBottomGate?: boolean;
  seedCells?: ReadonlyArray<SeedCellEntry>;
  appendTerminalPoint?: boolean;
  collectAllGoalCells?: boolean;
  applyGatesInline?: boolean;
  nextWaypointHintX?: number;
}

interface SegmentPathInternal {
  points: GridPoint[];
  distance: number;
  reachedCell: GridPoint;
  originSeedIndex: number;
  goalBranches?: WaystoneArrivalBranch[];
}

function computePolylineDistance(points: ReadonlyArray<GridPoint>): number {
  let distance = 0;
  for (let i = 1; i < points.length; i++) {
    distance += Math.hypot(
      points[i].x - points[i - 1].x,
      points[i].y - points[i - 1].y
    );
  }
  return distance;
}

/**
 * Smooths vertical gate-boulevard prefixes/suffixes onto the exact `x = gateX + 1.0` centerline
 * whenever both gate columns (`gateX` and `gateX + 1`) are open, eliminating the `0.5m` gate-mouth veer.
 */
function alignGateSeamCenterline(
  rawCells: GridPoint[],
  walkable: boolean[][],
  height: number,
  startX: number,
  goalX: number,
  applyNorthGate: boolean,
  applySouthGate: boolean
): void {
  const len = rawCells.length;
  if (len === 0) return;

  if (
    applyNorthGate &&
    applySouthGate &&
    startX === goalX &&
    len === height
  ) {
    let allStraightDualOpen = true;
    for (let k = 0; k < len; k++) {
      const cy = Math.floor(rawCells[k].y);
      const cx = Math.floor(rawCells[k].x);
      if (
        cy !== k ||
        (cx !== startX && cx !== startX + 1) ||
        !walkable[k][startX] ||
        !walkable[k][startX + 1]
      ) {
        allStraightDualOpen = false;
        break;
      }
    }
    if (allStraightDualOpen) {
      const seamX = startX + 1.0;
      for (let k = 0; k < len; k++) {
        rawCells[k].x = seamX;
      }
      return;
    }
  }

  let northRunEnd = -1;
  if (applyNorthGate) {
    for (let k = 0; k < len; k++) {
      const cy = Math.floor(rawCells[k].y);
      const cx = Math.floor(rawCells[k].x);
      if (
        cy === k &&
        (cx === startX || cx === startX + 1) &&
        walkable[k][startX] &&
        walkable[k][startX + 1]
      ) {
        northRunEnd = k;
      } else {
        break;
      }
    }
    // Keep `northRunEnd` at its inner cell center (`startX+0.5` or `startX+1.5`) to pivot cleanly into the turn
    const startSeamX = startX + 1.0;
    for (let k = 0; k < northRunEnd; k++) {
      rawCells[k].x = startSeamX;
    }
  }

  if (applySouthGate) {
    let southRunStart = len;
    for (let k = len - 1; k >= 0; k--) {
      const expectedY = height - 1 - (len - 1 - k);
      const cy = Math.floor(rawCells[k].y);
      const cx = Math.floor(rawCells[k].x);
      if (
        cy === expectedY &&
        (cx === goalX || cx === goalX + 1) &&
        walkable[cy][goalX] &&
        walkable[cy][goalX + 1]
      ) {
        southRunStart = k;
      } else {
        break;
      }
    }
    const minSouthIdx = Math.max(southRunStart + 1, northRunEnd + 1);
    const goalSeamX = goalX + 1.0;
    for (let k = minSouthIdx; k < len; k++) {
      rawCells[k].x = goalSeamX;
    }
  }
}

/**
 * A* pathfinding between pads on the walkable grid using an inline binary min-heap,
 * exact entry/exit terminal hop distances, explicit gate flags, and strict 8-dir no-corner-cutting.
 */
function findSegmentPath(
  walkable: boolean[][],
  width: number,
  height: number,
  startPad: GridPoint,
  goalPad: GridPoint,
  options?: SegmentQueryOptions
): SegmentPathInternal | null {
  if (width <= 0 || height <= 0) return null;

  const startX = startPad.x;
  const startY = startPad.y;
  const goalX = goalPad.x;
  const goalY = goalPad.y;

  const startIsTopGate = Boolean(options?.startIsTopGate);
  const goalIsBottomGate = Boolean(options?.goalIsBottomGate);
  const seedCells = options?.seedCells;
  const appendTerminalPoint = options?.appendTerminalPoint ?? true;
  const collectAllGoalCells = Boolean(
    options?.collectAllGoalCells && !appendTerminalPoint
  );
  const applyGatesInline = options?.applyGatesInline ?? true;
  const hintX = options?.nextWaypointHintX ?? goalX + 1.0;

  const gx0 = goalX;
  const gx1 = goalX + 1;
  const gy0 = goalIsBottomGate ? height - 1 : goalY;
  const gy1 = goalIsBottomGate ? height - 1 : goalY + 1;

  const startPoint: GridPoint = {
    x: startX + 1.0,
    y: startIsTopGate ? 0.0 : startY + 1.0,
  };

  const endPoint: GridPoint = {
    x: goalX + 1.0,
    y: goalIsBottomGate ? height : goalY + 1.0,
  };

  const totalCells = width * height;
  const goalSinkIdx = totalCells;
  const slotCount = totalCells + 1;
  ensureAStarScratch(slotCount);

  const gScore = scratchGScore;
  const fScore = scratchFScore;
  const cameFrom = scratchCameFrom;
  const originSeed = scratchOriginSeed;
  const closed = scratchClosed;
  const heapNodes = scratchHeapNodes;
  const heapPos = scratchHeapPos;

  gScore.fill(Infinity, 0, slotCount);
  fScore.fill(Infinity, 0, slotCount);
  cameFrom.fill(-1, 0, slotCount);
  originSeed.fill(0, 0, slotCount);
  closed.fill(0, 0, slotCount);
  heapPos.fill(-1, 0, slotCount);

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

  if (seedCells && seedCells.length > 0) {
    for (let s = 0; s < seedCells.length; s++) {
      const sc = seedCells[s];
      const sx = sc.x;
      const sy = sc.y;
      if (sx >= 0 && sx < width && sy >= 0 && sy < height && walkable[sy][sx]) {
        const idx = sy * width + sx;
        if (sc.initialCost < gScore[idx]) {
          gScore[idx] = sc.initialCost;
          originSeed[idx] = s;
          fScore[idx] =
            sc.initialCost +
            goalBoxHeuristic(sx, sy, gx0, gx1, gy0, gy1, hintX);
          heapPushOrUpdate(idx);
        }
      }
    }
  } else {
    const startDyMax = startIsTopGate ? 0 : 1;
    for (let dy = 0; dy <= startDyMax; dy++) {
      const sy = startY + dy;
      if (sy < 0 || sy >= height) continue;
      const row = walkable[sy];
      for (let dx = 0; dx <= 1; dx++) {
        const sx = startX + dx;
        if (sx >= 0 && sx < width && row[sx]) {
          const idx = sy * width + sx;
          const entryHop = Math.hypot(
            sx + 0.5 - startPoint.x,
            sy + 0.5 - startPoint.y
          );
          gScore[idx] = entryHop;
          originSeed[idx] = 0;
          fScore[idx] =
            entryHop + goalBoxHeuristic(sx, sy, gx0, gx1, gy0, gy1, hintX);
          heapPushOrUpdate(idx);
        }
      }
    }
  }

  let expectedGoalCells = 0;
  if (collectAllGoalCells) {
    for (let gy = gy0; gy <= gy1; gy++) {
      if (gy < 0 || gy >= height) continue;
      for (let gx = gx0; gx <= gx1; gx++) {
        if (gx >= 0 && gx < width && walkable[gy][gx]) {
          expectedGoalCells++;
        }
      }
    }
  }

  let reachedGoalIdx = -1;
  let firstGoalG = Infinity;
  const reachedGoalIndices: number[] = [];

  while (heapSize > 0) {
    const bestIdx = heapPop();
    if (closed[bestIdx]) continue;

    if (
      collectAllGoalCells &&
      reachedGoalIndices.length > 0 &&
      fScore[bestIdx] > firstGoalG + 2.01
    ) {
      break;
    }

    closed[bestIdx] = 1;

    if (bestIdx === goalSinkIdx) {
      reachedGoalIdx = cameFrom[goalSinkIdx];
      break;
    }

    const cx = bestIdx % width;
    const cy = (bestIdx - cx) / width;
    const currentG = gScore[bestIdx];

    if (cx >= gx0 && cx <= gx1 && cy >= gy0 && cy <= gy1) {
      if (!appendTerminalPoint) {
        if (reachedGoalIdx === -1) {
          reachedGoalIdx = bestIdx;
          firstGoalG = currentG;
        }
        if (!collectAllGoalCells) {
          break;
        }
        reachedGoalIndices.push(bestIdx);
        if (reachedGoalIndices.length >= expectedGoalCells) {
          break;
        }
      } else {
        const exitHop = Math.hypot(
          endPoint.x - (cx + 0.5),
          endPoint.y - (cy + 0.5)
        );
        const totalGoalCost = currentG + exitHop;
        if (totalGoalCost < gScore[goalSinkIdx]) {
          cameFrom[goalSinkIdx] = bestIdx;
          originSeed[goalSinkIdx] = originSeed[bestIdx];
          gScore[goalSinkIdx] = totalGoalCost;
          fScore[goalSinkIdx] = totalGoalCost;
          heapPushOrUpdate(goalSinkIdx);
        }
      }
    }

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
        originSeed[nIdx] = originSeed[bestIdx];
        gScore[nIdx] = tentativeG;
        fScore[nIdx] =
          tentativeG + goalBoxHeuristic(nx, ny, gx0, gx1, gy0, gy1, hintX);
        heapPushOrUpdate(nIdx);
      }
    }
  }

  if (reachedGoalIdx === -1) {
    return null;
  }

  const buildBranchForGoalIdx = (goalCellIdx: number): WaystoneArrivalBranch => {
    const gCx = goalCellIdx % width;
    const gCy = (goalCellIdx - gCx) / width;
    const cellChain: GridPoint[] = [];
    let walk = goalCellIdx;
    while (walk !== -1) {
      const wx = walk % width;
      const wy = (walk - wx) / width;
      cellChain.push({ x: wx + 0.5, y: wy + 0.5 });
      walk = cameFrom[walk];
    }
    cellChain.reverse();

    if (
      applyGatesInline &&
      ((startIsTopGate && !seedCells) ||
        (goalIsBottomGate && appendTerminalPoint))
    ) {
      alignGateSeamCenterline(
        cellChain,
        walkable,
        height,
        startX,
        goalX,
        startIsTopGate && !seedCells,
        goalIsBottomGate && appendTerminalPoint
      );
    }

    const branchPoints: GridPoint[] = seedCells
      ? cellChain
      : [startPoint, ...cellChain];
    if (appendTerminalPoint) {
      branchPoints.push(endPoint);
    }

    const segDist = computePolylineDistance(branchPoints);
    const seedIdx = originSeed[goalCellIdx];
    const baseCost =
      seedCells && seedCells[seedIdx] ? seedCells[seedIdx].initialCost : 0;

    return {
      cell: { x: gCx, y: gCy },
      points: branchPoints,
      distance: segDist,
      cumulativeCost: baseCost + segDist,
      originSeedIndex: seedIdx,
    };
  };

  const primaryBranch = buildBranchForGoalIdx(reachedGoalIdx);
  let goalBranches: WaystoneArrivalBranch[] | undefined;
  if (collectAllGoalCells) {
    goalBranches = reachedGoalIndices.map((gIdx) => buildBranchForGoalIdx(gIdx));
  }

  return {
    points: primaryBranch.points,
    distance: primaryBranch.distance,
    reachedCell: primaryBranch.cell,
    originSeedIndex: primaryBranch.originSeedIndex,
    goalBranches,
  };
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
  const lastSegIdx = waypoints.length - 2;
  const northGateActive = round.spawn.y === 0;
  const southGateActive = round.exit.y >= round.gridHeight - 2;

  const stageBranches: WaystoneArrivalBranch[][] = [];
  let finalSeg: SegmentPathInternal | null = null;

  for (let i = 0; i <= lastSegIdx; i++) {
    const isFirstSeg = i === 0;
    const isFinalSeg = i === lastSegIdx;
    const nextHintPad = !isFinalSeg ? waypoints[i + 2] : waypoints[i + 1];

    const prevBranches = isFirstSeg ? undefined : stageBranches[i - 1];
    const seedCells: SeedCellEntry[] | undefined = prevBranches
      ? prevBranches.map((b) => ({
          x: b.cell.x,
          y: b.cell.y,
          initialCost: b.cumulativeCost,
        }))
      : undefined;

    const seg = findSegmentPath(
      walkable,
      round.gridWidth,
      round.gridHeight,
      waypoints[i],
      waypoints[i + 1],
      {
        startIsTopGate: isFirstSeg && northGateActive,
        goalIsBottomGate: isFinalSeg && southGateActive,
        seedCells,
        appendTerminalPoint: isFinalSeg,
        collectAllGoalCells: !isFinalSeg,
        applyGatesInline: false,
        nextWaypointHintX: nextHintPad.x + 1.0,
      }
    );

    if (!seg) {
      return {
        valid: false,
        segments: [],
        allPoints: [],
        totalDistance: 0,
      };
    }

    if (isFinalSeg) {
      finalSeg = seg;
    } else {
      stageBranches.push(
        seg.goalBranches && seg.goalBranches.length > 0
          ? seg.goalBranches
          : [
              {
                cell: seg.reachedCell,
                points: seg.points,
                distance: seg.distance,
                cumulativeCost: seg.distance,
                originSeedIndex: seg.originSeedIndex,
              },
            ]
      );
    }
  }

  if (!finalSeg) {
    return {
      valid: false,
      segments: [],
      allPoints: [],
      totalDistance: 0,
    };
  }

  // Backtrack optimal DP Waystone transitions from final exit segment back to spawn
  const chosenSegmentPoints: GridPoint[][] = new Array(lastSegIdx + 1);
  chosenSegmentPoints[lastSegIdx] = finalSeg.points;
  let activeSeedIdx = finalSeg.originSeedIndex;

  for (let i = lastSegIdx - 1; i >= 0; i--) {
    const chosenBranch =
      stageBranches[i][activeSeedIdx] || stageBranches[i][0];
    chosenSegmentPoints[i] = chosenBranch.points;
    activeSeedIdx = chosenBranch.originSeedIndex;
  }

  // Share stitch-point object references across Waystone boundaries so full-path seam alignment
  // updates both segments[i] and allPoints atomically without `10.0 -> 9.5 -> 10.0` Waystone swerves
  const allPoints: GridPoint[] = [];
  for (let i = 0; i <= lastSegIdx; i++) {
    const pts = chosenSegmentPoints[i];
    if (i === 0) {
      allPoints.push(...pts);
    } else {
      const prevPts = chosenSegmentPoints[i - 1];
      pts[0] = prevPts[prevPts.length - 1];
      allPoints.push(...pts.slice(1));
    }
  }

  if (northGateActive || southGateActive) {
    const interiorStart = northGateActive ? 1 : 0;
    const interiorEnd = southGateActive
      ? allPoints.length - 1
      : allPoints.length;
    if (interiorEnd > interiorStart) {
      const interiorCells = allPoints.slice(interiorStart, interiorEnd);
      alignGateSeamCenterline(
        interiorCells,
        walkable,
        round.gridHeight,
        round.spawn.x,
        round.exit.x,
        northGateActive,
        southGateActive
      );
    }
  }

  const segments: PathSegment[] = [];
  let totalDistance = 0;
  for (let i = 0; i <= lastSegIdx; i++) {
    const pts = chosenSegmentPoints[i];
    const dist = computePolylineDistance(pts);
    segments.push({
      fromIndex: i,
      toIndex: i + 1,
      points: pts,
      distance: dist,
    });
    totalDistance += dist;
  }

  return {
    valid: true,
    segments,
    allPoints,
    totalDistance,
  };
}

/**
 * Computes the complete path from the North Gate entrance (through any Checkpoint Waystones)
 * to the South Shrine exit.
 */
export function computeFullMazePath(
  round: RoundConfig,
  towers: PlacedTower[]
): PathResult {
  const walkable = buildWalkableGrid(round, towers);
  return computeMazePathOnWalkable(round, walkable);
}

/**
 * Helper to find a dynamic path from any 2x2 pad to a target pad (e.g. Waygate exit rerouting).
 * Uses explicit gate identity checks so interior/border non-gate pads never project off-cliff.
 */
export function computeSingleSegmentPath(
  round: RoundConfig,
  towers: PlacedTower[],
  fromPad: GridPoint,
  toPad: GridPoint
): { points: GridPoint[]; distance: number } | null {
  const walkable = buildWalkableGrid(round, towers);
  const startIsSpawnGate =
    fromPad.x === round.spawn.x &&
    fromPad.y === round.spawn.y &&
    round.spawn.y === 0;
  const goalIsExitGate =
    toPad.x === round.exit.x &&
    toPad.y === round.exit.y &&
    round.exit.y >= round.gridHeight - 2;
  const isCheckpointGoal =
    !goalIsExitGate &&
    round.checkpoints.some((cp) => cp.x === toPad.x && cp.y === toPad.y);

  const seg = findSegmentPath(
    walkable,
    round.gridWidth,
    round.gridHeight,
    fromPad,
    toPad,
    {
      startIsTopGate: startIsSpawnGate,
      goalIsBottomGate: goalIsExitGate,
      appendTerminalPoint: !isCheckpointGoal,
      nextWaypointHintX: round.exit.x + 1.0,
    }
  );
  if (!seg) return null;
  return { points: seg.points, distance: seg.distance };
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

  // Snapshot exact prior 2x2 walkability state before temporary block
  const prev00 = walkable[y][x];
  const prev10 = walkable[y][x + 1];
  const prev01 = walkable[y + 1][x];
  const prev11 = walkable[y + 1][x + 1];

  walkable[y][x] = false;
  walkable[y][x + 1] = false;
  walkable[y + 1][x] = false;
  walkable[y + 1][x + 1] = false;

  let pathResult: PathResult;
  let waygateReachable = true;

  try {
    pathResult = computeMazePathOnWalkable(round, walkable);
    if (pathResult.valid && round.waygate) {
      const wgToExit = findSegmentPath(
        walkable,
        gridWidth,
        gridHeight,
        round.waygate.exit,
        round.exit,
        {
          startIsTopGate: false,
          goalIsBottomGate: round.exit.y >= gridHeight - 2,
          appendTerminalPoint: true,
        }
      );
      if (!wgToExit) {
        waygateReachable = false;
      }
    }
  } finally {
    walkable[y][x] = prev00;
    walkable[y][x + 1] = prev10;
    walkable[y + 1][x] = prev01;
    walkable[y + 1][x + 1] = prev11;
  }

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

function isFlushAlignedWithMasonry(
  round: RoundConfig,
  existingTowers: PlacedTower[],
  nx: number,
  ny: number
): boolean {
  for (let i = 0; i < existingTowers.length; i++) {
    const t = existingTowers[i];
    const dx = Math.abs(nx - t.x);
    const dy = Math.abs(ny - t.y);
    if ((dx === 2 && dy === 0) || (dx === 0 && dy === 2)) return true;
  }
  for (let i = 0; i < round.obstacles.length; i++) {
    const o = round.obstacles[i];
    const dx = Math.abs(nx - o.x);
    const dy = Math.abs(ny - o.y);
    if ((dx === 2 && dy === 0) || (dx === 0 && dy === 2)) return true;
  }
  return false;
}

/**
 * Resolves continuous island-space coordinates `(wx, wy)` to an accurate `2x2` top-left cell `(x, y)`
 * with flush-snap assist around Keeps, Spires, Walls, Pads, and Gates:
 * - Respects `options.searchSpanOverride` (`0` disables snap during continuous Loupe drag & Shift+Drag).
 * - Eliminates both the `0.5m` open-grass moat (`r <= 1.42m` mouse / `1.75m` touch) and the `2x2` Keep/Spire
 *   interior bullseye dead-zone on touch (`r <= 2.15m` when tapping inside an obstacle/pad).
 * - Prefers orthogonal flush masonry alignment (`-0.06` `distSq` tie-break) and never vaults across `'BLOCKS_PATH'` chokes.
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

  // 1. Exact raw 2x2 slot is valid, blocks an open corridor, or snap is explicitly disabled (Loupe / Shift+Drag)
  if (
    rawValidation.valid ||
    rawValidation.reasonCode === 'BLOCKS_PATH' ||
    options?.searchSpanOverride === 0
  ) {
    return finalizeResult(rawX, rawY, false, rawValidation);
  }

  // 2. Raw 2x2 slot overlapped a Keep, Spire, Wall, Gate, or Pad -> determine snap eligibility & span
  const clampedCellX = Math.max(
    0,
    Math.min(round.gridWidth - 1, Math.floor(wx))
  );
  const clampedCellY = Math.max(
    0,
    Math.min(round.gridHeight - 1, Math.floor(wy))
  );

  const cursorCellOpenGrass = !isCellPlacementBlocked(
    round,
    existingTowers,
    clampedCellX,
    clampedCellY
  );

  if (mode === 'mouse' && !cursorCellOpenGrass) {
    return finalizeResult(rawX, rawY, false, rawValidation);
  }

  const defaultSpan: 1 | 2 =
    mode === 'touch' && !cursorCellOpenGrass ? 2 : 1;
  const searchSpan = options?.searchSpanOverride ?? defaultSpan;

  const maxDist =
    mode === 'mouse'
      ? MOUSE_SNAP_MAX_DIST
      : cursorCellOpenGrass
      ? TOUCH_MOAT_SNAP_MAX_DIST
      : TOUCH_OBSTACLE_CORE_SNAP_MAX_DIST;
  const maxDistSq = maxDist * maxDist;

  interface SnapCandidate {
    x: number;
    y: number;
    dx: number;
    dy: number;
    distSq: number;
    sortScore: number;
    coversCursorCell: boolean;
  }

  const candidates: SnapCandidate[] = [];
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

      const aligned = isFlushAlignedWithMasonry(round, existingTowers, nx, ny);
      const sortScore =
        distSq - (aligned ? FLUSH_ALIGNMENT_DIST_SQ_BIAS : 0);
      const coversCursorCell =
        cursorCellOpenGrass &&
        clampedCellX >= nx &&
        clampedCellX <= nx + 1 &&
        clampedCellY >= ny &&
        clampedCellY <= ny + 1;

      candidates.push({
        x: nx,
        y: ny,
        dx,
        dy,
        distSq,
        sortScore,
        coversCursorCell,
      });
    }
  }

  candidates.sort(
    (a, b) => a.sortScore - b.sortScore || a.y - b.y || a.x - b.x
  );

  // Track 1-step directions that are static-free but fail BLOCKS_PATH so 2-step search never vaults over a choke
  const sealedStep1Dirs = new Set<string>();

  for (let i = 0; i < candidates.length; i++) {
    const cand = candidates[i];

    if (Math.abs(cand.dx) === 2 || Math.abs(cand.dy) === 2) {
      const sx = Math.sign(cand.dx);
      const sy = Math.sign(cand.dy);
      if (
        sealedStep1Dirs.has(`${sx},${sy}`) ||
        (sx !== 0 && sealedStep1Dirs.has(`${sx},0`)) ||
        (sy !== 0 && sealedStep1Dirs.has(`0,${sy}`))
      ) {
        continue;
      }
    }

    const candVal = validatePathWithCandidateOnWalkable(
      round,
      walkable,
      cand.x,
      cand.y
    );

    if (candVal.valid) {
      return finalizeResult(cand.x, cand.y, true, candVal);
    }

    if (candVal.reasonCode === 'BLOCKS_PATH') {
      // When cursor is on open grass inside a 1-tile choke corridor next to an obstacle,
      // stop monotonically on the closest covering choke cell instead of jumping sideways!
      if (cand.coversCursorCell && i === 0) {
        return finalizeResult(cand.x, cand.y, true, candVal);
      }
      if (Math.abs(cand.dx) <= 1 && Math.abs(cand.dy) <= 1) {
        sealedStep1Dirs.add(`${cand.dx},${cand.dy}`);
      }
    }
  }

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
 * Computes the Citadel Circuitry network with strict masonry-only (`PLAYER + KEEP`) `<= 2` conductivity:
 * - Only Player Stone Walls and Crimson Keeps (`obstacles`) connect via `|dx|<=2 && |dy|<=2` masonry chains
 *   (Spires never short-circuit Keep-less walls across their plinths, and dual-Keep chains on opposite Spire faces
 *   each emit their own inlaid gold ley-line conduit).
 * - Any Elemental Spire within `|dx|<=3 && |dy|<=3 && dx^2 + dy^2 <= 13` of a powered `PLAYER + KEEP` component
 *   gains +1 Overcharge Tier per distinct Crimson Keep in that component (capped at Tier 3 ◆◆◆).
 * - Populates `keepPoweredSpireCounts` (`0` = Wall-linked only, `>= 1` = ◆ Powering Spire(s)), `poweredNodeKeys`,
 *   and deduplicated `spireConduitLinks`.
 */
export function computeCitadelCircuitry(
  round: RoundConfig,
  towers: PlacedTower[]
): CitadelCircuitryResult {
  interface MasonryNode {
    x: number;
    y: number;
    isPlayer: boolean;
    keepIdx: number;
  }

  const nodes: MasonryNode[] = [];
  for (let i = 0; i < towers.length; i++) {
    const t = towers[i];
    nodes.push({ x: t.x, y: t.y, isPlayer: true, keepIdx: -1 });
  }
  for (let i = 0; i < round.obstacles.length; i++) {
    const o = round.obstacles[i];
    nodes.push({ x: o.x, y: o.y, isPlayer: false, keepIdx: i });
  }

  const nodeCount = nodes.length;
  const visited = new Uint8Array(nodeCount);
  const linkedKeepIndices = new Set<number>();
  const poweredNodeKeys = new Set<string>();
  const overchargedNodeKeys = new Set<string>();
  const keepCount = round.obstacles.length;
  const spireCount = round.preplacedSpires.length;

  const keepSpireSets: Array<Set<number>> = Array.from(
    { length: keepCount },
    () => new Set<number>()
  );
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
      if (n.isPlayer) {
        hasPlayerWall = true;
      } else if (n.keepIdx >= 0) {
        compKeeps.push(n.keepIdx);
      }
    }

    if (!hasPlayerWall || compKeeps.length === 0) continue;

    for (let k = 0; k < compKeeps.length; k++) {
      linkedKeepIndices.add(compKeeps[k]);
    }

    for (let c = 0; c < comp.length; c++) {
      const n = nodes[comp[c]];
      poweredNodeKeys.add(`${n.x},${n.y}`);
    }

    let compPowersAnySpire = false;
    for (let sIdx = 0; sIdx < spireCount; sIdx++) {
      const spire = round.preplacedSpires[sIdx];
      let bestSourceIdx = -1;
      let bestDistSq = Infinity;
      let bestIsPlayer = false;

      for (let c = 0; c < comp.length; c++) {
        const candIdx = comp[c];
        const wn = nodes[candIdx];
        const dx = wn.x - spire.x;
        const dy = wn.y - spire.y;
        if (Math.abs(dx) > 3 || Math.abs(dy) > 3) continue;
        const distSq = dx * dx + dy * dy;
        if (distSq > 13) continue;

        if (
          distSq < bestDistSq ||
          (distSq === bestDistSq && wn.isPlayer && !bestIsPlayer)
        ) {
          bestDistSq = distSq;
          bestSourceIdx = candIdx;
          bestIsPlayer = wn.isPlayer;
        }
      }

      if (bestSourceIdx !== -1) {
        compPowersAnySpire = true;
        for (let k = 0; k < compKeeps.length; k++) {
          const keepIdx = compKeeps[k];
          spireKeepSets[sIdx].add(keepIdx);
          keepSpireSets[keepIdx].add(sIdx);
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

    if (compPowersAnySpire) {
      for (let c = 0; c < comp.length; c++) {
        const n = nodes[comp[c]];
        overchargedNodeKeys.add(`${n.x},${n.y}`);
      }
    }
  }

  const keepPoweredSpireCounts = keepSpireSets.map((set) => set.size);
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
    keepPoweredSpireCounts,
    poweredNodeKeys,
    overchargedNodeKeys,
    spireConduitLinks,
  };
}
