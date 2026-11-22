import {
  computeCitadelCircuitry,
  computeFullMazePath,
  computeSingleSegmentPath,
} from './pathfinding.js';
import {
  ClapLocationPoint,
  EffectiveSpireStats,
  getEffectiveSpireStats,
  GridPoint,
  MazeEvalResult,
  OVERCHARGE_CDR,
  PathResult,
  PathSegment,
  PlacedTower,
  RoundConfig,
  RUNNER_ARCHETYPES,
  RunnerArchetypeSpec,
  RunnerSimState,
  SimEvent,
  SpireType,
  TOWER_SPECS,
  TowerSimState,
} from './types.js';

export { getEffectiveSpireStats, OVERCHARGE_CDR };
export type { ClapLocationPoint, EffectiveSpireStats };

export const SIM_TICK_RATE = 60;
export const SIM_DT = 1 / SIM_TICK_RATE;
export const MAX_SIM_SECONDS = 300;

const TIME_EPS = 1e-7;
const HOLD_GATE_THRESHOLD_SEC = 0.45;
const FROST_MIRE_SLOW = 0.25;
const HASTE_RIFT_MULT = 1.3;
const TAILWIND_DELAY_SEC = 3.2;
const TAILWIND_MULT = 1.28;

export interface EvalMazeOptions {
  precomputedPath?: PathResult;
  collectClapLocations?: boolean;
}

interface InternalSpire {
  state: TowerSimState;
  effectiveRangeSq: number;
  exitRimSq: number;
  slowPercent: number;
  baseSlowDuration: number;
  auraSlowPercent: number;
  cdrPulseSeconds: number;
  chronoBankSec: number;
  isFrost: boolean;
}

interface SlowSkylineEntry {
  pct: number;
  rem: number;
  sourceId: string;
}

function decayTimer(value: number, dt: number): number {
  if (value <= 0) return 0;
  const next = value - dt;
  return next <= TIME_EPS ? 0 : next;
}

function isInside2x2Pad(x: number, y: number, pad: GridPoint): boolean {
  return x >= pad.x && x <= pad.x + 2.0 && y >= pad.y && y <= pad.y + 2.0;
}

function isPathResult(val: PathResult | EvalMazeOptions): val is PathResult {
  return 'valid' in val && Array.isArray((val as PathResult).segments);
}

export class MazeRunnerSimulator {
  public playerId: string;
  public round: RoundConfig;
  public towers: PlacedTower[];
  public state: RunnerSimState;
  public pathResult: PathResult;
  public circuitry: ReturnType<typeof computeCitadelCircuitry>;
  public elapsedSeconds = 0;

  private tickCount = 0;
  private readonly runnerSpec: RunnerArchetypeSpec;
  private readonly spires: InternalSpire[];
  private readonly slowSkyline: SlowSkylineEntry[] = [];

