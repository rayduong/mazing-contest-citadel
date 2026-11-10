import { computeFullMazePath, do2x2Overlap } from './pathfinding.js';
import { GridPoint, RoundConfig, SpireType } from './types.js';

export const GRID_WIDTH = 20;
export const GRID_HEIGHT = 26;

export const ROUNDS: RoundConfig[] = [
  {
    roundNumber: 1,
    title: 'Highland Citadel',
    subtitle: '2 Storm Spires · 9 Red Keep Pillars · Citadel Scout',
    hint: 'Connect your Castle Pillars to Red Keep Pillars to Overcharge nearby Spires (+Range, −Cooldown, +Slow Duration)!',
    runnerType: 'SCOUT',
    gridWidth: GRID_WIDTH,
    gridHeight: GRID_HEIGHT,
    buildTimeSeconds: 90,
    startingGold: 175,
    spawn: { x: 9, y: 0 },
    exit: { x: 9, y: 24 },
    checkpoints: [],
    obstacleCount: 9,
    spireCount: 2,
    frostMireCount: 0,
    hasteRiftCount: 0,
    obstacles: [],
    preplacedSpires: [],
    frostMires: [],
    hasteRifts: [],
    parTimeSeconds: 46.0,
  },
  {
    roundNumber: 2,
    title: 'Permafrost Bastion',
    subtitle: '2 Storm · 1 Frost Obelisk · Royal Outrider',
    hint: 'Wrap a tight 360° spiral around the blue Frost Obelisk (-22% continuous aura + 45% Glacial Nova)! Outriders take +25% longer slows.',
    runnerType: 'OUTRIDER',
    gridWidth: GRID_WIDTH,
    gridHeight: GRID_HEIGHT,
    buildTimeSeconds: 95,
    startingGold: 185,
    spawn: { x: 4, y: 0 },
    exit: { x: 14, y: 24 },
    checkpoints: [],
    obstacleCount: 10,
    spireCount: 3,
    frostMireCount: 0,
    hasteRiftCount: 0,
    obstacles: [],
    preplacedSpires: [],
    frostMires: [],
    hasteRifts: [],
    parTimeSeconds: 56.0,
  },
  {
    roundNumber: 3,
    title: 'The Royal Courtyard',
    subtitle: '2 Storm · 1 Frost Obelisk · 11 Red Keep Pillars',
    hint: 'East-to-West border gates! Chain diagonal Castle Pillars across Red Keep Pillars to reach Tier 3 Spire Overcharge.',
    runnerType: 'SCOUT',
    gridWidth: GRID_WIDTH,
    gridHeight: GRID_HEIGHT,
    buildTimeSeconds: 100,
    startingGold: 190,
    spawn: { x: 14, y: 0 },
    exit: { x: 4, y: 24 },
    checkpoints: [],
    obstacleCount: 11,
    spireCount: 3,
    frostMireCount: 0,
    hasteRiftCount: 0,
    obstacles: [],
    preplacedSpires: [],
    frostMires: [],
    hasteRifts: [],
    parTimeSeconds: 64.0,
  },
  {
    roundNumber: 4,
    title: 'Chrono Sanctum',
    subtitle: '2 Storm · 1 Frost · 1 Chrono Spire · Wind Herald',
    hint: 'The violet Chrono Spire reduces all other Spires’ cooldowns by 1.2s! Space Spire passes evenly to stop Wind Herald Tailwind Haste.',
    runnerType: 'HERALD',
    gridWidth: GRID_WIDTH,
    gridHeight: GRID_HEIGHT,
    buildTimeSeconds: 105,
    startingGold: 200,
    spawn: { x: 3, y: 0 },
    exit: { x: 3, y: 24 },
    checkpoints: [],
    obstacleCount: 11,
    spireCount: 4,
    frostMireCount: 0,
    hasteRiftCount: 0,
    obstacles: [],
    preplacedSpires: [],
    frostMires: [],
    hasteRifts: [],
    parTimeSeconds: 72.0,
  },
  {
    roundNumber: 5,
    title: 'Red Keep Gauntlet',
    subtitle: '2 Storm · 1 Frost · 1 Chrono · Iron Juggernaut',
    hint: 'Iron Juggernaut resists 20% slow unless hit by an Overcharged Spire! Link Red Keep Pillars into your Spire corridors to pierce its armor.',
    runnerType: 'JUGGERNAUT',
    gridWidth: GRID_WIDTH,
    gridHeight: GRID_HEIGHT,
    buildTimeSeconds: 100,
    startingGold: 165,
    spawn: { x: 9, y: 0 },
    exit: { x: 9, y: 24 },
    checkpoints: [],
    obstacleCount: 14,
    spireCount: 4,
    frostMireCount: 0,
    hasteRiftCount: 0,
    obstacles: [],
    preplacedSpires: [],
    frostMires: [],
    hasteRifts: [],
    parTimeSeconds: 70.0,
  },
  {
    roundNumber: 6,
    title: 'Citadel Crosswinds',
    subtitle: '2 Storm · 1 Frost · 1 Chrono · Royal Outrider',
    hint: 'West-Flank to East-Flank border gates! Chain Chrono Spire cooldown resets into Frost Obelisk spirals.',
    runnerType: 'OUTRIDER',
    gridWidth: GRID_WIDTH,
    gridHeight: GRID_HEIGHT,
    buildTimeSeconds: 110,
    startingGold: 210,
    spawn: { x: 15, y: 0 },
    exit: { x: 15, y: 24 },
    checkpoints: [],
    obstacleCount: 12,
    spireCount: 4,
    frostMireCount: 0,
    hasteRiftCount: 0,
    obstacles: [],
    preplacedSpires: [],
    frostMires: [],
    hasteRifts: [],
    parTimeSeconds: 78.0,
  },
  {
    roundNumber: 7,
    title: 'Lordaeron Highlands',
    subtitle: '2 Storm · 2 Frost · 1 Chrono · Iron Juggernaut',
    hint: 'Five Spires! Anchor your Castle Pillars to Red Keep Pillars around every Spire to shatter the Juggernaut’s armor.',
    runnerType: 'JUGGERNAUT',
    gridWidth: GRID_WIDTH,
    gridHeight: GRID_HEIGHT,
    buildTimeSeconds: 115,
    startingGold: 220,
    spawn: { x: 3, y: 0 },
    exit: { x: 15, y: 24 },
    checkpoints: [],
    obstacleCount: 12,
    spireCount: 5,
    frostMireCount: 0,
    hasteRiftCount: 0,
    obstacles: [],
    preplacedSpires: [],
    frostMires: [],
    hasteRifts: [],
    parTimeSeconds: 86.0,
  },
  {
    roundNumber: 8,
    title: 'Grandmaster Citadel',
    subtitle: '2 Storm · 2 Frost · 1 Chrono · Wind Herald',
    hint: 'The Ultimate Trial: 47 Castle Pillars, 14 Red Keep Pillars, and 5 Elemental Spires against the Wind Herald!',
    runnerType: 'HERALD',
    gridWidth: GRID_WIDTH,
    gridHeight: GRID_HEIGHT,
    buildTimeSeconds: 120,
    startingGold: 235,
    spawn: { x: 9, y: 0 },
    exit: { x: 9, y: 24 },
    checkpoints: [],
    obstacleCount: 14,
    spireCount: 5,
    frostMireCount: 0,
    hasteRiftCount: 0,
    obstacles: [],
    preplacedSpires: [],
    frostMires: [],
    hasteRifts: [],
    parTimeSeconds: 94.0,
  },
];

