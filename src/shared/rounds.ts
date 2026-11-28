import { computeFullMazePath, do2x2Overlap } from './pathfinding.js';
import {
  ALL_RUNNER_ARCHETYPES,
  GridPoint,
  INFINITE_BUILD_TIME,
  INFINITE_ROUNDS,
  MapKeepStyle,
  MapLayoutPattern,
  RoundConfig,
  RUNNER_ARCHETYPES,
  RunnerArchetype,
  SpireType,
  WaystoneLayoutStyle,
} from './types.js';

export const GRID_WIDTH = 20;
export const GRID_HEIGHT = 26;
export const CLASSIC_ROUND_COUNT = 8;
export const DEFAULT_MATCH_ROUNDS = 8;

interface NewMapDef {
  mapId: number;
  title: string;
  hint: string;
  runnerType: RunnerArchetype;
  spireTypes: SpireType[];
  obstacleCount: number;
  waystoneCount?: 0 | 1 | 2;
  waystoneStyle?: WaystoneLayoutStyle;
  layoutPattern: MapLayoutPattern;
  keepStyle?: MapKeepStyle;
  spawn: GridPoint;
  exit: GridPoint;
  startingGold: number;
  buildTimeSeconds: number;
  parTimeSeconds: number;
}

function buildMapSubtitle(
  spireTypes: SpireType[],
  obstacleCount: number,
  waystoneCount: number,
  runnerType: RunnerArchetype
): string {
  const storm = spireTypes.filter((s) => s === 'THUNDERCLAP').length;
  const frost = spireTypes.filter((s) => s === 'FROST_OBELISK').length;
  const chrono = spireTypes.filter((s) => s === 'CHRONO_SPIRE').length;
  const parts: string[] = [];
  if (storm > 0) parts.push(`${storm} Storm`);
  if (frost > 0) parts.push(`${frost} Frost`);
  if (chrono > 0) parts.push(`${chrono} Chrono`);
  parts.push(`${obstacleCount} ${obstacleCount === 1 ? 'Keep' : 'Keeps'}`);
  if (waystoneCount > 0) {
    parts.push(
      `${waystoneCount} ${waystoneCount === 1 ? 'Waystone' : 'Waystones'}`
    );
  }
  parts.push(RUNNER_ARCHETYPES[runnerType].name);
  return parts.join(' · ');
}

function defineMap(def: NewMapDef): RoundConfig {
  const waystoneCount = def.waystoneCount ?? 0;
  const placeholderCheckpoints: GridPoint[] =
    waystoneCount === 0
      ? []
      : waystoneCount === 1
      ? [{ x: 9, y: 12 }]
      : [
          { x: 5, y: 8 },
          { x: 13, y: 16 },
        ];

  return {
    roundNumber: def.mapId,
    mapId: def.mapId,
    title: def.title,
    subtitle: buildMapSubtitle(
      def.spireTypes,
      def.obstacleCount,
      waystoneCount,
      def.runnerType
    ),
    hint: def.hint,
    runnerType: def.runnerType,
    spireTypes: [...def.spireTypes],
    layoutPattern: def.layoutPattern,
    keepStyle: def.keepStyle ?? 'DEFAULT',
    waystoneStyle: def.waystoneStyle ?? 'DEFAULT',
    gridWidth: GRID_WIDTH,
    gridHeight: GRID_HEIGHT,
    buildTimeSeconds: def.buildTimeSeconds,
    startingGold: def.startingGold,
    spawn: { ...def.spawn },
    exit: { ...def.exit },
    checkpoints: placeholderCheckpoints,
    obstacleCount: def.obstacleCount,
    spireCount: def.spireTypes.length,
    frostMireCount: 0,
    hasteRiftCount: 0,
    obstacles: [],
    preplacedSpires: [],
    frostMires: [],
    hasteRifts: [],
    parTimeSeconds: def.parTimeSeconds,
  };
}

