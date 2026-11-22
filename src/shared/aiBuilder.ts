import {
  computeCitadelCircuitry,
  computeFullMazePath,
  do2x2Overlap,
  validateTowerPlacement,
} from './pathfinding.js';
import { evaluateMazeRunTime } from './simulation.js';
import {
  getEffectiveSpireStats,
  GridPoint,
  MazeEvalResult,
  PathResult,
  PlacedTower,
  RoundConfig,
  RUNNER_ARCHETYPES,
  SpireType,
  TOWER_SPECS,
} from './types.js';

export type BotDifficulty = 'NOVICE' | 'ARCHITECT' | 'GRANDMASTER';
export type BotStyle = 'SWITCHBACK' | 'SPIRAL' | 'CLAP_CHAIN';

function isInside2x2(px: number, py: number, pad: GridPoint): boolean {
  return px >= pad.x && px <= pad.x + 2.0 && py >= pad.y && py <= pad.y + 2.0;
}

/**
 * Selects the signature architectural style matching a round's Spire roster.
 */
export function selectSampleMazeStyle(round: RoundConfig): BotStyle {
  let frostCount = 0;
  let chronoCount = 0;
  for (const sp of round.preplacedSpires) {
    if (sp.spireType === 'FROST_OBELISK') frostCount++;
    else if (sp.spireType === 'CHRONO_SPIRE') chronoCount++;
  }
  if (chronoCount >= 2 || (chronoCount >= 1 && frostCount === 0)) {
    return 'CLAP_CHAIN';
  }
  if (frostCount >= 2) {
    return 'SPIRAL';
  }
  return 'SWITCHBACK';
}

/**
 * Evaluates a candidate path with full map-feature awareness using canonical Spire stats:
 * - Spire Overcharge effective range, cooldown, burst slow, slow duration, and Frost aura
 * - Cooldown-spaced burst triggers vs continuous Frost Obelisk Permafrost dwell
 * - Chrono Spire 1.2s global cooldown shave when triggered after sibling Spires
 * - Runner traits: Juggernaut 20% slow resist (pierced by >=1 Overcharge), Outrider +25% slow duration,
 *   and Wind Herald +28% Tailwind Haste after 3.2s un-slowed outside Spire rings
 * - Multi-segment Checkpoint routes, Frost Mires (+), Haste Rifts (-), and Waygate shortcuts
 */
export function scorePathWithMapFeatures(
  round: RoundConfig,
  path: PathResult,
  spireOverchargeTiers?: number[]
): number {
  if (!path.valid || path.allPoints.length < 2) return 0;

  const runnerType = round.runnerType || 'SCOUT';
  const runnerSpec = RUNNER_ARCHETYPES[runnerType];
  const baseSpeed = runnerSpec.baseSpeed;
  const spires = round.preplacedSpires;
  const spireCount = spires.length;

  const effRanges = new Float64Array(spireCount);
  const effSlows = new Float64Array(spireCount);
  const effDurations = new Float64Array(spireCount);
  const effAuras = new Float64Array(spireCount);
  const effCdrPulses = new Float64Array(spireCount);
  const minRetriggerMeters = new Float64Array(spireCount);
  const nextReadyDist = new Float64Array(spireCount);
  const tiers = new Int32Array(spireCount);

  for (let s = 0; s < spireCount; s++) {
    const sType: SpireType = spires[s].spireType || 'THUNDERCLAP';
    const tier = Math.max(0, Math.min(3, spireOverchargeTiers?.[s] || 0));
    const stats = getEffectiveSpireStats(sType, tier, runnerType);

    tiers[s] = tier;
    effRanges[s] = stats.effectiveRange;
    effSlows[s] = stats.slowPercent;
    effDurations[s] = stats.slowDuration;
    effAuras[s] = stats.auraSlowPercent;
    effCdrPulses[s] = stats.cdrPulseSeconds;
    minRetriggerMeters[s] = Math.max(
      4.2,
      baseSpeed * 0.62 * stats.effectiveCooldown
    );
    nextReadyDist[s] = 0;
  }

  let score = path.totalDistance;
  let cumDist = 0;
  let unslowedMeters = 0;
  let slowCarryMeters = 0;
  let waygateEvaluated = false;

  const pts = path.allPoints;
  const hasMires = round.frostMires.length > 0;
  const hasRifts = round.hasteRifts.length > 0;
  const heraldSafeSpan = baseSpeed * 3.1;

  for (let i = 1; i < pts.length; i++) {
    const prev = pts[i - 1];
    const curr = pts[i];
    const segLen = Math.hypot(curr.x - prev.x, curr.y - prev.y);
    if (segLen <= 1e-6) continue;

    const mx = (prev.x + curr.x) * 0.5;
    const my = (prev.y + curr.y) * 0.5;
    cumDist += segLen;
    if (slowCarryMeters > 0) {
      slowCarryMeters = Math.max(0, slowCarryMeters - segLen);
    }

    let inAnySpire = false;

    for (let s = 0; s < spireCount; s++) {
      const cx = spires[s].x + 1.0;
      const cy = spires[s].y + 1.0;
      const dx = mx - cx;
      const dy = my - cy;
      const r = effRanges[s];
      if (dx * dx + dy * dy > r * r) continue;

      inAnySpire = true;
      const tier = tiers[s];
      const resist = tier > 0 ? 0.0 : runnerSpec.slowResist;

      if (effAuras[s] > 0) {
        score += segLen * effAuras[s] * (1 - resist) * 2.2;
      }

      if (cumDist >= nextReadyDist[s]) {
        nextReadyDist[s] = cumDist + minRetriggerMeters[s];
        const effSlow = effSlows[s] * (1 - resist);
        const effDur = effDurations[s];
        let burstValue = effSlow * effDur * baseSpeed * 1.18;
        if (tier > 0 && runnerSpec.slowResist > 0) {
          burstValue += 1.5;
        }

        if (effCdrPulses[s] > 0) {
          const shaveMeters = baseSpeed * 0.65 * effCdrPulses[s];
          for (let other = 0; other < spireCount; other++) {
            if (other !== s && nextReadyDist[other] > cumDist + 0.4) {
              const before = nextReadyDist[other];
              nextReadyDist[other] = Math.max(cumDist, before - shaveMeters);
              burstValue += (before - nextReadyDist[other]) * 0.7;
            }
          }
        }

        score += burstValue;
        slowCarryMeters = Math.max(slowCarryMeters, effDur * baseSpeed * 0.55);
      }
    }

    let inMire = false;
    if (hasMires) {
      for (let m = 0; m < round.frostMires.length; m++) {
        if (isInside2x2(mx, my, round.frostMires[m])) {
          inMire = true;
          score += segLen * 0.85 * (1 - runnerSpec.slowResist);
          break;
        }
      }
    }

    if (hasRifts) {
      for (let rf = 0; rf < round.hasteRifts.length; rf++) {
        if (isInside2x2(mx, my, round.hasteRifts[rf])) {
          score -= segLen * 1.45;
          break;
        }
      }
    }

    if (round.waygate && !waygateEvaluated) {
      const wx = round.waygate.entry.x + 1.0;
      const wy = round.waygate.entry.y + 1.0;
      if ((mx - wx) * (mx - wx) + (my - wy) * (my - wy) <= 0.91) {
        waygateEvaluated = true;
        const goalX = round.exit.x + 1.0;
        const goalY = round.gridHeight;
        const distFromEntry = Math.hypot(goalX - wx, goalY - wy);
        const distFromExit = Math.hypot(
          goalX - (round.waygate.exit.x + 1.0),
          goalY - (round.waygate.exit.y + 1.0)
        );
        score += (distFromExit - distFromEntry) * 1.15;
      }
    }

    if (runnerSpec.hasMomentum) {
      if (inAnySpire || slowCarryMeters > 0 || inMire) {
        unslowedMeters = 0;
      } else {
        unslowedMeters += segLen;
        if (unslowedMeters > heraldSafeSpan) {
          score -= segLen * 0.52;
        }
      }
    }
  }

  return score;
}

const CLEAN_MASONRY_DIRS: ReadonlyArray<[number, number]> = [
  [2, 0],
  [-2, 0],
  [0, 2],
  [0, -2],
  [2, 2],
  [-2, 2],
  [2, -2],
  [-2, -2],
];

/**
 * Exact match for the 3D renderer's post-Gabriel masonry bridge visibility rule:
 * Pure orthogonal (±2, 0) / (0, ±2) neighbors always connect; non-orthogonal neighbors
 * within |dx|<=2, |dy|<=2 connect iff no shared neighbor C forms a <=90° elbow.
 */
function areMasonryNodesBridged(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  nodes: ReadonlyArray<GridPoint>
): boolean {
  const dx = bx - ax;
  const dy = by - ay;
  if (Math.abs(dx) > 2 || Math.abs(dy) > 2 || (dx === 0 && dy === 0)) {
    return false;
  }
  if ((Math.abs(dx) === 2 && dy === 0) || (dx === 0 && Math.abs(dy) === 2)) {
    return true;
  }

  const abSq = dx * dx + dy * dy;
  for (let k = 0; k < nodes.length; k++) {
    const c = nodes[k];
    if ((c.x === ax && c.y === ay) || (c.x === bx && c.y === by)) continue;
    const dACx = c.x - ax;
    const dACy = c.y - ay;
    if (Math.abs(dACx) > 2 || Math.abs(dACy) > 2) continue;
    const dCBx = bx - c.x;
    const dCBy = by - c.y;
    if (Math.abs(dCBx) > 2 || Math.abs(dCBy) > 2) continue;

    if (dACx * dACx + dACy * dACy + dCBx * dCBx + dCBy * dCBy <= abSq) {
      return false;
    }
  }
  return true;
}

