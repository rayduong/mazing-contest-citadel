import { computeFullMazePath, do2x2Overlap } from './pathfinding.js';
import { GridPoint, RoundConfig, SpireType } from './types.js';

export const GRID_WIDTH = 20;
export const GRID_HEIGHT = 26;

export const ROUNDS: RoundConfig[] = [
  {
    roundNumber: 1,
    title: 'Meadow Gate',
    subtitle: '2 Storm · 4 Keeps · Citadel Scout',
    hint: 'Fold switchbacks past both Storm Spires. Link a Crimson Keep into your wall within 1 tile of a Spire to Overcharge it.',
    runnerType: 'SCOUT',
    gridWidth: GRID_WIDTH,
    gridHeight: GRID_HEIGHT,
    buildTimeSeconds: 90,
    startingGold: 130,
    spawn: { x: 9, y: 0 },
    exit: { x: 9, y: 24 },
    checkpoints: [],
    obstacleCount: 4,
    spireCount: 2,
    frostMireCount: 0,
    hasteRiftCount: 0,
    obstacles: [],
    preplacedSpires: [],
    frostMires: [],
    hasteRifts: [],
    parTimeSeconds: 28.0,
  },
  {
    roundNumber: 2,
    title: 'Frostbend Crossing',
    subtitle: '1 Storm · 2 Frost · 4 Keeps · Royal Outrider',
    hint: 'Outriders sprint fast on open grass, but slows last 25% longer. Wrap tight turns around both Frost Obelisks.',
    runnerType: 'OUTRIDER',
    gridWidth: GRID_WIDTH,
    gridHeight: GRID_HEIGHT,
    buildTimeSeconds: 95,
    startingGold: 150,
    spawn: { x: 4, y: 0 },
    exit: { x: 14, y: 24 },
    checkpoints: [],
    obstacleCount: 4,
    spireCount: 3,
    frostMireCount: 0,
    hasteRiftCount: 0,
    obstacles: [],
    preplacedSpires: [],
    frostMires: [],
    hasteRifts: [],
    parTimeSeconds: 34.0,
  },
  {
    roundNumber: 3,
    title: 'Switchback Court',
    subtitle: '2 Storm · 1 Frost · 5 Keeps · 1 Waystone · Citadel Scout',
    hint: 'Runners must visit the Waystone before the South Shrine. Chain three Crimson Keeps into one wall for max Overcharge.',
    runnerType: 'SCOUT',
    gridWidth: GRID_WIDTH,
    gridHeight: GRID_HEIGHT,
    buildTimeSeconds: 100,
    startingGold: 165,
    spawn: { x: 14, y: 0 },
    exit: { x: 4, y: 24 },
    checkpoints: [{ x: 5, y: 10 }],
    obstacleCount: 5,
    spireCount: 3,
    frostMireCount: 0,
    hasteRiftCount: 0,
    obstacles: [],
    preplacedSpires: [],
    frostMires: [],
    hasteRifts: [],
    parTimeSeconds: 41.0,
  },
  {
    roundNumber: 4,
    title: 'Westwall Relay',
    subtitle: '2 Storm · 1 Frost · 1 Chrono · 5 Keeps · Wind Herald',
    hint: 'Both gates hug the west cliff. Space your Spire passes under 3.2 seconds apart so the Wind Herald never triggers Tailwind.',
    runnerType: 'HERALD',
    gridWidth: GRID_WIDTH,
    gridHeight: GRID_HEIGHT,
    buildTimeSeconds: 105,
    startingGold: 180,
    spawn: { x: 3, y: 0 },
    exit: { x: 3, y: 24 },
    checkpoints: [],
    obstacleCount: 5,
    spireCount: 4,
    frostMireCount: 0,
    hasteRiftCount: 0,
    obstacles: [],
    preplacedSpires: [],
    frostMires: [],
    hasteRifts: [],
    parTimeSeconds: 45.0,
  },
  {
    roundNumber: 5,
    title: 'Iron Bastion',
    subtitle: '2 Storm · 1 Frost · 1 Chrono · 7 Keeps · Iron Juggernaut',
    hint: 'Juggernaut armor blocks a fifth of uncharged slows. Use the seven Crimson Keeps as anchors and Overcharge every Spire.',
    runnerType: 'JUGGERNAUT',
    gridWidth: GRID_WIDTH,
    gridHeight: GRID_HEIGHT,
    buildTimeSeconds: 105,
    startingGold: 175,
    spawn: { x: 9, y: 0 },
    exit: { x: 9, y: 24 },
    checkpoints: [],
    obstacleCount: 7,
    spireCount: 4,
    frostMireCount: 0,
    hasteRiftCount: 0,
    obstacles: [],
    preplacedSpires: [],
    frostMires: [],
    hasteRifts: [],
    parTimeSeconds: 50.0,
  },
  {
    roundNumber: 6,
    title: 'Crosswind Spiral',
    subtitle: '1 Storm · 2 Frost · 1 Chrono · 5 Keeps · 1 Waystone · Royal Outrider',
    hint: 'Route past Storm and Frost on the way to the Waystone, then trigger the Chrono Spire to cut 1.2s off active cooldowns.',
    runnerType: 'OUTRIDER',
    gridWidth: GRID_WIDTH,
    gridHeight: GRID_HEIGHT,
    buildTimeSeconds: 110,
    startingGold: 190,
    spawn: { x: 15, y: 0 },
    exit: { x: 3, y: 24 },
    checkpoints: [{ x: 5, y: 10 }],
    obstacleCount: 5,
    spireCount: 4,
    frostMireCount: 0,
    hasteRiftCount: 0,
    obstacles: [],
    preplacedSpires: [],
    frostMires: [],
    hasteRifts: [],
    parTimeSeconds: 51.0,
  },
  {
    roundNumber: 7,
    title: 'Twin Chrono Ridge',
    subtitle: '2 Storm · 1 Frost · 2 Chrono · 6 Keeps · Iron Juggernaut',
    hint: 'Two Chrono Spires cut 1.2s off each other on every pulse. Overcharge your central wall network to pierce Juggernaut armor.',
    runnerType: 'JUGGERNAUT',
    gridWidth: GRID_WIDTH,
    gridHeight: GRID_HEIGHT,
    buildTimeSeconds: 115,
    startingGold: 205,
    spawn: { x: 3, y: 0 },
    exit: { x: 15, y: 24 },
    checkpoints: [],
    obstacleCount: 6,
    spireCount: 5,
    frostMireCount: 0,
    hasteRiftCount: 0,
    obstacles: [],
    preplacedSpires: [],
    frostMires: [],
    hasteRifts: [],
    parTimeSeconds: 59.0,
  },
  {
    roundNumber: 8,
    title: 'The High Citadel',
    subtitle: '2 Storm · 2 Frost · 1 Chrono · 6 Keeps · 1 Waystone · Wind Herald',
    hint: 'Final round. Route the Wind Herald through the Waystone and all five Spires without leaving a 3.2-second Tailwind gap.',
    runnerType: 'HERALD',
    gridWidth: GRID_WIDTH,
    gridHeight: GRID_HEIGHT,
    buildTimeSeconds: 120,
    startingGold: 220,
    spawn: { x: 9, y: 0 },
    exit: { x: 9, y: 24 },
    checkpoints: [{ x: 13, y: 12 }],
    obstacleCount: 6,
    spireCount: 5,
    frostMireCount: 0,
    hasteRiftCount: 0,
    obstacles: [],
    preplacedSpires: [],
    frostMires: [],
    hasteRifts: [],
    parTimeSeconds: 62.0,
  },
];