const CLASSIC_ROUNDS: RoundConfig[] = [
  {
    roundNumber: 1,
    mapId: 1,
    title: 'Meadow Gate',
    subtitle: '2 Storm · 4 Keeps · Citadel Scout',
    hint: 'Fold switchbacks past both Storm Spires. Link a Crimson Keep into your wall within 1 tile of a Spire to Overcharge it.',
    runnerType: 'SCOUT',
    spireTypes: ['THUNDERCLAP', 'THUNDERCLAP'],
    layoutPattern: 'CLASSIC',
    keepStyle: 'DEFAULT',
    waystoneStyle: 'DEFAULT',
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
    mapId: 2,
    title: 'Frostbend Crossing',
    subtitle: '1 Storm · 2 Frost · 4 Keeps · Royal Outrider',
    hint: 'Outriders sprint fast on open grass, but slows last 25% longer. Wrap tight turns around both Frost Obelisks.',
    runnerType: 'OUTRIDER',
    spireTypes: ['FROST_OBELISK', 'THUNDERCLAP', 'FROST_OBELISK'],
    layoutPattern: 'CLASSIC',
    keepStyle: 'DEFAULT',
    waystoneStyle: 'DEFAULT',
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
    mapId: 3,
    title: 'Switchback Court',
    subtitle: '2 Storm · 1 Frost · 5 Keeps · 1 Waystone · Citadel Scout',
    hint: 'Runners must visit the Waystone before the South Shrine. Chain three Crimson Keeps into one wall for max Overcharge.',
    runnerType: 'SCOUT',
    spireTypes: ['THUNDERCLAP', 'FROST_OBELISK', 'THUNDERCLAP'],
    layoutPattern: 'CLASSIC',
    keepStyle: 'DEFAULT',
    waystoneStyle: 'DEFAULT',
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
    mapId: 4,
    title: 'Westwall Relay',
    subtitle: '2 Storm · 1 Frost · 1 Chrono · 5 Keeps · Wind Herald',
    hint: 'Both gates hug the west cliff. Space your Spire passes under 3.2 seconds apart so the Wind Herald never triggers Tailwind.',
    runnerType: 'HERALD',
    spireTypes: ['THUNDERCLAP', 'FROST_OBELISK', 'CHRONO_SPIRE', 'THUNDERCLAP'],
    layoutPattern: 'CLASSIC',
    keepStyle: 'DEFAULT',
    waystoneStyle: 'DEFAULT',
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
    mapId: 5,
    title: 'Iron Bastion',
    subtitle: '2 Storm · 1 Frost · 1 Chrono · 7 Keeps · Iron Juggernaut',
    hint: 'Juggernaut armor blocks a fifth of uncharged slows. Use the seven Crimson Keeps as anchors and Overcharge every Spire.',
    runnerType: 'JUGGERNAUT',
    spireTypes: ['THUNDERCLAP', 'FROST_OBELISK', 'CHRONO_SPIRE', 'THUNDERCLAP'],
    layoutPattern: 'CLASSIC',
    keepStyle: 'DEFAULT',
    waystoneStyle: 'DEFAULT',
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
    mapId: 6,
    title: 'Crosswind Spiral',
    subtitle:
      '1 Storm · 2 Frost · 1 Chrono · 5 Keeps · 1 Waystone · Royal Outrider',
    hint: 'Route past Storm and Frost on the way to the Waystone, then trigger the Chrono Spire to cut 1.2s off active cooldowns.',
    runnerType: 'OUTRIDER',
    spireTypes: ['FROST_OBELISK', 'THUNDERCLAP', 'CHRONO_SPIRE', 'FROST_OBELISK'],
    layoutPattern: 'CLASSIC',
    keepStyle: 'DEFAULT',
    waystoneStyle: 'DEFAULT',
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
    mapId: 7,
    title: 'Twin Chrono Ridge',
    subtitle: '2 Storm · 1 Frost · 2 Chrono · 6 Keeps · Iron Juggernaut',
    hint: 'Two Chrono Spires cut 1.2s off each other on every pulse. Overcharge your central wall network to pierce Juggernaut armor.',
    runnerType: 'JUGGERNAUT',
    spireTypes: [
      'THUNDERCLAP',
      'CHRONO_SPIRE',
      'FROST_OBELISK',
      'CHRONO_SPIRE',
      'THUNDERCLAP',
    ],
    layoutPattern: 'CLASSIC',
    keepStyle: 'DEFAULT',
    waystoneStyle: 'DEFAULT',
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
    mapId: 8,
    title: 'The High Citadel',
    subtitle:
      '2 Storm · 2 Frost · 1 Chrono · 6 Keeps · 1 Waystone · Wind Herald',
    hint: 'Final round. Route the Wind Herald through the Waystone and all five Spires without leaving a 3.2-second Tailwind gap.',
    runnerType: 'HERALD',
    spireTypes: [
      'THUNDERCLAP',
      'FROST_OBELISK',
      'CHRONO_SPIRE',
      'FROST_OBELISK',
      'THUNDERCLAP',
    ],
    layoutPattern: 'CLASSIC',
    keepStyle: 'DEFAULT',
    waystoneStyle: 'DEFAULT',
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

// 50 New Hand-Crafted Maps (Map #9 .. Map #58)
const EXPANSION_MAPS: RoundConfig[] = [
  // A. Agile & Precision Tactical Arenas (#9 - #18)
  defineMap({
    mapId: 9,
    title: 'Sunstone Pass',
    hint: 'Both Frost Obelisks anchor the center spine while gates hug the west cliff. Swing east and spiral around each glacier ring.',
    runnerType: 'SCOUT',
    spireTypes: ['FROST_OBELISK', 'FROST_OBELISK'],
    obstacleCount: 4,
    layoutPattern: 'CENTER_SPINE',
    keepStyle: 'DEFAULT',
    spawn: { x: 4, y: 0 },
    exit: { x: 4, y: 24 },
    startingGold: 130,
    buildTimeSeconds: 90,
    parTimeSeconds: 26.0,
  }),
  defineMap({
    mapId: 10,
    title: 'Amber Fork',
    hint: 'Paired flanking Storm Spires feed off a southern Chrono Spire. Pull the Outrider coast-to-coast so every extended slow counts.',
    runnerType: 'OUTRIDER',
    spireTypes: ['THUNDERCLAP', 'THUNDERCLAP', 'CHRONO_SPIRE'],
    obstacleCount: 4,
    layoutPattern: 'TWIN_FLANKS',
    keepStyle: 'DEFAULT',
    spawn: { x: 9, y: 0 },
    exit: { x: 15, y: 24 },
    startingGold: 140,
    buildTimeSeconds: 95,
    parTimeSeconds: 34.0,
  }),
  defineMap({
    mapId: 11,
    title: 'Clover Causeway',
    hint: 'Compact wall budget with a central Waystone. Keep the Wind Herald close to both Storm Spires to deny any Tailwind surge.',
    runnerType: 'HERALD',
    spireTypes: ['THUNDERCLAP', 'THUNDERCLAP'],
    obstacleCount: 3,
    waystoneCount: 1,
    waystoneStyle: 'CENTER',
    layoutPattern: 'CLASSIC',
    keepStyle: 'DEFAULT',
    spawn: { x: 2, y: 0 },
    exit: { x: 16, y: 24 },
    startingGold: 125,
    buildTimeSeconds: 90,
    parTimeSeconds: 32.0,
  }),
  defineMap({
    mapId: 12,
    title: 'Eastcliff Watch',
    hint: 'Every Spire hugs the eastern cliff beside heavy Keep bastions. Link the bastions into your east wall to shatter Juggernaut armor.',
    runnerType: 'JUGGERNAUT',
    spireTypes: ['FROST_OBELISK', 'THUNDERCLAP', 'FROST_OBELISK'],
    obstacleCount: 5,
    layoutPattern: 'EAST_GAUNTLET',
    keepStyle: 'BASTION_HEAVY',
    spawn: { x: 15, y: 0 },
    exit: { x: 15, y: 24 },
    startingGold: 145,
    buildTimeSeconds: 95,
    parTimeSeconds: 35.0,
  }),
  defineMap({
    mapId: 13,
    title: 'Lantern Hollow',
    hint: 'Three Storm Spires cascade diagonally across the field with perimeter Keeps. Stitch a lightning corridor from edge to center.',
    runnerType: 'SCOUT',
    spireTypes: ['THUNDERCLAP', 'THUNDERCLAP', 'THUNDERCLAP'],
    obstacleCount: 3,
    layoutPattern: 'DIAGONAL_CASCADE',
    keepStyle: 'PERIMETER',
    spawn: { x: 3, y: 0 },
    exit: { x: 15, y: 24 },
    startingGold: 135,
    buildTimeSeconds: 90,
    parTimeSeconds: 27.0,
  }),
  defineMap({
    mapId: 14,
    title: 'Rimegate Crossing',
    hint: 'Three Frost Obelisks line the center column. Weave S-curves through all three chill rings so the Royal Outrider crawls the entire run.',
    runnerType: 'OUTRIDER',
    spireTypes: ['FROST_OBELISK', 'FROST_OBELISK', 'FROST_OBELISK'],
    obstacleCount: 4,
    layoutPattern: 'CENTER_SPINE',
    keepStyle: 'DEFAULT',
    spawn: { x: 15, y: 0 },
    exit: { x: 3, y: 24 },
    startingGold: 140,
    buildTimeSeconds: 95,
    parTimeSeconds: 31.0,
  }),
  defineMap({
    mapId: 15,
    title: 'Clockwork Steps',
    hint: 'Dual Chrono Spires accelerate each other and your central Storm Spire. Chain pulses tightly so the Wind Herald never breaks free.',
    runnerType: 'HERALD',
    spireTypes: ['CHRONO_SPIRE', 'THUNDERCLAP', 'CHRONO_SPIRE'],
    obstacleCount: 4,
    layoutPattern: 'DIAGONAL_CASCADE',
    keepStyle: 'DEFAULT',
    spawn: { x: 14, y: 0 },
    exit: { x: 4, y: 24 },
    startingGold: 145,
    buildTimeSeconds: 95,
    parTimeSeconds: 30.0,
  }),
  defineMap({
    mapId: 16,
    title: 'Redwall Courtyard',
    hint: 'Only 24 walls, but six central Crimson Keeps form a natural stone ruin. Use the Keeps as free walls and max-Overcharge both Spires.',
    runnerType: 'JUGGERNAUT',
    spireTypes: ['THUNDERCLAP', 'THUNDERCLAP'],
    obstacleCount: 6,
    layoutPattern: 'TWIN_FLANKS',
    keepStyle: 'CENTRAL',
    spawn: { x: 9, y: 0 },
    exit: { x: 9, y: 24 },
    startingGold: 120,
    buildTimeSeconds: 90,
    parTimeSeconds: 30.0,
  }),
  defineMap({
    mapId: 17,
    title: 'Millstone Bend',
    hint: 'Gates sit on the east flank while the Waystone pulls runners far west. Loop through Storm, Frost, and Chrono on the detour.',
    runnerType: 'SCOUT',
    spireTypes: ['THUNDERCLAP', 'FROST_OBELISK', 'CHRONO_SPIRE'],
    obstacleCount: 4,
    waystoneCount: 1,
    waystoneStyle: 'WEST_FLANK',
    layoutPattern: 'CLASSIC',
    keepStyle: 'DEFAULT',
    spawn: { x: 12, y: 0 },
    exit: { x: 12, y: 24 },
    startingGold: 150,
    buildTimeSeconds: 95,
    parTimeSeconds: 36.0,
  }),
  defineMap({
    mapId: 18,
    title: 'Windward Spur',
    hint: 'A lean 26-wall budget along a western Spire gauntlet. Keep every switchback close to the Frost and Chrono rings to block Tailwind.',
    runnerType: 'HERALD',
    spireTypes: ['FROST_OBELISK', 'CHRONO_SPIRE', 'FROST_OBELISK'],
    obstacleCount: 3,
    layoutPattern: 'WEST_GAUNTLET',
    keepStyle: 'DEFAULT',
    spawn: { x: 4, y: 0 },
    exit: { x: 14, y: 24 },
    startingGold: 130,
    buildTimeSeconds: 90,
    parTimeSeconds: 26.0,
  }),

  // B. Mid-Tier Signature & Formation Maps (#19 - #34)
  defineMap({
    mapId: 19,
    title: 'Diamond Cloister',
    hint: 'Four Spires frame a classic diamond courtyard. Route the Scout clockwise around all four vertices for overlapping double-pass loops.',
    runnerType: 'SCOUT',
    spireTypes: ['THUNDERCLAP', 'FROST_OBELISK', 'FROST_OBELISK', 'THUNDERCLAP'],
    obstacleCount: 4,
    layoutPattern: 'DIAMOND_COURT',
    keepStyle: 'DEFAULT',
    spawn: { x: 9, y: 0 },
    exit: { x: 9, y: 24 },
    startingGold: 170,
    buildTimeSeconds: 100,
    parTimeSeconds: 38.0,
  }),
  defineMap({
    mapId: 20,
    title: 'Glacier Spine',
    hint: 'Four Frost Obelisks march straight down the middle while Keeps guard the cliffs. Bridge power inward to turn the entire spine into ice.',
    runnerType: 'OUTRIDER',
    spireTypes: [
      'FROST_OBELISK',
      'FROST_OBELISK',
      'FROST_OBELISK',
      'FROST_OBELISK',
    ],
    obstacleCount: 5,
    layoutPattern: 'CENTER_SPINE',
    keepStyle: 'PERIMETER',
    spawn: { x: 6, y: 0 },
    exit: { x: 12, y: 24 },
    startingGold: 170,
    buildTimeSeconds: 100,
    parTimeSeconds: 36.0,
  }),
  defineMap({
    mapId: 21,
    title: 'Thunder Corridor',
    hint: 'Four flanking Storm Spires and twin Keep bastions. Power both banks so every 50%+ thunderclap punches straight through Juggernaut armor.',
    runnerType: 'JUGGERNAUT',
    spireTypes: ['THUNDERCLAP', 'THUNDERCLAP', 'THUNDERCLAP', 'THUNDERCLAP'],
    obstacleCount: 5,
    layoutPattern: 'TWIN_FLANKS',
    keepStyle: 'BASTION_HEAVY',
    spawn: { x: 9, y: 0 },
    exit: { x: 9, y: 24 },
    startingGold: 175,
    buildTimeSeconds: 100,
    parTimeSeconds: 46.0,
  }),
  defineMap({
    mapId: 22,
    title: 'Sundial Terrace',
    hint: 'Twin Chrono Spires anchor the middle flanks of a diamond court. Alternate passes across the center so cooldowns melt away.',
    runnerType: 'HERALD',
    spireTypes: ['THUNDERCLAP', 'CHRONO_SPIRE', 'CHRONO_SPIRE', 'FROST_OBELISK'],
    obstacleCount: 5,
    layoutPattern: 'DIAMOND_COURT',
    keepStyle: 'DEFAULT',
    spawn: { x: 3, y: 0 },
    exit: { x: 15, y: 24 },
    startingGold: 180,
    buildTimeSeconds: 105,
    parTimeSeconds: 46.0,
  }),
  defineMap({
    mapId: 23,
    title: 'Twin Keep Causeway',
    hint: 'Eight Crimson Keeps cluster into massive stone bastions. Weave your maze directly off those ruins to save walls and hit triple Overcharge.',
    runnerType: 'JUGGERNAUT',
    spireTypes: ['THUNDERCLAP', 'FROST_OBELISK', 'CHRONO_SPIRE', 'THUNDERCLAP'],
    obstacleCount: 8,
    layoutPattern: 'CLASSIC',
    keepStyle: 'BASTION_HEAVY',
    spawn: { x: 15, y: 0 },
    exit: { x: 3, y: 24 },
    startingGold: 165,
    buildTimeSeconds: 105,
    parTimeSeconds: 55.0,
  }),
  defineMap({
    mapId: 24,
    title: 'Gilded Detour',
    hint: 'Gates and Spires sit west, while the Waystone waits across the eastern meadow. Drag the Outrider through the west gauntlet twice.',
    runnerType: 'OUTRIDER',
    spireTypes: ['THUNDERCLAP', 'FROST_OBELISK', 'THUNDERCLAP'],
    obstacleCount: 5,
    waystoneCount: 1,
    waystoneStyle: 'EAST_FLANK',
    layoutPattern: 'WEST_GAUNTLET',
    keepStyle: 'DEFAULT',
    spawn: { x: 3, y: 0 },
    exit: { x: 3, y: 24 },
    startingGold: 165,
    buildTimeSeconds: 100,
    parTimeSeconds: 42.0,
  }),
  defineMap({
    mapId: 25,
    title: 'Northgate Bastion',
    hint: 'Spires guard the northern and southern entries around a dense central Keep ruin. Build two switchback chambers connected by a central conduit.',
    runnerType: 'SCOUT',
    spireTypes: ['THUNDERCLAP', 'FROST_OBELISK', 'FROST_OBELISK', 'THUNDERCLAP'],
    obstacleCount: 6,
    layoutPattern: 'NORTH_SOUTH_BASTIONS',
    keepStyle: 'CENTRAL',
    spawn: { x: 9, y: 0 },
    exit: { x: 9, y: 24 },
    startingGold: 175,
    buildTimeSeconds: 105,
    parTimeSeconds: 37.0,
  }),
  defineMap({
    mapId: 26,
    title: 'Hourglass Vale',
    hint: 'Three Chrono Spires form a rapid-fire central engine—each pulse trims 1.2s off the other two. Keep the Wind Herald trapped inside the core.',
    runnerType: 'HERALD',
    spireTypes: ['CHRONO_SPIRE', 'CHRONO_SPIRE', 'CHRONO_SPIRE'],
    obstacleCount: 5,
    layoutPattern: 'CENTER_SPINE',
    keepStyle: 'DEFAULT',
    spawn: { x: 9, y: 0 },
    exit: { x: 9, y: 24 },
    startingGold: 160,
    buildTimeSeconds: 100,
    parTimeSeconds: 33.0,
  }),
  defineMap({
    mapId: 27,
    title: 'Vanguard Ridge',
    hint: 'Four outer Spires surround a central Waystone. Link your Keeps into the ring so the Juggernaut takes Overcharged hits entering and exiting.',
    runnerType: 'JUGGERNAUT',
    spireTypes: ['THUNDERCLAP', 'FROST_OBELISK', 'CHRONO_SPIRE', 'THUNDERCLAP'],
    obstacleCount: 5,
    waystoneCount: 1,
    waystoneStyle: 'CENTER',
    layoutPattern: 'CITADEL_RING',
    keepStyle: 'DEFAULT',
    spawn: { x: 2, y: 0 },
    exit: { x: 16, y: 24 },
    startingGold: 180,
    buildTimeSeconds: 105,
    parTimeSeconds: 49.0,
  }),
  defineMap({
    mapId: 28,
    title: 'Silverbrook Drift',
    hint: 'A diagonal cascade of three Frost Obelisks and a Storm Spire. Stair-step the Outrider along the diagonal to maximize chill uptime.',
    runnerType: 'OUTRIDER',
    spireTypes: ['FROST_OBELISK', 'THUNDERCLAP', 'FROST_OBELISK', 'FROST_OBELISK'],
    obstacleCount: 4,
    layoutPattern: 'DIAGONAL_CASCADE',
    keepStyle: 'DEFAULT',
    spawn: { x: 16, y: 0 },
    exit: { x: 2, y: 24 },
    startingGold: 170,
    buildTimeSeconds: 100,
    parTimeSeconds: 40.0,
  }),
  defineMap({
    mapId: 29,
    title: 'Beacon Flank',
    hint: 'Three Storm Spires and a Chrono Spire stack down the eastern side. Pull the Scout through tight east-wall hairpins before cutting to center exit.',
    runnerType: 'SCOUT',
    spireTypes: ['THUNDERCLAP', 'CHRONO_SPIRE', 'THUNDERCLAP', 'THUNDERCLAP'],
    obstacleCount: 6,
    layoutPattern: 'EAST_GAUNTLET',
    keepStyle: 'PERIMETER',
    spawn: { x: 16, y: 0 },
    exit: { x: 9, y: 24 },
    startingGold: 175,
    buildTimeSeconds: 105,
    parTimeSeconds: 41.0,
  }),
  defineMap({
    mapId: 30,
    title: 'Galebreak Spire',
    hint: 'Flanking Storm and Chrono pairs stand across the meadow. Zigzag back and forth between the cliffs so the Wind Herald never gains momentum.',
    runnerType: 'HERALD',
    spireTypes: ['THUNDERCLAP', 'CHRONO_SPIRE', 'CHRONO_SPIRE', 'THUNDERCLAP'],
    obstacleCount: 5,
    layoutPattern: 'TWIN_FLANKS',
    keepStyle: 'DEFAULT',
    spawn: { x: 5, y: 0 },
    exit: { x: 13, y: 24 },
    startingGold: 180,
    buildTimeSeconds: 105,
    parTimeSeconds: 47.0,
  }),
  defineMap({
    mapId: 31,
    title: 'Stonebridge Gallery',
    hint: 'Seven central Keeps separate the northern and southern Spire pairs. Connect the ruins into one mega-circuit to Overcharge both ends.',
    runnerType: 'JUGGERNAUT',
    spireTypes: ['FROST_OBELISK', 'THUNDERCLAP', 'CHRONO_SPIRE', 'FROST_OBELISK'],
    obstacleCount: 7,
    layoutPattern: 'NORTH_SOUTH_BASTIONS',
    keepStyle: 'CENTRAL',
    spawn: { x: 9, y: 0 },
    exit: { x: 2, y: 24 },
    startingGold: 170,
    buildTimeSeconds: 105,
    parTimeSeconds: 47.0,
  }),
  defineMap({
    mapId: 32,
    title: "Pilgrim's Reach",
    hint: 'Two Waystones pull the Scout diagonally across the island. Shape a flowing S-route that loops past all three Spires between Waystones.',
    runnerType: 'SCOUT',
    spireTypes: ['THUNDERCLAP', 'FROST_OBELISK', 'THUNDERCLAP'],
    obstacleCount: 4,
    waystoneCount: 2,
    waystoneStyle: 'DUAL_CROSS',
    layoutPattern: 'CLASSIC',
    keepStyle: 'DEFAULT',
    spawn: { x: 9, y: 0 },
    exit: { x: 9, y: 24 },
    startingGold: 170,
    buildTimeSeconds: 105,
    parTimeSeconds: 51.0,
  }),
  defineMap({
    mapId: 33,
    title: 'Crescent Ward',
    hint: 'East gates and east Spires oppose a far-west Waystone. Build a crescent return corridor so the Wind Herald hits Spires going out and coming back.',
    runnerType: 'HERALD',
    spireTypes: ['FROST_OBELISK', 'THUNDERCLAP', 'CHRONO_SPIRE', 'FROST_OBELISK'],
    obstacleCount: 5,
    waystoneCount: 1,
    waystoneStyle: 'WEST_FLANK',
    layoutPattern: 'EAST_GAUNTLET',
    keepStyle: 'DEFAULT',
    spawn: { x: 14, y: 0 },
    exit: { x: 14, y: 24 },
    startingGold: 180,
    buildTimeSeconds: 105,
    parTimeSeconds: 48.0,
  }),
  defineMap({
    mapId: 34,
    title: 'Oakhaven Labyrinth',
    hint: 'A four-Spire diamond packed with paired Keep bastions. Use the bastions to pocket the Outrider around your central Frost and Storm nexus.',
    runnerType: 'OUTRIDER',
    spireTypes: ['THUNDERCLAP', 'THUNDERCLAP', 'FROST_OBELISK', 'THUNDERCLAP'],
    obstacleCount: 6,
    layoutPattern: 'DIAMOND_COURT',
    keepStyle: 'BASTION_HEAVY',
    spawn: { x: 2, y: 0 },
    exit: { x: 9, y: 24 },
    startingGold: 175,
    buildTimeSeconds: 105,
    parTimeSeconds: 45.0,
  }),

  // C. Dual-Waystone & Boomerang Tactical Arenas (#35 - #44)
  defineMap({
    mapId: 35,
    title: 'Double Crossing',
    hint: 'Two Waystones sit on opposite flanks between four flanking Spires. Force the Royal Outrider to cross every chill and storm zone twice.',
    runnerType: 'OUTRIDER',
    spireTypes: ['FROST_OBELISK', 'THUNDERCLAP', 'THUNDERCLAP', 'FROST_OBELISK'],
    obstacleCount: 5,
    waystoneCount: 2,
    waystoneStyle: 'DUAL_CROSS',
    layoutPattern: 'TWIN_FLANKS',
    keepStyle: 'DEFAULT',
    spawn: { x: 3, y: 0 },
    exit: { x: 15, y: 24 },
    startingGold: 190,
    buildTimeSeconds: 110,
    parTimeSeconds: 65.0,
  }),
  defineMap({
    mapId: 36,
    title: 'The Rebound',
    hint: 'Boomerang route! Waystone 1 lies south and Waystone 2 pulls the Scout all the way back north—re-use your central Spires on all three passes.',
    runnerType: 'SCOUT',
    spireTypes: ['THUNDERCLAP', 'FROST_OBELISK', 'CHRONO_SPIRE', 'THUNDERCLAP'],
    obstacleCount: 5,
    waystoneCount: 2,
    waystoneStyle: 'DUAL_REBOUND',
    layoutPattern: 'CLASSIC',
    keepStyle: 'DEFAULT',
    spawn: { x: 9, y: 0 },
    exit: { x: 9, y: 24 },
    startingGold: 155,
    buildTimeSeconds: 105,
    parTimeSeconds: 81.0,
  }),
  defineMap({
    mapId: 37,
    title: 'Twin Pillars Pass',
    hint: 'Two vertical Waystones bisect four flanking Spires and six central Keeps. Build an Overcharged wall spine linking both sides to crack Juggernaut armor.',
    runnerType: 'JUGGERNAUT',
    spireTypes: ['THUNDERCLAP', 'FROST_OBELISK', 'FROST_OBELISK', 'CHRONO_SPIRE'],
    obstacleCount: 6,
    waystoneCount: 2,
    waystoneStyle: 'DUAL_VERTICAL',
    layoutPattern: 'TWIN_FLANKS',
    keepStyle: 'CENTRAL',
    spawn: { x: 4, y: 0 },
    exit: { x: 14, y: 24 },
    startingGold: 190,
    buildTimeSeconds: 110,
    parTimeSeconds: 62.0,
  }),
  defineMap({
    mapId: 38,
    title: 'Echo Switchback',
    hint: 'Rebound Waystones force three full lengths of the field! Keep the Wind Herald grazing both flanking Chrono-Storm pairs on every leg.',
    runnerType: 'HERALD',
    spireTypes: ['THUNDERCLAP', 'CHRONO_SPIRE', 'CHRONO_SPIRE', 'THUNDERCLAP'],
    obstacleCount: 5,
    waystoneCount: 2,
    waystoneStyle: 'DUAL_REBOUND',
    layoutPattern: 'TWIN_FLANKS',
    keepStyle: 'DEFAULT',
    spawn: { x: 15, y: 0 },
    exit: { x: 3, y: 24 },
    startingGold: 165,
    buildTimeSeconds: 110,
    parTimeSeconds: 75.0,
  }),
  defineMap({
    mapId: 39,
    title: 'Caravan Circuit',
    hint: 'North and south Spire bastions bracket two opposite-flank Waystones. Weave the Scout through both checkpoints before sealing the south exit.',
    runnerType: 'SCOUT',
    spireTypes: ['THUNDERCLAP', 'THUNDERCLAP', 'FROST_OBELISK', 'THUNDERCLAP'],
    obstacleCount: 4,
    waystoneCount: 2,
    waystoneStyle: 'DUAL_CROSS',
    layoutPattern: 'NORTH_SOUTH_BASTIONS',
    keepStyle: 'PERIMETER',
    spawn: { x: 16, y: 0 },
    exit: { x: 2, y: 24 },
    startingGold: 185,
    buildTimeSeconds: 110,
    parTimeSeconds: 52.0,
  }),
  defineMap({
    mapId: 40,
    title: 'Frostbite Loop',
    hint: 'Rebound Waystones orbit a spine of three Frost Obelisks and a Chrono Spire. Force the Outrider back through the frozen core again and again.',
    runnerType: 'OUTRIDER',
    spireTypes: ['FROST_OBELISK', 'FROST_OBELISK', 'CHRONO_SPIRE', 'FROST_OBELISK'],
    obstacleCount: 6,
    waystoneCount: 2,
    waystoneStyle: 'DUAL_REBOUND',
    layoutPattern: 'CENTER_SPINE',
    keepStyle: 'DEFAULT',
    spawn: { x: 9, y: 0 },
    exit: { x: 15, y: 24 },
    startingGold: 160,
    buildTimeSeconds: 110,
    parTimeSeconds: 70.0,
  }),
  defineMap({
    mapId: 41,
    title: 'Iron Pilgrimage',
    hint: 'Five Spires, six bastion Keeps, and two Waystones across a corner-to-corner run. Overcharge both Chrono Spires to grind down the Juggernaut.',
    runnerType: 'JUGGERNAUT',
    spireTypes: [
      'THUNDERCLAP',
      'CHRONO_SPIRE',
      'FROST_OBELISK',
      'CHRONO_SPIRE',
      'THUNDERCLAP',
    ],
    obstacleCount: 6,
    waystoneCount: 2,
    waystoneStyle: 'DUAL_CROSS',
    layoutPattern: 'CLASSIC',
    keepStyle: 'BASTION_HEAVY',
    spawn: { x: 2, y: 0 },
    exit: { x: 16, y: 24 },
    startingGold: 185,
    buildTimeSeconds: 115,
    parTimeSeconds: 75.0,
  }),
  defineMap({
    mapId: 42,
    title: 'Zephyr Figure-Eight',
    hint: 'Two central Waystones and a five-Spire flank grid create a natural figure-eight. Chain Frost and Chrono rings to choke off Wind Herald Tailwind.',
    runnerType: 'HERALD',
    spireTypes: [
      'FROST_OBELISK',
      'CHRONO_SPIRE',
      'THUNDERCLAP',
      'CHRONO_SPIRE',
      'FROST_OBELISK',
    ],
    obstacleCount: 5,
    waystoneCount: 2,
    waystoneStyle: 'DUAL_VERTICAL',
    layoutPattern: 'TWIN_FLANKS',
    keepStyle: 'DEFAULT',
    spawn: { x: 9, y: 0 },
    exit: { x: 9, y: 24 },
    startingGold: 205,
    buildTimeSeconds: 115,
    parTimeSeconds: 60.0,
  }),
  defineMap({
    mapId: 43,
    title: 'Crown Tourney',
    hint: 'A five-point Spire diamond paired with boomerang Waystones along the west gates. Loop the Juggernaut past the Overcharged center heart on every leg.',
    runnerType: 'JUGGERNAUT',
    spireTypes: [
      'THUNDERCLAP',
      'FROST_OBELISK',
      'CHRONO_SPIRE',
      'FROST_OBELISK',
      'THUNDERCLAP',
    ],
    obstacleCount: 6,
    waystoneCount: 2,
    waystoneStyle: 'DUAL_REBOUND',
    layoutPattern: 'DIAMOND_COURT',
    keepStyle: 'DEFAULT',
    spawn: { x: 3, y: 0 },
    exit: { x: 3, y: 24 },
    startingGold: 130,
    buildTimeSeconds: 110,
    parTimeSeconds: 88.0,
  }),
  defineMap({
    mapId: 44,
    title: 'Sovereign Relay',
    hint: 'Five ring Spires encircle two cross-field Waystones while gates hug the east edge. Turn the entire outer ring into an endless Outrider slow trap.',
    runnerType: 'OUTRIDER',
    spireTypes: [
      'THUNDERCLAP',
      'FROST_OBELISK',
      'FROST_OBELISK',
      'CHRONO_SPIRE',
      'THUNDERCLAP',
    ],
    obstacleCount: 5,
    waystoneCount: 2,
    waystoneStyle: 'DUAL_CROSS',
    layoutPattern: 'CITADEL_RING',
    keepStyle: 'DEFAULT',
    spawn: { x: 15, y: 0 },
    exit: { x: 15, y: 24 },
    startingGold: 210,
    buildTimeSeconds: 115,
    parTimeSeconds: 61.0,
  }),

  // D. High-Intensity Grand Citadels (#45 - #58)
  defineMap({
    mapId: 45,
    title: 'Tempest Crown',
    hint: 'Five Storm Spires form a glowing star diamond! Fold tight switchbacks around the central Storm Spire and feed Keeps into the whole star.',
    runnerType: 'SCOUT',
    spireTypes: [
      'THUNDERCLAP',
      'THUNDERCLAP',
      'THUNDERCLAP',
      'THUNDERCLAP',
      'THUNDERCLAP',
    ],
    obstacleCount: 6,
    layoutPattern: 'DIAMOND_COURT',
    keepStyle: 'DEFAULT',
    spawn: { x: 9, y: 0 },
    exit: { x: 9, y: 24 },
    startingGold: 200,
    buildTimeSeconds: 115,
    parTimeSeconds: 42.0,
  }),
  defineMap({
    mapId: 46,
    title: 'Permafrost Sanctum',
    hint: 'Four Frost Obelisks and a Chrono Spire ring the arena with perimeter Keeps. Spiral the Royal Outrider through overlapping chilled rings.',
    runnerType: 'OUTRIDER',
    spireTypes: [
      'FROST_OBELISK',
      'FROST_OBELISK',
      'CHRONO_SPIRE',
      'FROST_OBELISK',
      'FROST_OBELISK',
    ],
    obstacleCount: 6,
    layoutPattern: 'CITADEL_RING',
    keepStyle: 'PERIMETER',
    spawn: { x: 4, y: 0 },
    exit: { x: 14, y: 24 },
    startingGold: 205,
    buildTimeSeconds: 115,
    parTimeSeconds: 50.0,
  }),
  defineMap({
    mapId: 47,
    title: 'Chrono Foundry',
    hint: 'Three Chrono Spires power a central diamond alongside Storm and Frost! Every pulse cascades cooldown resets—keep the Wind Herald locked inside.',
    runnerType: 'HERALD',
    spireTypes: [
      'THUNDERCLAP',
      'CHRONO_SPIRE',
      'CHRONO_SPIRE',
      'CHRONO_SPIRE',
      'FROST_OBELISK',
    ],
    obstacleCount: 6,
    layoutPattern: 'DIAMOND_COURT',
    keepStyle: 'CENTRAL',
    spawn: { x: 9, y: 0 },
    exit: { x: 9, y: 24 },
    startingGold: 210,
    buildTimeSeconds: 115,
    parTimeSeconds: 50.0,
  }),
  defineMap({
    mapId: 48,
    title: 'Crimson Stronghold',
    hint: 'Nine Crimson Keeps fill the island with red stone bastions! Weave through the ruins to achieve triple Overcharge across all five Spires.',
    runnerType: 'JUGGERNAUT',
    spireTypes: [
      'THUNDERCLAP',
      'FROST_OBELISK',
      'CHRONO_SPIRE',
      'FROST_OBELISK',
      'THUNDERCLAP',
    ],
    obstacleCount: 9,
    layoutPattern: 'CLASSIC',
    keepStyle: 'BASTION_HEAVY',
    spawn: { x: 9, y: 0 },
    exit: { x: 9, y: 24 },
    startingGold: 195,
    buildTimeSeconds: 115,
    parTimeSeconds: 59.0,
  }),
  defineMap({
    mapId: 49,
    title: 'Skybridge Gauntlet',
    hint: 'Five ring Spires guard a central Waystone on a far-corner diagonal. Pair both Chrono Spires with switchbacks so the Wind Herald never accelerates.',
    runnerType: 'HERALD',
    spireTypes: [
      'THUNDERCLAP',
      'CHRONO_SPIRE',
      'FROST_OBELISK',
      'CHRONO_SPIRE',
      'THUNDERCLAP',
    ],
    obstacleCount: 5,
    waystoneCount: 1,
    waystoneStyle: 'CENTER',
    layoutPattern: 'CITADEL_RING',
    keepStyle: 'DEFAULT',
    spawn: { x: 2, y: 0 },
    exit: { x: 16, y: 24 },
    startingGold: 210,
    buildTimeSeconds: 115,
    parTimeSeconds: 63.0,
  }),
  defineMap({
    mapId: 50,
    title: "King's Switchback",
    hint: 'A sweeping five-Spire diagonal cascade with seven Keeps and a west Waystone. Turn the entire diagonal into a continuous lightning ribbon.',
    runnerType: 'SCOUT',
    spireTypes: [
      'THUNDERCLAP',
      'FROST_OBELISK',
      'CHRONO_SPIRE',
      'THUNDERCLAP',
      'THUNDERCLAP',
    ],
    obstacleCount: 7,
    waystoneCount: 1,
    waystoneStyle: 'WEST_FLANK',
    layoutPattern: 'DIAGONAL_CASCADE',
    keepStyle: 'DEFAULT',
    spawn: { x: 16, y: 0 },
    exit: { x: 2, y: 24 },
    startingGold: 210,
    buildTimeSeconds: 115,
    parTimeSeconds: 65.0,
  }),
  defineMap({
    mapId: 51,
    title: 'Avalanche Gorge',
    hint: 'Three Frost Obelisks fortify north and south bastions filled with Keep ruins. Hold the Royal Outrider inside both frost chambers.',
    runnerType: 'OUTRIDER',
    spireTypes: [
      'FROST_OBELISK',
      'THUNDERCLAP',
      'CHRONO_SPIRE',
      'FROST_OBELISK',
      'FROST_OBELISK',
    ],
    obstacleCount: 7,
    layoutPattern: 'NORTH_SOUTH_BASTIONS',
    keepStyle: 'BASTION_HEAVY',
    spawn: { x: 3, y: 0 },
    exit: { x: 15, y: 24 },
    startingGold: 205,
    buildTimeSeconds: 115,
    parTimeSeconds: 52.0,
  }),
  defineMap({
    mapId: 52,
    title: 'Bastion of Five',
    hint: 'Eight perimeter Keeps feed five ringed Spires across an opposite-corner run. Build one unified conduit ring to pierce Juggernaut armor everywhere.',
    runnerType: 'JUGGERNAUT',
    spireTypes: [
      'THUNDERCLAP',
      'FROST_OBELISK',
      'CHRONO_SPIRE',
      'FROST_OBELISK',
      'THUNDERCLAP',
    ],
    obstacleCount: 8,
    layoutPattern: 'CITADEL_RING',
    keepStyle: 'PERIMETER',
    spawn: { x: 15, y: 0 },
    exit: { x: 3, y: 24 },
    startingGold: 210,
    buildTimeSeconds: 120,
    parTimeSeconds: 56.0,
  }),
  defineMap({
    mapId: 53,
    title: 'Starfall Courtyard',
    hint: 'A five-Spire diamond with twin Chrono Spires and an eastern Waystone. Pull the Scout out east and back through the diamond core.',
    runnerType: 'SCOUT',
    spireTypes: [
      'THUNDERCLAP',
      'CHRONO_SPIRE',
      'FROST_OBELISK',
      'CHRONO_SPIRE',
      'THUNDERCLAP',
    ],
    obstacleCount: 6,
    waystoneCount: 1,
    waystoneStyle: 'EAST_FLANK',
    layoutPattern: 'DIAMOND_COURT',
    keepStyle: 'DEFAULT',
    spawn: { x: 4, y: 0 },
    exit: { x: 4, y: 24 },
    startingGold: 215,
    buildTimeSeconds: 120,
    parTimeSeconds: 58.0,
  }),
  defineMap({
    mapId: 54,
    title: "Warden's Crucible",
    hint: 'East-cliff gates open into north and south Storm-Chrono bastions around seven central Keeps. Overcharge every battery for relentless stuns.',
    runnerType: 'JUGGERNAUT',
    spireTypes: [
      'THUNDERCLAP',
      'CHRONO_SPIRE',
      'THUNDERCLAP',
      'CHRONO_SPIRE',
      'THUNDERCLAP',
    ],
    obstacleCount: 7,
    layoutPattern: 'NORTH_SOUTH_BASTIONS',
    keepStyle: 'CENTRAL',
    spawn: { x: 14, y: 0 },
    exit: { x: 14, y: 24 },
    startingGold: 215,
    buildTimeSeconds: 120,
    parTimeSeconds: 55.0,
  }),
  defineMap({
    mapId: 55,
    title: 'Hexspire Promenade',
    hint: 'Six Elemental Spires—two of each element—line both flanks in three tiers! Zigzag down the entire promenade for massive synergy chains.',
    runnerType: 'SCOUT',
    spireTypes: [
      'THUNDERCLAP',
      'FROST_OBELISK',
      'CHRONO_SPIRE',
      'CHRONO_SPIRE',
      'FROST_OBELISK',
      'THUNDERCLAP',
    ],
    obstacleCount: 6,
    layoutPattern: 'TWIN_FLANKS',
    keepStyle: 'DEFAULT',
    spawn: { x: 9, y: 0 },
    exit: { x: 9, y: 24 },
    startingGold: 220,
    buildTimeSeconds: 120,
    parTimeSeconds: 52.0,
  }),
  defineMap({
    mapId: 56,
    title: 'Grand Frostforge',
    hint: 'Six flanking Spires led by three Frost Obelisks and seven perimeter Keeps. Turn the far-corner sprint into an unbroken glacial labyrinth.',
    runnerType: 'OUTRIDER',
    spireTypes: [
      'FROST_OBELISK',
      'THUNDERCLAP',
      'FROST_OBELISK',
      'CHRONO_SPIRE',
      'THUNDERCLAP',
      'FROST_OBELISK',
    ],
    obstacleCount: 7,
    layoutPattern: 'TWIN_FLANKS',
    keepStyle: 'PERIMETER',
    spawn: { x: 2, y: 0 },
    exit: { x: 16, y: 24 },
    startingGold: 225,
    buildTimeSeconds: 120,
    parTimeSeconds: 57.0,
  }),
  defineMap({
    mapId: 57,
    title: 'Eternal Clocktower',
    hint: 'Six Spires—including THREE Chrono Spires—flank a central Waystone! Cooldowns cycle almost nonstop if you keep the Wind Herald weaving.',
    runnerType: 'HERALD',
    spireTypes: [
      'CHRONO_SPIRE',
      'FROST_OBELISK',
      'CHRONO_SPIRE',
      'THUNDERCLAP',
      'FROST_OBELISK',
      'CHRONO_SPIRE',
    ],
    obstacleCount: 5,
    waystoneCount: 1,
    waystoneStyle: 'CENTER',
    layoutPattern: 'TWIN_FLANKS',
    keepStyle: 'CENTRAL',
    spawn: { x: 16, y: 0 },
    exit: { x: 2, y: 24 },
    startingGold: 230,
    buildTimeSeconds: 125,
    parTimeSeconds: 61.0,
  }),
  defineMap({
    mapId: 58,
    title: "Emperor's Citadel",
    hint: 'The grandest arena: six balanced Spires, five bastion Keeps, and a central Waystone. Link your Keeps into an Overcharged empire against the Juggernaut.',
    runnerType: 'JUGGERNAUT',
    spireTypes: [
      'THUNDERCLAP',
      'FROST_OBELISK',
      'CHRONO_SPIRE',
      'CHRONO_SPIRE',
      'FROST_OBELISK',
      'THUNDERCLAP',
    ],
    obstacleCount: 5,
    waystoneCount: 1,
    waystoneStyle: 'CENTER',
    layoutPattern: 'TWIN_FLANKS',
    keepStyle: 'BASTION_HEAVY',
    spawn: { x: 4, y: 0 },
    exit: { x: 14, y: 24 },
    startingGold: 230,
    buildTimeSeconds: 125,
    parTimeSeconds: 68.0,
  }),
];

export const ROUNDS: RoundConfig[] = [...CLASSIC_ROUNDS, ...EXPANSION_MAPS];

const ROUND_BY_MAP_ID = new Map<number, RoundConfig>();
for (const r of ROUNDS) {
  const id = r.mapId ?? r.roundNumber;
  ROUND_BY_MAP_ID.set(id, r);
}

export function getMapById(mapId?: number): RoundConfig {
  if (typeof mapId === 'number' && ROUND_BY_MAP_ID.has(mapId)) {
    return ROUND_BY_MAP_ID.get(mapId)!;
  }
  return ROUNDS[0];
}

export function isInfiniteRounds(totalRounds?: number): boolean {
  return totalRounds === INFINITE_ROUNDS;
}

export function isInfiniteBuildTime(buildTimeSeconds?: number): boolean {
  return buildTimeSeconds === INFINITE_BUILD_TIME;
}

export function normalizeAllowedRunners(
  raw?: ReadonlyArray<string> | null
): RunnerArchetype[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    return [...ALL_RUNNER_ARCHETYPES];
  }
  const validSet = new Set<RunnerArchetype>();
  for (const r of raw) {
    const upper = String(r || '').toUpperCase() as RunnerArchetype;
    if ((ALL_RUNNER_ARCHETYPES as readonly string[]).includes(upper)) {
      validSet.add(upper);
    }
  }
  if (validSet.size === 0) {
    return [...ALL_RUNNER_ARCHETYPES];
  }
  return ALL_RUNNER_ARCHETYPES.filter((r) => validSet.has(r));
}

export function getMapsMatchingRunners(
  allowedRunners?: ReadonlyArray<RunnerArchetype>
): RoundConfig[] {
  const allowedSet = new Set(normalizeAllowedRunners(allowedRunners));
  return ROUNDS.filter((r) => allowedSet.has(r.runnerType || 'SCOUT'));
}

/**
 * Builds a randomized permutation of matching map indices from `ROUNDS`.
 * When `allowedRunners` is provided, only maps whose `runnerType` is included
 * are placed in the deck. Indices in `deprioritizeIndices` are shuffled to the
 * back half so consecutive matches avoid immediate repeats.
 */
export function createShuffledMapDeck(
  deprioritizeIndices: ReadonlyArray<number> = [],
  rng: () => number = Math.random,
  allowedRunners?: ReadonlyArray<RunnerArchetype>
): number[] {
  const allowedSet = new Set(normalizeAllowedRunners(allowedRunners));
  const deprioritized = new Set(deprioritizeIndices);
  const fresh: number[] = [];
  const recent: number[] = [];
  for (let i = 0; i < ROUNDS.length; i++) {
    const runner = ROUNDS[i].runnerType || 'SCOUT';
    if (!allowedSet.has(runner)) continue;
    if (deprioritized.has(i)) {
      recent.push(i);
    } else {
      fresh.push(i);
    }
  }

  const shuffle = (arr: number[]): number[] => {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      const tmp = arr[i];
      arr[i] = arr[j];
      arr[j] = tmp;
    }
    return arr;
  };

  return [...shuffle(fresh), ...shuffle(recent)];
}

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
  round: RoundConfig,
  slotIndex: number
): SpireType {
  if (Array.isArray(round.spireTypes) && slotIndex < round.spireTypes.length) {
    return round.spireTypes[slotIndex];
  }
  const key = round.mapId ?? round.roundNumber;
  const manifest = ROUND_SPIRE_ARCHETYPES[key];
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
  mirrorX: boolean,
  layoutPattern: MapLayoutPattern = 'CLASSIC',
  reserveCenterWaystone = false
): SpireZoneBand[] {
  const minX = 4;
  const maxX = Math.max(minX, gridWidth - 6); // 14 on width 20
  const minY = 4;
  const maxY = Math.max(minY, gridHeight - 6); // 20 on height 26

  const leftRange: [number, number] = [minX, Math.min(maxX, minX + 2)]; // [4..6]
  const tightLeftRange: [number, number] = [minX, Math.min(maxX, minX + 1)]; // [4..5]
  const centerRange: [number, number] = [
    Math.max(minX, Math.floor(gridWidth / 2) - 2),
    Math.min(maxX, Math.floor(gridWidth / 2)),
  ]; // [8..10]
  const rightRange: [number, number] = [Math.max(minX, maxX - 2), maxX]; // [12..14]
  const tightRightRange: [number, number] = [Math.max(minX, maxX - 1), maxX]; // [13..14]

  const clampBand = (
    xMin: number,
    xMax: number,
    yMin: number,
    yMax: number
  ): SpireZoneBand => ({
    xMin: Math.max(minX, Math.min(maxX, xMin)),
    xMax: Math.max(minX, Math.min(maxX, xMax)),
    yMin: Math.max(minY, Math.min(maxY, yMin)),
    yMax: Math.max(minY, Math.min(maxY, yMax)),
  });

  const mirrorBand = (b: SpireZoneBand): SpireZoneBand => {
    if (!mirrorX) return b;
    const nxMin = gridWidth - 2 - b.xMax;
    const nxMax = gridWidth - 2 - b.xMin;
    return clampBand(nxMin, nxMax, b.yMin, b.yMax);
  };

  const pickLateral = (slot: 'L' | 'C' | 'R'): [number, number] => {
    if (slot === 'C') return centerRange;
    if (slot === 'L') return mirrorX ? rightRange : leftRange;
    return mirrorX ? leftRange : rightRange;
  };

  if (layoutPattern === 'CENTER_SPINE') {
    if (spireCount <= 2) {
      return [
        clampBand(8, 10, 5, 8),
        clampBand(8, 10, 16, 19),
      ].slice(0, spireCount);
    }
    if (spireCount === 3) {
      return [
        clampBand(8, 10, 4, 6),
        clampBand(8, 10, 11, 13),
        clampBand(8, 10, 18, 20),
      ];
    }
    if (spireCount === 4) {
      return [
        mirrorBand(clampBand(7, 8, 4, 5)),
        mirrorBand(clampBand(10, 11, 9, 10)),
        mirrorBand(clampBand(7, 8, 14, 15)),
        mirrorBand(clampBand(10, 11, 19, 20)),
      ];
    }
    return [
      clampBand(8, 10, 4, 5),
      mirrorBand(clampBand(6, 7, 8, 9)),
      mirrorBand(clampBand(11, 12, 11, 13)),
      mirrorBand(clampBand(6, 7, 15, 16)),
      clampBand(8, 10, 19, 20),
    ].slice(0, spireCount);
  }

  if (layoutPattern === 'TWIN_FLANKS') {
    if (spireCount <= 2) {
      return [
        clampBand(leftRange[0], leftRange[1], 10, 14),
        clampBand(rightRange[0], rightRange[1], 10, 14),
      ].slice(0, spireCount);
    }
    if (spireCount === 3) {
      return [
        clampBand(leftRange[0], leftRange[1], 6, 9),
        clampBand(rightRange[0], rightRange[1], 6, 9),
        clampBand(centerRange[0], centerRange[1], 16, 19),
      ];
    }
    if (spireCount === 4) {
      return [
        clampBand(leftRange[0], leftRange[1], 5, 8),
        clampBand(rightRange[0], rightRange[1], 5, 8),
        clampBand(leftRange[0], leftRange[1], 16, 19),
        clampBand(rightRange[0], rightRange[1], 16, 19),
      ];
    }
    if (spireCount === 5) {
      return [
        clampBand(leftRange[0], leftRange[1], 4, 6),
        clampBand(rightRange[0], rightRange[1], 4, 6),
        clampBand(centerRange[0], centerRange[1], 11, 13),
        clampBand(leftRange[0], leftRange[1], 18, 20),
        clampBand(rightRange[0], rightRange[1], 18, 20),
      ];
    }
    // 6+ Spires: 3 paired flank tiers; narrow mid-flank X to x=4 & x=14 when Center Waystone is active
    const midLeftX: [number, number] = reserveCenterWaystone
      ? [minX, minX]
      : tightLeftRange;
    const midRightX: [number, number] = reserveCenterWaystone
      ? [maxX, maxX]
      : tightRightRange;
    return [
      clampBand(tightLeftRange[0], tightLeftRange[1], 4, 6),
      clampBand(tightRightRange[0], tightRightRange[1], 4, 6),
      clampBand(midLeftX[0], midLeftX[1], 11, 13),
      clampBand(midRightX[0], midRightX[1], 11, 13),
      clampBand(tightLeftRange[0], tightLeftRange[1], 18, 20),
      clampBand(tightRightRange[0], tightRightRange[1], 18, 20),
    ].slice(0, spireCount);
  }

  if (layoutPattern === 'DIAMOND_COURT') {
    if (spireCount <= 4) {
      return [
        clampBand(8, 10, 4, 6),
        clampBand(4, 6, 11, 13),
        clampBand(12, 14, 11, 13),
        clampBand(8, 10, 18, 20),
      ].slice(0, spireCount);
    }
    // 5-point Star Diamond: x=4 / x=9 / x=14 guarantee >=5.0 spacing across mid row
    return [
      clampBand(8, 10, 4, 5),
      clampBand(4, 4, 10, 13),
      clampBand(9, 9, 11, 13),
      clampBand(14, 14, 10, 13),
      clampBand(8, 10, 19, 20),
    ].slice(0, spireCount);
  }

  if (layoutPattern === 'DIAGONAL_CASCADE') {
    if (spireCount <= 3) {
      return [
        mirrorBand(clampBand(4, 6, 4, 6)),
        clampBand(8, 10, 11, 13),
        mirrorBand(clampBand(12, 14, 18, 20)),
      ].slice(0, spireCount);
    }
    if (spireCount === 4) {
      return [
        mirrorBand(clampBand(4, 4, 4, 5)),
        mirrorBand(clampBand(7, 8, 9, 10)),
        mirrorBand(clampBand(11, 12, 14, 15)),
        mirrorBand(clampBand(14, 14, 19, 20)),
      ];
    }
    return [
      mirrorBand(clampBand(4, 5, 4, 5)),
      mirrorBand(clampBand(11, 13, 6, 7)),
      clampBand(7, 10, 11, 13),
      mirrorBand(clampBand(5, 6, 16, 17)),
      mirrorBand(clampBand(12, 14, 19, 20)),
    ].slice(0, spireCount);
  }

  if (layoutPattern === 'CITADEL_RING') {
    if (spireCount <= 4) {
      return [
        clampBand(4, 6, 5, 7),
        clampBand(12, 14, 5, 7),
        clampBand(4, 6, 17, 19),
        clampBand(12, 14, 17, 19),
      ].slice(0, spireCount);
    }
    return [
      clampBand(4, 6, 4, 6),
      clampBand(12, 14, 4, 6),
      clampBand(4, 4, 11, 13),
      clampBand(14, 14, 11, 13),
      clampBand(8, 10, 18, 20),
    ].slice(0, spireCount);
  }

  if (layoutPattern === 'WEST_GAUNTLET') {
    if (spireCount <= 3) {
      return [
        clampBand(4, 7, 4, 6),
        clampBand(4, 7, 11, 13),
        clampBand(4, 7, 18, 20),
      ].slice(0, spireCount);
    }
    return [
      clampBand(4, 5, 4, 5),
      clampBand(7, 9, 9, 10),
      clampBand(4, 5, 14, 15),
      clampBand(7, 9, 19, 20),
    ].slice(0, spireCount);
  }

  if (layoutPattern === 'EAST_GAUNTLET') {
    if (spireCount <= 3) {
      return [
        clampBand(11, 14, 4, 6),
        clampBand(11, 14, 11, 13),
        clampBand(11, 14, 18, 20),
      ].slice(0, spireCount);
    }
    return [
      clampBand(13, 14, 4, 5),
      clampBand(9, 11, 9, 10),
      clampBand(13, 14, 14, 15),
      clampBand(9, 11, 19, 20),
    ].slice(0, spireCount);
  }

  if (layoutPattern === 'NORTH_SOUTH_BASTIONS') {
    if (spireCount <= 4) {
      return [
        clampBand(4, 6, 4, 7),
        clampBand(12, 14, 4, 7),
        clampBand(4, 6, 17, 20),
        clampBand(12, 14, 17, 20),
      ].slice(0, spireCount);
    }
    const midYBand: [number, number] = mirrorX ? [13, 15] : [9, 11];
    return [
      clampBand(4, 6, 4, 6),
      clampBand(12, 14, 4, 6),
      clampBand(8, 10, midYBand[0], midYBand[1]),
      clampBand(4, 6, 18, 20),
      clampBand(12, 14, 18, 20),
    ].slice(0, spireCount);
  }

  // CLASSIC zigzag longitudinal bands (exact original behavior for Classic Rounds 1-8)
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

  // 5+ Spires in CLASSIC mode
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
      yMin: Math.max(minY, yMin),
      yMax: Math.min(maxY, yMax),
      xMin,
      xMax,
    });
  }
  return bands;
}