  constructor(
    playerId: string,
    round: RoundConfig,
    towers: PlacedTower[],
    precomputedPath?: PathResult
  ) {
    this.playerId = playerId;
    this.round = round;
    this.towers = towers;

    const rawPath = precomputedPath ?? computeFullMazePath(round, towers);

    // Only clone segment arrays when a Waygate can dynamically rewrite a segment mid-run
    if (round.waygate) {
      this.pathResult = {
        valid: rawPath.valid,
        totalDistance: rawPath.totalDistance,
        allPoints: [...rawPath.allPoints],
        segments: rawPath.segments.map((s) => ({
          ...s,
          points: [...s.points],
        })),
      };
    } else {
      this.pathResult = rawPath;
    }

    this.circuitry = computeCitadelCircuitry(round, towers);
    this.runnerSpec = RUNNER_ARCHETYPES[round.runnerType || 'SCOUT'];

    const towerStates: Record<string, TowerSimState> = {};
    const spireList: InternalSpire[] = [];

    for (let idx = 0; idx < round.preplacedSpires.length; idx++) {
      const spire = round.preplacedSpires[idx];
      const id = `spire_${idx}`;
      const spireType: SpireType = spire.spireType || 'THUNDERCLAP';
      const spec = TOWER_SPECS[spireType];
      const tier = Math.max(
        0,
        Math.min(3, this.circuitry.spireOverchargeTiers[idx] || 0)
      );
      const effectiveStats = getEffectiveSpireStats(spireType, tier);
      const effectiveRange = effectiveStats.effectiveRange;
      const effectiveCooldown = effectiveStats.effectiveCooldown;
      const exitRim = Math.max(0, effectiveRange - 0.55);

      const simTower: TowerSimState = {
        id,
        type: spireType,
        centerX: spire.x + 1.0,
        centerY: spire.y + 1.0,
        overchargeTier: tier,
        effectiveRange,
        effectiveCooldown,
        cooldownRemaining: 0,
        triggeredCount: 0,
      };

      towerStates[id] = simTower;
      spireList.push({
        state: simTower,
        effectiveRangeSq: effectiveRange * effectiveRange,
        exitRimSq: exitRim * exitRim,
        slowPercent: effectiveStats.slowPercent,
        baseSlowDuration: spec.slowDuration + tier * 0.25,
        auraSlowPercent: effectiveStats.auraSlowPercent,
        cdrPulseSeconds: effectiveStats.cdrPulseSeconds,
        chronoBankSec: 0,
        isFrost: spireType === 'FROST_OBELISK',
      });
    }

    this.spires = spireList;

    const startX = round.spawn.x + 1.0;
    const startY = round.spawn.y === 0 ? 0.0 : round.spawn.y + 1.0;

    let initialFacing = Math.PI / 2;
    const firstSeg = this.pathResult.segments[0];
    if (firstSeg && firstSeg.points.length > 1) {
      const fdx = firstSeg.points[1].x - startX;
      const fdy = firstSeg.points[1].y - startY;
      if (fdx * fdx + fdy * fdy > 1e-8) {
        initialFacing = Math.atan2(fdy, fdx);
      }
    }

    this.state = {
      playerId,
      x: startX,
      y: startY,
      facingAngle: initialFacing,
      currentSegmentIndex: 0,
      currentWaypointIndex: 0,
      baseSpeed: this.runnerSpec.baseSpeed,
      currentSpeed: this.runnerSpec.baseSpeed,
      clapSlowRemaining: 0,
      activeSlowPercent: 0,
      strongSlowRemaining: 0,
      strongSlowPercent: 0,
      armoredHitRemaining: 0,
      exposureStacks: 0,
      timeSinceLastSpireSec: 0,
      inPermafrostAura: false,
      hasTailwindMomentum: false,
      inFrostMire: false,
      inHasteRift: false,
      waygateUsed: false,
      finished:
        !this.pathResult.valid || this.pathResult.segments.length === 0,
      finishTimeSeconds: 0,
      elapsedSeconds: 0,
      distanceTraveled: 0,
      checkpointsReached: 0,
      clapsTaken: 0,
      towers: towerStates,
    };
  }

  public step(dt: number = SIM_DT): SimEvent[] {
    const events: SimEvent[] = [];
    this.stepInternal(dt, events, null);
    return events;
  }

  public fastForwardTo(targetElapsedSeconds: number): void {
    if (
      !Number.isFinite(targetElapsedSeconds) ||
      targetElapsedSeconds <= this.elapsedSeconds
    ) {
      return;
    }
    const clampedTarget = Math.min(targetElapsedSeconds, MAX_SIM_SECONDS);
    let guardTicks = SIM_TICK_RATE * MAX_SIM_SECONDS;
    while (
      !this.state.finished &&
      this.elapsedSeconds + SIM_DT * 0.5 <= clampedTarget &&
      guardTicks > 0
    ) {
      this.stepInternal(SIM_DT, null, null);
      guardTicks--;
    }
  }