function getSpireArchetypeForSlot(roundNumber: number, slotIndex: number): SpireType {
  if (roundNumber === 1) return 'THUNDERCLAP';
  if (roundNumber <= 3) {
    return slotIndex === 1 ? 'FROST_OBELISK' : 'THUNDERCLAP';
  }
  const pattern: SpireType[] = [
    'THUNDERCLAP',
    'FROST_OBELISK',
    'CHRONO_SPIRE',
    'THUNDERCLAP',
    'FROST_OBELISK',
  ];
  return pattern[slotIndex % pattern.length];
}

/**
 * Generates a spacious 20x26 procedural layout of 2x2 Elemental Spires (Storm, Frost, Chrono)
 * and Pre-placed Crimson Keep Pillars (including orthogonal, diagonal, and half-tile angled formations),
 * with zero reserved terrain pads on the grass floor.
 */
export function generateRandomRoundLayout(baseRound: RoundConfig): RoundConfig {
  const round: RoundConfig = {
    ...baseRound,
    checkpoints: [],
    obstacles: [],
    preplacedSpires: [],
    frostMires: [],
    hasteRifts: [],
    waygate: undefined,
  };

  const keyPads: GridPoint[] = [round.spawn, round.exit];

  const isTooCloseToKeyPad = (x: number, y: number, minBuffer: number): boolean => {
    for (const pad of keyPads) {
      if (
        x < pad.x + 2 + minBuffer &&
        x + 2 + minBuffer > pad.x &&
        y < pad.y + 2 + minBuffer &&
        y + 2 + minBuffer > pad.y
      ) {
        return true;
      }
    }
    return false;
  };

  const overlapsAnyFeature = (x: number, y: number): boolean => {
    if (x < 0 || y < 0 || x + 2 > round.gridWidth || y + 2 > round.gridHeight) {
      return true;
    }
    for (const s of round.preplacedSpires) {
      if (do2x2Overlap(x, y, s.x, s.y)) return true;
    }
    for (const o of round.obstacles) {
      if (do2x2Overlap(x, y, o.x, o.y)) return true;
    }
    return false;
  };

  // 1. Allocate Random 2x2 Elemental Map Spires in the interior with generous breathing room
  let spireAttempts = 0;
  while (
    round.preplacedSpires.length < round.spireCount &&
    spireAttempts < 280
  ) {
    spireAttempts++;
    const sx = 3 + Math.floor(Math.random() * (round.gridWidth - 7));
    const sy = 4 + Math.floor(Math.random() * (round.gridHeight - 9));

    if (isTooCloseToKeyPad(sx, sy, 2)) continue;
    if (overlapsAnyFeature(sx, sy)) continue;

    const tooCloseToOtherSpire = round.preplacedSpires.some(
      (other) => Math.hypot(other.x - sx, other.y - sy) < 4.8
    );
    if (tooCloseToOtherSpire && spireAttempts < 190) continue;

    const slotIdx = round.preplacedSpires.length;
    const spireType = getSpireArchetypeForSlot(round.roundNumber, slotIdx);
    round.preplacedSpires.push({ x: sx, y: sy, spireType });
    const checkPath = computeFullMazePath(round, []);
    if (!checkPath.valid) {
      round.preplacedSpires.pop();
    }
  }

  // 2. Allocate Pre-placed Crimson Keep Pillars (singles, orthogonal pairs, and diagonal/angled pairs)
  const neighborOffsets = [
    { dx: 2, dy: 0 },
    { dx: -2, dy: 0 },
    { dx: 0, dy: 2 },
    { dx: 0, dy: -2 },
    { dx: 2, dy: 2 },
    { dx: -2, dy: 2 },
    { dx: 2, dy: -2 },
    { dx: -2, dy: -2 },
    { dx: 2, dy: 1 },
    { dx: -2, dy: 1 },
    { dx: 1, dy: 2 },
    { dx: 1, dy: -2 },
  ];

  let obsAttempts = 0;
  while (
    round.obstacles.length < round.obstacleCount &&
    obsAttempts < 340
  ) {
    obsAttempts++;
    const ox = 1 + Math.floor(Math.random() * (round.gridWidth - 3));
    const oy = 2 + Math.floor(Math.random() * (round.gridHeight - 5));

    if (isTooCloseToKeyPad(ox, oy, 1)) continue;
    if (overlapsAnyFeature(ox, oy)) continue;

    // Leave gap around Storm Spires so corridors can wrap around Spires
    const smothersSpire = round.preplacedSpires.some(
      (s) => Math.abs(s.x - ox) <= 2 && Math.abs(s.y - oy) <= 2
    );
    if (smothersSpire && obsAttempts < 240) continue;

    round.obstacles.push({ x: ox, y: oy });
    if (!computeFullMazePath(round, []).valid) {
      round.obstacles.pop();
      continue;
    }

    // 50% chance to extend this Crimson Keep Pillar in any direction (orthogonal, diagonal, or half-tile angled)
    if (
      round.obstacles.length < round.obstacleCount &&
      Math.random() < 0.5
    ) {
      const off =
        neighborOffsets[Math.floor(Math.random() * neighborOffsets.length)];
      const nx = ox + off.dx;
      const ny = oy + off.dy;

      if (
        !isTooCloseToKeyPad(nx, ny, 1) &&
        !overlapsAnyFeature(nx, ny) &&
        !round.preplacedSpires.some(
          (s) => Math.abs(s.x - nx) <= 2 && Math.abs(s.y - ny) <= 2
        )
      ) {
        round.obstacles.push({ x: nx, y: ny });
        if (!computeFullMazePath(round, []).valid) {
          round.obstacles.pop();
        }
      }
    }
  }

  return round;
}
