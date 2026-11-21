import {
  computeCitadelCircuitry,
  computeFullMazePath,
  do2x2Overlap,
  validateTowerPlacement,
} from './pathfinding.js';
import { evaluateMazeRunTime, OVERCHARGE_CDR } from './simulation.js';
import {
  GridPoint,
  PathResult,
  PlacedTower,
  RoundConfig,
  RUNNER_ARCHETYPES,
  SpirePoint,
  SpireType,
  TOWER_SPECS,
} from './types.js';

export type BotDifficulty = 'NOVICE' | 'ARCHITECT' | 'GRANDMASTER';
export type BotStyle = 'SWITCHBACK' | 'SPIRAL' | 'CLAP_CHAIN';

const nowMs = (): number =>
  typeof performance !== 'undefined' ? performance.now() : Date.now();

function isInside2x2(px: number, py: number, pad: GridPoint): boolean {
  return px >= pad.x && px <= pad.x + 2.0 && py >= pad.y && py <= pad.y + 2.0;
}

/**
 * Evaluates a candidate path with full map-feature awareness:
 * - Spire Overcharge effective range (+0.25m/tier) & cooldown reduction (12%/22%/30%)
 * - Cooldown-spaced burst triggers (Storm, Frost, Chrono) vs continuous Frost Permafrost dwell
 * - Chrono Spire 1.2s global cooldown shave when triggered after sibling Spires
 * - Runner traits: Juggernaut 20% slow resist (pierced by >=1 Overcharge), Outrider +25% slow duration,
 *   and Wind Herald +28% Tailwind Haste after 3.2s un-slowed outside Spire rings
 * - Optional Frost Mires (+), Haste Rifts (-), Checkpoints, and Waygate shortcuts
 */