  /**
   * Shared zero-allocation core step used by live playback (`step`), mid-run catch-up (`fastForwardTo`),
   * and fast build-hover / server evaluation (`evaluateMazeRunTime`).
   */
  public stepInternal(
    dt: number,
    eventsOut: SimEvent[] | null,
    clapLocationsOut: ClapLocationPoint[] | null
  ): void {
    if (this.state.finished || dt <= 0) return;

    if (Math.abs(dt - SIM_DT) < 1e-12) {
      this.tickCount += 1;
      this.elapsedSeconds = this.tickCount * SIM_DT;
    } else {
      this.elapsedSeconds += dt;
      this.tickCount = Math.round(this.elapsedSeconds * SIM_TICK_RATE);
    }
    this.state.elapsedSeconds = this.elapsedSeconds;

    const runnerSpec = this.runnerSpec;
    const spires = this.spires;
    const spireCount = spires.length;

    // 1. Decay Spire cooldowns with float64 epsilon snap so 3.0s = exact 180 ticks
    for (let i = 0; i < spireCount; i++) {
      const ts = spires[i].state;
      if (ts.cooldownRemaining > 0) {
        ts.cooldownRemaining = decayTimer(ts.cooldownRemaining, dt);
      }
    }

    // 2. Decay exact monotonic upper-envelope slow skyline & armor-resist indicator
    if (this.slowSkyline.length > 0) {
      let writeIdx = 0;
      for (let i = 0; i < this.slowSkyline.length; i++) {
        const entry = this.slowSkyline[i];
        const nextRem = decayTimer(entry.rem, dt);
        if (nextRem > 0) {
          entry.rem = nextRem;
          this.slowSkyline[writeIdx++] = entry;
        }
      }
      this.slowSkyline.length = writeIdx;
      this.syncSlowStateFromSkyline();
    } else if (
      this.state.clapSlowRemaining !== 0 ||
      this.state.activeSlowPercent !== 0
    ) {
      this.state.clapSlowRemaining = 0;
      this.state.activeSlowPercent = 0;
      this.state.strongSlowRemaining = 0;
      this.state.strongSlowPercent = 0;
    }

    if (
      this.state.armoredHitRemaining &&
      this.state.armoredHitRemaining > 0
    ) {
      this.state.armoredHitRemaining = decayTimer(
        this.state.armoredHitRemaining,
        dt
      );
    }

    let rx = this.state.x;
    let ry = this.state.y;

    // 3. Optional Waygate Portal trigger (reroutes across all remaining unvisited Waystones)
    if (this.round.waygate && !this.state.waygateUsed) {
      const entryX = this.round.waygate.entry.x + 1.0;
      const entryY = this.round.waygate.entry.y + 1.0;
      const wDx = rx - entryX;
      const wDy = ry - entryY;
      if (wDx * wDx + wDy * wDy <= 0.9025) {
        const exitPad = this.round.waygate.exit;
        const exitX = exitPad.x + 1.0;
        const exitY = exitPad.y + 1.0;
        const segIdx = this.state.currentSegmentIndex;
        const remCheckpoints = this.round.checkpoints.slice(segIdx);

        let newTailSegments: PathSegment[] | null = null;
        if (remCheckpoints.length === 0) {
          const single = computeSingleSegmentPath(
            this.round,
            this.towers,
            exitPad,
            this.round.exit
          );
          if (single) {
            newTailSegments = [
              {
                fromIndex: segIdx,
                toIndex: segIdx + 1,
                points: single.points,
                distance: single.distance,
              },
            ];
          }
        } else if (exitPad.y > 0) {
          const tailPath = computeFullMazePath(
            {
              ...this.round,
              spawn: exitPad,
              checkpoints: remCheckpoints,
            },
            this.towers
          );
          if (tailPath.valid && tailPath.segments.length > 0) {
            newTailSegments = tailPath.segments.map((s, k) => ({
              fromIndex: segIdx + k,
              toIndex: segIdx + k + 1,
              points: [...s.points],
              distance: s.distance,
            }));
          }
        } else {
          const chainPads: GridPoint[] = [
            exitPad,
            ...remCheckpoints,
            this.round.exit,
          ];
          const built: PathSegment[] = [];
          let ok = true;
          for (let k = 0; k < chainPads.length - 1; k++) {
            const part = computeSingleSegmentPath(
              this.round,
              this.towers,
              chainPads[k],
              chainPads[k + 1]
            );
            if (!part) {
              ok = false;
              break;
            }
            built.push({
              fromIndex: segIdx + k,
              toIndex: segIdx + k + 1,
              points: part.points,
              distance: part.distance,
            });
          }
          if (ok && built.length > 0) {
            newTailSegments = built;
          }
        }

        if (newTailSegments && newTailSegments.length > 0) {
          this.state.waygateUsed = true;
          const updatedSegments = [
            ...this.pathResult.segments.slice(0, segIdx),
            ...newTailSegments,
          ];
          const rebuiltAll: GridPoint[] = [];
          let rebuiltDist = 0;
          for (let s = 0; s < updatedSegments.length; s++) {
            const pts = updatedSegments[s].points;
            if (s === 0) {
              rebuiltAll.push(...pts);
            } else {
              rebuiltAll.push(...pts.slice(1));
            }
            rebuiltDist += updatedSegments[s].distance;
          }
          this.pathResult.segments = updatedSegments;
          this.pathResult.allPoints = rebuiltAll;
          this.pathResult.totalDistance = rebuiltDist;

          const firstNewPts = newTailSegments[0].points;
          const landX = firstNewPts.length > 0 ? firstNewPts[0].x : exitX;
          const landY = firstNewPts.length > 0 ? firstNewPts[0].y : exitY;
          this.state.currentWaypointIndex = 0;
          this.state.x = landX;
          this.state.y = landY;
          rx = landX;
          ry = landY;

          if (firstNewPts.length > 1) {
            const ndx = firstNewPts[1].x - landX;
            const ndy = firstNewPts[1].y - landY;
            if (ndx * ndx + ndy * ndy > 1e-8) {
              this.state.facingAngle = Math.atan2(ndy, ndx);
            }
          }

          if (eventsOut) {
            eventsOut.push({
              type: 'WAYGATE',
              playerId: this.playerId,
              x: entryX,
              y: entryY,
              targetX: exitX,
              targetY: exitY,
              timeSeconds: this.elapsedSeconds,
            });
          }
        }
      }
    }

    // Compute unit instantaneous heading vector for outer-rim & next-tick exit checks
    let ux = Math.cos(this.state.facingAngle);
    let uy = Math.sin(this.state.facingAngle);
    const activeSeg =
      this.pathResult.segments[this.state.currentSegmentIndex];
    if (activeSeg) {
      for (
        let wi = this.state.currentWaypointIndex + 1;
        wi < activeSeg.points.length;
        wi++
      ) {
        const hx = activeSeg.points[wi].x - rx;
        const hy = activeSeg.points[wi].y - ry;
        const hLenSq = hx * hx + hy * hy;
        if (hLenSq > 1e-8) {
          const invLen = 1 / Math.sqrt(hLenSq);
          ux = hx * invLen;
          uy = hy * invLen;
          break;
        }
      }
    }
    const estStep = this.state.baseSpeed * dt;

    // 4. Check Spire Perimeters, Permafrost Aura, and Burst Triggers (with 2nd micro-pass if Chrono recharges i < j)
    let insideAnySpireRing = false;
    let maxPermafrostTier = -1;
    let maxPermafrostAura = 0;

    for (let i = 0; i < spireCount; i++) {
      const sp = spires[i];
      const dx = rx - sp.state.centerX;
      const dy = ry - sp.state.centerY;
      if (dx * dx + dy * dy <= sp.effectiveRangeSq) {
        insideAnySpireRing = true;
        if (sp.isFrost && sp.state.overchargeTier > maxPermafrostTier) {
          maxPermafrostTier = sp.state.overchargeTier;
          maxPermafrostAura = sp.auraSlowPercent;
        }
      }
    }

    for (let pass = 0; pass < 2; pass++) {
      let rechargedEarlierSpire = false;

      for (let i = 0; i < spireCount; i++) {
        const sp = spires[i];
        const ts = sp.state;
        if (ts.cooldownRemaining > 0) continue;

        const dx = rx - ts.centerX;
        const dy = ry - ts.centerY;
        const distSq = dx * dx + dy * dy;
        if (distSq > sp.effectiveRangeSq) continue;

        // Ready Spires NEVER self-hold on their own prior slow; they hold only if a DIFFERENT Spire's
        // slow still has > 0.45s left, UNLESS Chrono can recharge an active sibling OR runner is exiting!
        const heldBySiblingSlow = this.isBlockedByOtherSpireSlow(ts.id);
        let shouldFire = !heldBySiblingSlow;

        if (!shouldFire) {
          if (sp.cdrPulseSeconds > 0 && this.hasRechargingSibling(i)) {
            shouldFire = true;
          } else {
            const nx = dx + ux * estStep;
            const ny = dy + uy * estStep;
            const willExitNextTick = nx * nx + ny * ny > sp.effectiveRangeSq;
            const exitingOuterRim =
              willExitNextTick ||
              (distSq >= sp.exitRimSq && dx * ux + dy * uy >= -1e-6);
            shouldFire = exitingOuterRim;
          }
        }

        if (!shouldFire) continue;

        const hadActiveSlow = this.state.clapSlowRemaining > 0;
        const banked = sp.chronoBankSec;
        sp.chronoBankSec = 0;
        ts.cooldownRemaining =
          banked > TIME_EPS
            ? Number(Math.max(0.6, ts.effectiveCooldown - banked).toFixed(4))
            : ts.effectiveCooldown;
        ts.triggeredCount++;
        this.state.clapsTaken++;
        this.state.exposureStacks = Math.min(5, this.state.exposureStacks + 1);
        this.state.timeSinceLastSpireSec = 0;

        // Overcharged Spires (tier > 0) pierce Iron Juggernaut slow resistance
        const armoredResisted =
          ts.overchargeTier === 0 && runnerSpec.slowResist > 0;
        if (armoredResisted) {
          this.state.armoredHitRemaining = 0.85;
        }

        const effectiveResist =
          ts.overchargeTier > 0 ? 0.0 : runnerSpec.slowResist;
        // Exposure starts on Hit #2 (+0% on Hit #1 so printed 50%/45%/55% match exactly)
        const exposureBonus = (this.state.exposureStacks - 1) * 0.03;
        const rawSlow = Math.min(
          0.75,
          (sp.slowPercent + exposureBonus) * (1.0 - effectiveResist)
        );
        const chainComboBonus = hadActiveSlow ? 0.3 : 0.0;
        const duration =
          (sp.baseSlowDuration + chainComboBonus) * runnerSpec.slowDurationMult;

        this.insertBurstSlow(rawSlow, duration, ts.id);

        // Chrono Spire pulse: shave active cooldowns first, and pre-charge up to 1.2s toward siblings' next shot
        let cdrApplied: number | undefined;
        let cdrTargetIds: string[] | undefined;
        if (sp.cdrPulseSeconds > 0) {
          const pulse = sp.cdrPulseSeconds;
          for (let j = 0; j < spireCount; j++) {
            if (j === i) continue;
            const otherSp = spires[j];
            const other = otherSp.state;
            const prevCd = other.cooldownRemaining;
            const shavedCd = prevCd > TIME_EPS ? Math.min(pulse, prevCd) : 0;
            if (shavedCd > 0) {
              const nextCd = decayTimer(prevCd, shavedCd);
              other.cooldownRemaining = nextCd;
              if (nextCd === 0 && j < i) {
                rechargedEarlierSpire = true;
              }
            }

            const remainder = pulse - shavedCd;
            const bankRoom = Math.max(0, pulse - otherSp.chronoBankSec);
            const bankAdded =
              remainder > TIME_EPS && bankRoom > TIME_EPS
                ? Math.min(remainder, bankRoom)
                : 0;
            if (bankAdded > 0) {
              otherSp.chronoBankSec = Number(
                Math.min(pulse, otherSp.chronoBankSec + bankAdded).toFixed(4)
              );
            }

            if (shavedCd + bankAdded > TIME_EPS) {
              cdrApplied = pulse;
              if (eventsOut) {
                if (!cdrTargetIds) cdrTargetIds = [];
                cdrTargetIds.push(other.id);
              }
            }
          }
        }

        if (clapLocationsOut) {
          clapLocationsOut.push({
            x: rx,
            y: ry,
            spireType: ts.type,
            spireIndex: i,
          });
        }

        if (eventsOut) {
          eventsOut.push({
            type: 'CLAP',
            playerId: this.playerId,
            x: ts.centerX,
            y: ts.centerY,
            targetX: rx,
            targetY: ry,
            towerId: ts.id,
            spireType: ts.type,
            overchargeTier: ts.overchargeTier,
            cdrAppliedSeconds: cdrApplied,
            cdrTargetIds,
            armoredResisted: armoredResisted ? true : undefined,
            timeSeconds: this.elapsedSeconds,
          });
        }
      }

      if (!rechargedEarlierSpire) break;
    }

    // Optional terrain modifiers (zero cost when round arrays are empty)
    let inMire = false;
    if (this.round.frostMires.length > 0) {
      for (let i = 0; i < this.round.frostMires.length; i++) {
        if (isInside2x2Pad(rx, ry, this.round.frostMires[i])) {
          inMire = true;
          break;
        }
      }
    }

    let inRift = false;
    if (this.round.hasteRifts.length > 0) {
      for (let i = 0; i < this.round.hasteRifts.length; i++) {
        if (isInside2x2Pad(rx, ry, this.round.hasteRifts[i])) {
          inRift = true;
          break;
        }
      }
    }

    this.state.inPermafrostAura = maxPermafrostTier >= 0;
    this.state.inFrostMire = inMire;
    this.state.inHasteRift = inRift;

    if (insideAnySpireRing || this.state.clapSlowRemaining > 0 || inMire) {
      this.state.timeSinceLastSpireSec = 0;
    } else {
      this.state.timeSinceLastSpireSec += dt;
    }

    // Wind Herald Tailwind: +28% speed after 3.2s unslowed outside Spire rings
    this.state.hasTailwindMomentum =
      runnerSpec.hasMomentum &&
      this.state.timeSinceLastSpireSec >= TAILWIND_DELAY_SEC - TIME_EPS;

    // 5. Calculate effective speed
    let speedMultiplier = 1.0;
    if (this.state.clapSlowRemaining > 0) {
      speedMultiplier *= 1.0 - this.state.activeSlowPercent;
    }

    if (maxPermafrostTier >= 0) {
      const auraResist = maxPermafrostTier > 0 ? 0.0 : runnerSpec.slowResist;
      speedMultiplier *= 1.0 - maxPermafrostAura * (1.0 - auraResist);
    }

    if (inMire) {
      speedMultiplier *= 1.0 - FROST_MIRE_SLOW * (1.0 - runnerSpec.slowResist);
    }

    if (this.state.hasTailwindMomentum) {
      speedMultiplier *= TAILWIND_MULT;
    }

    if (inRift) {
      speedMultiplier *= HASTE_RIFT_MULT;
    }

    this.state.currentSpeed = this.state.baseSpeed * speedMultiplier;

    // 6. Move along current segment waypoints with IEEE-754 sqrt & sub-tick finish interpolation
    let moveRemaining = this.state.currentSpeed * dt;

    while (moveRemaining > 0 && !this.state.finished) {
      const seg = this.pathResult.segments[this.state.currentSegmentIndex];
      if (!seg) {
        this.state.finished = true;
        this.state.finishTimeSeconds = Number(this.elapsedSeconds.toFixed(2));
        break;
      }

      const isFinalSegment =
        this.state.currentSegmentIndex >= this.pathResult.segments.length - 1;
      const nextWpIndex = this.state.currentWaypointIndex + 1;

      if (nextWpIndex >= seg.points.length) {
        if (!isFinalSegment) {
          this.state.checkpointsReached++;
          const cpPoint = seg.points[seg.points.length - 1];
          if (eventsOut) {
            eventsOut.push({
              type: 'CHECKPOINT',
              playerId: this.playerId,
              x: cpPoint.x,
              y: cpPoint.y,
              checkpointIndex: this.state.currentSegmentIndex,
              timeSeconds: this.elapsedSeconds,
            });
          }
          this.state.currentSegmentIndex++;
          this.state.currentWaypointIndex = 0;
          continue;
        } else {
          const exitPoint = seg.points[seg.points.length - 1];
          this.state.x = exitPoint.x;
          this.state.y = exitPoint.y;
          this.state.finished = true;
          this.state.finishTimeSeconds = Number(
            this.elapsedSeconds.toFixed(2)
          );
          if (eventsOut) {
            eventsOut.push({
              type: 'FINISH',
              playerId: this.playerId,
              x: exitPoint.x,
              y: exitPoint.y,
              timeSeconds: this.state.finishTimeSeconds,
            });
          }
          break;
        }
      }

      const target = seg.points[nextWpIndex];
      const dx = target.x - this.state.x;
      const dy = target.y - this.state.y;
      const distToWp = Math.sqrt(dx * dx + dy * dy);

      if (distToWp > 0.0001) {
        this.state.facingAngle = Math.atan2(dy, dx);
      }

      if (moveRemaining >= distToWp) {
        this.state.x = target.x;
        this.state.y = target.y;
        this.state.distanceTraveled += distToWp;
        moveRemaining -= distToWp;
        this.state.currentWaypointIndex = nextWpIndex;

        // Complete immediately upon reaching the final exit waypoint, interpolating unused sub-tick time
        if (isFinalSegment && nextWpIndex === seg.points.length - 1) {
          const unusedTime =
            this.state.currentSpeed > 1e-6
              ? Math.min(dt, moveRemaining / this.state.currentSpeed)
              : 0;
          const exactFinish = Math.max(0, this.elapsedSeconds - unusedTime);
          this.state.finished = true;
          this.state.finishTimeSeconds = Number(exactFinish.toFixed(2));
          moveRemaining = 0;
          if (eventsOut) {
            eventsOut.push({
              type: 'FINISH',
              playerId: this.playerId,
              x: target.x,
              y: target.y,
              timeSeconds: this.state.finishTimeSeconds,
            });
          }
          break;
        }
      } else {
        const ratio = moveRemaining / distToWp;
        this.state.x += dx * ratio;
        this.state.y += dy * ratio;
        this.state.distanceTraveled += moveRemaining;
        moveRemaining = 0;
      }
    }
  }