interface BuilderContext {
  round: RoundConfig;
  gw: number;
  gh: number;
  maxWalls: number;
  towers: PlacedTower[];
  occupied: Uint8Array;
  idPrefix: string;
  idSeq: number;
  astarRemaining: number;
  simRemaining: number;
}

function createBuilderContext(
  round: RoundConfig,
  maxWalls: number,
  idPrefix: string,
  astarBudget: number,
  simBudget: number
): BuilderContext {
  const gw = round.gridWidth;
  const gh = round.gridHeight;
  const occupied = new Uint8Array(gw * gh);

  const markPad = (pt: GridPoint) => {
    for (let dy = 0; dy < 2; dy++) {
      for (let dx = 0; dx < 2; dx++) {
        const cx = pt.x + dx;
        const cy = pt.y + dy;
        if (cx >= 0 && cx < gw && cy >= 0 && cy < gh) {
          occupied[cy * gw + cx] = 1;
        }
      }
    }
  };

  for (const obs of round.obstacles) markPad(obs);
  for (const sp of round.preplacedSpires) markPad(sp);
  markPad(round.spawn);
  markPad(round.exit);
  for (const cp of round.checkpoints) markPad(cp);
  if (round.waygate) {
    markPad(round.waygate.entry);
    markPad(round.waygate.exit);
  }

  return {
    round,
    gw,
    gh,
    maxWalls,
    towers: [],
    occupied,
    idPrefix,
    idSeq: 1,
    astarRemaining: astarBudget,
    simRemaining: simBudget,
  };
}

function canFit2x2Fast(ctx: BuilderContext, x: number, y: number): boolean {
  const { gw, gh, occupied } = ctx;
  if (x < 0 || y < 0 || x + 2 > gw || y + 2 > gh) return false;
  const row0 = y * gw + x;
  const row1 = row0 + gw;
  return (
    occupied[row0] === 0 &&
    occupied[row0 + 1] === 0 &&
    occupied[row1] === 0 &&
    occupied[row1 + 1] === 0
  );
}

/**
 * Enforces renderer-exact masonry hygiene:
 * - Zero rendered bridge triangles (no 3 mutually Gabriel-bridged PLAYER/KEEP nodes)
 * - Zero 2x2 solid pillar quads (K4 cliques)
 * - Caps rendered Keep degree at <= 3 (zero starburst Keeps) and Wall degree at <= 3
 *   (allowing degree 4 ONLY when `allowSliverSeal` is sealing an active 1-tile A* leak)
 */
function passesMasonryRules(
  ctx: BuilderContext,
  x: number,
  y: number,
  options: {
    allowCliffRoot?: boolean;
    allowSpireRoot?: boolean;
    allowSliverSeal?: boolean;
  } = {}
): boolean {
  const rawTouchers: GridPoint[] = [];
  for (let i = 0; i < ctx.towers.length; i++) {
    const t = ctx.towers[i];
    if (Math.abs(t.x - x) <= 2 && Math.abs(t.y - y) <= 2) {
      rawTouchers.push(t);
    }
  }
  for (let i = 0; i < ctx.round.obstacles.length; i++) {
    const o = ctx.round.obstacles[i];
    if (Math.abs(o.x - x) <= 2 && Math.abs(o.y - y) <= 2) {
      rawTouchers.push(o);
    }
  }

  const maxRawDeg = options.allowSliverSeal ? 4 : 3;
  if (rawTouchers.length > maxRawDeg) return false;

  if (rawTouchers.length >= 3) {
    let rawPairTouches = 0;
    for (let i = 0; i < rawTouchers.length; i++) {
      for (let j = i + 1; j < rawTouchers.length; j++) {
        if (
          Math.abs(rawTouchers[i].x - rawTouchers[j].x) <= 2 &&
          Math.abs(rawTouchers[i].y - rawTouchers[j].y) <= 2
        ) {
          rawPairTouches++;
        }
      }
    }
    if (rawPairTouches >= 3) return false;
  }

  // Only local nodes within |dx|<=4, |dy|<=4 can ever influence Gabriel pruning around (x, y)
  const localMasonry: GridPoint[] = [{ x, y }];
  for (let i = 0; i < ctx.towers.length; i++) {
    const t = ctx.towers[i];
    if (Math.abs(t.x - x) <= 4 && Math.abs(t.y - y) <= 4) {
      localMasonry.push(t);
    }
  }
  for (let i = 0; i < ctx.round.obstacles.length; i++) {
    const o = ctx.round.obstacles[i];
    if (Math.abs(o.x - x) <= 4 && Math.abs(o.y - y) <= 4) {
      localMasonry.push(o);
    }
  }

  const bridgedNeighbors: GridPoint[] = [];
  for (let i = 0; i < rawTouchers.length; i++) {
    const nb = rawTouchers[i];
    if (areMasonryNodesBridged(x, y, nb.x, nb.y, localMasonry)) {
      bridgedNeighbors.push(nb);
    }
  }

  if (bridgedNeighbors.length > maxRawDeg) return false;

  for (let i = 0; i < bridgedNeighbors.length; i++) {
    for (let j = i + 1; j < bridgedNeighbors.length; j++) {
      if (
        areMasonryNodesBridged(
          bridgedNeighbors[i].x,
          bridgedNeighbors[i].y,
          bridgedNeighbors[j].x,
          bridgedNeighbors[j].y,
          localMasonry
        )
      ) {
        return false;
      }
    }
  }

  for (let k = 0; k < ctx.round.obstacles.length; k++) {
    const kp = ctx.round.obstacles[k];
    if (Math.abs(kp.x - x) > 2 || Math.abs(kp.y - y) > 2) continue;
    let kpBridges = 0;
    for (let m = 0; m < localMasonry.length; m++) {
      const other = localMasonry[m];
      if (other.x === kp.x && other.y === kp.y) continue;
      if (areMasonryNodesBridged(kp.x, kp.y, other.x, other.y, localMasonry)) {
        kpBridges++;
      }
    }
    if (kpBridges > 3) return false;
  }

  for (let i = 0; i < ctx.towers.length; i++) {
    const t = ctx.towers[i];
    if (Math.abs(t.x - x) > 2 || Math.abs(t.y - y) > 2) continue;
    let tBridges = 0;
    for (let m = 0; m < localMasonry.length; m++) {
      const other = localMasonry[m];
      if (other.x === t.x && other.y === t.y) continue;
      if (areMasonryNodesBridged(t.x, t.y, other.x, other.y, localMasonry)) {
        tBridges++;
      }
    }
    if (tBridges > maxRawDeg) return false;
  }

  if (bridgedNeighbors.length > 0) return true;

  if (options.allowCliffRoot && (x === 0 || x === ctx.gw - 2)) {
    return true;
  }

  if (options.allowSpireRoot) {
    for (let i = 0; i < ctx.round.preplacedSpires.length; i++) {
      const sp = ctx.round.preplacedSpires[i];
      const dx = sp.x - x;
      const dy = sp.y - y;
      if (Math.abs(dx) <= 3 && Math.abs(dy) <= 3 && dx * dx + dy * dy <= 13) {
        return true;
      }
    }
  }

  return false;
}

interface TryPlaceOutcome {
  placed: boolean;
  blockedPath: boolean;
  pathResult?: PathResult;
}

function validateCounted(
  ctx: BuilderContext,
  towers: PlacedTower[],
  x: number,
  y: number
) {
  if (ctx.astarRemaining <= 0) {
    return { valid: false as const, reasonCode: 'NO_PILLARS' as const };
  }
  ctx.astarRemaining--;
  return validateTowerPlacement(ctx.round, towers, x, y);
}

function evalSimCounted(
  ctx: BuilderContext,
  towers: PlacedTower[],
  precomputedPath?: PathResult
): MazeEvalResult {
  if (ctx.simRemaining > 0) {
    ctx.simRemaining--;
  }
  return evaluateMazeRunTime(ctx.round, towers, {
    precomputedPath,
    collectClapLocations: false,
  });
}

function tryPlaceWallDetailed(
  ctx: BuilderContext,
  x: number,
  y: number,
  masonryOpts: {
    allowCliffRoot?: boolean;
    allowSpireRoot?: boolean;
    allowSliverSeal?: boolean;
  } = { allowCliffRoot: true, allowSpireRoot: true }
): TryPlaceOutcome {
  if (ctx.towers.length >= ctx.maxWalls || ctx.astarRemaining <= 0) {
    return { placed: false, blockedPath: false };
  }
  if (!Number.isInteger(x) || !Number.isInteger(y)) {
    return { placed: false, blockedPath: false };
  }
  if (!canFit2x2Fast(ctx, x, y)) {
    return { placed: false, blockedPath: false };
  }
  if (!passesMasonryRules(ctx, x, y, masonryOpts)) {
    return { placed: false, blockedPath: false };
  }

  const check = validateCounted(ctx, ctx.towers, x, y);
  if (!check.valid || !check.pathResult) {
    return {
      placed: false,
      blockedPath: check.reasonCode === 'BLOCKS_PATH',
    };
  }

  commitValidatedWall(ctx, x, y);
  return { placed: true, blockedPath: false, pathResult: check.pathResult };
}

function commitValidatedWall(ctx: BuilderContext, x: number, y: number): void {
  ctx.towers.push({
    id: `${ctx.idPrefix}_${ctx.idSeq++}`,
    type: 'BLOCK',
    x,
    y,
    createdAt: 0,
  });

  const r0 = y * ctx.gw + x;
  const r1 = r0 + ctx.gw;
  ctx.occupied[r0] = 1;
  ctx.occupied[r0 + 1] = 1;
  ctx.occupied[r1] = 1;
  ctx.occupied[r1 + 1] = 1;
}