const ROUND_SPIRE_ARCHETYPES: Record<number, SpireType[]> = {
  1: ['THUNDERCLAP', 'THUNDERCLAP'],
  2: ['FROST_OBELISK', 'THUNDERCLAP', 'FROST_OBELISK'],
  3: ['THUNDERCLAP', 'FROST_OBELISK', 'THUNDERCLAP'],
  4: ['THUNDERCLAP', 'FROST_OBELISK', 'CHRONO_SPIRE', 'THUNDERCLAP'],
  5: ['THUNDERCLAP', 'FROST_OBELISK', 'CHRONO_SPIRE', 'THUNDERCLAP'],
  6: ['FROST_OBELISK', 'THUNDERCLAP', 'CHRONO_SPIRE', 'FROST_OBELISK'],
  7: [
    'THUNDERCLAP',
    'CHRONO_SPIRE',
    'FROST_OBELISK',
    'CHRONO_SPIRE',
    'THUNDERCLAP',
  ],
  8: [
    'THUNDERCLAP',
    'FROST_OBELISK',
    'CHRONO_SPIRE',
    'FROST_OBELISK',
    'THUNDERCLAP',
  ],
};

function getSpireArchetypeForSlot(
  roundNumber: number,
  slotIndex: number
): SpireType {
  const manifest = ROUND_SPIRE_ARCHETYPES[roundNumber];
  if (manifest && slotIndex < manifest.length) {
    return manifest[slotIndex];
  }
  const fallback: SpireType[] = [
    'THUNDERCLAP',
    'FROST_OBELISK',
    'CHRONO_SPIRE',
    'THUNDERCLAP',
    'FROST_OBELISK',
  ];
  return fallback[slotIndex % fallback.length];
}

