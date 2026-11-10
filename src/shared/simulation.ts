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
  RunnerSimState,
  SimEvent,
  SpireType,
  TOWER_SPECS,
  TowerSimState,
} from './types.js';

export const SIM_TICK_RATE = 60;
export const SIM_DT = 1 / SIM_TICK_RATE;
export const BASE_RUNNER_SPEED = 3.5;

const OVERCHARGE_CDR = [0, 0.12, 0.22, 0.3];

export class MazeRunnerSimulator {
  public state: RunnerSimState;
  public pathResult: PathResult;
  public circuitry: {
    linkedKeeps: number;
    overchargedSpires: number;
    spireOverchargeTiers: number[];
  };
  public elapsedSeconds = 0;

  constructor(
    public playerId: string,
    public round: RoundConfig,
    public towers: PlacedTower[]
  ) {
    const rawPath = computeFullMazePath(round, towers);
    this.pathResult = {
      valid: rawPath.valid,
      totalDistance: rawPath.totalDistance,
      allPoints: [...rawPath.allPoints],
      segments: rawPath.segments.map((s) => ({
        ...s,
        points: [...s.points],
      })),
    };

    this.circuitry = computeCitadelCircuitry(round, towers);
    const runnerSpec = RUNNER_ARCHETYPES[round.runnerType || 'SCOUT'];

    const towerStates: Record<string, TowerSimState> = {};
    round.preplacedSpires.forEach((spire, idx) => {
      const id = `spire_${idx}`;
      const spireType: SpireType = spire.spireType || 'THUNDERCLAP';
      const spec = TOWER_SPECS[spireType];
      const tier = this.circuitry.spireOverchargeTiers[idx] || 0;
      const effectiveRange = Number((spec.range + tier * 0.25).toFixed(2));
      const effectiveCooldown = Number(
        (spec.cooldown * (1 - OVERCHARGE_CDR[tier])).toFixed(2)
      );

      towerStates[id] = {
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
    });

    const startX = round.spawn.x + 1.0;
    const startY = round.spawn.y === 0 ? 0.0 : round.spawn.y + 1.0;

    this.state = {
      playerId,
      x: startX,
      y: startY,
      facingAngle: Math.PI / 2,
      currentSegmentIndex: 0,
      currentWaypointIndex: 0,
      baseSpeed: runnerSpec.baseSpeed,
      currentSpeed: runnerSpec.baseSpeed,
      clapSlowRemaining: 0,
      activeSlowPercent: 0.5,
      exposureStacks: 0,
      timeSinceLastSpireSec: 0,
      inPermafrostAura: false,
      hasTailwindMomentum: false,
      inFrostMire: false,
      inHasteRift: false,
      waygateUsed: false,
      finished: !this.pathResult.valid || this.pathResult.segments.length === 0,
      finishTimeSeconds: 0,
      distanceTraveled: 0,
      checkpointsReached: 0,
      clapsTaken: 0,
      towers: towerStates,
    };
  }

  public step(dt: number = SIM_DT): SimEvent[] {
    const events: SimEvent[] = [];
    if (this.state.finished) return events;

    this.elapsedSeconds += dt;
    const runnerSpec = RUNNER_ARCHETYPES[this.round.runnerType || 'SCOUT'];

    // 1. Update Spire cooldowns
    for (const tid in this.state.towers) {
      const ts = this.state.towers[tid];
      if (ts.cooldownRemaining > 0) {
        ts.cooldownRemaining = Math.max(0, ts.cooldownRemaining - dt);
      }
    }

    // 2. Decay active Spire burst slow
    if (this.state.clapSlowRemaining > 0) {
      this.state.clapSlowRemaining = Math.max(
        0,
        this.state.clapSlowRemaining - dt
      );
    }

    const rx = this.state.x;
    const ry = this.state.y;

    // 3. Optional Waygate Portal trigger (if active)
    if (this.round.waygate && !this.state.waygateUsed) {
      const entryX = this.round.waygate.entry.x + 1.0;
      const entryY = this.round.waygate.entry.y + 1.0;
      if (Math.hypot(rx - entryX, ry - entryY) <= 0.95) {
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

        if (rerouted && this.pathResult.segments[this.state.currentSegmentIndex]) {
          this.pathResult.segments[this.state.currentSegmentIndex].points =
            rerouted.points;
          this.state.currentWaypointIndex = 0;
          this.state.x = exitX;
          this.state.y = exitY;

          events.push({
            type: 'WAYGATE',
            playerId: this.playerId,
            x: rx,
            y: ry,
            targetX: exitX,
            targetY: exitY,
            timeSeconds: this.elapsedSeconds,
          });
          return events;
        }
      }
    }

    // 4. Check Spire Perimeters, Frost Obelisk Permafrost Aura, and Burst Triggers (Storm, Frost, Chrono)
    let insideAnySpireRing = false;
    let inPermafrost = false;

    for (const tid in this.state.towers) {
      const ts = this.state.towers[tid];
      const spec = TOWER_SPECS[ts.type];
      const dist = Math.hypot(rx - ts.centerX, ry - ts.centerY);

      if (dist <= ts.effectiveRange) {
        insideAnySpireRing = true;
        if (ts.type === 'FROST_OBELISK') {
          inPermafrost = true;
        }
      }

      if (
        dist <= ts.effectiveRange &&
        ts.cooldownRemaining <= 0 &&
        (this.state.clapSlowRemaining <= 0.45 ||
          dist >= ts.effectiveRange - 0.55)
      ) {
        ts.cooldownRemaining = ts.effectiveCooldown;
        ts.triggeredCount++;
        this.state.clapsTaken++;
        this.state.exposureStacks = Math.min(5, this.state.exposureStacks + 1);
        this.state.timeSinceLastSpireSec = 0;

        // Overcharged Spires (tier > 0) pierce Iron Juggernaut slow resistance!
        const effectiveResist =
          ts.overchargeTier > 0 ? 0.0 : runnerSpec.slowResist;
        const exposureBonus = this.state.exposureStacks * 0.03;
        const rawSlow = Math.min(
          0.75,
          (spec.slowPercent + exposureBonus) * (1.0 - effectiveResist)
        );
        const chainComboBonus = this.state.clapSlowRemaining > 0 ? 0.3 : 0.0;
        const duration =
          (spec.slowDuration + ts.overchargeTier * 0.25 + chainComboBonus) *
          runnerSpec.slowDurationMult;

        if (
          this.state.clapSlowRemaining <= 0 ||
          rawSlow >= this.state.activeSlowPercent
        ) {
          this.state.activeSlowPercent = rawSlow;
        }
        this.state.clapSlowRemaining = Math.max(
          this.state.clapSlowRemaining,
          duration
        );

        // Chrono Spire Temporal Warp: reduce cooldown of all other Spires on the map!
        if (spec.cdrPulseSeconds && spec.cdrPulseSeconds > 0) {
          for (const otherId in this.state.towers) {
            if (otherId !== tid) {
              const other = this.state.towers[otherId];
              other.cooldownRemaining = Math.max(
                0,
                other.cooldownRemaining - spec.cdrPulseSeconds
              );
            }
          }
        }

        events.push({
          type: 'CLAP',
          playerId: this.playerId,
          x: ts.centerX,
          y: ts.centerY,
          targetX: rx,
          targetY: ry,
          towerId: ts.id,
          spireType: ts.type,
          overchargeTier: ts.overchargeTier,
          timeSeconds: this.elapsedSeconds,
        });
      }
    }

    this.state.inPermafrostAura = inPermafrost;
    if (insideAnySpireRing || this.state.clapSlowRemaining > 0) {
      this.state.timeSinceLastSpireSec = 0;
    } else {
      this.state.timeSinceLastSpireSec += dt;
    }

    // Wind Herald Momentum: +28% speed if un-slowed and outside Spire rings for >= 3.2s
    this.state.hasTailwindMomentum =
      runnerSpec.hasMomentum && this.state.timeSinceLastSpireSec >= 3.2;

    // 5. Calculate effective speed
    let speedMultiplier = 1.0;
    if (this.state.clapSlowRemaining > 0) {
      speedMultiplier *= 1.0 - this.state.activeSlowPercent;
    }
    if (this.state.inPermafrostAura) {
      speedMultiplier *= 1.0 - (TOWER_SPECS.FROST_OBELISK.auraSlowPercent || 0.22);
    }
    if (this.state.hasTailwindMomentum) {
      speedMultiplier *= 1.28;
    }

    this.state.currentSpeed = this.state.baseSpeed * speedMultiplier;

    // 6. Move along current segment waypoints
    let moveRemaining = this.state.currentSpeed * dt;

    while (moveRemaining > 0 && !this.state.finished) {
      const seg = this.pathResult.segments[this.state.currentSegmentIndex];
      if (!seg) {
        this.state.finished = true;
        this.state.finishTimeSeconds = this.elapsedSeconds;
        break;
      }

      const nextWpIndex = this.state.currentWaypointIndex + 1;
      if (nextWpIndex >= seg.points.length) {
        if (
          this.state.currentSegmentIndex <
          this.pathResult.segments.length - 1
        ) {
          this.state.checkpointsReached++;
          const cpPoint = seg.points[seg.points.length - 1];
          events.push({
            type: 'CHECKPOINT',
            playerId: this.playerId,
            x: cpPoint.x,
            y: cpPoint.y,
            checkpointIndex: this.state.currentSegmentIndex,
            timeSeconds: this.elapsedSeconds,
          });
          this.state.currentSegmentIndex++;
          this.state.currentWaypointIndex = 0;
          continue;
        } else {
          const exitPoint = seg.points[seg.points.length - 1];
          this.state.x = exitPoint.x;
          this.state.y = exitPoint.y;
          this.state.finished = true;
          this.state.finishTimeSeconds = Number(this.elapsedSeconds.toFixed(2));
          events.push({
            type: 'FINISH',
            playerId: this.playerId,
            x: exitPoint.x,
            y: exitPoint.y,
            timeSeconds: this.state.finishTimeSeconds,
          });
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
      } else {
        const ratio = moveRemaining / distToWp;
        this.state.x += dx * ratio;
        this.state.y += dy * ratio;
        this.state.distanceTraveled += moveRemaining;
        moveRemaining = 0;
      }
    }

    return events;
  }
}

/**
 * Runs a full fast-forward simulation of a maze to compute its exact finish time,
 * exact Spire detonation coordinates, per-spire trigger counts, and Citadel Circuitry Keep links.
 */
export function evaluateMazeRunTime(
  round: RoundConfig,
  towers: PlacedTower[]
): MazeEvalResult {
  const sim = new MazeRunnerSimulator('__eval__', round, towers);
  const clapLocations: GridPoint[] = [];
  let maxTicks = SIM_TICK_RATE * 300;

  while (!sim.state.finished && maxTicks > 0) {
    const evs = sim.step(SIM_DT);
    for (const ev of evs) {
      if (ev.type === 'CLAP' && ev.targetX !== undefined && ev.targetY !== undefined) {
        clapLocations.push({ x: ev.targetX, y: ev.targetY });
      }
    }
    maxTicks--;
  }

  const perSpireClaps: Record<string, number> = {};
  for (const tid in sim.state.towers) {
    perSpireClaps[tid] = sim.state.towers[tid].triggeredCount;
  }

  return {
    finishTimeSeconds: Number(sim.elapsedSeconds.toFixed(2)),
    distance: Number(sim.state.distanceTraveled.toFixed(1)),
    clapsTaken: sim.state.clapsTaken,
    clapLocations,
    perSpireClaps,
    linkedKeeps: sim.circuitry.linkedKeeps,
    overchargedSpires: sim.circuitry.overchargedSpires,
    spireOverchargeTiers: sim.circuitry.spireOverchargeTiers,
  };
}

