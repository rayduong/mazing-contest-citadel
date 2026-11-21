import {
  computeCitadelCircuitry,
  computeFullMazePath,
  computeSingleSegmentPath,
} from './pathfinding.js';
import {
  GridPoint,
  MazeEvalResult,
  PathResult,
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

export const SIM_TICK_RATE = 60;
export const SIM_DT = 1 / SIM_TICK_RATE;
export const MAX_SIM_SECONDS = 300;
export const BASE_RUNNER_SPEED = 3.5;
export const OVERCHARGE_CDR = [0, 0.12, 0.22, 0.3] as const;

const TIME_EPS = 1e-7;
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
  slowDuration: number;
  cdrPulseSeconds: number;
  isFrost: boolean;
}

function decayTimer(value: number, dt: number): number {
  if (value <= 0) return 0;
  const next = value - dt;
  return next <= TIME_EPS ? 0 : next;
}

function isInside2x2Pad(x: number, y: number, pad: GridPoint): boolean {
  return x >= pad.x && x <= pad.x + 2.0 && y >= pad.y && y <= pad.y + 2.0;
}

function isPathResult(
  val: PathResult | EvalMazeOptions
): val is PathResult {
  return 'valid' in val && Array.isArray((val as PathResult).segments);
}

export class MazeRunnerSimulator {
  public state: RunnerSimState;
  public pathResult: PathResult;
  public circuitry: ReturnType<typeof computeCitadelCircuitry>;
  public elapsedSeconds = 0;

  private tickCount = 0;
  private readonly runnerSpec: RunnerArchetypeSpec;
  private readonly spires: InternalSpire[];

