import express from 'express';
import fs from 'fs';
import path from 'path';
import http from 'http';
import { fileURLToPath } from 'url';
import { WebSocketServer } from 'ws';
import { createServer as createViteServer } from 'vite';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');
const DATA_DIR = path.join(__dirname, 'data');
const LEADERBOARD_FILE = path.join(DATA_DIR, 'leaderboard.json');

const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;

const PLAYER_COLORS = [
  '#38bdf8', // Cyan (Player 1)
  '#f59e0b', // Amber Gold (Player 2)
  '#c084fc', // Arcane Violet (Player 3)
  '#34d399', // Emerald (Player 4)
  '#f43f5e', // Crimson Rose (Player 5)
  '#fb923c', // Solar Orange (Player 6)
];

const BOT_PRESETS = [
  { name: 'Grandmaster Pender', difficulty: 'GRANDMASTER', style: 'SWITCHBACK' },
  { name: 'Archmage Vashj', difficulty: 'ARCHITECT', style: 'SPIRAL' },
  { name: 'Stormlord Kael', difficulty: 'ARCHITECT', style: 'CLAP_CHAIN' },
  { name: 'Acolyte Kel', difficulty: 'NOVICE', style: 'SWITCHBACK' },
  { name: 'Warden Maiev', difficulty: 'GRANDMASTER', style: 'SPIRAL' },
];

function createSeededLeaderboard(ROUNDS) {
  const now = Date.now();
  /** @type {Record<number, any[]>} */
  const roundRecords = {};

  const famousArchitects = [
    { name: 'Grandmaster Pender', color: '#f59e0b', bonus: 1.18, claps: 9, overcharge: 3, keeps: 5 },
    { name: 'Elvenking', color: '#38bdf8', bonus: 1.11, claps: 8, overcharge: 2, keeps: 4 },
    { name: 'Archmage Vashj', color: '#c084fc', bonus: 1.05, claps: 7, overcharge: 2, keeps: 4 },
    { name: 'Warden Maiev', color: '#34d399', bonus: 0.98, claps: 6, overcharge: 1, keeps: 3 },
    { name: 'Stormlord Kael', color: '#f43f5e', bonus: 0.92, claps: 5, overcharge: 1, keeps: 2 },
  ];

  for (const r of ROUNDS) {
    roundRecords[r.roundNumber] = famousArchitects.map((arch, idx) => {
      const survivalTimeSeconds = Number(
        (r.parTimeSeconds * arch.bonus - idx * 0.65).toFixed(2)
      );
      const pathDistance = Number(
        (survivalTimeSeconds * 2.45 + 18).toFixed(1)
      );
      return {
        id: `seed_r${r.roundNumber}_${idx}`,
        roundNumber: r.roundNumber,
        roundTitle: r.title,
        runnerType: r.runnerType || 'SCOUT',
        playerName: arch.name,
        playerColor: arch.color,
        isBot: false,
        survivalTimeSeconds,
        parTimeSeconds: r.parTimeSeconds,
        beatPar: survivalTimeSeconds >= r.parTimeSeconds,
        clapsTaken: arch.claps + Math.floor(r.roundNumber / 3),
        overchargedSpires: Math.min(r.spireCount, arch.overcharge),
        linkedKeeps: Math.min(r.obstacleCount, arch.keeps),
        pathDistance,
        goldMultiplier: 1.0,
        roomCode: 'CITADEL',
        timestamp: now - (idx + 1) * 3600_000 * 4,
      };
    });
  }

  const champions = [
    {
      playerName: 'Grandmaster Pender',
      playerColor: '#f59e0b',
      matchesWon: 14,
      roundsPlayed: 64,
      totalCareerPoints: 682,
      parStarsEarned: 52,
      bestSurvivalTime: Number((ROUNDS[7].parTimeSeconds * 1.18).toFixed(2)),
      bestRoundNumber: 8,
      lastPlayedAt: now - 3600_000 * 2,
    },
    {
      playerName: 'Elvenking',
      playerColor: '#38bdf8',
      matchesWon: 11,
      roundsPlayed: 56,
      totalCareerPoints: 540,
      parStarsEarned: 41,
      bestSurvivalTime: Number((ROUNDS[7].parTimeSeconds * 1.11).toFixed(2)),
      bestRoundNumber: 8,
      lastPlayedAt: now - 3600_000 * 5,
    },
    {
      playerName: 'Archmage Vashj',
      playerColor: '#c084fc',
      matchesWon: 8,
      roundsPlayed: 48,
      totalCareerPoints: 438,
      parStarsEarned: 33,
      bestSurvivalTime: Number((ROUNDS[6].parTimeSeconds * 1.09).toFixed(2)),
      bestRoundNumber: 7,
      lastPlayedAt: now - 3600_000 * 9,
    },
    {
      playerName: 'Warden Maiev',
      playerColor: '#34d399',
      matchesWon: 6,
      roundsPlayed: 40,
      totalCareerPoints: 355,
      parStarsEarned: 25,
      bestSurvivalTime: Number((ROUNDS[5].parTimeSeconds * 1.06).toFixed(2)),
      bestRoundNumber: 6,
      lastPlayedAt: now - 3600_000 * 14,
    },
    {
      playerName: 'Stormlord Kael',
      playerColor: '#f43f5e',
      matchesWon: 4,
      roundsPlayed: 32,
      totalCareerPoints: 270,
      parStarsEarned: 18,
      bestSurvivalTime: Number((ROUNDS[4].parTimeSeconds * 1.04).toFixed(2)),
      bestRoundNumber: 5,
      lastPlayedAt: now - 3600_000 * 20,
    },
  ];

  return {
    roundRecords,
    champions,
    updatedAt: now,
  };
}