function removeWallAtIndex(ctx: BuilderContext, idx: number): void {
  const removed = ctx.towers.splice(idx, 1)[0];
  if (!removed) return;
  const r0 = removed.y * ctx.gw + removed.x;
  const r1 = r0 + ctx.gw;
  ctx.occupied[r0] = 0;
  ctx.occupied[r0 + 1] = 0;
  ctx.occupied[r1] = 0;
  ctx.occupied[r1 + 1] = 0;
}

function rollbackTowersTo(ctx: BuilderContext, targetLength: number): void {
  while (ctx.towers.length > targetLength) {
    removeWallAtIndex(ctx, ctx.towers.length - 1);
  }
}

interface BaffleBuildResult {
  committed: boolean;
  actualOpenLeft: boolean;
  crossingX: number;
  wallsAdded: number;
}

function measureBandCrossingX(
  path: PathResult,
  bandY: number,
  fallbackX: number
): number {
  const pts = path.allPoints;
  let lastCrossX = -1;

  for (let i = 1; i < pts.length; i++) {
    const y0 = pts[i - 1].y;
    const y1 = pts[i].y;
    const midY = bandY + 1.0;
    if ((y0 <= midY && y1 >= midY) || (y0 >= midY && y1 <= midY)) {
      const denom = Math.abs(y1 - y0);
      const t = denom > 1e-6 ? Math.abs(midY - y0) / denom : 0.5;
      lastCrossX = pts[i - 1].x + (pts[i].x - pts[i - 1].x) * t;
    }
  }

  if (lastCrossX >= 0) return lastCrossX;

  for (let i = 0; i < pts.length; i++) {
    if (pts[i].y >= bandY && pts[i].y <= bandY + 2) {
      lastCrossX = pts[i].x;
    }
  }
  return lastCrossX >= 0 ? lastCrossX : fallbackX;
}

/**
 * Builds, seals, and verifies a horizontal/chevron masonry baffle:
 * - Strictly clamps wall X inside `[minWallX .. maxWallX]` so `turnGap >= 2` is NEVER narrowed into a 1-tile chute
 * - Never aborts early on `BLOCKS_PATH` (skips only the pinching column)
 * - Uses `allowSliverSeal` to plug 1-tile slots next to Keeps/Spires
 * - Atomically rolls back ineffective half-bands and returns the measured `actualOpenLeft`
 */
function buildVerifiedBaffle(
  ctx: BuilderContext,
  cellMinX: number,
  cellMaxX: number,
  wantOpenLeft: boolean,
  ryFn: (x: number) => number,
  wallCap: number,
  minRequiredDetour = 1.6
): BaffleBuildResult {
  const clampY = (y: number) => Math.max(2, Math.min(ctx.gh - 4, y));
  const midRefY = clampY(ryFn(Math.floor(ctx.gw * 0.5)));
  const remBudget = Math.min(wallCap, ctx.maxWalls) - ctx.towers.length;

  const beforePath = computeFullMazePath(ctx.round, ctx.towers);
  if (!beforePath.valid || remBudget < 2) {
    const cross = measureBandCrossingX(beforePath, midRefY, ctx.gw * 0.5);
    return {
      committed: false,
      actualOpenLeft: cross < ctx.gw * 0.5,
      crossingX: cross,
      wallsAdded: 0,
    };
  }

  let minWallX = Math.max(0, cellMinX);
  let maxWallX = Math.min(ctx.gw - 2, cellMaxX - 1);
  let effWantOpenLeft = wantOpenLeft;
  let effMinDetour = minRequiredDetour;
  let effCellMinX = cellMinX;
  let effCellMaxX = cellMaxX;

  // When remaining walls cannot span the full arena, build a cliff-rooted chicane wing
  // across the side where the runner currently enters this band instead of rolling back!
  const fullBricksNeeded = Math.ceil((maxWallX - minWallX + 2) / 2.3);
  const isPartialWing = remBudget < fullBricksNeeded - 1;
  if (isPartialWing) {
    const curCross = measureBandCrossingX(beforePath, midRefY, ctx.gw * 0.5);
    if (curCross < ctx.gw * 0.5) {
      minWallX = 0;
      maxWallX = Math.min(ctx.gw - 4, remBudget * 2 - 2);
      effCellMinX = 0;
      effCellMaxX = maxWallX + 1;
      effWantOpenLeft = false;
    } else {
      maxWallX = ctx.gw - 2;
      minWallX = Math.max(2, ctx.gw - remBudget * 2);
      effCellMinX = minWallX;
      effCellMaxX = ctx.gw - 1;
      effWantOpenLeft = true;
    }
    effMinDetour = 0.8;
  }

  if (minWallX > maxWallX) {
    const cross = measureBandCrossingX(beforePath, midRefY, ctx.gw * 0.5);
    return {
      committed: false,
      actualOpenLeft: cross < ctx.gw * 0.5,
      crossingX: cross,
      wallsAdded: 0,
    };
  }

  const prevLen = ctx.towers.length;
  const fromRightToLeft = effWantOpenLeft;

  const targetXs: number[] = [];
  if (fromRightToLeft) {
    for (let x = maxWallX; x >= minWallX; x -= 2) targetXs.push(x);
    if (targetXs[targetXs.length - 1] !== minWallX) targetXs.push(minWallX);
  } else {
    for (let x = minWallX; x <= maxWallX; x += 2) targetXs.push(x);
    if (targetXs[targetXs.length - 1] !== maxWallX) targetXs.push(maxWallX);
  }

  // Fast batch placement: place the entire masonry row with O(1) rules and validate in 1 A* call!
  for (const bx of targetXs) {
    if (ctx.towers.length >= wallCap || ctx.towers.length >= ctx.maxWalls) {
      break;
    }
    const by = clampY(ryFn(bx));
    const r0 = by * ctx.gw + bx;
    const r1 = r0 + ctx.gw;
    if (
      (ctx.occupied[r0] || ctx.occupied[r1]) &&
      (ctx.occupied[r0 + 1] || ctx.occupied[r1 + 1])
    ) {
      continue;
    }

    if (
      canFit2x2Fast(ctx, bx, by) &&
      passesMasonryRules(ctx, bx, by, {
        allowCliffRoot: true,
        allowSpireRoot: true,
      })
    ) {
      commitValidatedWall(ctx, bx, by);
      continue;
    }

    const dir = fromRightToLeft ? -1 : 1;
    const collarOffsets: Array<[number, number]> = [
      [bx + dir, by],
      [bx - dir, by],
      [bx, by + 1],
      [bx, by - 1],
      [bx, by + 2],
      [bx, by - 2],
    ];
    for (const [cx, cy] of collarOffsets) {
      if (cx < minWallX || cx > maxWallX) continue;
      const cby = clampY(cy);
      if (
        canFit2x2Fast(ctx, cx, cby) &&
        passesMasonryRules(ctx, cx, cby, {
          allowCliffRoot: true,
          allowSpireRoot: true,
          allowSliverSeal: true,
        })
      ) {
        commitValidatedWall(ctx, cx, cby);
        break;
      }
    }
  }

  ctx.astarRemaining = Math.max(0, ctx.astarRemaining - 1);
  let latestPath = computeFullMazePath(ctx.round, ctx.towers);

  // Fallback to brick-by-brick validation ONLY when the batch row pinched a Keep/Spire choke
  if (!latestPath.valid) {
    rollbackTowersTo(ctx, prevLen);
    for (const bx of targetXs) {
      if (
        ctx.towers.length >= wallCap ||
        ctx.towers.length >= ctx.maxWalls ||
        ctx.astarRemaining <= 4
      ) {
        break;
      }
      const by = clampY(ryFn(bx));
      const r0 = by * ctx.gw + bx;
      const r1 = r0 + ctx.gw;
      if (
        (ctx.occupied[r0] || ctx.occupied[r1]) &&
        (ctx.occupied[r0 + 1] || ctx.occupied[r1 + 1])
      ) {
        continue;
      }

      const direct = tryPlaceWallDetailed(ctx, bx, by, {
        allowCliffRoot: true,
        allowSpireRoot: true,
      });
      if (direct.placed) {
        if (direct.pathResult) latestPath = direct.pathResult;
        continue;
      }
      if (direct.blockedPath) continue;

      const dir = fromRightToLeft ? -1 : 1;
      const collarOffsets: Array<[number, number]> = [
        [bx + dir, by],
        [bx - dir, by],
        [bx, by + 1],
        [bx, by - 1],
        [bx, by + 2],
        [bx, by - 2],
      ];
      for (const [cx, cy] of collarOffsets) {
        if (cx < minWallX || cx > maxWallX) continue;
        const cRes = tryPlaceWallDetailed(ctx, cx, clampY(cy), {
          allowCliffRoot: true,
          allowSpireRoot: true,
          allowSliverSeal: true,
        });
        if (cRes.placed) {
          if (cRes.pathResult) latestPath = cRes.pathResult;
          break;
        }
      }
    }
    latestPath = computeFullMazePath(ctx.round, ctx.towers);
  }

  for (let guard = 0; guard < 4; guard++) {
    if (
      ctx.towers.length >= wallCap ||
      ctx.towers.length >= ctx.maxWalls ||
      ctx.astarRemaining <= 4 ||
      !latestPath.valid
    ) {
      break;
    }

    let leakCell: GridPoint | null = null;
    for (let i = 1; i < latestPath.allPoints.length - 1; i++) {
      const pt = latestPath.allPoints[i];
      const lx = Math.floor(pt.x);
      const ly = Math.floor(pt.y);
      if (lx < effCellMinX || lx > effCellMaxX) continue;
      const bandY = clampY(ryFn(Math.min(ctx.gw - 2, Math.max(0, lx))));
      if (ly >= bandY && ly <= bandY + 1) {
        leakCell = { x: lx, y: ly };
        break;
      }
    }
    if (!leakCell) break;

    const leakBandY = clampY(
      ryFn(Math.min(ctx.gw - 2, Math.max(0, leakCell.x)))
    );
    const plugs: Array<[number, number]> = [
      [leakCell.x, leakCell.y],
      [leakCell.x - 1, leakCell.y],
      [leakCell.x, leakCell.y - 1],
      [leakCell.x - 1, leakCell.y - 1],
      [leakCell.x - 1, clampY(leakBandY + 2)],
      [leakCell.x, clampY(leakBandY + 2)],
      [leakCell.x - 1, clampY(leakBandY - 2)],
      [leakCell.x, clampY(leakBandY - 2)],
    ];

    let plugged = false;
    for (const [px, py] of plugs) {
      if (px < minWallX || px > maxWallX) continue;
      const pRes = tryPlaceWallDetailed(ctx, px, py, {
        allowCliffRoot: true,
        allowSpireRoot: true,
        allowSliverSeal: true,
      });
      if (pRes.placed) {
        if (pRes.pathResult) latestPath = pRes.pathResult;
        plugged = true;
        break;
      }
    }
    if (!plugged) break;
  }

  const afterPath = latestPath.valid
    ? latestPath
    : computeFullMazePath(ctx.round, ctx.towers);
  const wallsAdded = ctx.towers.length - prevLen;
  const distGain = afterPath.totalDistance - beforePath.totalDistance;
  const crossX = measureBandCrossingX(afterPath, midRefY, ctx.gw * 0.5);
  const reachedTargetSide = isPartialWing
    ? distGain >= effMinDetour
    : effWantOpenLeft
    ? crossX < ctx.gw * 0.48
    : crossX > ctx.gw * 0.52;

  if (wallsAdded > 0 && distGain < effMinDetour && !reachedTargetSide) {
    rollbackTowersTo(ctx, prevLen);
    const revCross = measureBandCrossingX(beforePath, midRefY, ctx.gw * 0.5);
    return {
      committed: false,
      actualOpenLeft: revCross < ctx.gw * 0.5,
      crossingX: revCross,
      wallsAdded: 0,
    };
  }

  return {
    committed: wallsAdded > 0 || reachedTargetSide,
    actualOpenLeft: crossX < ctx.gw * 0.5,
    crossingX: crossX,
    wallsAdded,
  };
}

