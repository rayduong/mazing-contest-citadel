import { GridPoint, RoundConfig } from './types.js';

export type TutorialStepKind = 'PLACE' | 'REMOVE' | 'RUN';

export interface TutorialStepDef {
  id: string;
  stepNumber: number;
  kind: TutorialStepKind;
  title: string;
  instruction: string;
  touchInstruction?: string;
  targets: GridPoint[];
  removeTarget?: GridPoint;
  focusPoint: GridPoint;
  allowFreeBuild?: boolean;
}

export const TUTORIAL_ROUND_CONFIG: RoundConfig = {
  roundNumber: 1,
  mapId: 0,
  title: 'Guided Training Grounds',
  subtitle: '1 Storm · 1 Frost · 4 Keeps · Citadel Scout',
  hint: 'Follow the glowing gold targets to build an Overcharged S-curve maze!',
  seed: 202601,
  runnerType: 'SCOUT',
  spireTypes: ['THUNDERCLAP', 'FROST_OBELISK'],
  layoutPattern: 'CENTER_SPINE',
  keepStyle: 'DEFAULT',
  waystoneStyle: 'DEFAULT',
  gridWidth: 20,
  gridHeight: 26,
  buildTimeSeconds: 999,
  startingGold: 100, // 20 walls (11 guided walls + 9 bonus walls for free play!)
  spawn: { x: 15, y: 0 },
  exit: { x: 15, y: 24 },
  checkpoints: [],
  obstacleCount: 4,
  spireCount: 2,
  frostMireCount: 0,
  hasteRiftCount: 0,
  obstacles: [
    { x: 16, y: 8 },
    { x: 16, y: 16 },
    { x: 2, y: 12 },
    { x: 4, y: 12 },
  ],
  preplacedSpires: [
    { x: 10, y: 8, spireType: 'THUNDERCLAP' },
    { x: 10, y: 16, spireType: 'FROST_OBELISK' },
  ],
  frostMires: [],
  hasteRifts: [],
  parTimeSeconds: 20.0,
};

export const TUTORIAL_STEPS: TutorialStepDef[] = [
  {
    id: 'overcharge_storm',
    stepNumber: 1,
    kind: 'PLACE',
    title: 'Block the Lane & Overcharge the Storm Spire',
    instruction:
      'The runner wants to sprint straight down the east edge. Place 3 Stone Walls on the glowing gold squares to seal the east cliff and connect the red Crimson Keep to Overcharge the yellow Storm Spire (◆)!',
    touchInstruction:
      'Tap a glowing gold square and tap Place (or re-tap the ghost) to place all 3 walls, sealing the cliff and Overcharging the Storm Spire.',
    targets: [
      { x: 18, y: 8 },
      { x: 14, y: 8 },
      { x: 12, y: 8 },
    ],
    focusPoint: { x: 14, y: 8 },
  },
  {
    id: 'overcharge_frost',
    stepNumber: 2,
    kind: 'PLACE',
    title: 'Power Up the Frost Obelisk',
    instruction:
      'Awesome — look at the yellow Spire glow with ◆ Overcharge! Now place 3 walls below to connect the lower red Keep to the blue Frost Obelisk so it chills and slows the runner.',
    touchInstruction:
      'Place 3 walls on the lower glowing gold squares to Overcharge the blue Frost Obelisk.',
    targets: [
      { x: 18, y: 16 },
      { x: 14, y: 16 },
      { x: 12, y: 16 },
    ],
    focusPoint: { x: 14, y: 16 },
  },
  {
    id: 'switchback_baffle',
    stepNumber: 3,
    kind: 'PLACE',
    title: 'Fold an S-Curve Switchback',
    instruction:
      'Great mazes force runners to zigzag! Place 4 walls off the western red Keep bastion to force the runner back east between your two Overcharged Spires—watch your Est. Time jump past 20s!',
    touchInstruction:
      'Place 4 walls on the middle glowing squares to build an S-curve switchback between both Spires.',
    targets: [
      { x: 0, y: 12 },
      { x: 6, y: 12 },
      { x: 8, y: 12 },
      { x: 10, y: 12 },
    ],
    focusPoint: { x: 7, y: 12 },
  },
  {
    id: 'extend_choke',
    stepNumber: 4,
    kind: 'PLACE',
    title: 'Extend the Corridor',
    instruction:
      'Add 2 more walls to stretch the middle baffle even farther east—forcing extra seconds inside both Spire slow rings!',
    touchInstruction:
      'Place 2 more walls on the glowing gold squares to stretch the switchback corridor.',
    targets: [
      { x: 12, y: 12 },
      { x: 14, y: 12 },
    ],
    focusPoint: { x: 13, y: 12 },
  },
  {
    id: 'remove_wall',
    stepNumber: 5,
    kind: 'REMOVE',
    title: 'Reclaim a Wall (100% Free Refund)',
    instruction:
      'You can always reshape your maze—removing a wall refunds +1 wall immediately. Right-click the pulsing red wall (or press X and click it) to reclaim it.',
    touchInstruction:
      'Tap the pulsing red wall, then tap Remove (+1) to reclaim it for a free refund.',
    targets: [],
    removeTarget: { x: 14, y: 12 },
    focusPoint: { x: 14, y: 12 },
  },
  {
    id: 'run_maze',
    stepNumber: 6,
    kind: 'RUN',
    title: 'Release the Runner!',
    instruction:
      'Your Overcharged S-curve maze already beats 20s Par! Feel free to place extra walls anywhere you like, then press Start (Space) to watch your maze in action.',
    touchInstruction:
      'Place any extra walls you like, then tap Start to release the runner and watch your Spires go to work!',
    targets: [],
    focusPoint: { x: 10, y: 12 },
    allowFreeBuild: true,
  },
];