/**
 * Deterministic 32-bit PRNG (Mulberry32) so every round layout can be reproduced
 * identically from `round.seed`.
 */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function normalizeSeed(seed?: number): number {
  if (typeof seed === 'number' && Number.isFinite(seed)) {
    const clean = Math.trunc(seed) >>> 0;
    return clean === 0 ? 1 : clean;
  }
  const randomSeed = Math.floor(Math.random() * 0x7ffffffe) + 1;
  return randomSeed >>> 0;
}

/**
 * Scales a round's base Par target by the room's Wall Supply multiplier, tapering on
 * high-density late rounds so 125% Supply never over-inflates Par under board saturation:
 * - 0.80x (80%)   -> 0.86x (early) tapering gently to 0.88x (late) [R1 28.0s -> 24.1s]
 * - 1.00x (Normal)-> 1.00x Par
 * - 1.25x (125%)  -> ~1.08x tapered (1.10x on open R1-R2 down to 1.06x on dense R7-R8)
 */
export function computeEffectivePar(
  baseParSeconds: number,
  goldMultiplier: number = 1.0
): number {
  const mult =
    typeof goldMultiplier === 'number' &&
    Number.isFinite(goldMultiplier) &&
    goldMultiplier > 0
      ? goldMultiplier
      : 1.0;

  // Normalized campaign density factor in [0..1] across basePar 28s..62s
  const densityT = Math.max(0, Math.min(1, (baseParSeconds - 28) / 34));
  const targetAt80 = 0.86 + 0.02 * densityT;
  const targetAt125 = 1.10 - 0.04 * densityT;

  let scale = 1.0;
  if (Math.abs(mult - 1.0) < 0.005) {
    scale = 1.0;
  } else if (Math.abs(mult - 0.8) < 0.005) {
    scale = targetAt80;
  } else if (Math.abs(mult - 1.25) < 0.005) {
    scale = targetAt125;
  } else if (mult < 1.0) {
    const dropAt80 = 1.0 - targetAt80;
    scale = Math.max(0.6, 1.0 - ((1.0 - mult) * dropAt80) / 0.2);
  } else {
    const gainAt125 = targetAt125 - 1.0;
    scale = Math.min(1.3, 1.0 + ((mult - 1.0) * gainAt125) / 0.25);
  }

  return Number((baseParSeconds * scale).toFixed(1));
}

/**
 * True when two 2x2 footprints at (ax, ay) and (bx, by) leave at least 2 full
 * walkable tiles along X or Y (`max(|dx|, |dy|) >= 4`), preventing 1-tile dead slivers.
 */
function hasTwoTileClearance(
  ax: number,
  ay: number,
  bx: number,
  by: number
): boolean {
  return Math.max(Math.abs(ax - bx), Math.abs(ay - by)) >= 4;
}

interface SpireZoneBand {
  yMin: number;
  yMax: number;
  xMin: number;
  xMax: number;
}