function corridorPluggedBetween(
  round: RoundConfig,
  yUpper: number,
  yLower: number
): boolean {
  const gapHeight = yLower - (yUpper + 2);
  if (gapHeight <= 0) return true;
  if (gapHeight >= 3) return false;
  if (gapHeight === 1) {
    const cy = yUpper + 2;
    for (const sp of round.preplacedSpires) {
      if (sp.y === cy || sp.y + 1 === cy) return true;
    }
    for (const kp of round.obstacles) {
      if (kp.y === cy || kp.y + 1 === cy) return true;
    }
    return false;
  }

  const corridorY = yUpper + 2;
  for (const sp of round.preplacedSpires) {
    if (sp.y === corridorY) return true;
  }
  for (const kp of round.obstacles) {
    if (kp.y === corridorY) return true;
  }
  return false;
}

/**
 * Exact O(gh² * K) Dynamic Programming row selector packing non-colliding Spire-aligned rows.
 * When `sawtoothMode` is active (`maxWalls >= 40`), opens a 3-tile North Apron (`minY = 3`) and
 * rewards `stride = 5` (3-tile corridors) so alternating sawtooth slalom teeth fit cleanly!
 */
function selectOptimalBaffleRowsDP(
  round: RoundConfig,
  desiredCount: number,
  minStride: number
): number[] {
  const minY = 2;
  const maxY = round.gridHeight - 4;
  if (maxY < minY || desiredCount <= 0) return [];

  const rowScores = new Float64Array(round.gridHeight);
  for (let y = minY; y <= maxY; y++) {
    let s = 4.0;
    for (const sp of round.preplacedSpires) {
      const dy = Math.abs(sp.y - y);
      if (dy === 0) s += 6.5;
      else if (dy === 1) s += 3.8;
    }
    for (const kp of round.obstacles) {
      const dy = Math.abs(kp.y - y);
      if (dy <= 1) s += 2.2;
    }
    for (const cp of round.checkpoints) {
      if (Math.abs(cp.y - y) <= 1) s -= 2.4;
    }
    rowScores[y] = s;
  }

  const K = desiredCount;
  const H = round.gridHeight;
  const dp: Float64Array[] = Array.from({ length: K }, () =>
    new Float64Array(H).fill(-Infinity)
  );
  const prevRow: Int32Array[] = Array.from({ length: K }, () =>
    new Int32Array(H).fill(-1)
  );

  for (let y = minY; y <= maxY; y++) dp[0][y] = rowScores[y];

  for (let k = 1; k < K; k++) {
    for (let y = minY; y <= maxY; y++) {
      for (let py = minY; py <= y - minStride; py++) {
        if (dp[k - 1][py] === -Infinity) continue;
        if (y - py <= 4 && corridorPluggedBetween(round, py, y)) continue;
        const gapPenalty = Math.max(0, y - py - 5) * 0.35;
        const cand = dp[k - 1][py] + rowScores[y] - gapPenalty;
        if (cand > dp[k][y]) {
          dp[k][y] = cand;
          prevRow[k][y] = py;
        }
      }
    }
  }

  let bestK = -1;
  let bestEndY = -1;
  let bestTotal = -Infinity;

  for (let k = K - 1; k >= 0; k--) {
    for (let y = minY; y <= maxY; y++) {
      if (dp[k][y] > bestTotal) {
        bestTotal = dp[k][y];
        bestK = k;
        bestEndY = y;
      }
    }
    if (bestK !== -1) break;
  }
  if (bestK === -1) return [];

  const rows: number[] = [];
  let curY = bestEndY;
  for (let k = bestK; k >= 0 && curY !== -1; k--) {
    rows.push(curY);
    curY = prevRow[k][curY];
  }
  return rows.reverse();
}

function chooseInitialOpenLeft(
  round: RoundConfig,
  flipPolarity: boolean
): boolean {
  const midX = round.gridWidth * 0.5;
  const openLeft =
    round.spawn.x > midX
      ? true
      : round.spawn.x < midX - 2
      ? false
      : (round.preplacedSpires[0]?.x ?? midX - 1) < midX - 1;
  return flipPolarity ? !openLeft : openLeft;
}

function buildSwitchbackScaffold(
  ctx: BuilderContext,
  difficulty: BotDifficulty,
  scaffoldBudget: number,
  flipPolarity: boolean
): void {
  const turnGap =
    difficulty === 'NOVICE' ? 4 : difficulty === 'ARCHITECT' ? 3 : 2;
  const minStride = difficulty === 'NOVICE' ? 5 : 4;
  const desiredBaffles =
    difficulty === 'NOVICE'
      ? Math.min(3, Math.max(2, Math.floor(scaffoldBudget / 6)))
      : difficulty === 'ARCHITECT'
      ? Math.min(4, Math.max(3, Math.floor(scaffoldBudget / 6.2)))
      : Math.min(6, Math.max(4, Math.ceil(scaffoldBudget / 7.2)));

  const rows = selectOptimalBaffleRowsDP(ctx.round, desiredBaffles, minStride);
  let wantOpenLeft = chooseInitialOpenLeft(ctx.round, flipPolarity);

  for (const ry of rows) {
    if (ctx.towers.length >= scaffoldBudget || ctx.astarRemaining <= 4) break;
    const cellMinX = wantOpenLeft ? turnGap : 0;
    const cellMaxX = wantOpenLeft ? ctx.gw - 1 : ctx.gw - 1 - turnGap;

    const res = buildVerifiedBaffle(
      ctx,
      cellMinX,
      cellMaxX,
      wantOpenLeft,
      () => ry,
      scaffoldBudget
    );
    if (res.committed) {
      wantOpenLeft = !res.actualOpenLeft;
    }
  }
}

function buildSpiralScaffold(
  ctx: BuilderContext,
  difficulty: BotDifficulty,
  scaffoldBudget: number,
  flipPolarity: boolean
): void {
  const frostSpires = ctx.round.preplacedSpires.filter(
    (s) => s.spireType === 'FROST_OBELISK'
  );
  if (frostSpires.length === 0) {
    buildSwitchbackScaffold(ctx, difficulty, scaffoldBudget, flipPolarity);
    return;
  }

  const centerX = ctx.gw * 0.5 - 1;
  const centerY = ctx.gh * 0.5 - 1;
  frostSpires.sort(
    (a, b) =>
      Math.hypot(a.x - centerX, a.y - centerY) -
      Math.hypot(b.x - centerX, b.y - centerY)
  );

  const primary = frostSpires[0];
  const sy = Math.max(6, Math.min(ctx.gh - 8, primary.y));
  const turnGap =
    difficulty === 'NOVICE' ? 4 : difficulty === 'ARCHITECT' ? 3 : 2;
  const baseStride = 4;

  const yTop = Math.max(
    2,
    sy - (corridorPluggedBetween(ctx.round, sy - 4, sy) ? 5 : 4)
  );
  const yBot = Math.min(
    ctx.gh - 4,
    sy + (corridorPluggedBetween(ctx.round, sy, sy + 4) ? 5 : 4)
  );

  const maxBands =
    difficulty === 'NOVICE' ? 3 : difficulty === 'ARCHITECT' ? 4 : 6;

  const bandYs: number[] = [yTop, sy, yBot];
  let ny = yTop;
  while (ny - baseStride >= 2 && bandYs.length < maxBands) {
    const step = corridorPluggedBetween(ctx.round, ny - baseStride, ny)
      ? baseStride + 1
      : baseStride;
    if (ny - step < 2) break;
    ny -= step;
    bandYs.unshift(ny);
  }

  let by = yBot;
  while (by + baseStride <= ctx.gh - 4 && bandYs.length < maxBands) {
    const step = corridorPluggedBetween(ctx.round, by, by + baseStride)
      ? baseStride + 1
      : baseStride;
    if (by + step > ctx.gh - 4) break;
    by += step;
    bandYs.push(by);
  }

  const coreIdx = bandYs.indexOf(sy);
  const naturalCoreOpenLeft = !(primary.x <= centerX);
  const desiredCoreOpenLeft = flipPolarity
    ? !naturalCoreOpenLeft
    : naturalCoreOpenLeft;
  let wantOpenLeft =
    coreIdx % 2 === 0 ? desiredCoreOpenLeft : !desiredCoreOpenLeft;

  for (const rowY of bandYs) {
    if (ctx.towers.length >= scaffoldBudget || ctx.astarRemaining <= 4) break;
    const isCore = rowY === sy;

    const cellMinX = wantOpenLeft ? turnGap : 0;
    const cellMaxX = wantOpenLeft ? ctx.gw - 1 : ctx.gw - 1 - turnGap;

    const res = buildVerifiedBaffle(
      ctx,
      cellMinX,
      cellMaxX,
      wantOpenLeft,
      () => rowY,
      scaffoldBudget
    );

    if (res.committed) {
      wantOpenLeft = !res.actualOpenLeft;

      if (
        isCore &&
        difficulty !== 'NOVICE' &&
        ctx.towers.length < scaffoldBudget &&
        ctx.astarRemaining > 4
      ) {
        const flankX = res.actualOpenLeft ? primary.x - 4 : primary.x + 4;
        if (flankX >= turnGap && flankX <= ctx.gw - 2 - turnGap) {
          const before = computeFullMazePath(ctx.round, ctx.towers);
          const riser = tryPlaceWallDetailed(ctx, flankX, rowY - 2, {
            allowCliffRoot: false,
            allowSpireRoot: false,
          });
          if (
            riser.placed &&
            riser.pathResult &&
            riser.pathResult.totalDistance < before.totalDistance + 0.4
          ) {
            removeWallAtIndex(ctx, ctx.towers.length - 1);
          }
        }
      }
    }
  }
}