  constructor(
    public playerId: string,
    public round: RoundConfig,
    public towers: PlacedTower[],
    precomputedPath?: PathResult
  ) {
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
      const effectiveRange = Number((spec.range + tier * 0.25).toFixed(2));
      const effectiveCooldown = Number(
        (spec.cooldown * (1 - OVERCHARGE_CDR[tier])).toFixed(2)
      );
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
        slowPercent: spec.slowPercent,
        slowDuration: spec.slowDuration,
        cdrPulseSeconds: spec.cdrPulseSeconds || 0,
        isFrost: spireType === 'FROST_OBELISK',
      });
    }

    this.spires = spireList;

    const startX = round.spawn.x + 1.0;
    const startY = round.spawn.y === 0 ? 0.0 : round.spawn.y + 1.0;

    this.state = {
      playerId,
      x: startX,
      y: startY,
      facingAngle: Math.PI / 2,
      currentSegmentIndex: 0,
      currentWaypointIndex: 0,
      baseSpeed: this.runnerSpec.baseSpeed,
      currentSpeed: this.runnerSpec.baseSpeed,
      clapSlowRemaining: 0,
      activeSlowPercent: 0.5,
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
    clapLocationsOut: GridPoint[] | null
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

    // 2. Decay dual-slot Spire burst slows & armor-resist visual flag
    if (this.state.clapSlowRemaining > 0) {
      this.state.clapSlowRemaining = decayTimer(
        this.state.clapSlowRemaining,
        dt
      );
    }
    if (
      this.state.strongSlowRemaining &&
      this.state.strongSlowRemaining > 0
    ) {
      this.state.strongSlowRemaining = decayTimer(
        this.state.strongSlowRemaining,
        dt
      );
    }
    if (this.state.clapSlowRemaining <= 0) {
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

    // 3. Optional Waygate Portal trigger
    if (this.round.waygate && !this.state.waygateUsed) {
      const entryX = this.round.waygate.entry.x + 1.0;
      const entryY = this.round.waygate.entry.y + 1.0;
      const wDx = rx - entryX;
      const wDy = ry - entryY;
      if (wDx * wDx + wDy * wDy <= 0.9025) {
        this.state.waygateUsed = true;
        const exitPad = this.round.waygate.exit;
        const exitX = exitPad.x + 1.0;
        const exitY = exitPad.y + 1.0;

        const waypoints: GridPoint[] = [
          this.round.spawn,
          ...this.round.checkpoints,
          this.round.exit,
        ];
        const targetPad =
          waypoints[this.state.currentSegmentIndex + 1] || this.round.exit;
        const rerouted = computeSingleSegmentPath(
          this.round,
          this.towers,
          exitPad,
          targetPad
        );

        if (
          rerouted &&
          this.pathResult.segments[this.state.currentSegmentIndex]
        ) {
          this.pathResult.segments[this.state.currentSegmentIndex].points =
            rerouted.points;
          this.state.currentWaypointIndex = 0;
          this.state.x = exitX;
          this.state.y = exitY;
          rx = exitX;
          ry = exitY;

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

    // Compute instantaneous heading vector so outer-rim Spire override fires only when exiting
    let headingX = Math.cos(this.state.facingAngle);
    let headingY = Math.sin(this.state.facingAngle);
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
        if (hx * hx + hy * hy > 1e-8) {
          headingX = hx;
          headingY = hy;
          break;
        }
      }
    }

    // 4. Check Spire Perimeters, Frost Obelisk Permafrost Aura, and Burst Triggers
    let insideAnySpireRing = false;
    let maxPermafrostTier = -1;

    for (let i = 0; i < spireCount; i++) {
      const sp = spires[i];
      const ts = sp.state;
      const dx = rx - ts.centerX;
      const dy = ry - ts.centerY;
      const distSq = dx * dx + dy * dy;

      if (distSq > sp.effectiveRangeSq) continue;

      insideAnySpireRing = true;
      if (sp.isFrost && ts.overchargeTier > maxPermafrostTier) {
        maxPermafrostTier = ts.overchargeTier;
      }

      if (ts.cooldownRemaining > 0) continue;

      const slowNearlyExpired =
        this.state.clapSlowRemaining <= 0.45 + TIME_EPS;
      const exitingOuterRim =
        distSq >= sp.exitRimSq && dx * headingX + dy * headingY > 0;

      if (slowNearlyExpired || exitingOuterRim) {
        const hadActiveSlow = this.state.clapSlowRemaining > 0;
        ts.cooldownRemaining = ts.effectiveCooldown;
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
        const exposureBonus = this.state.exposureStacks * 0.03;
        const rawSlow = Math.min(
          0.75,
          (sp.slowPercent + exposureBonus) * (1.0 - effectiveResist)
        );
        const chainComboBonus = hadActiveSlow ? 0.3 : 0.0;
        const duration =
          (sp.slowDuration + ts.overchargeTier * 0.25 + chainComboBonus) *
          runnerSpec.slowDurationMult;

        this.applyBurstSlowEnvelope(rawSlow, duration);

        // Chrono Spire pulse: shave cooldown off all other Spires on the island
        let cdrApplied: number | undefined;
        if (sp.cdrPulseSeconds > 0) {
          cdrApplied = sp.cdrPulseSeconds;
          for (let j = 0; j < spireCount; j++) {
            if (j !== i) {
              const other = spires[j].state;
              other.cooldownRemaining = decayTimer(
                other.cooldownRemaining,
                sp.cdrPulseSeconds
              );
            }
          }
        }

        if (clapLocationsOut) {
          clapLocationsOut.push({ x: rx, y: ry });
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
            armoredResisted: armoredResisted ? true : undefined,
            timeSeconds: this.elapsedSeconds,
          });
        }
      }
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

    // Wind Herald Momentum: +28% speed after 3.2s un-slowed outside Spire rings
    this.state.hasTailwindMomentum =
      runnerSpec.hasMomentum &&
      this.state.timeSinceLastSpireSec >= TAILWIND_DELAY_SEC - TIME_EPS;

    // 5. Calculate effective speed
    let speedMultiplier = 1.0;
    if (this.state.clapSlowRemaining > 0) {
      const burstSlow =
        (this.state.strongSlowRemaining || 0) > 0
          ? Math.max(
              this.state.activeSlowPercent,
              this.state.strongSlowPercent || 0
            )
          : this.state.activeSlowPercent;
      speedMultiplier *= 1.0 - burstSlow;
    }

    if (maxPermafrostTier >= 0) {
      const baseAura =
        (TOWER_SPECS.FROST_OBELISK.auraSlowPercent || 0.22) +
        maxPermafrostTier * 0.02;
      const auraResist = maxPermafrostTier > 0 ? 0.0 : runnerSpec.slowResist;
      speedMultiplier *= 1.0 - baseAura * (1.0 - auraResist);
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

    // 6. Move along current segment waypoints with sub-tick finish interpolation
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
      const distToWp = Math.hypot(dx, dy);

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

  /**
   * Exact O(1) upper-envelope composition of overlapping Spire slows so a weaker slow
   * never artificially extends a stronger slow's remaining duration.
   */
  private applyBurstSlowEnvelope(rawSlow: number, duration: number): void {
    const prevRem = this.state.clapSlowRemaining;
    if (prevRem <= 0) {
      this.state.activeSlowPercent = rawSlow;
      this.state.clapSlowRemaining = duration;
      this.state.strongSlowPercent = 0;
      this.state.strongSlowRemaining = 0;
      return;
    }

    const prevBasePct = this.state.activeSlowPercent;
    const prevStrongRem = this.state.strongSlowRemaining || 0;
    const prevStrongPct =
      prevStrongRem > 0 ? this.state.strongSlowPercent || 0 : prevBasePct;
    const currentPeakPct = Math.max(prevBasePct, prevStrongPct);
    const currentPeakRem =
      prevStrongPct > prevBasePct && prevStrongRem > 0
        ? prevStrongRem
        : prevRem;

    if (rawSlow >= currentPeakPct) {
      if (duration >= prevRem) {
        this.state.activeSlowPercent = rawSlow;
        this.state.clapSlowRemaining = duration;
        this.state.strongSlowPercent = 0;
        this.state.strongSlowRemaining = 0;
      } else {
        this.state.strongSlowPercent = rawSlow;
        this.state.strongSlowRemaining = duration;
      }
    } else if (duration > currentPeakRem) {
      this.state.strongSlowPercent = currentPeakPct;
      this.state.strongSlowRemaining = currentPeakRem;
      this.state.activeSlowPercent =
        prevRem > duration ? Math.max(prevBasePct, rawSlow) : rawSlow;
      this.state.clapSlowRemaining = Math.max(prevRem, duration);
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
  const clapLocations: GridPoint[] = [];
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