async function startServer() {
  const app = express();
  app.use(express.json());
  const server = http.createServer(app);

  const vite = await createViteServer({
    server: { middlewareMode: true, allowedHosts: true },
    appType: 'spa',
  });

  // Load shared TypeScript game modules via Vite SSR loader
  const { ROUNDS, generateRandomRoundLayout } = await vite.ssrLoadModule(
    '/src/shared/rounds.ts'
  );
  const { TOWER_SPECS } = await vite.ssrLoadModule('/src/shared/types.ts');
  const { computeFullMazePath, validateTowerPlacement } =
    await vite.ssrLoadModule('/src/shared/pathfinding.ts');
  const { evaluateMazeRunTime } = await vite.ssrLoadModule(
    '/src/shared/simulation.ts'
  );
  const { generateMazeLayout } = await vite.ssrLoadModule(
    '/src/shared/aiBuilder.ts'
  );

  // Initialize persistent Hall of Fame Leaderboard
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }

  let leaderboard = createSeededLeaderboard(ROUNDS);
  try {
    if (fs.existsSync(LEADERBOARD_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(LEADERBOARD_FILE, 'utf-8'));
      if (parsed && parsed.roundRecords && parsed.champions) {
        leaderboard = parsed;
      }
    } else {
      fs.writeFileSync(LEADERBOARD_FILE, JSON.stringify(leaderboard, null, 2));
    }
  } catch (err) {
    console.warn('Could not read leaderboard.json, using seeded records:', err);
  }

  function saveLeaderboard() {
    leaderboard.updatedAt = Date.now();
    try {
      fs.writeFileSync(LEADERBOARD_FILE, JSON.stringify(leaderboard, null, 2));
    } catch (err) {
      console.warn('Failed to persist leaderboard.json:', err);
    }
  }

  const wss = new WebSocketServer({ server, path: '/ws' });

  /** @type {Map<string, any>} */
  const rooms = new Map();
  /** @type {Map<any, { roomCode: string; playerId: string }>} */
  const clientMap = new Map();

  function createBotPlayer(index, usedColors, difficultyOverride) {
    const preset = BOT_PRESETS[index % BOT_PRESETS.length];
    const color =
      PLAYER_COLORS.find((c) => !usedColors.has(c)) ||
      PLAYER_COLORS[index % PLAYER_COLORS.length];
    usedColors.add(color);
    return {
      id: `bot_${Math.random().toString(36).slice(2, 8)}`,
      name: `${preset.name} [AI]`,
      color,
      isBot: true,
      botDifficulty: difficultyOverride || preset.difficulty,
      botStyle: preset.style,
      isHost: false,
      ready: true,
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
    const validTotalRounds = [3, 5, 8].includes(Number(partial.totalRounds))
      ? Number(partial.totalRounds)
      : ROUNDS.length;
    const validBuildTime = [0, 30, 45, 60, 80, 90, 120, 999].includes(
      Number(partial.buildTimeSeconds)
    )
      ? Number(partial.buildTimeSeconds)
      : 0;
    const validGoldMult = [0.8, 1.0, 1.25, 1.3].includes(
      Number(partial.goldMultiplier)
    )
      ? Number(partial.goldMultiplier)
      : 1.0;
    const validBotCount =
      partial.botCount !== undefined
        ? Math.max(0, Math.min(5, Number(partial.botCount)))
        : 3;
    const validBotDiff = ['NOVICE', 'ARCHITECT', 'GRANDMASTER'].includes(
      partial.botDifficulty
    )
      ? partial.botDifficulty
      : 'ARCHITECT';

    return {
      roomName:
        (partial.roomName || '').trim().slice(0, 28) ||
        (fallbackCode === 'ARENA1'
          ? 'Highland Citadel #1'
          : `Citadel Lobby ${fallbackCode}`),
      isPublic: partial.isPublic !== undefined ? Boolean(partial.isPublic) : true,
      totalRounds: validTotalRounds,
      buildTimeSeconds: validBuildTime,
      goldMultiplier: validGoldMult,
      botCount: validBotCount,
      botDifficulty: validBotDiff,
      fogOfWar: Boolean(partial.fogOfWar),
    };
  }

  function syncRoomBots(room) {
    const humans = room.players.filter((p) => !p.isBot);
    const bots = room.players.filter((p) => p.isBot);
    const maxBotsAllowed = Math.max(0, 6 - humans.length);
    const targetBots = Math.min(maxBotsAllowed, room.settings.botCount);

    while (bots.length > targetBots) {
      const removed = bots.pop();
      const idx = room.players.findIndex((p) => p.id === removed.id);
      if (idx !== -1) room.players.splice(idx, 1);
    }

    const usedColors = new Set(room.players.map((p) => p.color));
    const basePath = computeFullMazePath(room.roundConfig, []);
    const baseDist = Number(basePath.totalDistance.toFixed(1));

    while (bots.length < targetBots) {
      const bot = createBotPlayer(
        bots.length,
        usedColors,
        room.settings.botDifficulty
      );
      bot.gold = room.roundConfig.startingGold;
      bot.pathDistance = baseDist;
      if (room.phase === 'BUILD') {
        bot._pendingBotTowers = generateMazeLayout(
          room.roundConfig,
          bot.botDifficulty,
          bot.botStyle
        );
      }
      room.players.push(bot);
      bots.push(bot);
    }

    // Ensure bot difficulties reflect room setting
    for (const b of bots) {
      if (b.botDifficulty !== room.settings.botDifficulty) {
        b.botDifficulty = room.settings.botDifficulty;
        if (room.phase === 'BUILD') {
          b.towers = [];
          b.gold = room.roundConfig.startingGold;
          b.pathDistance = baseDist;
          b.ready = false;
          b._pendingBotTowers = generateMazeLayout(
            room.roundConfig,
            b.botDifficulty,
            b.botStyle
          );
        }
      }
    }
  }

  function getOrCreateRoom(roomCode, customSettings) {
    const code = (roomCode || 'ARENA1')
      .toUpperCase()
      .replace(/[^A-Z0-9-]/g, '')
      .slice(0, 8) || 'ARENA1';

    if (rooms.has(code)) {
      const existing = rooms.get(code);
      if (customSettings && Object.keys(customSettings).length > 0) {
        existing.settings = normalizeRoomSettings(
          { ...existing.settings, ...customSettings },
          code
        );
        syncRoomBots(existing);
      }
      return existing;
    }

    const settings = normalizeRoomSettings(customSettings || {}, code);
    const round0 = generateRandomRoundLayout(ROUNDS[0]);
    const usedColors = new Set([PLAYER_COLORS[0]]);
    const initialBots = [];
    for (let i = 0; i < settings.botCount; i++) {
      initialBots.push(
        createBotPlayer(i, usedColors, settings.botDifficulty)
      );
    }

    const room = {
      roomCode: code,
      phase: 'BUILD',
      settings,
      currentRoundIndex: 0,
      roundsCompleted: 0,
      roundConfig: round0,
      phaseTimeRemaining: round0.buildTimeSeconds,
      simSpeedMultiplier: 1,
      players: [...initialBots],
      newRecordHolders: [],
      chat: [
        {
          id: `msg_${Date.now()}`,
          senderName: 'Sanctum Arbiter',
          senderColor: '#38bdf8',
          text: `Welcome to ${settings.roomName} (${code})! Place 2×2 Stone Pillars on the meadow and link Crimson Keeps to Overcharge Spires.`,
          timestamp: Date.now(),
          isSystem: true,
        },
      ],
      _runDurationTarget: 0,
      _runElapsed: 0,
    };

    rooms.set(code, room);
    prepareRoundForRoom(room, 0);
    return room;
  }

  function getPublicLobbySummaries() {
    // Ensure default ARENA1 always exists so lobby browser is never empty
    if (!rooms.has('ARENA1')) {
      getOrCreateRoom('ARENA1');
    }
    const list = [];
    for (const room of rooms.values()) {
      if (!room.settings.isPublic) continue;
      const humans = room.players.filter((p) => !p.isBot);
      const bots = room.players.filter((p) => p.isBot);
      const host =
        humans.find((p) => p.isHost) || humans[0] || room.players[0];
      list.push({
        roomCode: room.roomCode,
        roomName: room.settings.roomName || `Citadel ${room.roomCode}`,
        hostName: host ? host.name : 'Citadel Arbiter',
        phase: room.phase,
        currentRound: room.roundConfig.roundNumber,
        totalRounds: room.settings.totalRounds,
        playerCount: room.players.length,
        humanCount: humans.length,
        botCount: bots.length,
        maxPlayers: 6,
        settings: room.settings,
      });
    }
    return list.sort((a, b) => b.humanCount - a.humanCount);
  }

  function broadcastLobbyListToAll() {
    const payload = JSON.stringify({
      type: 'LOBBY_LIST',
      rooms: getPublicLobbySummaries(),
    });
    for (const ws of clientMap.keys()) {
      if (ws.readyState === 1) {
        ws.send(payload);
      }
    }
  }

  function broadcastLeaderboardToAll() {
    const payload = JSON.stringify({
      type: 'LEADERBOARD_DATA',
      leaderboard,
    });
    for (const ws of clientMap.keys()) {
      if (ws.readyState === 1) {
        ws.send(payload);
      }
    }
  }

  function sanitizeRoomStateForClient(room, viewerPlayerId) {
    const hideOpponents = room.phase === 'BUILD' && room.settings.fogOfWar;
    return {
      roomCode: room.roomCode,
      phase: room.phase,
      settings: room.settings,
      currentRoundIndex: room.currentRoundIndex,
      roundsCompleted: room.roundsCompleted || 0,
      roundConfig: room.roundConfig,
      phaseTimeRemaining: Math.ceil(room.phaseTimeRemaining),
      simSpeedMultiplier: room.simSpeedMultiplier,
      newRecordHolders: room.newRecordHolders || [],
      chat: room.chat.slice(-30),
      players: room.players.map((p) => {
        const shouldMask = hideOpponents && p.id !== viewerPlayerId;
        return {
          id: p.id,
          name: p.name,
          color: p.color,
          isBot: p.isBot,
          botDifficulty: p.botDifficulty,
          botStyle: p.botStyle,
          isHost: p.isHost,
          ready: p.ready,
          gold: p.gold,
          towers: shouldMask ? [] : p.towers,
          pathDistance: shouldMask ? 0 : p.pathDistance,
          totalScore: p.totalScore,
          lastRoundTime: p.lastRoundTime,
          lastRoundPoints: p.lastRoundPoints,
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

  function broadcastRoomState(room) {
    for (const [ws, info] of clientMap.entries()) {
      if (info.roomCode === room.roomCode && ws.readyState === 1) {
        ws.send(
          JSON.stringify({
            type: 'ROOM_STATE',
            state: sanitizeRoomStateForClient(room, info.playerId),
          })
        );
      }
    }
    broadcastLobbyListToAll();
  }

  function broadcastToRoom(room, payload) {
    const str = JSON.stringify(payload);
    for (const [ws, info] of clientMap.entries()) {
      if (info.roomCode === room.roomCode && ws.readyState === 1) {
        ws.send(str);
      }
    }
  }

  function addSystemChat(room, text) {
    const message = {
      id: `sys_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      senderName: 'Sanctum Arbiter',
      senderColor: '#38bdf8',
      text,
      timestamp: Date.now(),
      isSystem: true,
    };
    room.chat.push(message);
    if (room.chat.length > 40) room.chat.shift();
    broadcastToRoom(room, { type: 'CHAT_MESSAGE', message });
  }

  function prepareRoundForRoom(room, roundIndex) {
    const clampedIdx = Math.max(0, Math.min(ROUNDS.length - 1, roundIndex));
    const round = generateRandomRoundLayout(ROUNDS[clampedIdx]);

    // Apply room configuration overrides (Gold Multiplier & Build Timer)
    const goldMult = Number(room.settings.goldMultiplier) || 1.0;
    round.startingGold = Math.max(
      25,
      Math.round((round.startingGold * goldMult) / 5) * 5
    );
    const customBuildSecs = Number(room.settings.buildTimeSeconds) || 0;
    if (customBuildSecs > 0) {
      round.buildTimeSeconds = customBuildSecs;
    }

    room.currentRoundIndex = clampedIdx;
    room.roundConfig = round;
    room.phase = 'BUILD';
    room.phaseTimeRemaining = round.buildTimeSeconds;
    room.simSpeedMultiplier = 1;
    room.newRecordHolders = [];

    const basePath = computeFullMazePath(round, []);
    const baseDist = Number(basePath.totalDistance.toFixed(1));

    for (const p of room.players) {
      p.gold = round.startingGold;
      p.towers = [];
      p.pathDistance = baseDist;
      p.ready = false;

      if (p.isBot) {
        const planned = generateMazeLayout(
          round,
          p.botDifficulty || room.settings.botDifficulty || 'ARCHITECT',
          p.botStyle || 'SWITCHBACK'
        );
        p._pendingBotTowers = [...planned];
      }
    }

    const pillarsCount = Math.floor(
      round.startingGold / TOWER_SPECS.BLOCK.goldCost
    );
    addSystemChat(
      room,
      `Round ${round.roundNumber}: ${round.title} — ${pillarsCount} Stone Pillars · ${round.preplacedSpires.length} Elemental Spires · ${round.obstacles.length} Crimson Keeps.`
    );
    broadcastRoomState(room);
  }

  function startRunPhase(room) {
    if (room.phase === 'RUN') return;

    for (const p of room.players) {
      if (p.isBot && p._pendingBotTowers && p._pendingBotTowers.length > 0) {
        while (p._pendingBotTowers.length > 0) {
          const nextTower = p._pendingBotTowers.shift();
          applyBotTower(room, p, nextTower);
        }
      }
    }

    room.phase = 'RUN';
    room._runElapsed = 0;

    let maxRunTime = 5.0;
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

    room._runDurationTarget = maxRunTime + 1.5;
    room.phaseTimeRemaining = Math.ceil(room._runDurationTarget);

    addSystemChat(
      room,
      `Build phase locked — Runners released!`
    );
    broadcastRoomState(room);
  }

  function recordRoundToLeaderboard(room, rankedPlayers) {
    const round = room.roundConfig;
    const rNum = round.roundNumber;
    if (!leaderboard.roundRecords[rNum]) {
      leaderboard.roundRecords[rNum] = [];
    }

    const newRecordHolders = [];
    const now = Date.now();

    for (const p of rankedPlayers) {
      const cleanName = p.name.replace(/\s*\[AI\]$/i, '');
      const runTime = Number((p.lastRoundTime || 0).toFixed(2));
      const beatPar = runTime >= round.parTimeSeconds;

      // Only record meaningful runs (> 8s)
      if (runTime > 8.0) {
        const entry = {
          id: `rec_${now}_${Math.random().toString(36).slice(2, 7)}`,
          roundNumber: rNum,
          roundTitle: round.title,
          runnerType: round.runnerType || 'SCOUT',
          playerName: p.name,
          playerColor: p.color,
          isBot: p.isBot,
          survivalTimeSeconds: runTime,
          parTimeSeconds: round.parTimeSeconds,
          beatPar,
          clapsTaken: p.lastRoundClaps || 0,
          overchargedSpires: p.lastRoundOvercharge || 0,
          linkedKeeps: p.lastRoundKeeps || 0,
          pathDistance: p.pathDistance || 0,
          goldMultiplier: room.settings.goldMultiplier || 1.0,
          roomCode: room.roomCode,
          timestamp: now,
        };

        // Keep each player's personal best on this round so one player doesn't flood all 10 slots
        const existingIdx = leaderboard.roundRecords[rNum].findIndex(
          (e) => e.playerName === p.name
        );
        if (existingIdx !== -1) {
          if (
            runTime >
            leaderboard.roundRecords[rNum][existingIdx].survivalTimeSeconds
          ) {
            leaderboard.roundRecords[rNum][existingIdx] = entry;
          }
        } else {
          leaderboard.roundRecords[rNum].push(entry);
        }

        leaderboard.roundRecords[rNum].sort(
          (a, b) => b.survivalTimeSeconds - a.survivalTimeSeconds
        );
        leaderboard.roundRecords[rNum] = leaderboard.roundRecords[rNum].slice(
          0,
          12
        );

        const rankInBoard = leaderboard.roundRecords[rNum].findIndex(
          (e) => e.playerName === p.name && e.survivalTimeSeconds === runTime
        );
        if (rankInBoard !== -1 && rankInBoard < 5 && !p.isBot) {
          newRecordHolders.push(p.name);
        }
      }

      // Update Career Champions entry
      let champ = leaderboard.champions.find(
        (c) => c.playerName === cleanName || c.playerName === p.name
      );
      if (!champ) {
        champ = {
          playerName: p.name,
          playerColor: p.color,
          matchesWon: 0,
          roundsPlayed: 0,
          totalCareerPoints: 0,
          parStarsEarned: 0,
          bestSurvivalTime: 0,
          bestRoundNumber: rNum,
          lastPlayedAt: now,
        };
        leaderboard.champions.push(champ);
      }
      champ.playerColor = p.color;
      champ.roundsPlayed += 1;
      champ.totalCareerPoints += p.lastRoundPoints || 0;
      if (beatPar) champ.parStarsEarned += 1;
      if (runTime > champ.bestSurvivalTime) {
        champ.bestSurvivalTime = runTime;
        champ.bestRoundNumber = rNum;
      }
      champ.lastPlayedAt = now;
    }

    leaderboard.champions.sort(
      (a, b) =>
        b.totalCareerPoints - a.totalCareerPoints ||
        b.matchesWon - a.matchesWon ||
        b.bestSurvivalTime - a.bestSurvivalTime
    );
    leaderboard.champions = leaderboard.champions.slice(0, 20);

    saveLeaderboard();
    broadcastLeaderboardToAll();
    return newRecordHolders;
  }

  function finishRunPhaseAndScore(room) {
    if (room.phase !== 'RUN') return;
    room.roundsCompleted = (room.roundsCompleted || 0) + 1;

    const ranked = [...room.players].sort(
      (a, b) => (b._evaluatedFinishTime || 0) - (a._evaluatedFinishTime || 0)
    );

    const pointTable = [10, 7, 5, 3, 2, 1];
    ranked.forEach((p, idx) => {
      const runTime = Number((p._evaluatedFinishTime || 0).toFixed(2));
      const beatPar = runTime >= room.roundConfig.parTimeSeconds;
      let pts = pointTable[idx] ?? 1;
      if (beatPar) {
        pts += 2;
        p.parStarsEarned = (p.parStarsEarned || 0) + 1;
      }
      p.lastRoundTime = runTime;
      p.lastRoundPoints = pts;
      p.lastRoundClaps = p._evalClaps || 0;
      p.lastRoundOvercharge = p._evalOvercharge || 0;
      p.lastRoundKeeps = p._evalKeeps || 0;
      p.totalScore += pts;
      if (runTime > p.bestMazeTime) {
        p.bestMazeTime = runTime;
      }
      p.roundHistory.push({
        roundNumber: room.roundConfig.roundNumber,
        timeSeconds: runTime,
        pointsEarned: pts,
        rank: idx + 1,
        clapsTaken: p.lastRoundClaps,
        overchargedSpires: p.lastRoundOvercharge,
        linkedKeeps: p.lastRoundKeeps,
        distance: p.pathDistance,
        beatPar,
      });
    });

    const newRecordHolders = recordRoundToLeaderboard(room, ranked);
    room.newRecordHolders = newRecordHolders;

    // Check if this completed the configured Match Length
    if (room.roundsCompleted >= room.settings.totalRounds) {
      room.phase = 'GAME_OVER';
      room.phaseTimeRemaining = 0;

      const matchStandings = [...room.players].sort(
        (a, b) => b.totalScore - a.totalScore || b.bestMazeTime - a.bestMazeTime
      );
      const grandChampion = matchStandings[0];
      if (grandChampion) {
        const champEntry = leaderboard.champions.find(
          (c) => c.playerName === grandChampion.name
        );
        if (champEntry) {
          champEntry.matchesWon += 1;
          saveLeaderboard();
          broadcastLeaderboardToAll();
        }
        addSystemChat(
          room,
          `Citadel Champion: ${grandChampion.name} wins the ${room.settings.totalRounds}-Round Match with ${grandChampion.totalScore} points!`
        );
      }
    } else {
      room.phase = 'ROUND_RESULTS';
      room.phaseTimeRemaining = 15;

      const winner = ranked[0];
      if (winner) {
        addSystemChat(
          room,
          `${winner.name} wins Round ${room.roundConfig.roundNumber} with a survival time of ${winner.lastRoundTime.toFixed(2)}s (+${winner.lastRoundPoints} pts).`
        );
      }
    }

    if (newRecordHolders.length > 0) {
      addSystemChat(
        room,
        `New Hall of Fame Top-5 Record on Round ${room.roundConfig.roundNumber} by ${newRecordHolders.join(', ')}!`
      );
    }

    broadcastRoomState(room);
  }

  function applyBotTower(room, bot, plannedTower) {
    const wallCost = TOWER_SPECS.BLOCK.goldCost;
    if (bot.gold < wallCost) return;

    const check = validateTowerPlacement(
      room.roundConfig,
      bot.towers,
      plannedTower.x,
      plannedTower.y
    );
    if (check.valid && check.pathResult) {
      bot.towers.push(plannedTower);
      bot.gold -= wallCost;
      bot.pathDistance = Number(check.pathResult.totalDistance.toFixed(1));
    }
  }

  function removePlayerFromCurrentRoom(ws, currentRoom, currentPlayer) {
    if (!currentRoom || !currentPlayer) return;
    const idx = currentRoom.players.findIndex(
      (p) => p.id === currentPlayer.id
    );
    if (idx !== -1) {
      currentRoom.players.splice(idx, 1);
    }
    const remainingHuman = currentRoom.players.find((p) => !p.isBot);
    if (remainingHuman) {
      if (!currentRoom.players.some((p) => !p.isBot && p.isHost)) {
        remainingHuman.isHost = true;
      }
      addSystemChat(currentRoom, `${currentPlayer.name} left the lobby.`);
      broadcastRoomState(currentRoom);
    } else if (currentRoom.roomCode !== 'ARENA1') {
      rooms.delete(currentRoom.roomCode);
      broadcastLobbyListToAll();
    }
  }

  function joinPlayerIntoRoom(ws, room, playerName) {
    if (room.players.length >= 6) {
      const botIdx = room.players.findIndex((p) => p.isBot);
      if (botIdx !== -1) {
        room.players.splice(botIdx, 1);
      }
    }

    const usedColors = new Set(room.players.map((p) => p.color));
    const color =
      PLAYER_COLORS.find((c) => !usedColors.has(c)) ||
      PLAYER_COLORS[room.players.length % PLAYER_COLORS.length];

    const hasHost = room.players.some((p) => !p.isBot && p.isHost);
    const basePath = computeFullMazePath(room.roundConfig, []);

    const player = {
      id: `plr_${Math.random().toString(36).slice(2, 9)}`,
      name: (playerName || 'Maze Architect').trim().slice(0, 20) || 'Maze Architect',
      color,
      isBot: false,
      isHost: !hasHost,
      ready: false,
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

    const firstBotIdx = room.players.findIndex((p) => p.isBot);
    if (firstBotIdx === -1) {
      room.players.push(player);
    } else {
      room.players.splice(firstBotIdx, 0, player);
    }

    clientMap.set(ws, { roomCode: room.roomCode, playerId: player.id });

    ws.send(
      JSON.stringify({
        type: 'WELCOME',
        playerId: player.id,
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

    addSystemChat(room, `${player.name} joined ${room.settings.roomName}.`);
    broadcastRoomState(room);
    return player;
  }

  // Master 500ms server loop for timers & AI bot incremental building
  setInterval(() => {
    const dt = 0.5;
    for (const room of rooms.values()) {
      const hasHuman = room.players.some((p) => !p.isBot);
      if (!hasHuman) continue;

      if (room.phase === 'BUILD') {
        // 999 = Sandbox unlimited build time
        if (room.settings.buildTimeSeconds !== 999) {
          room.phaseTimeRemaining = Math.max(0, room.phaseTimeRemaining - dt);
        }

        let botChanged = false;
        for (const p of room.players) {
          if (p.isBot && p._pendingBotTowers) {
            if (p._pendingBotTowers.length > 0) {
              const nextTower = p._pendingBotTowers.shift();
              applyBotTower(room, p, nextTower);
              botChanged = true;
            } else if (!p.ready) {
              p.ready = true;
              botChanged = true;
            }
          }
        }

        if (botChanged && !room.settings.fogOfWar) {
          broadcastRoomState(room);
        } else if (Math.abs(room.phaseTimeRemaining % 1) < 0.01) {
          broadcastToRoom(room, {
            type: 'TIMER_TICK',
            phaseTimeRemaining: Math.ceil(room.phaseTimeRemaining),
          });
        }

        const allHumansReady = room.players
          .filter((p) => !p.isBot)
          .every((p) => p.ready);

        if (
          (room.settings.buildTimeSeconds !== 999 &&
            room.phaseTimeRemaining <= 0) ||
          (allHumansReady && room.players.some((p) => !p.isBot))
        ) {
          startRunPhase(room);
        }
      } else if (room.phase === 'RUN') {
        room._runElapsed += dt * room.simSpeedMultiplier;
        room.phaseTimeRemaining = Math.max(
          0,
          room._runDurationTarget - room._runElapsed
        );
        if (room._runElapsed >= room._runDurationTarget) {
          finishRunPhaseAndScore(room);
        }
      }
    }
  }, 500);

  // 25-second WebSocket Keep-Alive Ping for Cloud Proxies (Render, Railway, Fly.io)
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

  wss.on('connection', (ws) => {
    let currentRoom = null;
    let currentPlayer = null;

    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }

      if (msg.type === 'JOIN_ROOM') {
        if (currentRoom && currentPlayer) {
          removePlayerFromCurrentRoom(ws, currentRoom, currentPlayer);
        }
        const room = getOrCreateRoom(
          msg.roomCode || 'ARENA1',
          msg.createSettings
        );
        currentRoom = room;
        currentPlayer = joinPlayerIntoRoom(ws, room, msg.playerName);
        return;
      }

      if (msg.type === 'CREATE_ROOM') {
        if (currentRoom && currentPlayer) {
          removePlayerFromCurrentRoom(ws, currentRoom, currentPlayer);
        }
        const generatedCode =
          (msg.roomCode || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8) ||
          `CIT${Math.floor(100 + Math.random() * 899)}`;
        // If room exists, reset its settings
        if (rooms.has(generatedCode)) {
          rooms.delete(generatedCode);
        }
        const room = getOrCreateRoom(generatedCode, msg.settings || {});
        currentRoom = room;
        currentPlayer = joinPlayerIntoRoom(ws, room, msg.playerName);
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
        case 'SET_NAME': {
          const cleanName = (msg.playerName || '').trim().slice(0, 20);
          if (cleanName) {
            currentPlayer.name = cleanName;
            broadcastRoomState(currentRoom);
          }
          break;
        }

        case 'PLACE_TOWER': {
          if (currentRoom.phase !== 'BUILD') {
            ws.send(
              JSON.stringify({
                type: 'ERROR_TOAST',
                message: 'Pillars can only be placed during the Build phase.',
              })
            );
            return;
          }

          const wallCost = TOWER_SPECS.BLOCK.goldCost;
          if (currentPlayer.gold < wallCost) {
            ws.send(
              JSON.stringify({
                type: 'ERROR_TOAST',
                message: 'All Pillars placed — reclaim an existing Pillar to free one up.',
              })
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
            ws.send(
              JSON.stringify({
                type: 'ERROR_TOAST',
                message: validation.reason || 'Invalid placement!',
              })
            );
            return;
          }

          currentPlayer.towers.push({
            id: `twr_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
            type: 'BLOCK',
            x: msg.x,
            y: msg.y,
            createdAt: Date.now(),
          });
          currentPlayer.gold -= wallCost;
          currentPlayer.pathDistance = Number(
            validation.pathResult.totalDistance.toFixed(1)
          );
          currentPlayer.ready = false;

          broadcastRoomState(currentRoom);
          break;
        }

        case 'SELL_TOWER': {
          if (currentRoom.phase !== 'BUILD') return;
          const idx = currentPlayer.towers.findIndex(
            (t) => t.id === msg.towerId
          );
          if (idx === -1) return;

          currentPlayer.towers.splice(idx, 1);
          currentPlayer.gold += TOWER_SPECS.BLOCK.goldCost;
          const newPath = computeFullMazePath(
            currentRoom.roundConfig,
            currentPlayer.towers
          );
          currentPlayer.pathDistance = Number(
            newPath.totalDistance.toFixed(1)
          );
          currentPlayer.ready = false;

          broadcastRoomState(currentRoom);
          break;
        }

        case 'CLEAR_TOWERS': {
          if (currentRoom.phase !== 'BUILD') return;
          currentPlayer.towers = [];
          currentPlayer.gold = currentRoom.roundConfig.startingGold;
          const basePath = computeFullMazePath(currentRoom.roundConfig, []);
          currentPlayer.pathDistance = Number(
            basePath.totalDistance.toFixed(1)
          );
          currentPlayer.ready = false;
          broadcastRoomState(currentRoom);
          break;
        }

        case 'LOAD_PRESET_DEMO': {
          if (currentRoom.phase !== 'BUILD') return;
          const demoTowers = generateMazeLayout(
            currentRoom.roundConfig,
            'GRANDMASTER',
            'SWITCHBACK'
          );
          const spentGold = demoTowers.length * TOWER_SPECS.BLOCK.goldCost;
          currentPlayer.towers = demoTowers;
          currentPlayer.gold =
            currentRoom.roundConfig.startingGold - spentGold;
          const demoPath = computeFullMazePath(
            currentRoom.roundConfig,
            demoTowers
          );
          currentPlayer.pathDistance = Number(
            demoPath.totalDistance.toFixed(1)
          );
          broadcastRoomState(currentRoom);
          break;
        }

        case 'REROLL_MAP': {
          if (currentRoom.phase !== 'BUILD') return;
          prepareRoundForRoom(currentRoom, currentRoom.currentRoundIndex);
          break;
        }

        case 'TOGGLE_READY': {
          if (currentRoom.phase !== 'BUILD') return;
          currentPlayer.ready = !currentPlayer.ready;
          broadcastRoomState(currentRoom);

          const allHumansReady = currentRoom.players
            .filter((p) => !p.isBot)
            .every((p) => p.ready);
          if (allHumansReady) {
            startRunPhase(currentRoom);
          }
          break;
        }

        case 'NEXT_ROUND': {
          if (
            currentRoom.phase === 'GAME_OVER' ||
            (currentRoom.roundsCompleted || 0) >=
              currentRoom.settings.totalRounds
          ) {
            // Reset match from Round 1
            currentRoom.roundsCompleted = 0;
            for (const p of currentRoom.players) {
              p.totalScore = 0;
              p.lastRoundTime = null;
              p.lastRoundPoints = 0;
              p.parStarsEarned = 0;
              p.roundHistory = [];
            }
            prepareRoundForRoom(currentRoom, 0);
          } else {
            const nextIdx =
              (currentRoom.currentRoundIndex + 1) % ROUNDS.length;
            prepareRoundForRoom(currentRoom, nextIdx);
          }
          break;
        }

        case 'RESTART_MATCH': {
          currentRoom.roundsCompleted = 0;
          for (const p of currentRoom.players) {
            p.totalScore = 0;
            p.lastRoundTime = null;
            p.lastRoundPoints = 0;
            p.parStarsEarned = 0;
            p.roundHistory = [];
          }
          addSystemChat(
            currentRoom,
            `${currentPlayer.name} started a fresh ${currentRoom.settings.totalRounds}-Round Citadel Match.`
          );
          prepareRoundForRoom(currentRoom, 0);
          break;
        }

        case 'JUMP_TO_ROUND': {
          prepareRoundForRoom(currentRoom, msg.roundIndex);
          break;
        }

        case 'SET_SIM_SPEED': {
          if ([1, 2, 4].includes(msg.speed)) {
            currentRoom.simSpeedMultiplier = msg.speed;
            broadcastRoomState(currentRoom);
          }
          break;
        }

        case 'UPDATE_SETTINGS': {
          const prevSettings = { ...currentRoom.settings };
          currentRoom.settings = normalizeRoomSettings(
            { ...currentRoom.settings, ...(msg.settings || {}) },
            currentRoom.roomCode
          );

          syncRoomBots(currentRoom);

          // If in BUILD phase and goldMultiplier or buildTimeSeconds changed, apply live!
          if (currentRoom.phase === 'BUILD') {
            const baseRound = ROUNDS[currentRoom.currentRoundIndex];
            if (
              prevSettings.goldMultiplier !==
              currentRoom.settings.goldMultiplier
            ) {
              const newGold = Math.max(
                25,
                Math.round(
                  (baseRound.startingGold *
                    currentRoom.settings.goldMultiplier) /
                    5
                ) * 5
              );
              currentRoom.roundConfig.startingGold = newGold;
              const wallCost = TOWER_SPECS.BLOCK.goldCost;
              for (const p of currentRoom.players) {
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
              prevSettings.buildTimeSeconds !==
              currentRoom.settings.buildTimeSeconds
            ) {
              const targetSecs =
                currentRoom.settings.buildTimeSeconds > 0
                  ? currentRoom.settings.buildTimeSeconds
                  : baseRound.buildTimeSeconds;
              currentRoom.roundConfig.buildTimeSeconds = targetSecs;
              currentRoom.phaseTimeRemaining = targetSecs;
            }
          }

          addSystemChat(
            currentRoom,
            `${currentPlayer.name} updated match rules (${currentRoom.settings.totalRounds} Rounds · ${
              currentRoom.settings.buildTimeSeconds === 0
                ? 'Default Timer'
                : currentRoom.settings.buildTimeSeconds === 999
                ? 'Sandbox'
                : `${currentRoom.settings.buildTimeSeconds}s`
            } · ${Math.round(currentRoom.settings.goldMultiplier * 100)}% Pillars · ${
              currentRoom.settings.botCount
            } ${currentRoom.settings.botDifficulty} Bots).`
          );
          broadcastRoomState(currentRoom);
          break;
        }

        case 'ADD_BOT': {
          if (currentRoom.players.length >= 6) {
            ws.send(
              JSON.stringify({
                type: 'ERROR_TOAST',
                message: 'Arena is full (maximum 6 islands).',
              })
            );
            return;
          }
          const usedColors = new Set(currentRoom.players.map((p) => p.color));
          const bot = createBotPlayer(
            currentRoom.players.length,
            usedColors,
            msg.difficulty || currentRoom.settings.botDifficulty
          );
          bot.gold = currentRoom.roundConfig.startingGold;
          bot._pendingBotTowers = generateMazeLayout(
            currentRoom.roundConfig,
            bot.botDifficulty,
            bot.botStyle
          );
          const basePath = computeFullMazePath(currentRoom.roundConfig, []);
          bot.pathDistance = Number(basePath.totalDistance.toFixed(1));
          currentRoom.players.push(bot);
          currentRoom.settings.botCount = currentRoom.players.filter(
            (p) => p.isBot
          ).length;
          addSystemChat(currentRoom, `${bot.name} entered the arena.`);
          broadcastRoomState(currentRoom);
          break;
        }

        case 'REMOVE_BOT': {
          const botIndex = msg.botId
            ? currentRoom.players.findIndex(
                (p) => p.isBot && p.id === msg.botId
              )
            : currentRoom.players.findIndex((p) => p.isBot);
          if (botIndex !== -1) {
            const removed = currentRoom.players.splice(botIndex, 1)[0];
            currentRoom.settings.botCount = currentRoom.players.filter(
              (p) => p.isBot
            ).length;
            addSystemChat(currentRoom, `${removed.name} left the arena.`);
            broadcastRoomState(currentRoom);
          }
          break;
        }

        case 'CHAT': {
          const text = (msg.text || '').trim().slice(0, 180);
          if (!text) return;
          const chatMsg = {
            id: `chat_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
            senderName: currentPlayer.name,
            senderColor: currentPlayer.color,
            text,
            timestamp: Date.now(),
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
      clientMap.delete(ws);
      removePlayerFromCurrentRoom(ws, currentRoom, currentPlayer);
    });
  });

  // REST API Endpoints for Lobby Browser, Leaderboard & Cloud Healthchecks
  app.get('/api/health', (_req, res) => {
    res.json({
      status: 'ok',
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

  // Serve compiled static bundle in production if dist/index.html exists
  const distPath = path.join(ROOT_DIR, 'dist');
  if (
    process.env.NODE_ENV === 'production' &&
    fs.existsSync(path.join(distPath, 'index.html'))
  ) {
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  } else {
    app.use(vite.middlewares);
  }

  server.listen(PORT, () => {
    console.log(
      `\n✨ Mazing Contest 2026 Server running at http://localhost:${PORT}\n`
    );
  });
}

startServer();
