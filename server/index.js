import express from 'express';
import fs from 'fs';
import path from 'path';
import http from 'http';
import { fileURLToPath } from 'url';
import { WebSocketServer } from 'ws';
import { createServer as createViteServer } from 'vite';
import { createPersistenceStorage } from './storage.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');
const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(__dirname, 'data');

const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;
const PLANNING_TIME_SECONDS = 5;
const RECONNECT_GRACE_MS = 45_000;
const UNREADY_BLIP_HOLD_MS = 5_000;
const HOST_MIGRATE_DELAY_MS = 5_000;
const POST_FINISH_HOLD_REAL_SEC = 1.3;
const MAX_RANKED_REROLLS_PER_ROUND = 2;
const MAX_TOTAL_REROLLS_PER_ROUND = 8;
const WS_MAX_PAYLOAD_BYTES = 16 * 1024;
const WS_CLOSE_SESSION_SUPERSEDED = 4001;
const MAX_SOCKETS_PER_IP = 32;

const PLAYER_COLORS = [
  '#38bdf8', // Cyan (Player 1)
  '#f59e0b', // Amber Gold (Player 2)
  '#c084fc', // Violet (Player 3)
  '#34d399', // Emerald (Player 4)
  '#f43f5e', // Coral Rose (Player 5)
  '#fb923c', // Warm Orange (Player 6)
];

// IP-clean Original Mason Bot Roster (no " [AI]" suffix; UI renders BOT badge via isBot)
const BOT_PRESETS = [
  { name: 'Master Pender', difficulty: 'GRANDMASTER', style: 'SWITCHBACK' },
  { name: 'Mason Rowan', difficulty: 'ARCHITECT', style: 'SPIRAL' },
  { name: 'Warden Soren', difficulty: 'ARCHITECT', style: 'CLAP_CHAIN' },
  { name: 'Apprentice Pip', difficulty: 'NOVICE', style: 'SWITCHBACK' },
  { name: 'Lady Maren', difficulty: 'GRANDMASTER', style: 'SPIRAL' },
];

const LEGACY_SEED_BOT_NAMES = [
  'Archon Vance',
  'Guildmaster Sera',
  'Master Kaelen',
  'Warden Thorne',
  'Mason Tovin',
];

const BOT_AND_SEED_NAMES_LOWER = new Set([
  ...BOT_PRESETS.map((b) => b.name.toLowerCase()),
  ...LEGACY_SEED_BOT_NAMES.map((n) => n.toLowerCase()),
]);

const RESERVED_NAMES_LOWER = new Set([
  ...BOT_PRESETS.map((b) => b.name.toLowerCase()),
]);

const HEAVY_CPU_ACTIONS = new Set([
  'CREATE_ROOM',
  'START_SOLO',
  'START_DAILY',
  'REROLL_MAP',
  'LOAD_PRESET_DEMO',
  'JUMP_TO_ROUND',
  'UPDATE_SETTINGS',
  'ADD_BOT',
]);

// Clean human-only map leaderboard (zero bots or seeded NPCs)
function createEmptyLeaderboard() {
  return {
    mapRecords: {},
    roundRecords: {},
    champions: [],
    updatedAt: Date.now(),
  };
}

/**
 * Strips any AI bots or legacy seeded NPC pacesetters from persisted leaderboards
 * (both disk JSON and PostgreSQL) and ensures every entry is keyed strictly by mapId.
 */
function sanitizeLeaderboard(lb, getMapByIdFn) {
  const safe =
    lb && typeof lb === 'object' ? lb : createEmptyLeaderboard();
  const rawRecords =
    safe.mapRecords && typeof safe.mapRecords === 'object'
      ? safe.mapRecords
      : safe.roundRecords && typeof safe.roundRecords === 'object'
      ? safe.roundRecords
      : {};

  let changed = false;
  /** @type {Record<number, any[]>} */
  const cleanRecords = {};

  for (const [key, list] of Object.entries(rawRecords)) {
    if (!Array.isArray(list)) {
      changed = true;
      continue;
    }
    const mapId = Number(key);
    if (!Number.isInteger(mapId) || mapId < 1) {
      changed = true;
      continue;
    }
    const mapMeta = typeof getMapByIdFn === 'function' ? getMapByIdFn(mapId) : null;
    const filtered = [];
    for (const rec of list) {
      if (!rec || typeof rec !== 'object') {
        changed = true;
        continue;
      }
      const lowerName = String(rec.playerName || '').trim().toLowerCase();
      if (
        rec.isBot === true ||
        String(rec.id || '').startsWith('seed_') ||
        !lowerName ||
        BOT_AND_SEED_NAMES_LOWER.has(lowerName)
      ) {
        changed = true;
        continue;
      }
      const normalizedRec = {
        ...rec,
        mapId,
        mapTitle: rec.mapTitle || rec.roundTitle || mapMeta?.title || `Map #${mapId}`,
        roundNumber: mapId,
        roundTitle: rec.mapTitle || rec.roundTitle || mapMeta?.title || `Map #${mapId}`,
        isBot: false,
      };
      if (rec.mapId !== mapId || !rec.mapTitle) changed = true;
      filtered.push(normalizedRec);
    }
    if (filtered.length > 0) {
      filtered.sort((a, b) => (b.survivalTimeSeconds || 0) - (a.survivalTimeSeconds || 0));
      cleanRecords[mapId] = filtered.slice(0, 12);
    } else if (list.length > 0) {
      changed = true;
    }
  }

  const rawChamps = Array.isArray(safe.champions) ? safe.champions : [];
  const cleanChamps = [];
  for (const c of rawChamps) {
    if (!c || typeof c !== 'object') {
      changed = true;
      continue;
    }
    const lowerName = String(c.playerName || '').trim().toLowerCase();
    if (
      c.isBot === true ||
      !lowerName ||
      BOT_AND_SEED_NAMES_LOWER.has(lowerName)
    ) {
      changed = true;
      continue;
    }
    const bestMapId = Number(c.bestMapId || c.bestRoundNumber) || 1;
    const bestMapMeta =
      typeof getMapByIdFn === 'function' ? getMapByIdFn(bestMapId) : null;
    const normalizedChamp = {
      ...c,
      bestMapId,
      bestMapTitle: c.bestMapTitle || bestMapMeta?.title || `Map #${bestMapId}`,
      bestRoundNumber: bestMapId,
    };
    if (!c.bestMapId || !c.bestMapTitle) changed = true;
    cleanChamps.push(normalizedChamp);
  }
  cleanChamps.sort(
    (a, b) =>
      (b.totalCareerPoints || 0) - (a.totalCareerPoints || 0) ||
      (b.matchesWon || 0) - (a.matchesWon || 0) ||
      (b.bestSurvivalTime || 0) - (a.bestSurvivalTime || 0)
  );

  if (!safe.mapRecords) changed = true;

  return {
    cleaned: {
      mapRecords: cleanRecords,
      roundRecords: cleanRecords,
      champions: cleanChamps.slice(0, 20),
      updatedAt: Number(safe.updatedAt) || Date.now(),
    },
    changed,
  };
}

function fallbackEffectivePar(baseParSeconds, goldMultiplier = 1.0) {
  const mult = Number(goldMultiplier) || 1.0;
  const factor = mult <= 0.85 ? 0.86 : mult >= 1.15 ? 1.08 : 1.0;
  return Number((baseParSeconds * factor).toFixed(1));
}

function computeRoundBuildSeconds(baseRound, settings) {
  const customSecs = Number(settings.buildTimeSeconds) || 0;
  if (customSecs > 0) return customSecs;
  // Grant +15s build time at 1.25x (125% Wall Supply) when using Default timer
  const supplyBonus = Number(settings.goldMultiplier) >= 1.2 ? 15 : 0;
  return baseRound.buildTimeSeconds + supplyBonus;
}

function sanitizePlayerName(rawName, fallbackNumber) {
  let cleaned = String(rawName || '')
    .replace(/\s*\[AI\]$/i, '')
    .replace(/\s*\[BOT\]$/i, '')
    .trim()
    .slice(0, 20);
  if (!cleaned) {
    const num = fallbackNumber || Math.floor(100 + Math.random() * 899);
    return `Player ${num}`;
  }
  if (RESERVED_NAMES_LOWER.has(cleaned.toLowerCase())) {
    cleaned = `${cleaned.slice(0, 17)} II`;
  }
  return cleaned;
}