function buildSpireZoneBands(
  spireCount: number,
  gridWidth: number,
  gridHeight: number,
  mirrorX: boolean
): SpireZoneBand[] {
  const minX = 4;
  const maxX = Math.max(minX, gridWidth - 6); // 14 on width 20

  const leftRange: [number, number] = [minX, Math.min(maxX, minX + 2)]; // [4..6]
  const centerRange: [number, number] = [
    Math.max(minX, Math.floor(gridWidth / 2) - 2),
    Math.min(maxX, Math.floor(gridWidth / 2)),
  ]; // [8..10]
  const rightRange: [number, number] = [Math.max(minX, maxX - 2), maxX]; // [12..14]

  const pickLateral = (slot: 'L' | 'C' | 'R'): [number, number] => {
    if (slot === 'C') return centerRange;
    if (slot === 'L') return mirrorX ? rightRange : leftRange;
    return mirrorX ? leftRange : rightRange;
  };

  if (spireCount <= 2) {
    const [x0Min, x0Max] = pickLateral('L');
    const [x1Min, x1Max] = pickLateral('R');
    return [
      { yMin: 5, yMax: 9, xMin: x0Min, xMax: x0Max },
      { yMin: 14, yMax: 18, xMin: x1Min, xMax: x1Max },
    ].slice(0, spireCount);
  }

  if (spireCount === 3) {
    const [x0Min, x0Max] = pickLateral('L');
    const [x1Min, x1Max] = pickLateral('R');
    const [x2Min, x2Max] = pickLateral('C');
    return [
      { yMin: 4, yMax: 7, xMin: x0Min, xMax: x0Max },
      { yMin: 10, yMax: 13, xMin: x1Min, xMax: x1Max },
      { yMin: 16, yMax: 20, xMin: x2Min, xMax: x2Max },
    ];
  }

  if (spireCount === 4) {
    const [x0Min, x0Max] = pickLateral('L');
    const [x1Min, x1Max] = pickLateral('R');
    const [x2Min, x2Max] = pickLateral('L');
    const [x3Min, x3Max] = pickLateral('R');
    return [
      { yMin: 4, yMax: 6, xMin: x0Min, xMax: x0Max },
      { yMin: 8, yMax: 11, xMin: x1Min, xMax: x1Max },
      { yMin: 13, yMax: 16, xMin: x2Min, xMax: x2Max },
      { yMin: 18, yMax: 20, xMin: x3Min, xMax: x3Max },
    ];
  }

  // 5+ Spires: distributed across y in [4..20] (avoiding y in {3,21} 3-tile border slivers)
  // with separated L/R/C lateral windows so Slot 0..4 maintain strict monotonic Y-order.
  const minY5 = 4;
  const maxY5 = Math.max(minY5, gridHeight - 6); // 20 on height 26
  const pattern: Array<'L' | 'C' | 'R'> = ['L', 'R', 'C', 'L', 'R'];
  const yBands: Array<[number, number]> = [
    [4, 5],
    [7, 9],
    [11, 13],
    [15, 17],
    [19, 20],
  ];

  const bands: SpireZoneBand[] = [];
  for (let i = 0; i < spireCount; i++) {
    const [xMin, xMax] = pickLateral(pattern[i % pattern.length]);
    const [yMin, yMax] = yBands[Math.min(i, yBands.length - 1)];
    bands.push({
      yMin: Math.max(minY5, yMin),
      yMax: Math.min(maxY5, yMax),
      xMin,
      xMax,
    });
  }
  return bands;
}

/**
 * Generates a deterministic, sliver-free 20x26 layout of 2x2 Elemental Spires,
 * optional Gilded Waystones (R3, R6, R8), and 4-7 Crimson Keeps using `mulberry32(seed)`.
 * - Spires sit across longitudinal bands in y in [4..20] (strictly ordered North-to-South) so full
 *   360-degree 1-tile corridor wraps and 2x2 outer walls always fit inside the island with >= 4-tile border gaps.
 * - Keeps forbid 3-tile cliff-sliver coordinates (`x in {3,15}`, `y in {3,21}`), either forming
 *   clean 2-block orthogonal bastions (`gap = 0`) or leaving >= 2 walkable tiles of clearance.
 * - Deterministic per-Spire round-robin guarantees reachable Keep anchors near Spires.
 */
