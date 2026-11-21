import { computeFullMazePath, do2x2Overlap } from './pathfinding.js';
import { GridPoint, RoundConfig, SpireType } from './types.js';

export const GRID_WIDTH = 20;
export const GRID_HEIGHT = 26;

export const ROUNDS: RoundConfig[] = [
  {
    roundNumber: 1,
    title: 'Meadow Gate',
    subtitle: '2 Storm Spires · 4 Crimson Keeps · Citadel Scout',
    hint: 'Fold switchbacks past both Storm Spires. Link a Crimson Keep into your wall to boost Spire range and recharge.',
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
    subtitle: '1 Storm · 2 Frost Obelisks · 4 Keeps · Royal Outrider',
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
    subtitle: '2 Storm · 1 Frost Obelisk · 5 Keeps · Citadel Scout',
    hint: 'Northeast to Southwest gates create a long diagonal. Chain three Crimson Keeps into one wall for max Overcharge.',
    runnerType: 'SCOUT',
    gridWidth: GRID_WIDTH,
    gridHeight: GRID_HEIGHT,
    buildTimeSeconds: 100,
    startingGold: 165,
    spawn: { x: 14, y: 0 },
    exit: { x: 4, y: 24 },
    checkpoints: [],
    obstacleCount: 5,
    spireCount: 3,
    frostMireCount: 0,
    hasteRiftCount: 0,
    obstacles: [],
    preplacedSpires: [],
    frostMires: [],
    hasteRifts: [],
    parTimeSeconds: 39.0,
  },
  {
    roundNumber: 4,
    title: 'Westwall Relay',
    subtitle: '2 Storm · 1 Frost · 1 Chrono Spire · 5 Keeps · Wind Herald',
    hint: 'Both gates hug the west edge. Space your Spire passes evenly so the Wind Herald never builds Tailwind speed.',
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
    parTimeSeconds: 43.0,
  },
  {
    roundNumber: 5,
    title: 'Iron Bastion',
    subtitle: '2 Storm · 1 Frost · 1 Chrono · 7 Keeps · Iron Juggernaut',
    hint: 'Uncharged Spires lose 20% slow against Juggernaut armor. Link at least one Crimson Keep into every Spire corridor.',
    runnerType: 'JUGGERNAUT',
    gridWidth: GRID_WIDTH,
    gridHeight: GRID_HEIGHT,
    buildTimeSeconds: 105,
    startingGold: 160,
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
    parTimeSeconds: 45.0,
  },
  {
    roundNumber: 6,
    title: 'Eastwall Spiral',
    subtitle: '1 Storm · 2 Frost · 1 Chrono · 5 Keeps · Royal Outrider',
    hint: 'Each Chrono pulse shaves 1.2s off every other Spire. Route through the Chrono ring right before your Frost spirals.',
    runnerType: 'OUTRIDER',
    gridWidth: GRID_WIDTH,
    gridHeight: GRID_HEIGHT,
    buildTimeSeconds: 110,
    startingGold: 190,
    spawn: { x: 15, y: 0 },
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
    parTimeSeconds: 49.0,
  },
  {
    roundNumber: 7,
    title: 'Twin-Chrono Ridge',
    subtitle: '2 Storm · 1 Frost · 2 Chrono · 6 Keeps · Iron Juggernaut',
    hint: 'Two Chrono Spires recharge each other rapidly. Overcharge your central wall network to pierce Juggernaut armor.',
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
    parTimeSeconds: 55.0,
  },
  {
    roundNumber: 8,
    title: 'The High Citadel',
    subtitle: '2 Storm · 2 Frost · 1 Chrono · 6 Keeps · Wind Herald',
    hint: 'Final round. Guide the Wind Herald across all five Spires without leaving a 3-second sprint gap on the route.',
    runnerType: 'HERALD',
    gridWidth: GRID_WIDTH,
    gridHeight: GRID_HEIGHT,
    buildTimeSeconds: 120,
    startingGold: 220,
    spawn: { x: 9, y: 0 },
    exit: { x: 9, y: 24 },
    checkpoints: [],
    obstacleCount: 6,
    spireCount: 5,
    frostMireCount: 0,
    hasteRiftCount: 0,
    obstacles: [],
    preplacedSpires: [],
    frostMires: [],
    hasteRifts: [],
    parTimeSeconds: 58.0,
  },
];

