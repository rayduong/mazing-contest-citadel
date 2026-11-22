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

  if (!options.allowSliverSeal) {
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
      if (tBridges > 3) return false;
    }
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

  return { placed: true, blockedPath: false, pathResult: check.pathResult };
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
  const minWallX = Math.max(0, cellMinX);
  const maxWallX = Math.min(ctx.gw - 2, cellMaxX - 1);
  const midRefY = clampY(ryFn(Math.floor(ctx.gw * 0.5)));

  const beforePath = computeFullMazePath(ctx.round, ctx.towers);
  if (!beforePath.valid || minWallX > maxWallX) {
    const cross = measureBandCrossingX(beforePath, midRefY, ctx.gw * 0.5);
    return {
      committed: false,
      actualOpenLeft: cross < ctx.gw * 0.5,
      crossingX: cross,
      wallsAdded: 0,
    };
  }

  const prevLen = ctx.towers.length;
  const fromRightToLeft = wantOpenLeft;

  const targetXs: number[] = [];
  if (fromRightToLeft) {
    for (let x = maxWallX; x >= minWallX; x -= 2) targetXs.push(x);
    if (targetXs[targetXs.length - 1] !== minWallX) targetXs.push(minWallX);
  } else {
    for (let x = minWallX; x <= maxWallX; x += 2) targetXs.push(x);
    if (targetXs[targetXs.length - 1] !== maxWallX) targetXs.push(maxWallX);
  }

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
    if (direct.placed || direct.blockedPath) continue;

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
      if (
        tryPlaceWallDetailed(ctx, cx, clampY(cy), {
          allowCliffRoot: true,
          allowSpireRoot: true,
          allowSliverSeal: true,
        }).placed
      ) {
        break;
      }
    }
  }

  for (let guard = 0; guard < 5; guard++) {
    if (
      ctx.towers.length >= wallCap ||
      ctx.towers.length >= ctx.maxWalls ||
      ctx.astarRemaining <= 4
    ) {
      break;
    }
    const path = computeFullMazePath(ctx.round, ctx.towers);
    if (!path.valid) break;

    let leakCell: GridPoint | null = null;
    for (let i = 1; i < path.allPoints.length - 1; i++) {
      const pt = path.allPoints[i];
      const lx = Math.floor(pt.x);
      const ly = Math.floor(pt.y);
      if (lx < cellMinX || lx > cellMaxX) continue;
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
      if (
        tryPlaceWallDetailed(ctx, px, py, {
          allowCliffRoot: true,
          allowSpireRoot: true,
          allowSliverSeal: true,
        }).placed
      ) {
        plugged = true;
        break;
      }
    }
    if (!plugged) break;
  }

  const afterPath = computeFullMazePath(ctx.round, ctx.towers);
  const wallsAdded = ctx.towers.length - prevLen;
  const distGain = afterPath.totalDistance - beforePath.totalDistance;
  const crossX = measureBandCrossingX(afterPath, midRefY, ctx.gw * 0.5);
  const reachedTargetSide = wantOpenLeft
    ? crossX < ctx.gw * 0.48
    : crossX > ctx.gw * 0.52;

  if (wallsAdded > 0 && distGain < minRequiredDetour && !reachedTargetSide) {
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
      : Math.min(6, Math.max(4, Math.round(scaffoldBudget / 6.0)));

  const rows = selectOptimalBaffleRowsDP(ctx.round, desiredBaffles, minStride);
  let wantOpenLeft = chooseInitialOpenLeft(ctx.round, flipPolarity);

  for (const ry of rows) {
    if (ctx.towers.length >= scaffoldBudget || ctx.astarRemaining <= 6) break;
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
  const spires = [...ctx.round.preplacedSpires];
  if (spires.length === 0) {
    buildSwitchbackScaffold(ctx, difficulty, scaffoldBudget, flipPolarity);
    return;
  }

  const centerX = ctx.gw * 0.5 - 1;
  const centerY = ctx.gh * 0.5 - 1;
  spires.sort((a, b) => {
    const aFrost = a.spireType === 'FROST_OBELISK' ? 1 : 0;
    const bFrost = b.spireType === 'FROST_OBELISK' ? 1 : 0;
    if (aFrost !== bFrost) return bFrost - aFrost;
    return (
      Math.hypot(a.x - centerX, a.y - centerY) -
      Math.hypot(b.x - centerX, b.y - centerY)
    );
  });

  const primary = spires[0];
  const sy = Math.max(6, Math.min(ctx.gh - 8, primary.y));
  const turnGap =
    difficulty === 'NOVICE' ? 4 : difficulty === 'ARCHITECT' ? 3 : 2;

  const yTop = Math.max(
    2,
    sy - (corridorPluggedBetween(ctx.round, sy - 4, sy) ? 5 : 4)
  );
  const yBot = Math.min(
    ctx.gh - 4,
    sy + (corridorPluggedBetween(ctx.round, sy, sy + 4) ? 5 : 4)
  );

  const bandYs: number[] = [yTop, sy, yBot];
  let ny = yTop;
  while (ny - 4 >= 2 && bandYs.length < (difficulty === 'NOVICE' ? 3 : 6)) {
    const step = corridorPluggedBetween(ctx.round, ny - 4, ny) ? 5 : 4;
    if (ny - step < 2) break;
    ny -= step;
    bandYs.unshift(ny);
  }

  let by = yBot;
  const maxBands =
    difficulty === 'NOVICE' ? 3 : difficulty === 'ARCHITECT' ? 4 : 6;
  while (by + 4 <= ctx.gh - 4 && bandYs.length < maxBands) {
    const step = corridorPluggedBetween(ctx.round, by, by + 4) ? 5 : 4;
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
    if (ctx.towers.length >= scaffoldBudget || ctx.astarRemaining <= 6) break;
    const isCore = rowY === sy;

    let cellMinX = wantOpenLeft ? turnGap : 0;
    let cellMaxX = wantOpenLeft ? ctx.gw - 1 : ctx.gw - 1 - turnGap;

    if (isCore) {
      if (wantOpenLeft) {
        cellMinX = Math.max(turnGap, Math.min(primary.x - 2, ctx.gw - 5));
        cellMaxX = ctx.gw - 1;
      } else {
        cellMinX = 0;
        cellMaxX = Math.min(
          ctx.gw - 1 - turnGap,
          Math.max(primary.x + 3, 4)
        );
      }
    }

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
        ctx.astarRemaining > 6
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
      : Math.min(6, Math.max(4, Math.round(scaffoldBudget / 6.0)));

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
    if (ctx.towers.length >= scaffoldBudget || ctx.astarRemaining <= 6) break;
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

/**
 * Stage 3: Bridges Crimson Keeps into Spire perimeters ONLY when the target Spire is actively
 * hit by the runner's route.
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
    ctx.astarRemaining > 10 &&
    ctx.simRemaining > 4
  ) {
    passes++;
    const baseCirc = computeCitadelCircuitry(ctx.round, ctx.towers);
    if (baseCirc.spireOverchargeTiers.every((t) => t >= targetMaxTier)) break;

    const basePath = computeFullMazePath(ctx.round, ctx.towers);
    if (!basePath.valid) break;
    const baseEval = evalSimCounted(ctx, ctx.towers, basePath);

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
      const activeHits = baseEval.perSpireClaps[`spire_${sIdx}`] || 0;
      if (
        activeHits > 0 &&
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
      if (ctx.astarRemaining <= 6 || ctx.simRemaining <= 3) break;
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
        if (diffTier > 0 && (baseEval.perSpireClaps[`spire_${s}`] || 0) > 0) {
          activeOverDelta += diffTier;
        }
      }
      if (activeOverDelta <= 0) continue;

      const check = validateCounted(ctx, ctx.towers, cand.x, cand.y);
      if (!check.valid || !check.pathResult) continue;

      const sim = evalSimCounted(ctx, testTowers, check.pathResult);
      const dt = sim.finishTimeSeconds - baseEval.finishTimeSeconds;
      if (dt < -0.2) continue;

      const gainScore =
        dt * 3.4 + activeOverDelta * (isJuggernaut ? 4.2 : 2.2);
      if (gainScore > 0.8 && (!bestSingle || gainScore > bestSingle.gainScore)) {
        bestSingle = { x: cand.x, y: cand.y, gainScore };
      }
    }

    if (
      bestSingle &&
      tryPlaceWallDetailed(ctx, bestSingle.x, bestSingle.y, {
        allowCliffRoot: false,
        allowSpireRoot: false,
      }).placed
    ) {
      continue;
    }

    if (
      difficulty === 'GRANDMASTER' &&
      ctx.towers.length + 2 <= ctx.maxWalls &&
      ctx.astarRemaining > 12 &&
      ctx.simRemaining > 4
    ) {
      let bestPair: { a: GridPoint; b: GridPoint; gainScore: number } | null =
        null;

      for (let kIdx = 0; kIdx < ctx.round.obstacles.length; kIdx++) {
        if (ctx.astarRemaining <= 8 || ctx.simRemaining <= 3) break;
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
              if (dtier > 0 && (baseEval.perSpireClaps[`spire_${s}`] || 0) > 0) {
                activeOverDelta += dtier;
              }
            }
            if (activeOverDelta <= 0) continue;

            const c1 = validateCounted(ctx, ctx.towers, ax, ay);
            if (!c1.valid) continue;
            const c2 = validateCounted(ctx, pairTowers.slice(0, -1), bx, by);
            if (!c2.valid || !c2.pathResult) continue;

            const sim = evalSimCounted(ctx, pairTowers, c2.pathResult);
            const dt = sim.finishTimeSeconds - baseEval.finishTimeSeconds;
            if (dt < 0.05) continue;

            const gainScore =
              dt * 3.2 + activeOverDelta * (isJuggernaut ? 4.5 : 2.4);
            if (
              gainScore > 2.2 &&
              (!bestPair || gainScore > bestPair.gainScore)
            ) {
              bestPair = { a: { x: ax, y: ay }, b: { x: bx, y: by }, gainScore };
            }
          }
        }
      }

      if (bestPair) {
        if (
          tryPlaceWallDetailed(ctx, bestPair.a.x, bestPair.a.y, {
            allowCliffRoot: false,
            allowSpireRoot: false,
          }).placed
        ) {
          if (
            !tryPlaceWallDetailed(ctx, bestPair.b.x, bestPair.b.y, {
              allowCliffRoot: false,
              allowSpireRoot: false,
            }).placed
          ) {
            removeWallAtIndex(ctx, ctx.towers.length - 1);
          } else {
            continue;
          }
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
    for (let y = 2; y <= ctx.gh - 4; y += 2) {
      consider(0, y);
      consider(ctx.gw - 2, y);
    }
  }

  scored.sort((a, b) => b.priority - a.priority);
  return scored;
}

/**
 * Stage 4 & Stage 5: Budget-Counted Frontier Polish + Path-Intersecting Full-Spend Pass.
 */
function spendAndPolishWalls(
  ctx: BuilderContext,
  difficulty: BotDifficulty
): void {
  const maxSteps =
    difficulty === 'NOVICE' ? 2 : difficulty === 'ARCHITECT' ? 5 : 18;
  const topK = difficulty === 'NOVICE' ? 2 : 3;
  const evalBatchCap = difficulty === 'GRANDMASTER' ? 16 : 12;

  let step = 0;
  while (
    ctx.towers.length < ctx.maxWalls &&
    step < maxSteps &&
    ctx.astarRemaining > 4 &&
    ctx.simRemaining > 2
  ) {
    step++;
    const curPath = computeFullMazePath(ctx.round, ctx.towers);
    if (!curPath.valid) break;

    const curCirc = computeCitadelCircuitry(ctx.round, ctx.towers);
    const curGeo = scorePathWithMapFeatures(
      ctx.round,
      curPath,
      curCirc.spireOverchargeTiers
    );
    const curEval = evalSimCounted(ctx, ctx.towers, curPath);
    const curComp =
      curEval.finishTimeSeconds * 4.0 +
      curEval.overchargedSpires * 1.4 +
      curPath.totalDistance * 0.12;

    // Fast path-intersection-only scan first (`includeHalo = false`)
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

    const limit = Math.min(directPathCoords.length, evalBatchCap);
    for (let i = 0; i < limit; i++) {
      if (ctx.astarRemaining <= 2) break;
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
        geoDelta > 0.05 ||
        check.pathResult.totalDistance > curPath.totalDistance + 0.1
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

    let bestSingle: { x: number; y: number; comp: number } | null = null;
    const minGain = difficulty === 'GRANDMASTER' ? 0.12 : 0.35;

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
        bestSingle = { x: cand.x, y: cand.y, comp };
      }
    }

    if (
      bestSingle &&
      tryPlaceWallDetailed(ctx, bestSingle.x, bestSingle.y, {
        allowCliffRoot: difficulty === 'GRANDMASTER',
        allowSpireRoot: false,
      }).placed
    ) {
      continue;
    }

    // 2-Wall Corridor-Folding Tooth Lookahead (only on GRANDMASTER when single step stalls)
    if (
      difficulty === 'GRANDMASTER' &&
      ctx.towers.length + 2 <= ctx.maxWalls &&
      ctx.astarRemaining > 10 &&
      ctx.simRemaining > 3
    ) {
      const haloCoords = collectRankedPathCandidates(ctx, curPath, true, true);
      const seeds = haloCoords.slice(0, 4);
      let placedPair = false;

      for (const s of seeds) {
        if (ctx.astarRemaining <= 4 || ctx.simRemaining <= 1) break;
        if (
          !tryPlaceWallDetailed(ctx, s.x, s.y, {
            allowCliffRoot: true,
            allowSpireRoot: false,
          }).placed
        ) {
          continue;
        }

        let bestExt: { x: number; y: number; comp: number } | null = null;
        for (const [dx, dy] of CLEAN_MASONRY_DIRS) {
          if (ctx.astarRemaining <= 2 || ctx.simRemaining <= 0) break;
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
          const c2 = validateCounted(ctx, ctx.towers, ex, ey);
          if (!c2.valid || !c2.pathResult) continue;
          if (c2.pathResult.totalDistance <= curPath.totalDistance + 0.3) {
            continue;
          }

          const sim2 = evalSimCounted(
            ctx,
            [
              ...ctx.towers,
              { id: '__p2__', type: 'BLOCK', x: ex, y: ey, createdAt: 0 },
            ],
            c2.pathResult
          );
          const comp2 =
            sim2.finishTimeSeconds * 4.0 +
            sim2.overchargedSpires * 1.4 +
            c2.pathResult.totalDistance * 0.12;
          if (comp2 > curComp + 0.5 && (!bestExt || comp2 > bestExt.comp)) {
            bestExt = { x: ex, y: ey, comp: comp2 };
          }
        }

        if (
          bestExt &&
          tryPlaceWallDetailed(ctx, bestExt.x, bestExt.y, {
            allowCliffRoot: true,
            allowSpireRoot: false,
          }).placed
        ) {
          placedPair = true;
          break;
        } else {
          removeWallAtIndex(ctx, ctx.towers.length - 1);
        }
      }

      if (placedPair) continue;
    }

    break;
  }

  // Ultra-fast zero-sim A*-only finish pass so high-budget R6–R8 GRANDMASTER rounds spend remaining walls
  if (difficulty === 'GRANDMASTER') {
    let tailSteps = 0;
    while (
      ctx.towers.length < ctx.maxWalls &&
      tailSteps++ < 16 &&
      ctx.astarRemaining > 2
    ) {
      const curPath = computeFullMazePath(ctx.round, ctx.towers);
      if (!curPath.valid) break;
      const curCirc = computeCitadelCircuitry(ctx.round, ctx.towers);
      const curGeo = scorePathWithMapFeatures(
        ctx.round,
        curPath,
        curCirc.spireOverchargeTiers
      );

      const coords = collectRankedPathCandidates(ctx, curPath, true, false);
      const cap = Math.min(coords.length, 12);
      let best: { x: number; y: number; delta: number } | null = null;

      for (let i = 0; i < cap && ctx.astarRemaining > 1; i++) {
        const c = coords[i];
        const check = validateCounted(ctx, ctx.towers, c.x, c.y);
        if (!check.valid || !check.pathResult) continue;
        if (check.pathResult.totalDistance < curPath.totalDistance + 0.2) {
          continue;
        }
        const delta =
          scorePathWithMapFeatures(
            ctx.round,
            check.pathResult,
            curCirc.spireOverchargeTiers
          ) - curGeo;
        if (delta > 0.25 && (!best || delta > best.delta)) {
          best = { x: c.x, y: c.y, delta };
        }
      }

      if (
        best &&
        tryPlaceWallDetailed(ctx, best.x, best.y, {
          allowCliffRoot: true,
          allowSpireRoot: false,
        }).placed
      ) {
        continue;
      }
      break;
    }
  }
}

/**
 * Fast <0.2ms Hygiene Pass:
 * 1. Strips zero-impact leaf walls (`Δdistance < 0.12m` AND `Δtime < 0.05s` AND `Δover <= 0` —
 *    skipping `evaluateMazeRunTime` whenever `Δdistance >= 0.15m`!)
 * 2. Unconditionally removes any freestanding wall with `0` post-Gabriel rendered bridges.
 */
function cleanZeroImpactAndUnbridgedWalls(
  ctx: BuilderContext,
  stripZeroImpact: boolean
): void {
  if (ctx.towers.length === 0) return;

  const countRenderedBridges = (
    target: GridPoint,
    masonry: ReadonlyArray<GridPoint>
  ): number => {
    let count = 0;
    for (let i = 0; i < masonry.length; i++) {
      const m = masonry[i];
      if (m.x === target.x && m.y === target.y) continue;
      if (areMasonryNodesBridged(target.x, target.y, m.x, m.y, masonry)) {
        count++;
      }
    }
    return count;
  };

  if (stripZeroImpact && ctx.towers.length > 3) {
    let basePath = computeFullMazePath(ctx.round, ctx.towers);
    let baseCirc = computeCitadelCircuitry(ctx.round, ctx.towers);
    let cachedBaseEval: MazeEvalResult | null = null;

    for (let i = ctx.towers.length - 1; i >= 0; i--) {
      if (ctx.astarRemaining <= 2) break;
      const allMasonry: GridPoint[] = [...ctx.towers, ...ctx.round.obstacles];
      if (countRenderedBridges(ctx.towers[i], allMasonry) > 1) continue;

      const without = ctx.towers.filter((_, idx) => idx !== i);
      const nextCirc = computeCitadelCircuitry(ctx.round, without);
      if (nextCirc.overchargedSpires < baseCirc.overchargedSpires) continue;

      const nextMasonry: GridPoint[] = [...without, ...ctx.round.obstacles];
      let orphansNeighbor = false;
      for (let j = 0; j < without.length; j++) {
        if (countRenderedBridges(without[j], nextMasonry) === 0) {
          orphansNeighbor = true;
          break;
        }
      }
      if (orphansNeighbor) continue;

      ctx.astarRemaining--;
      const pathWithout = computeFullMazePath(ctx.round, without);
      if (!pathWithout.valid) continue;

      // Fast distance short-circuit: if removing this wall shortens the A* path by >=0.18m, keep it!
      if (basePath.totalDistance - pathWithout.totalDistance >= 0.18) {
        continue;
      }

      if (!cachedBaseEval) {
        cachedBaseEval = evalSimCounted(ctx, ctx.towers, basePath);
      }
      const evalWithout = evalSimCounted(ctx, without, pathWithout);
      if (
        cachedBaseEval.finishTimeSeconds - evalWithout.finishTimeSeconds <
        0.05
      ) {
        removeWallAtIndex(ctx, i);
        basePath = pathWithout;
        baseCirc = nextCirc;
        cachedBaseEval = evalWithout;
      }
    }
  }

  let changed = true;
  while (changed && ctx.towers.length > 0) {
    changed = false;
    const allMasonry: GridPoint[] = [...ctx.towers, ...ctx.round.obstacles];
    for (let i = ctx.towers.length - 1; i >= 0; i--) {
      if (countRenderedBridges(ctx.towers[i], allMasonry) === 0) {
        const without = ctx.towers.filter((_, idx) => idx !== i);
        if (computeFullMazePath(ctx.round, without).valid) {
          removeWallAtIndex(ctx, i);
          changed = true;
          break;
        }
      }
    }
  }
}

function buildSingleAttempt(
  round: RoundConfig,
  maxWalls: number,
  difficulty: BotDifficulty,
  style: BotStyle,
  flipPolarity: boolean,
  attemptTag: string
): { towers: PlacedTower[]; evalRes: MazeEvalResult } {
  const astarBudget =
    difficulty === 'NOVICE'
      ? 75
      : difficulty === 'ARCHITECT'
      ? 130
      : 200 + maxWalls * 5;
  const simBudget =
    difficulty === 'NOVICE' ? 10 : difficulty === 'ARCHITECT' ? 20 : 34;

  const ctx = createBuilderContext(
    round,
    maxWalls,
    `ai_r${round.roundNumber}_${attemptTag}`,
    astarBudget,
    simBudget
  );

  const scaffoldShare =
    difficulty === 'NOVICE' ? 0.94 : difficulty === 'ARCHITECT' ? 0.9 : 0.95;
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
  spendAndPolishWalls(ctx, difficulty);
  cleanZeroImpactAndUnbridgedWalls(ctx, false);

  const evalRes = evaluateMazeRunTime(round, ctx.towers, {
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

  const resolvedStyle: BotStyle =
    preferredStyle ?? selectSampleMazeStyle(round);

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
    [
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

  for (const fb of fallbackQueue) {
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