  private hasRechargingSibling(selfIdx: number): boolean {
    for (let j = 0; j < this.spires.length; j++) {
      if (j !== selfIdx && this.spires[j].state.cooldownRemaining > TIME_EPS) {
        return true;
      }
    }
    return false;
  }

  private isBlockedByOtherSpireSlow(spireId: string): boolean {
    for (let k = 0; k < this.slowSkyline.length; k++) {
      const entry = this.slowSkyline[k];
      if (
        entry.sourceId !== spireId &&
        entry.rem > HOLD_GATE_THRESHOLD_SEC + TIME_EPS
      ) {
        return true;
      }
    }
    return false;
  }

  /**
   * Maintains the exact monotonic upper-envelope skyline `S(tau) = max_k { pct_k | tau < rem_k }`:
   * strictly decreasing `pct` with strictly increasing `rem` (bounded to <= 4 entries).
   */
  private insertBurstSlow(
    rawSlow: number,
    duration: number,
    sourceId: string
  ): void {
    if (rawSlow <= 0 || duration <= TIME_EPS) return;

    const skyline = this.slowSkyline;

    // If an existing entry already dominates (rawSlow, duration), update sourceId only on exact tie
    for (let i = 0; i < skyline.length; i++) {
      const e = skyline[i];
      if (e.pct >= rawSlow - 1e-9 && e.rem >= duration - TIME_EPS) {
        if (
          Math.abs(e.pct - rawSlow) <= 1e-9 &&
          Math.abs(e.rem - duration) <= TIME_EPS
        ) {
          e.sourceId = sourceId;
        }
        return;
      }
    }

    // Step 1: Prune entries dominated by (rawSlow, duration) in-place (writeIdx <= i)
    let writeIdx = 0;
    const origLen = skyline.length;
    for (let i = 0; i < origLen; i++) {
      const e = skyline[i];
      if (e.pct <= rawSlow + 1e-9 && e.rem <= duration + TIME_EPS) {
        continue;
      }
      skyline[writeIdx++] = e;
    }
    skyline.length = writeIdx;

    // Step 2: Insert new entry in descending pct order via backward shift
    const newEntry: SlowSkylineEntry = { pct: rawSlow, rem: duration, sourceId };
    let insPos = writeIdx;
    while (insPos > 0 && rawSlow > skyline[insPos - 1].pct) {
      insPos--;
    }
    skyline.push(newEntry);
    for (let j = skyline.length - 1; j > insPos; j--) {
      skyline[j] = skyline[j - 1];
    }
    skyline[insPos] = newEntry;

    // Step 3: Enforce strictly increasing remaining duration along the descending-pct skyline
    const afterInsLen = skyline.length;
    if (afterInsLen > 1) {
      let cleanIdx = 1;
      for (let i = 1; i < afterInsLen; i++) {
        if (skyline[i].rem > skyline[cleanIdx - 1].rem + TIME_EPS) {
          skyline[cleanIdx++] = skyline[i];
        }
      }
      skyline.length = cleanIdx;
    }

    this.syncSlowStateFromSkyline();
  }