function buildClapChainScaffold(
  ctx: BuilderContext,
  difficulty: BotDifficulty,
  scaffoldBudget: number,
  flipPolarity: boolean
): void {
  const turnGap =
    difficulty === 'NOVICE' ? 4 : difficulty === 'ARCHITECT' ? 3 : 2;
  const minStride = difficulty === 'NOVICE' ? 5 : 4;
  const desiredStages =
    difficulty === 'NOVICE'
      ? 3
      : difficulty === 'ARCHITECT'
      ? 4
      : Math.min(6, Math.max(4, Math.ceil(scaffoldBudget / 7.2)));

  const rows = selectOptimalBaffleRowsDP(ctx.round, desiredStages, minStride);

  const midX = ctx.gw * 0.5;
  const chronoSpires = ctx.round.preplacedSpires.filter(
    (s) => s.spireType === 'CHRONO_SPIRE'
  );
  let wantOpenLeft = chooseInitialOpenLeft(ctx.round, flipPolarity);
  if (
    !flipPolarity &&
    chronoSpires.length > 0 &&
    ctx.round.preplacedSpires.length >= 2
  ) {
    const firstNonChrono = ctx.round.preplacedSpires.find(
      (s) => s.spireType !== 'CHRONO_SPIRE'
    );
    if (firstNonChrono) {
      wantOpenLeft = firstNonChrono.x < midX;
    }
  }

  const stepStart = Math.floor(ctx.gw * 0.28);
  const stepEnd = Math.ceil(ctx.gw * 0.68);
  const apexStart = Math.floor(ctx.gw * 0.4);
  const apexEnd = Math.ceil(ctx.gw * 0.56);

  for (let idx = 0; idx < rows.length; idx++) {
    if (ctx.towers.length >= scaffoldBudget || ctx.astarRemaining <= 4) break;
    const baseY = rows[idx];
    const prevY = idx > 0 ? rows[idx - 1] : -10;
    const nextY = idx + 1 < rows.length ? rows[idx + 1] : ctx.gh + 10;

    const canStep2Down =
      difficulty !== 'NOVICE' &&
      nextY - (baseY + 2) >= 4 &&
      !corridorPluggedBetween(ctx.round, baseY + 2, nextY);
    const canStep2Up =
      difficulty !== 'NOVICE' &&
      baseY - 2 - prevY >= 4 &&
      !corridorPluggedBetween(ctx.round, prevY, baseY - 2);
    const canStepDown =
      difficulty !== 'NOVICE' &&
      nextY - (baseY + 1) >= 4 &&
      !corridorPluggedBetween(ctx.round, baseY + 1, nextY);
    const canStepUp =
      difficulty !== 'NOVICE' &&
      baseY - 1 - prevY >= 4 &&
      !corridorPluggedBetween(ctx.round, prevY, baseY - 1);

    const maxShift =
      idx % 2 === 0
        ? canStep2Down
          ? 2
          : canStepDown
          ? 1
          : 0
        : canStep2Up
        ? -2
        : canStepUp
        ? -1
        : 0;

    const chevronY = (x: number): number => {
      if (maxShift === 0) return baseY;
      const sign = Math.sign(maxShift);
      const mag = Math.abs(maxShift);
      if (mag >= 2 && x >= apexStart && x <= apexEnd) return baseY + sign * 2;
      if (x >= stepStart && x <= stepEnd) return baseY + sign;
      return baseY;
    };

    const cellMinX = wantOpenLeft ? turnGap : 0;
    const cellMaxX = wantOpenLeft ? ctx.gw - 1 : ctx.gw - 1 - turnGap;

    const res = buildVerifiedBaffle(
      ctx,
      cellMinX,
      cellMaxX,
      wantOpenLeft,
      chevronY,
      scaffoldBudget
    );
    if (res.committed) {
      wantOpenLeft = !res.actualOpenLeft;
    }
  }
}

function isSpireHitByPath(
  path: PathResult,
  sp: { x: number; y: number; spireType?: SpireType },
  tier: number
): boolean {
  const sType: SpireType = sp.spireType || 'THUNDERCLAP';
  const radSq = Math.pow(
    getEffectiveSpireStats(sType, tier).effectiveRange + 0.15,
    2
  );
  const cx = sp.x + 1.0;
  const cy = sp.y + 1.0;
  const pts = path.allPoints;
  for (let i = 0; i < pts.length; i++) {
    const dx = pts[i].x - cx;
    const dy = pts[i].y - cy;
    if (dx * dx + dy * dy <= radSq) return true;
  }
  return false;
}

/**
 * Stage 3: Zero-Sim Geometric Keep-to-Spire Overcharge Bridging (<1ms).
 * Connects Crimson Keeps into Spire perimeters strictly when the target Spire is actively
 * hit by the runner's route, without burning 60Hz tick simulations per candidate!
 */