export function generateRandomRoundLayout(
  baseRound: RoundConfig,
  seed?: number
): RoundConfig {
  const resolvedSeed = normalizeSeed(seed);
  const rng = mulberry32(resolvedSeed);

  const randInt = (min: number, max: number): number => {
    if (max <= min) return min;
    return min + Math.floor(rng() * (max - min + 1));
  };

  const shuffleInPlace = <T>(arr: T[]): T[] => {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = randInt(0, i);
      const tmp = arr[i];
      arr[i] = arr[j];
      arr[j] = tmp;
    }
    return arr;
  };

  const wantsCheckpoint =
    Array.isArray(baseRound.checkpoints) && baseRound.checkpoints.length > 0;

  const round: RoundConfig = {
    ...baseRound,
    seed: resolvedSeed,
    checkpoints: [],
    obstacles: [],
    preplacedSpires: [],
    frostMires: [],
    hasteRifts: [],
    waygate: undefined,
  };

  const gatePads: GridPoint[] = [round.spawn, round.exit];

  const clearOfPads = (x: number, y: number, pads: GridPoint[]): boolean => {
    for (const pad of pads) {
      if (!hasTwoTileClearance(x, y, pad.x, pad.y)) {
        return false;
      }
    }
    return true;
  };

  // Orient 5-Spire lateral phase away from corner gates for balanced field flow
  let mirrorX = rng() < 0.5;
  if (round.spireCount >= 5) {
    if (round.spawn.x <= 5) {
      mirrorX = true; // Slot 0 starts on Right [12..14], Slot 4 ends on Left [4..6] away from exit=(15,24)
    } else if (round.spawn.x >= round.gridWidth - 7) {
      mirrorX = false; // Slot 0 starts on Left [4..6]
    }
  }

  // 1. Stratified 2x2 Elemental Spires in strict North-to-South longitudinal order (x in [4..14], y in [4..20])
  const spireMinX = 4;
  const spireMaxX = Math.max(spireMinX, round.gridWidth - 6); // 14
  const spireMinY = 4;
  const spireMaxY = Math.max(spireMinY, round.gridHeight - 6); // 20

  const zoneBands = buildSpireZoneBands(
    round.spireCount,
    round.gridWidth,
    round.gridHeight,
    mirrorX
  );

  const canPlaceSpireAt = (
    sx: number,
    sy: number,
    minCenterDist: number
  ): boolean => {
    if (
      sx < spireMinX ||
      sx > spireMaxX ||
      sy < spireMinY ||
      sy > spireMaxY
    ) {
      return false;
    }
    // At y=3 or y=21 near central gates (x=9), ensure >= 4 tiles from gate pad
    if (!clearOfPads(sx, sy, gatePads)) return false;

    for (const other of round.preplacedSpires) {
      if (do2x2Overlap(sx, sy, other.x, other.y)) return false;
      if (!hasTwoTileClearance(sx, sy, other.x, other.y)) return false;
      if (Math.hypot(other.x - sx, other.y - sy) < minCenterDist) return false;
    }
    return true;
  };

  for (let slotIdx = 0; slotIdx < round.spireCount; slotIdx++) {
    const band = zoneBands[slotIdx];
    const spireType = getSpireArchetypeForSlot(round.roundNumber, slotIdx);
    const prevY =
      round.preplacedSpires.length > 0
        ? round.preplacedSpires[round.preplacedSpires.length - 1].y
        : -1;
    let placed = false;

    // Pass A: Exact longitudinal + lateral band candidates (shuffled exhaustively)
    const bandCells: GridPoint[] = [];
    for (let sy = band.yMin; sy <= band.yMax; sy++) {
      if (sy <= prevY) continue;
      for (let sx = band.xMin; sx <= band.xMax; sx++) {
        bandCells.push({ x: sx, y: sy });
      }
    }
    shuffleInPlace(bandCells);

    for (const targetMinDist of [6.8, 5.2]) {
      if (placed) break;
      for (const cand of bandCells) {
        if (!canPlaceSpireAt(cand.x, cand.y, targetMinDist)) continue;
        round.preplacedSpires.push({ x: cand.x, y: cand.y, spireType });
        if (computeFullMazePath(round, []).valid) {
          placed = true;
          break;
        }
        round.preplacedSpires.pop();
      }
    }

    // Pass B: In-band full-width fallback preserving strict North-to-South Y-order & >= 5.0m spacing
    if (!placed) {
      const yLo = Math.max(spireMinY, prevY + 2, band.yMin - 1);
      const yHi = Math.min(spireMaxY, band.yMax + 1);
      const wideBandCells: GridPoint[] = [];
      for (let sy = yLo; sy <= yHi; sy++) {
        for (let sx = spireMinX; sx <= spireMaxX; sx++) {
          wideBandCells.push({ x: sx, y: sy });
        }
      }
      shuffleInPlace(wideBandCells);

      for (const cand of wideBandCells) {
        if (!canPlaceSpireAt(cand.x, cand.y, 5.0)) continue;
        round.preplacedSpires.push({ x: cand.x, y: cand.y, spireType });
        if (computeFullMazePath(round, []).valid) {
          placed = true;
          break;
        }
        round.preplacedSpires.pop();
      }
    }
  }

  // 2. Seeded 2x2 Gilded Waystone on signature rounds (R3, R6, R8)
  if (wantsCheckpoint) {
    const cpCandidates: GridPoint[] = [];
    const preferWestFlank =
      round.roundNumber === 8 ? mirrorX : !mirrorX;
    const primaryXRange: [number, number] = preferWestFlank ? [4, 7] : [11, 14];
    const secondaryXRange: [number, number] = preferWestFlank ? [11, 14] : [4, 7];

    for (const [xLo, xHi] of [primaryXRange, secondaryXRange, [4, 14] as [number, number]]) {
      const windowCells: GridPoint[] = [];
      for (let cy = 8; cy <= 16; cy++) {
        for (let cx = xLo; cx <= xHi; cx++) {
          windowCells.push({ x: cx, y: cy });
        }
      }
      shuffleInPlace(windowCells);
      cpCandidates.push(...windowCells);
    }

    for (const cp of cpCandidates) {
      if (!clearOfPads(cp.x, cp.y, gatePads)) continue;
      if (
        round.preplacedSpires.some(
          (s) => !hasTwoTileClearance(cp.x, cp.y, s.x, s.y)
        )
      ) {
        continue;
      }
      round.checkpoints = [{ x: cp.x, y: cp.y }];
      if (computeFullMazePath(round, []).valid) {
        break;
      }
      round.checkpoints = [];
    }
  }

  const allKeyPads: GridPoint[] = [
    round.spawn,
    ...round.checkpoints,
    round.exit,
  ];

  // 3. Crimson Keeps: forbid 3-tile cliff-slivers (x in {3,15}, y in {3,21}) & guarantee per-Spire reachability
  const keepMinX = 2;
  const keepMaxX = Math.max(keepMinX, round.gridWidth - 4); // 16
  const keepMinY = 2;
  const keepMaxY = Math.max(keepMinY, round.gridHeight - 4); // 22

  const isSliverFreeKeepCoord = (ox: number, oy: number): boolean => {
    if (ox < keepMinX || ox > keepMaxX || oy < keepMinY || oy > keepMaxY) {
      return false;
    }
    // Forbid 3-tile cliff gaps where 2x2 walls cannot seal without a 1-tile edge leak
    if (ox === 3 || ox === round.gridWidth - 5) return false;
    if (oy === 3 || oy === round.gridHeight - 5) return false;
    return true;
  };

  const canPlaceStandaloneKeep = (ox: number, oy: number): boolean => {
    if (!isSliverFreeKeepCoord(ox, oy)) return false;
    if (!clearOfPads(ox, oy, allKeyPads)) return false;

    for (const s of round.preplacedSpires) {
      if (!hasTwoTileClearance(ox, oy, s.x, s.y)) return false;
    }
    for (const k of round.obstacles) {
      if (!hasTwoTileClearance(ox, oy, k.x, k.y)) return false;
    }
    return true;
  };

  const bastionMemberIndices = new Set<number>();

  const canPlaceFlushBastionPartner = (
    nx: number,
    ny: number,
    anchorIndex: number
  ): boolean => {
    if (bastionMemberIndices.has(anchorIndex)) return false; // Never chain 3 Keeps in a row
    if (!isSliverFreeKeepCoord(nx, ny)) return false;
    if (!clearOfPads(nx, ny, allKeyPads)) return false;

    for (const s of round.preplacedSpires) {
      if (!hasTwoTileClearance(nx, ny, s.x, s.y)) return false;
    }
    for (let i = 0; i < round.obstacles.length; i++) {
      const k = round.obstacles[i];
      if (do2x2Overlap(nx, ny, k.x, k.y)) return false;
      if (i !== anchorIndex && !hasTwoTileClearance(nx, ny, k.x, k.y)) {
        return false;
      }
    }
    return true;
  };

  const isWithinSpireBridgeBand = (ox: number, oy: number): boolean => {
    return round.preplacedSpires.some((s) => {
      const cheb = Math.max(Math.abs(ox - s.x), Math.abs(oy - s.y));
      const euclid = Math.hypot(ox - s.x, oy - s.y);
      return cheb >= 4 && cheb <= 7 && euclid >= 4.0 && euclid <= 7.6;
    });
  };

  // Precompute relative ring offsets (cheb in [4..7], euclid <= 8.4), prioritizing 4..6-tile 1-2 wall bridges
  const nearRingOffsets: GridPoint[] = [];
  const outerRingOffsets: GridPoint[] = [];
  for (let dy = -7; dy <= 7; dy++) {
    for (let dx = -7; dx <= 7; dx++) {
      const cheb = Math.max(Math.abs(dx), Math.abs(dy));
      const euclid = Math.hypot(dx, dy);
      if (cheb < 4 || cheb > 7 || euclid > 8.4) continue;
      if (cheb <= 6 && euclid <= 6.8) {
        nearRingOffsets.push({ x: dx, y: dy });
      } else {
        outerRingOffsets.push({ x: dx, y: dy });
      }
    }
  }

  // Pass A: Deterministic per-Spire round-robin so every Spire gets a reachable Keep anchor
  const spireOrder = shuffleInPlace(
    round.preplacedSpires.map((_, idx) => idx)
  );
  for (const sIdx of spireOrder) {
    if (round.obstacles.length >= round.obstacleCount) break;
    const spire = round.preplacedSpires[sIdx];

    const alreadyAnchored = round.obstacles.some(
      (k) => Math.hypot(k.x - spire.x, k.y - spire.y) <= 8.2
    );
    if (alreadyAnchored) continue;

    const ringTry = [
      ...shuffleInPlace([...nearRingOffsets]),
      ...shuffleInPlace([...outerRingOffsets]),
    ];

    for (const off of ringTry) {
      const ox = spire.x + off.x;
      const oy = spire.y + off.y;
      if (!canPlaceStandaloneKeep(ox, oy)) continue;

      round.obstacles.push({ x: ox, y: oy });
      if (computeFullMazePath(round, []).valid) {
        break;
      }
      round.obstacles.pop();
    }
  }

  // Pass B: Remaining Keeps — optional clean orthogonal 2-Keep bastions + Spire-bridge meadow slots
  const orthogonalBastionOffsets: GridPoint[] = [
    { x: 2, y: 0 },
    { x: -2, y: 0 },
    { x: 0, y: 2 },
    { x: 0, y: -2 },
  ];
  const maxBastionPairs =
    round.obstacleCount >= 7 ? 2 : round.obstacleCount >= 5 ? 1 : 0;
  let bastionPairsCreated = 0;

  if (
    bastionPairsCreated < maxBastionPairs &&
    round.obstacles.length < round.obstacleCount &&
    rng() < 0.45
  ) {
    const anchorIndices = shuffleInPlace(
      round.obstacles.map((_, idx) => idx)
    );
    for (const anchorIdx of anchorIndices) {
      if (
        bastionPairsCreated >= maxBastionPairs ||
        round.obstacles.length >= round.obstacleCount
      ) {
        break;
      }
      const anchor = round.obstacles[anchorIdx];
      const dirs = shuffleInPlace([...orthogonalBastionOffsets]);
      for (const off of dirs) {
        const nx = anchor.x + off.x;
        const ny = anchor.y + off.y;
        if (
          isWithinSpireBridgeBand(nx, ny) &&
          canPlaceFlushBastionPartner(nx, ny, anchorIdx)
        ) {
          round.obstacles.push({ x: nx, y: ny });
          if (computeFullMazePath(round, []).valid) {
            bastionMemberIndices.add(anchorIdx);
            bastionMemberIndices.add(round.obstacles.length - 1);
            bastionPairsCreated++;
            break;
          }
          round.obstacles.pop();
        }
      }
    }
  }

  if (round.obstacles.length < round.obstacleCount) {
    const bridgeCells: GridPoint[] = [];
    const openCells: GridPoint[] = [];
    for (let oy = keepMinY; oy <= keepMaxY; oy++) {
      for (let ox = keepMinX; ox <= keepMaxX; ox++) {
        if (!isSliverFreeKeepCoord(ox, oy)) continue;
        if (isWithinSpireBridgeBand(ox, oy)) {
          bridgeCells.push({ x: ox, y: oy });
        } else {
          openCells.push({ x: ox, y: oy });
        }
      }
    }
    const candidates = [
      ...shuffleInPlace(bridgeCells),
      ...shuffleInPlace(openCells),
    ];

    for (const cell of candidates) {
      if (round.obstacles.length >= round.obstacleCount) break;
      if (!canPlaceStandaloneKeep(cell.x, cell.y)) continue;
      round.obstacles.push({ x: cell.x, y: cell.y });
      if (!computeFullMazePath(round, []).valid) {
        round.obstacles.pop();
      }
    }

    // Fallback 2-Keep bastion partner (never chaining 3 Keeps) if standalone slots saturate
    for (
      let anchorIdx = 0;
      anchorIdx < round.obstacles.length &&
      round.obstacles.length < round.obstacleCount;
      anchorIdx++
    ) {
      const anchor = round.obstacles[anchorIdx];
      const dirs = shuffleInPlace([...orthogonalBastionOffsets]);
      for (const off of dirs) {
        const nx = anchor.x + off.x;
        const ny = anchor.y + off.y;
        if (canPlaceFlushBastionPartner(nx, ny, anchorIdx)) {
          round.obstacles.push({ x: nx, y: ny });
          if (computeFullMazePath(round, []).valid) {
            bastionMemberIndices.add(anchorIdx);
            bastionMemberIndices.add(round.obstacles.length - 1);
            break;
          }
          round.obstacles.pop();
        }
      }
    }
  }

  return round;
}