  private syncSlowStateFromSkyline(): void {
    const len = this.slowSkyline.length;
    if (len === 0) {
      this.state.activeSlowPercent = 0;
      this.state.clapSlowRemaining = 0;
      this.state.strongSlowPercent = 0;
      this.state.strongSlowRemaining = 0;
      return;
    }
    this.state.activeSlowPercent = this.slowSkyline[0].pct;
    this.state.clapSlowRemaining = this.slowSkyline[len - 1].rem;
    if (len > 1) {
      this.state.strongSlowPercent = this.slowSkyline[0].pct;
      this.state.strongSlowRemaining = this.slowSkyline[0].rem;
    } else {
      this.state.strongSlowPercent = 0;
      this.state.strongSlowRemaining = 0;
    }
  }
}

/**
 * Runs a fast-forward deterministic simulation of a maze to compute its exact finish time,
 * Spire detonation coordinates, per-spire trigger counts, and Citadel Circuitry Keep links.
 */
export function evaluateMazeRunTime(
  round: RoundConfig,
  towers: PlacedTower[],
  optionsOrPath?: PathResult | EvalMazeOptions
): MazeEvalResult {
  let precomputedPath: PathResult | undefined;
  let collectClapLocations = true;

  if (optionsOrPath) {
    if (isPathResult(optionsOrPath)) {
      precomputedPath = optionsOrPath;
    } else {
      precomputedPath = optionsOrPath.precomputedPath;
      if (optionsOrPath.collectClapLocations !== undefined) {
        collectClapLocations = optionsOrPath.collectClapLocations;
      }
    }
  }

  const sim = new MazeRunnerSimulator(
    '__eval__',
    round,
    towers,
    precomputedPath
  );
  const clapLocations: ClapLocationPoint[] = [];
  const clapSink = collectClapLocations ? clapLocations : null;
  let maxTicks = SIM_TICK_RATE * MAX_SIM_SECONDS;

  while (!sim.state.finished && maxTicks > 0) {
    sim.stepInternal(SIM_DT, null, clapSink);
    maxTicks--;
  }

  const perSpireClaps: Record<string, number> = {};
  for (const tid in sim.state.towers) {
    perSpireClaps[tid] = sim.state.towers[tid].triggeredCount;
  }

  const finishTimeSeconds = sim.state.finished
    ? sim.state.finishTimeSeconds
    : Number(sim.elapsedSeconds.toFixed(2));

  return {
    finishTimeSeconds,
    distance: Number(sim.state.distanceTraveled.toFixed(1)),
    clapsTaken: sim.state.clapsTaken,
    clapLocations,
    perSpireClaps,
    linkedKeeps: sim.circuitry.linkedKeeps,
    overchargedSpires: sim.circuitry.overchargedSpires,
    spireOverchargeTiers: sim.circuitry.spireOverchargeTiers,
  };
}