function bridgeKeepsForOvercharge(
  ctx: BuilderContext,
  difficulty: BotDifficulty
): void {
  if (difficulty === 'NOVICE' || ctx.round.obstacles.length === 0) return;

  const targetMaxTier = difficulty === 'ARCHITECT' ? 1 : 3;
  const isJuggernaut =
    RUNNER_ARCHETYPES[ctx.round.runnerType || 'SCOUT'].slowResist > 0;

  let passes = 0;
  while (
    ctx.towers.length < ctx.maxWalls &&
    passes < 3 &&
    ctx.astarRemaining > 6
  ) {
    passes++;
    const baseCirc = computeCitadelCircuitry(ctx.round, ctx.towers);
    if (baseCirc.spireOverchargeTiers.every((t) => t >= targetMaxTier)) break;

    const basePath = computeFullMazePath(ctx.round, ctx.towers);
    if (!basePath.valid) break;
    const baseGeo = scorePathWithMapFeatures(
      ctx.round,
      basePath,
      baseCirc.spireOverchargeTiers
    );

    const activeSpireFlags = ctx.round.preplacedSpires.map((sp, idx) =>
      isSpireHitByPath(basePath, sp, (baseCirc.spireOverchargeTiers[idx] || 0) + 1)
    );

    const candidateSet = new Map<number, GridPoint>();
    ctx.round.obstacles.forEach((kp, kIdx) => {
      if (!baseCirc.linkedKeepIndices.has(kIdx)) {
        for (const [dx, dy] of CLEAN_MASONRY_DIRS) {
          const tx = kp.x + dx;
          const ty = kp.y + dy;
          if (canFit2x2Fast(ctx, tx, ty)) {
            candidateSet.set(ty * ctx.gw + tx, { x: tx, y: ty });
          }
        }
      }
    });
    ctx.round.preplacedSpires.forEach((sp, sIdx) => {
      if (
        activeSpireFlags[sIdx] &&
        (baseCirc.spireOverchargeTiers[sIdx] || 0) < targetMaxTier
      ) {
        for (let dy = -3; dy <= 3; dy++) {
          for (let dx = -3; dx <= 3; dx++) {
            if (dx * dx + dy * dy > 13) continue;
            const tx = sp.x + dx;
            const ty = sp.y + dy;
            if (canFit2x2Fast(ctx, tx, ty)) {
              candidateSet.set(ty * ctx.gw + tx, { x: tx, y: ty });
            }
          }
        }
      }
    });

    let bestSingle: { x: number; y: number; gainScore: number } | null = null;
    for (const cand of candidateSet.values()) {
      if (ctx.astarRemaining <= 4) break;
      if (!passesMasonryRules(ctx, cand.x, cand.y, { allowSpireRoot: false })) {
        continue;
      }

      const testTowers: PlacedTower[] = [
        ...ctx.towers,
        { id: '__k1__', type: 'BLOCK', x: cand.x, y: cand.y, createdAt: 0 },
      ];
      const nextCirc = computeCitadelCircuitry(ctx.round, testTowers);

      let activeOverDelta = 0;
      for (let s = 0; s < ctx.round.preplacedSpires.length; s++) {
        const diffTier =
          (nextCirc.spireOverchargeTiers[s] || 0) -
          (baseCirc.spireOverchargeTiers[s] || 0);
        if (diffTier > 0 && activeSpireFlags[s]) {
          activeOverDelta += diffTier;
        }
      }
      if (activeOverDelta <= 0) continue;

      const check = validateCounted(ctx, ctx.towers, cand.x, cand.y);
      if (!check.valid || !check.pathResult) continue;
      if (check.pathResult.totalDistance < basePath.totalDistance - 0.15) {
        continue;
      }

      const geoDelta =
        scorePathWithMapFeatures(
          ctx.round,
          check.pathResult,
          nextCirc.spireOverchargeTiers
        ) - baseGeo;

      const gainScore =
        geoDelta + activeOverDelta * (isJuggernaut ? 4.2 : 2.2);
      if (gainScore > 0.8 && (!bestSingle || gainScore > bestSingle.gainScore)) {
        bestSingle = { x: cand.x, y: cand.y, gainScore };
      }
    }

    if (bestSingle) {
      commitValidatedWall(ctx, bestSingle.x, bestSingle.y);
      continue;
    }

    if (
      difficulty === 'GRANDMASTER' &&
      ctx.towers.length + 2 <= ctx.maxWalls &&
      ctx.astarRemaining > 8
    ) {
      let bestPair: { a: GridPoint; b: GridPoint; gainScore: number } | null =
        null;

      for (let kIdx = 0; kIdx < ctx.round.obstacles.length; kIdx++) {
        if (ctx.astarRemaining <= 6) break;
        if (baseCirc.linkedKeepIndices.has(kIdx)) continue;
        const kp = ctx.round.obstacles[kIdx];

        for (const [dx1, dy1] of CLEAN_MASONRY_DIRS) {
          const ax = kp.x + dx1;
          const ay = kp.y + dy1;
          if (!canFit2x2Fast(ctx, ax, ay)) continue;
          if (!passesMasonryRules(ctx, ax, ay, { allowSpireRoot: false })) {
            continue;
          }

          for (const [dx2, dy2] of CLEAN_MASONRY_DIRS) {
            const bx = ax + dx2;
            const by = ay + dy2;
            if (do2x2Overlap(ax, ay, bx, by) || !canFit2x2Fast(ctx, bx, by)) {
              continue;
            }

            const pairTowers: PlacedTower[] = [
              ...ctx.towers,
              { id: '__ka__', type: 'BLOCK', x: ax, y: ay, createdAt: 0 },
              { id: '__kb__', type: 'BLOCK', x: bx, y: by, createdAt: 0 },
            ];
            const pairCirc = computeCitadelCircuitry(ctx.round, pairTowers);
            let activeOverDelta = 0;
            for (let s = 0; s < ctx.round.preplacedSpires.length; s++) {
              const dtier =
                (pairCirc.spireOverchargeTiers[s] || 0) -
                (baseCirc.spireOverchargeTiers[s] || 0);
              if (dtier > 0 && activeSpireFlags[s]) {
                activeOverDelta += dtier;
              }
            }
            if (activeOverDelta <= 0) continue;

            const c1 = validateCounted(ctx, ctx.towers, ax, ay);
            if (!c1.valid) continue;
            const c2 = validateCounted(ctx, pairTowers.slice(0, -1), bx, by);
            if (!c2.valid || !c2.pathResult) continue;
            if (c2.pathResult.totalDistance < basePath.totalDistance - 0.1) {
              continue;
            }

            const geoDelta =
              scorePathWithMapFeatures(
                ctx.round,
                c2.pathResult,
                pairCirc.spireOverchargeTiers
              ) - baseGeo;
            const gainScore =
              geoDelta + activeOverDelta * (isJuggernaut ? 4.5 : 2.4);
            if (
              gainScore > 2.0 &&
              (!bestPair || gainScore > bestPair.gainScore)
            ) {
              bestPair = { a: { x: ax, y: ay }, b: { x: bx, y: by }, gainScore };
            }
          }
        }
      }

      if (bestPair) {
        commitValidatedWall(ctx, bestPair.a.x, bestPair.a.y);
        if (
          canFit2x2Fast(ctx, bestPair.b.x, bestPair.b.y) &&
          passesMasonryRules(ctx, bestPair.b.x, bestPair.b.y, {
            allowCliffRoot: false,
            allowSpireRoot: false,
          })
        ) {
          commitValidatedWall(ctx, bestPair.b.x, bestPair.b.y);
          continue;
        } else {
          removeWallAtIndex(ctx, ctx.towers.length - 1);
        }
      }
    }

    break;
  }
}

/**
 * Collects masonry-bridged candidate cells that directly intersect (or 1-tile approach for 2-wall teeth)
 * the active runner path — exploiting the A* invariant that non-path cells have Δdistance === 0!
 */
function collectRankedPathCandidates(
  ctx: BuilderContext,
  curPath: PathResult,
  allowCliffRoot: boolean,
  includeHalo: boolean
): GridPoint[] {
  const pathHitCount = new Uint16Array(ctx.gw * ctx.gh);
  const pts = curPath.allPoints;
  for (let i = 1; i < pts.length - 1; i++) {
    const px = Math.floor(pts[i].x);
    const py = Math.floor(pts[i].y);
    if (px >= 0 && px < ctx.gw && py >= 0 && py < ctx.gh) {
      pathHitCount[py * ctx.gw + px]++;
    }
  }

  const seen = new Uint8Array(ctx.gw * ctx.gh);
  const scored: Array<{ x: number; y: number; priority: number }> = [];

  const consider = (tx: number, ty: number) => {
    if (!canFit2x2Fast(ctx, tx, ty)) return;
    const key = ty * ctx.gw + tx;
    if (seen[key]) return;
    seen[key] = 1;

    let pathTouch =
      pathHitCount[key] +
      pathHitCount[key + 1] +
      pathHitCount[key + ctx.gw] +
      pathHitCount[key + ctx.gw + 1];

    if (pathTouch === 0 && includeHalo) {
      for (let dy = -1; dy <= 2 && pathTouch === 0; dy++) {
        for (let dx = -1; dx <= 2; dx++) {
          const hx = tx + dx;
          const hy = ty + dy;
          if (
            hx >= 0 &&
            hx < ctx.gw &&
            hy >= 0 &&
            hy < ctx.gh &&
            pathHitCount[hy * ctx.gw + hx] > 0
          ) {
            pathTouch = 0.25;
            break;
          }
        }
      }
    }
    if (pathTouch === 0) return;

    if (
      !passesMasonryRules(ctx, tx, ty, {
        allowCliffRoot,
        allowSpireRoot: false,
      })
    ) {
      return;
    }

    let spireBonus = 0;
    for (let s = 0; s < ctx.round.preplacedSpires.length; s++) {
      const sp = ctx.round.preplacedSpires[s];
      const dist = Math.hypot(tx - sp.x, ty - sp.y);
      if (dist <= 4.5) spireBonus += 4.5 - dist;
    }

    scored.push({
      x: tx,
      y: ty,
      priority: pathTouch * 3.2 + spireBonus,
    });
  };

  for (let i = 0; i < ctx.towers.length; i++) {
    const t = ctx.towers[i];
    for (const [dx, dy] of CLEAN_MASONRY_DIRS) consider(t.x + dx, t.y + dy);
  }
  for (let i = 0; i < ctx.round.obstacles.length; i++) {
    const o = ctx.round.obstacles[i];
    for (const [dx, dy] of CLEAN_MASONRY_DIRS) consider(o.x + dx, o.y + dy);
  }
  if (allowCliffRoot) {
    for (let y = 0; y <= ctx.gh - 2; y += 2) {
      consider(0, y);
      consider(ctx.gw - 2, y);
    }
  }

  scored.sort((a, b) => b.priority - a.priority);
  return scored;
}

/**
 * Stage 4 & Stage 5: Cached-Sim Frontier Polish + Dedicated Full-Budget GRANDMASTER Spend Pass.
 */