function sanitizeSessionId(rawSessionId) {
  if (typeof rawSessionId === 'string') {
    const clean = rawSessionId
      .trim()
      .replace(/[^a-zA-Z0-9_-]/g, '')
      .slice(0, 48);
    if (clean.length >= 6) return clean;
  }
  return `ses_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function sanitizeClientId(rawClientId) {
  if (typeof rawClientId !== 'string') return undefined;
  const clean = rawClientId.trim().replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 36);
  return clean.length > 0 ? clean : undefined;
}

function getClientIp(req) {
  const forwarded = req?.headers?.['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.length > 0) {
    return forwarded.split(',')[0].trim();
  }
  return req?.socket?.remoteAddress || 'unknown';
}

async function startServer() {
  const app = express();
  app.use(express.json({ limit: '16kb' }));
  const server = http.createServer(app);

  const distPath = path.join(ROOT_DIR, 'dist');
  const isProdStatic =
    process.env.NODE_ENV === 'production' &&
    fs.existsSync(path.join(distPath, 'index.html'));

  const vite = await createViteServer({
    server: {
      middlewareMode: true,
      allowedHosts: true,
      ...(isProdStatic ? { hmr: false, watch: null } : {}),
    },
    appType: isProdStatic ? 'custom' : 'spa',
  });

  // Load shared TypeScript game modules via Vite SSR loader
  const roundsMod = await vite.ssrLoadModule('/src/shared/rounds.ts');
  const {
    ROUNDS,
    DEFAULT_MATCH_ROUNDS = 8,
    getMapById,
    createShuffledMapDeck,
    isInfiniteRounds,
    isInfiniteBuildTime,
    normalizeAllowedRunners,
    generateRandomRoundLayout,
    generateDailyRoundConfig,
    getDailyDateKeyUtc,
    getNextDailyResetUtcMs,
    DAILY_BUILD_TIME_SECONDS,
  } = roundsMod;
  const computeEffectivePar =
    typeof roundsMod.computeEffectivePar === 'function'
      ? roundsMod.computeEffectivePar
      : fallbackEffectivePar;

  const {
    TOWER_SPECS,
    INFINITE_ROUNDS = 999,
    INFINITE_BUILD_TIME = 999,
    MIN_CUSTOM_ROUNDS = 1,
    MAX_CUSTOM_ROUNDS = 100,
    MIN_CUSTOM_BUILD_SECONDS = 15,
    MAX_CUSTOM_BUILD_SECONDS = 600,
  } = await vite.ssrLoadModule('/src/shared/types.ts');
  const { computeFullMazePath, validateTowerPlacement } =
    await vite.ssrLoadModule('/src/shared/pathfinding.ts');
  const { evaluateMazeRunTime } = await vite.ssrLoadModule(
    '/src/shared/simulation.ts'
  );
  const aiBuilderMod = await vite.ssrLoadModule('/src/shared/aiBuilder.ts');
  const { generateMazeLayout } = aiBuilderMod;
  const selectSampleMazeStyle =
    typeof aiBuilderMod.selectSampleMazeStyle === 'function'
      ? aiBuilderMod.selectSampleMazeStyle
      : () => 'SWITCHBACK';

  // Release Vite dev watcher/HMR graph in production once shared ESM modules are in V8 memory
  if (isProdStatic) {
    await vite.close().catch(() => {});
  }

  // Initialize durable persistence (PostgreSQL via DATABASE_URL -> DATA_DIR disk -> local JSON fallback)
  const storage = createPersistenceStorage({ defaultDataDir: DATA_DIR });
  await storage.init();

  const rawLoadedLeaderboard = await storage.loadLeaderboard(
    createEmptyLeaderboard()
  );
  const { cleaned: sanitizedLb, changed: lbSanitized } = sanitizeLeaderboard(
    rawLoadedLeaderboard,
    getMapById
  );
  let leaderboard = sanitizedLb;
  if (lbSanitized) {
    console.log('Sanitized leaderboard: removed bots/seeded entries & migrated to map-specific records.');
    void storage.saveLeaderboard(leaderboard);
  }

  function saveLeaderboard() {
    void storage.saveLeaderboard(leaderboard);
  }

  /** @type {{ days: Record<string, any[]>; updatedAt: number }} */
  let dailyStore = await storage.loadDailyStore();

  function saveDailyEntry(dateKey, entry) {
    void storage.saveDailyEntry(dateKey, entry, dailyStore);
  }

  /** @type {Map<string, { dateKey: string; puzzleNumber: number; roundConfig: any }>} */
  const dailyConfigCache = new Map();

  function getCachedDailyConfig(dateKey) {
    const key = dateKey || getDailyDateKeyUtc();
    if (!dailyConfigCache.has(key)) {
      if (dailyConfigCache.size > 4) dailyConfigCache.clear();
      dailyConfigCache.set(key, generateDailyRoundConfig(key));
    }
    return dailyConfigCache.get(key);
  }

  function cloneRoundConfig(rc) {
    return JSON.parse(JSON.stringify(rc));
  }

  function sanitizeDailyClientId(rawId) {
    if (typeof rawId === 'string') {
      const clean = rawId
        .trim()
        .replace(/[^a-zA-Z0-9_-]/g, '')
        .slice(0, 56);
      if (clean.length >= 6) return clean;
    }
    return '';
  }

  function compareDailyEntries(a, b) {
    const timeDiff =
      Number((b.survivalTimeSeconds || 0).toFixed(2)) -
      Number((a.survivalTimeSeconds || 0).toFixed(2));
    if (timeDiff !== 0) return timeDiff;
    const overDiff = (b.overchargedSpires || 0) - (a.overchargedSpires || 0);
    if (overDiff !== 0) return overDiff;
    const clapsDiff = (b.clapsTaken || 0) - (a.clapsTaken || 0);
    if (clapsDiff !== 0) return clapsDiff;
    const wallsDiff = (a.wallsUsed || 0) - (b.wallsUsed || 0);
    if (wallsDiff !== 0) return wallsDiff;
    return (a.timestamp || 0) - (b.timestamp || 0);
  }

  function getDailyEntriesForDay(dateKey) {
    if (!Array.isArray(dailyStore.days[dateKey])) {
      dailyStore.days[dateKey] = [];
    }
    return dailyStore.days[dateKey];
  }

  function hasCompletedDaily(dateKey, dailyClientId) {
    const cid = sanitizeDailyClientId(dailyClientId);
    if (!cid) return false;
    const entries = getDailyEntriesForDay(dateKey);
    return entries.some((e) => e.clientId === cid);
  }

  function buildDailyPayload(dailyClientId, playerName) {
    const dateKey = getDailyDateKeyUtc();
    const { puzzleNumber, roundConfig } = getCachedDailyConfig(dateKey);
    const entries = getDailyEntriesForDay(dateKey);
    entries.sort(compareDailyEntries);

    const ranked = entries.map((e, idx) => ({
      ...e,
      rank: idx + 1,
    }));

    const cid = sanitizeDailyClientId(dailyClientId);
    const nameLower = String(playerName || '').trim().toLowerCase();
    let myIdx = cid ? ranked.findIndex((e) => e.clientId === cid) : -1;
    if (myIdx === -1 && nameLower) {
      myIdx = ranked.findIndex(
        (e) => String(e.playerName || '').trim().toLowerCase() === nameLower
      );
    }

    const totalParticipants = ranked.length;
    const myStanding =
      myIdx !== -1
        ? {
            rank: myIdx + 1,
            totalParticipants,
            percentile: Math.max(
              1,
              Math.round(((myIdx + 1) / Math.max(1, totalParticipants)) * 100)
            ),
            entry: ranked[myIdx],
          }
        : null;

    return {
      dateKey,
      puzzleNumber,
      resetsAtUtcMs: getNextDailyResetUtcMs(),
      puzzle: {
        dateKey,
        puzzleNumber,
        title: roundConfig.title,
        subtitle: roundConfig.subtitle,
        hint: roundConfig.hint,
        runnerType: roundConfig.runnerType || 'SCOUT',
        parTimeSeconds: roundConfig.parTimeSeconds,
        buildTimeSeconds: DAILY_BUILD_TIME_SECONDS || 120,
        wallCount: Math.floor(
          roundConfig.startingGold / TOWER_SPECS.BLOCK.goldCost
        ),
        spireCount: roundConfig.preplacedSpires.length,
        keepCount: roundConfig.obstacles.length,
        hasWaystone: (roundConfig.checkpoints?.length || 0) > 0,
      },
      top10: ranked.slice(0, 10),
      totalParticipants,
      completedToday: cid ? entries.some((e) => e.clientId === cid) : false,
      myStanding,
      updatedAt: dailyStore.updatedAt,
    };
  }

  function recordDailyResult(dateKey, player, room) {
    if (!player || player.isBot) return false;
    const cid = sanitizeDailyClientId(player._dailyClientId || player._sessionId);
    if (!cid) return false;

    const entries = getDailyEntriesForDay(dateKey);
    // Strict 1 official attempt per day
    if (entries.some((e) => e.clientId === cid)) {
      return false;
    }

    const evalRes = evaluateMazeRunTime(room.roundConfig, player.towers || []);
    const runTime = Number(
      (
        (player._evaluatedFinishTime ?? evalRes.finishTimeSeconds) ||
        0
      ).toFixed(2)
    );
    const parTime = room.roundConfig.parTimeSeconds;
    const entry = {
      id: `daily_${dateKey}_${Date.now().toString(36)}_${Math.random()
        .toString(36)
        .slice(2, 6)}`,
      clientId: cid,
      playerName: sanitizePlayerName(player.name),
      playerColor: player.color || PLAYER_COLORS[0],
      survivalTimeSeconds: runTime,
      parTimeSeconds: parTime,
      beatPar: runTime >= parTime,
      clapsTaken: player._evalClaps ?? evalRes.clapsTaken ?? 0,
      overchargedSpires:
        player._evalOvercharge ?? evalRes.overchargedSpires ?? 0,
      linkedKeeps: player._evalKeeps ?? evalRes.linkedKeeps ?? 0,
      pathDistance: Number(
        (player.pathDistance || evalRes.distance || 0).toFixed(1)
      ),
      wallsUsed: Array.isArray(player.towers) ? player.towers.length : 0,
      timestamp: Date.now(),
    };

    entries.push(entry);
    entries.sort(compareDailyEntries);
    saveDailyEntry(dateKey, entry);
    return true;
  }

  const wss = new WebSocketServer({
    server,
    path: '/ws',
    maxPayload: WS_MAX_PAYLOAD_BYTES,
  });

  /** @type {Map<string, any>} */
  const rooms = new Map();
  /** @type {Map<any, { roomCode: string; playerId: string; sessionId: string; superseded?: boolean }>} */
  const clientMap = new Map();
  /** @type {Map<any, { dailyClientId?: string; playerName?: string }>} */
  const socketMeta = new Map();
  /** @type {Map<string, number>} */
  const ipSocketCounts = new Map();

  let lobbyBroadcastTimer = null;
  let lastLobbyBroadcastPayload = '';

  function getConnectedHumans(room) {
    return room.players.filter((p) => !p.isBot && p.connected !== false);
  }

  function getAllHumans(room) {
    return room.players.filter((p) => !p.isBot);
  }

  function updateRoomBuildPauseState(room) {
    // Explicit Start flows (Solo setup, Online Lobby Ready-Up, Daily Play) replace the old cold-boot pause
    const prev = Boolean(room._buildTimerPaused);
    room._buildTimerPaused = false;
    return prev !== false;
  }

  function markArenaTouched(room, player) {
    if (player) player._arenaActive = true;
    if (room) {
      room._roundTouched = true;
      updateRoomBuildPauseState(room);
    }
  }

  function ackClientSeq(player, rawSeq) {
    if (player && Number.isInteger(rawSeq) && rawSeq > 0) {
      player._lastAckedSeq = Math.max(player._lastAckedSeq || 0, rawSeq);
    }
  }

  function createBotPlayer(
    index,
    usedColors,
    difficultyOverride,
    usedNames = new Set()
  ) {
    const preset = BOT_PRESETS[index % BOT_PRESETS.length];
    const color =
      PLAYER_COLORS.find((c) => !usedColors.has(c)) ||
      PLAYER_COLORS[index % PLAYER_COLORS.length];
    usedColors.add(color);

    const baseName = preset.name;
    const finalName = usedNames.has(baseName) ? `${baseName} II` : baseName;
    usedNames.add(finalName);

    const validDiff = ['NOVICE', 'ARCHITECT', 'GRANDMASTER'].includes(
      difficultyOverride
    )
      ? difficultyOverride
      : preset.difficulty;

    return {
      id: `bot_${Math.random().toString(36).slice(2, 8)}`,
      name: finalName,
      color,
      isBot: true,
      botDifficulty: validDiff,
      botStyle: preset.style,
      isHost: false,
      ready: true,
      nextRoundReady: false,
      connected: true,
      usedSampleMaze: false,
      gold: ROUNDS[0].startingGold,
      towers: [],
      pathDistance: 0,
      totalScore: 0,
      lastRoundTime: null,
      lastRoundPoints: 0,
      lastRoundClaps: 0,
      lastRoundOvercharge: 0,
      lastRoundKeeps: 0,
      parStarsEarned: 0,
      bestMazeTime: 0,
      roundHistory: [],
      _pendingBotTowers: [],
    };
  }

  function normalizeRoomSettings(partial = {}, fallbackCode = 'ARENA1') {
    let validTotalRounds = DEFAULT_MATCH_ROUNDS;
    const rawRounds = partial.totalRounds;
    if (
      rawRounds === 'infinity' ||
      rawRounds === '∞' ||
      Number(rawRounds) === INFINITE_ROUNDS
    ) {
      validTotalRounds = INFINITE_ROUNDS;
    } else if (
      rawRounds !== undefined &&
      rawRounds !== null &&
      rawRounds !== '' &&
      Number.isFinite(Number(rawRounds))
    ) {
      const parsed = Math.round(Number(rawRounds));
      validTotalRounds = Math.max(
        MIN_CUSTOM_ROUNDS,
        Math.min(MAX_CUSTOM_ROUNDS, parsed)
      );
    }

    let validBuildTime = 0;
    const rawBuildTime = partial.buildTimeSeconds;
    if (
      rawBuildTime === 'infinity' ||
      rawBuildTime === '∞' ||
      Number(rawBuildTime) === INFINITE_BUILD_TIME
    ) {
      validBuildTime = INFINITE_BUILD_TIME;
    } else if (
      rawBuildTime !== undefined &&
      rawBuildTime !== null &&
      rawBuildTime !== '' &&
      Number.isFinite(Number(rawBuildTime))
    ) {
      const parsedTime = Math.round(Number(rawBuildTime));
      if (parsedTime <= 0) {
        validBuildTime = 0;
      } else {
        validBuildTime = Math.max(
          MIN_CUSTOM_BUILD_SECONDS,
          Math.min(MAX_CUSTOM_BUILD_SECONDS, parsedTime)
        );
      }
    }

    // Strictly 0.8 (80%), 1.0 (Normal), 1.25 (125%) — 1.3x dropped
    const validGoldMult = [0.8, 1.0, 1.25].includes(
      Number(partial.goldMultiplier)
    )
      ? Number(partial.goldMultiplier)
      : 1.0;
    const validBotCount =
      partial.botCount !== undefined && !Number.isNaN(Number(partial.botCount))
        ? Math.max(0, Math.min(5, Math.floor(Number(partial.botCount))))
        : 3;
    const validBotDiff = ['NOVICE', 'ARCHITECT', 'GRANDMASTER'].includes(
      partial.botDifficulty
    )
      ? partial.botDifficulty
      : 'ARCHITECT';
    const validAllowedRunners = normalizeAllowedRunners(partial.allowedRunners);

    return {
      roomName:
        String(partial.roomName || '').trim().slice(0, 28) ||
        (fallbackCode === 'ARENA1'
          ? 'Meadow Gate #1'
          : `Room ${fallbackCode}`),
      isPublic:
        partial.isPublic !== undefined ? Boolean(partial.isPublic) : true,
      totalRounds: validTotalRounds,
      buildTimeSeconds: validBuildTime,
      goldMultiplier: validGoldMult,
      botCount: validBotCount,
      botDifficulty: validBotDiff,
      fogOfWar: Boolean(partial.fogOfWar),
      allowedRunners: validAllowedRunners,
    };
  }

  function syncRoomBots(room, options = {}) {
    const forceRegenAllBots = Boolean(options.forceRegenAllBots);
    const existingBots = room.players.filter((p) => p.isBot);
    const humans = getAllHumans(room);
    const bots = [...existingBots];
    const maxBotsAllowed = Math.max(0, 6 - humans.length);
    const targetBots = Math.min(maxBotsAllowed, room.settings.botCount);

    while (bots.length > targetBots) {
      const removed = bots.pop();
      const idx = room.players.findIndex((p) => p.id === removed.id);
      if (idx !== -1) room.players.splice(idx, 1);
    }

    const survivingExistingIds = new Set(bots.map((b) => b.id));
    const usedColors = new Set(room.players.map((p) => p.color));
    const usedNames = new Set(room.players.map((p) => p.name));
    const basePath = computeFullMazePath(room.roundConfig, []);
    const baseDist = Number(basePath.totalDistance.toFixed(1));

    let presetCursor = 0;
    while (bots.length < targetBots) {
      while (
        presetCursor < BOT_PRESETS.length * 2 &&
        usedNames.has(BOT_PRESETS[presetCursor % BOT_PRESETS.length].name)
      ) {
        presetCursor++;
      }
      const bot = createBotPlayer(
        presetCursor,
        usedColors,
        room.settings.botDifficulty,
        usedNames
      );
      presetCursor++;
      bot.gold = room.roundConfig.startingGold;
      bot.pathDistance = baseDist;
      if (room.phase === 'BUILD' || room.phase === 'PLANNING') {
        bot.ready = false;
        bot._pendingBotTowers = generateMazeLayout(
          room.roundConfig,
          bot.botDifficulty,
          bot.botStyle
        );
      } else if (room.phase === 'LOBBY') {
        bot.ready = true;
      }
      room.players.push(bot);
      bots.push(bot);
    }

    for (const b of bots) {
      if (!survivingExistingIds.has(b.id)) continue;
      const diffChanged = b.botDifficulty !== room.settings.botDifficulty;
      if (diffChanged || forceRegenAllBots) {
        b.botDifficulty = room.settings.botDifficulty;
        if (room.phase === 'BUILD' || room.phase === 'PLANNING') {
          b.towers = [];
          b.gold = room.roundConfig.startingGold;
          b.pathDistance = baseDist;
          b.ready = false;
          b._pendingBotTowers = generateMazeLayout(
            room.roundConfig,
            b.botDifficulty,
            b.botStyle
          );
        } else if (room.phase === 'LOBBY') {
          b.ready = true;
          b._pendingBotTowers = [];
        }
      }
    }
  }

  function ensureDeckCoversSlot(room, slotIndex) {
    const allowedRunners = normalizeAllowedRunners(
      room?.settings?.allowedRunners
    );
    if (!Array.isArray(room._mapDeck) || room._mapDeck.length === 0) {
      room._mapDeck = createShuffledMapDeck([], Math.random, allowedRunners);
    }
    const safeSlot = Math.max(0, Math.floor(Number(slotIndex) || 0));
    while (room._mapDeck.length <= safeSlot) {
      const lastPlayed =
        room._mapDeck.length > 0
          ? [room._mapDeck[room._mapDeck.length - 1]]
          : [];
      const nextWave = createShuffledMapDeck(
        lastPlayed,
        Math.random,
        allowedRunners
      );
      if (nextWave.length === 0) break;
      room._mapDeck.push(...nextWave);
    }
  }

  function getMapIndexForRoundSlot(room, slotIndex) {
    const safeSlot = Math.max(0, Math.floor(Number(slotIndex) || 0));
    ensureDeckCoversSlot(room, safeSlot);
    return room._mapDeck[safeSlot % room._mapDeck.length] ?? 0;
  }

  function getBaseMapForRoom(room) {
    if (room?.roundConfig?.mapId && typeof getMapById === 'function') {
      return getMapById(room.roundConfig.mapId);
    }
    const idx = getMapIndexForRoundSlot(room, room?.currentRoundIndex || 0);
    return ROUNDS[idx] || ROUNDS[0];
  }

  function reshuffleRoomMapDeck(room, avoidCurrentMatch = true) {
    if (!room || room.mode === 'DAILY') return;
    const allowedRunners = normalizeAllowedRunners(
      room.settings?.allowedRunners
    );
    const finiteRounds = isInfiniteRounds(room.settings?.totalRounds)
      ? Math.max(1, (room.currentRoundIndex || 0) + 1)
      : Math.max(1, Number(room.settings?.totalRounds) || DEFAULT_MATCH_ROUNDS);
    const playedIndices =
      avoidCurrentMatch && Array.isArray(room._mapDeck)
        ? room._mapDeck.slice(0, Math.min(room._mapDeck.length, finiteRounds))
        : [];
    room._mapDeck = createShuffledMapDeck(
      playedIndices,
      Math.random,
      allowedRunners
    );
  }

  function formatRoundsPhrase(totalRounds) {
    return isInfiniteRounds(totalRounds)
      ? 'endless randomized maps'
      : `${totalRounds} randomized ${totalRounds === 1 ? 'map' : 'maps'}`;
  }

  function createRoom(roomCode, customSettings, options = {}) {
    const mode =
      options.mode === 'DAILY' || options.mode === 'SOLO'
        ? options.mode
        : 'ONLINE';
    const startInLobby = Boolean(options.startInLobby);
    const code =
      String(roomCode || 'ROOM100')
        .toUpperCase()
        .replace(/[^A-Z0-9-]/g, '')
        .slice(0, 8) || 'ROOM100';

    const settings = normalizeRoomSettings(
      {
        ...(customSettings || {}),
        ...(mode === 'DAILY'
          ? {
              isPublic: false,
              totalRounds: 1,
              buildTimeSeconds: DAILY_BUILD_TIME_SECONDS || 120,
              goldMultiplier: 1.0,
              botCount: 0,
              fogOfWar: false,
            }
          : mode === 'SOLO'
          ? { isPublic: false }
          : {}),
      },
      code
    );

    const mapDeck =
      mode === 'DAILY'
        ? [0]
        : createShuffledMapDeck([], Math.random, settings.allowedRunners);
    const firstBaseMap = ROUNDS[mapDeck[0]] || ROUNDS[0];

    let round0;
    if (mode === 'DAILY' && options.dailyRoundConfig) {
      round0 = cloneRoundConfig(options.dailyRoundConfig);
    } else {
      round0 = generateRandomRoundLayout(firstBaseMap);
      round0.roundNumber = 1;
      round0.mapId = firstBaseMap.mapId ?? firstBaseMap.roundNumber;
      const goldMult = Number(settings.goldMultiplier) || 1.0;
      round0.startingGold = Math.max(
        25,
        Math.round((firstBaseMap.startingGold * goldMult) / 5) * 5
      );
      round0.parTimeSeconds = computeEffectivePar(
        firstBaseMap.parTimeSeconds,
        goldMult
      );
      round0.buildTimeSeconds = computeRoundBuildSeconds(
        firstBaseMap,
        settings
      );
    }

    const usedColors = new Set([PLAYER_COLORS[0]]);
    const usedNames = new Set();
    const initialBots = [];
    for (let i = 0; i < settings.botCount; i++) {
      const bot = createBotPlayer(i, usedColors, settings.botDifficulty, usedNames);
      bot.gold = round0.startingGold;
      initialBots.push(bot);
    }

    const roundsPhrase = formatRoundsPhrase(settings.totalRounds);

    const room = {
      roomCode: code,
      mode,
      dailyDateKey: options.dailyDateKey,
      dailyPuzzleNumber: options.dailyPuzzleNumber,
      _dailyClientId: options.dailyClientId,
      _mapDeck: mapDeck,
      phase: startInLobby ? 'LOBBY' : 'PLANNING',
      settings,
      currentRoundIndex: 0,
      roundsCompleted: 0,
      roundConfig: round0,
      phaseTimeRemaining: startInLobby ? 0 : PLANNING_TIME_SECONDS,
      simSpeedMultiplier: 1,
      players: [...initialBots],
      newRecordHolders: [],
      chat: [
        {
          id: `msg_${Date.now()}`,
          senderName: '',
          senderColor: '#38bdf8',
          text: startInLobby
            ? `Lobby ${code} created (${roundsPhrase}). Share the room code and press Ready Up when set.`
            : mode === 'DAILY'
            ? `Daily Maze #${options.dailyPuzzleNumber || 1} — 5s planning, then 120s to build your best maze.`
            : `Match started with ${roundsPhrase}. Plan your route during the 5s countdown, then build!`,
          timestamp: Date.now(),
          isSystem: true,
        },
      ],
      _maxRunTime: 0,
      _runElapsed: 0,
      _postFinishRealRemaining: 0,
      _botStepAccum: 0,
      _lastBroadcastSec: startInLobby ? 0 : PLANNING_TIME_SECONDS,
      _roundTouched: !startInLobby,
      _buildTimerPaused: false,
      _keepFogUntilRoundEnd: false,
      _unreadyDisconnectHoldUntil: 0,
      _rerollsThisRound: 0,
    };

    rooms.set(code, room);
    if (!startInLobby) {
      prepareRoundForRoom(room, 0, false);
    }
    return room;
  }

  function resetMatchStandingFields(room) {
    room.roundsCompleted = 0;
    room._roundTouched = false;
    room._rerollsThisRound = 0;
    for (const p of room.players) {
      p.totalScore = 0;
      p.lastRoundTime = null;
      p.lastRoundPoints = 0;
      p.lastRoundRank = undefined;
      p.lastRoundClaps = 0;
      p.lastRoundOvercharge = 0;
      p.lastRoundKeeps = 0;
      p.parStarsEarned = 0;
      p.bestMazeTime = 0;
      p.roundHistory = [];
      p.usedSampleMaze = false;
      p.nextRoundReady = false;
    }
  }

  function getPublicLobbySummaries() {
    const list = [];
    for (const room of rooms.values()) {
      if (room.mode !== 'ONLINE' || !room.settings.isPublic) continue;
      const connectedHumans = getConnectedHumans(room);
      const allHumans = getAllHumans(room);
      if (allHumans.length === 0) continue;
      const bots = room.players.filter((p) => p.isBot);
      const host =
        connectedHumans.find((p) => p.isHost) ||
        connectedHumans[0] ||
        allHumans[0] ||
        room.players[0];

      list.push({
        roomCode: room.roomCode,
        roomName: room.settings.roomName || `Room ${room.roomCode}`,
        hostName: host && !host.isBot ? host.name : 'Host',
        phase: room.phase,
        currentRound: room.roundConfig.roundNumber,
        totalRounds: room.settings.totalRounds,
        playerCount: room.players.length,
        humanCount: connectedHumans.length,
        botCount: bots.length,
        maxPlayers: 6,
        settings: room.settings,
      });
    }
    return list.sort((a, b) => {
      // Waiting lobbies appear first, then by human count
      const aLobby = a.phase === 'LOBBY' ? 1 : 0;
      const bLobby = b.phase === 'LOBBY' ? 1 : 0;
      if (bLobby !== aLobby) return bLobby - aLobby;
      return b.humanCount - a.humanCount;
    });
  }

  function broadcastLobbyListNow() {
    lobbyBroadcastTimer = null;
    const payload = JSON.stringify({
      type: 'LOBBY_LIST',
      rooms: getPublicLobbySummaries(),
    });
    if (payload === lastLobbyBroadcastPayload) return;
    lastLobbyBroadcastPayload = payload;

    for (const ws of wss.clients) {
      if (ws.readyState !== 1) continue;
      const info = clientMap.get(ws);
      if (info?.superseded) continue;
      if (info) {
        const r = rooms.get(info.roomCode);
        if (r && r.phase === 'RUN') continue;
      }
      ws.send(payload);
    }
  }

  function scheduleLobbyListBroadcast() {
    if (lobbyBroadcastTimer) return;
    lobbyBroadcastTimer = setTimeout(broadcastLobbyListNow, 150);
  }

  function broadcastLeaderboardToAll() {
    const payload = JSON.stringify({
      type: 'LEADERBOARD_DATA',
      leaderboard,
    });
    for (const ws of wss.clients) {
      if (ws.readyState === 1) {
        ws.send(payload);
      }
    }
  }

  function broadcastDailyLeaderboardToAll() {
    for (const ws of wss.clients) {
      if (ws.readyState !== 1) continue;
      const info = clientMap.get(ws);
      if (info?.superseded) continue;
      const meta = socketMeta.get(ws) || {};
      ws.send(
        JSON.stringify({
          type: 'DAILY_LEADERBOARD_DATA',
          daily: buildDailyPayload(meta.dailyClientId, meta.playerName),
        })
      );
    }
  }

  function sanitizeRoomStateForClient(room, viewerPlayerId) {
    const hideOpponents =
      (room.phase === 'BUILD' || room.phase === 'PLANNING') &&
      (Boolean(room.settings.fogOfWar) || Boolean(room._keepFogUntilRoundEnd));
    const viewerPlayer = room.players.find((p) => p.id === viewerPlayerId);

    return {
      roomCode: room.roomCode,
      mode: room.mode || 'ONLINE',
      ...(room.dailyDateKey ? { dailyDateKey: room.dailyDateKey } : {}),
      ...(room.dailyPuzzleNumber
        ? { dailyPuzzleNumber: room.dailyPuzzleNumber }
        : {}),
      phase: room.phase,
      settings: room.settings,
      currentRoundIndex: room.currentRoundIndex,
      roundsCompleted: room.roundsCompleted || 0,
      matchMapIds: (() => {
        if (room.mode === 'DAILY') return [room.roundConfig.mapId || 1];
        const endless = isInfiniteRounds(room.settings?.totalRounds);
        const targetCount = endless
          ? Math.max(8, (room.currentRoundIndex || 0) + 8)
          : Math.max(
              1,
              Number(room.settings?.totalRounds) || DEFAULT_MATCH_ROUNDS
            );
        ensureDeckCoversSlot(room, targetCount - 1);
        return (room._mapDeck || [])
          .slice(0, targetCount)
          .map((idx) => ROUNDS[idx]?.mapId ?? idx + 1);
      })(),
      roundConfig: room.roundConfig,
      phaseTimeRemaining: Math.max(0, Math.ceil(room.phaseTimeRemaining)),
      runElapsed:
        room.phase === 'RUN' ? Number((room._runElapsed || 0).toFixed(2)) : 0,
      lastAckedSeq: viewerPlayer ? viewerPlayer._lastAckedSeq || 0 : 0,
      buildTimerPaused: Boolean(room._buildTimerPaused),
      simSpeedMultiplier: room.simSpeedMultiplier,
      newRecordHolders: room.newRecordHolders || [],
      chat: room.chat.slice(-25),
      players: room.players.map((p) => {
        const isViewer = p.id === viewerPlayerId;
        const shouldMask = hideOpponents && !isViewer;
        const cleanTowers = shouldMask
          ? []
          : isViewer
          ? p.towers
          : p.towers.map((t) => ({
              id: t.id,
              type: t.type,
              x: t.x,
              y: t.y,
              createdAt: t.createdAt,
            }));

        return {
          id: p.id,
          name: p.name,
          color: p.color,
          isBot: p.isBot,
          botDifficulty: p.botDifficulty,
          botStyle: p.botStyle,
          isHost: p.isHost,
          ready: p.ready,
          nextRoundReady: Boolean(p.nextRoundReady),
          gold: shouldMask ? room.roundConfig.startingGold : p.gold,
          towers: cleanTowers,
          pathDistance: shouldMask ? 0 : p.pathDistance,
          fogMasked: shouldMask,
          usedSampleMaze: shouldMask ? false : Boolean(p.usedSampleMaze),
          connected: p.connected !== false,
          totalScore: p.totalScore,
          lastRoundTime: p.lastRoundTime,
          lastRoundPoints: p.lastRoundPoints,
          ...(p.lastRoundRank ? { lastRoundRank: p.lastRoundRank } : {}),
          lastRoundClaps: p.lastRoundClaps || 0,
          lastRoundOvercharge: p.lastRoundOvercharge || 0,
          lastRoundKeeps: p.lastRoundKeeps || 0,
          parStarsEarned: p.parStarsEarned || 0,
          bestMazeTime: p.bestMazeTime,
          roundHistory: p.roundHistory,
        };
      }),
    };
  }

  function sendRoomStateToPlayer(room, playerId) {
    for (const [ws, info] of clientMap.entries()) {
      if (
        info.roomCode === room.roomCode &&
        info.playerId === playerId &&
        !info.superseded &&
        ws.readyState === 1
      ) {
        ws.send(
          JSON.stringify({
            type: 'ROOM_STATE',
            state: sanitizeRoomStateForClient(room, info.playerId),
          })
        );
      }
    }
  }

  function sendBuildRejection(ws, room, player, message, rejectedSeq) {
    if (ws.readyState !== 1) return;
    ws.send(
      JSON.stringify({
        type: 'ERROR_TOAST',
        message,
        ...(Number.isInteger(rejectedSeq) ? { rejectedSeq } : {}),
        ...(room && player
          ? { state: sanitizeRoomStateForClient(room, player.id) }
          : {}),
      })
    );
  }

  function broadcastRoomState(
    room,
    notifyLobbyBrowser = false,
    excludeWs = null
  ) {
    for (const [ws, info] of clientMap.entries()) {
      if (
        ws !== excludeWs &&
        info.roomCode === room.roomCode &&
        !info.superseded &&
        ws.readyState === 1
      ) {
        ws.send(
          JSON.stringify({
            type: 'ROOM_STATE',
            state: sanitizeRoomStateForClient(room, info.playerId),
          })
        );
      }
    }
    if (notifyLobbyBrowser) {
      scheduleLobbyListBroadcast();
    }
  }

  function broadcastToRoom(room, payload) {
    const str = JSON.stringify(payload);
    for (const [ws, info] of clientMap.entries()) {
      if (
        info.roomCode === room.roomCode &&
        !info.superseded &&
        ws.readyState === 1
      ) {
        ws.send(str);
      }
    }
  }

  function addSystemChat(room, text) {
    const message = {
      id: `sys_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      senderName: '',
      senderColor: '#38bdf8',
      text,
      timestamp: Date.now(),
      isSystem: true,
    };
    room.chat.push(message);
    if (room.chat.length > 40) room.chat.shift();
    broadcastToRoom(room, { type: 'CHAT_MESSAGE', message });
  }

  function formatParLabel(parSec) {
    return parSec % 1 === 0 ? `${parSec.toFixed(0)}s+` : `${parSec.toFixed(1)}s+`;
  }

  function prepareRoundForRoom(
    room,
    roundIndex,
    emitBroadcast = true,
    options = {}
  ) {
    const isDaily = room.mode === 'DAILY';
    const endless = !isDaily && isInfiniteRounds(room.settings?.totalRounds);
    const totalMatchRounds = Math.max(
      1,
      Number(room.settings?.totalRounds) || DEFAULT_MATCH_ROUNDS
    );
    const clampedIdx = isDaily
      ? 0
      : endless
      ? Math.max(0, Math.floor(Number(roundIndex) || 0))
      : Math.max(
          0,
          Math.min(totalMatchRounds - 1, Math.floor(Number(roundIndex) || 0))
        );

    let round;
    if (isDaily) {
      const dailyInfo = getCachedDailyConfig(
        room.dailyDateKey || getDailyDateKeyUtc()
      );
      room.dailyDateKey = dailyInfo.dateKey;
      room.dailyPuzzleNumber = dailyInfo.puzzleNumber;
      round = cloneRoundConfig(dailyInfo.roundConfig);
      round.buildTimeSeconds = DAILY_BUILD_TIME_SECONDS || 120;
    } else {
      const mapIdx = getMapIndexForRoundSlot(room, clampedIdx);
      const baseRound = ROUNDS[mapIdx] || ROUNDS[0];
      round = generateRandomRoundLayout(baseRound);
      round.roundNumber = clampedIdx + 1;
      round.mapId = baseRound.mapId ?? baseRound.roundNumber;

      const goldMult = Number(room.settings.goldMultiplier) || 1.0;
      round.startingGold = Math.max(
        25,
        Math.round((baseRound.startingGold * goldMult) / 5) * 5
      );
      round.parTimeSeconds = computeEffectivePar(
        baseRound.parTimeSeconds,
        goldMult
      );
      round.buildTimeSeconds = computeRoundBuildSeconds(
        baseRound,
        room.settings
      );
    }

    room.currentRoundIndex = clampedIdx;
    room.roundConfig = round;
    // Every new round begins with a 5-second PLANNING countdown before building unlocks
    room.phase = 'PLANNING';
    room.phaseTimeRemaining = PLANNING_TIME_SECONDS;
    room.simSpeedMultiplier = [1, 2, 4].includes(room.simSpeedMultiplier)
      ? room.simSpeedMultiplier
      : 1;
    room.newRecordHolders = [];
    room._maxRunTime = 0;
    room._runElapsed = 0;
    room._postFinishRealRemaining = 0;
    room._botStepAccum = 0;
    room._keepFogUntilRoundEnd = false;
    room._unreadyDisconnectHoldUntil = 0;
    if (!options.preserveRerollCount) {
      room._rerollsThisRound = 0;
    }
    room._lastBroadcastSec = PLANNING_TIME_SECONDS;
    room._roundTouched = true;

    const basePath = computeFullMazePath(round, []);
    const baseDist = Number(basePath.totalDistance.toFixed(1));

    for (const p of room.players) {
      p.gold = round.startingGold;
      p.towers = [];
      p.pathDistance = baseDist;
      p.ready = false;
      p.nextRoundReady = false;
      p._joinedMidRun = false;
      // Note: p.usedSampleMaze stays match-sticky until match reset!

      if (p.isBot) {
        const planned = generateMazeLayout(
          round,
          p.botDifficulty || room.settings.botDifficulty || 'ARCHITECT',
          p.botStyle || 'SWITCHBACK'
        );
        p._pendingBotTowers = [...planned];
      }
    }

    updateRoomBuildPauseState(room);

    if (emitBroadcast) {
      const wallsCount = Math.floor(
        round.startingGold / TOWER_SPECS.BLOCK.goldCost
      );
      addSystemChat(
        room,
        isDaily
          ? `${round.title} · ${wallsCount} walls · 120s build · Par ${formatParLabel(round.parTimeSeconds)}`
          : endless
          ? `Round ${round.roundNumber} (Endless): ${round.title} (Map #${round.mapId || round.roundNumber}) · ${wallsCount} walls · Par ${formatParLabel(round.parTimeSeconds)}`
          : `Round ${round.roundNumber}/${totalMatchRounds}: ${round.title} (Map #${round.mapId || round.roundNumber}) · ${wallsCount} walls · Par ${formatParLabel(round.parTimeSeconds)}`
      );
      broadcastRoomState(room, true);
    }
  }

  function startRunPhase(room) {
    if (room.phase === 'RUN') return;

    room._roundTouched = true;
    room._buildTimerPaused = false;
    room._keepFogUntilRoundEnd = false;

    for (const p of room.players) {
      if (p.isBot && p._pendingBotTowers && p._pendingBotTowers.length > 0) {
        while (p._pendingBotTowers.length > 0) {
          const nextTower = p._pendingBotTowers.shift();
          applyBotTower(room, p, nextTower);
        }
        p.ready = true;
      }
    }

    room.phase = 'RUN';
    room._runElapsed = 0;
    room._postFinishRealRemaining = POST_FINISH_HOLD_REAL_SEC;

    let maxRunTime = 4.0;
    for (const p of room.players) {
      const evalRes = evaluateMazeRunTime(room.roundConfig, p.towers);
      p._evaluatedFinishTime = evalRes.finishTimeSeconds;
      p._evalClaps = evalRes.clapsTaken;
      p._evalOvercharge = evalRes.overchargedSpires;
      p._evalKeeps = evalRes.linkedKeeps;
      p.pathDistance = evalRes.distance;
      if (evalRes.finishTimeSeconds > maxRunTime) {
        maxRunTime = evalRes.finishTimeSeconds;
      }
    }

    room._maxRunTime = maxRunTime;
    const speedMult = room.simSpeedMultiplier || 1;
    room.phaseTimeRemaining = Math.ceil(
      maxRunTime / speedMult + POST_FINISH_HOLD_REAL_SEC
    );
    room._lastBroadcastSec = room.phaseTimeRemaining;

    broadcastRoomState(room, true);
  }

  function recordRoundToLeaderboard(room, rankedPlayers) {
    const round = room.roundConfig;
    const mapId = round.mapId || round.roundNumber;
    if (!leaderboard.roundRecords[mapId]) {
      leaderboard.roundRecords[mapId] = [];
    }

    const goldMult = Number(room.settings.goldMultiplier) || 1.0;
    // Only <= 1.0x wall supply and <= 2 map rerolls/round qualify for global map survival records
    const eligibleForMapBoard =
      goldMult <= 1.01 &&
      (room._rerollsThisRound || 0) <= MAX_RANKED_REROLLS_PER_ROUND;
    const newRecordHolders = [];
    const now = Date.now();
    let changed = false;

    for (const p of rankedPlayers) {
      // Strictly human-only: exclude bots, mid-run joiners, 0-wall AFK boards, and sticky Sample Maze users
      if (
        p.isBot ||
        p._joinedMidRun ||
        p.usedSampleMaze ||
        !p.towers ||
        p.towers.length === 0
      ) {
        continue;
      }

      const cleanName = sanitizePlayerName(p.name);
      const cleanLower = cleanName.toLowerCase();
      if (BOT_AND_SEED_NAMES_LOWER.has(cleanLower)) continue;

      const runTime = Number((p.lastRoundTime || 0).toFixed(2));
      const beatPar = runTime >= round.parTimeSeconds;

      if (eligibleForMapBoard && runTime > 8.0) {
        const entry = {
          id: `rec_${now}_${Math.random().toString(36).slice(2, 7)}`,
          mapId,
          mapTitle: round.title,
          roundNumber: mapId,
          roundTitle: round.title,
          runnerType: round.runnerType || 'SCOUT',
          playerName: cleanName,
          playerColor: p.color,
          isBot: false,
          survivalTimeSeconds: runTime,
          parTimeSeconds: round.parTimeSeconds,
          beatPar,
          clapsTaken: p.lastRoundClaps || 0,
          overchargedSpires: p.lastRoundOvercharge || 0,
          linkedKeeps: p.lastRoundKeeps || 0,
          pathDistance: p.pathDistance || 0,
          goldMultiplier: goldMult,
          roomCode: room.roomCode,
          timestamp: now,
        };

        const existingIdx = leaderboard.roundRecords[mapId].findIndex(
          (e) => String(e.playerName || '').toLowerCase() === cleanLower
        );
        if (existingIdx !== -1) {
          if (
            runTime >
            leaderboard.roundRecords[mapId][existingIdx].survivalTimeSeconds
          ) {
            leaderboard.roundRecords[mapId][existingIdx] = entry;
            changed = true;
          }
        } else {
          leaderboard.roundRecords[mapId].push(entry);
          changed = true;
        }

        leaderboard.roundRecords[mapId].sort(
          (a, b) => b.survivalTimeSeconds - a.survivalTimeSeconds
        );
        leaderboard.roundRecords[mapId] = leaderboard.roundRecords[mapId].slice(
          0,
          12
        );

        const rankInBoard = leaderboard.roundRecords[mapId].findIndex(
          (e) =>
            String(e.playerName || '').toLowerCase() === cleanLower &&
            e.survivalTimeSeconds === runTime
        );
        if (rankInBoard !== -1 && rankInBoard < 5) {
          newRecordHolders.push(cleanName);
        }
      }

      // Only contested rooms (>= 2 players/bots) count toward human career champion totals (bots never enter!)
      if (room.players.length >= 2) {
        let champ = leaderboard.champions.find(
          (c) => String(c.playerName || '').toLowerCase() === cleanLower
        );
        if (!champ) {
          champ = {
            playerName: cleanName,
            playerColor: p.color,
            matchesWon: 0,
            roundsPlayed: 0,
            totalCareerPoints: 0,
            parStarsEarned: 0,
            bestSurvivalTime: 0,
            bestRoundNumber: mapId,
            bestMapId: mapId,
            bestMapTitle: round.title,
            lastPlayedAt: now,
          };
          leaderboard.champions.push(champ);
        }
        champ.playerColor = p.color;
        champ.roundsPlayed += 1;
        champ.totalCareerPoints += p.lastRoundPoints || 0;
        if (beatPar) champ.parStarsEarned += 1;
        if (eligibleForMapBoard && runTime > champ.bestSurvivalTime) {
          champ.bestSurvivalTime = runTime;
          champ.bestRoundNumber = mapId;
          champ.bestMapId = mapId;
          champ.bestMapTitle = round.title;
        }
        champ.lastPlayedAt = now;
        changed = true;
      }
    }

    if (changed) {
      leaderboard.mapRecords = leaderboard.roundRecords;
      leaderboard.champions.sort(
        (a, b) =>
          b.totalCareerPoints - a.totalCareerPoints ||
          b.matchesWon - a.matchesWon ||
          b.bestSurvivalTime - a.bestSurvivalTime
      );
      leaderboard.champions = leaderboard.champions.slice(0, 20);
      saveLeaderboard();
      broadcastLeaderboardToAll();
    }

    return newRecordHolders;
  }

  function compareRoundPerformance(a, b) {
    const timeA = Number((a._evaluatedFinishTime || 0).toFixed(2));
    const timeB = Number((b._evaluatedFinishTime || 0).toFixed(2));
    if (timeB !== timeA) return timeB - timeA;

    const overA = a._evalOvercharge || 0;
    const overB = b._evalOvercharge || 0;
    if (overB !== overA) return overB - overA;

    const clapsA = a._evalClaps || 0;
    const clapsB = b._evalClaps || 0;
    if (clapsB !== clapsA) return clapsB - clapsA;

    // Unspent wall budget tie-breaker (achieving identical time/synergy with fewer walls)
    return (b.gold || 0) - (a.gold || 0);
  }

  function finishRunPhaseAndScore(room) {
    if (room.phase !== 'RUN') return;
    room.roundsCompleted = (room.roundsCompleted || 0) + 1;

    const ranked = [...room.players].sort(compareRoundPerformance);

    const pointTable = [10, 7, 5, 3, 2, 1];
    let currentSharedRank = 1;

    ranked.forEach((p, idx) => {
      if (idx > 0 && compareRoundPerformance(ranked[idx - 1], p) !== 0) {
        currentSharedRank = idx + 1;
      }

      const runTime = Number((p._evaluatedFinishTime || 0).toFixed(2));
      const beatPar = runTime >= room.roundConfig.parTimeSeconds;
      let pts = pointTable[currentSharedRank - 1] ?? 1;
      if (beatPar) {
        pts += 2;
        p.parStarsEarned = (p.parStarsEarned || 0) + 1;
      }

      p.lastRoundTime = runTime;
      p.lastRoundPoints = pts;
      p.lastRoundRank = currentSharedRank;
      p.lastRoundClaps = p._evalClaps || 0;
      p.lastRoundOvercharge = p._evalOvercharge || 0;
      p.lastRoundKeeps = p._evalKeeps || 0;
      p.totalScore += pts;
      p.ready = false;
      p.nextRoundReady = false;
      if (runTime > p.bestMazeTime) {
        p.bestMazeTime = runTime;
      }
      p.roundHistory.push({
        roundNumber: room.roundConfig.roundNumber,
        timeSeconds: runTime,
        pointsEarned: pts,
        rank: currentSharedRank,
        clapsTaken: p.lastRoundClaps,
        overchargedSpires: p.lastRoundOvercharge,
        linkedKeeps: p.lastRoundKeeps,
        distance: p.pathDistance,
        beatPar,
      });
    });

    if (room.mode === 'DAILY') {
      const human = ranked.find((p) => !p.isBot);
      const dateKey = room.dailyDateKey || getDailyDateKeyUtc();
      if (human) {
        recordDailyResult(dateKey, human, room);
      }
      room.newRecordHolders = [];
      room.phase = 'GAME_OVER';
      room.phaseTimeRemaining = 0;
      room._lastBroadcastSec = 0;
      broadcastRoomState(room, false);
      broadcastDailyLeaderboardToAll();
      return;
    }

    const newRecordHolders = recordRoundToLeaderboard(room, ranked);
    room.newRecordHolders = newRecordHolders;

    const endless = isInfiniteRounds(room.settings.totalRounds);
    if (!endless && room.roundsCompleted >= room.settings.totalRounds) {
      room.phase = 'GAME_OVER';
      room.phaseTimeRemaining = 0;
      room._lastBroadcastSec = 0;

      const matchStandings = [...room.players].sort(
        (a, b) =>
          b.totalScore - a.totalScore ||
          (b.parStarsEarned || 0) - (a.parStarsEarned || 0) ||
          b.bestMazeTime - a.bestMazeTime
      );
      const grandChampion = matchStandings[0];
      if (grandChampion) {
        if (
          !grandChampion.isBot &&
          !grandChampion.usedSampleMaze &&
          room.players.length >= 2 &&
          grandChampion.bestMazeTime > 8.0
        ) {
          const champLower = sanitizePlayerName(grandChampion.name).toLowerCase();
          const champEntry = leaderboard.champions.find(
            (c) => String(c.playerName || '').toLowerCase() === champLower
          );
          if (champEntry) {
            champEntry.matchesWon += 1;
            saveLeaderboard();
            broadcastLeaderboardToAll();
          }
        }
        addSystemChat(
          room,
          `${grandChampion.name} won the ${room.settings.totalRounds}-round match with ${grandChampion.totalScore} pts.`
        );
      }
    } else {
      room.phase = 'ROUND_RESULTS';
      room.phaseTimeRemaining = 15;
      room._lastBroadcastSec = 15;

      const winner = ranked[0];
      if (winner) {
        addSystemChat(
          room,
          `${winner.name} won Round ${room.roundConfig.roundNumber} with ${winner.lastRoundTime.toFixed(2)}s (+${winner.lastRoundPoints} pts).`
        );
      }
    }

    if (newRecordHolders.length > 0) {
      addSystemChat(
        room,
        `New Top 5 Leaderboard record on ${room.roundConfig.title}: ${newRecordHolders.join(', ')}.`
      );
    }

    broadcastRoomState(room, true);
  }

  function applyBotTower(room, bot, plannedTower) {
    if (
      !plannedTower ||
      !Number.isInteger(plannedTower.x) ||
      !Number.isInteger(plannedTower.y)
    ) {
      return;
    }
    const wallCost = TOWER_SPECS.BLOCK.goldCost;
    if (bot.gold < wallCost) return;

    const check = validateTowerPlacement(
      room.roundConfig,
      bot.towers,
      plannedTower.x,
      plannedTower.y
    );
    if (check.valid && check.pathResult) {
      bot.towers.push({
        id:
          plannedTower.id ||
          `bot_twr_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        type: 'BLOCK',
        x: plannedTower.x,
        y: plannedTower.y,
        createdAt: plannedTower.createdAt || Date.now(),
      });
      bot.gold -= wallCost;
      bot.pathDistance = Number(check.pathResult.totalDistance.toFixed(1));
    }
  }

  function ensureConnectedHost(room, announcePromotion = false) {
    const connectedHumans = getConnectedHumans(room);
    if (connectedHumans.length > 0) {
      if (!connectedHumans.some((p) => p.isHost)) {
        for (const p of room.players) {
          if (!p.isBot) p.isHost = false;
        }
        const promoted = connectedHumans[0];
        promoted.isHost = true;
        if (announcePromotion) {
          addSystemChat(room, `${promoted.name} is now the room host.`);
        }
      }
    }
  }

  function cleanupEmptyRoomIfNeeded(room, announceHostPromotion = false) {
    const anyHumanRemaining = getAllHumans(room).length > 0;
    if (anyHumanRemaining) {
      ensureConnectedHost(room, announceHostPromotion);
      updateRoomBuildPauseState(room);
      broadcastRoomState(room, true);
      return;
    }

    rooms.delete(room.roomCode);
    scheduleLobbyListBroadcast();
  }

  function clearHostTransferTimerOnly(player) {
    if (!player) return;
    if (player._hostTransferTimer) {
      clearTimeout(player._hostTransferTimer);
      player._hostTransferTimer = null;
    }
  }

  function clearPlayerTimers(player) {
    if (!player) return;
    if (player._disconnectTimer) {
      clearTimeout(player._disconnectTimer);
      player._disconnectTimer = null;
    }
    clearHostTransferTimerOnly(player);
  }

  function extendActiveRunIfNeeded(room, candidateFinishSeconds) {
    if (!room || room.phase !== 'RUN') return;
    if (candidateFinishSeconds > room._maxRunTime) {
      room._maxRunTime = candidateFinishSeconds;
      const speedMult = room.simSpeedMultiplier || 1;
      const simLeft = Math.max(0, room._maxRunTime - room._runElapsed);
      room.phaseTimeRemaining = Math.max(
        0,
        simLeft / speedMult + room._postFinishRealRemaining
      );
      room._lastBroadcastSec = Math.ceil(room.phaseTimeRemaining);
    }
  }

  function removePlayerImmediately(room, player, announceLeave = true) {
    if (!room || !player) return;
    clearPlayerTimers(player);

    const wasHost = player.isHost;
    const idx = room.players.findIndex((p) => p.id === player.id);
    if (idx !== -1) {
      room.players.splice(idx, 1);
    }

    const connectedHumans = getConnectedHumans(room);
    if (announceLeave && connectedHumans.length > 0) {
      addSystemChat(room, `${player.name} left the room.`);
    }
    cleanupEmptyRoomIfNeeded(room, wasHost && connectedHumans.length > 0);
  }

  function handleSocketDisconnect(room, player) {
    if (!room || !player) return;
    if (!rooms.has(room.roomCode)) return;

    player.connected = false;

    // Hold allHumansReady auto-start for 5s if an unready builder briefly drops Wi-Fi
    if (room.phase === 'BUILD' && !player.ready) {
      room._unreadyDisconnectHoldUntil = Date.now() + UNREADY_BLIP_HOLD_MS;
    }

    // Preserve host across brief <5s page refreshes; migrate & announce if still offline after 5s
    if (player.isHost && getConnectedHumans(room).length > 0) {
      if (player._hostTransferTimer) clearTimeout(player._hostTransferTimer);
      player._hostTransferTimer = setTimeout(() => {
        player._hostTransferTimer = null;
        if (player.connected === false && player.isHost && rooms.has(room.roomCode)) {
          const nextHost = getConnectedHumans(room)[0];
          if (nextHost) {
            player.isHost = false;
            nextHost.isHost = true;
            addSystemChat(room, `${nextHost.name} is now the room host.`);
            broadcastRoomState(room, true);
          }
        }
      }, HOST_MIGRATE_DELAY_MS);
    }

    updateRoomBuildPauseState(room);
    broadcastRoomState(room, true);

    if (player._disconnectTimer) {
      clearTimeout(player._disconnectTimer);
    }
    player._disconnectTimer = setTimeout(() => {
      player._disconnectTimer = null;
      if (player.connected === false) {
        if (
          room.mode === 'DAILY' &&
          room.phase !== 'GAME_OVER' &&
          room.phase !== 'LOBBY'
        ) {
          recordDailyResult(
            room.dailyDateKey || getDailyDateKeyUtc(),
            player,
            room
          );
          broadcastDailyLeaderboardToAll();
        }
        removePlayerImmediately(room, player, true);
      }
    }, RECONNECT_GRACE_MS);
  }

  function detachSocketFromPreviousRoom(ws, currentRoom, currentPlayer) {
    const prevInfo = clientMap.get(ws);
    if (prevInfo) {
      prevInfo.superseded = true;
      clientMap.delete(ws);
    }
    if (currentRoom && currentPlayer) {
      removePlayerImmediately(currentRoom, currentPlayer, true);
    }
  }

  function canRoomAcceptJoin(room, sessionId) {
    if (!room) return true;
    // Existing player reconnecting with matching sessionId is always accepted
    if (room.players.some((p) => !p.isBot && p._sessionId === sessionId)) {
      return true;
    }
    if (room.players.length < 6) return true;
    if (room.players.some((p) => p.isBot)) return true;
    if (room.players.some((p) => !p.isBot && p.connected === false)) return true;
    return false;
  }

  function joinOrReconnectPlayer(ws, room, rawPlayerName, rawSessionId) {
    const sessionId = sanitizeSessionId(rawSessionId);

    // 1. Check for existing session in this room (45s reconnect grace or duplicate tab)
    const existingPlayer = room.players.find(
      (p) => !p.isBot && p._sessionId === sessionId
    );

    if (existingPlayer) {
      clearPlayerTimers(existingPlayer);

      // Supersede any stale/other-tab socket with 4001 so the older tab stops auto-reconnecting
      for (const [oldWs, info] of clientMap.entries()) {
        if (info.playerId === existingPlayer.id && oldWs !== ws) {
          info.superseded = true;
          clientMap.delete(oldWs);
          try {
            oldWs.close(WS_CLOSE_SESSION_SUPERSEDED, 'SESSION_SUPERSEDED');
          } catch {
            // ignore
          }
        }
      }

      existingPlayer.connected = true;
      if (rawPlayerName && String(rawPlayerName).trim()) {
        existingPlayer.name = sanitizePlayerName(rawPlayerName);
      }
      ensureConnectedHost(room, false);
      updateRoomBuildPauseState(room);

      clientMap.set(ws, {
        roomCode: room.roomCode,
        playerId: existingPlayer.id,
        sessionId,
      });

      ws.send(
        JSON.stringify({
          type: 'WELCOME',
          playerId: existingPlayer.id,
          sessionId,
          state: sanitizeRoomStateForClient(room, existingPlayer.id),
        })
      );
      ws.send(
        JSON.stringify({
          type: 'LOBBY_LIST',
          rooms: getPublicLobbySummaries(),
        })
      );
      ws.send(
        JSON.stringify({
          type: 'LEADERBOARD_DATA',
          leaderboard,
        })
      );

      broadcastRoomState(room, true, ws);
      return existingPlayer;
    }

    // 2. Make room if 6 slots are full (evict a bot or an offline slot)
    if (room.players.length >= 6) {
      const botIdx = room.players.findIndex((p) => p.isBot);
      if (botIdx !== -1) {
        room.players.splice(botIdx, 1);
      } else {
        const offlineIdx = room.players.findIndex(
          (p) => !p.isBot && p.connected === false
        );
        if (offlineIdx !== -1) {
          const evicted = room.players[offlineIdx];
          clearPlayerTimers(evicted);
          room.players.splice(offlineIdx, 1);
        } else {
          ws.send(
            JSON.stringify({
              type: 'ERROR_TOAST',
              message: 'Room is full (max 6 players).',
            })
          );
          return null;
        }
      }
    }

    const usedColors = new Set(room.players.map((p) => p.color));
    const color =
      PLAYER_COLORS.find((c) => !usedColors.has(c)) ||
      PLAYER_COLORS[room.players.length % PLAYER_COLORS.length];

    const connectedBeforeJoin = getConnectedHumans(room);
    const hasActiveOrGraceHost = getAllHumans(room).some((p) => p.isHost);
    const basePath = computeFullMazePath(room.roundConfig, []);
    const joinedMidRun = room.phase === 'RUN';

    // Cold-boot solo Round 1 starts with _arenaActive = false until CLIENT_ARENA_ACTIVE(true) or player action
    const startColdBootPaused =
      connectedBeforeJoin.length === 0 &&
      room.phase === 'BUILD' &&
      room.currentRoundIndex === 0 &&
      (room.roundsCompleted || 0) === 0 &&
      !room._roundTouched;

    const player = {
      id: `plr_${Math.random().toString(36).slice(2, 9)}`,
      _sessionId: sessionId,
      _disconnectTimer: null,
      _hostTransferTimer: null,
      _joinedMidRun: joinedMidRun,
      _lastAckedSeq: 0,
      _arenaActive: !startColdBootPaused,
      name: sanitizePlayerName(rawPlayerName),
      color,
      isBot: false,
      isHost: !hasActiveOrGraceHost,
      ready: false,
      nextRoundReady: false,
      connected: true,
      usedSampleMaze: false,
      gold: room.roundConfig.startingGold,
      towers: [],
      pathDistance: Number(basePath.totalDistance.toFixed(1)),
      totalScore: 0,
      lastRoundTime: null,
      lastRoundPoints: 0,
      lastRoundClaps: 0,
      lastRoundOvercharge: 0,
      lastRoundKeeps: 0,
      parStarsEarned: 0,
      bestMazeTime: 0,
      roundHistory: [],
    };

    if (joinedMidRun) {
      const baseEval = evaluateMazeRunTime(room.roundConfig, []);
      player._evaluatedFinishTime = baseEval.finishTimeSeconds;
      player._evalClaps = baseEval.clapsTaken;
      player._evalOvercharge = baseEval.overchargedSpires;
      player._evalKeeps = baseEval.linkedKeeps;
      extendActiveRunIfNeeded(room, baseEval.finishTimeSeconds);
    }

    const firstBotIdx = room.players.findIndex((p) => p.isBot);
    if (firstBotIdx === -1) {
      room.players.push(player);
    } else {
      room.players.splice(firstBotIdx, 0, player);
    }

    // Guarantee at least one connected human is host (fixes 45s hostless window after solo-host disconnect)
    if (!getConnectedHumans(room).some((p) => p.isHost)) {
      for (const p of room.players) {
        if (!p.isBot) {
          clearHostTransferTimerOnly(p);
          p.isHost = false;
        }
      }
      ensureConnectedHost(room, false);
    }
    updateRoomBuildPauseState(room);

    clientMap.set(ws, {
      roomCode: room.roomCode,
      playerId: player.id,
      sessionId,
    });

    ws.send(
      JSON.stringify({
        type: 'WELCOME',
        playerId: player.id,
        sessionId,
        state: sanitizeRoomStateForClient(room, player.id),
      })
    );
    ws.send(
      JSON.stringify({
        type: 'LOBBY_LIST',
        rooms: getPublicLobbySummaries(),
      })
    );
    ws.send(
      JSON.stringify({
        type: 'LEADERBOARD_DATA',
        leaderboard,
      })
    );

    if (getConnectedHumans(room).length > 1) {
      addSystemChat(room, `${player.name} joined the room.`);
    }
    broadcastRoomState(room, true, ws);
    return player;
  }

  function requireHostIfMultiHuman(ws, room, player, message) {
    const activeHost = getConnectedHumans(room).find((p) => p.isHost);
    // If the original host is currently offline mid-5s grace, promote caller cleanly WITHOUT canceling _disconnectTimer!
    if (!activeHost && player && !player.isHost) {
      for (const p of room.players) {
        if (!p.isBot) {
          clearHostTransferTimerOnly(p);
          p.isHost = false;
        }
      }
      player.isHost = true;
      addSystemChat(room, `${player.name} is now the room host.`);
      return true;
    }

    if (getConnectedHumans(room).length > 1 && !player.isHost) {
      ws.send(
        JSON.stringify({
          type: 'ERROR_TOAST',
          message: message || 'Only the room host can do that.',
        })
      );
      return false;
    }
    return true;
  }

  function syncPlayerBuildMutation(room, player, wasReady) {
    const fogActive =
      Boolean(room.settings.fogOfWar) || Boolean(room._keepFogUntilRoundEnd);
    if (room.phase === 'BUILD' && fogActive && !wasReady) {
      sendRoomStateToPlayer(room, player.id);
    } else {
      broadcastRoomState(room, false);
    }
  }

  function canAutoStartFromAllReady(room, nowMs = Date.now()) {
    const connectedHumans = getConnectedHumans(room);
    if (connectedHumans.length === 0 || !connectedHumans.every((p) => p.ready)) {
      return false;
    }
    const unreadyOfflineHold =
      room.players.some(
        (p) => !p.isBot && p.connected === false && !p.ready
      ) && nowMs < (room._unreadyDisconnectHoldUntil || 0);
    return !unreadyOfflineHold;
  }

  function advanceToNextRoundOrResetMatch(room) {
    const endless = isInfiniteRounds(room.settings.totalRounds);
    if (
      !endless &&
      (room.phase === 'GAME_OVER' ||
        (room.roundsCompleted || 0) >= room.settings.totalRounds)
    ) {
      reshuffleRoomMapDeck(room, true);
      resetMatchStandingFields(room);
      room._roundTouched = true;
      prepareRoundForRoom(room, 0, true);
    } else {
      const nextIdx = room.currentRoundIndex + 1;
      prepareRoundForRoom(room, nextIdx, true);
    }
  }

  function generateUniqueRoomCode(preferredCode = '') {
    let candidate = String(preferredCode || '')
      .toUpperCase()
      .replace(/[^A-Z0-9-]/g, '')
      .slice(0, 8);

    for (let attempt = 0; attempt < 25; attempt++) {
      if (!candidate) {
        candidate = `RM${Math.floor(1000 + Math.random() * 8999)}`;
      }
      if (!rooms.has(candidate)) {
        return candidate;
      }
      const existing = rooms.get(candidate);
      if (candidate !== 'ARENA1' && getAllHumans(existing).length === 0) {
        rooms.delete(candidate);
        return candidate;
      }
      candidate = '';
    }
    return `RM${Date.now().toString(36).toUpperCase().slice(-6)}`;
  }

  // Master 250ms monotonic server loop for PLANNING, BUILD, RUN, and ROUND_RESULTS
  let lastLoopTickMs = Date.now();
  setInterval(() => {
    const nowMs = Date.now();
    const realDt = Math.min(
      0.5,
      Math.max(0.05, (nowMs - lastLoopTickMs) / 1000)
    );
    lastLoopTickMs = nowMs;

    for (const room of rooms.values()) {
      if (room.phase === 'LOBBY' || room.phase === 'GAME_OVER') continue;
      const connectedHumans = getConnectedHumans(room);
      if (connectedHumans.length === 0) continue;

      if (room.phase === 'PLANNING') {
        room.phaseTimeRemaining = Math.max(0, room.phaseTimeRemaining - realDt);
        const ceilSec = Math.ceil(room.phaseTimeRemaining);
        if (ceilSec !== room._lastBroadcastSec) {
          room._lastBroadcastSec = ceilSec;
          broadcastToRoom(room, {
            type: 'TIMER_TICK',
            phaseTimeRemaining: ceilSec,
            phase: 'PLANNING',
          });
        }
        if (room.phaseTimeRemaining <= 0) {
          room.phase = 'BUILD';
          room.phaseTimeRemaining = room.roundConfig.buildTimeSeconds;
          room._lastBroadcastSec = Math.ceil(room.phaseTimeRemaining);
          room._botStepAccum = 0;
          broadcastRoomState(room, true);
        }
      } else if (room.phase === 'BUILD') {
        updateRoomBuildPauseState(room);
        if (room._buildTimerPaused) {
          continue;
        }

        if (room.settings.buildTimeSeconds !== 999) {
          room.phaseTimeRemaining = Math.max(
            0,
            room.phaseTimeRemaining - realDt
          );
        }

        room._botStepAccum = (room._botStepAccum || 0) + realDt;
        let botTowerPlaced = false;
        let botReadyChanged = false;

        if (room._botStepAccum >= 0.5) {
          room._botStepAccum -= 0.5;
          for (const p of room.players) {
            if (p.isBot && p._pendingBotTowers) {
              if (p._pendingBotTowers.length > 0) {
                const nextTower = p._pendingBotTowers.shift();
                applyBotTower(room, p, nextTower);
                botTowerPlaced = true;
              } else if (!p.ready) {
                p.ready = true;
                botReadyChanged = true;
              }
            }
          }
        }

        const fogActive =
          Boolean(room.settings.fogOfWar) ||
          Boolean(room._keepFogUntilRoundEnd);
        if (!fogActive && (botTowerPlaced || botReadyChanged)) {
          broadcastRoomState(room, false);
        } else if (fogActive && botReadyChanged) {
          broadcastRoomState(room, false);
        }

        if (room.settings.buildTimeSeconds !== 999) {
          const ceilSec = Math.ceil(room.phaseTimeRemaining);
          if (ceilSec !== room._lastBroadcastSec) {
            room._lastBroadcastSec = ceilSec;
            broadcastToRoom(room, {
              type: 'TIMER_TICK',
              phaseTimeRemaining: ceilSec,
              phase: 'BUILD',
              buildTimerPaused: false,
            });
          }
        }

        if (
          (room.settings.buildTimeSeconds !== 999 &&
            room.phaseTimeRemaining <= 0) ||
          canAutoStartFromAllReady(room, nowMs)
        ) {
          startRunPhase(room);
        }
      } else if (room.phase === 'RUN') {
        const speedMult = room.simSpeedMultiplier || 1;
        if (room._runElapsed < room._maxRunTime) {
          room._runElapsed = Math.min(
            room._maxRunTime,
            room._runElapsed + realDt * speedMult
          );
          const simLeft = room._maxRunTime - room._runElapsed;
          room.phaseTimeRemaining = Math.max(
            0,
            simLeft / speedMult + room._postFinishRealRemaining
          );
        } else {
          room._postFinishRealRemaining = Math.max(
            0,
            room._postFinishRealRemaining - realDt
          );
          room.phaseTimeRemaining = Math.max(0, room._postFinishRealRemaining);
        }

        const ceilSec = Math.ceil(room.phaseTimeRemaining);
        if (ceilSec !== room._lastBroadcastSec) {
          room._lastBroadcastSec = ceilSec;
          broadcastToRoom(room, {
            type: 'TIMER_TICK',
            phaseTimeRemaining: ceilSec,
            phase: 'RUN',
            runElapsed: Number(room._runElapsed.toFixed(2)),
          });
        }

        if (
          room._runElapsed >= room._maxRunTime &&
          room._postFinishRealRemaining <= 0
        ) {
          finishRunPhaseAndScore(room);
        }
      } else if (room.phase === 'ROUND_RESULTS') {
        room.phaseTimeRemaining = Math.max(0, room.phaseTimeRemaining - realDt);
        const ceilSec = Math.ceil(room.phaseTimeRemaining);
        if (ceilSec !== room._lastBroadcastSec) {
          room._lastBroadcastSec = ceilSec;
          broadcastToRoom(room, {
            type: 'TIMER_TICK',
            phaseTimeRemaining: ceilSec,
            phase: 'ROUND_RESULTS',
          });
        }

        if (room.phaseTimeRemaining <= 0) {
          advanceToNextRoundOrResetMatch(room);
        }
      }
    }
  }, 250);

  // 25-second WebSocket Keep-Alive Ping for Cloud Proxies
  setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.readyState === 1) {
        try {
          ws.ping();
        } catch {
          // ignore
        }
      }
    }
  }, 25000);

  wss.on('error', (err) => {
    console.warn('WebSocketServer error:', err?.message || err);
  });

  wss.on('connection', (ws, req) => {
    // Prevent oversized payload (>16KB) RangeError or abrupt socket resets from crashing Node
    ws.on('error', () => {});

    const clientIp = getClientIp(req);
    const activeForIp = (ipSocketCounts.get(clientIp) || 0) + 1;
    if (activeForIp > MAX_SOCKETS_PER_IP) {
      try {
        ws.close(1008, 'Too many connections');
      } catch {
        // ignore
      }
      return;
    }
    ipSocketCounts.set(clientIp, activeForIp);

    let currentRoom = null;
    let currentPlayer = null;
    socketMeta.set(ws, {});

    // Send live lobby & leaderboard snapshots immediately even before joining a room
    try {
      ws.send(
        JSON.stringify({
          type: 'LOBBY_LIST',
          rooms: getPublicLobbySummaries(),
        })
      );
      ws.send(
        JSON.stringify({
          type: 'LEADERBOARD_DATA',
          leaderboard,
        })
      );
    } catch {
      // ignore
    }

    // Per-socket token bucket + heavy CPU action cooldown + chat flood guard
    let msgTokens = 50;
    let lastTokenRefillMs = Date.now();
    let consecutiveDrops = 0;
    const lastHeavyActionByType = new Map();
    const recentChatTimestamps = [];

    ws.on('message', (raw) => {
      const nowMs = Date.now();
      const elapsedSec = Math.max(0, (nowMs - lastTokenRefillMs) / 1000);
      lastTokenRefillMs = nowMs;
      msgTokens = Math.min(50, msgTokens + elapsedSec * 30);

      if (msgTokens < 1) {
        consecutiveDrops++;
        if (consecutiveDrops > 16) {
          try {
            ws.close(1008, 'Rate limit exceeded');
          } catch {
            // ignore
          }
        }
        return;
      }
      msgTokens -= 1;
      consecutiveDrops = 0;

      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (!msg || typeof msg.type !== 'string') return;

      if (HEAVY_CPU_ACTIONS.has(msg.type)) {
        const minGapMs = msg.type === 'ADD_BOT' ? 140 : 320;
        const prevHeavyMs = lastHeavyActionByType.get(msg.type) || 0;
        if (nowMs - prevHeavyMs < minGapMs) {
          ackClientSeq(currentPlayer, msg.clientSeq);
          sendBuildRejection(
            ws,
            currentRoom,
            currentPlayer,
            'Please wait a moment before repeating that action.',
            msg.clientSeq
          );
          return;
        }
        lastHeavyActionByType.set(msg.type, nowMs);
      }

      if (msg.type === 'REQUEST_DAILY') {
        const cid = sanitizeDailyClientId(msg.dailyClientId);
        const meta = socketMeta.get(ws) || {};
        if (cid) meta.dailyClientId = cid;
        if (typeof msg.playerName === 'string' && msg.playerName.trim()) {
          meta.playerName = sanitizePlayerName(msg.playerName);
        }
        socketMeta.set(ws, meta);
        ws.send(
          JSON.stringify({
            type: 'DAILY_LEADERBOARD_DATA',
            daily: buildDailyPayload(meta.dailyClientId, meta.playerName),
          })
        );
        return;
      }

      if (msg.type === 'LEAVE_ROOM') {
        if (currentRoom && currentPlayer) {
          // Leaving an active Daily Maze before finishing locks in today's single attempt with the current maze
          if (
            currentRoom.mode === 'DAILY' &&
            currentRoom.phase !== 'GAME_OVER' &&
            currentRoom.phase !== 'LOBBY'
          ) {
            recordDailyResult(
              currentRoom.dailyDateKey || getDailyDateKeyUtc(),
              currentPlayer,
              currentRoom
            );
            broadcastDailyLeaderboardToAll();
          }
          detachSocketFromPreviousRoom(ws, currentRoom, currentPlayer);
          currentRoom = null;
          currentPlayer = null;
        }
        ws.send(JSON.stringify({ type: 'LEFT_ROOM' }));
        ws.send(
          JSON.stringify({
            type: 'LOBBY_LIST',
            rooms: getPublicLobbySummaries(),
          })
        );
        return;
      }

      if (msg.type === 'JOIN_ROOM') {
        const targetCode = String(msg.roomCode || '')
          .toUpperCase()
          .replace(/[^A-Z0-9-]/g, '')
          .slice(0, 8);
        const sessionId = sanitizeSessionId(msg.sessionId);

        if (!targetCode || !rooms.has(targetCode)) {
          ws.send(
            JSON.stringify({
              type: 'ERROR_TOAST',
              message: `Room "${targetCode || '?'}" not found. Check the code or host a new room.`,
            })
          );
          return;
        }

        const existingTarget = rooms.get(targetCode);
        if (existingTarget.mode !== 'ONLINE') {
          ws.send(
            JSON.stringify({
              type: 'ERROR_TOAST',
              message: 'That room is private and cannot be joined.',
            })
          );
          return;
        }

        if (!canRoomAcceptJoin(existingTarget, sessionId)) {
          ws.send(
            JSON.stringify({
              type: 'ERROR_TOAST',
              message: 'Room is full (max 6 players).',
            })
          );
          return;
        }

        if (
          currentRoom &&
          currentPlayer &&
          currentRoom.roomCode !== targetCode
        ) {
          detachSocketFromPreviousRoom(ws, currentRoom, currentPlayer);
          currentRoom = null;
          currentPlayer = null;
        }

        const joined = joinOrReconnectPlayer(
          ws,
          existingTarget,
          msg.playerName,
          sessionId
        );
        if (joined) {
          currentRoom = existingTarget;
          currentPlayer = joined;
        }
        return;
      }

      if (msg.type === 'CREATE_ROOM') {
        if (currentRoom && currentPlayer) {
          detachSocketFromPreviousRoom(ws, currentRoom, currentPlayer);
          currentRoom = null;
          currentPlayer = null;
        }

        const targetCode = generateUniqueRoomCode(msg.roomCode);
        // Online rooms always start in LOBBY phase so players can join & ready up before the host starts!
        const room = createRoom(targetCode, msg.settings || {}, {
          mode: 'ONLINE',
          startInLobby: true,
        });
        const joined = joinOrReconnectPlayer(
          ws,
          room,
          msg.playerName,
          msg.sessionId
        );
        if (joined) {
          currentRoom = room;
          currentPlayer = joined;
        }
        return;
      }

      if (msg.type === 'START_SOLO') {
        if (currentRoom && currentPlayer) {
          detachSocketFromPreviousRoom(ws, currentRoom, currentPlayer);
          currentRoom = null;
          currentPlayer = null;
        }

        const targetCode = generateUniqueRoomCode(
          `SOLO${Math.floor(10 + Math.random() * 89)}`
        );
        const room = createRoom(targetCode, msg.settings || {}, {
          mode: 'SOLO',
          startInLobby: false,
        });
        const joined = joinOrReconnectPlayer(
          ws,
          room,
          msg.playerName,
          msg.sessionId
        );
        if (joined) {
          currentRoom = room;
          currentPlayer = joined;
        }
        return;
      }

      if (msg.type === 'START_DAILY') {
        const dailyClientId = sanitizeDailyClientId(
          msg.dailyClientId || msg.sessionId
        );
        const dateKey = getDailyDateKeyUtc();
        const meta = socketMeta.get(ws) || {};
        if (dailyClientId) meta.dailyClientId = dailyClientId;
        if (typeof msg.playerName === 'string' && msg.playerName.trim()) {
          meta.playerName = sanitizePlayerName(msg.playerName);
        }
        socketMeta.set(ws, meta);

        // Enforce 1 attempt per day
        if (hasCompletedDaily(dateKey, dailyClientId)) {
          ws.send(
            JSON.stringify({
              type: 'DAILY_LEADERBOARD_DATA',
              daily: buildDailyPayload(dailyClientId, msg.playerName),
            })
          );
          ws.send(
            JSON.stringify({
              type: 'ERROR_TOAST',
              message:
                "You've already completed today's Daily Maze! Come back tomorrow.",
            })
          );
          return;
        }

        // Reconnect into an existing active Daily Maze room for this player if still running
        let activeDailyRoom = null;
        for (const r of rooms.values()) {
          if (
            r.mode === 'DAILY' &&
            r.dailyDateKey === dateKey &&
            r._dailyClientId &&
            r._dailyClientId === dailyClientId &&
            r.phase !== 'GAME_OVER'
          ) {
            activeDailyRoom = r;
            break;
          }
        }

        if (
          currentRoom &&
          currentPlayer &&
          (!activeDailyRoom || currentRoom.roomCode !== activeDailyRoom.roomCode)
        ) {
          detachSocketFromPreviousRoom(ws, currentRoom, currentPlayer);
          currentRoom = null;
          currentPlayer = null;
        }

        let room = activeDailyRoom;
        if (!room) {
          const dailyInfo = getCachedDailyConfig(dateKey);
          const targetCode = generateUniqueRoomCode(
            `DAY${Math.floor(100 + Math.random() * 899)}`
          );
          room = createRoom(
            targetCode,
            {
              roomName: `Daily Maze #${dailyInfo.puzzleNumber}`,
              isPublic: false,
              totalRounds: 1,
              buildTimeSeconds: DAILY_BUILD_TIME_SECONDS || 120,
              goldMultiplier: 1.0,
              botCount: 0,
              fogOfWar: false,
            },
            {
              mode: 'DAILY',
              startInLobby: false,
              dailyDateKey: dailyInfo.dateKey,
              dailyPuzzleNumber: dailyInfo.puzzleNumber,
              dailyRoundConfig: dailyInfo.roundConfig,
              dailyClientId,
            }
          );
        }

        const joined = joinOrReconnectPlayer(
          ws,
          room,
          msg.playerName,
          msg.sessionId
        );
        if (joined) {
          joined._dailyClientId = dailyClientId;
          currentRoom = room;
          currentPlayer = joined;
        }
        return;
      }

      if (msg.type === 'REQUEST_LOBBIES') {
        ws.send(
          JSON.stringify({
            type: 'LOBBY_LIST',
            rooms: getPublicLobbySummaries(),
          })
        );
        ws.send(
          JSON.stringify({
            type: 'LEADERBOARD_DATA',
            leaderboard,
          })
        );
        return;
      }

      if (!currentRoom || !currentPlayer) return;

      switch (msg.type) {
        case 'CLIENT_ARENA_ACTIVE': {
          const nextActive = Boolean(msg.active);
          if (currentPlayer._arenaActive !== nextActive) {
            currentPlayer._arenaActive = nextActive;
            if (updateRoomBuildPauseState(currentRoom)) {
              broadcastRoomState(currentRoom, false);
            }
          }
          break;
        }

        case 'SET_NAME': {
          const cleanName = sanitizePlayerName(msg.playerName);
          if (cleanName && cleanName !== currentPlayer.name) {
            currentPlayer.name = cleanName;
            broadcastRoomState(currentRoom, currentPlayer.isHost);
          }
          break;
        }

        case 'PLACE_TOWER': {
          ackClientSeq(currentPlayer, msg.clientSeq);
          markArenaTouched(currentRoom, currentPlayer);

          if (currentRoom.phase !== 'BUILD') {
            sendBuildRejection(
              ws,
              currentRoom,
              currentPlayer,
              'Walls can only be placed during the Build phase.',
              msg.clientSeq
            );
            return;
          }

          if (!Number.isInteger(msg.x) || !Number.isInteger(msg.y)) {
            sendBuildRejection(
              ws,
              currentRoom,
              currentPlayer,
              'Out of bounds.',
              msg.clientSeq
            );
            return;
          }

          const wallCost = TOWER_SPECS.BLOCK.goldCost;
          if (currentPlayer.gold < wallCost) {
            sendBuildRejection(
              ws,
              currentRoom,
              currentPlayer,
              'No walls left. Remove a wall first.',
              msg.clientSeq
            );
            return;
          }

          const validation = validateTowerPlacement(
            currentRoom.roundConfig,
            currentPlayer.towers,
            msg.x,
            msg.y
          );

          if (!validation.valid || !validation.pathResult) {
            sendBuildRejection(
              ws,
              currentRoom,
              currentPlayer,
              validation.reason || 'Cannot place wall there.',
              msg.clientSeq
            );
            return;
          }

          const clientId = sanitizeClientId(msg.clientId);
          const newTower = {
            id: `twr_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
            type: 'BLOCK',
            x: msg.x,
            y: msg.y,
            createdAt: Date.now(),
            ...(clientId ? { clientId } : {}),
          };

          const wasReady = currentPlayer.ready;
          currentPlayer.towers.push(newTower);
          currentPlayer.gold -= wallCost;
          currentPlayer.pathDistance = Number(
            validation.pathResult.totalDistance.toFixed(1)
          );
          currentPlayer.ready = false;

          syncPlayerBuildMutation(currentRoom, currentPlayer, wasReady);
          break;
        }

        case 'SELL_TOWER': {
          ackClientSeq(currentPlayer, msg.clientSeq);
          markArenaTouched(currentRoom, currentPlayer);

          if (currentRoom.phase !== 'BUILD') {
            sendRoomStateToPlayer(currentRoom, currentPlayer.id);
            return;
          }

          const idx = currentPlayer.towers.findIndex(
            (t) =>
              (typeof msg.towerId === 'string' &&
                msg.towerId.length > 0 &&
                (t.id === msg.towerId || t.clientId === msg.towerId)) ||
              (Number.isInteger(msg.x) &&
                Number.isInteger(msg.y) &&
                t.x === msg.x &&
                t.y === msg.y)
          );
          if (idx === -1) {
            sendRoomStateToPlayer(currentRoom, currentPlayer.id);
            return;
          }

          const wasReady = currentPlayer.ready;
          currentPlayer.towers.splice(idx, 1);
          currentPlayer.gold = Math.min(
            currentRoom.roundConfig.startingGold,
            currentPlayer.gold + TOWER_SPECS.BLOCK.goldCost
          );
          const newPath = computeFullMazePath(
            currentRoom.roundConfig,
            currentPlayer.towers
          );
          currentPlayer.pathDistance = Number(
            newPath.totalDistance.toFixed(1)
          );
          currentPlayer.ready = false;

          syncPlayerBuildMutation(currentRoom, currentPlayer, wasReady);
          break;
        }

        case 'RESTORE_TOWERS': {
          ackClientSeq(currentPlayer, msg.clientSeq);
          markArenaTouched(currentRoom, currentPlayer);

          if (currentRoom.phase !== 'BUILD' || !Array.isArray(msg.towers)) {
            sendRoomStateToPlayer(currentRoom, currentPlayer.id);
            return;
          }

          const wallCost = TOWER_SPECS.BLOCK.goldCost;
          const maxWalls = Math.floor(
            currentRoom.roundConfig.startingGold / wallCost
          );
          const wasReady = currentPlayer.ready;

          currentPlayer.towers = [];
          currentPlayer.gold = currentRoom.roundConfig.startingGold;
          // Sticky match-wide usedSampleMaze (never laundered via Clear -> Undo)
          currentPlayer.usedSampleMaze = Boolean(
            currentPlayer.usedSampleMaze || msg.usedSampleMaze
          );
          currentPlayer.ready = false;

          const limit = Math.min(maxWalls, msg.towers.length);
          for (let i = 0; i < limit; i++) {
            const pt = msg.towers[i];
            if (
              !pt ||
              !Number.isInteger(pt.x) ||
              !Number.isInteger(pt.y) ||
              currentPlayer.gold < wallCost
            ) {
              continue;
            }
            const check = validateTowerPlacement(
              currentRoom.roundConfig,
              currentPlayer.towers,
              pt.x,
              pt.y
            );
            if (check.valid && check.pathResult) {
              currentPlayer.towers.push({
                id: `twr_${Date.now()}_${i}_${Math.random().toString(36).slice(2, 5)}`,
                type: 'BLOCK',
                x: pt.x,
                y: pt.y,
                createdAt: Date.now(),
              });
              currentPlayer.gold -= wallCost;
            }
          }

          const restoredPath = computeFullMazePath(
            currentRoom.roundConfig,
            currentPlayer.towers
          );
          currentPlayer.pathDistance = Number(
            restoredPath.totalDistance.toFixed(1)
          );

          syncPlayerBuildMutation(currentRoom, currentPlayer, wasReady);
          break;
        }

        case 'CLEAR_TOWERS': {
          ackClientSeq(currentPlayer, msg.clientSeq);
          markArenaTouched(currentRoom, currentPlayer);

          if (currentRoom.phase !== 'BUILD') {
            sendRoomStateToPlayer(currentRoom, currentPlayer.id);
            return;
          }

          const wasReady = currentPlayer.ready;
          currentPlayer.towers = [];
          currentPlayer.gold = currentRoom.roundConfig.startingGold;
          // Keep currentPlayer.usedSampleMaze sticky across Clear All
          const basePath = computeFullMazePath(currentRoom.roundConfig, []);
          currentPlayer.pathDistance = Number(
            basePath.totalDistance.toFixed(1)
          );
          currentPlayer.ready = false;

          syncPlayerBuildMutation(currentRoom, currentPlayer, wasReady);
          break;
        }

        case 'LOAD_PRESET_DEMO': {
          ackClientSeq(currentPlayer, msg.clientSeq);
          markArenaTouched(currentRoom, currentPlayer);

          if (currentRoom.mode === 'DAILY') {
            sendBuildRejection(
              ws,
              currentRoom,
              currentPlayer,
              'Sample mazes are disabled in the Daily Maze.',
              msg.clientSeq
            );
            return;
          }

          if (currentRoom.phase !== 'BUILD') {
            sendBuildRejection(
              ws,
              currentRoom,
              currentPlayer,
              'Sample mazes can only be loaded during the Build phase.',
              msg.clientSeq
            );
            return;
          }

          const wallCost = TOWER_SPECS.BLOCK.goldCost;
          const maxWalls = Math.floor(
            currentRoom.roundConfig.startingGold / wallCost
          );
          const sampleCap = Math.max(1, Math.floor(maxWalls * 0.8));
          const preferredStyle = selectSampleMazeStyle(currentRoom.roundConfig);
          const rawScaffold = generateMazeLayout(
            currentRoom.roundConfig,
            'ARCHITECT',
            preferredStyle
          );

          const wasReady = currentPlayer.ready;
          currentPlayer.towers = [];
          currentPlayer.gold = currentRoom.roundConfig.startingGold;

          for (const candidate of rawScaffold.slice(0, sampleCap)) {
            if (
              !candidate ||
              !Number.isInteger(candidate.x) ||
              !Number.isInteger(candidate.y) ||
              currentPlayer.gold < wallCost
            ) {
              continue;
            }
            const check = validateTowerPlacement(
              currentRoom.roundConfig,
              currentPlayer.towers,
              candidate.x,
              candidate.y
            );
            if (check.valid && check.pathResult) {
              currentPlayer.towers.push({
                id: `twr_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
                type: 'BLOCK',
                x: candidate.x,
                y: candidate.y,
                createdAt: Date.now(),
              });
              currentPlayer.gold -= wallCost;
            }
          }

          const demoPath = computeFullMazePath(
            currentRoom.roundConfig,
            currentPlayer.towers
          );
          currentPlayer.pathDistance = Number(
            demoPath.totalDistance.toFixed(1)
          );
          currentPlayer.usedSampleMaze = true;
          currentPlayer.ready = false;

          syncPlayerBuildMutation(currentRoom, currentPlayer, wasReady);
          break;
        }

        case 'REROLL_MAP': {
          if (currentRoom.mode === 'DAILY') {
            ws.send(
              JSON.stringify({
                type: 'ERROR_TOAST',
                message: 'Everyone competes on the exact same Daily Maze.',
              })
            );
            return;
          }
          if (currentRoom.phase !== 'BUILD') return;
          if (
            !requireHostIfMultiHuman(
              ws,
              currentRoom,
              currentPlayer,
              'Only the room host can generate a new map.'
            )
          ) {
            return;
          }
          if ((currentRoom._rerollsThisRound || 0) >= MAX_TOTAL_REROLLS_PER_ROUND) {
            ws.send(
              JSON.stringify({
                type: 'ERROR_TOAST',
                message: 'Map reroll limit reached for this round.',
              })
            );
            return;
          }
          currentRoom._rerollsThisRound =
            (currentRoom._rerollsThisRound || 0) + 1;
          markArenaTouched(currentRoom, currentPlayer);
          // Swap in a fresh unused random map matching this room's allowedRunners filter
          ensureDeckCoversSlot(currentRoom, currentRoom.currentRoundIndex);
          const allowedRunners = normalizeAllowedRunners(
            currentRoom.settings?.allowedRunners
          );
          const currentMapIdx =
            currentRoom._mapDeck[currentRoom.currentRoundIndex];
          const usedInMatch = new Set(
            currentRoom._mapDeck.slice(
              0,
              isInfiniteRounds(currentRoom.settings?.totalRounds)
                ? currentRoom.currentRoundIndex + 1
                : Math.min(
                    currentRoom._mapDeck.length,
                    Number(currentRoom.settings?.totalRounds) ||
                      DEFAULT_MATCH_ROUNDS
                  )
            )
          );
          const filteredPool = createShuffledMapDeck(
            [...usedInMatch],
            Math.random,
            allowedRunners
          );
          const freshChoice =
            filteredPool.find((idx) => !usedInMatch.has(idx)) ??
            filteredPool.find((idx) => idx !== currentMapIdx);
          if (freshChoice !== undefined) {
            // Keep deck entries unique where possible by swapping if present later in deck
            const laterIdx = currentRoom._mapDeck.indexOf(
              freshChoice,
              currentRoom.currentRoundIndex + 1
            );
            if (laterIdx !== -1) {
              currentRoom._mapDeck[laterIdx] = currentMapIdx;
            }
            currentRoom._mapDeck[currentRoom.currentRoundIndex] = freshChoice;
          }
          prepareRoundForRoom(currentRoom, currentRoom.currentRoundIndex, true, {
            preserveRerollCount: true,
          });
          if (currentRoom._rerollsThisRound === MAX_RANKED_REROLLS_PER_ROUND + 1) {
            addSystemChat(
              currentRoom,
              'Practice seed: 3+ map rerolls on the same round run unranked.'
            );
          }
          break;
        }

        case 'TOGGLE_READY': {
          ackClientSeq(currentPlayer, msg.clientSeq);
          markArenaTouched(currentRoom, currentPlayer);

          if (currentRoom.phase === 'LOBBY') {
            currentPlayer.ready = !currentPlayer.ready;
            broadcastRoomState(currentRoom, true);
            return;
          }

          if (currentRoom.phase !== 'BUILD') {
            sendRoomStateToPlayer(currentRoom, currentPlayer.id);
            return;
          }

          currentPlayer.ready = !currentPlayer.ready;
          broadcastRoomState(currentRoom, false);

          if (canAutoStartFromAllReady(currentRoom)) {
            startRunPhase(currentRoom);
          }
          break;
        }

        case 'START_GAME': {
          if (
            !requireHostIfMultiHuman(
              ws,
              currentRoom,
              currentPlayer,
              'Only the room host can start the round.'
            )
          ) {
            return;
          }
          if (currentRoom.phase === 'LOBBY') {
            const connectedHumans = getConnectedHumans(currentRoom);
            if (
              connectedHumans.length === 0 ||
              !connectedHumans.every((p) => p.ready)
            ) {
              ws.send(
                JSON.stringify({
                  type: 'ERROR_TOAST',
                  message:
                    'Every player in the lobby must ready up before starting.',
                })
              );
              return;
            }
            resetMatchStandingFields(currentRoom);
            markArenaTouched(currentRoom, currentPlayer);
            addSystemChat(
              currentRoom,
              `${currentPlayer.name} started the match! 5-second planning timer begins.`
            );
            prepareRoundForRoom(currentRoom, 0, true);
            return;
          }
          if (Number.isInteger(msg.roundIndex)) {
            if (currentRoom.mode === 'DAILY') return;
            if (currentRoom.phase === 'RUN') {
              ws.send(
                JSON.stringify({
                  type: 'ERROR_TOAST',
                  message:
                    'Wait for the current run to finish before switching rounds.',
                })
              );
              return;
            }
            markArenaTouched(currentRoom, currentPlayer);
            resetMatchStandingFields(currentRoom);
            currentRoom._roundTouched = true;
            prepareRoundForRoom(currentRoom, msg.roundIndex, true);
          } else if (currentRoom.phase === 'BUILD') {
            markArenaTouched(currentRoom, currentPlayer);
            startRunPhase(currentRoom);
          }
          break;
        }

        case 'NEXT_ROUND': {
          if (currentRoom.mode === 'DAILY') return;
          if (
            currentRoom.phase !== 'ROUND_RESULTS' &&
            currentRoom.phase !== 'GAME_OVER'
          ) {
            return;
          }
          markArenaTouched(currentRoom, currentPlayer);
          currentPlayer.nextRoundReady = true;

          const connectedHumans = getConnectedHumans(currentRoom);
          if (
            connectedHumans.length <= 1 ||
            currentPlayer.isHost ||
            connectedHumans.every((p) => p.nextRoundReady)
          ) {
            advanceToNextRoundOrResetMatch(currentRoom);
          } else {
            broadcastRoomState(currentRoom, false);
          }
          break;
        }

        case 'RESTART_MATCH': {
          if (currentRoom.mode === 'DAILY') return;
          const connectedHumans = getConnectedHumans(currentRoom);

          // In GAME_OVER, non-hosts can cast a nextRoundReady vote to start a new match
          if (
            currentRoom.phase === 'GAME_OVER' &&
            connectedHumans.length > 1 &&
            !currentPlayer.isHost
          ) {
            currentPlayer.nextRoundReady = true;
            if (connectedHumans.every((p) => p.nextRoundReady)) {
              advanceToNextRoundOrResetMatch(currentRoom);
            } else {
              broadcastRoomState(currentRoom, false);
            }
            return;
          }

          if (
            !requireHostIfMultiHuman(
              ws,
              currentRoom,
              currentPlayer,
              'Only the room host can restart the match.'
            )
          ) {
            return;
          }

          reshuffleRoomMapDeck(currentRoom, true);
          resetMatchStandingFields(currentRoom);
          markArenaTouched(currentRoom, currentPlayer);
          addSystemChat(
            currentRoom,
            `${currentPlayer.name} restarted the match with fresh randomized maps.`
          );
          prepareRoundForRoom(currentRoom, 0, true);
          break;
        }

        case 'JUMP_TO_ROUND': {
          if (currentRoom.mode === 'DAILY') return;
          if (
            !requireHostIfMultiHuman(
              ws,
              currentRoom,
              currentPlayer,
              'Only the room host can switch rounds.'
            )
          ) {
            return;
          }
          if (currentRoom.phase === 'RUN') {
            ws.send(
              JSON.stringify({
                type: 'ERROR_TOAST',
                message:
                  'Wait for the current run to finish before switching rounds.',
              })
            );
            return;
          }
          if (Number.isInteger(msg.mapId)) {
            const targetMapIdx = ROUNDS.findIndex(
              (r) => (r.mapId ?? r.roundNumber) === msg.mapId
            );
            if (targetMapIdx !== -1) {
              // Pin selected map to Round 1 and shuffle all remaining filtered maps behind it
              const rest = createShuffledMapDeck(
                [targetMapIdx],
                Math.random,
                currentRoom.settings?.allowedRunners
              ).filter((idx) => idx !== targetMapIdx);
              currentRoom._mapDeck = [targetMapIdx, ...rest];
              resetMatchStandingFields(currentRoom);
              markArenaTouched(currentRoom, currentPlayer);
              prepareRoundForRoom(currentRoom, 0, true);
            }
          } else if (
            typeof msg.roundIndex === 'number' &&
            !Number.isNaN(msg.roundIndex)
          ) {
            // Reset match standings on manual round jumps to prevent Round-1 win farming
            resetMatchStandingFields(currentRoom);
            markArenaTouched(currentRoom, currentPlayer);
            prepareRoundForRoom(currentRoom, Math.floor(msg.roundIndex), true);
          }
          break;
        }

        case 'SET_SIM_SPEED': {
          if (![1, 2, 4].includes(msg.speed)) return;
          if (
            !requireHostIfMultiHuman(
              ws,
              currentRoom,
              currentPlayer,
              'Only the room host can change playback speed.'
            )
          ) {
            return;
          }
          currentRoom.simSpeedMultiplier = msg.speed;
          if (currentRoom.phase === 'RUN') {
            const simLeft = Math.max(
              0,
              currentRoom._maxRunTime - currentRoom._runElapsed
            );
            currentRoom.phaseTimeRemaining = Math.max(
              0,
              simLeft / msg.speed + currentRoom._postFinishRealRemaining
            );
            currentRoom._lastBroadcastSec = Math.ceil(
              currentRoom.phaseTimeRemaining
            );
          }
          broadcastRoomState(currentRoom, false);
          break;
        }

        case 'UPDATE_SETTINGS': {
          if (currentRoom.mode === 'DAILY') return;
          if (
            !requireHostIfMultiHuman(
              ws,
              currentRoom,
              currentPlayer,
              'Only the room host can change room rules.'
            )
          ) {
            return;
          }

          const prevSettings = { ...currentRoom.settings };
          currentRoom.settings = normalizeRoomSettings(
            { ...currentRoom.settings, ...(msg.settings || {}) },
            currentRoom.roomCode
          );

          const isBuildPhase = currentRoom.phase === 'BUILD';
          const isLobbyPhase = currentRoom.phase === 'LOBBY';
          const goldChanged =
            prevSettings.goldMultiplier !== currentRoom.settings.goldMultiplier;
          const timerChanged =
            prevSettings.buildTimeSeconds !==
            currentRoom.settings.buildTimeSeconds;
          const runnersChanged =
            normalizeAllowedRunners(prevSettings.allowedRunners).join(',') !==
            normalizeAllowedRunners(currentRoom.settings.allowedRunners).join(
              ','
            );

          if (runnersChanged) {
            if (isLobbyPhase) {
              currentRoom._mapDeck = createShuffledMapDeck(
                [],
                Math.random,
                currentRoom.settings.allowedRunners
              );
              const firstMap = ROUNDS[currentRoom._mapDeck[0]] || ROUNDS[0];
              const refreshed = generateRandomRoundLayout(firstMap);
              refreshed.roundNumber = 1;
              refreshed.mapId = firstMap.mapId ?? firstMap.roundNumber;
              refreshed.startingGold = Math.max(
                25,
                Math.round(
                  (firstMap.startingGold *
                    (Number(currentRoom.settings.goldMultiplier) || 1.0)) /
                    5
                ) * 5
              );
              refreshed.parTimeSeconds = computeEffectivePar(
                firstMap.parTimeSeconds,
                currentRoom.settings.goldMultiplier
              );
              refreshed.buildTimeSeconds = computeRoundBuildSeconds(
                firstMap,
                currentRoom.settings
              );
              currentRoom.roundConfig = refreshed;
            } else {
              // Keep active round slot intact and re-filter all upcoming slots
              const activeSlot = currentRoom.currentRoundIndex || 0;
              const prefix = (currentRoom._mapDeck || []).slice(
                0,
                activeSlot + 1
              );
              const tail = createShuffledMapDeck(
                prefix,
                Math.random,
                currentRoom.settings.allowedRunners
              );
              currentRoom._mapDeck = [...prefix, ...tail];
            }
          }

          // Update round startingGold & Par BEFORE syncRoomBots so bots regenerate at most ONCE
          if (isBuildPhase) {
            const baseRound = getBaseMapForRoom(currentRoom);
            if (goldChanged) {
              const newGold = Math.max(
                25,
                Math.round(
                  (baseRound.startingGold *
                    currentRoom.settings.goldMultiplier) /
                    5
                ) * 5
              );
              currentRoom.roundConfig.startingGold = newGold;
              currentRoom.roundConfig.parTimeSeconds = computeEffectivePar(
                baseRound.parTimeSeconds,
                currentRoom.settings.goldMultiplier
              );

              const wallCost = TOWER_SPECS.BLOCK.goldCost;
              for (const p of currentRoom.players) {
                if (p.isBot) continue;
                const maxTowers = Math.floor(newGold / wallCost);
                if (p.towers.length > maxTowers) {
                  p.towers = p.towers.slice(0, maxTowers);
                  const newPath = computeFullMazePath(
                    currentRoom.roundConfig,
                    p.towers
                  );
                  p.pathDistance = Number(newPath.totalDistance.toFixed(1));
                }
                p.gold = Math.max(0, newGold - p.towers.length * wallCost);
              }
            }

            if (
              timerChanged ||
              (goldChanged && currentRoom.settings.buildTimeSeconds === 0)
            ) {
              const targetSecs = computeRoundBuildSeconds(
                baseRound,
                currentRoom.settings
              );
              currentRoom.roundConfig.buildTimeSeconds = targetSecs;
              currentRoom.phaseTimeRemaining = targetSecs;
              currentRoom._lastBroadcastSec = Math.ceil(targetSecs);
            }
          }

          syncRoomBots(currentRoom, {
            forceRegenAllBots: isBuildPhase && goldChanged,
          });
          const connectedHumans = getConnectedHumans(currentRoom);

          // Prevent silent mid-BUILD Fog of War spy toggles when rivals already placed walls
          if (prevSettings.fogOfWar !== currentRoom.settings.fogOfWar) {
            const rivalsHaveBuilt =
              isBuildPhase &&
              connectedHumans.length > 1 &&
              currentRoom.players.some(
                (p) => !p.isBot && p.id !== currentPlayer.id && p.towers.length > 0
              );

            if (
              prevSettings.fogOfWar === true &&
              currentRoom.settings.fogOfWar === false &&
              rivalsHaveBuilt
            ) {
              currentRoom._keepFogUntilRoundEnd = true;
              addSystemChat(
                currentRoom,
                `${currentPlayer.name} set Rival Mazes to Visible (takes effect next round).`
              );
            } else {
              currentRoom._keepFogUntilRoundEnd = false;
              if (connectedHumans.length > 1) {
                addSystemChat(
                  currentRoom,
                  `${currentPlayer.name} set Rival Mazes to ${currentRoom.settings.fogOfWar ? 'Hidden' : 'Visible'}.`
                );
              }
            }
          }

          const majorRuleChanged =
            prevSettings.totalRounds !== currentRoom.settings.totalRounds ||
            prevSettings.buildTimeSeconds !==
              currentRoom.settings.buildTimeSeconds ||
            prevSettings.goldMultiplier !== currentRoom.settings.goldMultiplier ||
            runnersChanged;

          if (majorRuleChanged && connectedHumans.length > 1) {
            addSystemChat(
              currentRoom,
              `${currentPlayer.name} updated room rules.`
            );
          }

          updateRoomBuildPauseState(currentRoom);
          broadcastRoomState(currentRoom, true);
          break;
        }

        case 'ADD_BOT': {
          if (currentRoom.mode === 'DAILY') return;
          if (
            !requireHostIfMultiHuman(
              ws,
              currentRoom,
              currentPlayer,
              'Only the room host can manage bots.'
            )
          ) {
            return;
          }
          if (currentRoom.players.length >= 6) {
            ws.send(
              JSON.stringify({
                type: 'ERROR_TOAST',
                message: 'Room is full (max 6 players).',
              })
            );
            return;
          }
          const validDiff = ['NOVICE', 'ARCHITECT', 'GRANDMASTER'].includes(
            msg.difficulty
          )
            ? msg.difficulty
            : currentRoom.settings.botDifficulty;

          const usedColors = new Set(currentRoom.players.map((p) => p.color));
          const usedNames = new Set(currentRoom.players.map((p) => p.name));
          let presetIdx = currentRoom.players.length;
          for (let i = 0; i < BOT_PRESETS.length; i++) {
            if (!usedNames.has(BOT_PRESETS[i].name)) {
              presetIdx = i;
              break;
            }
          }
          const bot = createBotPlayer(
            presetIdx,
            usedColors,
            validDiff,
            usedNames
          );
          bot.gold = currentRoom.roundConfig.startingGold;
          if (
            currentRoom.phase === 'BUILD' ||
            currentRoom.phase === 'PLANNING'
          ) {
            bot.ready = false;
            bot._pendingBotTowers = generateMazeLayout(
              currentRoom.roundConfig,
              bot.botDifficulty,
              bot.botStyle
            );
          } else if (currentRoom.phase === 'RUN') {
            const baseEval = evaluateMazeRunTime(currentRoom.roundConfig, []);
            bot._evaluatedFinishTime = baseEval.finishTimeSeconds;
            bot._evalClaps = baseEval.clapsTaken;
            bot._evalOvercharge = baseEval.overchargedSpires;
            bot._evalKeeps = baseEval.linkedKeeps;
            extendActiveRunIfNeeded(currentRoom, baseEval.finishTimeSeconds);
          }
          const basePath = computeFullMazePath(currentRoom.roundConfig, []);
          bot.pathDistance = Number(basePath.totalDistance.toFixed(1));
          currentRoom.players.push(bot);
          currentRoom.settings.botCount = currentRoom.players.filter(
            (p) => p.isBot
          ).length;
          broadcastRoomState(currentRoom, true);
          break;
        }

        case 'REMOVE_BOT': {
          if (currentRoom.mode === 'DAILY') return;
          if (
            !requireHostIfMultiHuman(
              ws,
              currentRoom,
              currentPlayer,
              'Only the room host can manage bots.'
            )
          ) {
            return;
          }
          const botIndex =
            typeof msg.botId === 'string' && msg.botId.length > 0
              ? currentRoom.players.findIndex(
                  (p) => p.isBot && p.id === msg.botId
                )
              : -1;
          const fallbackBotIndex =
            botIndex !== -1
              ? botIndex
              : currentRoom.players.map((p) => p.isBot).lastIndexOf(true);

          if (fallbackBotIndex !== -1) {
            currentRoom.players.splice(fallbackBotIndex, 1);
            currentRoom.settings.botCount = currentRoom.players.filter(
              (p) => p.isBot
            ).length;
            broadcastRoomState(currentRoom, true);
          }
          break;
        }

        case 'CHAT': {
          const cutoff = nowMs - 4000;
          while (
            recentChatTimestamps.length > 0 &&
            recentChatTimestamps[0] < cutoff
          ) {
            recentChatTimestamps.shift();
          }
          if (recentChatTimestamps.length >= 4) {
            ws.send(
              JSON.stringify({
                type: 'ERROR_TOAST',
                message: 'Sending messages too quickly.',
              })
            );
            return;
          }

          const text = String(msg.text || '').trim().slice(0, 180);
          if (!text) return;
          recentChatTimestamps.push(nowMs);

          const chatMsg = {
            id: `chat_${nowMs}_${Math.random().toString(36).slice(2, 6)}`,
            senderName: currentPlayer.name,
            senderColor: currentPlayer.color,
            text,
            timestamp: nowMs,
          };
          currentRoom.chat.push(chatMsg);
          if (currentRoom.chat.length > 40) currentRoom.chat.shift();
          broadcastToRoom(currentRoom, {
            type: 'CHAT_MESSAGE',
            message: chatMsg,
          });
          break;
        }
      }
    });

    ws.on('close', () => {
      const remForIp = (ipSocketCounts.get(clientIp) || 1) - 1;
      if (remForIp <= 0) {
        ipSocketCounts.delete(clientIp);
      } else {
        ipSocketCounts.set(clientIp, remForIp);
      }

      socketMeta.delete(ws);
      const info = clientMap.get(ws);
      clientMap.delete(ws);
      if (!info || info.superseded) return;
      handleSocketDisconnect(currentRoom, currentPlayer);
    });
  });

  // Disable HTTP caching on dynamic JSON APIs so players always see fresh leaderboard & lobby state
  app.use('/api', (_req, res, next) => {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
    next();
  });

  // REST API Endpoints for Lobby Browser, Leaderboard, Daily Maze & Cloud Healthchecks
  app.get('/api/health', (_req, res) => {
    res.json({
      status: 'ok',
      storage: storage.getBackendName(),
      activeRooms: rooms.size,
      connectedPlayers: clientMap.size,
      uptimeSeconds: Math.floor(process.uptime()),
    });
  });

  app.get('/api/lobbies', (_req, res) => {
    res.json({ rooms: getPublicLobbySummaries() });
  });

  app.get('/api/rooms', (_req, res) => {
    res.json({ rooms: getPublicLobbySummaries() });
  });

  app.get('/api/leaderboard', (_req, res) => {
    res.json(leaderboard);
  });

  app.get('/api/daily', (req, res) => {
    const clientId =
      typeof req.query?.clientId === 'string' ? req.query.clientId : '';
    const playerName =
      typeof req.query?.playerName === 'string' ? req.query.playerName : '';
    res.json(buildDailyPayload(clientId, playerName));
  });

  // Serve compiled static bundle in production if dist/index.html exists
  if (isProdStatic) {
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  } else {
    app.use(vite.middlewares);
  }

  server.listen(PORT, () => {
    console.log(
      `\nMazing Contest server running at http://localhost:${PORT}\n`
    );
  });
}

startServer();