/**
 * Generates a deterministic, sliver-free 20x26 layout of 2x2 Elemental Spires,
 * optional Gilded Waystones (0, 1, or 2), and 3-9 Crimson Keeps using `mulberry32(seed)`.
 * - Spires sit inside x in [4..14], y in [4..20] so full 360-degree 1-tile corridor wraps
 *   and 2x2 outer walls always fit inside the island with >= 4-tile border gaps.
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

  const targetCheckpointCount = Array.isArray(baseRound.checkpoints)
    ? baseRound.checkpoints.length
    : 0;
  const layoutPattern: MapLayoutPattern = baseRound.layoutPattern ?? 'CLASSIC';
  const keepStyle: MapKeepStyle = baseRound.keepStyle ?? 'DEFAULT';
  const waystoneStyle: WaystoneLayoutStyle =
    baseRound.waystoneStyle ?? 'DEFAULT';
  const reserveCenterWaystone =
    targetCheckpointCount >= 1 && waystoneStyle === 'CENTER';

  const round: RoundConfig = {
    ...baseRound,
    mapId: baseRound.mapId ?? baseRound.roundNumber,
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

  // Orient lateral phase cleanly away from corner gates when appropriate
  let mirrorX = rng() < 0.5;
  if (layoutPattern === 'CLASSIC' && round.spireCount >= 5) {
    if (round.spawn.x <= 5) {
      mirrorX = true;
    } else if (round.spawn.x >= round.gridWidth - 7) {
      mirrorX = false;
    }
  } else if (layoutPattern === 'DIAGONAL_CASCADE') {
    if (round.spawn.x >= round.gridWidth - 7 && round.exit.x <= 5) {
      mirrorX = true; // NE -> SW cascade matching gates
    } else if (round.spawn.x <= 5 && round.exit.x >= round.gridWidth - 7) {
      mirrorX = false; // NW -> SE cascade matching gates
    }
  }

  // 1. Stratified 2x2 Elemental Spires inside (x in [4..14], y in [4..20])
  const spireMinX = 4;
  const spireMaxX = Math.max(spireMinX, round.gridWidth - 6); // 14
  const spireMinY = 4;
  const spireMaxY = Math.max(spireMinY, round.gridHeight - 6); // 20
  const requireMonotonicY = layoutPattern === 'CLASSIC';

  const zoneBands = buildSpireZoneBands(
    round.spireCount,
    round.gridWidth,
    round.gridHeight,
    mirrorX,
    layoutPattern,
    reserveCenterWaystone
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
    if (!clearOfPads(sx, sy, gatePads)) return false;

    for (const other of round.preplacedSpires) {
      if (do2x2Overlap(sx, sy, other.x, other.y)) return false;
      if (!hasTwoTileClearance(sx, sy, other.x, other.y)) return false;
      if (Math.hypot(other.x - sx, other.y - sy) < minCenterDist) return false;
    }
    return true;
  };

  for (let slotIdx = 0; slotIdx < round.spireCount; slotIdx++) {
    const band = zoneBands[slotIdx] ?? {
      xMin: spireMinX,
      xMax: spireMaxX,
      yMin: spireMinY,
      yMax: spireMaxY,
    };
    const spireType = getSpireArchetypeForSlot(round, slotIdx);
    const prevY =
      requireMonotonicY && round.preplacedSpires.length > 0
        ? round.preplacedSpires[round.preplacedSpires.length - 1].y
        : -1;
    let placed = false;

    // Pass A: Exact longitudinal + lateral band candidates (shuffled exhaustively)
    const bandCells: GridPoint[] = [];
    for (let sy = band.yMin; sy <= band.yMax; sy++) {
      if (requireMonotonicY && sy <= prevY) continue;
      for (let sx = band.xMin; sx <= band.xMax; sx++) {
        bandCells.push({ x: sx, y: sy });
      }
    }
    shuffleInPlace(bandCells);

    const distTiers =
      round.spireCount >= 6 || layoutPattern === 'DIAMOND_COURT'
        ? [6.2, 5.0, 4.4]
        : [6.8, 5.2, 4.5];

    for (const targetMinDist of distTiers) {
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

    // Pass B: In-band full-width fallback preserving band Y window & >= 4.5m spacing
    if (!placed) {
      const yLo = requireMonotonicY
        ? Math.max(spireMinY, prevY + 2, band.yMin - 1)
        : Math.max(spireMinY, band.yMin - 2);
      const yHi = Math.min(spireMaxY, band.yMax + 2);
      const wideBandCells: GridPoint[] = [];
      for (let sy = yLo; sy <= yHi; sy++) {
        for (let sx = spireMinX; sx <= spireMaxX; sx++) {
          wideBandCells.push({ x: sx, y: sy });
        }
      }
      shuffleInPlace(wideBandCells);

      for (const targetMinDist of [5.0, 4.2]) {
        if (placed) break;
        for (const cand of wideBandCells) {
          if (!canPlaceSpireAt(cand.x, cand.y, targetMinDist)) continue;
          round.preplacedSpires.push({ x: cand.x, y: cand.y, spireType });
          if (computeFullMazePath(round, []).valid) {
            placed = true;
            break;
          }
          round.preplacedSpires.pop();
        }
      }
    }

    // Pass C: Full-board guaranteed fallback so zero Spires are ever dropped
    if (!placed) {
      const allCells: GridPoint[] = [];
      for (let sy = spireMinY; sy <= spireMaxY; sy++) {
        for (let sx = spireMinX; sx <= spireMaxX; sx++) {
          allCells.push({ x: sx, y: sy });
        }
      }
      shuffleInPlace(allCells);
      for (const cand of allCells) {
        if (!canPlaceSpireAt(cand.x, cand.y, 4.0)) continue;
        round.preplacedSpires.push({ x: cand.x, y: cand.y, spireType });
        if (computeFullMazePath(round, []).valid) {
          placed = true;
          break;
        }
        round.preplacedSpires.pop();
      }
    }
  }

  // 2. Seeded 2x2 Gilded Waystones (supports 0, 1, or 2 Waystones with bespoke patterns)
  if (targetCheckpointCount > 0) {
    type CpWindow = { xLo: number; xHi: number; yLo: number; yHi: number };

    const tryPlaceWaystone = (
      windows: CpWindow[],
      minDistToExistingCp = 6.5
    ): boolean => {
      const allCands: GridPoint[] = [];
      const seen = new Set<number>();

      const pushWindow = (w: CpWindow) => {
        const cells: GridPoint[] = [];
        for (let cy = w.yLo; cy <= w.yHi; cy++) {
          for (let cx = w.xLo; cx <= w.xHi; cx++) {
            const key = cy * 32 + cx;
            if (seen.has(key)) continue;
            seen.add(key);
            cells.push({ x: cx, y: cy });
          }
        }
        shuffleInPlace(cells);
        allCands.push(...cells);
      };

      for (const w of windows) pushWindow(w);
      pushWindow({ xLo: 4, xHi: 14, yLo: 4, yHi: 20 });

      for (const distReq of [minDistToExistingCp, 4.0]) {
        for (const cp of allCands) {
          if (!clearOfPads(cp.x, cp.y, gatePads)) continue;
          if (
            round.preplacedSpires.some(
              (s) => !hasTwoTileClearance(cp.x, cp.y, s.x, s.y)
            )
          ) {
            continue;
          }
          if (
            round.checkpoints.some(
              (other) =>
                !hasTwoTileClearance(cp.x, cp.y, other.x, other.y) ||
                Math.hypot(cp.x - other.x, cp.y - other.y) < distReq
            )
          ) {
            continue;
          }
          round.checkpoints.push({ x: cp.x, y: cp.y });
          if (computeFullMazePath(round, []).valid) {
            return true;
          }
          round.checkpoints.pop();
        }
      }
      return false;
    };

    if (targetCheckpointCount === 1) {
      if (waystoneStyle === 'CENTER') {
        tryPlaceWaystone([
          { xLo: 8, xHi: 10, yLo: 10, yHi: 14 },
          { xLo: 6, xHi: 12, yLo: 8, yHi: 16 },
        ]);
      } else if (waystoneStyle === 'WEST_FLANK') {
        tryPlaceWaystone([
          { xLo: 4, xHi: 7, yLo: 8, yHi: 16 },
          { xLo: 4, xHi: 9, yLo: 6, yHi: 18 },
        ]);
      } else if (waystoneStyle === 'EAST_FLANK') {
        tryPlaceWaystone([
          { xLo: 11, xHi: 14, yLo: 8, yHi: 16 },
          { xLo: 9, xHi: 14, yLo: 6, yHi: 18 },
        ]);
      } else {
        // DEFAULT classic logic (preserved for R3, R6, R8)
        const preferWestFlank =
          (round.mapId ?? round.roundNumber) === 8 ? mirrorX : !mirrorX;
        const primary: [number, number] = preferWestFlank ? [4, 7] : [11, 14];
        const secondary: [number, number] = preferWestFlank ? [11, 14] : [4, 7];
        tryPlaceWaystone([
          { xLo: primary[0], xHi: primary[1], yLo: 8, yHi: 16 },
          { xLo: secondary[0], xHi: secondary[1], yLo: 8, yHi: 16 },
          { xLo: 4, xHi: 14, yLo: 8, yHi: 16 },
        ]);
      }
    } else {
      // 2 Waystones
      const firstWest = mirrorX;
      const flankA: [number, number] = firstWest ? [4, 7] : [11, 14];
      const flankB: [number, number] = firstWest ? [11, 14] : [4, 7];

      if (waystoneStyle === 'DUAL_REBOUND') {
        // Waystone 1 in LOWER half -> Waystone 2 pulls back up to UPPER opposite half!
        tryPlaceWaystone(
          [
            { xLo: flankA[0], xHi: flankA[1], yLo: 15, yHi: 19 },
            { xLo: 4, xHi: 14, yLo: 15, yHi: 19 },
          ],
          7.5
        );
        tryPlaceWaystone(
          [
            { xLo: flankB[0], xHi: flankB[1], yLo: 5, yHi: 9 },
            { xLo: 4, xHi: 14, yLo: 5, yHi: 9 },
          ],
          7.5
        );
      } else if (waystoneStyle === 'DUAL_VERTICAL') {
        tryPlaceWaystone(
          [
            { xLo: 7, xHi: 11, yLo: 5, yHi: 9 },
            { xLo: 5, xHi: 13, yLo: 5, yHi: 10 },
          ],
          7.0
        );
        tryPlaceWaystone(
          [
            { xLo: 7, xHi: 11, yLo: 15, yHi: 19 },
            { xLo: 5, xHi: 13, yLo: 14, yHi: 19 },
          ],
          7.0
        );
      } else {
        // DUAL_CROSS: Upper flank A -> Lower flank B
        tryPlaceWaystone(
          [
            { xLo: flankA[0], xHi: flankA[1], yLo: 5, yHi: 10 },
            { xLo: 4, xHi: 14, yLo: 5, yHi: 10 },
          ],
          7.5
        );
        tryPlaceWaystone(
          [
            { xLo: flankB[0], xHi: flankB[1], yLo: 14, yHi: 19 },
            { xLo: 4, xHi: 14, yLo: 14, yHi: 19 },
          ],
          7.5
        );
      }
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

  const isPerimeterKeepCoord = (ox: number, oy: number): boolean =>
    ox <= 4 || ox >= round.gridWidth - 6 || oy <= 4 || oy >= round.gridHeight - 6;

  const isCentralKeepCoord = (ox: number, oy: number): boolean =>
    ox >= 6 && ox <= 12 && oy >= 7 && oy <= 17;

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
  const spireAnchorBudget =
    keepStyle === 'BASTION_HEAVY'
      ? Math.max(2, Math.ceil(round.obstacleCount * 0.55))
      : keepStyle === 'PERIMETER' || keepStyle === 'CENTRAL'
      ? Math.max(2, Math.ceil(round.obstacleCount * 0.6))
      : round.obstacleCount;

  const spireOrder = shuffleInPlace(
    round.preplacedSpires.map((_, idx) => idx)
  );
  for (const sIdx of spireOrder) {
    if (round.obstacles.length >= spireAnchorBudget) break;
    const spire = round.preplacedSpires[sIdx];

    const alreadyAnchored = round.obstacles.some(
      (k) => Math.hypot(k.x - spire.x, k.y - spire.y) <= 8.2
    );
    if (alreadyAnchored) continue;

    const rawRing = [
      ...shuffleInPlace([...nearRingOffsets]),
      ...shuffleInPlace([...outerRingOffsets]),
    ];

    const ringTry =
      keepStyle === 'PERIMETER'
        ? [
            ...rawRing.filter((o) =>
              isPerimeterKeepCoord(spire.x + o.x, spire.y + o.y)
            ),
            ...rawRing.filter(
              (o) => !isPerimeterKeepCoord(spire.x + o.x, spire.y + o.y)
            ),
          ]
        : keepStyle === 'CENTRAL'
        ? [
            ...rawRing.filter((o) =>
              isCentralKeepCoord(spire.x + o.x, spire.y + o.y)
            ),
            ...rawRing.filter(
              (o) => !isCentralKeepCoord(spire.x + o.x, spire.y + o.y)
            ),
          ]
        : rawRing;

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

  // Pass B: Remaining Keeps — clean orthogonal 2-Keep bastions + style-biased meadow slots
  const orthogonalBastionOffsets: GridPoint[] = [
    { x: 2, y: 0 },
    { x: -2, y: 0 },
    { x: 0, y: 2 },
    { x: 0, y: -2 },
  ];
  const maxBastionPairs =
    keepStyle === 'BASTION_HEAVY'
      ? Math.min(3, Math.floor(round.obstacleCount / 2))
      : round.obstacleCount >= 7
      ? 2
      : round.obstacleCount >= 5
      ? 1
      : 0;
  const bastionChance = keepStyle === 'BASTION_HEAVY' ? 0.96 : 0.45;
  let bastionPairsCreated = 0;

  if (
    bastionPairsCreated < maxBastionPairs &&
    round.obstacles.length < round.obstacleCount &&
    rng() < bastionChance
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
        const passesBand =
          keepStyle === 'BASTION_HEAVY' || isWithinSpireBridgeBand(nx, ny);
        if (passesBand && canPlaceFlushBastionPartner(nx, ny, anchorIdx)) {
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
    const preferredCells: GridPoint[] = [];
    const bridgeCells: GridPoint[] = [];
    const openCells: GridPoint[] = [];
    for (let oy = keepMinY; oy <= keepMaxY; oy++) {
      for (let ox = keepMinX; ox <= keepMaxX; ox++) {
        if (!isSliverFreeKeepCoord(ox, oy)) continue;
        if (keepStyle === 'PERIMETER' && isPerimeterKeepCoord(ox, oy)) {
          preferredCells.push({ x: ox, y: oy });
        } else if (keepStyle === 'CENTRAL' && isCentralKeepCoord(ox, oy)) {
          preferredCells.push({ x: ox, y: oy });
        } else if (isWithinSpireBridgeBand(ox, oy)) {
          bridgeCells.push({ x: ox, y: oy });
        } else {
          openCells.push({ x: ox, y: oy });
        }
      }
    }
    const candidates = [
      ...shuffleInPlace(preferredCells),
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
export const DAILY_MAX_ATTEMPTS = 2;
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
  // Curated pool across all 57 rich maps (excluding intro Meadow Gate) for engaging daily puzzles
  const pool = ROUNDS.slice(1);
  const templateIndex = (puzzleNumber - 1 + (seed % pool.length)) % pool.length;
  const baseTemplate = pool[templateIndex] || ROUNDS[2];

  const generated = generateRandomRoundLayout(baseTemplate, seed);
  generated.roundNumber = 1;
  generated.mapId = baseTemplate.mapId ?? baseTemplate.roundNumber;
  generated.buildTimeSeconds = DAILY_BUILD_TIME_SECONDS;
  generated.title = `Daily #${puzzleNumber} · ${baseTemplate.title}`;

  return {
    dateKey: resolvedKey,
    puzzleNumber,
    roundConfig: generated,
  };
}