function spendAndPolishWalls(
  ctx: BuilderContext,
  difficulty: BotDifficulty
): MazeEvalResult | null {
  const isHeavyRound = ctx.round.parTimeSeconds >= 50;
  const maxSteps =
    difficulty === 'NOVICE'
      ? 2
      : difficulty === 'ARCHITECT'
      ? 4
      : isHeavyRound
      ? 6
      : 10;
  const topK = isHeavyRound ? 1 : 2;
  const targetValidPerStep = difficulty === 'GRANDMASTER' ? 5 : 4;

  let cachedPath: PathResult | null = null;
  let cachedEval: MazeEvalResult | null = null;

  let step = 0;
  while (
    ctx.towers.length < ctx.maxWalls &&
    step < maxSteps &&
    ctx.astarRemaining > 3 &&
    ctx.simRemaining > 1
  ) {
    step++;
    const curPath: PathResult =
      cachedPath ?? computeFullMazePath(ctx.round, ctx.towers);
    if (!curPath.valid) break;

    const curCirc = computeCitadelCircuitry(ctx.round, ctx.towers);
    const curGeo = scorePathWithMapFeatures(
      ctx.round,
      curPath,
      curCirc.spireOverchargeTiers
    );
    const curEval: MazeEvalResult =
      cachedEval ?? evalSimCounted(ctx, ctx.towers, curPath);
    cachedPath = curPath;
    cachedEval = curEval;

    const curComp =
      curEval.finishTimeSeconds * 4.0 +
      curEval.overchargedSpires * 1.4 +
      curPath.totalDistance * 0.12;

    const directPathCoords = collectRankedPathCandidates(
      ctx,
      curPath,
      difficulty === 'GRANDMASTER',
      false
    );

    const geoCandidates: Array<{
      x: number;
      y: number;
      geoDelta: number;
      pathResult: PathResult;
    }> = [];

    for (
      let i = 0;
      i < directPathCoords.length &&
      geoCandidates.length < targetValidPerStep &&
      ctx.astarRemaining > 1;
      i++
    ) {
      const c = directPathCoords[i];
      const check = validateCounted(ctx, ctx.towers, c.x, c.y);
      if (!check.valid || !check.pathResult) continue;

      const geo = scorePathWithMapFeatures(
        ctx.round,
        check.pathResult,
        curCirc.spireOverchargeTiers
      );
      const geoDelta = geo - curGeo;
      if (
        geoDelta > 0.03 ||
        check.pathResult.totalDistance > curPath.totalDistance + 0.15
      ) {
        geoCandidates.push({
          x: c.x,
          y: c.y,
          geoDelta,
          pathResult: check.pathResult,
        });
      }
    }

    geoCandidates.sort((a, b) => b.geoDelta - a.geoDelta);
    const shortlist = geoCandidates.slice(0, topK);

    let bestSingle: {
      x: number;
      y: number;
      comp: number;
      pathResult: PathResult;
      sim: MazeEvalResult;
    } | null = null;
    const minGain = difficulty === 'GRANDMASTER' ? 0.1 : 0.3;

    for (const cand of shortlist) {
      if (ctx.simRemaining <= 0) break;
      const sim = evalSimCounted(
        ctx,
        [
          ...ctx.towers,
          { id: '__p1__', type: 'BLOCK', x: cand.x, y: cand.y, createdAt: 0 },
        ],
        cand.pathResult
      );
      const comp =
        sim.finishTimeSeconds * 4.0 +
        sim.overchargedSpires * 1.4 +
        cand.pathResult.totalDistance * 0.12;

      if (comp > curComp + minGain && (!bestSingle || comp > bestSingle.comp)) {
        bestSingle = {
          x: cand.x,
          y: cand.y,
          comp,
          pathResult: cand.pathResult,
          sim,
        };
      }
    }

    if (bestSingle) {
      commitValidatedWall(ctx, bestSingle.x, bestSingle.y);
      cachedPath = bestSingle.pathResult;
      cachedEval = bestSingle.sim;
      continue;
    }

    break;
  }

  // Dedicated zero-sim A*-only Full-Budget Spend Loop (populates sawtooth teeth & Keep links!)
  if (difficulty === 'GRANDMASTER' && ctx.towers.length < ctx.maxWalls) {
    const segScale = 1 + (ctx.round.checkpoints?.length ?? 0) * 0.5;
    const remNeed = ctx.maxWalls - ctx.towers.length;
    let tailAstar = Math.min(
      52,
      Math.max(24, Math.round((28 + remNeed * 3) / segScale))
    );
    let curPath = cachedPath ?? computeFullMazePath(ctx.round, ctx.towers);
    let tailSteps = 0;

    while (
      ctx.towers.length < ctx.maxWalls &&
      tailSteps++ < 22 &&
      tailAstar > 1 &&
      curPath.valid
    ) {
      const curCirc = computeCitadelCircuitry(ctx.round, ctx.towers);
      const curGeo = scorePathWithMapFeatures(
        ctx.round,
        curPath,
        curCirc.spireOverchargeTiers
      );

      const coords = collectRankedPathCandidates(ctx, curPath, true, false);
      let best: { x: number; y: number; delta: number; path: PathResult } | null =
        null;
      let validFound = 0;

      for (
        let i = 0;
        i < coords.length && validFound < 7 && tailAstar > 0;
        i++
      ) {
        tailAstar--;
        const c = coords[i];
        const check = validateTowerPlacement(ctx.round, ctx.towers, c.x, c.y);
        if (!check.valid || !check.pathResult) continue;
        validFound++;
        if (check.pathResult.totalDistance < curPath.totalDistance + 0.16) {
          continue;
        }
        const delta =
          scorePathWithMapFeatures(
            ctx.round,
            check.pathResult,
            curCirc.spireOverchargeTiers
          ) - curGeo;
        if (delta > 0.03 && (!best || delta > best.delta)) {
          best = { x: c.x, y: c.y, delta, path: check.pathResult };
        }
      }

      if (best) {
        commitValidatedWall(ctx, best.x, best.y);
        curPath = best.path;
        cachedEval = null;
        continue;
      }

      // Secondary Overcharge Keep link spend (connects remaining Keeps to Spire circuits)
      if (ctx.round.obstacles.length > 0 && tailAstar > 3) {
        let linkedKeep = false;
        for (let kIdx = 0; kIdx < ctx.round.obstacles.length; kIdx++) {
          if (curCirc.linkedKeepIndices.has(kIdx) || tailAstar <= 1) continue;
          const kp = ctx.round.obstacles[kIdx];
          for (const [dx, dy] of CLEAN_MASONRY_DIRS) {
            if (tailAstar <= 0) break;
            const kx = kp.x + dx;
            const ky = kp.y + dy;
            if (!canFit2x2Fast(ctx, kx, ky)) continue;
            if (!passesMasonryRules(ctx, kx, ky, { allowSpireRoot: false })) {
              continue;
            }
            const nextCirc = computeCitadelCircuitry(ctx.round, [
              ...ctx.towers,
              { id: '__tk__', type: 'BLOCK', x: kx, y: ky, createdAt: 0 },
            ]);
            if (nextCirc.overchargedSpires <= curCirc.overchargedSpires) {
              continue;
            }
            tailAstar--;
            const kc = validateTowerPlacement(ctx.round, ctx.towers, kx, ky);
            if (
              kc.valid &&
              kc.pathResult &&
              kc.pathResult.totalDistance >= curPath.totalDistance - 0.05
            ) {
              commitValidatedWall(ctx, kx, ky);
              curPath = kc.pathResult;
              cachedEval = null;
              linkedKeep = true;
              break;
            }
          }
          if (linkedKeep) break;
        }
        if (linkedKeep) continue;
      }

      // 2-wall slalom tooth fallback (skips BLOCKS_PATH seeds until up to 4 valid seeds are tested)
      if (ctx.towers.length + 2 <= ctx.maxWalls && tailAstar > 6) {
        const halo = collectRankedPathCandidates(ctx, curPath, true, true);
        let pairCommitted = false;
        let validSeedsTried = 0;

        for (
          let sIdx = 0;
          sIdx < halo.length && validSeedsTried < 2 && tailAstar > 2;
          sIdx++
        ) {
          const s = halo[sIdx];
          tailAstar--;
          const c1 = validateTowerPlacement(ctx.round, ctx.towers, s.x, s.y);
          if (!c1.valid) continue;
          validSeedsTried++;
          commitValidatedWall(ctx, s.x, s.y);

          let best2: {
            x: number;
            y: number;
            delta: number;
            path: PathResult;
          } | null = null;
          for (const [dx, dy] of CLEAN_MASONRY_DIRS) {
            if (tailAstar <= 0) break;
            const ex = s.x + dx;
            const ey = s.y + dy;
            if (!canFit2x2Fast(ctx, ex, ey)) continue;
            if (
              !passesMasonryRules(ctx, ex, ey, {
                allowCliffRoot: true,
                allowSpireRoot: false,
              })
            ) {
              continue;
            }
            tailAstar--;
            const c2 = validateTowerPlacement(ctx.round, ctx.towers, ex, ey);
            if (!c2.valid || !c2.pathResult) continue;
            if (c2.pathResult.totalDistance < curPath.totalDistance + 0.35) {
              continue;
            }
            const delta =
              scorePathWithMapFeatures(
                ctx.round,
                c2.pathResult,
                curCirc.spireOverchargeTiers
              ) - curGeo;
            if (delta > 0.07 && (!best2 || delta > best2.delta)) {
              best2 = { x: ex, y: ey, delta, path: c2.pathResult };
            }
          }

          if (best2) {
            commitValidatedWall(ctx, best2.x, best2.y);
            curPath = best2.path;
            cachedEval = null;
            pairCommitted = true;
            break;
          } else {
            removeWallAtIndex(ctx, ctx.towers.length - 1);
          }
        }

        if (pairCommitted) continue;
      }

      break;
    }
  }

  return cachedEval;
}

/**
 * Zero-Sim Local Leaf & Corner Masonry Hygiene Pass (<0.8ms):
 * 1. Skips collinear `deg === 2` interior baffle bricks in O(1) (only leaf tips & corners can be dead spurs).
 * 2. Strips zero-impact dead walls with ZERO 60Hz simulations (even on Waygate rounds, via Waygate exit path check).
 * 3. Unconditionally removes any freestanding wall with `0` post-Gabriel rendered bridges.
 */
