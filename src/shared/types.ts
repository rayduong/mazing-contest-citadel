export type SpireType = 'THUNDERCLAP' | 'FROST_OBELISK' | 'CHRONO_SPIRE';
export type TowerType = 'BLOCK' | SpireType;
export type ActiveBuildTool = 'BLOCK' | 'SELL' | 'PAN';
export type RunnerArchetype = 'SCOUT' | 'OUTRIDER' | 'JUGGERNAUT' | 'HERALD';
export type GamePhase = 'LOBBY' | 'BUILD' | 'RUN' | 'ROUND_RESULTS' | 'GAME_OVER';

export interface GridPoint {
  x: number;
  y: number;
}

export interface SpirePoint extends GridPoint {
  spireType?: SpireType;
}

export interface RunnerArchetypeSpec {
  type: RunnerArchetype;
  name: string;
  icon: string;
  baseSpeed: number;
  slowDurationMult: number;
  slowResist: number;
  hasMomentum: boolean;
  traitSummary: string;
}

export const RUNNER_ARCHETYPES: Record<RunnerArchetype, RunnerArchetypeSpec> = {
  SCOUT: {
    type: 'SCOUT',
    name: 'Citadel Scout',
    icon: 'scout',
    baseSpeed: 3.5,
    slowDurationMult: 1.0,
    slowResist: 0.0,
    hasMomentum: false,
    traitSummary: '3.5 m/s · Standard slow duration',
  },
  OUTRIDER: {
    type: 'OUTRIDER',
    name: 'Royal Outrider',
    icon: 'outrider',
    baseSpeed: 3.85,
    slowDurationMult: 1.25,
    slowResist: 0.0,
    hasMomentum: false,
    traitSummary: '3.85 m/s · Slows last 25% longer',
  },
  JUGGERNAUT: {
    type: 'JUGGERNAUT',
    name: 'Iron Juggernaut',
    icon: 'juggernaut',
    baseSpeed: 3.25,
    slowDurationMult: 1.0,
    slowResist: 0.2,
    hasMomentum: false,
    traitSummary: '3.25 m/s · Resists 20% of slows unless Spire is Overcharged',
  },
  HERALD: {
    type: 'HERALD',
    name: 'Wind Herald',
    icon: 'herald',
    baseSpeed: 3.55,
    slowDurationMult: 1.05,
    slowResist: 0.0,
    hasMomentum: true,
    traitSummary: '3.55 m/s · Gains +28% speed after 3.2s un-slowed outside Spires',
  },
};

export interface TowerSpec {
  type: TowerType;
  name: string;
  hotkey: string;
  goldCost: number;
  footprint: 2;
  walkable: boolean;
  range: number;
  cooldown: number;
  slowPercent: number;
  slowDuration: number;
  auraSlowPercent?: number;
  cdrPulseSeconds?: number;
  description: string;
  accentColor: string;
}

export const TOWER_SPECS: Record<TowerType, TowerSpec> = {
  BLOCK: {
    type: 'BLOCK',
    name: 'Stone Wall',
    hotkey: 'Q',
    goldCost: 5,
    footprint: 2,
    walkable: false,
    range: 0,
    cooldown: 0,
    slowPercent: 0,
    slowDuration: 0,
    description:
      '2×2 stone wall. Connects to nearby walls and links Crimson Keeps to Overcharge Spires.',
    accentColor: '#38bdf8',
  },
  THUNDERCLAP: {
    type: 'THUNDERCLAP',
    name: 'Storm Spire',
    hotkey: '',
    goldCost: 0,
    footprint: 2,
    walkable: false,
    range: 3.45,
    cooldown: 3.0,
    slowPercent: 0.5,
    slowDuration: 2.4,
    description:
      'Pulses every 3.0s, slowing runners by 50% for 2.4s. Strongest on multi-pass switchbacks.',
    accentColor: '#f59e0b',
  },
  FROST_OBELISK: {
    type: 'FROST_OBELISK',
    name: 'Frost Obelisk',
    hotkey: '',
    goldCost: 0,
    footprint: 2,
    walkable: false,
    range: 3.25,
    cooldown: 3.4,
    slowPercent: 0.45,
    slowDuration: 2.2,
    auraSlowPercent: 0.22,
    description:
      'Chills runners by 22% inside its ring and bursts for a 45% slow every 3.4s. Rewards tight spirals.',
    accentColor: '#38bdf8',
  },
  CHRONO_SPIRE: {
    type: 'CHRONO_SPIRE',
    name: 'Chrono Spire',
    hotkey: '',
    goldCost: 0,
    footprint: 2,
    walkable: false,
    range: 3.65,
    cooldown: 3.8,
    slowPercent: 0.55,
    slowDuration: 2.0,
    cdrPulseSeconds: 1.2,
    description:
      'Slows runners by 55% every 3.8s and cuts 1.2s off every other Spire cooldown.',
    accentColor: '#c084fc',
  },
};