export const DAILY_BUILD_TIME_SECONDS = 120;
const DAILY_EPOCH_UTC_MS = Date.UTC(2026, 10, 1); // 2026-11-01 UTC -> Daily #1

export function getDailyDateKeyUtc(nowMs: number = Date.now()): string {
  const d = new Date(nowMs);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function getDailyPuzzleNumber(dateKey: string): number {
  const [yStr, mStr, dStr] = dateKey.split('-');
  const y = Number(yStr) || 2026;
  const m = (Number(mStr) || 11) - 1;
  const d = Number(dStr) || 1;
  const dayStartMs = Date.UTC(y, m, d);
  const diffDays = Math.floor((dayStartMs - DAILY_EPOCH_UTC_MS) / 86_400_000);
  return Math.max(1, diffDays + 1);
}

export function getNextDailyResetUtcMs(nowMs: number = Date.now()): number {
  const d = new Date(nowMs);
  return Date.UTC(
    d.getUTCFullYear(),
    d.getUTCMonth(),
    d.getUTCDate() + 1,
    0,
    0,
    0,
    0
  );
}

export function hashStringToSeed(input: string): number {
  let hash = 2166136261 >>> 0;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash === 0 ? 1 : hash;
}

/**
 * Generates today's global deterministic Daily Maze so every player worldwide
 * competes on the exact same map layout, runner, wall supply, and 120s build timer.
 */
export function generateDailyRoundConfig(dateKey?: string): {
  dateKey: string;
  puzzleNumber: number;
  roundConfig: RoundConfig;
} {
  const resolvedKey = dateKey || getDailyDateKeyUtc();
  const puzzleNumber = getDailyPuzzleNumber(resolvedKey);
  const seed = hashStringToSeed(`mazing-daily-v1:${resolvedKey}`);
  // Curated pool of rich mid-to-late templates (R2..R8) for engaging daily puzzles
  const pool = ROUNDS.slice(1);
  const templateIndex = (puzzleNumber - 1 + (seed % pool.length)) % pool.length;
  const baseTemplate = pool[templateIndex] || ROUNDS[2];

  const generated = generateRandomRoundLayout(baseTemplate, seed);
  generated.roundNumber = 1;
  generated.buildTimeSeconds = DAILY_BUILD_TIME_SECONDS;
  generated.title = `Daily #${puzzleNumber} · ${baseTemplate.title}`;

  return {
    dateKey: resolvedKey,
    puzzleNumber,
    roundConfig: generated,
  };
}