export function scorePathWithMapFeatures(
  round: RoundConfig,
  path: PathResult,
  spireOverchargeTiers?: number[]
): number {
  if (!path.valid || path.allPoints.length < 2) return 0;

  const runnerSpec = RUNNER_ARCHETYPES[round.runnerType || 'SCOUT'];
  const baseSpeed = runnerSpec.baseSpeed;
  const spires = round.preplacedSpires;
  const spireCount = spires.length;

  const effRanges = new Float64Array(spireCount);
  const minRetriggerMeters = new Float64Array(spireCount);
  const nextReadyDist = new Float64Array(spireCount);
  const spireTypes: SpireType[] = new Array(spireCount);
  const tiers = new Int32Array(spireCount);

  for (let s = 0; s < spireCount; s++) {
    const sType: SpireType = spires[s].spireType || 'THUNDERCLAP';
    const spec = TOWER_SPECS[sType];
    const tier = Math.max(0, Math.min(3, spireOverchargeTiers?.[s] || 0));
    const effRange = spec.range + tier * 0.25;
    const effCd = spec.cooldown * (1 - OVERCHARGE_CDR[tier]);

    spireTypes[s] = sType;
    tiers[s] = tier;
    effRanges[s] = effRange;
    minRetriggerMeters[s] = Math.max(4.4, baseSpeed * 0.62 * effCd);
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
      const sType = spireTypes[s];
      const spec = TOWER_SPECS[sType];
      const resist = tier > 0 ? 0.0 : runnerSpec.slowResist;

      if (sType === 'FROST_OBELISK') {
        const auraPct =
          ((spec.auraSlowPercent || 0.22) + tier * 0.02) * (1 - resist);
        score += segLen * auraPct * 2.1;
      }

      if (cumDist >= nextReadyDist[s]) {
        nextReadyDist[s] = cumDist + minRetriggerMeters[s];
        const effSlow = spec.slowPercent * (1 - resist);
        const effDur =
          (spec.slowDuration + tier * 0.25) * runnerSpec.slowDurationMult;
        let burstValue = effSlow * effDur * baseSpeed * 1.15;
        if (tier > 0 && runnerSpec.slowResist > 0) {
          burstValue += 1.4;
        }

        if (spec.cdrPulseSeconds && spec.cdrPulseSeconds > 0) {
          const shaveMeters = baseSpeed * 0.65 * spec.cdrPulseSeconds;
          for (let other = 0; other < spireCount; other++) {
            if (other !== s && nextReadyDist[other] > cumDist + 0.5) {
              const before = nextReadyDist[other];
              nextReadyDist[other] = Math.max(cumDist, before - shaveMeters);
              burstValue += (before - nextReadyDist[other]) * 0.65;
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
          score -= segLen * 0.48;
        }
      }
    }
  }

  return score;
}

interface BuilderContext {
  round: RoundConfig;
  gw: number;
  gh: number;
  maxWalls: number;
  towers: PlacedTower[];
  occupied: Uint8Array;
  idSeq: number;
  stamp: number;
}

function createBuilderContext(
  round: RoundConfig,
  maxWalls: number
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
    idSeq: 1,
    stamp: Date.now(),
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
 * Enforces clean, readable masonry:
 * - Strictly caps total touching neighbor degree (Walls + Keeps + Spires <= 3) so no 4-way clumps form
 * - Rejects 2x2 solid pillar quads and tight triangles (`pairTouches >= 2` when `deg >= 3`)
 * - Ensures adding `(x, y)` does not push any existing player wall above degree 3
 */
function passesMasonryRules(
  ctx: BuilderContext,
  x: number,
  y: number,
  options: {
    allowCliffRoot?: boolean;
    allowSpireRoot?: boolean;
  } = {}
): boolean {
  const wallKeepNeighbors: GridPoint[] = [];
  let spireTouches = 0;

  for (let i = 0; i < ctx.towers.length; i++) {
    const t = ctx.towers[i];
    if (Math.abs(t.x - x) <= 2 && Math.abs(t.y - y) <= 2) {
      wallKeepNeighbors.push(t);
    }
  }
  for (let i = 0; i < ctx.round.obstacles.length; i++) {
    const o = ctx.round.obstacles[i];
    if (Math.abs(o.x - x) <= 2 && Math.abs(o.y - y) <= 2) {
      wallKeepNeighbors.push(o);
    }
  }
  for (let i = 0; i < ctx.round.preplacedSpires.length; i++) {
    const s = ctx.round.preplacedSpires[i];
    if (Math.abs(s.x - x) <= 2 && Math.abs(s.y - y) <= 2) {
      spireTouches++;
    }
  }

  const totalDeg = wallKeepNeighbors.length + spireTouches;
  if (totalDeg > 3) return false;

  if (wallKeepNeighbors.length >= 2) {
    let pairTouches = 0;
    for (let i = 0; i < wallKeepNeighbors.length; i++) {
      for (let j = i + 1; j < wallKeepNeighbors.length; j++) {
        if (
          Math.abs(wallKeepNeighbors[i].x - wallKeepNeighbors[j].x) <= 2 &&
          Math.abs(wallKeepNeighbors[i].y - wallKeepNeighbors[j].y) <= 2
        ) {
          pairTouches++;
        }
      }
    }
    if (pairTouches >= 2) return false;
  }

  // Prevent pushing any existing player tower to degree >= 4
  for (let i = 0; i < ctx.towers.length; i++) {
    const t = ctx.towers[i];
    if (Math.abs(t.x - x) > 2 || Math.abs(t.y - y) > 2) continue;

    let tDeg = 1; // includes candidate (x, y)
    for (let j = 0; j < ctx.towers.length; j++) {
      if (
        i !== j &&
        Math.abs(ctx.towers[j].x - t.x) <= 2 &&
        Math.abs(ctx.towers[j].y - t.y) <= 2
      ) {
        tDeg++;
      }
    }
    for (let k = 0; k < ctx.round.obstacles.length; k++) {
      const o = ctx.round.obstacles[k];
      if (Math.abs(o.x - t.x) <= 2 && Math.abs(o.y - t.y) <= 2) tDeg++;
    }
    for (let s = 0; s < ctx.round.preplacedSpires.length; s++) {
      const sp = ctx.round.preplacedSpires[s];
      if (Math.abs(sp.x - t.x) <= 2 && Math.abs(sp.y - t.y) <= 2) tDeg++;
    }
    if (tDeg > 3) return false;
  }

  if (wallKeepNeighbors.length > 0) return true;

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

function tryPlaceWallDetailed(
  ctx: BuilderContext,
  x: number,
  y: number,
  masonryOpts: {
    allowCliffRoot?: boolean;
    allowSpireRoot?: boolean;
  } = { allowCliffRoot: true, allowSpireRoot: true }
): TryPlaceOutcome {
  if (ctx.towers.length >= ctx.maxWalls) {
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

  const check = validateTowerPlacement(ctx.round, ctx.towers, x, y);
  if (!check.valid || !check.pathResult) {
    return {
      placed: false,
      blockedPath: check.reasonCode === 'BLOCKS_PATH',
    };
  }

  ctx.towers.push({
    id: `ai_${ctx.idSeq++}_${ctx.stamp}`,
    type: 'BLOCK',
    x,
    y,
    createdAt: ctx.stamp,
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

/**
 * Seals a horizontal masonry baffle across `[cellMinX .. cellMaxX]` around `ryFn(x)`.
 * Stops immediately if a placement triggers `BLOCKS_PATH` (preventing wasted walls in a
 * sealed dead-end pocket) and closes any remaining 1-tile Keep/Spire collar leak.
 */
function buildSealedBaffle(
  ctx: BuilderContext,
  cellMinX: number,
  cellMaxX: number,
  fromRightToLeft: boolean,
  ryFn: (x: number) => number,
  wallCap: number
): void {
  const clampY = (y: number) => Math.max(2, Math.min(ctx.gh - 4, y));

  const targetXs: number[] = [];
  if (fromRightToLeft) {
    for (let x = cellMaxX - 1; x >= cellMinX; x -= 2) {
      targetXs.push(x);
    }
    if (targetXs.length === 0 || targetXs[targetXs.length - 1] !== cellMinX) {
      targetXs.push(cellMinX);
    }
  } else {
    for (let x = cellMinX; x <= cellMaxX - 1; x += 2) {
      targetXs.push(x);
    }
    if (
      targetXs.length === 0 ||
      targetXs[targetXs.length - 1] !== cellMaxX - 1
    ) {
      targetXs.push(Math.max(0, cellMaxX - 1));
    }
  }

  for (const bx of targetXs) {
    if (ctx.towers.length >= wallCap || ctx.towers.length >= ctx.maxWalls) {
      return;
    }
    const by = clampY(ryFn(bx));

    const r0 = by * ctx.gw + bx;
    const r1 = r0 + ctx.gw;
    if (
      bx >= 0 &&
      bx + 1 < ctx.gw &&
      (ctx.occupied[r0] || ctx.occupied[r1]) &&
      (ctx.occupied[r0 + 1] || ctx.occupied[r1 + 1])
    ) {
      continue;
    }

    const direct = tryPlaceWallDetailed(ctx, bx, by, {
      allowCliffRoot: true,
      allowSpireRoot: true,
    });
    if (direct.placed) continue;

    // If placing at (bx, by) pinches the sole remaining path, stop extending into the dead-end pocket
    if (direct.blockedPath) return;

    const dir = fromRightToLeft ? -1 : 1;
    const collarOffsets: Array<[number, number]> = [
      [bx + dir, by],
      [bx - dir, by],
      [bx, by + 1],
      [bx, by - 1],
    ];
    let hitBlock = false;
    for (const [cx, cy] of collarOffsets) {
      if (cx < Math.max(0, cellMinX - 1) || cx + 1 > Math.min(ctx.gw - 1, cellMaxX + 1)) {
        continue;
      }
      const res = tryPlaceWallDetailed(ctx, cx, clampY(cy), {
        allowCliffRoot: true,
        allowSpireRoot: true,
      });
      if (res.placed) break;
      if (res.blockedPath) {
        hitBlock = true;
        break;
      }
    }
    if (hitBlock) return;
  }

  // Plug any remaining 1-tile vertical leak across [cellMinX .. cellMaxX]
  for (let guard = 0; guard < 4; guard++) {
    if (ctx.towers.length >= wallCap || ctx.towers.length >= ctx.maxWalls) break;
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

    const leakBandY = clampY(ryFn(Math.min(ctx.gw - 2, Math.max(0, leakCell.x))));
    const plugs: Array<[number, number]> = [
      [leakCell.x, leakCell.y],
      [leakCell.x - 1, leakCell.y],
      [leakCell.x, leakCell.y - 1],
      [leakCell.x - 1, leakCell.y - 1],
      // Cap 1-tile slivers sandwiched between a Spire/Keep and an adjacent Stone Wall
      [leakCell.x - 1, clampY(leakBandY + 2)],
      [leakCell.x, clampY(leakBandY + 2)],
      [leakCell.x - 1, clampY(leakBandY - 2)],
      [leakCell.x, clampY(leakBandY - 2)],
    ];
    let plugged = false;
    for (const [px, py] of plugs) {
      if (px < Math.max(0, cellMinX - 1) || px + 1 > Math.min(ctx.gw - 1, cellMaxX + 1)) {
        continue;
      }
      if (
        tryPlaceWallDetailed(ctx, px, py, {
          allowCliffRoot: true,
          allowSpireRoot: true,
        }).placed
      ) {
        plugged = true;
        break;
      }
    }
    if (!plugged) break;
  }
}

/**
 * Checks whether a 2-cell horizontal corridor `[yUpper + 2 .. yLower - 1]` between two
 * adjacent baffles would be completely plugged vertically by a 2x2 Spire or Keep.
 */
function corridorPluggedBetween(
  round: RoundConfig,
  yUpper: number,
  yLower: number
): boolean {
  const gapHeight = yLower - (yUpper + 2);
  if (gapHeight <= 0) return true;
  if (gapHeight >= 3) return false;

  // For a 2-tile tall corridor [corridorY, corridorY + 1], any 2x2 block at sy === corridorY plugs it
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
 * Selects optimal Y rows spaced >= minStride apart that pass THROUGH Spires & Keeps
 * (using them as free wall anchors & double-pass wraps) while never leaving a 2-cell
 * corridor plugged by an interior 2x2 Spire/Keep.
 */
function selectAlignedSwitchbackRows(
  round: RoundConfig,
  desiredCount: number,
  minStride: number
): number[] {
  const minY = 2;
  const maxY = round.gridHeight - 4;
  const rowScores = new Float64Array(round.gridHeight);

  for (let y = minY; y <= maxY; y++) {
    let s = 1.0;
    for (const sp of round.preplacedSpires) {
      const dy = Math.abs(sp.y - y);
      if (dy === 0) s += 7.0;
      else if (dy === 1) s += 4.2;
    }
    for (const kp of round.obstacles) {
      const dy = Math.abs(kp.y - y);
      if (dy <= 1) s += 2.6;
    }
    rowScores[y] = s;
  }

  const chosen: number[] = [];
  const span = maxY - minY + 1;

  for (let i = 0; i < desiredCount; i++) {
    const zoneCenter = minY + ((i + 0.5) * span) / desiredCount;
    let bestY = -1;
    let bestVal = -Infinity;

    for (let y = minY; y <= maxY; y++) {
      let validSpacing = true;
      for (const cy of chosen) {
        if (Math.abs(cy - y) < minStride) {
          validSpacing = false;
          break;
        }
        const yUp = Math.min(cy, y);
        const yLo = Math.max(cy, y);
        if (yLo - yUp === 4 && corridorPluggedBetween(round, yUp, yLo)) {
          validSpacing = false;
          break;
        }
      }
      if (!validSpacing) continue;

      const val = rowScores[y] - Math.abs(y - zoneCenter) * 0.48;
      if (val > bestVal) {
        bestVal = val;
        bestY = y;
      }
    }

    if (bestY !== -1) {
      chosen.push(bestY);
      chosen.sort((a, b) => a - b);
    }
  }

  return chosen;
}

/**
 * Style 1: SWITCHBACK — Spire-aligned boustrophedon bastion walls with strict alternating turns.
 */
function buildSwitchbackScaffold(
  ctx: BuilderContext,
  difficulty: BotDifficulty,
  scaffoldBudget: number
): void {
  const turnGap =
    difficulty === 'NOVICE' ? 4 : difficulty === 'ARCHITECT' ? 3 : 2;
  const minStride = difficulty === 'NOVICE' ? 5 : 4;
  const maxBaffles =
    difficulty === 'NOVICE'
      ? Math.min(3, Math.max(2, Math.floor(scaffoldBudget / 6)))
      : difficulty === 'ARCHITECT'
      ? Math.min(4, Math.max(3, Math.floor(scaffoldBudget / 6.2)))
      : Math.min(6, Math.max(4, Math.floor(scaffoldBudget / 6.2)));

  const rows = selectAlignedSwitchbackRows(ctx.round, maxBaffles, minStride);

  let openLeft =
    ctx.round.spawn.x > ctx.gw * 0.5
      ? true
      : ctx.round.spawn.x < ctx.gw * 0.5 - 2
      ? false
      : (ctx.round.preplacedSpires[0]?.x ?? 9) < 9;

  for (const ry of rows) {
    if (ctx.towers.length >= scaffoldBudget) break;
    if (openLeft) {
      buildSealedBaffle(
        ctx,
        turnGap,
        ctx.gw - 1,
        true,
        () => ry,
        scaffoldBudget
      );
    } else {
      buildSealedBaffle(
        ctx,
        0,
        ctx.gw - 1 - turnGap,
        false,
        () => ry,
        scaffoldBudget
      );
    }
    openLeft = !openLeft;
  }
}

/**
 * Style 2: SPIRAL — Frost-Obelisk hairpin & S-spiral builder.
 * Orders all radial core arms and framing shell arms strictly top-to-bottom with guaranteed
 * alternating Left/Right openings so runners wrap 270°+ around Frost Obelisks without cliff chutes.
 */
function buildSpiralScaffold(
  ctx: BuilderContext,
  difficulty: BotDifficulty,
  scaffoldBudget: number
): void {
  const spires = [...ctx.round.preplacedSpires];
  if (spires.length === 0) {
    buildSwitchbackScaffold(ctx, difficulty, scaffoldBudget);
    return;
  }

  spires.sort((a, b) => {
    const aFrost = a.spireType === 'FROST_OBELISK' ? 1 : 0;
    const bFrost = b.spireType === 'FROST_OBELISK' ? 1 : 0;
    if (aFrost !== bFrost) return bFrost - aFrost;
    return Math.hypot(a.x - 9, a.y - 12) - Math.hypot(b.x - 9, b.y - 12);
  });

  const primary = spires[0];
  const sy = Math.max(6, Math.min(ctx.gh - 8, primary.y));
  const sx = primary.x;
  const turnGap =
    difficulty === 'NOVICE' ? 4 : difficulty === 'ARCHITECT' ? 3 : 2;

  // Radial arm connects primary Spire to its nearer cliff; open side wraps around the Spire!
  const coreAnchorLeft = sx <= ctx.gw / 2 - 1;
  const coreOpenLeft = !coreAnchorLeft;

  interface SpiralBand {
    y: number;
    openLeft: boolean;
    isCoreRadial?: boolean;
    coreSpire?: SpirePoint;
  }

  // Construct the 3-band Spiral Core Shell:
  // [sy - 4: opposite opening] -> [sy: radial Spire splitter] -> [sy + 4: opposite opening]
  const yTop = Math.max(2, sy - (corridorPluggedBetween(ctx.round, sy - 4, sy) ? 5 : 4));
  const yBot = Math.min(
    ctx.gh - 4,
    sy + (corridorPluggedBetween(ctx.round, sy, sy + 4) ? 5 : 4)
  );

  const bands: SpiralBand[] = [
    { y: yTop, openLeft: !coreOpenLeft },
    { y: sy, openLeft: coreOpenLeft, isCoreRadial: true, coreSpire: primary },
    { y: yBot, openLeft: !coreOpenLeft },
  ];

  // Prepend North framing bands (strictly alternating upward from yTop)
  let curY = yTop;
  let curOpen = !coreOpenLeft;
  while (curY - 4 >= 2 && bands.length < (difficulty === 'NOVICE' ? 3 : 5)) {
    const step = corridorPluggedBetween(ctx.round, curY - 4, curY) ? 5 : 4;
    if (curY - step < 2) break;
    curY -= step;
    curOpen = !curOpen;
    bands.unshift({ y: curY, openLeft: curOpen });
  }

  // Append South framing / second-Spire bands (strictly alternating downward from yBot)
  curY = yBot;
  curOpen = !coreOpenLeft;
  const maxTotalBands =
    difficulty === 'NOVICE' ? 3 : difficulty === 'ARCHITECT' ? 4 : 6;
  while (curY + 4 <= ctx.gh - 4 && bands.length < maxTotalBands) {
    const step = corridorPluggedBetween(ctx.round, curY, curY + 4) ? 5 : 4;
    if (curY + step > ctx.gh - 4) break;
    curY += step;
    curOpen = !curOpen;
    bands.push({ y: curY, openLeft: curOpen });
  }

  for (const band of bands) {
    if (ctx.towers.length >= scaffoldBudget) break;

    if (band.isCoreRadial && band.coreSpire) {
      const sp = band.coreSpire;
      // Seal from anchor cliff into the Spire AND extend 1–2 walls past the Spire to tighten the wrap
      if (band.openLeft) {
        // Anchor is on Right (East) cliff -> seal from East inward past Spire to max(turnGap, sp.x - 2)
        const minX = Math.max(turnGap, sp.x - 2);
        buildSealedBaffle(ctx, minX, ctx.gw - 1, true, () => band.y, scaffoldBudget);
      } else {
        // Anchor is on Left (West) cliff -> seal from West inward past Spire to min(gw - 1 - turnGap, sp.x + 3)
        const maxX = Math.min(ctx.gw - 1 - turnGap, sp.x + 3);
        buildSealedBaffle(ctx, 0, maxX, false, () => band.y, scaffoldBudget);
      }

      // Place vertical spiral side-riser on the Spire's open flank to form a visible 270° spiral box
      if (difficulty !== 'NOVICE' && ctx.towers.length < scaffoldBudget) {
        const flankX = band.openLeft ? sp.x - 4 : sp.x + 4;
        if (flankX >= 1 && flankX <= ctx.gw - 3) {
          tryPlaceWallDetailed(ctx, flankX, band.y - 2, {
            allowSpireRoot: true,
            allowCliffRoot: true,
          });
          if (difficulty === 'GRANDMASTER' && ctx.towers.length < scaffoldBudget) {
            tryPlaceWallDetailed(ctx, flankX, band.y + 2, {
              allowSpireRoot: true,
              allowCliffRoot: true,
            });
          }
        }
      }
    } else {
      if (band.openLeft) {
        buildSealedBaffle(
          ctx,
          turnGap,
          ctx.gw - 1,
          true,
          () => band.y,
          scaffoldBudget
        );
      } else {
        buildSealedBaffle(
          ctx,
          0,
          ctx.gw - 1 - turnGap,
          false,
          () => band.y,
          scaffoldBudget
        );
      }
    }
  }
}

/**
 * Style 3: CLAP_CHAIN — Chrono-ordered stepped diagonal baffles that trigger Storm/Frost Spires
 * before sweeping across Chrono Spires (-1.2s global cooldown shave) and folding back.
 */
function buildClapChainScaffold(
  ctx: BuilderContext,
  difficulty: BotDifficulty,
  scaffoldBudget: number
): void {
  const turnGap =
    difficulty === 'NOVICE' ? 4 : difficulty === 'ARCHITECT' ? 3 : 2;
  const minStride = difficulty === 'NOVICE' ? 5 : 4;
  const desiredStages =
    difficulty === 'NOVICE'
      ? 3
      : difficulty === 'ARCHITECT'
      ? 4
      : Math.min(6, Math.max(4, Math.floor(scaffoldBudget / 6.2)));

  const rows = selectAlignedSwitchbackRows(ctx.round, desiredStages, minStride);

  const chronoSpires = ctx.round.preplacedSpires.filter(
    (s) => s.spireType === 'CHRONO_SPIRE'
  );
  let openLeft = ctx.round.spawn.x > ctx.gw * 0.5;
  if (chronoSpires.length > 0 && ctx.round.preplacedSpires.length >= 2) {
    const firstNonChrono = ctx.round.preplacedSpires.find(
      (s) => s.spireType !== 'CHRONO_SPIRE'
    );
    if (firstNonChrono) {
      openLeft = firstNonChrono.x < ctx.gw * 0.5;
    }
  }

  for (let idx = 0; idx < rows.length; idx++) {
    if (ctx.towers.length >= scaffoldBudget) break;
    const baseY = rows[idx];

    const prevY = idx > 0 ? rows[idx - 1] : -10;
    const nextY = idx + 1 < rows.length ? rows[idx + 1] : 99;
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

    // Sweeping angled chevron wall across the central Spire zone
    const chevronY = (x: number): number => {
      if (maxShift === 0) return baseY;
      const sign = Math.sign(maxShift);
      const mag = Math.abs(maxShift);
      if (mag >= 2 && x >= 8 && x <= 11) return baseY + sign * 2;
      if (x >= 5 && x <= 14) return baseY + sign;
      return baseY;
    };

    if (openLeft) {
      buildSealedBaffle(
        ctx,
        turnGap,
        ctx.gw - 1,
        true,
        chevronY,
        scaffoldBudget
      );
    } else {
      buildSealedBaffle(
        ctx,
        0,
        ctx.gw - 1 - turnGap,
        false,
        chevronY,
        scaffoldBudget
      );
    }
    openLeft = !openLeft;
  }
}

/**
 * Stage 3: Dedicated Citadel Circuitry Keep-to-Spire Overcharge Bridging.
 */
function bridgeKeepsForOvercharge(
  ctx: BuilderContext,
  difficulty: BotDifficulty,
  deadlineMs: number
): void {
  if (difficulty === 'NOVICE' || ctx.round.obstacles.length === 0) return;

  const targetMaxTier = difficulty === 'ARCHITECT' ? 2 : 3;
  const isJuggernaut =
    RUNNER_ARCHETYPES[ctx.round.runnerType || 'SCOUT'].slowResist > 0;

  let passes = 0;
  while (
    ctx.towers.length < ctx.maxWalls &&
    passes < 4 &&
    nowMs() < deadlineMs
  ) {
    passes++;
    const baseCirc = computeCitadelCircuitry(ctx.round, ctx.towers);
    if (baseCirc.spireOverchargeTiers.every((t) => t >= targetMaxTier)) break;

    const basePath = computeFullMazePath(ctx.round, ctx.towers);
    if (!basePath.valid) break;
    const baseEval = evaluateMazeRunTime(ctx.round, ctx.towers, {
      precomputedPath: basePath,
      collectClapLocations: false,
    });

    const candidateSet = new Map<number, GridPoint>();
    const addAround = (gx: number, gy: number, rad: number) => {
      for (let dy = -rad; dy <= rad; dy++) {
        for (let dx = -rad; dx <= rad; dx++) {
          const tx = gx + dx;
          const ty = gy + dy;
          if (!canFit2x2Fast(ctx, tx, ty)) continue;
          candidateSet.set(ty * ctx.gw + tx, { x: tx, y: ty });
        }
      }
    };

    ctx.round.obstacles.forEach((kp, kIdx) => {
      if (!baseCirc.linkedKeepIndices.has(kIdx)) addAround(kp.x, kp.y, 2);
    });
    ctx.round.preplacedSpires.forEach((sp, sIdx) => {
      if ((baseCirc.spireOverchargeTiers[sIdx] || 0) < targetMaxTier) {
        addAround(sp.x, sp.y, 3);
      }
    });

    let bestSingle: { x: number; y: number; gainScore: number } | null = null;
    for (const cand of candidateSet.values()) {
      if (nowMs() >= deadlineMs) break;
      if (!passesMasonryRules(ctx, cand.x, cand.y, { allowSpireRoot: true })) {
        continue;
      }
      const testTowers: PlacedTower[] = [
        ...ctx.towers,
        { id: '__k1__', type: 'BLOCK', x: cand.x, y: cand.y, createdAt: 0 },
      ];
      const nextCirc = computeCitadelCircuitry(ctx.round, testTowers);
      const dOver = nextCirc.overchargedSpires - baseCirc.overchargedSpires;
      const dKeeps = nextCirc.linkedKeeps - baseCirc.linkedKeeps;
      if (dOver <= 0 && dKeeps <= 0) continue;

      const check = validateTowerPlacement(ctx.round, ctx.towers, cand.x, cand.y);
      if (!check.valid || !check.pathResult) continue;

      const sim = evaluateMazeRunTime(ctx.round, testTowers, {
        precomputedPath: check.pathResult,
        collectClapLocations: false,
      });
      const dt = sim.finishTimeSeconds - baseEval.finishTimeSeconds;
      const gainScore =
        dt * 3.0 + dOver * (isJuggernaut ? 4.8 : 2.6) + dKeeps * 1.0;

      if (gainScore > 0.6 && (!bestSingle || gainScore > bestSingle.gainScore)) {
        bestSingle = { x: cand.x, y: cand.y, gainScore };
      }
    }

    if (
      bestSingle &&
      tryPlaceWallDetailed(ctx, bestSingle.x, bestSingle.y, {
        allowSpireRoot: true,
        allowCliffRoot: true,
      }).placed
    ) {
      continue;
    }

    // 2-pillar Keep bridge for Grandmaster
    if (
      difficulty === 'GRANDMASTER' &&
      ctx.towers.length + 2 <= ctx.maxWalls &&
      nowMs() < deadlineMs
    ) {
      let bestPair: { a: GridPoint; b: GridPoint; gainScore: number } | null =
        null;
      const stepOffsets: Array<[number, number]> = [
        [2, 0],
        [-2, 0],
        [0, 2],
        [0, -2],
        [2, 2],
        [-2, 2],
        [2, -2],
        [-2, -2],
      ];

      for (let kIdx = 0; kIdx < ctx.round.obstacles.length; kIdx++) {
        if (nowMs() >= deadlineMs) break;
        if (baseCirc.linkedKeepIndices.has(kIdx)) continue;
        const kp = ctx.round.obstacles[kIdx];

        for (const [dx1, dy1] of stepOffsets) {
          const ax = kp.x + dx1;
          const ay = kp.y + dy1;
          if (!canFit2x2Fast(ctx, ax, ay)) continue;
          if (!passesMasonryRules(ctx, ax, ay, { allowSpireRoot: true })) {
            continue;
          }

          for (const [dx2, dy2] of stepOffsets) {
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
            const dOver = pairCirc.overchargedSpires - baseCirc.overchargedSpires;
            if (dOver <= 0) continue;

            const c1 = validateTowerPlacement(ctx.round, ctx.towers, ax, ay);
            if (!c1.valid) continue;
            const c2 = validateTowerPlacement(
              ctx.round,
              pairTowers.slice(0, -1),
              bx,
              by
            );
            if (!c2.valid || !c2.pathResult) continue;

            const sim = evaluateMazeRunTime(ctx.round, pairTowers, {
              precomputedPath: c2.pathResult,
              collectClapLocations: false,
            });
            const dt = sim.finishTimeSeconds - baseEval.finishTimeSeconds;
            const gainScore = dt * 2.5 + dOver * (isJuggernaut ? 5.0 : 3.0);
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
        if (
          tryPlaceWallDetailed(ctx, bestPair.a.x, bestPair.a.y, {
            allowSpireRoot: true,
            allowCliffRoot: true,
          }).placed
        ) {
          tryPlaceWallDetailed(ctx, bestPair.b.x, bestPair.b.y, {
            allowSpireRoot: true,
            allowCliffRoot: true,
          });
          continue;
        }
      }
    }

    break;
  }
}

/**
 * Stage 4: Ultra-Fast Wall-Tip & Path-Choke Frontier Polish.
 * Evaluates only high-leverage cells touching existing Wall/Keep tips on or adjacent to the active
 * runner path (<= 16 A* checks per step), spending remaining walls cleanly in <2ms.
 */
function polishMazeFrontier(
  ctx: BuilderContext,
  difficulty: BotDifficulty,
  deadlineMs: number
): void {
  const maxSteps =
    difficulty === 'NOVICE' ? 3 : difficulty === 'ARCHITECT' ? 12 : 22;
  const topK = difficulty === 'NOVICE' ? 2 : 3;

  let step = 0;
  while (
    ctx.towers.length < ctx.maxWalls &&
    step < maxSteps &&
    nowMs() < deadlineMs
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
    const curEval = evaluateMazeRunTime(ctx.round, ctx.towers, {
      precomputedPath: curPath,
      collectClapLocations: false,
    });
    const curComposite =
      curEval.finishTimeSeconds * 3.8 +
      curEval.overchargedSpires * 1.8 +
      curEval.linkedKeeps * 0.6;

    // Mark active path cells on a fast bitmap so we only test masonry extensions right on the path
    const onPath = new Uint8Array(ctx.gw * ctx.gh);
    for (let i = 1; i < curPath.allPoints.length - 1; i++) {
      const px = Math.floor(curPath.allPoints[i].x);
      const py = Math.floor(curPath.allPoints[i].y);
      if (px >= 0 && px < ctx.gw && py >= 0 && py < ctx.gh) {
        onPath[py * ctx.gw + px] = 1;
      }
    }

    const rawCoords: GridPoint[] = [];
    const seen = new Uint8Array(ctx.gw * ctx.gh);
    const tipDirs: Array<[number, number]> = [
      [2, 0],
      [-2, 0],
      [0, 2],
      [0, -2],
      [2, 1],
      [-2, 1],
      [2, -1],
      [-2, -1],
      [2, 2],
      [-2, 2],
      [2, -2],
      [-2, -2],
    ];

    const anchors: GridPoint[] = [...ctx.towers, ...ctx.round.obstacles];
    for (let a = 0; a < anchors.length; a++) {
      const anc = anchors[a];
      for (const [dx, dy] of tipDirs) {
        const tx = anc.x + dx;
        const ty = anc.y + dy;
        if (!canFit2x2Fast(ctx, tx, ty)) continue;
        const key = ty * ctx.gw + tx;
        if (seen[key]) continue;
        seen[key] = 1;

        // Only evaluate placements whose 2x2 footprint intercepts or grazes the active runner path
        const r0 = key;
        const r1 = key + ctx.gw;
        if (
          !onPath[r0] &&
          !onPath[r0 + 1] &&
          !onPath[r1] &&
          !onPath[r1 + 1]
        ) {
          continue;
        }

        if (
          !passesMasonryRules(ctx, tx, ty, {
            allowCliffRoot: false,
            allowSpireRoot: false,
          })
        ) {
          continue;
        }
        rawCoords.push({ x: tx, y: ty });
      }
    }

    const geoCandidates: Array<{
      x: number;
      y: number;
      geoDelta: number;
      pathResult: PathResult;
    }> = [];

    // Cap A* evaluations per step to keep worst-case latency tiny
    const evalLimit = Math.min(rawCoords.length, 18);
    for (let i = 0; i < evalLimit; i++) {
      if (nowMs() >= deadlineMs) break;
      const c = rawCoords[i];
      const check = validateTowerPlacement(ctx.round, ctx.towers, c.x, c.y);
      if (!check.valid || !check.pathResult) continue;

      const geo = scorePathWithMapFeatures(
        ctx.round,
        check.pathResult,
        curCirc.spireOverchargeTiers
      );
      const geoDelta = geo - curGeo;
      if (geoDelta > 0.15) {
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

    let bestSingle: { x: number; y: number; composite: number } | null = null;
    for (const cand of shortlist) {
      if (nowMs() >= deadlineMs) break;
      const sim = evaluateMazeRunTime(
        ctx.round,
        [
          ...ctx.towers,
          { id: '__p1__', type: 'BLOCK', x: cand.x, y: cand.y, createdAt: 0 },
        ],
        { precomputedPath: cand.pathResult, collectClapLocations: false }
      );
      const comp =
        sim.finishTimeSeconds * 3.8 +
        sim.overchargedSpires * 1.8 +
        sim.linkedKeeps * 0.6;
      if (
        comp > curComposite + 0.25 &&
        (!bestSingle || comp > bestSingle.composite)
      ) {
        bestSingle = { x: cand.x, y: cand.y, composite: comp };
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

    // 2-Pillar Spur Lookahead to fold wide corridors cleanly
    if (
      difficulty !== 'NOVICE' &&
      ctx.towers.length + 2 <= ctx.maxWalls &&
      nowMs() < deadlineMs
    ) {
      const seeds = rawCoords.slice(0, 4);
      let placedPair = false;
      const extDirs: Array<[number, number]> = [
        [2, 0],
        [-2, 0],
        [0, 2],
        [0, -2],
        [2, 2],
        [-2, 2],
      ];

      for (const s of seeds) {
        if (nowMs() >= deadlineMs) break;
        if (
          !tryPlaceWallDetailed(ctx, s.x, s.y, {
            allowCliffRoot: false,
            allowSpireRoot: false,
          }).placed
        ) {
          continue;
        }

        let bestExt: { x: number; y: number; comp: number } | null = null;
        for (const [dx, dy] of extDirs) {
          const ex = s.x + dx;
          const ey = s.y + dy;
          if (!canFit2x2Fast(ctx, ex, ey)) continue;
          if (!passesMasonryRules(ctx, ex, ey, { allowCliffRoot: true })) {
            continue;
          }
          const c2 = validateTowerPlacement(ctx.round, ctx.towers, ex, ey);
          if (!c2.valid || !c2.pathResult) continue;

          const sim2 = evaluateMazeRunTime(
            ctx.round,
            [
              ...ctx.towers,
              { id: '__p2__', type: 'BLOCK', x: ex, y: ey, createdAt: 0 },
            ],
            { precomputedPath: c2.pathResult, collectClapLocations: false }
          );
          const comp2 =
            sim2.finishTimeSeconds * 3.8 +
            sim2.overchargedSpires * 1.8 +
            sim2.linkedKeeps * 0.6;
          if (
            comp2 > curComposite + 1.2 &&
            (!bestExt || comp2 > bestExt.comp)
          ) {
            bestExt = { x: ex, y: ey, comp: comp2 };
          }
        }

        if (
          bestExt &&
          tryPlaceWallDetailed(ctx, bestExt.x, bestExt.y, {
            allowCliffRoot: true,
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
}

/**
 * Final Masonry Hygiene Pass: removes any freestanding block lacking Wall/Keep neighbors
 * unless it provides substantial survival or Overcharge value.
 */
function pruneFloatingPillars(ctx: BuilderContext): void {
  if (ctx.towers.length <= 2) return;

  const baseEval = evaluateMazeRunTime(ctx.round, ctx.towers, {
    collectClapLocations: false,
  });

  for (let i = ctx.towers.length - 1; i >= 0; i--) {
    const t = ctx.towers[i];
    let wallKeepDeg = 0;
    for (let j = 0; j < ctx.towers.length; j++) {
      if (
        i !== j &&
        Math.abs(ctx.towers[j].x - t.x) <= 2 &&
        Math.abs(ctx.towers[j].y - t.y) <= 2
      ) {
        wallKeepDeg++;
      }
    }
    for (let k = 0; k < ctx.round.obstacles.length; k++) {
      const o = ctx.round.obstacles[k];
      if (Math.abs(o.x - t.x) <= 2 && Math.abs(o.y - t.y) <= 2) {
        wallKeepDeg++;
      }
    }

    if (wallKeepDeg > 0) continue;

    const without = ctx.towers.filter((_, idx) => idx !== i);
    const testPath = computeFullMazePath(ctx.round, without);
    if (!testPath.valid) continue;

    const withoutEval = evaluateMazeRunTime(ctx.round, without, {
      precomputedPath: testPath,
      collectClapLocations: false,
    });
    const timeLoss = baseEval.finishTimeSeconds - withoutEval.finishTimeSeconds;
    const overLoss = baseEval.overchargedSpires - withoutEval.overchargedSpires;

    if (timeLoss < 1.2 && overLoss <= 0) {
      removeWallAtIndex(ctx, i);
    }
  }
}

/**
 * Generates an architectural Stone Wall layout across the 20x26 island in <8ms:
 * - Stage 1 & 2: Map-aware Topological Scaffold (`SWITCHBACK`, Frost-anchored `SPIRAL`, Chrono `CLAP_CHAIN`)
 * - Stage 3: Dedicated 1–2 hop Crimson Keep -> Spire Overcharge circuitry bridging
 * - Stage 4: Masonry-clean (`1 <= deg <= 3`, 0 pimples, 0 2x2 quads) simulation-guided frontier polish
 */
export function generateMazeLayout(
  round: RoundConfig,
  difficulty: BotDifficulty = 'GRANDMASTER',
  preferredStyle: BotStyle = 'SWITCHBACK'
): PlacedTower[] {
  const startMs = nowMs();
  const deadlineMs = startMs + 5.8;

  const wallCost = TOWER_SPECS.BLOCK.goldCost;
  const totalAvailableWalls = Math.max(
    0,
    Math.floor(round.startingGold / wallCost)
  );
  if (totalAvailableWalls === 0) return [];

  const maxWalls =
    difficulty === 'NOVICE'
      ? Math.max(6, Math.floor(totalAvailableWalls * 0.56))
      : difficulty === 'ARCHITECT'
      ? Math.max(8, Math.floor(totalAvailableWalls * 0.8))
      : totalAvailableWalls;

  const ctx = createBuilderContext(round, maxWalls);

  const scaffoldShare =
    difficulty === 'NOVICE' ? 0.92 : difficulty === 'ARCHITECT' ? 0.88 : 0.9;
  const scaffoldBudget = Math.max(6, Math.floor(maxWalls * scaffoldShare));

  if (preferredStyle === 'SPIRAL') {
    buildSpiralScaffold(ctx, difficulty, scaffoldBudget);
  } else if (preferredStyle === 'CLAP_CHAIN') {
    buildClapChainScaffold(ctx, difficulty, scaffoldBudget);
  } else {
    buildSwitchbackScaffold(ctx, difficulty, scaffoldBudget);
  }

  if (nowMs() < deadlineMs) {
    bridgeKeepsForOvercharge(ctx, difficulty, deadlineMs);
  }

  if (nowMs() < deadlineMs) {
    polishMazeFrontier(ctx, difficulty, deadlineMs);
  }

  pruneFloatingPillars(ctx);

  return ctx.towers;
}