export interface PlacedTower {
  id: string;
  type: 'BLOCK';
  x: number;
  y: number;
  createdAt: number;
}

export interface WaygatePair {
  entry: GridPoint; // 2x2 pad top-left
  exit: GridPoint;  // 2x2 pad top-left
}

export interface RoundConfig {
  roundNumber: number;
  title: string;
  subtitle: string;
  hint: string;
  seed?: number;
  runnerType?: RunnerArchetype;
  gridWidth: number;
  gridHeight: number;
  buildTimeSeconds: number;
  startingGold: number;
  spawn: GridPoint;
  exit: GridPoint;
  checkpoints: GridPoint[];
  obstacleCount: number;
  spireCount: number;
  frostMireCount: number;
  hasteRiftCount: number;
  hasWaygate?: boolean;
  obstacles: GridPoint[];       // 2x2 pre-placed Crimson Keeps
  preplacedSpires: SpirePoint[]; // 2x2 pre-placed Elemental Spires (Storm, Frost, Chrono)
  frostMires: GridPoint[];
  hasteRifts: GridPoint[];
  waygate?: WaygatePair;
  parTimeSeconds: number;
}

export interface PathSegment {
  fromIndex: number;
  toIndex: number;
  points: GridPoint[];
  distance: number;
}

export interface PathResult {
  valid: boolean;
  segments: PathSegment[];
  allPoints: GridPoint[];
  totalDistance: number;
}

export interface SimEvent {
  type: 'CLAP' | 'CHECKPOINT' | 'WAYGATE' | 'FINISH';
  playerId: string;
  x: number;
  y: number;
  targetX?: number;
  targetY?: number;
  towerId?: string;
  spireType?: SpireType;
  overchargeTier?: number;
  cdrAppliedSeconds?: number;
  armoredResisted?: boolean;
  checkpointIndex?: number;
  timeSeconds: number;
}

export interface TowerSimState {
  id: string;
  type: SpireType;
  centerX: number;
  centerY: number;
  overchargeTier: number;
  effectiveRange: number;
  effectiveCooldown: number;
  cooldownRemaining: number;
  triggeredCount: number;
}

export interface RunnerSimState {
  playerId: string;
  x: number;
  y: number;
  facingAngle: number;
  currentSegmentIndex: number;
  currentWaypointIndex: number;
  baseSpeed: number;
  currentSpeed: number;
  clapSlowRemaining: number;
  activeSlowPercent: number;
  strongSlowRemaining?: number;
  strongSlowPercent?: number;
  armoredHitRemaining?: number;
  exposureStacks: number;
  timeSinceLastSpireSec: number;
  inPermafrostAura: boolean;
  hasTailwindMomentum: boolean;
  inFrostMire: boolean;
  inHasteRift: boolean;
  waygateUsed: boolean;
  finished: boolean;
  finishTimeSeconds: number;
  elapsedSeconds?: number;
  distanceTraveled: number;
  checkpointsReached: number;
  clapsTaken: number;
  towers: Record<string, TowerSimState>;
}

export interface MazeEvalResult {
  finishTimeSeconds: number;
  distance: number;
  clapsTaken: number;
  clapLocations: GridPoint[];
  perSpireClaps: Record<string, number>;
  linkedKeeps: number;
  overchargedSpires: number;
  spireOverchargeTiers: number[];
}

export interface RoundScoreEntry {
  roundNumber: number;
  timeSeconds: number;
  pointsEarned: number;
  rank: number;
  clapsTaken?: number;
  overchargedSpires?: number;
  linkedKeeps?: number;
  distance?: number;
  beatPar?: boolean;
}

export interface PlayerState {
  id: string;
  name: string;
  color: string;
  isBot: boolean;
  botDifficulty?: 'NOVICE' | 'ARCHITECT' | 'GRANDMASTER';
  botStyle?: 'SWITCHBACK' | 'SPIRAL' | 'CLAP_CHAIN';
  isHost: boolean;
  ready: boolean;
  gold: number;
  towers: PlacedTower[];
  pathDistance: number;
  fogMasked?: boolean;
  usedSampleMaze?: boolean;
  connected?: boolean;
  totalScore: number;
  lastRoundTime: number | null;
  lastRoundPoints: number;
  lastRoundClaps?: number;
  lastRoundOvercharge?: number;
  lastRoundKeeps?: number;
  parStarsEarned?: number;
  bestMazeTime: number;
  roundHistory: RoundScoreEntry[];
}