const ROUND_SPIRE_ARCHETYPES: Record<number, SpireType[]> = {
  1: ['THUNDERCLAP', 'THUNDERCLAP'],
  2: ['FROST_OBELISK', 'THUNDERCLAP', 'FROST_OBELISK'],
  3: ['THUNDERCLAP', 'FROST_OBELISK', 'THUNDERCLAP'],
  4: ['THUNDERCLAP', 'CHRONO_SPIRE', 'FROST_OBELISK', 'THUNDERCLAP'],
  5: ['THUNDERCLAP', 'FROST_OBELISK', 'CHRONO_SPIRE', 'THUNDERCLAP'],
  6: ['CHRONO_SPIRE', 'FROST_OBELISK', 'THUNDERCLAP', 'FROST_OBELISK'],
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
 * Scales a round's base Par target by the room's Wall Supply multiplier:
 * - 0.80x (80%)   -> 0.86x Par
 * - 1.00x (Normal)-> 1.00x Par
 * - 1.25x (125%)  -> 1.12x Par
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

  let scale = 1.0;
  if (Math.abs(mult - 1.0) < 0.005) {
    scale = 1.0;
  } else if (Math.abs(mult - 0.8) < 0.005) {
    scale = 0.86;
  } else if (Math.abs(mult - 1.25) < 0.005) {
    scale = 1.12;
  } else if (mult < 1.0) {
    scale = Math.max(0.6, 1.0 - ((1.0 - mult) * 0.14) / 0.2);
  } else {
    scale = Math.min(1.35, 1.0 + ((mult - 1.0) * 0.12) / 0.25);
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
  const minY = 4;
  const maxY = Math.max(minY, gridHeight - 6); // 20 on height 26

  const leftRange: [number, number] = [minX, Math.min(maxX, minX + 3)]; // [4..7]
  const centerRange: [number, number] = [
    Math.max(minX, Math.floor(gridWidth / 2) - 3),
    Math.min(maxX, Math.floor(gridWidth / 2) + 1),
  ]; // [7..11]
  const rightRange: [number, number] = [Math.max(minX, maxX - 3), maxX]; // [11..14]

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

  // 5+ Spires: alternating L -> R -> C -> L -> R down [4..20]
  const pattern: Array<'L' | 'C' | 'R'> = ['L', 'R', 'C', 'L', 'R'];
  const yBands: Array<[number, number]> = [
    [4, 6],
    [7, 9],
    [11, 13],
    [15, 17],
    [18, 20],
  ];

  const bands: SpireZoneBand[] = [];
  for (let i = 0; i < spireCount; i++) {
    const [xMin, xMax] = pickLateral(pattern[i % pattern.length]);
    const [yMin, yMax] = yBands[Math.min(i, yBands.length - 1)];
    bands.push({
      yMin: Math.max(minY, yMin),
      yMax: Math.min(maxY, yMax),
      xMin,
      xMax,
    });
  }
  return bands;
}

/**
 * Generates a deterministic, sliver-free 20x26 layout of 2x2 Elemental Spires
 * and 4-7 Crimson Keeps using `mulberry32(seed)`.
 * - Spires sit within x in [4..14], y in [4..20] across longitudinal bands so full 360-degree
 *   1-tile corridor wraps and 2x2 outer walls always fit cleanly.
 * - Keeps sit within x in [2..16], y in [3..21], either forming clean orthogonal 2-block
 *   bastions (gap = 0) or keeping >= 2 walkable tiles of clearance from all structures and borders.
 * - >= 60% of Crimson Keeps spawn within 4-7 tiles of a Spire for readable Overcharge routing.
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

  const keyPads: GridPoint[] = [round.spawn, round.exit];

  const clearOfKeyPads = (x: number, y: number): boolean => {
    for (const pad of keyPads) {
      if (!hasTwoTileClearance(x, y, pad.x, pad.y)) {
        return false;
      }
    }
    return true;
  };

  // 1. Stratified 2x2 Elemental Spires across longitudinal bands (x in [4..14], y in [4..20])
  const spireMinX = 4;
  const spireMaxX = Math.max(spireMinX, round.gridWidth - 6);
  const spireMinY = 4;
  const spireMaxY = Math.max(spireMinY, round.gridHeight - 6);
  const mirrorX = rng() < 0.5;
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
    if (!clearOfKeyPads(sx, sy)) return false;

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
    let placed = false;

    // Pass A: Stratified longitudinal + lateral zone candidate sampling
    for (let attempt = 0; attempt < 90 && !placed; attempt++) {
      const sx = randInt(band.xMin, band.xMax);
      const sy = randInt(band.yMin, band.yMax);
      if (!canPlaceSpireAt(sx, sy, 5.2)) continue;

      round.preplacedSpires.push({ x: sx, y: sy, spireType });
      if (computeFullMazePath(round, []).valid) {
        placed = true;
      } else {
        round.preplacedSpires.pop();
      }
    }

    // Pass B: Full-interior fallback preserving strict >= 2-tile clearance & safe wrap bounds
    for (let attempt = 0; attempt < 180 && !placed; attempt++) {
      const sx = randInt(spireMinX, spireMaxX);
      const sy = randInt(spireMinY, spireMaxY);
      const minDist = attempt < 100 ? 5.0 : 4.2;
      if (!canPlaceSpireAt(sx, sy, minDist)) continue;

      round.preplacedSpires.push({ x: sx, y: sy, spireType });
      if (computeFullMazePath(round, []).valid) {
        placed = true;
      } else {
        round.preplacedSpires.pop();
      }
    }
  }

  // 2. Crimson Keeps (x in [2..16], y in [3..21]), zero 1-tile slivers, >= 60% within 4-7 tiles of a Spire
  const keepMinX = 2;
  const keepMaxX = Math.max(keepMinX, round.gridWidth - 4);
  const keepMinY = 3;
  const keepMaxY = Math.max(keepMinY, round.gridHeight - 5);

  const canPlaceStandaloneKeep = (ox: number, oy: number): boolean => {
    if (ox < keepMinX || ox > keepMaxX || oy < keepMinY || oy > keepMaxY) {
      return false;
    }
    if (!clearOfKeyPads(ox, oy)) return false;

    for (const s of round.preplacedSpires) {
      if (!hasTwoTileClearance(ox, oy, s.x, s.y)) return false;
    }
    for (const k of round.obstacles) {
      if (!hasTwoTileClearance(ox, oy, k.x, k.y)) return false;
    }
    return true;
  };

  const canPlaceFlushBastionPartner = (
    nx: number,
    ny: number,
    anchorIndex: number
  ): boolean => {
    if (nx < keepMinX || nx > keepMaxX || ny < keepMinY || ny > keepMaxY) {
      return false;
    }
    if (!clearOfKeyPads(nx, ny)) return false;

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
      return cheb >= 4 && cheb <= 7 && euclid >= 4.0 && euclid <= 7.0;
    });
  };

  const orthogonalBastionOffsets: GridPoint[] = [
    { x: 2, y: 0 },
    { x: -2, y: 0 },
    { x: 0, y: 2 },
    { x: 0, y: -2 },
  ];

  const maxBastionPairs = round.obstacleCount >= 7 ? 2 : round.obstacleCount >= 5 ? 1 : 0;
  let bastionPairsCreated = 0;

  // Pass A: Place Spire-proximate Crimson Keeps (4-7 tiles from rotating Spires)
  const targetBridgeKeeps = Math.min(
    round.obstacleCount,
    Math.max(Math.ceil(round.obstacleCount * 0.75), 3)
  );

  let bridgeAttempts = 0;
  while (
    round.obstacles.length < targetBridgeKeeps &&
    round.preplacedSpires.length > 0 &&
    bridgeAttempts < 320
  ) {
    bridgeAttempts++;
    const spire =
      round.preplacedSpires[
        (round.obstacles.length + bridgeAttempts) % round.preplacedSpires.length
      ];
    const dx = randInt(-6, 6);
    const dy = randInt(-6, 6);
    const ox = spire.x + dx;
    const oy = spire.y + dy;

    const cheb = Math.max(Math.abs(dx), Math.abs(dy));
    const euclid = Math.hypot(dx, dy);
    if (cheb < 4 || cheb > 7 || euclid > 7.0) continue;
    if (!canPlaceStandaloneKeep(ox, oy)) continue;

    round.obstacles.push({ x: ox, y: oy });
    if (!computeFullMazePath(round, []).valid) {
      round.obstacles.pop();
      continue;
    }

    // Optional clean orthogonal 2-block Keep bastion (gap = 0, zero half-tile staggers)
    if (
      bastionPairsCreated < maxBastionPairs &&
      round.obstacles.length < round.obstacleCount &&
      rng() < 0.35
    ) {
      const anchorIdx = round.obstacles.length - 1;
      const startOff = randInt(0, orthogonalBastionOffsets.length - 1);
      for (let k = 0; k < orthogonalBastionOffsets.length; k++) {
        const off =
          orthogonalBastionOffsets[(startOff + k) % orthogonalBastionOffsets.length];
        const nx = ox + off.x;
        const ny = oy + off.y;
        if (
          isWithinSpireBridgeBand(nx, ny) &&
          canPlaceFlushBastionPartner(nx, ny, anchorIdx)
        ) {
          round.obstacles.push({ x: nx, y: ny });
          if (computeFullMazePath(round, []).valid) {
            bastionPairsCreated++;
            break;
          } else {
            round.obstacles.pop();
          }
        }
      }
    }
  }

  // Pass B: Fill remaining Keeps cleanly across the meadow (preferring Spire-bridge band first)
  let fillAttempts = 0;
  while (round.obstacles.length < round.obstacleCount && fillAttempts < 400) {
    fillAttempts++;
    const ox = randInt(keepMinX, keepMaxX);
    const oy = randInt(keepMinY, keepMaxY);

    if (fillAttempts < 220 && !isWithinSpireBridgeBand(ox, oy)) continue;
    if (!canPlaceStandaloneKeep(ox, oy)) continue;

    round.obstacles.push({ x: ox, y: oy });
    if (!computeFullMazePath(round, []).valid) {
      round.obstacles.pop();
    }
  }

  // Pass C: Deterministic shuffled grid sweep so rare dense seeds still hit exact obstacleCount
  if (round.obstacles.length < round.obstacleCount) {
    const remainingCells: GridPoint[] = [];
    for (let oy = keepMinY; oy <= keepMaxY; oy++) {
      for (let ox = keepMinX; ox <= keepMaxX; ox++) {
        remainingCells.push({ x: ox, y: oy });
      }
    }
    for (let i = remainingCells.length - 1; i > 0; i--) {
      const j = randInt(0, i);
      const tmp = remainingCells[i];
      remainingCells[i] = remainingCells[j];
      remainingCells[j] = tmp;
    }

    for (const cell of remainingCells) {
      if (round.obstacles.length >= round.obstacleCount) break;
      if (!canPlaceStandaloneKeep(cell.x, cell.y)) continue;
      round.obstacles.push({ x: cell.x, y: cell.y });
      if (!computeFullMazePath(round, []).valid) {
        round.obstacles.pop();
      }
    }

    // Fallback orthogonal 2-block bastion partner if standalone slots are saturated
    for (
      let anchorIdx = 0;
      anchorIdx < round.obstacles.length &&
      round.obstacles.length < round.obstacleCount;
      anchorIdx++
    ) {
      const anchor = round.obstacles[anchorIdx];
      for (const off of orthogonalBastionOffsets) {
        const nx = anchor.x + off.x;
        const ny = anchor.y + off.y;
        if (canPlaceFlushBastionPartner(nx, ny, anchorIdx)) {
          round.obstacles.push({ x: nx, y: ny });
          if (computeFullMazePath(round, []).valid) {
            break;
          } else {
            round.obstacles.pop();
          }
        }
      }
    }
  }

  return round;
}