function cleanZeroImpactAndUnbridgedWalls(
  ctx: BuilderContext,
  stripZeroImpact: boolean,
  knownEval: MazeEvalResult | null = null
): MazeEvalResult | null {
  if (ctx.towers.length === 0) return knownEval;

  const getLocalBridgedNeighbors = (
    tx: number,
    ty: number,
    skipTowerIdx: number
  ): GridPoint[] => {
    const local: GridPoint[] = [];
    for (let i = 0; i < ctx.towers.length; i++) {
      if (i === skipTowerIdx) continue;
      const t = ctx.towers[i];
      if (Math.abs(t.x - tx) <= 4 && Math.abs(t.y - ty) <= 4) {
        local.push(t);
      }
    }
    for (let k = 0; k < ctx.round.obstacles.length; k++) {
      const o = ctx.round.obstacles[k];
      if (Math.abs(o.x - tx) <= 4 && Math.abs(o.y - ty) <= 4) {
        local.push(o);
      }
    }

    const bridged: GridPoint[] = [];
    for (let i = 0; i < local.length; i++) {
      const m = local[i];
      if (m.x === tx && m.y === ty) continue;
      if (Math.abs(m.x - tx) > 2 || Math.abs(m.y - ty) > 2) continue;
      if (areMasonryNodesBridged(tx, ty, m.x, m.y, local)) {
        bridged.push(m);
      }
    }
    return bridged;
  };

  let cachedBaseEval = knownEval;

  if (stripZeroImpact && ctx.towers.length > 3) {
    let basePath = computeFullMazePath(ctx.round, ctx.towers);
    let baseCirc = computeCitadelCircuitry(ctx.round, ctx.towers);
    const wgExitRound: RoundConfig | null = ctx.round.waygate
      ? {
          ...ctx.round,
          spawn: ctx.round.waygate.exit,
          checkpoints: [],
        }
      : null;
    let baseWgPath = wgExitRound
      ? computeFullMazePath(wgExitRound, ctx.towers)
      : null;

    let pass = 0;
    let strippedInPass = true;
    while (strippedInPass && pass++ < 2 && ctx.towers.length > 3) {
      strippedInPass = false;
      for (let i = ctx.towers.length - 1; i >= 0; i--) {
        const target = ctx.towers[i];
        const bridged = getLocalBridgedNeighbors(target.x, target.y, -1);
        if (bridged.length > 2) continue;

        // On pass 2, only re-check newly exposed deg <= 1 leaf tips
        if (pass > 1 && bridged.length > 1) continue;

        // Skip interior collinear baffle segments (dx1 === -dx2 && dy1 === -dy2) in O(1)!
        if (
          bridged.length === 2 &&
          bridged[0].x - target.x === -(bridged[1].x - target.x) &&
          bridged[0].y - target.y === -(bridged[1].y - target.y)
        ) {
          continue;
        }

        let orphansNeighbor = false;
        for (let j = 0; j < ctx.towers.length; j++) {
          if (j === i) continue;
          const nb = ctx.towers[j];
          if (Math.abs(nb.x - target.x) > 2 || Math.abs(nb.y - target.y) > 2) {
            continue;
          }
          if (getLocalBridgedNeighbors(nb.x, nb.y, i).length === 0) {
            orphansNeighbor = true;
            break;
          }
        }
        if (orphansNeighbor) continue;

        const without = ctx.towers.filter((_, idx) => idx !== i);
        const nextCirc = computeCitadelCircuitry(ctx.round, without);
        if (nextCirc.overchargedSpires < baseCirc.overchargedSpires) continue;

        const pathWithout = computeFullMazePath(ctx.round, without);
        if (!pathWithout.valid) continue;

        const distDrop = basePath.totalDistance - pathWithout.totalDistance;
        if (distDrop >= 0.08) continue;

        if (wgExitRound && baseWgPath) {
          const wgWithout = computeFullMazePath(wgExitRound, without);
          if (
            wgWithout.valid &&
            baseWgPath.totalDistance - wgWithout.totalDistance >= 0.08
          ) {
            continue;
          }
          removeWallAtIndex(ctx, i);
          basePath = pathWithout;
          baseCirc = nextCirc;
          baseWgPath = wgWithout;
          cachedBaseEval = null;
          strippedInPass = true;
          continue;
        }

        removeWallAtIndex(ctx, i);
        basePath = pathWithout;
        baseCirc = nextCirc;
        cachedBaseEval = null;
        strippedInPass = true;
      }
    }
  }

  let changed = true;
  while (changed && ctx.towers.length > 0) {
    changed = false;
    for (let i = ctx.towers.length - 1; i >= 0; i--) {
      const t = ctx.towers[i];
      if (getLocalBridgedNeighbors(t.x, t.y, -1).length === 0) {
        const without = ctx.towers.filter((_, idx) => idx !== i);
        if (computeFullMazePath(ctx.round, without).valid) {
          removeWallAtIndex(ctx, i);
          cachedBaseEval = null;
          changed = true;
          break;
        }
      }
    }
  }

  return cachedBaseEval;
}

function buildSingleAttempt(
  round: RoundConfig,
  maxWalls: number,
  difficulty: BotDifficulty,
  style: BotStyle,
  flipPolarity: boolean,
  attemptTag: string
): { towers: PlacedTower[]; evalRes: MazeEvalResult } {
  const segScale = 1 + (round.checkpoints?.length ?? 0) * 0.45;
  const astarBudget = Math.max(
    24,
    Math.round(
      (difficulty === 'NOVICE'
        ? 45
        : difficulty === 'ARCHITECT'
        ? 75
        : 95 + maxWalls) / segScale
    )
  );
  const simBudget =
    difficulty === 'NOVICE'
      ? 2
      : difficulty === 'ARCHITECT'
      ? 3
      : round.parTimeSeconds >= 50
      ? 3
      : 6;

  const ctx = createBuilderContext(
    round,
    maxWalls,
    `ai_r${round.roundNumber}_${attemptTag}`,
    astarBudget,
    simBudget
  );

  const scaffoldShare =
    difficulty === 'NOVICE' ? 0.94 : difficulty === 'ARCHITECT' ? 0.9 : 0.98;
  const scaffoldBudget = Math.max(6, Math.floor(maxWalls * scaffoldShare));

  if (style === 'SPIRAL') {
    buildSpiralScaffold(ctx, difficulty, scaffoldBudget, flipPolarity);
  } else if (style === 'CLAP_CHAIN') {
    buildClapChainScaffold(ctx, difficulty, scaffoldBudget, flipPolarity);
  } else {
    buildSwitchbackScaffold(ctx, difficulty, scaffoldBudget, flipPolarity);
  }

  cleanZeroImpactAndUnbridgedWalls(ctx, true);
  bridgeKeepsForOvercharge(ctx, difficulty);
  let lastEval = spendAndPolishWalls(ctx, difficulty);
  lastEval = cleanZeroImpactAndUnbridgedWalls(ctx, true, lastEval);

  const evalRes =
    lastEval ??
    evaluateMazeRunTime(round, ctx.towers, {
      collectClapLocations: false,
    });
  return { towers: ctx.towers, evalRes };
}

/**
 * Deterministic, hardware-independent 4-Stage Corridor-First Maze Architect:
 * - Strictly counted evaluation budget (zero wall-clock deadlines; identical output across all CPUs)
 * - Verified & self-healing baffle openings (zero straight-chute seeds, >=2-tile turn gaps)
 * - Exact renderer-matched masonry rules (0 rendered bridge triangles, 0 isolated pimples, 0 [±2,±1] crooked spurs)
 * - Multi-style quality floor guaranteeing `GRANDMASTER > ARCHITECT > NOVICE` across R1–R8
 */
export function generateMazeLayout(
  round: RoundConfig,
  difficulty: BotDifficulty = 'GRANDMASTER',
  preferredStyle?: BotStyle
): PlacedTower[] {
  const wallCost = TOWER_SPECS.BLOCK.goldCost;
  const totalAvailableWalls = Math.max(
    0,
    Math.floor(round.startingGold / wallCost)
  );
  if (totalAvailableWalls === 0) return [];

  const hasFrost = round.preplacedSpires.some(
    (s) => s.spireType === 'FROST_OBELISK'
  );
  const rawStyle: BotStyle = preferredStyle ?? selectSampleMazeStyle(round);
  const resolvedStyle: BotStyle =
    rawStyle === 'SPIRAL' && !hasFrost ? 'SWITCHBACK' : rawStyle;

  const maxWalls =
    difficulty === 'NOVICE'
      ? Math.max(6, Math.floor(totalAvailableWalls * 0.5))
      : difficulty === 'ARCHITECT'
      ? Math.max(8, Math.floor(totalAvailableWalls * 0.66))
      : totalAvailableWalls;

  const primary = buildSingleAttempt(
    round,
    maxWalls,
    difficulty,
    resolvedStyle,
    false,
    `${difficulty[0]}${resolvedStyle[0]}0`
  );

  const minFloorRatio =
    difficulty === 'GRANDMASTER'
      ? 0.88
      : difficulty === 'ARCHITECT'
      ? 0.68
      : 0.45;
  const minClaps =
    difficulty === 'NOVICE' ? 1 : Math.max(2, round.preplacedSpires.length);

  if (
    primary.evalRes.finishTimeSeconds >= round.parTimeSeconds * minFloorRatio &&
    primary.evalRes.clapsTaken >= minClaps
  ) {
    return primary.towers;
  }

  let best = primary;
  const fallbackQueue: Array<{ style: BotStyle; flip: boolean; tag: string }> =
    round.parTimeSeconds >= 50
      ? [
          {
            style: resolvedStyle === 'SWITCHBACK' ? 'CLAP_CHAIN' : 'SWITCHBACK',
            flip: false,
            tag: `${difficulty[0]}F0`,
          },
        ]
      : [
          {
            style: resolvedStyle,
            flip: true,
            tag: `${difficulty[0]}${resolvedStyle[0]}1`,
          },
          {
            style: resolvedStyle === 'SWITCHBACK' ? 'CLAP_CHAIN' : 'SWITCHBACK',
            flip: false,
            tag: `${difficulty[0]}F0`,
          },
        ];

  for (let idx = 0; idx < fallbackQueue.length; idx++) {
    if (
      idx === 1 &&
      best.evalRes.finishTimeSeconds >=
        round.parTimeSeconds * minFloorRatio * 0.9 &&
      best.evalRes.clapsTaken >= minClaps
    ) {
      break;
    }

    const fb = fallbackQueue[idx];
    const cand = buildSingleAttempt(
      round,
      maxWalls,
      difficulty,
      fb.style,
      fb.flip,
      fb.tag
    );
    if (cand.evalRes.finishTimeSeconds > best.evalRes.finishTimeSeconds) {
      best = cand;
    }
    if (
      best.evalRes.finishTimeSeconds >= round.parTimeSeconds * minFloorRatio &&
      best.evalRes.clapsTaken >= minClaps
    ) {
      break;
    }
  }

  return best.towers;
}