export interface RoomSettings {
  roomName: string;
  isPublic: boolean;
  totalRounds: number;
  buildTimeSeconds: number; // 0 = Round Default, or custom override (e.g. 45, 60, 90, 120, 999)
  goldMultiplier: number;   // 0.8 (80%), 1.0 (Normal), 1.25 (125%)
  botCount: number;         // 0..5
  botDifficulty: 'NOVICE' | 'ARCHITECT' | 'GRANDMASTER';
  fogOfWar: boolean;
}

export interface LobbyRoomSummary {
  roomCode: string;
  roomName: string;
  hostName: string;
  phase: GamePhase;
  currentRound: number;
  totalRounds: number;
  playerCount: number;
  humanCount: number;
  botCount: number;
  maxPlayers: number;
  settings: RoomSettings;
}

export interface LeaderboardRoundEntry {
  id: string;
  roundNumber: number;
  roundTitle: string;
  runnerType: RunnerArchetype;
  playerName: string;
  playerColor: string;
  isBot?: boolean;
  survivalTimeSeconds: number;
  parTimeSeconds: number;
  beatPar: boolean;
  clapsTaken: number;
  overchargedSpires: number;
  linkedKeeps: number;
  pathDistance: number;
  goldMultiplier: number;
  roomCode: string;
  timestamp: number;
}

export interface LeaderboardChampionEntry {
  playerName: string;
  playerColor: string;
  matchesWon: number;
  roundsPlayed: number;
  totalCareerPoints: number;
  parStarsEarned: number;
  bestSurvivalTime: number;
  bestRoundNumber: number;
  lastPlayedAt: number;
}

export interface LeaderboardPayload {
  roundRecords: Record<number, LeaderboardRoundEntry[]>;
  champions: LeaderboardChampionEntry[];
  updatedAt: number;
}

export interface ChatMessage {
  id: string;
  senderName: string;
  senderColor: string;
  text: string;
  timestamp: number;
  isSystem?: boolean;
}

export interface RoomState {
  roomCode: string;
  phase: GamePhase;
  settings: RoomSettings;
  currentRoundIndex: number;
  roundsCompleted?: number;
  roundConfig: RoundConfig;
  phaseTimeRemaining: number;
  runElapsed?: number;
  simSpeedMultiplier: 1 | 2 | 4;
  players: PlayerState[];
  chat: ChatMessage[];
  newRecordHolders?: string[];
}

export type ClientToServerMessage =
  | {
      type: 'JOIN_ROOM';
      roomCode: string;
      playerName: string;
      sessionId?: string;
      createSettings?: Partial<RoomSettings>;
    }
  | {
      type: 'CREATE_ROOM';
      roomCode?: string;
      playerName: string;
      sessionId?: string;
      settings: Partial<RoomSettings>;
    }
  | { type: 'SET_NAME'; playerName: string }
  | { type: 'PLACE_TOWER'; x: number; y: number; clientId?: string }
  | { type: 'SELL_TOWER'; towerId: string; x?: number; y?: number }
  | { type: 'RESTORE_TOWERS'; towers: GridPoint[] }
  | { type: 'CLEAR_TOWERS' }
  | { type: 'LOAD_PRESET_DEMO' }
  | { type: 'REROLL_MAP' }
  | { type: 'TOGGLE_READY' }
  | { type: 'START_GAME'; roundIndex?: number }
  | { type: 'NEXT_ROUND' }
  | { type: 'RESTART_MATCH' }
  | { type: 'JUMP_TO_ROUND'; roundIndex: number }
  | { type: 'SET_SIM_SPEED'; speed: 1 | 2 | 4 }
  | { type: 'UPDATE_SETTINGS'; settings: Partial<RoomSettings> }
  | { type: 'ADD_BOT'; difficulty?: 'NOVICE' | 'ARCHITECT' | 'GRANDMASTER' }
  | { type: 'REMOVE_BOT'; botId?: string }
  | { type: 'REQUEST_LOBBIES' }
  | { type: 'CHAT'; text: string };

export type ServerToClientMessage =
  | { type: 'WELCOME'; playerId: string; sessionId?: string; state: RoomState }
  | { type: 'ROOM_STATE'; state: RoomState }
  | {
      type: 'TIMER_TICK';
      phaseTimeRemaining: number;
      phase?: GamePhase;
      runElapsed?: number;
    }
  | { type: 'LOBBY_LIST'; rooms: LobbyRoomSummary[] }
  | { type: 'LEADERBOARD_DATA'; leaderboard: LeaderboardPayload }
  | { type: 'CHAT_MESSAGE'; message: ChatMessage }
  | { type: 'ERROR_TOAST'; message: string };
