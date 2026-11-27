import {
  computeCitadelCircuitry,
  validateTowerPlacement,
} from '../shared/pathfinding.js';
import {
  computeEffectivePar,
  DEFAULT_MATCH_ROUNDS,
  generateRandomRoundLayout,
  getMapById,
  ROUNDS,
} from '../shared/rounds.js';
import { MazeRunnerSimulator, SIM_DT } from '../shared/simulation.js';
import {
  ActiveBuildTool,
  ClientToServerMessage,
  DailyMazePayload,
  getEffectiveSpireStats,
  GridPoint,
  LeaderboardPayload,
  LobbyRoomSummary,
  PlayerState,
  RoomSettings,
  RoomState,
  RUNNER_ARCHETYPES,
  RunnerSimState,
  ServerToClientMessage,
  SimEvent,
  TOWER_SPECS,
} from '../shared/types.js';
import { soundEngine } from './audio.js';
import {
  getMedalBadge,
  getRunnerIcon,
  getSpireIcon,
  hydrateStaticIcons,
  icon,
  IconName,
} from './icons.js';
import {
  Arena3DRenderer,
  HoverStatusInfo,
  InspectedWorldFeature,
} from './renderer3d.js';

type UndoEntry =
  | { kind: 'PLACE'; x: number; y: number; clientId: string; seq?: number }
  | { kind: 'SELL'; x: number; y: number; seq?: number }
  | {
      kind: 'BATCH_REPLACE';
      previousTowers: GridPoint[];
      previousUsedSampleMaze: boolean;
      seq?: number;
    };

type RedoEntry =
  | { kind: 'PLACE'; x: number; y: number }
  | { kind: 'SELL'; x: number; y: number }
  | {
      kind: 'BATCH_REPLACE';
      nextTowers: GridPoint[];
      nextUsedSampleMaze: boolean;
    };

type PendingMutation =
  | { seq: number; kind: 'PLACE'; x: number; y: number; clientId: string }
  | { seq: number; kind: 'SELL'; towerId: string; x?: number; y?: number }
  | { seq: number; kind: 'CLEAR' }
  | {
      seq: number;
      kind: 'RESTORE';
      towers: GridPoint[];
      usedSampleMaze: boolean;
    }
  | { seq: number; kind: 'SAMPLE' }
  | { seq: number; kind: 'READY'; ready: boolean };

interface ArmedButtonEntry {
  timer: number;
  restoreHtml: string;
  armedAt: number;
}

type MenuScreen =
  | 'home'
  | 'solo-setup'
  | 'online'
  | 'lobby'
  | 'daily'
  | 'how-to-play'
  | 'settings'
  | 'leaderboard';

const NAME_STORAGE_KEY = 'mc2026_player_name';
const TAB_SESSION_STORAGE_KEY = 'mc2026_tab_session_id';
const DAILY_CLIENT_ID_STORAGE_KEY = 'mc2026_daily_client_id';
const TIPS_STORAGE_KEY = 'mc2026_show_tips';

function readOrCreateDailyClientId(): string {
  const generated = `daily_${Date.now().toString(36)}_${Math.random()
    .toString(36)
    .slice(2, 12)}`;
  try {
    const existing = localStorage.getItem(DAILY_CLIENT_ID_STORAGE_KEY);
    if (existing && existing.trim().length >= 8) {
      return existing.trim();
    }
    localStorage.setItem(DAILY_CLIENT_ID_STORAGE_KEY, generated);
    return generated;
  } catch {
    return generated;
  }
}

function readShowRoundTips(): boolean {
  try {
    const raw = localStorage.getItem(TIPS_STORAGE_KEY);
    return raw === null ? true : raw !== '0';
  } catch {
    return true;
  }
}

function formatCountdownHms(msRemaining: number): string {
  const totalSec = Math.max(0, Math.floor(msRemaining / 1000));
  const hh = String(Math.floor(totalSec / 3600)).padStart(2, '0');
  const mm = String(Math.floor((totalSec % 3600) / 60)).padStart(2, '0');
  const ss = String(totalSec % 60).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

function formatDailyDateLabel(dateKey: string): string {
  const [y, m, d] = dateKey.split('-').map(Number);
  if (!y || !m || !d) return dateKey;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return (
    dt.toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      timeZone: 'UTC',
    }) + ' · UTC'
  );
}

function escapeHtml(raw: string): string {
  return raw
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatOrdinal(rank: number): string {
  if (rank === 1) return '1st';
  if (rank === 2) return '2nd';
  if (rank === 3) return '3rd';
  return `${rank}th`;
}

function formatParTarget(par: number): string {
  const rounded = Math.round(par * 10) / 10;
  return Number.isInteger(rounded) ? `${rounded}s+` : `${rounded.toFixed(1)}s+`;
}

function readOrCreateSessionId(): string {
  const generated = `sess_${Date.now().toString(36)}_${Math.random()
    .toString(36)
    .slice(2, 10)}`;
  try {
    const existing = sessionStorage.getItem(TAB_SESSION_STORAGE_KEY);
    if (existing && existing.trim().length >= 8) {
      return existing.trim();
    }
    sessionStorage.setItem(TAB_SESSION_STORAGE_KEY, generated);
    return generated;
  } catch {
    return generated;
  }
}

function readOrCreatePlayerName(): string {
  const fallback = `Player ${Math.floor(100 + Math.random() * 900)}`;
  try {
    const stored = (localStorage.getItem(NAME_STORAGE_KEY) || '').trim();
    if (!stored || /^Architect-\d+$/i.test(stored)) {
      localStorage.setItem(NAME_STORAGE_KEY, fallback);
      return fallback;
    }
    return stored.slice(0, 18);
  } catch {
    return fallback;
  }
}

function formatWallSupplyLabel(mult?: number): string {
  const m = mult ?? 1;
  if (Math.abs(m - 1) < 0.01) return 'Normal';
  return `${Math.round(m * 100)}%`;
}

function formatBotSkillLabel(
  diff?: 'NOVICE' | 'ARCHITECT' | 'GRANDMASTER'
): string {
  if (diff === 'NOVICE') return 'Easy';
  if (diff === 'GRANDMASTER') return 'Hard';
  return 'Normal';
}

class MazingContestClient {
  private renderer3d: Arena3DRenderer;
  private ws: WebSocket | null = null;
  private localPlayerId: string | null = null;
  private sessionId: string;
  private dailyClientId: string;
  private roomState: RoomState | null = null;
  private roomCode: string | null = null;
  private urlInviteRoomCode: string | null = null;
  private playerName: string;
  private showRoundTips: boolean;

  private lobbies: LobbyRoomSummary[] = [];
  private leaderboard: LeaderboardPayload | null = null;
  private dailyData: DailyMazePayload | null = null;
  private activeMenuScreen: MenuScreen = 'home';
  private leaderboardMode: 'rounds' | 'champions' = 'rounds';
  private selectedLeaderboardRound = 1;
  private roundSwitcherTab: 'match' | 'catalog' = 'match';
  private roundMapSearchQuery = '';
  private lastMatchMapSignature = '';
  private dailyCountdownInterval: number | null = null;
  private lastPlanningTickSec = -1;
  private lobbyRulesEditorOpen = false;

  private simulators = new Map<string, MazeRunnerSimulator>();
  private simAccumulator = 0;
  private runPhaseActive = false;

  private undoStack: UndoEntry[] = [];
  private redoStack: RedoEntry[] = [];
  private optSeq = 0;
  private clientSeq = 0;
  private pendingMutations: PendingMutation[] = [];
  private lastUndoRoundSignature = '';
  private sortedStandingsIds: string[] = [];

  private wsSuperseded = false;
  private pendingJoinToast: string | null = null;
  private unreadChatCount = 0;
  private lastErrorToastText = '';
  private lastErrorToastAt = 0;

  private localParAchievedThisRun = false;
  private localFinishPlayedThisRun = false;
  private lastRunDomCache = new Map<string, string>();
  private lastLobbySignature = '';
  private lastChatSignature = '';
  private lastSampleToastRoundSig = '';

  private armedTimers = new Map<HTMLElement, ArmedButtonEntry>();
  private lastPillSignature = '';
  private lastTraySignature = '';

  private lastBriefRoundSignature = '';
  private pendingRoundBrief = false;
  private briefDismissTimer: number | null = null;
  private lastCountdownTickSec = -1;

  private cachedTopHudBottom = 56;
  private cachedBottomHudInset = 84;
  private cachedTrayTop = 0;
  private insetRafPending = false;

  private nudgeHoldDelayTimer: number | null = null;
  private nudgeHoldInterval: number | null = null;

  constructor() {
    this.hydrateSingleSourceGuide();
    hydrateStaticIcons();
    this.initInputModeTracking();

    const viewport = document.getElementById('viewport-container')!;
    const labels = document.getElementById('world-labels')!;
    this.renderer3d = new Arena3DRenderer(viewport, labels);

    this.sessionId = readOrCreateSessionId();
    this.dailyClientId = readOrCreateDailyClientId();
    this.playerName = readOrCreatePlayerName();
    this.showRoundTips = readShowRoundTips();

    const urlParams = new URLSearchParams(window.location.search);
    const urlRoom = (urlParams.get('room') || '')
      .toUpperCase()
      .replace(/[^A-Z0-9-]/g, '')
      .slice(0, 8);
    this.urlInviteRoomCode = urlRoom || null;
    this.roomCode = null;

    this.syncAllNameInputs();

    // Show sunlit decorative island behind the simplified Home Screen with ZERO server room created
    this.renderMenuBackdropIsland();
    this.openMenuScreen('home');

    this.syncAudioMuteButtons();
    this.syncSettingsScreenControls();
    this.setupVisualViewportAndInsets();
    this.setupRendererCallbacks();
    this.setupUIEvents();
    this.setupHubEvents();
    this.renderRoundSelectorPills();
    this.renderLeaderboardRoundPills();
    this.syncModalOpenState();
    this.scheduleHudSafeInsetsSync();
    this.connectWebSocket();
    this.fetchInitialHubData();
    this.startDailyCountdownTicker();

    let lastTime = performance.now();
    const animate = (now: number) => {
      requestAnimationFrame(animate);
      const dt = Math.min(0.1, (now - lastTime) / 1000);
      lastTime = now;

      this.stepRunSimulation(dt);
      this.renderer3d.renderFrame(dt);
    };
    requestAnimationFrame(animate);
  }

  /**
   * Clones the single-source How to Play markup (`#codex-guide-content`)
   * into `#help-guide-content` before static SVG icon hydration.
   */
  private hydrateSingleSourceGuide() {
    const source = document.getElementById('codex-guide-content');
    const target = document.getElementById('help-guide-content');
    if (source && target) {
      target.innerHTML = source.innerHTML;
    }
  }

  private initInputModeTracking() {
    const coarse =
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(pointer: coarse)').matches;
    document.body.dataset.input = coarse ? 'touch' : 'mouse';

    window.addEventListener(
      'pointerdown',
      (e) => {
        const nextMode = e.pointerType === 'touch' ? 'touch' : 'mouse';
        if (document.body.dataset.input !== nextMode) {
          document.body.dataset.input = nextMode;
          if (nextMode === 'mouse' && this.renderer3d?.activeTool === 'PAN') {
            this.selectTool('BLOCK');
          }
          this.scheduleHudSafeInsetsSync();
        }
      },
      { passive: true, capture: true }
    );
  }

  private setupVisualViewportAndInsets() {
    const updateViewportVars = () => {
      const vv = window.visualViewport;
      const vvh = vv ? vv.height : window.innerHeight;
      const offsetTop = vv ? vv.offsetTop : 0;
      document.documentElement.style.setProperty(
        '--vvh',
        `${Math.round(vvh)}px`
      );
      document.documentElement.style.setProperty(
        '--vv-offset-top',
        `${Math.round(offsetTop)}px`
      );
      const keyboardOpen = window.innerHeight - vvh > 140;
      document.body.classList.toggle('keyboard-open', keyboardOpen);
      this.scheduleHudSafeInsetsSync();
    };

    updateViewportVars();
    window.addEventListener('resize', updateViewportVars, { passive: true });
    window.visualViewport?.addEventListener('resize', updateViewportVars, {
      passive: true,
    });
    window.visualViewport?.addEventListener('scroll', updateViewportVars, {
      passive: true,
    });
  }

  private scheduleHudSafeInsetsSync() {
    if (this.insetRafPending) return;
    this.insetRafPending = true;
    requestAnimationFrame(() => {
      this.insetRafPending = false;
      const h = window.innerHeight || 720;

      const topBar = document.getElementById('hud-top-bar');
      let topPx = 56;
      if (topBar) {
        const rect = topBar.getBoundingClientRect();
        if (rect.height > 0) {
          topPx = Math.max(36, Math.round(rect.bottom));
        }
      }

      // Measure precision tray separately for floating pill clamp WITHOUT shifting camera target
      let trayTop = h;
      const trayEl = document.getElementById('touch-precision-tray');
      if (trayEl && !trayEl.classList.contains('hidden')) {
        const tStyle = window.getComputedStyle(trayEl);
        if (tStyle.display !== 'none' && tStyle.opacity !== '0') {
          const tRect = trayEl.getBoundingClientRect();
          if (tRect.height > 0 && tRect.top < h) {
            trayTop = tRect.top;
          }
        }
      }
      this.cachedTrayTop = trayTop;

      let minBottomTop = h - 16;
      const isTouchBuild =
        document.body.dataset.input === 'touch' &&
        this.roomState?.phase === 'BUILD';

      const bottomCandidates: Array<HTMLElement | null> = [
        document.getElementById('hud-bottom-dock'),
        document.getElementById('spectator-bar'),
        document.getElementById('hud-run-dock'),
      ];
      if (!isTouchBuild) {
        bottomCandidates.push(trayEl);
      }

      const resultsModal = document.getElementById('results-modal');
      if (
        resultsModal &&
        !resultsModal.classList.contains('hidden') &&
        resultsModal.classList.contains('peek-minimized')
      ) {
        bottomCandidates.push(
          resultsModal.querySelector<HTMLElement>('.results-modal-card')
        );
      }

      for (const el of bottomCandidates) {
        if (!el || el.classList.contains('hidden')) continue;
        if (
          el.id === 'hud-bottom-dock' &&
          (el.classList.contains('dock-hidden') || this.isSpectatingRival())
        ) {
          continue;
        }
        const style = window.getComputedStyle(el);
        if (style.display === 'none' || style.opacity === '0') continue;
        const rect = el.getBoundingClientRect();
        if (rect.height > 0 && rect.top < h && rect.bottom > h * 0.45) {
          minBottomTop = Math.min(minBottomTop, rect.top);
        }
      }

      const bottomPx = Math.max(16, Math.round(h - minBottomTop + 6));
      // Live inset includes the open precision tray so ghost auto-pan / offscreen checks clear it,
      // while the framing inset stays locked (zero camera bob on tray toggle).
      const liveBottomPx =
        trayTop < h
          ? Math.max(bottomPx, Math.round(h - trayTop + 6))
          : bottomPx;
      this.cachedTopHudBottom = topPx;
      this.cachedBottomHudInset = bottomPx;
      this.renderer3d.setHudSafeInsets(topPx, bottomPx, liveBottomPx);
    });
  }

  private isHubOpen(): boolean {
    const hub = document.getElementById('home-hub-modal');
    return Boolean(hub && !hub.classList.contains('hidden'));
  }

  private isHelpOpen(): boolean {
    const help = document.getElementById('help-modal');
    return Boolean(help && !help.classList.contains('hidden'));
  }

  private isResultsBlocking(): boolean {
    const results = document.getElementById('results-modal');
    return Boolean(
      results &&
        !results.classList.contains('hidden') &&
        !results.classList.contains('peek-minimized')
    );
  }

  private syncModalOpenState() {
    const blocking =
      this.isHubOpen() || this.isHelpOpen() || this.isResultsBlocking();
    this.renderer3d.modalOpen = blocking;
    if (blocking) {
      this.hideCursorPill();
      this.hideTouchPrecisionTray();
    }
  }

  private isSpectatingRival(): boolean {
    return (
      !this.renderer3d.arenaOverviewMode &&
      this.renderer3d.focusedPlayerId !== null &&
      this.renderer3d.focusedPlayerId !== this.localPlayerId
    );
  }

  private getLocalPlayer(): PlayerState | undefined {
    if (!this.roomState || !this.localPlayerId) return undefined;
    return this.roomState.players.find((p) => p.id === this.localPlayerId);
  }

  private getHumanCount(): number {
    if (!this.roomState) return 1;
    return Math.max(
      1,
      this.roomState.players.filter((p) => !p.isBot && p.connected !== false)
        .length
    );
  }

  private canControlRoomRules(): boolean {
    const me = this.getLocalPlayer();
    if (!me) return true;
    return me.isHost || this.getHumanCount() <= 1;
  }

  // ==========================================================================
  // TWO-TAP DESTRUCTIVE-ACTION SAFETY (`3.5s` ARMED WINDOW)
  // ==========================================================================

  private disarmButton(btn: HTMLElement | null) {
    if (!btn) return;
    const entry = this.armedTimers.get(btn);
    if (!entry) return;
    window.clearTimeout(entry.timer);
    btn.classList.remove('armed-confirm');
    delete btn.dataset.armed;
    btn.innerHTML = entry.restoreHtml;
    this.armedTimers.delete(btn);
  }

  private disarmAllButtons() {
    for (const btn of Array.from(this.armedTimers.keys())) {
      this.disarmButton(btn);
    }
  }

  private armDestructiveButton(
    btn: HTMLElement,
    shouldGuard: boolean,
    confirmLabel: string,
    confirmIcon: IconName,
    onConfirm: () => void
  ) {
    if (!shouldGuard) {
      this.disarmButton(btn);
      onConfirm();
      return;
    }

    const existing = this.armedTimers.get(btn);
    if (existing) {
      // 180ms minimum bounce floor prevents synthetic touch/click double-fire from auto-confirming
      if (performance.now() - existing.armedAt < 180) {
        return;
      }
      this.disarmButton(btn);
      onConfirm();
      return;
    }

    this.disarmAllButtons();
    const restoreHtml = btn.innerHTML;
    btn.classList.add('armed-confirm');
    btn.dataset.armed = 'true';
    btn.innerHTML = `${icon(confirmIcon, 15)}<span>${escapeHtml(
      confirmLabel
    )}</span>`;
    soundEngine.playUiClick();
    soundEngine.haptic('snap');

    const timer = window.setTimeout(() => {
      this.disarmButton(btn);
    }, 3500);
    this.armedTimers.set(btn, {
      timer,
      restoreHtml,
      armedAt: performance.now(),
    });
  }

  // ==========================================================================
  // NETWORKING & LIFECYCLE
  // ==========================================================================

  private updateWsStatusPill(message: string | null) {
    const pill = document.getElementById('ws-status-pill');
    if (!pill) return;
    if (!message) {
      pill.classList.add('hidden');
      return;
    }
    pill.textContent = message;
    pill.classList.remove('hidden');
  }

  private ensureConnectedForAction(): boolean {
    if (this.wsSuperseded) {
      this.showToast('Session moved to another tab. Refresh to reconnect here.');
      return false;
    }
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.updateWsStatusPill('Reconnecting…');
      const now = performance.now();
      if (now - this.lastErrorToastAt > 1200) {
        this.lastErrorToastAt = now;
        this.showToast('Reconnecting to server…');
      }
      return false;
    }
    return true;
  }

  private nextSeq(): number {
    return ++this.clientSeq;
  }

  private async fetchInitialHubData() {
    try {
      const qs = new URLSearchParams({
        clientId: this.dailyClientId,
        playerName: this.playerName,
      });
      const [lobbiesRes, lbRes, dailyRes] = await Promise.all([
        fetch('/api/lobbies', { cache: 'no-store' }),
        fetch('/api/leaderboard', { cache: 'no-store' }),
        fetch(`/api/daily?${qs.toString()}`, { cache: 'no-store' }),
      ]);
      if (lobbiesRes.ok) {
        const data = await lobbiesRes.json();
        if (Array.isArray(data.rooms)) {
          this.lobbies = data.rooms;
          this.renderLobbyBrowser();
        }
      }
      if (lbRes.ok) {
        this.leaderboard = await lbRes.json();
        this.renderLeaderboard();
      }
      if (dailyRes.ok) {
        this.dailyData = await dailyRes.json();
        this.updateHomeDailyBadge();
        this.renderDailyScreen();
      }
    } catch {
      // WebSocket also supplies LOBBY_LIST, LEADERBOARD_DATA & DAILY_LEADERBOARD_DATA
    }
  }

  private connectWebSocket() {
    if (this.wsSuperseded) return;
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${proto}//${window.location.host}/ws`;
    this.ws = new WebSocket(wsUrl);

    this.ws.addEventListener('open', () => {
      this.updateWsStatusPill(null);
      this.send({ type: 'REQUEST_LOBBIES' });
      this.send({
        type: 'REQUEST_DAILY',
        dailyClientId: this.dailyClientId,
        playerName: this.playerName,
      });

      // Only join a room if reconnecting to an active room or explicitly invited via ?room=CODE
      if (this.roomCode && this.roomState?.mode === 'DAILY') {
        this.send({
          type: 'START_DAILY',
          playerName: this.playerName,
          sessionId: this.sessionId,
          dailyClientId: this.dailyClientId,
        });
      } else if (this.roomCode) {
        this.send({
          type: 'JOIN_ROOM',
          roomCode: this.roomCode,
          playerName: this.playerName,
          sessionId: this.sessionId,
        });
      } else if (this.urlInviteRoomCode) {
        const inviteCode = this.urlInviteRoomCode;
        this.urlInviteRoomCode = null;
        this.pendingJoinToast = `Joined room ${inviteCode}`;
        this.send({
          type: 'JOIN_ROOM',
          roomCode: inviteCode,
          playerName: this.playerName,
          sessionId: this.sessionId,
        });
      }
    });

    this.ws.addEventListener('message', (ev) => {
      let msg: ServerToClientMessage;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }

      if (msg.type === 'WELCOME') {
        this.wsSuperseded = false;
        this.updateWsStatusPill(null);
        this.localPlayerId = msg.playerId;
        if (msg.sessionId) {
          this.sessionId = msg.sessionId;
          try {
            sessionStorage.setItem(TAB_SESSION_STORAGE_KEY, msg.sessionId);
          } catch {
            // ignore
          }
        }
        this.roomCode = msg.state.roomCode;
        this.syncUrlRoomCode(
          msg.state.mode === 'ONLINE' ? this.roomCode : null
        );

        const joinToast = this.pendingJoinToast;
        this.pendingJoinToast = null;
        if (joinToast) {
          this.showToast(joinToast, true);
        }

        if (msg.state.phase === 'LOBBY') {
          this.openMenuScreen('lobby');
        } else {
          this.closeHub();
        }

        this.applyRoomState(msg.state);
        this.syncConfigFormFromSettings(msg.state.settings);
      } else if (msg.type === 'ROOM_STATE') {
        this.roomCode = msg.state.roomCode;
        this.syncUrlRoomCode(
          msg.state.mode === 'ONLINE' ? this.roomCode : null
        );
        this.applyRoomState(msg.state);
      } else if (msg.type === 'LEFT_ROOM') {
        this.handleLeftRoomCleanup();
      } else if (msg.type === 'TIMER_TICK') {
        if (this.roomState) {
          this.roomState.phaseTimeRemaining = msg.phaseTimeRemaining;
          if (typeof msg.buildTimerPaused === 'boolean') {
            this.roomState.buildTimerPaused = msg.buildTimerPaused;
          }
          if (typeof msg.runElapsed === 'number') {
            this.roomState.runElapsed = msg.runElapsed;
            this.reconcileRunDrift(msg.runElapsed);
          }
          this.updateTimerDOM(true);
          if (this.roomState.phase === 'PLANNING') {
            this.updatePlanningBannerDOM(true);
          }
          if (this.isHubOpen()) {
            this.updateHomeActiveMatchBar();
          }
          if (this.roomState.phase === 'ROUND_RESULTS') {
            this.updateResultsCountdownDOM();
          }
        }
      } else if (msg.type === 'LOBBY_LIST') {
        this.lobbies = msg.rooms;
        this.renderLobbyBrowser();
      } else if (msg.type === 'LEADERBOARD_DATA') {
        this.leaderboard = msg.leaderboard;
        this.renderLeaderboard();
      } else if (msg.type === 'DAILY_LEADERBOARD_DATA') {
        this.dailyData = msg.daily;
        this.updateHomeDailyBadge();
        this.renderDailyScreen();
        if (
          this.roomState?.mode === 'DAILY' &&
          this.roomState.phase === 'GAME_OVER'
        ) {
          this.renderRoundResultsModal(this.roomState);
        }
      } else if (msg.type === 'CHAT_MESSAGE') {
        if (this.roomState) {
          this.roomState.chat.push(msg.message);
          this.renderChat();
          const lobbyDrawer = document.getElementById('lobby-drawer');
          const drawerHidden =
            !lobbyDrawer || lobbyDrawer.classList.contains('hidden');
          if (
            this.roomState.phase !== 'LOBBY' &&
            drawerHidden &&
            !msg.message.isSystem &&
            msg.message.senderName !== this.playerName
          ) {
            this.unreadChatCount++;
            document
              .getElementById('lobby-unread-dot')
              ?.classList.remove('hidden');
          }
        }
      } else if (msg.type === 'ERROR_TOAST') {
        this.pendingJoinToast = null;
        if (!this.roomState) {
          this.syncUrlRoomCode(null);
        }
        if (typeof msg.rejectedSeq === 'number') {
          this.pendingMutations = this.pendingMutations.filter(
            (m) => m.seq !== msg.rejectedSeq
          );
          this.undoStack = this.undoStack.filter(
            (u) => u.seq !== msg.rejectedSeq
          );
        }
        if (msg.state) {
          this.applyRoomState(msg.state);
        }
        const now = performance.now();
        if (
          msg.message !== this.lastErrorToastText ||
          now - this.lastErrorToastAt > 900
        ) {
          this.lastErrorToastText = msg.message;
          this.lastErrorToastAt = now;
          soundEngine.playError();
          soundEngine.haptic('error');
          this.showToast(msg.message);
        }
      }
    });

    this.ws.addEventListener('close', (ev) => {
      if (ev.code === 4001) {
        this.wsSuperseded = true;
        this.updateWsStatusPill('Disconnected · Opened in another tab');
        return;
      }
      this.updateWsStatusPill('Reconnecting…');
      setTimeout(() => this.connectWebSocket(), 2000);
    });
  }

  private syncUrlRoomCode(code: string | null) {
    try {
      const url = new URL(window.location.href);
      if (code) {
        if (url.searchParams.get('room') !== code) {
          url.searchParams.set('room', code);
          window.history.replaceState({}, '', url.toString());
        }
      } else if (url.searchParams.has('room')) {
        url.searchParams.delete('room');
        window.history.replaceState({}, '', url.toString());
      }
    } catch {
      // ignore
    }
  }

  private send(msg: ClientToServerMessage) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  // ==========================================================================
  // TRANSIENT POPOVERS, CURSOR PILL & TOUCH PRECISION TRAY
  // ==========================================================================

  private dismissAllTransientOverlays(): boolean {
    this.disarmAllButtons();

    const roundDropdown = document.getElementById('round-dropdown');
    const standingsDropdown = document.getElementById('standings-dropdown');
    const dockToolsPopover = document.getElementById('dock-tools-popover');
    const lobbyDrawer = document.getElementById('lobby-drawer');

    const anyOpen = Boolean(
      (roundDropdown && !roundDropdown.classList.contains('hidden')) ||
        (standingsDropdown && !standingsDropdown.classList.contains('hidden')) ||
        (dockToolsPopover && !dockToolsPopover.classList.contains('hidden')) ||
        (lobbyDrawer && !lobbyDrawer.classList.contains('hidden'))
    );

    if (anyOpen) {
      roundDropdown?.classList.add('hidden');
      standingsDropdown?.classList.add('hidden');
      dockToolsPopover?.classList.add('hidden');
      lobbyDrawer?.classList.add('hidden');
      const roundBtn = document.getElementById('btn-round-picker');
      roundBtn?.classList.remove('active');
      roundBtn?.setAttribute('aria-expanded', 'false');
      const standingsBtn = document.getElementById('btn-standings-toggle');
      standingsBtn?.classList.remove('active');
      standingsBtn?.setAttribute('aria-expanded', 'false');
      const dockToolsBtn = document.getElementById('btn-dock-tools');
      dockToolsBtn?.classList.remove('active');
      dockToolsBtn?.setAttribute('aria-expanded', 'false');
      const lobbyBtn = document.getElementById('btn-toggle-lobby');
      lobbyBtn?.classList.remove('active');
      lobbyBtn?.setAttribute('aria-expanded', 'false');
    }

    return anyOpen;
  }

  private hideTransientPopovers() {
    this.disarmAllButtons();
    document.getElementById('round-dropdown')?.classList.add('hidden');
    const roundBtn = document.getElementById('btn-round-picker');
    roundBtn?.classList.remove('active');
    roundBtn?.setAttribute('aria-expanded', 'false');
    document.getElementById('standings-dropdown')?.classList.add('hidden');
    const standingsBtn = document.getElementById('btn-standings-toggle');
    standingsBtn?.classList.remove('active');
    standingsBtn?.setAttribute('aria-expanded', 'false');
    document.getElementById('dock-tools-popover')?.classList.add('hidden');
    const dockToolsBtn = document.getElementById('btn-dock-tools');
    dockToolsBtn?.classList.remove('active');
    dockToolsBtn?.setAttribute('aria-expanded', 'false');
  }

  private hideCursorPill() {
    const pill = document.getElementById('cursor-telemetry-pill');
    if (pill && !pill.classList.contains('hidden')) {
      pill.classList.add('hidden');
      pill.style.opacity = '';
    }
    this.lastPillSignature = '';
  }

  private hideTouchPrecisionTray() {
    this.stopNudgeHold();
    const tray = document.getElementById('touch-precision-tray');
    if (tray && !tray.classList.contains('hidden')) {
      tray.classList.add('hidden');
      this.lastTraySignature = '';
      this.scheduleHudSafeInsetsSync();
    }
  }

  private dismissRoundBrief() {
    if (this.briefDismissTimer !== null) {
      window.clearTimeout(this.briefDismissTimer);
      this.briefDismissTimer = null;
    }
    document.body.dataset.briefVisible = 'false';
    document.getElementById('round-brief-banner')?.classList.add('hidden');
  }

  private hidePlanningBanner() {
    document.getElementById('planning-banner')?.classList.add('hidden');
  }

  private updatePlanningBannerDOM(fromTick: boolean) {
    if (!this.roomState || this.roomState.phase !== 'PLANNING') {
      this.hidePlanningBanner();
      return;
    }
    const banner = document.getElementById('planning-banner');
    const numEl = document.getElementById('planning-countdown-num');
    const lineEl = document.getElementById('planning-round-line');
    const hintEl = document.getElementById('planning-hint-line');
    if (!banner || !numEl || !lineEl) return;

    const secs = Math.max(1, Math.ceil(this.roomState.phaseTimeRemaining));
    const round = this.roomState.roundConfig;
    const archKey = round.runnerType || 'SCOUT';
    const arch = RUNNER_ARCHETYPES[archKey];

    numEl.textContent = String(secs);
    const roundPrefix =
      this.roomState.mode === 'DAILY'
        ? round.title
        : `Round ${round.roundNumber} · ${round.title}`;
    lineEl.textContent = `${roundPrefix} · Building unlocks in ${secs}s`;
    if (hintEl) {
      hintEl.textContent = `${arch.name} · Par ${formatParTarget(
        round.parTimeSeconds
      )} — inspect Spires and Red Keeps to plan your route!`;
    }
    banner.classList.remove('hidden');

    if (fromTick && secs <= 3 && secs !== this.lastPlanningTickSec) {
      this.lastPlanningTickSec = secs;
      soundEngine.playCountdownTick(secs === 1);
    }
  }

  private triggerRoundBriefBanner() {
    if (!this.showRoundTips) return;
    if (!this.roomState || this.roomState.phase !== 'BUILD') return;
    if (this.isHubOpen()) {
      this.pendingRoundBrief = true;
      return;
    }

    this.pendingRoundBrief = false;
    const round = this.roomState.roundConfig;
    const archKey = round.runnerType || 'SCOUT';
    const arch = RUNNER_ARCHETYPES[archKey];
    const banner = document.getElementById('round-brief-banner');
    const textEl = document.getElementById('round-brief-text');
    if (!banner || !textEl) return;

    textEl.innerHTML = `
      <span class="brief-head-line">
        ${getRunnerIcon(archKey, 14)}
        <strong>${escapeHtml(arch.name)}</strong>
        <span class="brief-trait">· ${escapeHtml(arch.traitSummary)}</span>
        <span class="brief-par-chip">${icon('starFilled', 11)} Par ${escapeHtml(
          formatParTarget(round.parTimeSeconds)
        )}</span>
      </span>
      <span class="brief-hint-line">${escapeHtml(round.hint)}</span>
    `;
    document.body.dataset.briefVisible = 'true';
    banner.classList.remove('hidden');

    if (this.briefDismissTimer !== null) {
      window.clearTimeout(this.briefDismissTimer);
    }
    const holdMs = round.roundNumber === 1 ? 8500 : 6200;
    this.briefDismissTimer = window.setTimeout(() => {
      document.body.dataset.briefVisible = 'false';
      banner.classList.add('hidden');
      this.briefDismissTimer = null;
    }, holdMs);
  }

  // ==========================================================================
  // ROOM STATE APPLICATION & RUN SIMULATION
  // ==========================================================================

  private replayPendingMutationsOntoLocalPlayer(state: RoomState) {
    if (!this.localPlayerId || this.pendingMutations.length === 0) return;
    const me = state.players.find((p) => p.id === this.localPlayerId);
    if (!me) return;

    const wallCost = TOWER_SPECS.BLOCK.goldCost;
    const round = state.roundConfig;

    for (const mut of this.pendingMutations) {
      if (mut.kind === 'PLACE') {
        const exists = me.towers.some(
          (t) => t.id === mut.clientId || (t.x === mut.x && t.y === mut.y)
        );
        if (!exists && me.gold >= wallCost) {
          const check = validateTowerPlacement(round, me.towers, mut.x, mut.y);
          if (check.valid && check.pathResult) {
            me.towers.push({
              id: mut.clientId,
              type: 'BLOCK',
              x: mut.x,
              y: mut.y,
              createdAt: Date.now(),
            });
            me.gold = Math.max(0, me.gold - wallCost);
            me.pathDistance = Number(check.pathResult.totalDistance.toFixed(1));
            me.ready = false;
          }
        }
      } else if (mut.kind === 'SELL') {
        const idx = me.towers.findIndex(
          (t) =>
            t.id === mut.towerId ||
            (mut.x !== undefined &&
              mut.y !== undefined &&
              t.x === mut.x &&
              t.y === mut.y)
        );
        if (idx !== -1) {
          me.towers.splice(idx, 1);
          me.gold += wallCost;
          me.ready = false;
        }
      } else if (mut.kind === 'CLEAR') {
        me.towers = [];
        me.gold = round.startingGold;
        me.ready = false;
      } else if (mut.kind === 'RESTORE') {
        me.towers = [];
        me.gold = round.startingGold;
        me.usedSampleMaze = Boolean(me.usedSampleMaze || mut.usedSampleMaze);
        me.ready = false;
        for (const pt of mut.towers) {
          if (me.gold < wallCost) break;
          const check = validateTowerPlacement(round, me.towers, pt.x, pt.y);
          if (check.valid && check.pathResult) {
            me.towers.push({
              id: `opt_${++this.optSeq}`,
              type: 'BLOCK',
              x: pt.x,
              y: pt.y,
              createdAt: Date.now(),
            });
            me.gold = Math.max(0, me.gold - wallCost);
            me.pathDistance = Number(check.pathResult.totalDistance.toFixed(1));
          }
        }
      } else if (mut.kind === 'READY') {
        me.ready = mut.ready;
      }
    }
  }

  private applyRoomState(state: RoomState) {
    const prevPhase = this.roomState?.phase;
    this.roomState = state;
    document.body.dataset.phase = state.phase;
    document.body.dataset.mode = state.mode || 'ONLINE';

    const undoSig = `${state.roomCode}|${state.roundConfig.roundNumber}|${
      state.roundConfig.mapId ?? ''
    }|${state.roundConfig.seed ?? ''}`;
    if (state.phase !== 'BUILD' || undoSig !== this.lastUndoRoundSignature) {
      this.undoStack = [];
      this.redoStack = [];
      this.pendingMutations = [];
      this.lastUndoRoundSignature = undoSig;
      this.lastCountdownTickSec = -1;
    } else {
      const acked = state.lastAckedSeq ?? 0;
      if (acked > 0) {
        this.pendingMutations = this.pendingMutations.filter(
          (m) => m.seq > acked
        );
      }
      this.replayPendingMutationsOntoLocalPlayer(state);
    }

    // Waiting Room LOBBY phase: keep player on the Multiplayer Lobby screen
    if (state.phase === 'LOBBY') {
      this.runPhaseActive = false;
      this.hidePlanningBanner();
      this.dismissRoundBrief();
      document.getElementById('results-modal')?.classList.add('hidden');
      document.getElementById('hud-bottom-dock')?.classList.add('dock-hidden');
      document.getElementById('hud-run-dock')?.classList.add('hidden');
      this.openMenuScreen('lobby');
      this.renderWaitingLobby();
      this.renderChat();
      this.syncHostOnlyControls();
      this.renderLobbyBrowser();
      return;
    }

    // Leaving LOBBY into PLANNING/BUILD/RUN -> enter the 3D arena immediately
    if (prevPhase === 'LOBBY' && this.isHubOpen()) {
      this.closeHub();
    }

    this.renderer3d.syncRoomState(state, this.localPlayerId);
    if (state.phase === 'BUILD' && this.pendingMutations.length > 0) {
      const me = this.getLocalPlayer();
      const evalRes = this.renderer3d.getLocalMazeEval();
      if (me && evalRes) {
        me.pathDistance = Number(evalRes.distance.toFixed(1));
      }
    }

    if (state.phase === 'RUN') {
      if (prevPhase !== 'RUN' || !this.runPhaseActive) {
        this.startClientRunPhase(state);
      } else if (typeof state.runElapsed === 'number') {
        this.reconcileRunDrift(state.runElapsed);
      }
    } else {
      this.runPhaseActive = false;
    }

    // 5-second Planning Countdown before Building begins
    if (state.phase === 'PLANNING') {
      if (prevPhase !== 'PLANNING') {
        this.lastPlanningTickSec = -1;
        this.renderer3d.resetToMyIsland();
      }
      this.dismissRoundBrief();
      this.updatePlanningBannerDOM(false);
    } else {
      this.hidePlanningBanner();
    }

    // Trigger Build unlock chime & Round Brief at start of each round's BUILD phase
    if (state.phase === 'BUILD') {
      if (prevPhase === 'PLANNING') {
        soundEngine.playBuildUnlock();
        soundEngine.haptic('ready');
        this.showToast('Build phase open — place your walls!', true);
      } else if (prevPhase && prevPhase !== 'BUILD') {
        this.renderer3d.resetToMyIsland();
      }
      const briefSig = `${state.roomCode}|${state.roundConfig.roundNumber}|${
        state.roundConfig.mapId ?? ''
      }|${state.roundConfig.seed ?? ''}`;
      if (briefSig !== this.lastBriefRoundSignature) {
        this.lastBriefRoundSignature = briefSig;
        this.triggerRoundBriefBanner();
      }
      const meNow = state.players.find((p) => p.id === this.localPlayerId);
      if (meNow?.usedSampleMaze && this.lastSampleToastRoundSig !== briefSig) {
        this.lastSampleToastRoundSig = briefSig;
        this.showToast(
          'Sample Maze · Practice: this round runs unranked for you.'
        );
      }
    } else {
      this.dismissRoundBrief();
    }

    // Bottom Build Dock, Run Dock & Touch Precision Tray visibility
    const bottomDock = document.getElementById('hud-bottom-dock')!;
    const runDock = document.getElementById('hud-run-dock');
    if (state.phase === 'BUILD') {
      bottomDock.classList.remove('dock-hidden');
      runDock?.classList.add('hidden');
      if (!this.renderer3d.hasActiveTouchGhost()) {
        this.hideTouchPrecisionTray();
      }
    } else {
      bottomDock.classList.add('dock-hidden');
      document.getElementById('dock-tools-popover')?.classList.add('hidden');
      document.getElementById('btn-dock-tools')?.classList.remove('active');
      this.hideTouchPrecisionTray();
      if (state.phase !== 'RUN') {
        this.hideCursorPill();
      }
      if (state.phase === 'RUN') {
        runDock?.classList.remove('hidden');
      } else {
        runDock?.classList.add('hidden');
      }
    }

    const resultsModal = document.getElementById('results-modal')!;
    if (state.phase === 'ROUND_RESULTS' || state.phase === 'GAME_OVER') {
      if (prevPhase !== state.phase) {
        if (!this.localFinishPlayedThisRun) {
          soundEngine.playFinish();
        }
        resultsModal.classList.remove('peek-minimized');
        this.syncPeekMazesButton(false);
      }
      this.renderRoundResultsModal(state);
      resultsModal.classList.remove('hidden');
    } else {
      resultsModal.classList.add('hidden');
      resultsModal.classList.remove('peek-minimized');
      this.syncPeekMazesButton(false);
    }

    this.syncModalOpenState();
    this.syncSpectatorStateDOM();
    this.updateUndoAndToolAvailability();
    this.updateTopBarAndResources();
    this.updateScoreboardDOM();
    this.renderDrawerRoster();
    this.syncHostOnlyControls();
    this.updateHubHeroStatus();
    this.renderChat();
    this.renderLobbyBrowser();
    this.scheduleHudSafeInsetsSync();
  }

  private startClientRunPhase(state: RoomState) {
    this.simulators.clear();
    this.lastRunDomCache.clear();
    this.localParAchievedThisRun = false;
    this.localFinishPlayedThisRun = false;

    const initialElapsed = Math.max(0, state.runElapsed || 0);
    for (const p of state.players) {
      const sim = new MazeRunnerSimulator(p.id, state.roundConfig, p.towers);
      if (initialElapsed > 0.04) {
        sim.fastForwardTo(initialElapsed);
      }
      this.simulators.set(p.id, sim);
    }
    // Reconnecting mid-run past Par must not re-trigger the Par celebration
    const localSim = this.localPlayerId
      ? this.simulators.get(this.localPlayerId)
      : undefined;
    if (localSim) {
      const localSecs = localSim.state.finished
        ? localSim.state.finishTimeSeconds
        : localSim.elapsedSeconds;
      this.localParAchievedThisRun =
        initialElapsed > 0.2 && localSecs >= state.roundConfig.parTimeSeconds;
    }
    if (initialElapsed < 0.2) {
      soundEngine.playRunStart();
    }
    this.simAccumulator = 0;
    this.runPhaseActive = true;

    const stateMap = new Map<string, RunnerSimState>();
    for (const [pid, sim] of this.simulators.entries()) {
      stateMap.set(pid, sim.state);
    }
    this.renderer3d.updateRunners(stateMap, []);
    this.updateLiveRunScoreboard();
  }

  private reconcileRunDrift(serverElapsed: number) {
    if (!this.runPhaseActive || !this.roomState || serverElapsed <= 0) return;
    const smallDrifts: number[] = [];
    for (const p of this.roomState.players) {
      let sim = this.simulators.get(p.id);
      if (!sim) {
        // Mid-RUN joiner / late bot: build its simulator at the authoritative clock
        sim = new MazeRunnerSimulator(p.id, this.roomState.roundConfig, p.towers);
        sim.fastForwardTo(serverElapsed);
        this.simulators.set(p.id, sim);
        continue;
      }
      if (sim.state.finished) continue;
      const drift = serverElapsed - sim.elapsedSeconds;
      if (drift > 1.25) {
        sim.fastForwardTo(serverElapsed);
      } else if (drift < -1.25) {
        const fresh = new MazeRunnerSimulator(
          p.id,
          this.roomState.roundConfig,
          p.towers
        );
        fresh.fastForwardTo(serverElapsed);
        this.simulators.set(p.id, fresh);
      } else {
        smallDrifts.push(drift);
      }
    }
    // Shared accumulator: apply ONE symmetric slew from the mean drift (never 6x per player)
    if (smallDrifts.length > 0) {
      const meanDrift =
        smallDrifts.reduce((s, d) => s + d, 0) / smallDrifts.length;
      if (Math.abs(meanDrift) > 0.18) {
        this.simAccumulator = Math.max(
          -SIM_DT * 8,
          this.simAccumulator + meanDrift * 0.25
        );
      }
    }
  }

  private stepRunSimulation(dt: number) {
    if (
      !this.runPhaseActive ||
      !this.roomState ||
      this.roomState.phase !== 'RUN'
    ) {
      return;
    }

    const speedMult = this.roomState.simSpeedMultiplier || 1;
    this.simAccumulator += dt * speedMult;

    const allEvents: SimEvent[] = [];
    while (this.simAccumulator >= SIM_DT) {
      this.simAccumulator -= SIM_DT;
      for (const sim of this.simulators.values()) {
        if (!sim.state.finished) {
          const evs = sim.step(SIM_DT);
          allEvents.push(...evs);
        }
      }
    }

    const focusId = this.renderer3d.focusedPlayerId || this.localPlayerId;
    for (const ev of allEvents) {
      const isFocused =
        !this.renderer3d.arenaOverviewMode && ev.playerId === focusId;
      if (isFocused || this.renderer3d.arenaOverviewMode) {
        const vol = isFocused
          ? 1.0
          : ev.playerId === this.localPlayerId
          ? 0.72
          : 0.42;
        if (ev.type === 'CLAP') {
          if (ev.armoredResisted) {
            soundEngine.playArmorDeflect(vol);
          } else {
            soundEngine.playSpirePulse(
              ev.spireType || 'THUNDERCLAP',
              ev.overchargeTier || 0,
              vol
            );
          }
        } else if (ev.type === 'WAYGATE') {
          soundEngine.playChronoWarp(vol);
        } else if (ev.type === 'CHECKPOINT') {
          soundEngine.playCheckpoint(vol);
        } else if (ev.type === 'FINISH') {
          if (isFocused || ev.playerId === this.localPlayerId) {
            soundEngine.playFinish();
            this.localFinishPlayedThisRun = true;
          }
        }
      }
    }

    // Celebrate the exact moment the local/focused runner crosses the Round Par threshold
    if (!this.localParAchievedThisRun) {
      const watchId = this.localPlayerId || focusId || '';
      const watchSim = this.simulators.get(watchId);
      const parSecs = this.roomState.roundConfig.parTimeSeconds;
      const watchSecs = watchSim
        ? watchSim.state.finished
          ? watchSim.state.finishTimeSeconds
          : watchSim.elapsedSeconds
        : 0;
      if (watchSim && watchSecs >= parSecs) {
        this.localParAchievedThisRun = true;
        soundEngine.playParAchieved();
        soundEngine.haptic('ready');
        this.showToast(
          `Par achieved (${formatParTarget(parSecs)}) · +2 bonus pts`,
          true
        );
      }
    }

    const stateMap = new Map<string, RunnerSimState>();
    for (const [pid, sim] of this.simulators.entries()) {
      stateMap.set(pid, sim.state);
    }

    this.renderer3d.updateRunners(stateMap, allEvents);
    this.updateLiveRunScoreboard();
  }

  // ==========================================================================
  // OPTIMISTIC `<1ms` BUILD / REMOVE & DETERMINISTIC UNDO STACK
  // ==========================================================================

  private handleOptimisticPlaceTower(x: number, y: number) {
    if (!this.roomState || this.roomState.phase !== 'BUILD') return;
    if (!this.ensureConnectedForAction()) return;
    const me = this.getLocalPlayer();
    if (!me) return;

    const wallCost = TOWER_SPECS.BLOCK.goldCost;
    if (me.gold < wallCost) {
      const now = performance.now();
      if (now - this.lastErrorToastAt > 900) {
        this.lastErrorToastAt = now;
        soundEngine.playError();
        soundEngine.haptic('error');
        this.showToast('No walls left. Remove a wall first.');
      }
      return;
    }

    const validation = validateTowerPlacement(
      this.roomState.roundConfig,
      me.towers,
      x,
      y
    );
    if (!validation.valid || !validation.pathResult) {
      const msg = validation.reason || 'Blocked';
      const now = performance.now();
      if (msg !== this.lastErrorToastText || now - this.lastErrorToastAt > 900) {
        this.lastErrorToastText = msg;
        this.lastErrorToastAt = now;
        soundEngine.playError();
        soundEngine.haptic('error');
        this.showToast(msg);
      } else {
        soundEngine.playError();
      }
      return;
    }

    const prevOvercharge =
      this.renderer3d.getLocalMazeEval()?.overchargedSpires ??
      computeCitadelCircuitry(this.roomState.roundConfig, me.towers)
        .overchargedSpires;

    const clientId = `opt_${++this.optSeq}`;
    const seq = this.nextSeq();
    me.towers.push({
      id: clientId,
      type: 'BLOCK',
      x,
      y,
      createdAt: Date.now(),
    });
    me.gold = Math.max(0, me.gold - wallCost);
    me.pathDistance = Number(validation.pathResult.totalDistance.toFixed(1));
    me.ready = false;

    this.redoStack = [];
    this.pushUndo({ kind: 'PLACE', x, y, clientId, seq });
    this.pendingMutations.push({ seq, kind: 'PLACE', x, y, clientId });

    this.renderer3d.syncRoomState(this.roomState, this.localPlayerId);
    const nextOvercharge =
      this.renderer3d.getLocalMazeEval()?.overchargedSpires ?? prevOvercharge;
    const gainedOvercharge = Math.max(0, nextOvercharge - prevOvercharge);

    soundEngine.playBuild('BLOCK', gainedOvercharge);
    soundEngine.haptic('build');

    this.updateUndoAndToolAvailability();
    this.updateTopBarAndResources();
    this.updateScoreboardDOM();

    this.send({ type: 'PLACE_TOWER', x, y, clientId, clientSeq: seq });
  }

  private handleOptimisticSellTower(
    towerId: string,
    x?: number,
    y?: number
  ) {
    if (!this.roomState || this.roomState.phase !== 'BUILD') return;
    if (!this.ensureConnectedForAction()) return;
    const me = this.getLocalPlayer();
    if (!me) return;

    const idx = me.towers.findIndex(
      (t) =>
        t.id === towerId ||
        (x !== undefined && y !== undefined && t.x === x && t.y === y)
    );
    if (idx === -1) return;

    const [removed] = me.towers.splice(idx, 1);
    const seq = this.nextSeq();
    me.gold += TOWER_SPECS.BLOCK.goldCost;
    me.ready = false;

    this.redoStack = [];
    this.pushUndo({ kind: 'SELL', x: removed.x, y: removed.y, seq });
    this.pendingMutations.push({
      seq,
      kind: 'SELL',
      towerId: removed.id,
      x: removed.x,
      y: removed.y,
    });

    this.renderer3d.syncRoomState(this.roomState, this.localPlayerId);
    const evalRes = this.renderer3d.getLocalMazeEval();
    if (evalRes) {
      me.pathDistance = Number(evalRes.distance.toFixed(1));
    }

    soundEngine.playSell();
    soundEngine.haptic('sell');

    this.updateUndoAndToolAvailability();
    this.updateTopBarAndResources();
    this.updateScoreboardDOM();

    this.send({
      type: 'SELL_TOWER',
      towerId: removed.id,
      x: removed.x,
      y: removed.y,
      clientSeq: seq,
    });
  }

  private pushUndo(entry: UndoEntry) {
    this.undoStack.push(entry);
    if (this.undoStack.length > 64) {
      this.undoStack.shift();
    }
  }

  private pushRedo(entry: RedoEntry) {
    this.redoStack.push(entry);
    if (this.redoStack.length > 64) {
      this.redoStack.shift();
    }
  }

  private performUndo() {
    if (
      !this.roomState ||
      this.roomState.phase !== 'BUILD' ||
      this.isSpectatingRival() ||
      this.renderer3d.arenaOverviewMode ||
      this.undoStack.length === 0
    ) {
      return;
    }
    if (!this.ensureConnectedForAction()) return;
    const me = this.getLocalPlayer();
    if (!me) return;

    this.renderer3d.cancelTouchGhost();
    this.hideTouchPrecisionTray();
    this.disarmAllButtons();

    const entry = this.undoStack.pop()!;
    const wallCost = TOWER_SPECS.BLOCK.goldCost;
    const seq = this.nextSeq();

    if (entry.kind === 'PLACE') {
      const idx = me.towers.findIndex(
        (t) =>
          t.id === entry.clientId || (t.x === entry.x && t.y === entry.y)
      );
      const removedId = idx !== -1 ? me.towers[idx].id : entry.clientId;
      if (idx !== -1) {
        me.towers.splice(idx, 1);
        me.gold += wallCost;
        me.ready = false;
      }
      this.pushRedo({ kind: 'PLACE', x: entry.x, y: entry.y });
      this.pendingMutations.push({
        seq,
        kind: 'SELL',
        towerId: removedId,
        x: entry.x,
        y: entry.y,
      });
      this.renderer3d.syncRoomState(this.roomState, this.localPlayerId);
      const evalRes = this.renderer3d.getLocalMazeEval();
      if (evalRes) {
        me.pathDistance = Number(evalRes.distance.toFixed(1));
      }
      soundEngine.playSell();
      soundEngine.haptic('undo');
      this.send({
        type: 'SELL_TOWER',
        towerId: removedId,
        x: entry.x,
        y: entry.y,
        clientSeq: seq,
      });
    } else if (entry.kind === 'SELL') {
      if (me.gold >= wallCost) {
        const validation = validateTowerPlacement(
          this.roomState.roundConfig,
          me.towers,
          entry.x,
          entry.y
        );
        if (validation.valid && validation.pathResult) {
          const clientId = `opt_${++this.optSeq}`;
          me.towers.push({
            id: clientId,
            type: 'BLOCK',
            x: entry.x,
            y: entry.y,
            createdAt: Date.now(),
          });
          me.gold = Math.max(0, me.gold - wallCost);
          me.pathDistance = Number(
            validation.pathResult.totalDistance.toFixed(1)
          );
          me.ready = false;
          this.pushRedo({ kind: 'SELL', x: entry.x, y: entry.y });
          this.pendingMutations.push({
            seq,
            kind: 'PLACE',
            x: entry.x,
            y: entry.y,
            clientId,
          });
          this.renderer3d.syncRoomState(this.roomState, this.localPlayerId);
          soundEngine.playBuild('BLOCK', 0);
          soundEngine.haptic('undo');
          this.send({
            type: 'PLACE_TOWER',
            x: entry.x,
            y: entry.y,
            clientId,
            clientSeq: seq,
          });
        }
      }
    } else if (entry.kind === 'BATCH_REPLACE') {
      const round = this.roomState.roundConfig;
      const nextTowers = me.towers.map((t) => ({ x: t.x, y: t.y }));
      const nextUsedSampleMaze = Boolean(me.usedSampleMaze);
      this.pushRedo({
        kind: 'BATCH_REPLACE',
        nextTowers,
        nextUsedSampleMaze,
      });

      const stickySample = Boolean(
        me.usedSampleMaze || entry.previousUsedSampleMaze
      );
      me.towers = [];
      me.gold = round.startingGold;
      me.usedSampleMaze = stickySample;
      me.ready = false;

      for (const pt of entry.previousTowers) {
        if (me.gold < wallCost) break;
        const check = validateTowerPlacement(round, me.towers, pt.x, pt.y);
        if (check.valid && check.pathResult) {
          me.towers.push({
            id: `opt_${++this.optSeq}`,
            type: 'BLOCK',
            x: pt.x,
            y: pt.y,
            createdAt: Date.now(),
          });
          me.gold = Math.max(0, me.gold - wallCost);
          me.pathDistance = Number(check.pathResult.totalDistance.toFixed(1));
        }
      }

      this.pendingMutations.push({
        seq,
        kind: 'RESTORE',
        towers: entry.previousTowers,
        usedSampleMaze: stickySample,
      });
      this.renderer3d.syncRoomState(this.roomState, this.localPlayerId);
      const evalRes = this.renderer3d.getLocalMazeEval();
      if (evalRes) {
        me.pathDistance = Number(evalRes.distance.toFixed(1));
      }
      soundEngine.playBuild('RESTORE', 0);
      soundEngine.haptic('undo');
      this.send({
        type: 'RESTORE_TOWERS',
        towers: entry.previousTowers,
        usedSampleMaze: stickySample,
        clientSeq: seq,
      });
    }

    this.updateUndoAndToolAvailability();
    this.updateTopBarAndResources();
    this.updateScoreboardDOM();
  }

  private performRedo() {
    if (
      !this.roomState ||
      this.roomState.phase !== 'BUILD' ||
      this.isSpectatingRival() ||
      this.renderer3d.arenaOverviewMode ||
      this.redoStack.length === 0
    ) {
      return;
    }
    if (!this.ensureConnectedForAction()) return;
    const me = this.getLocalPlayer();
    if (!me) return;

    this.renderer3d.cancelTouchGhost();
    this.hideTouchPrecisionTray();
    this.disarmAllButtons();

    const entry = this.redoStack.pop()!;
    const wallCost = TOWER_SPECS.BLOCK.goldCost;
    const seq = this.nextSeq();

    if (entry.kind === 'PLACE') {
      if (me.gold >= wallCost) {
        const validation = validateTowerPlacement(
          this.roomState.roundConfig,
          me.towers,
          entry.x,
          entry.y
        );
        if (validation.valid && validation.pathResult) {
          const clientId = `opt_${++this.optSeq}`;
          me.towers.push({
            id: clientId,
            type: 'BLOCK',
            x: entry.x,
            y: entry.y,
            createdAt: Date.now(),
          });
          me.gold = Math.max(0, me.gold - wallCost);
          me.pathDistance = Number(
            validation.pathResult.totalDistance.toFixed(1)
          );
          me.ready = false;
          this.pushUndo({
            kind: 'PLACE',
            x: entry.x,
            y: entry.y,
            clientId,
            seq,
          });
          this.pendingMutations.push({
            seq,
            kind: 'PLACE',
            x: entry.x,
            y: entry.y,
            clientId,
          });
          this.renderer3d.syncRoomState(this.roomState, this.localPlayerId);
          soundEngine.playBuild('BLOCK', 0);
          soundEngine.haptic('build');
          this.send({
            type: 'PLACE_TOWER',
            x: entry.x,
            y: entry.y,
            clientId,
            clientSeq: seq,
          });
        }
      }
    } else if (entry.kind === 'SELL') {
      const idx = me.towers.findIndex(
        (t) => t.x === entry.x && t.y === entry.y
      );
      if (idx !== -1) {
        const [removed] = me.towers.splice(idx, 1);
        me.gold += wallCost;
        me.ready = false;
        this.pushUndo({ kind: 'SELL', x: removed.x, y: removed.y, seq });
        this.pendingMutations.push({
          seq,
          kind: 'SELL',
          towerId: removed.id,
          x: removed.x,
          y: removed.y,
        });
        this.renderer3d.syncRoomState(this.roomState, this.localPlayerId);
        const evalRes = this.renderer3d.getLocalMazeEval();
        if (evalRes) {
          me.pathDistance = Number(evalRes.distance.toFixed(1));
        }
        soundEngine.playSell();
        soundEngine.haptic('sell');
        this.send({
          type: 'SELL_TOWER',
          towerId: removed.id,
          x: removed.x,
          y: removed.y,
          clientSeq: seq,
        });
      }
    } else if (entry.kind === 'BATCH_REPLACE') {
      const round = this.roomState.roundConfig;
      const previousTowers = me.towers.map((t) => ({ x: t.x, y: t.y }));
      const previousUsedSampleMaze = Boolean(me.usedSampleMaze);
      this.pushUndo({
        kind: 'BATCH_REPLACE',
        previousTowers,
        previousUsedSampleMaze,
        seq,
      });

      const stickySample = Boolean(
        me.usedSampleMaze || entry.nextUsedSampleMaze
      );
      me.towers = [];
      me.gold = round.startingGold;
      me.usedSampleMaze = stickySample;
      me.ready = false;

      for (const pt of entry.nextTowers) {
        if (me.gold < wallCost) break;
        const check = validateTowerPlacement(round, me.towers, pt.x, pt.y);
        if (check.valid && check.pathResult) {
          me.towers.push({
            id: `opt_${++this.optSeq}`,
            type: 'BLOCK',
            x: pt.x,
            y: pt.y,
            createdAt: Date.now(),
          });
          me.gold = Math.max(0, me.gold - wallCost);
          me.pathDistance = Number(check.pathResult.totalDistance.toFixed(1));
        }
      }

      this.pendingMutations.push({
        seq,
        kind: 'RESTORE',
        towers: entry.nextTowers,
        usedSampleMaze: stickySample,
      });
      this.renderer3d.syncRoomState(this.roomState, this.localPlayerId);
      const evalRes = this.renderer3d.getLocalMazeEval();
      if (evalRes) {
        me.pathDistance = Number(evalRes.distance.toFixed(1));
      }
      soundEngine.playBuild('RESTORE', 0);
      soundEngine.haptic('undo');
      this.send({
        type: 'RESTORE_TOWERS',
        towers: entry.nextTowers,
        usedSampleMaze: stickySample,
        clientSeq: seq,
      });
    }

    this.updateUndoAndToolAvailability();
    this.updateTopBarAndResources();
    this.updateScoreboardDOM();
  }

  private updateUndoAndToolAvailability() {
    const me = this.getLocalPlayer();
    const canEdit =
      this.roomState?.phase === 'BUILD' &&
      !this.isSpectatingRival() &&
      !this.renderer3d.arenaOverviewMode &&
      Boolean(me);

    const undoBtn = document.getElementById(
      'btn-undo'
    ) as HTMLButtonElement | null;
    if (undoBtn) {
      undoBtn.disabled = !canEdit || this.undoStack.length === 0;
    }

    const redoBtn = document.getElementById(
      'btn-redo'
    ) as HTMLButtonElement | null;
    if (redoBtn) {
      redoBtn.disabled = !canEdit || this.redoStack.length === 0;
    }

    const clearBtn = document.getElementById(
      'btn-clear-maze'
    ) as HTMLButtonElement | null;
    if (clearBtn) {
      clearBtn.disabled = !me || me.towers.length === 0;
    }

    const rerollBtn = document.getElementById(
      'btn-reroll-map'
    ) as HTMLButtonElement | null;
    if (rerollBtn) {
      rerollBtn.disabled = !this.canControlRoomRules();
    }
  }

  // ==========================================================================
  // 3D RENDERER CALLBACKS, HOVER INSPECTION & PRECISION TOUCH TRAY
  // ==========================================================================

  private stopNudgeHold() {
    if (this.nudgeHoldDelayTimer !== null) {
      window.clearTimeout(this.nudgeHoldDelayTimer);
      this.nudgeHoldDelayTimer = null;
    }
    if (this.nudgeHoldInterval !== null) {
      window.clearInterval(this.nudgeHoldInterval);
      this.nudgeHoldInterval = null;
    }
  }

  private setupRendererCallbacks() {
    this.renderer3d.onPlaceTower = (x, y) => {
      this.handleOptimisticPlaceTower(x, y);
    };

    this.renderer3d.onSellTower = (towerId, x, y) => {
      this.handleOptimisticSellTower(towerId, x, y);
    };

    this.renderer3d.onTouchSnapChange = (_cell, valid) => {
      soundEngine.playTouchSnap();
      soundEngine.haptic(valid ? 'snap' : 'nudge');
    };

    this.renderer3d.dismissTransientUI = () => {
      return this.dismissAllTransientOverlays();
    };

    this.renderer3d.onFocusChange = () => {
      this.syncSpectatorStateDOM();
      this.updateUndoAndToolAvailability();
      this.updateScoreboardDOM();
      this.scheduleHudSafeInsetsSync();
    };

    this.renderer3d.onDesktopMouseActive = () => {
      if (document.body.dataset.input !== 'mouse') {
        document.body.dataset.input = 'mouse';
        if (this.renderer3d.activeTool === 'PAN') {
          this.selectTool('BLOCK');
        }
        this.hideTouchPrecisionTray();
        this.scheduleHudSafeInsetsSync();
      }
    };

    // Support clicking/tapping projected .island-3d-badge labels in All Islands Overview
    const worldLabels = document.getElementById('world-labels');
    worldLabels?.addEventListener('click', (e) => {
      const badge = (e.target as HTMLElement).closest(
        '.island-3d-badge'
      ) as HTMLElement | null;
      if (!badge || !this.roomState) return;
      e.stopPropagation();

      const explicitId = badge.dataset.playerId;
      const nameText = badge.querySelector('strong')?.textContent?.trim();
      const targetPlayer = explicitId
        ? this.roomState.players.find((p) => p.id === explicitId)
        : this.roomState.players.find((p) => p.name === nameText);

      if (targetPlayer) {
        this.renderer3d.cancelTouchGhost();
        this.hideTouchPrecisionTray();
        this.hideCursorPill();
        this.renderer3d.focusOnPlayerIsland(targetPlayer.id);
        this.syncSpectatorStateDOM();
        this.updateUndoAndToolAvailability();
        this.updateScoreboardDOM();
        this.scheduleHudSafeInsetsSync();
      }
    });

    // Stationary Mobile Precision Tray (#touch-precision-tray)
    const tray = document.getElementById('touch-precision-tray')!;
    tray.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
    });

    const stepNudge = (dx: number, dy: number) => {
      if (this.renderer3d.activeTool === 'SELL') {
        this.stopNudgeHold();
        return;
      }
      const moved = this.renderer3d.nudgeTouchGhost(dx, dy);
      if (!moved) {
        soundEngine.haptic('error');
        soundEngine.playEdgeBump?.();
        this.stopNudgeHold();
      }
    };

    tray
      .querySelectorAll<HTMLButtonElement>('.touch-nudge-btn')
      .forEach((btn) => {
        const dx = Number(btn.dataset.nudgeDx || 0);
        const dy = Number(btn.dataset.nudgeDy || 0);

        btn.addEventListener('pointerdown', (e) => {
          e.preventDefault();
          e.stopPropagation();
          this.stopNudgeHold();
          stepNudge(dx, dy);
          this.nudgeHoldDelayTimer = window.setTimeout(() => {
            this.nudgeHoldDelayTimer = null;
            this.nudgeHoldInterval = window.setInterval(() => {
              stepNudge(dx, dy);
            }, 85);
          }, 240);
        });

        btn.addEventListener('pointerup', () => this.stopNudgeHold());
        btn.addEventListener('pointercancel', () => this.stopNudgeHold());
        btn.addEventListener('pointerleave', () => this.stopNudgeHold());

        // Keyboard accessibility fallback (detail === 0)
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          if (e.detail === 0) {
            stepNudge(dx, dy);
          }
        });
      });

    window.addEventListener('blur', () => this.stopNudgeHold());

    document
      .getElementById('btn-touch-confirm')
      ?.addEventListener('click', (e) => {
        e.stopPropagation();
        if (!this.ensureConnectedForAction()) return;
        const confirmBtn = e.currentTarget as HTMLButtonElement | null;
        if (
          this.renderer3d.activeTool === 'SELL' &&
          !confirmBtn?.classList.contains('reclaim-action')
        ) {
          return;
        }
        const ok = this.renderer3d.confirmTouchGhost({ chainAdvance: true });
        if (ok) {
          if (!this.renderer3d.hasActiveTouchGhost()) {
            this.hideTouchPrecisionTray();
          }
        } else {
          soundEngine.playError();
          soundEngine.haptic('error');
        }
      });

    document
      .getElementById('btn-touch-cancel')
      ?.addEventListener('click', (e) => {
        e.stopPropagation();
        soundEngine.playUiClick();
        this.renderer3d.cancelTouchGhost();
        this.hideTouchPrecisionTray();
        this.hideCursorPill();
      });

    const pill = document.getElementById('cursor-telemetry-pill')!;
    pill.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('[data-dismiss-inspect]')) {
        e.stopPropagation();
        soundEngine.playUiClick();
        this.renderer3d.cancelTouchGhost();
        this.hideCursorPill();
      }
    });

    // Dismiss the mobile touch inspect card as soon as the player pans or pinches the board
    const viewportEl = document.getElementById('viewport-container');
    let inspectTouchStart: { x: number; y: number } | null = null;
    viewportEl?.addEventListener(
      'touchstart',
      (e) => {
        const t = e.touches[0];
        inspectTouchStart = t ? { x: t.clientX, y: t.clientY } : null;
      },
      { passive: true }
    );
    viewportEl?.addEventListener(
      'touchmove',
      (e) => {
        if (!pill.classList.contains('touch-inspect-card')) return;
        if (pill.classList.contains('hidden')) return;
        const t = e.touches[0];
        const movedFar =
          inspectTouchStart && t
            ? Math.hypot(
                t.clientX - inspectTouchStart.x,
                t.clientY - inspectTouchStart.y
              ) > 14
            : false;
        if (e.touches.length >= 2 || movedFar) {
          this.hideCursorPill();
        }
      },
      { passive: true }
    );

    this.renderer3d.onHoverStatusChange = (info: HoverStatusInfo) => {
      if (this.renderer3d.modalOpen || !this.roomState) {
        this.hideCursorPill();
        this.hideTouchPrecisionTray();
        return;
      }

      // 1. Mobile Clean-Tap World Feature Inspect Card (Spire, Keep, Runner, Gate)
      if (info.isTouchInspect && info.inspectedFeature && !info.offscreen) {
        if (!this.renderer3d.hasActiveTouchGhost()) {
          this.hideTouchPrecisionTray();
        }
        const cardHtml = this.renderInspectedFeatureHtml(
          info.inspectedFeature,
          true
        );
        const nextClass =
          'cursor-telemetry-pill inspect-card touch-inspect-card neutral';
        const sig = `touch-inspect|${cardHtml}`;
        if (this.lastPillSignature !== sig) {
          pill.className = nextClass;
          pill.innerHTML = cardHtml;
          this.lastPillSignature = sig;
        }
        pill.classList.remove('hidden');
        pill.style.opacity = '1';

        const pillW = pill.offsetWidth || 220;
        const pillH = pill.offsetHeight || 64;
        const minTop = this.cachedTopHudBottom + 8;
        const bottomCeil = Math.min(
          window.innerHeight - this.cachedBottomHudInset,
          this.cachedTrayTop || window.innerHeight
        );
        const maxTop = Math.max(minTop, bottomCeil - pillH - 10);

        let rawY = info.screenY - pillH - 22;
        if (rawY < minTop) {
          rawY = info.screenY + 26;
        }
        const clampedX = Math.max(
          10,
          Math.min(window.innerWidth - pillW - 10, info.screenX - pillW * 0.5)
        );
        const clampedY = Math.max(minTop, Math.min(maxTop, rawY));
        pill.style.transform = `translate3d(${Math.round(
          clampedX
        )}px, ${Math.round(clampedY)}px, 0)`;
        return;
      }

      // 2. Mobile Touch Two-Stage Precision Preview (Stationary Tray + Non-Blocking Micro-Tag)
      if (info.isTouchPreview) {
        if (this.roomState.phase !== 'BUILD' || !info.cell) {
          this.hideTouchPrecisionTray();
          this.hideCursorPill();
          return;
        }

        this.updateTouchPrecisionTrayDOM(info);

        if (info.offscreen) {
          this.hideCursorPill();
          return;
        }

        let tagTone = 'neutral';
        let tagHtml = '';

        if (info.existingTower) {
          tagTone = 'neutral';
          const dt = info.deltaTime;
          const deltaSuffix =
            typeof dt === 'number'
              ? ` · ${dt >= 0 ? '+' : ''}${dt.toFixed(1)}s`
              : '';
          tagHtml = `${icon('reclaim', 12)}<span>Remove (+1)${deltaSuffix}</span>`;
        } else if (this.renderer3d.activeTool === 'SELL') {
          tagTone = 'neutral';
          tagHtml = `${icon('reclaim', 12)}<span>Tap a wall to remove</span>`;
        } else if (info.valid) {
          const dt = info.deltaTime ?? 0;
          const dOver = info.deltaOvercharge ?? 0;
          const dKeeps = info.deltaKeeps ?? 0;
          const sign = dt >= 0 ? '+' : '';
          tagTone =
            dt > 0.05 || dOver > 0 || dKeeps > 0
              ? 'positive'
              : dt < -0.05
              ? 'negative'
              : 'neutral';
          const overPart =
            dOver > 0
              ? `<span class="overcharge-pips">+${dOver}${icon(
                  'diamondFilled',
                  10
                )}</span>`
              : dKeeps > 0
              ? `<span class="overcharge-pips">+${dKeeps} Keep</span>`
              : '';
          tagHtml = `<span>${sign}${dt.toFixed(1)}s</span>${overPart}`;
        } else {
          tagTone = 'invalid';
          tagHtml = `${icon('close', 12)}<span>${escapeHtml(
            info.reason || 'Blocked'
          )}</span>`;
        }

        const nextClass = `cursor-telemetry-pill micro-touch-tag ${tagTone}`;
        const sig = `touch-tag|${nextClass}|${tagHtml}`;
        if (this.lastPillSignature !== sig) {
          pill.className = nextClass;
          pill.innerHTML = tagHtml;
          this.lastPillSignature = sig;
        }
        pill.classList.remove('hidden');
        pill.style.opacity =
          info.isGestureMoving && !info.isLoupeDragging ? '0.55' : '1';

        const pillW = pill.offsetWidth || 104;
        const pillH = pill.offsetHeight || 28;
        const minTop = this.cachedTopHudBottom + 8;
        const bottomCeil = Math.min(
          window.innerHeight - this.cachedBottomHudInset,
          this.cachedTrayTop || window.innerHeight
        );
        const maxTop = Math.max(minTop, bottomCeil - pillH - 8);

        let rawY = info.screenY - 38 - pillH * 0.5;
        if (info.placeNearTopEdge || rawY < minTop) {
          rawY = info.screenY + 34;
        }

        const clampedX = Math.max(
          10,
          Math.min(window.innerWidth - pillW - 10, info.screenX - pillW * 0.5)
        );
        const clampedY = Math.max(minTop, Math.min(maxTop, rawY));
        pill.style.transform = `translate3d(${Math.round(
          clampedX
        )}px, ${Math.round(clampedY)}px, 0)`;
        return;
      }

      // Not in touch preview -> ensure touch tray is hidden
      if (!this.renderer3d.hasActiveTouchGhost()) {
        this.hideTouchPrecisionTray();
      }

      // 3. Desktop World Feature Inspection Card (Spire, Keep, Runner, Gate in BUILD & RUN)
      if (info.inspectedFeature && !info.offscreen) {
        const cardHtml = this.renderInspectedFeatureHtml(
          info.inspectedFeature,
          false
        );
        const nextClass = 'cursor-telemetry-pill inspect-card neutral';
        const sig = `inspect|${cardHtml}`;
        if (this.lastPillSignature !== sig) {
          pill.className = nextClass;
          pill.innerHTML = cardHtml;
          this.lastPillSignature = sig;
        }
        pill.classList.remove('hidden');
        pill.style.opacity = '1';
        this.positionDesktopFloatingPill(pill, info.screenX, info.screenY);
        return;
      }

      // 4. Desktop Build / Remove Hover Delta Pill
      if (
        !info.cell ||
        info.offscreen ||
        this.roomState.phase !== 'BUILD'
      ) {
        this.hideCursorPill();
        return;
      }

      let nextClass = 'cursor-telemetry-pill neutral';
      let nextHtml = '';

      if (info.existingTower) {
        const label =
          this.renderer3d.activeTool === 'SELL'
            ? 'Click · Remove (+1)'
            : 'Right-click · Remove (+1)';
        const dt = info.deltaTime;
        const dtSuffix =
          typeof dt === 'number'
            ? ` · ${dt >= 0 ? '+' : ''}${dt.toFixed(1)}s`
            : '';
        nextClass = 'cursor-telemetry-pill neutral';
        nextHtml = `${icon('reclaim', 13)}<span>${label}${dtSuffix}</span>`;
      } else if (this.renderer3d.activeTool === 'SELL') {
        this.hideCursorPill();
        return;
      } else if (info.valid) {
        const dt = info.deltaTime ?? 0;
        const dOver = info.deltaOvercharge ?? 0;
        const dKeeps = info.deltaKeeps ?? 0;
        const dClaps = info.deltaClaps ?? 0;
        const sign = dt >= 0 ? '+' : '';
        const tone =
          dt > 0.05 || dOver > 0 || dKeeps > 0
            ? 'positive'
            : dt < -0.05
            ? 'negative'
            : 'neutral';
        nextClass = `cursor-telemetry-pill ${tone}`;

        const synergyPart =
          dOver > 0
            ? `<span class="overcharge-pips">+${dOver}${icon(
                'diamondFilled',
                11
              )} Overcharge</span>`
            : dKeeps > 0
            ? `<span class="overcharge-pips">+${dKeeps} Keep</span>`
            : '';
        const hitsPart =
          dClaps > 0
            ? `<span>+${dClaps} ${dClaps === 1 ? 'hit' : 'hits'}</span>`
            : '';
        nextHtml = `<span>${sign}${dt.toFixed(1)}s</span>${synergyPart}${hitsPart}`;
      } else {
        nextClass = 'cursor-telemetry-pill invalid';
        nextHtml = `${icon('close', 13)}<span>${escapeHtml(
          info.reason || 'Blocked'
        )}</span>`;
      }

      const sig = `hover|${nextClass}|${nextHtml}`;
      if (this.lastPillSignature !== sig) {
        pill.className = nextClass;
        pill.innerHTML = nextHtml;
        this.lastPillSignature = sig;
      }
      pill.classList.remove('hidden');
      pill.style.opacity = '1';
      this.positionDesktopFloatingPill(pill, info.screenX, info.screenY);
    };
  }

  private positionDesktopFloatingPill(
    pill: HTMLElement,
    screenX: number,
    screenY: number
  ) {
    const pillW = pill.offsetWidth || 140;
    const pillH = pill.offsetHeight || 34;
    const minTop = this.cachedTopHudBottom + 8;
    // Clamp above the bottom dock so the pill never slides under #hud-bottom-dock
    const maxTop = Math.max(
      minTop,
      window.innerHeight - this.cachedBottomHudInset - pillH - 8
    );

    let offsetX = screenX + 18;
    if (offsetX + pillW > window.innerWidth - 12) {
      offsetX = Math.max(10, screenX - pillW - 16);
    }
    const offsetY = Math.max(minTop, Math.min(maxTop, screenY - 22));
    pill.style.transform = `translate3d(${Math.round(offsetX)}px, ${Math.round(
      offsetY
    )}px, 0)`;
  }

  private updateTouchPrecisionTrayDOM(info: HoverStatusInfo) {
    const tray = document.getElementById('touch-precision-tray');
    const confirmBtn = document.getElementById(
      'btn-touch-confirm'
    ) as HTMLButtonElement | null;
    if (!tray || !confirmBtn) return;

    const wasHidden = tray.classList.contains('hidden');
    tray.classList.remove('hidden');
    if (wasHidden) {
      this.scheduleHudSafeInsetsSync();
    }

    // In BLOCK mode keep nudges visible on an existing-wall selection (enables +2 step-over)
    const nudgeCluster = tray.querySelector<HTMLElement>('.touch-nudge-cluster');
    const hideNudges =
      this.renderer3d.activeTool === 'SELL' || Boolean(info.isTouchInspect);
    if (nudgeCluster) {
      nudgeCluster.style.display = hideNudges ? 'none' : '';
    }
    if (hideNudges) {
      this.stopNudgeHold();
    }

    let btnClass = 'touch-confirm-btn';
    let btnDisabled = false;
    let btnHtml = '';

    if (info.existingTower) {
      const dt = info.deltaTime;
      const dOver = info.deltaOvercharge ?? 0;
      const dtPart =
        typeof dt === 'number' ? ` · ${dt >= 0 ? '+' : ''}${dt.toFixed(1)}s` : '';
      const overLoss =
        dOver < 0
          ? `<span class="overcharge-pips">${dOver}${icon(
              'diamondFilled',
              11
            )}</span>`
          : '';
      btnClass = 'touch-confirm-btn reclaim-action';
      btnHtml = `${icon(
        'reclaim',
        15
      )}<span id="touch-confirm-label">Remove${dtPart}</span>${overLoss}`;
    } else if (this.renderer3d.activeTool === 'SELL') {
      btnClass = 'touch-confirm-btn invalid';
      btnDisabled = true;
      btnHtml = `${icon(
        'reclaim',
        14
      )}<span id="touch-confirm-label">Tap a wall to remove</span>`;
    } else if (info.valid) {
      const dt = info.deltaTime ?? 0;
      const dOver = info.deltaOvercharge ?? 0;
      const dKeeps = info.deltaKeeps ?? 0;
      const sign = dt >= 0 ? '+' : '';
      const overBadge =
        dOver > 0
          ? `<span class="overcharge-pips">+${dOver}${icon(
              'diamondFilled',
              11
            )}</span>`
          : dKeeps > 0
          ? `<span class="overcharge-pips">+${dKeeps} Keep</span>`
          : '';
      btnClass = 'touch-confirm-btn';
      btnHtml = `${icon(
        'pillar',
        15
      )}<span id="touch-confirm-label">Place · ${sign}${dt.toFixed(
        1
      )}s</span>${overBadge}`;
    } else {
      btnClass = 'touch-confirm-btn invalid';
      btnDisabled = true;
      btnHtml = `${icon('close', 14)}<span id="touch-confirm-label">${escapeHtml(
        info.reason || 'Blocked'
      )}</span>`;
    }

    const sig = `${hideNudges}|${btnClass}|${btnDisabled}|${btnHtml}`;
    if (this.lastTraySignature !== sig) {
      confirmBtn.className = btnClass;
      confirmBtn.disabled = btnDisabled;
      confirmBtn.innerHTML = btnHtml;
      this.lastTraySignature = sig;
    }
  }

  private renderOverchargeDiamonds(tier: number): string {
    const clamped = Math.max(0, Math.min(3, tier));
    if (clamped === 0) {
      return `<span class="inspect-meta">Uncharged</span>`;
    }
    let pips = '';
    for (let i = 0; i < clamped; i++) {
      pips += icon('diamondFilled', 11);
    }
    return `<span class="overcharge-pips" title="Overcharge Tier ${clamped}">${pips}</span>`;
  }

  private renderInspectedFeatureHtml(
    f: InspectedWorldFeature,
    isTouchInspect = false
  ): string {
    const closeBtn = isTouchInspect
      ? `<button type="button" class="inspect-dismiss-btn" data-dismiss-inspect="true" aria-label="Dismiss">${icon(
          'close',
          12
        )}</button>`
      : '';

    if (f.kind === 'SPIRE') {
      const spec = TOWER_SPECS[f.spireType];
      const pips = this.renderOverchargeDiamonds(f.overchargeTier);
      const runnerType = this.roomState?.roundConfig.runnerType || 'SCOUT';
      const eff = getEffectiveSpireStats(
        f.spireType,
        f.overchargeTier,
        runnerType
      );

      let statsLine = '';
      if (f.spireType === 'FROST_OBELISK') {
        const auraPct = Math.round(eff.auraSlowPercent * 100);
        statsLine = `${auraPct}% ring chill · ${Math.round(
          eff.slowPercent * 100
        )}% burst (${eff.slowDuration.toFixed(1)}s) / ${eff.effectiveCooldown.toFixed(
          1
        )}s · ${eff.effectiveRange.toFixed(1)}m`;
      } else if (f.spireType === 'CHRONO_SPIRE') {
        statsLine = `${Math.round(
          eff.slowPercent * 100
        )}% slow (${eff.slowDuration.toFixed(1)}s) / ${eff.effectiveCooldown.toFixed(
          1
        )}s · ${eff.effectiveRange.toFixed(2)}m · -${eff.cdrPulseSeconds.toFixed(
          1
        )}s Spire recharge`;
      } else {
        statsLine = `${Math.round(
          eff.slowPercent * 100
        )}% slow (${eff.slowDuration.toFixed(1)}s) / ${eff.effectiveCooldown.toFixed(
          1
        )}s · ${eff.effectiveRange.toFixed(1)}m`;
      }

      const isRun = this.roomState?.phase === 'RUN';
      const armorNote = eff.armoredReduced
        ? ' · Armor resists until 1◆'
        : '';
      const metaLine = isRun
        ? `Spire Hits this run: ${f.projectedOrLiveHits}${armorNote}`
        : `Projected Spire Hits: ${f.projectedOrLiveHits}${
            f.overchargeTier < 3
              ? ' · Link Crimson Keeps within 1 tile for +1◆'
              : ' · Max Overcharge'
          }${armorNote}`;

      return `
        <div class="inspect-head">
          ${getSpireIcon(f.spireType, 14)}
          <span>${escapeHtml(spec.name)}</span>
          ${pips}
          ${closeBtn}
        </div>
        <div class="inspect-sub">${escapeHtml(statsLine)}</div>
        <div class="inspect-meta">${escapeHtml(metaLine)}</div>
      `;
    }

    if (f.kind === 'KEEP') {
      const poweredCount = f.poweredSpireCount ?? 0;
      let badge = `<span class="inspect-meta">Unlinked</span>`;
      let desc =
        'Connect Stone Walls here and within 1 tile of a Spire for +1◆ Overcharge.';
      if (f.linked && poweredCount >= 1) {
        badge = `<span class="overcharge-pips">${icon(
          'diamondFilled',
          11
        )} Powering ${poweredCount} Spire${poweredCount > 1 ? 's' : ''}</span>`;
        desc = 'Granting +1◆ Overcharge tier to each connected Spire.';
      } else if (f.linked) {
        badge = `<span class="inspect-meta">Wall-linked</span>`;
        desc =
          'Connected to your walls · Extend this chain within 1 tile of a Spire for +1◆';
      }
      return `
        <div class="inspect-head">
          ${icon('keep', 14)}
          <span>Crimson Keep</span>
          ${badge}
          ${closeBtn}
        </div>
        <div class="inspect-sub">${escapeHtml(desc)}</div>
      `;
    }

    if (f.kind === 'RUNNER') {
      const arch = RUNNER_ARCHETYPES[f.archetype];
      const statusPart = f.statusLabel
        ? `<span class="inspect-meta">· ${escapeHtml(f.statusLabel)}</span>`
        : '';
      const isRunPhase = this.roomState?.phase === 'RUN';
      const subText = isRunPhase
        ? `Speed ${f.currentSpeed.toFixed(2)} m/s (base ${f.baseSpeed.toFixed(
            2
          )} m/s)`
        : arch.traitSummary;
      const traitLine = isRunPhase
        ? `<div class="inspect-meta">${escapeHtml(arch.traitSummary)}</div>`
        : '';
      return `
        <div class="inspect-head">
          ${getRunnerIcon(f.archetype, 14)}
          <span>${escapeHtml(arch.name)}</span>
          ${statusPart}
          ${closeBtn}
        </div>
        <div class="inspect-sub">${escapeHtml(subText)}</div>
        ${traitLine}
      `;
    }

    if (f.kind === 'CHECKPOINT') {
      const total = Math.max(1, f.totalCheckpoints);
      const label =
        total > 1 ? `Waystone ${f.checkpointIndex + 1} of ${total}` : 'Waystone';
      const isRun = this.roomState?.phase === 'RUN';
      const badge = isRun
        ? f.reached
          ? `<span class="overcharge-pips">${icon('check', 11)} Reached</span>`
          : `<span class="inspect-meta">Not yet reached</span>`
        : '';
      return `
        <div class="inspect-head">
          ${icon('target', 14)}
          <span>${escapeHtml(label)}</span>
          ${badge}
          ${closeBtn}
        </div>
        <div class="inspect-sub">The runner must touch every Waystone before heading to the South Shrine. Route your maze through it to add distance.</div>
      `;
    }

    if (f.kind === 'WAYGATE') {
      const roleLabel =
        f.role === 'ENTRY' ? 'Waygate · Entrance' : 'Waygate · Exit';
      const usedBadge =
        this.roomState?.phase === 'RUN' && f.used
          ? `<span class="inspect-meta">· Used</span>`
          : '';
      const desc =
        f.role === 'ENTRY'
          ? 'Warps the runner once to its paired exit. Keep it off the runner path to avoid the shortcut.'
          : 'Runners warped through the paired entrance continue from here.';
      return `
        <div class="inspect-head">
          ${icon('chrono', 14)}
          <span>${escapeHtml(roleLabel)}</span>
          ${usedBadge}
          ${closeBtn}
        </div>
        <div class="inspect-sub">${escapeHtml(desc)}</div>
      `;
    }

    // GATE
    if (f.gateType === 'SPAWN') {
      return `
        <div class="inspect-head">
          ${icon('compass', 14)}
          <span>North Gate · Entrance</span>
          ${closeBtn}
        </div>
        <div class="inspect-sub">Runners enter here and route toward the South Shrine.</div>
      `;
    }

    return `
      <div class="inspect-head">
        ${icon('flag', 14)}
        <span>South Shrine · Exit</span>
        ${closeBtn}
      </div>
      <div class="inspect-sub">Round Par ${escapeHtml(
        formatParTarget(f.parTimeSeconds)
      )} (+2 bonus pts for beating Par)</div>
    `;
  }

  // ==========================================================================
  // AUDIO, SPECTATOR BAR & HOME HUB NAVIGATION
  // ==========================================================================

  private syncAllNameInputs() {
    const ids = [
      'player-name-input',
      'hub-player-name-input',
      'settings-player-name',
    ];
    for (const id of ids) {
      const inp = document.getElementById(id) as HTMLInputElement | null;
      if (inp && inp.value !== this.playerName) {
        inp.value = this.playerName;
      }
    }
  }

  private commitPlayerName(rawVal: string) {
    const clean = rawVal.trim().slice(0, 18);
    if (clean) {
      this.playerName = clean;
      try {
        localStorage.setItem(NAME_STORAGE_KEY, clean);
      } catch {
        // ignore
      }
      this.syncAllNameInputs();
      if (this.roomState) {
        this.send({ type: 'SET_NAME', playerName: clean });
      }
      this.send({
        type: 'REQUEST_DAILY',
        dailyClientId: this.dailyClientId,
        playerName: this.playerName,
      });
    } else {
      this.syncAllNameInputs();
    }
  }

  private renderMenuBackdropIsland() {
    if (this.roomState) return;
    const randomMap =
      ROUNDS[Math.floor(Math.random() * ROUNDS.length)] || ROUNDS[0];
    const previewRound = generateRandomRoundLayout(randomMap);
    previewRound.roundNumber = 1;
    previewRound.mapId = randomMap.mapId ?? randomMap.roundNumber;
    const previewState: RoomState = {
      roomCode: 'PREVIEW',
      mode: 'SOLO',
      phase: 'LOBBY',
      settings: {
        roomName: 'Preview',
        isPublic: false,
        totalRounds: 8,
        buildTimeSeconds: 90,
        goldMultiplier: 1,
        botCount: 0,
        botDifficulty: 'ARCHITECT',
        fogOfWar: false,
      },
      currentRoundIndex: 0,
      roundsCompleted: 0,
      roundConfig: previewRound,
      phaseTimeRemaining: 0,
      simSpeedMultiplier: 1,
      players: [
        {
          id: 'preview_local',
          name: this.playerName,
          color: '#38bdf8',
          isBot: false,
          isHost: true,
          ready: false,
          gold: previewRound.startingGold,
          towers: [],
          pathDistance: 24,
          totalScore: 0,
          lastRoundTime: null,
          lastRoundPoints: 0,
          bestMazeTime: 0,
          roundHistory: [],
        },
      ],
      chat: [],
    };
    this.renderer3d.syncRoomState(previewState, 'preview_local');
  }

  private handleLeftRoomCleanup() {
    this.roomState = null;
    this.localPlayerId = null;
    this.roomCode = null;
    this.runPhaseActive = false;
    this.simulators.clear();
    this.undoStack = [];
    this.redoStack = [];
    this.pendingMutations = [];
    this.lobbyRulesEditorOpen = false;
    this.hidePlanningBanner();
    this.dismissRoundBrief();
    this.dismissAllTransientOverlays();
    document.getElementById('results-modal')?.classList.add('hidden');
    document.getElementById('hud-bottom-dock')?.classList.add('dock-hidden');
    document.getElementById('hud-run-dock')?.classList.add('hidden');
    document.getElementById('spectator-bar')?.classList.add('hidden');
    document.body.dataset.phase = 'LOBBY';
    document.body.dataset.mode = 'ONLINE';
    this.syncUrlRoomCode(null);
    this.renderMenuBackdropIsland();
    this.openMenuScreen('home');
    this.send({
      type: 'REQUEST_DAILY',
      dailyClientId: this.dailyClientId,
      playerName: this.playerName,
    });
  }

  private syncAudioMuteButtons() {
    const hudIcon = icon(soundEngine.muted ? 'volumeOff' : 'volumeOn', 18);
    const subIcon = icon(soundEngine.muted ? 'volumeOff' : 'volumeOn', 16);

    const muteBtn = document.getElementById('btn-mute');
    const muteIconSlot = document.getElementById('mute-icon-slot');
    if (muteIconSlot) muteIconSlot.innerHTML = hudIcon;
    muteBtn?.classList.toggle('active', soundEngine.muted);

    const drawerMuteBtn = document.getElementById('btn-drawer-mute');
    const drawerMuteIconSlot = document.getElementById('drawer-mute-icon-slot');
    if (drawerMuteIconSlot) drawerMuteIconSlot.innerHTML = subIcon;
    drawerMuteBtn?.classList.toggle('active', soundEngine.muted);

    const hubMuteBtn = document.getElementById('btn-hub-mute');
    const hubMuteIconSlot = document.getElementById('hub-mute-icon-slot');
    const hubMuteLabel = document.getElementById('hub-mute-label');
    if (hubMuteIconSlot) hubMuteIconSlot.innerHTML = subIcon;
    if (hubMuteLabel) {
      hubMuteLabel.textContent = soundEngine.muted ? 'Muted' : 'Sound On';
    }
    hubMuteBtn?.classList.toggle('active', soundEngine.muted);

    this.syncSettingsScreenControls();
  }

  private syncSettingsScreenControls() {
    const soundBtn = document.getElementById('settings-sound-toggle');
    if (soundBtn) {
      const soundOn = !soundEngine.muted;
      soundBtn.textContent = soundOn ? 'On' : 'Muted';
      soundBtn.classList.toggle('active', soundOn);
    }

    const volPct = Math.round(soundEngine.volume * 100);
    const slider = document.getElementById(
      'settings-volume-slider'
    ) as HTMLInputElement | null;
    if (slider) slider.value = String(volPct);
    const volVal = document.getElementById('settings-volume-value');
    if (volVal) volVal.textContent = `${volPct}%`;

    const hapticsBtn = document.getElementById('settings-haptics-toggle');
    if (hapticsBtn) {
      hapticsBtn.textContent = soundEngine.hapticsEnabled ? 'On' : 'Off';
      hapticsBtn.classList.toggle('active', soundEngine.hapticsEnabled);
    }

    const tipsBtn = document.getElementById('settings-tips-toggle');
    if (tipsBtn) {
      tipsBtn.textContent = this.showRoundTips ? 'On' : 'Off';
      tipsBtn.classList.toggle('active', this.showRoundTips);
    }
  }

  private syncSpectatorStateDOM() {
    const spectating = this.isSpectatingRival();
    document.body.dataset.spectating = spectating ? 'true' : 'false';

    const bar = document.getElementById('spectator-bar');
    const nameEl = document.getElementById('spectator-target-name');
    if (bar) {
      const phase = this.roomState?.phase;
      const showBar =
        spectating &&
        (phase === 'BUILD' ||
          phase === 'PLANNING' ||
          (phase === 'RUN' && document.body.dataset.input !== 'touch'));
      bar.classList.toggle('hidden', !showBar);
      if (showBar && nameEl && this.roomState) {
        const target = this.roomState.players.find(
          (p) => p.id === this.renderer3d.focusedPlayerId
        );
        nameEl.textContent = target ? `${target.name}'s Island` : 'Rival Island';
      }
    }
  }

  private toggleOverviewOrReturnHome() {
    if (this.roomState?.mode === 'DAILY') return;
    this.renderer3d.cancelTouchGhost();
    this.hideTouchPrecisionTray();
    this.hideCursorPill();

    const awayFromHome =
      this.renderer3d.arenaOverviewMode || this.isSpectatingRival();
    if (awayFromHome && this.localPlayerId) {
      this.renderer3d.focusOnPlayerIsland(this.localPlayerId);
    } else {
      this.renderer3d.focusArenaOverview();
    }

    this.syncSpectatorStateDOM();
    this.updateUndoAndToolAvailability();
    this.updateScoreboardDOM();
    this.scheduleHudSafeInsetsSync();
  }

  private syncPeekMazesButton(isPeeking: boolean) {
    const peekBtn = document.getElementById('btn-peek-mazes');
    if (!peekBtn) return;
    peekBtn.innerHTML = isPeeking
      ? `${icon('eyeOff', 15)}<span>Back to Results</span>`
      : `${icon('eye', 15)}<span>View Mazes</span>`;
  }

  private openMenuScreen(
    screen: MenuScreen,
    mobilePlayPane?: 'rooms' | 'setup'
  ) {
    this.activeMenuScreen = screen;
    const hub = document.getElementById('home-hub-modal');
    if (hub) {
      hub.dataset.screen = screen;
      hub.classList.remove('hidden');
    }

    const allScreens: MenuScreen[] = [
      'home',
      'solo-setup',
      'online',
      'lobby',
      'daily',
      'how-to-play',
      'settings',
      'leaderboard',
    ];
    for (const s of allScreens) {
      document
        .getElementById(`screen-${s}`)
        ?.classList.toggle('hidden', s !== screen);
    }

    if (mobilePlayPane) {
      this.setMobilePlayPane(mobilePlayPane);
    }

    document.body.dataset.inMenu = 'true';
    this.dismissAllTransientOverlays();
    this.renderer3d.cancelTouchGhost();
    this.hideTouchPrecisionTray();
    this.hideCursorPill();
    this.syncModalOpenState();

    if (screen === 'home') {
      this.updateHomeActiveMatchBar();
      this.updateHomeDailyBadge();
    } else if (screen === 'online') {
      this.send({ type: 'REQUEST_LOBBIES' });
      this.renderLobbyBrowser();
    } else if (screen === 'lobby') {
      this.renderWaitingLobby();
    } else if (screen === 'daily') {
      this.send({
        type: 'REQUEST_DAILY',
        dailyClientId: this.dailyClientId,
        playerName: this.playerName,
      });
      void this.refreshDailyFromApi();
      this.renderDailyScreen();
    } else if (screen === 'leaderboard') {
      this.renderLeaderboard();
    } else if (screen === 'settings') {
      this.syncAllNameInputs();
      this.syncSettingsScreenControls();
    }
  }

  private openHub(
    tab?: 'play' | 'leaderboard' | 'codex' | MenuScreen,
    mobilePlayPane?: 'rooms' | 'setup'
  ) {
    let target: MenuScreen = 'home';
    if (tab === 'leaderboard') target = 'leaderboard';
    else if (tab === 'codex') target = 'how-to-play';
    else if (tab === 'play') target = 'home';
    else if (tab) target = tab;

    this.openMenuScreen(target, mobilePlayPane);
    if (this.roomState) {
      this.send({ type: 'CLIENT_ARENA_ACTIVE', active: false });
    }
  }

  private closeHub() {
    if (!this.roomState || this.roomState.phase === 'LOBBY') {
      if (this.roomState?.phase === 'LOBBY') {
        this.openMenuScreen('lobby');
      } else {
        this.openMenuScreen('home');
      }
      return;
    }

    this.disarmAllButtons();
    document.getElementById('home-hub-modal')?.classList.add('hidden');
    document.body.dataset.inMenu = 'false';
    this.syncModalOpenState();
    this.send({ type: 'CLIENT_ARENA_ACTIVE', active: true });
    if (this.pendingRoundBrief) {
      this.triggerRoundBriefBanner();
    }
    this.scheduleHudSafeInsetsSync();
  }

  private setMobilePlayPane(pane: 'rooms' | 'setup') {
    const grid = document.getElementById('hub-play-grid');
    if (grid) {
      grid.dataset.mobilePane = pane;
    }
    document
      .querySelectorAll<HTMLButtonElement>('#hub-play-subtabs .subtab-pill')
      .forEach((btn) => {
        btn.classList.toggle('active', btn.dataset.playPane === pane);
      });
  }

  private updateHubHeroStatus() {
    this.updateHomeActiveMatchBar();
  }

  private updateHomeActiveMatchBar() {
    const bar = document.getElementById('home-active-match-bar');
    const textEl = document.getElementById('home-active-match-text');
    const resumeBtn = document.getElementById('btn-home-resume');
    if (!bar || !textEl) return;

    if (!this.roomState) {
      bar.classList.add('hidden');
      return;
    }

    bar.classList.remove('hidden');
    const modeLabel =
      this.roomState.mode === 'DAILY'
        ? `Daily Maze #${this.roomState.dailyPuzzleNumber || 1}`
        : this.roomState.mode === 'SOLO'
        ? 'Solo Match'
        : `Room ${this.roomState.roomCode}`;

    let statusDetail = '';
    if (this.roomState.phase === 'LOBBY') {
      statusDetail = 'Waiting in Lobby';
    } else if (this.roomState.phase === 'PLANNING') {
      statusDetail = `Planning (${Math.max(
        1,
        Math.ceil(this.roomState.phaseTimeRemaining)
      )}s)`;
    } else if (this.roomState.phase === 'BUILD') {
      statusDetail = `Round ${this.roomState.roundConfig.roundNumber} · Building`;
    } else if (this.roomState.phase === 'RUN') {
      statusDetail = `Round ${this.roomState.roundConfig.roundNumber} · Running`;
    } else {
      statusDetail = 'Results';
    }

    textEl.innerHTML = `<strong>${escapeHtml(modeLabel)}</strong> · ${escapeHtml(
      statusDetail
    )}`;
    if (resumeBtn) {
      const label =
        this.roomState.phase === 'LOBBY' ? 'Return to Lobby' : 'Resume Match';
      resumeBtn.innerHTML = `${icon('play', 14)}<span>${label}</span>`;
    }
  }

  private updateHomeDailyBadge() {
    const badge = document.getElementById('home-daily-badge');
    if (!badge) return;
    if (!this.dailyData) {
      badge.textContent = 'Daily Challenge';
      badge.classList.remove('completed');
      return;
    }
    if (this.dailyData.completedToday && this.dailyData.myStanding) {
      badge.textContent = `Rank #${this.dailyData.myStanding.rank} / ${this.dailyData.totalParticipants}`;
      badge.classList.add('completed');
    } else {
      badge.textContent = `Daily #${this.dailyData.puzzleNumber}`;
      badge.classList.remove('completed');
    }
  }

  private startDailyCountdownTicker() {
    if (this.dailyCountdownInterval !== null) {
      window.clearInterval(this.dailyCountdownInterval);
    }
    const tick = () => {
      const el = document.getElementById('daily-reset-countdown');
      if (!el || !this.dailyData) return;
      const msLeft = Math.max(0, this.dailyData.resetsAtUtcMs - Date.now());
      el.textContent = `Next maze in ${formatCountdownHms(msLeft)}`;
      if (msLeft === 0) {
        this.send({
          type: 'REQUEST_DAILY',
          dailyClientId: this.dailyClientId,
          playerName: this.playerName,
        });
      }
    };
    tick();
    this.dailyCountdownInterval = window.setInterval(tick, 1000);
  }

  private renderDailyLeaderboardRows(
    container: HTMLElement,
    daily: DailyMazePayload
  ) {
    container.innerHTML = '';
    if (!daily.top10 || daily.top10.length === 0) {
      container.innerHTML = `<div class="daily-empty-note">No scores yet today. Be the very first to set the pace!</div>`;
      return;
    }

    const head = document.createElement('div');
    head.className = 'lb-table-head daily-lb-head';
    head.innerHTML = `
      <div>Rank</div>
      <div>Player</div>
      <div>Time</div>
      <div class="lb-synergies">Maze Stats</div>
    `;
    container.appendChild(head);

    daily.top10.forEach((rec, idx) => {
      const rank = rec.rank || idx + 1;
      const isMe =
        rec.clientId === this.dailyClientId ||
        Boolean(daily.myStanding && daily.myStanding.entry.id === rec.id);
      const row = document.createElement('div');
      const rankClass = rank <= 3 ? ` rank-${rank}` : '';
      row.className = `lb-row daily-lb-row${rankClass}${isMe ? ' is-me' : ''}`;

      const rankBadge =
        rank <= 3
          ? getMedalBadge(rank as 1 | 2 | 3, 22)
          : `<span>#${rank}</span>`;
      const parBadge = rec.beatPar
        ? `<span class="par-pill">${icon('starFilled', 10)}<span>Par</span></span>`
        : '';
      const youBadge = isMe ? `<span class="you-badge">You</span>` : '';

      row.innerHTML = `
        <div class="lb-rank">${rankBadge}</div>
        <div class="lb-architect">
          <span class="player-swatch" style="background:${escapeHtml(
            rec.playerColor
          )}"></span>
          <span class="lb-name">${escapeHtml(rec.playerName)}</span>
          ${youBadge}
        </div>
        <div class="lb-time-primary">
          <span>${rec.survivalTimeSeconds.toFixed(2)}s</span>
          ${parBadge}
        </div>
        <div class="lb-synergies">
          <span class="stat-chip" title="Spire Hits">${icon('bolt', 12)} ${
        rec.clapsTaken
      }</span>
          <span class="stat-chip" title="Overcharge">${icon(
            'diamondFilled',
            11
          )} ${rec.overchargedSpires}</span>
          <span class="stat-chip" title="Path Length">${rec.pathDistance.toFixed(
            0
          )}m</span>
        </div>
      `;
      container.appendChild(row);
    });
  }

  private async refreshDailyFromApi() {
    try {
      const qs = new URLSearchParams({
        clientId: this.dailyClientId,
        playerName: this.playerName,
      });
      const res = await fetch(`/api/daily?${qs.toString()}`, {
        cache: 'no-store',
      });
      if (res.ok) {
        this.dailyData = await res.json();
        this.updateHomeDailyBadge();
        this.renderDailyScreen();
      }
    } catch {
      // ignore transient network errors
    }
  }

  private renderDailyScreen() {
    const titleEl = document.getElementById('daily-screen-title');
    const dateEl = document.getElementById('daily-screen-date');
    const countdownEl = document.getElementById('daily-reset-countdown');
    const puzzleNameEl = document.getElementById('daily-puzzle-name');
    const specsEl = document.getElementById('daily-puzzle-specs');
    const hintEl = document.getElementById('daily-puzzle-hint');
    const ctaArea = document.getElementById('daily-cta-area');
    const countBadge = document.getElementById('daily-participants-badge');
    const tableWrap = document.getElementById('daily-leaderboard-table');
    const standingBar = document.getElementById('daily-my-standing-bar');

    if (!this.dailyData) {
      if (tableWrap) {
        tableWrap.innerHTML = `<div class="daily-empty-note">Loading today's Daily Maze…</div>`;
      }
      return;
    }

    const d = this.dailyData;
    const p = d.puzzle;
    const arch = RUNNER_ARCHETYPES[p.runnerType || 'SCOUT'];

    if (titleEl) titleEl.textContent = `Daily Maze #${d.puzzleNumber}`;
    if (dateEl) dateEl.textContent = formatDailyDateLabel(d.dateKey);
    if (countdownEl) {
      countdownEl.textContent = `Next maze in ${formatCountdownHms(
        Math.max(0, d.resetsAtUtcMs - Date.now())
      )}`;
    }
    if (puzzleNameEl) puzzleNameEl.textContent = p.title;
    if (hintEl) hintEl.textContent = p.hint;
    if (specsEl) {
      specsEl.innerHTML = `
        <span class="meta-pill">${getRunnerIcon(p.runnerType, 13)} ${escapeHtml(
        arch.name
      )}</span>
        <span class="meta-pill">${icon('pillar', 13)} ${p.wallCount} Walls</span>
        <span class="meta-pill">${icon('bolt', 13)} ${p.spireCount} Spires</span>
        <span class="meta-pill">${icon('keep', 13)} ${p.keepCount} Keeps</span>
        ${
          p.hasWaystone
            ? `<span class="meta-pill">${icon('target', 13)} Waystone</span>`
            : ''
        }
        <span class="par-pill">${icon('starFilled', 11)} Par ${escapeHtml(
        formatParTarget(p.parTimeSeconds)
      )}</span>
      `;
    }

    if (countBadge) {
      countBadge.textContent = `${d.totalParticipants} ${
        d.totalParticipants === 1 ? 'Player' : 'Players'
      }`;
    }

    if (ctaArea) {
      if (d.completedToday && d.myStanding) {
        const s = d.myStanding;
        ctaArea.innerHTML = `
          <div class="daily-completed-box">
            <div class="daily-completed-head">
              <span class="meta-pill daily-done-pill">${icon('check', 13)} Completed Today</span>
              <strong>${s.entry.survivalTimeSeconds.toFixed(2)}s</strong>
              ${
                s.entry.beatPar
                  ? `<span class="par-pill">${icon('starFilled', 11)} Beat Par</span>`
                  : ''
              }
            </div>
            <p class="daily-completed-sub">
              You placed <strong>#${s.rank} of ${s.totalParticipants}</strong> (Top ${
          s.percentile
        }%). A new maze unlocks at midnight UTC!
            </p>
            <button type="button" id="btn-daily-share" class="dock-ready-btn daily-play-cta">
              ${icon('share', 15)}<span>Share Result</span>
            </button>
          </div>
        `;
        document
          .getElementById('btn-daily-share')
          ?.addEventListener('click', () => {
            soundEngine.playUiClick();
            this.shareDailyResult();
          });
      } else {
        ctaArea.innerHTML = `
          <button type="button" id="btn-start-daily" class="dock-ready-btn daily-play-cta">
            ${icon('play', 15)}<span>Play Today's Maze</span>
          </button>
        `;
        document
          .getElementById('btn-start-daily')
          ?.addEventListener('click', () => {
            if (!this.ensureConnectedForAction()) return;
            soundEngine.playUiClick();
            this.pendingJoinToast = `Daily Maze #${d.puzzleNumber} — 5s to plan!`;
            this.send({
              type: 'START_DAILY',
              playerName: this.playerName,
              sessionId: this.sessionId,
              dailyClientId: this.dailyClientId,
            });
          });
      }
    }

    if (tableWrap) {
      this.renderDailyLeaderboardRows(tableWrap, d);
    }

    if (standingBar) {
      if (d.myStanding) {
        const s = d.myStanding;
        const inTop10 = s.rank <= 10;
        standingBar.innerHTML = `
          <div class="standing-left">
            <span class="you-badge">Your Position</span>
            <strong>#${s.rank}</strong>
            <span>of ${s.totalParticipants} (Top ${s.percentile}%)</span>
            ${inTop10 ? `<span class="meta-pill">Top 10!</span>` : ''}
          </div>
          <div class="standing-right">
            <strong>${s.entry.survivalTimeSeconds.toFixed(2)}s</strong>
            ${
              s.entry.beatPar
                ? `<span class="par-pill">${icon('starFilled', 10)} Par</span>`
                : ''
            }
          </div>
        `;
      } else {
        standingBar.innerHTML = `
          <div class="standing-left">
            <span class="meta-pill">Your Position</span>
            <span>Not ranked yet today — play your daily attempt to claim your spot!</span>
          </div>
        `;
      }
    }
  }

  private async shareDailyResult() {
    const d = this.dailyData;
    const s = d?.myStanding;
    if (!d || !s) return;
    const e = s.entry;
    const parIcon = e.beatPar
      ? '⭐ Beat Par'
      : `Par ${formatParTarget(e.parTimeSeconds)}`;
    const shareText = [
      `🏰 Mazing Contest · Daily Maze #${d.puzzleNumber} (${d.dateKey})`,
      `⏱️ ${e.survivalTimeSeconds.toFixed(2)}s · ${parIcon}`,
      `🏆 Rank #${s.rank} / ${s.totalParticipants} (Top ${s.percentile}%)`,
      `⚡ ${e.clapsTaken} Spire Hits · ◆ ${e.overchargedSpires} Overcharge · 🧱 ${e.wallsUsed} Walls`,
      `${window.location.origin}`,
    ].join('\n');

    if (
      document.body.dataset.input === 'touch' &&
      typeof navigator.share === 'function'
    ) {
      try {
        await navigator.share({
          title: `Mazing Contest Daily #${d.puzzleNumber}`,
          text: shareText,
        });
        return;
      } catch (err) {
        if ((err as Error)?.name === 'AbortError') return;
      }
    }

    let copied = false;
    if (navigator.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(shareText);
        copied = true;
      } catch {
        copied = false;
      }
    }
    if (!copied) {
      try {
        const ta = document.createElement('textarea');
        ta.value = shareText;
        ta.setAttribute('readonly', 'true');
        ta.style.position = 'fixed';
        ta.style.top = '-9999px';
        document.body.appendChild(ta);
        ta.select();
        copied = document.execCommand('copy');
        ta.remove();
      } catch {
        copied = false;
      }
    }
    this.showToast(
      copied
        ? 'Daily Maze result copied to clipboard!'
        : 'Could not copy result.',
      copied
    );
  }

  private renderWaitingLobby() {
    if (!this.roomState || this.roomState.phase !== 'LOBBY') return;
    const state = this.roomState;
    const me = this.getLocalPlayer();
    const isHost = Boolean(me?.isHost);

    const nameEl = document.getElementById('lobby-room-name');
    const codeEl = document.getElementById('lobby-room-code');
    const visEl = document.getElementById('lobby-visibility-badge');
    const countEl = document.getElementById('lobby-player-count');
    const slotsGrid = document.getElementById('lobby-slots-grid');
    const rulesSummary = document.getElementById('lobby-rules-summary');
    const editBtn = document.getElementById('btn-lobby-edit-rules');
    const hostBotActions = document.getElementById('lobby-host-bot-actions');
    const readyBtn = document.getElementById(
      'btn-lobby-ready'
    ) as HTMLButtonElement | null;
    const readyLabel = document.getElementById('lobby-ready-label');
    const startBtn = document.getElementById(
      'btn-lobby-start'
    ) as HTMLButtonElement | null;
    const startLabel = document.getElementById('lobby-start-label');
    const startHint = document.getElementById('lobby-start-hint');

    if (nameEl)
      nameEl.textContent = state.settings.roomName || `Room ${state.roomCode}`;
    if (codeEl) codeEl.textContent = state.roomCode;
    if (visEl)
      visEl.textContent = state.settings.isPublic ? 'Public' : 'Private';
    if (countEl) countEl.textContent = `${state.players.length} / 6`;

    if (hostBotActions) {
      hostBotActions.classList.toggle('hidden', !isHost);
    }
    if (editBtn) {
      editBtn.classList.toggle('hidden', !isHost);
    }
    if (!isHost) {
      this.lobbyRulesEditorOpen = false;
      document.getElementById('lobby-rules-editor')?.classList.add('hidden');
    }

    const addBotBtn = document.getElementById(
      'btn-lobby-add-bot'
    ) as HTMLButtonElement | null;
    const remBotBtn = document.getElementById(
      'btn-lobby-remove-bot'
    ) as HTMLButtonElement | null;
    const botCount = state.players.filter((p) => p.isBot).length;
    if (addBotBtn) addBotBtn.disabled = !isHost || state.players.length >= 6;
    if (remBotBtn) remBotBtn.disabled = !isHost || botCount <= 0;

    if (slotsGrid) {
      slotsGrid.innerHTML = '';
      for (let i = 0; i < 6; i++) {
        const p = state.players[i];
        const card = document.createElement('div');
        if (p) {
          const isMe = p.id === this.localPlayerId;
          const isReady = p.isBot || p.ready;
          card.className = `lobby-slot-card filled${isMe ? ' is-me' : ''}${
            isReady ? ' is-ready' : ''
          }`;
          const roleBadge = p.isBot
            ? `<span class="bot-badge">BOT · ${escapeHtml(
                formatBotSkillLabel(p.botDifficulty)
              )}</span>`
            : p.isHost
            ? `<span class="bot-badge host-badge">${icon('crown', 11)} HOST</span>`
            : '';
          const youBadge = isMe ? `<span class="you-badge">You</span>` : '';
          const statusPill = isReady
            ? `<span class="lobby-ready-pill ready">${icon('check', 12)} Ready</span>`
            : `<span class="lobby-ready-pill waiting">Not Ready</span>`;

          card.innerHTML = `
            <div class="lobby-slot-identity">
              <span class="player-swatch" style="background:${escapeHtml(
                p.color
              )}"></span>
              <span class="lobby-slot-name">${escapeHtml(p.name)}</span>
              ${youBadge}
              ${roleBadge}
            </div>
            ${statusPill}
          `;
        } else {
          card.className = 'lobby-slot-card empty';
          card.innerHTML = `
            <div class="lobby-slot-identity">
              <span class="lobby-empty-dot"></span>
              <span class="lobby-empty-label">Open Slot · Waiting for player…</span>
            </div>
          `;
        }
        slotsGrid.appendChild(card);
      }
    }

    if (rulesSummary) {
      const s = state.settings;
      const timerLabel =
        s.buildTimeSeconds === 999
          ? 'Unlimited (∞)'
          : s.buildTimeSeconds > 0
          ? `${s.buildTimeSeconds}s`
          : 'Round Default (90s–120s)';
      rulesSummary.innerHTML = `
        <div class="lobby-rule-chip"><strong>Rounds:</strong> ${s.totalRounds}</div>
        <div class="lobby-rule-chip"><strong>Maps:</strong> Randomized (${ROUNDS.length} pool)</div>
        <div class="lobby-rule-chip"><strong>Build Timer:</strong> ${timerLabel}</div>
        <div class="lobby-rule-chip"><strong>Wall Supply:</strong> ${formatWallSupplyLabel(
          s.goldMultiplier
        )}</div>
        <div class="lobby-rule-chip"><strong>Bots:</strong> ${botCount} (${formatBotSkillLabel(
        s.botDifficulty
      )})</div>
        <div class="lobby-rule-chip"><strong>Rival Mazes:</strong> ${
          s.fogOfWar ? 'Hidden' : 'Visible'
        }</div>
        <div class="lobby-rule-chip"><strong>Planning:</strong> 5s before every round</div>
      `;
    }

    const setLobbySeg = (groupId: string, val: string) => {
      document
        .querySelectorAll<HTMLButtonElement>(`#${groupId} .seg-btn`)
        .forEach((b) => b.classList.toggle('active', b.dataset.val === val));
    };
    setLobbySeg(
      'lobby-cfg-public-group',
      String(Boolean(state.settings.isPublic))
    );
    setLobbySeg(
      'lobby-cfg-rounds-group',
      String(state.settings.totalRounds || 8)
    );
    setLobbySeg(
      'lobby-cfg-buildtime-group',
      String(state.settings.buildTimeSeconds || 0)
    );
    setLobbySeg(
      'lobby-cfg-gold-group',
      String(state.settings.goldMultiplier || 1)
    );
    setLobbySeg(
      'lobby-cfg-botdiff-group',
      state.settings.botDifficulty || 'ARCHITECT'
    );
    setLobbySeg('lobby-cfg-fog-group', String(Boolean(state.settings.fogOfWar)));

    const connectedHumans = state.players.filter(
      (p) => !p.isBot && p.connected !== false
    );
    const readyHumans = connectedHumans.filter((p) => p.ready).length;
    const allHumansReady =
      connectedHumans.length > 0 && readyHumans === connectedHumans.length;

    if (readyBtn && readyLabel && me) {
      readyBtn.classList.toggle('is-ready', me.ready);
      readyLabel.textContent = me.ready ? 'Ready' : 'Ready Up';
    }

    if (startBtn && startLabel) {
      if (isHost) {
        startBtn.classList.remove('hidden');
        startBtn.disabled = !allHumansReady;
        startLabel.textContent = allHumansReady
          ? 'Start Round'
          : `Waiting for Ready (${readyHumans}/${connectedHumans.length})`;
      } else {
        startBtn.classList.add('hidden');
      }
    }

    if (startHint) {
      if (allHumansReady) {
        startHint.textContent = isHost
          ? 'Everyone is ready! Click Start Round when you want to begin.'
          : 'Everyone is ready! Waiting for the host to start the round…';
      } else if (!me?.ready) {
        startHint.textContent =
          'Click Ready Up once you are set. All players must ready up before the round starts.';
      } else {
        startHint.textContent = `Waiting for other players to ready up (${readyHumans}/${connectedHumans.length} ready)…`;
      }
    }
  }

  private async shareOrCopyInviteLink() {
    if (!this.roomCode) return;
    const shareUrl = `${window.location.origin}/?room=${this.roomCode}`;

    if (
      document.body.dataset.input === 'touch' &&
      typeof navigator.share === 'function'
    ) {
      try {
        await navigator.share({
          title: 'Mazing Contest',
          text: `Join lobby ${this.roomCode} in Mazing Contest`,
          url: shareUrl,
        });
        return;
      } catch (err) {
        if ((err as Error)?.name === 'AbortError') return;
      }
    }

    let copied = false;
    if (
      navigator.clipboard &&
      typeof navigator.clipboard.writeText === 'function'
    ) {
      try {
        await navigator.clipboard.writeText(shareUrl);
        copied = true;
      } catch {
        copied = false;
      }
    }

    if (!copied) {
      try {
        const ta = document.createElement('textarea');
        ta.value = shareUrl;
        ta.setAttribute('readonly', 'true');
        ta.style.position = 'fixed';
        ta.style.top = '-9999px';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        copied = document.execCommand('copy');
        ta.remove();
      } catch {
        copied = false;
      }
    }

    if (copied) {
      this.showToast(`Invite link copied (${this.roomCode})`, true);
    } else {
      this.showToast(`Room code: ${this.roomCode}`, true);
    }
  }

  private setupHubEvents() {
    document.getElementById('btn-open-hub')?.addEventListener('click', () => {
      soundEngine.playUiClick();
      this.openMenuScreen('home');
    });

    document
      .getElementById('btn-open-leaderboard')
      ?.addEventListener('click', () => {
        soundEngine.playUiClick();
        this.openMenuScreen('leaderboard');
      });

    document
      .getElementById('btn-drawer-open-config')
      ?.addEventListener('click', () => {
        soundEngine.playUiClick();
        this.dismissAllTransientOverlays();
        this.openMenuScreen('online', 'setup');
      });

    document.getElementById('btn-hub-mute')?.addEventListener('click', () => {
      soundEngine.toggleMuted();
      this.syncAudioMuteButtons();
    });

    document
      .getElementById('btn-results-leaderboard')
      ?.addEventListener('click', () => {
        soundEngine.playUiClick();
        if (this.roomState) {
          this.selectedLeaderboardRound =
            this.roomState.roundConfig.mapId ||
            this.roomState.roundConfig.roundNumber;
          this.leaderboardMode = 'rounds';
        }
        this.openMenuScreen('leaderboard');
      });

    document
      .getElementById('btn-results-share-daily')
      ?.addEventListener('click', () => {
        soundEngine.playUiClick();
        this.shareDailyResult();
      });

    document
      .getElementById('btn-results-home')
      ?.addEventListener('click', () => {
        soundEngine.playUiClick();
        if (this.roomState) {
          this.send({ type: 'LEAVE_ROOM' });
        } else {
          this.openMenuScreen('home');
        }
      });

    const hubModal = document.getElementById('home-hub-modal');
    hubModal?.addEventListener('click', (e) => {
      if (
        e.target === hubModal &&
        this.roomState &&
        this.roomState.phase !== 'LOBBY'
      ) {
        this.closeHub();
      }
    });

    document
      .querySelectorAll<HTMLButtonElement>('[data-nav]')
      .forEach((btn) => {
        btn.addEventListener('click', () => {
          soundEngine.playUiClick();
          const target = btn.dataset.nav as MenuScreen;
          if (target) {
            this.openMenuScreen(target);
          }
        });
      });

    document
      .getElementById('btn-home-resume')
      ?.addEventListener('click', () => {
        soundEngine.playUiClick();
        if (this.roomState?.phase === 'LOBBY') {
          this.openMenuScreen('lobby');
        } else {
          this.closeHub();
        }
      });

    const leaveHomeBtn = document.getElementById('btn-home-leave');
    leaveHomeBtn?.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!this.roomState) return;
      const isDailyActive =
        this.roomState.mode === 'DAILY' && this.roomState.phase !== 'GAME_OVER';
      this.armDestructiveButton(
        leaveHomeBtn,
        isDailyActive || this.roomState.phase === 'BUILD',
        isDailyActive ? 'End Daily Try?' : 'Confirm Leave',
        'logout',
        () => {
          soundEngine.playUiClick();
          this.send({ type: 'LEAVE_ROOM' });
        }
      );
    });

    document
      .querySelectorAll<HTMLButtonElement>('#hub-play-subtabs .subtab-pill')
      .forEach((btn) => {
        btn.addEventListener('click', () => {
          soundEngine.playUiClick();
          const pane = (btn.dataset.playPane as 'rooms' | 'setup') || 'rooms';
          this.setMobilePlayPane(pane);
        });
      });

    const hubNameInput = document.getElementById(
      'hub-player-name-input'
    ) as HTMLInputElement | null;
    const settingsNameInput = document.getElementById(
      'settings-player-name'
    ) as HTMLInputElement | null;

    [hubNameInput, settingsNameInput].forEach((inp) => {
      if (!inp) return;
      inp.addEventListener('change', () => this.commitPlayerName(inp.value));
      inp.addEventListener('blur', () => {
        if (!inp.value.trim()) this.commitPlayerName('');
      });
      inp.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          this.commitPlayerName(inp.value);
          inp.blur();
        }
      });
    });

    document
      .getElementById('settings-sound-toggle')
      ?.addEventListener('click', () => {
        soundEngine.toggleMuted();
        this.syncAudioMuteButtons();
      });

    const volSlider = document.getElementById(
      'settings-volume-slider'
    ) as HTMLInputElement | null;
    volSlider?.addEventListener('input', () => {
      const pct = Number(volSlider.value);
      soundEngine.volume = pct / 100;
      if (pct > 0 && soundEngine.muted) {
        soundEngine.muted = false;
      }
      this.syncAudioMuteButtons();
    });

    document
      .getElementById('btn-settings-test-sound')
      ?.addEventListener('click', () => {
        if (soundEngine.muted) {
          soundEngine.muted = false;
          this.syncAudioMuteButtons();
        }
        soundEngine.playBuildUnlock();
      });

    document
      .getElementById('settings-haptics-toggle')
      ?.addEventListener('click', () => {
        soundEngine.hapticsEnabled = !soundEngine.hapticsEnabled;
        if (soundEngine.hapticsEnabled) soundEngine.haptic('snap');
        soundEngine.playUiClick();
        this.syncSettingsScreenControls();
      });

    document
      .getElementById('settings-tips-toggle')
      ?.addEventListener('click', () => {
        this.showRoundTips = !this.showRoundTips;
        try {
          localStorage.setItem(
            TIPS_STORAGE_KEY,
            this.showRoundTips ? '1' : '0'
          );
        } catch {
          // ignore
        }
        soundEngine.playUiClick();
        this.syncSettingsScreenControls();
      });

    const wireSegmented = (selector: string, onChange?: () => void) => {
      document.querySelectorAll<HTMLElement>(selector).forEach((group) => {
        group.querySelectorAll<HTMLButtonElement>('.seg-btn').forEach((btn) => {
          btn.addEventListener('click', () => {
            if (btn.disabled) return;
            soundEngine.playUiClick();
            group
              .querySelectorAll<HTMLButtonElement>('.seg-btn')
              .forEach((b) => b.classList.remove('active'));
            btn.classList.add('active');
            onChange?.();
          });
        });
      });
    };

    wireSegmented('#screen-solo-setup .segmented-control', () =>
      this.syncSoloBotSkillRow()
    );
    wireSegmented('#screen-online .segmented-control', () =>
      this.syncBotSkillRow()
    );
    wireSegmented('#lobby-rules-editor .segmented-control');

    document
      .getElementById('btn-start-solo-match')
      ?.addEventListener('click', () => {
        if (!this.ensureConnectedForAction()) return;
        soundEngine.playUiClick();
        const settings = this.readSoloFormSettings();
        this.pendingJoinToast = 'Solo match started — 5s to plan your route!';
        this.send({
          type: 'START_SOLO',
          playerName: this.playerName,
          sessionId: this.sessionId,
          settings,
        });
      });

    const joinCodeInput = document.getElementById(
      'join-code-input'
    ) as HTMLInputElement | null;
    const handleJoinByCode = () => {
      if (!this.ensureConnectedForAction()) return;
      const code = (joinCodeInput?.value || '')
        .trim()
        .toUpperCase()
        .replace(/[^A-Z0-9-]/g, '')
        .slice(0, 8);
      if (!code) {
        this.showToast('Enter a room code to join.');
        return;
      }
      this.pendingJoinToast = `Joined lobby ${code}`;
      this.send({
        type: 'JOIN_ROOM',
        roomCode: code,
        playerName: this.playerName,
        sessionId: this.sessionId,
      });
      if (joinCodeInput) joinCodeInput.value = '';
    };
    document
      .getElementById('btn-join-code')
      ?.addEventListener('click', handleJoinByCode);
    joinCodeInput?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        handleJoinByCode();
      }
    });

    document
      .getElementById('btn-refresh-lobbies')
      ?.addEventListener('click', () => {
        soundEngine.playUiClick();
        this.send({ type: 'REQUEST_LOBBIES' });
        this.fetchInitialHubData();
      });

    document
      .getElementById('btn-refresh-daily')
      ?.addEventListener('click', () => {
        soundEngine.playUiClick();
        this.send({
          type: 'REQUEST_DAILY',
          dailyClientId: this.dailyClientId,
          playerName: this.playerName,
        });
        void this.refreshDailyFromApi();
      });

    document
      .getElementById('btn-create-custom-room')
      ?.addEventListener('click', () => {
        if (!this.ensureConnectedForAction()) return;
        soundEngine.playUiClick();
        const settings = this.readConfigFormSettings();
        const customCode = `RM${Math.floor(1000 + Math.random() * 8999)}`;
        this.pendingJoinToast = `Lobby ${customCode} created — waiting for players!`;
        this.send({
          type: 'CREATE_ROOM',
          roomCode: customCode,
          playerName: this.playerName,
          sessionId: this.sessionId,
          settings,
        });
      });

    document
      .getElementById('lobby-room-code')
      ?.addEventListener('click', () => {
        soundEngine.playUiClick();
        this.shareOrCopyInviteLink();
      });

    document
      .getElementById('btn-lobby-copy-invite')
      ?.addEventListener('click', () => {
        soundEngine.playUiClick();
        this.shareOrCopyInviteLink();
      });

    document
      .getElementById('btn-leave-lobby')
      ?.addEventListener('click', () => {
        soundEngine.playUiClick();
        this.send({ type: 'LEAVE_ROOM' });
      });

    document
      .getElementById('btn-lobby-ready')
      ?.addEventListener('click', () => {
        if (!this.ensureConnectedForAction()) return;
        if (this.roomState?.phase !== 'LOBBY') return;
        const me = this.getLocalPlayer();
        soundEngine.playReady(!me?.ready);
        soundEngine.haptic('ready');
        this.send({ type: 'TOGGLE_READY' });
      });

    document
      .getElementById('btn-lobby-start')
      ?.addEventListener('click', () => {
        if (!this.ensureConnectedForAction()) return;
        if (this.roomState?.phase !== 'LOBBY') return;
        soundEngine.playUiClick();
        this.send({ type: 'START_GAME' });
      });

    document
      .getElementById('btn-lobby-add-bot')
      ?.addEventListener('click', () => {
        if (!this.ensureConnectedForAction()) return;
        soundEngine.playUiClick();
        this.send({ type: 'ADD_BOT' });
      });

    document
      .getElementById('btn-lobby-remove-bot')
      ?.addEventListener('click', () => {
        if (!this.ensureConnectedForAction()) return;
        soundEngine.playUiClick();
        this.send({ type: 'REMOVE_BOT' });
      });

    document
      .getElementById('btn-lobby-edit-rules')
      ?.addEventListener('click', () => {
        soundEngine.playUiClick();
        this.lobbyRulesEditorOpen = !this.lobbyRulesEditorOpen;
        document
          .getElementById('lobby-rules-editor')
          ?.classList.toggle('hidden', !this.lobbyRulesEditorOpen);
      });

    document
      .getElementById('btn-lobby-save-rules')
      ?.addEventListener('click', () => {
        if (!this.ensureConnectedForAction()) return;
        soundEngine.playUiClick();
        const getSeg = (id: string, fb: string) =>
          document.querySelector<HTMLButtonElement>(`#${id} .seg-btn.active`)
            ?.dataset.val ?? fb;
        this.send({
          type: 'UPDATE_SETTINGS',
          settings: {
            isPublic: getSeg('lobby-cfg-public-group', 'true') === 'true',
            totalRounds: Number(getSeg('lobby-cfg-rounds-group', '8')),
            buildTimeSeconds: Number(getSeg('lobby-cfg-buildtime-group', '0')),
            goldMultiplier: Number(getSeg('lobby-cfg-gold-group', '1')),
            botDifficulty: getSeg('lobby-cfg-botdiff-group', 'ARCHITECT') as
              | 'NOVICE'
              | 'ARCHITECT'
              | 'GRANDMASTER',
            fogOfWar: getSeg('lobby-cfg-fog-group', 'false') === 'true',
          },
        });
        this.lobbyRulesEditorOpen = false;
        document.getElementById('lobby-rules-editor')?.classList.add('hidden');
        this.showToast('Lobby rules updated', true);
      });

    const lobbyChatForm = document.getElementById(
      'lobby-chat-form'
    ) as HTMLFormElement | null;
    const lobbyChatInput = document.getElementById(
      'lobby-chat-input'
    ) as HTMLInputElement | null;
    lobbyChatForm?.addEventListener('submit', (e) => {
      e.preventDefault();
      if (!lobbyChatInput || !this.ensureConnectedForAction()) return;
      const text = lobbyChatInput.value.trim();
      if (text) {
        this.send({ type: 'CHAT', text });
        lobbyChatInput.value = '';
      }
    });

    const lbModeGroup = document.getElementById('leaderboard-mode-group');
    lbModeGroup
      ?.querySelectorAll<HTMLButtonElement>('.seg-btn')
      .forEach((btn) => {
        btn.addEventListener('click', () => {
          soundEngine.playUiClick();
          lbModeGroup
            .querySelectorAll<HTMLButtonElement>('.seg-btn')
            .forEach((b) => b.classList.remove('active'));
          btn.classList.add('active');
          this.leaderboardMode =
            (btn.dataset.lbMode as 'rounds' | 'champions') || 'rounds';
          this.renderLeaderboard();
        });
      });
  }

  private readSoloFormSettings(): RoomSettings {
    const getSegVal = (groupId: string, fallback: string) => {
      const active = document.querySelector<HTMLButtonElement>(
        `#${groupId} .seg-btn.active`
      );
      return active?.dataset.val ?? fallback;
    };
    return {
      roomName: `${this.playerName}'s Island`,
      isPublic: false,
      totalRounds: Number(getSegVal('solo-rounds-group', '8')),
      buildTimeSeconds: Number(getSegVal('solo-buildtime-group', '0')),
      goldMultiplier: Number(getSegVal('solo-gold-group', '1')),
      botCount: Number(getSegVal('solo-botcount-group', '3')),
      botDifficulty: getSegVal('solo-botdiff-group', 'ARCHITECT') as
        | 'NOVICE'
        | 'ARCHITECT'
        | 'GRANDMASTER',
      fogOfWar: getSegVal('solo-fog-group', 'false') === 'true',
    };
  }

  private syncSoloBotSkillRow() {
    const zeroBots =
      Number(
        document.querySelector<HTMLButtonElement>(
          '#solo-botcount-group .seg-btn.active'
        )?.dataset.val ?? '3'
      ) === 0;
    document
      .getElementById('solo-row-bot-skill')
      ?.classList.toggle('hidden', zeroBots);
  }

  private readConfigFormSettings(): RoomSettings {
    const getSegVal = (groupId: string, fallback: string) => {
      const active = document.querySelector<HTMLButtonElement>(
        `#${groupId} .seg-btn.active`
      );
      return active?.dataset.val ?? fallback;
    };

    const nameInput = document.getElementById(
      'cfg-room-name'
    ) as HTMLInputElement | null;
    const roomName =
      nameInput?.value.trim().slice(0, 26) || `${this.playerName}'s Lobby`;

    return {
      roomName,
      isPublic: getSegVal('cfg-public-group', 'true') === 'true',
      totalRounds: Number(getSegVal('cfg-rounds-group', '8')),
      buildTimeSeconds: Number(getSegVal('cfg-buildtime-group', '0')),
      goldMultiplier: Number(getSegVal('cfg-gold-group', '1')),
      botCount: Number(getSegVal('cfg-botcount-group', '0')),
      botDifficulty: getSegVal('cfg-botdiff-group', 'ARCHITECT') as
        | 'NOVICE'
        | 'ARCHITECT'
        | 'GRANDMASTER',
      fogOfWar: getSegVal('cfg-fog-group', 'false') === 'true',
    };
  }

  private syncBotSkillRow() {
    const zeroBots =
      Number(
        document.querySelector<HTMLButtonElement>(
          '#cfg-botcount-group .seg-btn.active'
        )?.dataset.val ?? '0'
      ) === 0;
    document
      .getElementById('row-bot-skill')
      ?.classList.toggle('hidden', zeroBots);
  }

  private syncHostOnlyControls() {
    const canEditRules = this.canControlRoomRules();
    const fogChk = document.getElementById(
      'chk-fog'
    ) as HTMLInputElement | null;
    if (fogChk) {
      fogChk.checked = Boolean(this.roomState?.settings?.fogOfWar);
      fogChk.disabled = !canEditRules;
    }
  }

  private syncConfigFormFromSettings(settings: RoomSettings) {
    const nameInput = document.getElementById(
      'cfg-room-name'
    ) as HTMLInputElement | null;
    if (nameInput && settings.roomName && this.roomState?.mode === 'ONLINE') {
      nameInput.value = settings.roomName;
    }
    this.syncBotSkillRow();
    this.syncSoloBotSkillRow();
    this.syncHostOnlyControls();
  }

  // ==========================================================================
  // OPEN ROOMS & HEADERED LEADERBOARD RENDERING
  // ==========================================================================

  private renderLobbyBrowser() {
    const listEl = document.getElementById('lobby-browser-list');
    const countEl = document.getElementById('public-lobby-count');
    const mobileCountEl = document.getElementById('mobile-lobby-count');
    if (!listEl) return;

    const rooms = this.lobbies;
    const lobbySig = `${this.roomCode ?? ''}|${JSON.stringify(
      rooms.map((r) => [
        r.roomCode,
        r.roomName,
        r.hostName,
        r.phase,
        r.currentRound,
        r.totalRounds,
        r.humanCount,
        r.botCount,
        r.maxPlayers,
        r.settings.buildTimeSeconds,
        r.settings.fogOfWar,
      ])
    )}`;
    if (lobbySig === this.lastLobbySignature) return;
    this.lastLobbySignature = lobbySig;

    if (countEl) {
      countEl.textContent = `${rooms.length} Open`;
    }
    if (mobileCountEl) {
      mobileCountEl.textContent = String(rooms.length);
    }

    listEl.innerHTML = '';
    if (rooms.length === 0) {
      listEl.innerHTML = `<div class="daily-empty-note">No public lobbies open right now. Host a new lobby and share your room code!</div>`;
      return;
    }

    for (const r of rooms) {
      const isCurrent = Boolean(this.roomCode && r.roomCode === this.roomCode);
      const isFull = !isCurrent && r.humanCount >= r.maxPlayers;
      const card = document.createElement('div');
      card.className = `lobby-card${isCurrent ? ' current-room' : ''}`;

      const phaseText =
        r.phase === 'LOBBY'
          ? 'In Lobby'
          : r.phase === 'PLANNING'
          ? `Planning R${r.currentRound}/${r.totalRounds}`
          : r.phase === 'BUILD'
          ? `Build R${r.currentRound}/${r.totalRounds}`
          : r.phase === 'RUN'
          ? `Run R${r.currentRound}/${r.totalRounds}`
          : 'Standings';

      const paceDesc =
        r.settings.buildTimeSeconds === 999
          ? '∞ Timer'
          : r.settings.buildTimeSeconds > 0
          ? `${r.settings.buildTimeSeconds}s`
          : 'Default';

      const hiddenSuffix = r.settings.fogOfWar ? ' · Hidden Mazes' : '';
      const subtitleText = `Host: ${escapeHtml(r.hostName)} · ${
        r.totalRounds
      } Rounds · ${paceDesc}${hiddenSuffix}`;
      const botsLabel = `${r.botCount} ${r.botCount === 1 ? 'Bot' : 'Bots'}`;

      card.innerHTML = `
        <div class="lobby-card-main">
          <div class="lobby-card-title-row">
            <span class="lobby-card-name">${escapeHtml(r.roomName)}</span>
            <span class="room-code-badge">${escapeHtml(r.roomCode)}</span>
            <span class="lobby-phase-dot${
              r.phase === 'RUN'
                ? ' running'
                : r.phase === 'LOBBY'
                ? ' waiting'
                : ''
            }">${phaseText}</span>
          </div>
          <div class="lobby-card-subtitle">${subtitleText}</div>
        </div>
        <div class="lobby-card-right">
          <span class="capacity-pill" title="${r.humanCount} Players · ${botsLabel}">
            ${icon('users', 14)}
            <span>${r.humanCount}/${r.maxPlayers}${
        r.botCount > 0 ? ` · ${botsLabel}` : ''
      }</span>
          </span>
          <button type="button" class="hub-action-pill ${
            isCurrent ? 'sage' : 'gold'
          }"${isFull ? ' disabled' : ''}>
            ${
              isCurrent
                ? `${icon('check', 14)}<span>Active</span>`
                : isFull
                ? `<span>Full</span>`
                : `<span>Join</span>`
            }
          </button>
        </div>
      `;

      const btn = card.querySelector('button')!;
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        soundEngine.playUiClick();
        if (isCurrent) {
          if (this.roomState?.phase === 'LOBBY') {
            this.openMenuScreen('lobby');
          } else {
            this.closeHub();
          }
          return;
        }
        if (!this.ensureConnectedForAction()) return;
        this.pendingJoinToast = `Joined ${r.roomName} (${r.roomCode})`;
        this.send({
          type: 'JOIN_ROOM',
          roomCode: r.roomCode,
          playerName: this.playerName,
          sessionId: this.sessionId,
        });
      });

      listEl.appendChild(card);
    }
  }

  private renderLeaderboardRoundPills() {
    const select = document.getElementById(
      'leaderboard-map-select'
    ) as HTMLSelectElement | null;
    if (!select) return;

    const prevMapBtn = document.getElementById('btn-lb-prev-map');
    const nextMapBtn = document.getElementById('btn-lb-next-map');

    const populateOptions = () => {
      select.innerHTML = '';
      for (const r of ROUNDS) {
        const mapId = r.mapId ?? r.roundNumber;
        const arch = RUNNER_ARCHETYPES[r.runnerType || 'SCOUT'];
        const hasRecs =
          (this.leaderboard?.roundRecords?.[mapId]?.length || 0) > 0;
        const opt = document.createElement('option');
        opt.value = String(mapId);
        opt.textContent = `#${mapId} · ${r.title} (${arch.name.replace(
          /^(Citadel|Royal|Iron|Wind)\s+/i,
          ''
        )})${hasRecs ? ' ★' : ''}`;
        select.appendChild(opt);
      }
      select.value = String(this.selectedLeaderboardRound);
    };

    populateOptions();

    if (!select.dataset.wired) {
      select.dataset.wired = 'true';
      select.addEventListener('change', () => {
        soundEngine.playUiClick();
        const nextId = Number(select.value) || 1;
        this.selectedLeaderboardRound = nextId;
        this.renderLeaderboard();
      });

      prevMapBtn?.addEventListener('click', () => {
        soundEngine.playUiClick();
        const curIdx = ROUNDS.findIndex(
          (r) => (r.mapId ?? r.roundNumber) === this.selectedLeaderboardRound
        );
        const nextIdx = (curIdx <= 0 ? ROUNDS.length - 1 : curIdx - 1);
        this.selectedLeaderboardRound =
          ROUNDS[nextIdx].mapId ?? ROUNDS[nextIdx].roundNumber;
        this.renderLeaderboard();
      });

      nextMapBtn?.addEventListener('click', () => {
        soundEngine.playUiClick();
        const curIdx = ROUNDS.findIndex(
          (r) => (r.mapId ?? r.roundNumber) === this.selectedLeaderboardRound
        );
        const nextIdx = (curIdx + 1) % ROUNDS.length;
        this.selectedLeaderboardRound =
          ROUNDS[nextIdx].mapId ?? ROUNDS[nextIdx].roundNumber;
        this.renderLeaderboard();
      });
    }
  }

  private renderLeaderboard() {
    const pickerWrap = document.getElementById('leaderboard-map-picker');
    const mapSelect = document.getElementById(
      'leaderboard-map-select'
    ) as HTMLSelectElement | null;
    const metaEl = document.getElementById('leaderboard-round-meta');
    const tableWrap = document.getElementById('leaderboard-table-wrap');
    if (!tableWrap || !metaEl) return;

    const lbModeGroup = document.getElementById('leaderboard-mode-group');
    lbModeGroup
      ?.querySelectorAll<HTMLButtonElement>('.seg-btn')
      .forEach((btn) => {
        btn.classList.toggle('active', btn.dataset.lbMode === this.leaderboardMode);
      });

    if (mapSelect) {
      this.renderLeaderboardRoundPills();
      mapSelect.value = String(this.selectedLeaderboardRound);
    }

    if (!this.leaderboard) {
      tableWrap.innerHTML = `<div style="color:var(--text-secondary);font-size:12.5px;padding:14px">Loading leaderboard...</div>`;
      return;
    }

    tableWrap.innerHTML = '';
    const myLower = this.playerName.trim().toLowerCase();

    if (this.leaderboardMode === 'rounds') {
      pickerWrap?.classList.remove('hidden');
      const roundCfg = getMapById(this.selectedLeaderboardRound);
      const mapId = roundCfg.mapId ?? roundCfg.roundNumber;
      const arch = RUNNER_ARCHETYPES[roundCfg.runnerType || 'SCOUT'];

      metaEl.innerHTML = `
        <div class="lb-meta-main">
          <strong>Map #${mapId} · ${escapeHtml(roundCfg.title)}</strong>
          <span class="lb-meta-trait">${getRunnerIcon(
            roundCfg.runnerType || 'SCOUT',
            14
          )} ${escapeHtml(arch.name)} · ${escapeHtml(arch.traitSummary)}</span>
        </div>
        <div class="par-pill">
          ${icon('starFilled', 11)}
          <span>Par ${escapeHtml(formatParTarget(roundCfg.parTimeSeconds))}</span>
        </div>
      `;

      const records = this.leaderboard.roundRecords[mapId] || [];
      if (records.length === 0) {
        tableWrap.innerHTML = `<div style="color:var(--text-secondary);font-size:12.5px;padding:14px">No survival records yet for Map #${mapId} (${escapeHtml(
          roundCfg.title
        )}). Complete a run to set the first record.</div>`;
        return;
      }

      const head = document.createElement('div');
      head.className = 'lb-table-head';
      head.innerHTML = `
        <div>Rank</div>
        <div>Player</div>
        <div>Survival</div>
        <div class="lb-synergies">Maze Stats</div>
        <div class="lb-meta-right">Supply</div>
      `;
      tableWrap.appendChild(head);

      records.forEach((rec, idx) => {
        const row = document.createElement('div');
        const rankClass = idx < 3 ? ` rank-${idx + 1}` : '';
        const isMe = rec.playerName.trim().toLowerCase() === myLower;
        row.className = `lb-row${rankClass}${isMe ? ' is-me' : ''}`;

        const rankBadge =
          idx < 3
            ? getMedalBadge((idx + 1) as 1 | 2 | 3, 22)
            : `<span>#${idx + 1}</span>`;
        const parBadge = rec.beatPar
          ? `<span class="par-pill">${icon('starFilled', 10)}<span>Par</span></span>`
          : '';
        const youBadge = isMe ? `<span class="you-badge">You</span>` : '';

        row.innerHTML = `
          <div class="lb-rank">${rankBadge}</div>
          <div class="lb-architect">
            <span class="player-swatch" style="background:${escapeHtml(
              rec.playerColor
            )}"></span>
            <span class="lb-name">${escapeHtml(rec.playerName)}</span>
            ${youBadge}
          </div>
          <div class="lb-time-primary">
            <span>${rec.survivalTimeSeconds.toFixed(2)}s</span>
            ${parBadge}
          </div>
          <div class="lb-synergies">
            <span class="stat-chip" title="Spire Hits">${icon('bolt', 12)} ${
          rec.clapsTaken
        }</span>
            <span class="stat-chip" title="Overcharge Diamonds">${icon(
              'diamondFilled',
              11
            )} ${rec.overchargedSpires}</span>
            <span class="stat-chip" title="Linked Keeps">${icon('keep', 12)} ${
          rec.linkedKeeps
        }</span>
            <span class="stat-chip" title="Path Length">${rec.pathDistance.toFixed(
              0
            )}m</span>
          </div>
          <div class="lb-meta-right">
            ${formatWallSupplyLabel(rec.goldMultiplier)}
          </div>
        `;
        tableWrap.appendChild(row);
      });
    } else {
      pickerWrap?.classList.add('hidden');
      metaEl.innerHTML = `
        <div class="lb-meta-main">
          ${icon('crown', 16)}
          <strong>Top Players</strong>
          <span class="lb-meta-trait">Ranked by total points, match wins, and Par stars</span>
        </div>
        <div class="meta-pill">All-Time</div>
      `;

      const champs = this.leaderboard.champions || [];
      if (champs.length === 0) {
        tableWrap.innerHTML = `<div style="color:var(--text-secondary);font-size:12.5px;padding:14px">Complete a full match to claim the top spot on the leaderboard.</div>`;
        return;
      }

      const head = document.createElement('div');
      head.className = 'lb-table-head';
      head.innerHTML = `
        <div>Rank</div>
        <div>Player</div>
        <div>Points</div>
        <div class="lb-synergies">Highlights</div>
        <div class="lb-meta-right">Best Run</div>
      `;
      tableWrap.appendChild(head);

      champs.forEach((c, idx) => {
        const row = document.createElement('div');
        const rankClass = idx < 3 ? ` rank-${idx + 1}` : '';
        const isMe = c.playerName.trim().toLowerCase() === myLower;
        row.className = `lb-row${rankClass}${isMe ? ' is-me' : ''}`;

        const rankBadge =
          idx < 3
            ? getMedalBadge((idx + 1) as 1 | 2 | 3, 22)
            : `<span>#${idx + 1}</span>`;
        const youBadge = isMe ? `<span class="you-badge">You</span>` : '';
        const bestMap = getMapById(c.bestRoundNumber);

        row.innerHTML = `
          <div class="lb-rank">${rankBadge}</div>
          <div class="lb-architect">
            <span class="player-swatch" style="background:${escapeHtml(
              c.playerColor
            )}"></span>
            <span>${escapeHtml(c.playerName)}</span>
            ${youBadge}
          </div>
          <div class="lb-time-primary" style="color:var(--accent-sage)">
            <span>${c.totalCareerPoints} pts</span>
          </div>
          <div class="lb-synergies">
            <span class="stat-chip">${icon('trophy', 12)} ${
          c.matchesWon
        } Wins</span>
            <span class="stat-chip">${icon('starFilled', 11)} ${
          c.parStarsEarned
        } Par</span>
            <span class="stat-chip">${c.roundsPlayed} Rounds</span>
          </div>
          <div class="lb-meta-right" title="${escapeHtml(bestMap.title)}">
            ${c.bestSurvivalTime.toFixed(1)}s · #${c.bestRoundNumber}
          </div>
        `;
        tableWrap.appendChild(row);
      });
    }
  }

  // ==========================================================================
  // IN-GAME HUD, DOCK, POPOVER & KEYBOARD EVENTS
  // ==========================================================================

  private setupUIEvents() {
    // Prevent Space from double-firing a focused HUD button after pointer click
    document.addEventListener('click', (e) => {
      if (e.detail <= 0) return;
      const btn = (e.target as HTMLElement | null)?.closest(
        '#hud-top-bar button, #hud-bottom-dock button, #hud-run-dock button, #spectator-bar button'
      ) as HTMLElement | null;
      btn?.blur();
    });

    // Round Strategy Brief Dismiss
    document
      .getElementById('btn-dismiss-brief')
      ?.addEventListener('click', () => {
        this.dismissRoundBrief();
      });

    // Bottom Dock Build / Remove / Pan Tools
    document
      .querySelectorAll<HTMLButtonElement>('#tower-buttons .dock-tool-btn')
      .forEach((btn) => {
        btn.addEventListener('click', () => {
          const tool = (btn.dataset.tool as ActiveBuildTool) || 'BLOCK';
          soundEngine.playUiClick();
          this.selectTool(tool);
        });
      });

    // Undo / Optional Redo Buttons
    document.getElementById('btn-undo')?.addEventListener('click', () => {
      this.performUndo();
    });
    document.getElementById('btn-redo')?.addEventListener('click', () => {
      this.performRedo();
    });

    // Bottom Progressive-Disclosure Tools Popover
    const dockToolsBtn = document.getElementById('btn-dock-tools')!;
    const dockToolsPopover = document.getElementById('dock-tools-popover')!;
    dockToolsBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      soundEngine.playUiClick();
      const willOpen = dockToolsPopover.classList.contains('hidden');
      this.dismissAllTransientOverlays();
      if (willOpen) {
        dockToolsPopover.classList.remove('hidden');
        dockToolsBtn.classList.add('active');
        dockToolsBtn.setAttribute('aria-expanded', 'true');
      }
    });

    // Top Standings Collapsible Popover
    const standingsBtn = document.getElementById('btn-standings-toggle')!;
    const standingsDropdown = document.getElementById('standings-dropdown')!;
    standingsBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      soundEngine.playUiClick();
      const willOpen = standingsDropdown.classList.contains('hidden');
      this.dismissAllTransientOverlays();
      if (willOpen) {
        standingsDropdown.classList.remove('hidden');
        standingsBtn.classList.add('active');
        standingsBtn.setAttribute('aria-expanded', 'true');
      }
    });

    // Round Inspect & Switcher Popover
    const roundDropdown = document.getElementById('round-dropdown')!;
    const roundPickerBtn = document.getElementById('btn-round-picker')!;
    roundPickerBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      soundEngine.playUiClick();
      const willOpen = roundDropdown.classList.contains('hidden');
      this.dismissAllTransientOverlays();
      if (willOpen) {
        roundDropdown.classList.remove('hidden');
        roundPickerBtn.classList.add('active');
        roundPickerBtn.setAttribute('aria-expanded', 'true');
        this.renderRoundSelectorPills();
      }
    });

    document
      .querySelectorAll<HTMLButtonElement>('#round-switcher-tabs .round-tab-btn')
      .forEach((tabBtn) => {
        tabBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          soundEngine.playUiClick();
          const nextTab =
            tabBtn.dataset.roundTab === 'catalog' ? 'catalog' : 'match';
          this.roundSwitcherTab = nextTab;
          document
            .querySelectorAll<HTMLButtonElement>(
              '#round-switcher-tabs .round-tab-btn'
            )
            .forEach((b) =>
              b.classList.toggle('active', b.dataset.roundTab === nextTab)
            );
          document
            .getElementById('round-map-search-wrap')
            ?.classList.toggle('hidden', nextTab !== 'catalog');
          this.renderRoundSelectorPills();
        });
      });

    const roundSearchInput = document.getElementById(
      'round-map-search'
    ) as HTMLInputElement | null;
    roundSearchInput?.addEventListener('input', () => {
      this.roundMapSearchQuery = roundSearchInput.value.trim().toLowerCase();
      this.renderRoundSelectorPills();
    });

    // Room & Chat Slide-Over Drawer / Mobile Sheet
    const lobbyDrawer = document.getElementById('lobby-drawer')!;
    const lobbyToggleBtn = document.getElementById('btn-toggle-lobby')!;
    lobbyToggleBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      soundEngine.playUiClick();
      const willOpen = lobbyDrawer.classList.contains('hidden');
      this.dismissAllTransientOverlays();
      if (willOpen) {
        lobbyDrawer.classList.remove('hidden');
        lobbyToggleBtn.classList.add('active');
        lobbyToggleBtn.setAttribute('aria-expanded', 'true');
        this.unreadChatCount = 0;
        document.getElementById('lobby-unread-dot')?.classList.add('hidden');
      }
    });

    document
      .getElementById('btn-close-lobby')
      ?.addEventListener('click', () => {
        soundEngine.playUiClick();
        lobbyDrawer.classList.add('hidden');
        lobbyToggleBtn.classList.remove('active');
        lobbyToggleBtn.setAttribute('aria-expanded', 'false');
      });

    // Global Outside-Click Dismissal for Popovers & Armed Buttons
    window.addEventListener('click', (e) => {
      const target = e.target as HTMLElement;
      if (!target.closest('[data-armed="true"]')) {
        this.disarmAllButtons();
      }
      if (!target.closest('.round-selector-wrap')) {
        roundDropdown.classList.add('hidden');
        roundPickerBtn.classList.remove('active');
        roundPickerBtn.setAttribute('aria-expanded', 'false');
      }
      if (!target.closest('#standings-wrap')) {
        standingsDropdown.classList.add('hidden');
        standingsBtn.classList.remove('active');
        standingsBtn.setAttribute('aria-expanded', 'false');
      }
      if (!target.closest('#dock-tools-wrap')) {
        dockToolsPopover.classList.add('hidden');
        dockToolsBtn.classList.remove('active');
        dockToolsBtn.setAttribute('aria-expanded', 'false');
      }
      if (
        !target.closest('#lobby-drawer') &&
        !target.closest('#btn-toggle-lobby')
      ) {
        lobbyDrawer.classList.add('hidden');
        lobbyToggleBtn.classList.remove('active');
        lobbyToggleBtn.setAttribute('aria-expanded', 'false');
      }
    });

    // Modal-Guarded Desktop Keyboard Shortcuts
    window.addEventListener('keydown', (e) => {
      const activeEl = e.target as HTMLElement | null;
      const tag = activeEl?.tagName;
      if (
        tag === 'INPUT' ||
        tag === 'TEXTAREA' ||
        tag === 'SELECT' ||
        activeEl?.isContentEditable
      ) {
        if (e.code === 'Escape') {
          activeEl?.blur();
        }
        return;
      }

      if (e.code === 'Escape') {
        if (this.isHubOpen()) {
          if (this.activeMenuScreen === 'lobby') {
            return;
          }
          if (this.activeMenuScreen !== 'home') {
            this.openMenuScreen('home');
            return;
          }
          if (this.roomState && this.roomState.phase !== 'LOBBY') {
            this.closeHub();
          }
          return;
        }
        if (this.isHelpOpen()) {
          document.getElementById('help-modal')?.classList.add('hidden');
          this.syncModalOpenState();
          return;
        }
        const lobbyDrawerEl = document.getElementById('lobby-drawer');
        if (lobbyDrawerEl && !lobbyDrawerEl.classList.contains('hidden')) {
          this.dismissAllTransientOverlays();
          return;
        }
        if (this.armedTimers.size > 0) {
          this.disarmAllButtons();
          return;
        }
        if (this.dismissAllTransientOverlays()) {
          return;
        }
        const pillEl = document.getElementById('cursor-telemetry-pill');
        if (
          this.renderer3d.hasActiveTouchGhost() ||
          Boolean(
            pillEl &&
              !pillEl.classList.contains('hidden') &&
              pillEl.classList.contains('touch-inspect-card')
          )
        ) {
          this.renderer3d.cancelTouchGhost();
          this.hideTouchPrecisionTray();
          this.hideCursorPill();
          return;
        }
        if (
          this.roomState?.phase === 'BUILD' &&
          this.renderer3d.activeTool === 'SELL'
        ) {
          this.selectTool('BLOCK');
          return;
        }
        if (
          (this.isSpectatingRival() || this.renderer3d.arenaOverviewMode) &&
          this.localPlayerId &&
          !this.isResultsBlocking()
        ) {
          this.toggleOverviewOrReturnHome();
          return;
        }
        const resultsModal = document.getElementById('results-modal');
        if (
          resultsModal &&
          !resultsModal.classList.contains('hidden') &&
          resultsModal.classList.contains('peek-minimized')
        ) {
          resultsModal.classList.remove('peek-minimized');
          this.syncPeekMazesButton(false);
          this.syncModalOpenState();
          this.scheduleHudSafeInsetsSync();
        }
        return;
      }

      // Results Modal Shortcuts (Space / Enter -> Next Round)
      if (this.isResultsBlocking()) {
        if (e.code === 'Space' || e.code === 'Enter') {
          e.preventDefault();
          document.getElementById('btn-next-round')?.click();
        } else if (e.key.toUpperCase() === 'L') {
          this.openHub('leaderboard');
        }
        return;
      }

      // Hub hotkeys: M mute · H resume/close · L Leaderboard · ? How to Play
      if (this.isHubOpen()) {
        if (e.ctrlKey || e.metaKey || e.altKey) return;
        const hubKey = e.key.toUpperCase();
        if (hubKey === 'M') {
          soundEngine.toggleMuted();
          this.syncAudioMuteButtons();
        } else if (
          hubKey === 'H' &&
          this.roomState &&
          this.roomState.phase !== 'LOBBY'
        ) {
          this.closeHub();
        } else if (hubKey === 'L' && this.activeMenuScreen !== 'lobby') {
          this.openMenuScreen('leaderboard');
        } else if (e.key === '?' && this.activeMenuScreen !== 'lobby') {
          this.openMenuScreen('how-to-play');
        }
        return;
      }

      // Suppress arena hotkeys while Guide modal is open
      if (this.isHelpOpen()) {
        if (e.key.toUpperCase() === 'M') {
          soundEngine.toggleMuted();
          this.syncAudioMuteButtons();
        }
        return;
      }

      const key = e.key.toUpperCase();

      // Redo: Ctrl+Y / Ctrl+Shift+Z (Cmd on macOS). Bare Shift+Z is intentionally unbound.
      if (
        (e.ctrlKey || e.metaKey) &&
        (key === 'Y' || (key === 'Z' && e.shiftKey))
      ) {
        e.preventDefault();
        this.performRedo();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && key === 'Z' && !e.shiftKey) {
        e.preventDefault();
        this.performUndo();
        return;
      }
      if (e.ctrlKey || e.metaKey || e.altKey) return;

      if (key === 'Z' && !e.shiftKey) {
        e.preventDefault();
        this.performUndo();
      } else if (key === 'Q' || key === 'B') {
        this.selectTool('BLOCK');
      } else if (key === 'X' || key === 'E') {
        this.selectTool('SELL');
      } else if (key === 'R') {
        this.hideTransientPopovers();
        this.renderer3d.resetToMyIsland();
        this.syncSpectatorStateDOM();
        this.updateUndoAndToolAvailability();
        this.updateScoreboardDOM();
        this.scheduleHudSafeInsetsSync();
      } else if (key === 'M') {
        soundEngine.toggleMuted();
        this.syncAudioMuteButtons();
      } else if (key === 'C') {
        document.getElementById('btn-toggle-lobby')?.click();
      } else if (e.key === '?') {
        document.getElementById('btn-help')?.click();
      } else if (key === 'H') {
        this.openHub('play');
      } else if (key === 'L') {
        this.openHub('leaderboard');
      } else if (e.code === 'Space') {
        e.preventDefault();
        if (this.roomState?.phase === 'BUILD') {
          document.getElementById('btn-ready-lock')?.click();
        } else if (
          this.roomState?.phase === 'ROUND_RESULTS' ||
          this.roomState?.phase === 'GAME_OVER'
        ) {
          document.getElementById('btn-next-round')?.click();
        }
      } else if (key === '0' || e.code === 'Tab') {
        e.preventDefault();
        this.toggleOverviewOrReturnHome();
      } else if (['1', '2', '3', '4', '5', '6'].includes(key)) {
        const idx = Number(key) - 1;
        const targetId =
          this.sortedStandingsIds[idx] || this.roomState?.players[idx]?.id;
        if (targetId) {
          this.renderer3d.cancelTouchGhost();
          this.hideTouchPrecisionTray();
          this.hideCursorPill();
          this.renderer3d.focusOnPlayerIsland(targetId);
          this.syncSpectatorStateDOM();
          this.updateUndoAndToolAvailability();
          this.updateScoreboardDOM();
          this.scheduleHudSafeInsetsSync();
        }
      }
    });

    // Playback Speed Controls (Both Top Bar & Mobile #hud-run-dock; Host-Guarded)
    document
      .querySelectorAll<HTMLButtonElement>('.speed-btn')
      .forEach((btn) => {
        btn.addEventListener('click', () => {
          if (!this.ensureConnectedForAction()) return;
          if (!this.canControlRoomRules()) {
            this.showToast('Only the room host can change run speed.');
            return;
          }
          soundEngine.playUiClick();
          const spd = Number(btn.dataset.speed) as 1 | 2 | 4;
          this.send({ type: 'SET_SIM_SPEED', speed: spd });
        });
      });

    // Clear All (2-Tap Guarded + Undoable via BATCH_REPLACE; Preserves Sticky usedSampleMaze)
    const clearMazeBtn = document.getElementById('btn-clear-maze');
    clearMazeBtn?.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!this.ensureConnectedForAction()) return;
      const me = this.getLocalPlayer();
      if (!me || me.towers.length === 0 || this.roomState?.phase !== 'BUILD') {
        return;
      }
      this.armDestructiveButton(
        clearMazeBtn,
        true,
        'Confirm Clear',
        'trash',
        () => {
          const previousTowers = me.towers.map((t) => ({ x: t.x, y: t.y }));
          const previousUsedSampleMaze = Boolean(me.usedSampleMaze);
          const seq = this.nextSeq();
          this.redoStack = [];
          this.pushUndo({
            kind: 'BATCH_REPLACE',
            previousTowers,
            previousUsedSampleMaze,
            seq,
          });
          this.pendingMutations.push({ seq, kind: 'CLEAR' });

          me.towers = [];
          me.gold = this.roomState!.roundConfig.startingGold;
          me.ready = false;

          this.renderer3d.cancelTouchGhost();
          this.hideTouchPrecisionTray();
          this.hideCursorPill();
          this.hideTransientPopovers();

          this.renderer3d.syncRoomState(this.roomState!, this.localPlayerId);
          const evalRes = this.renderer3d.getLocalMazeEval();
          if (evalRes) {
            me.pathDistance = Number(evalRes.distance.toFixed(1));
          }

          soundEngine.playSell();
          soundEngine.haptic('sell');
          this.updateUndoAndToolAvailability();
          this.updateTopBarAndResources();
          this.updateScoreboardDOM();
          this.showToast('Cleared walls. Press Undo to restore.', true);
          this.send({ type: 'CLEAR_TOWERS', clientSeq: seq });
        }
      );
    });

    // New Map (2-Tap Guarded)
    const rerollBtn = document.getElementById('btn-reroll-map');
    rerollBtn?.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!this.ensureConnectedForAction()) return;
      if (!this.canControlRoomRules()) {
        this.showToast('Only the room host can generate a new map.');
        return;
      }
      this.armDestructiveButton(
        rerollBtn,
        true,
        'Confirm New Map',
        'dice',
        () => {
          soundEngine.playCheckpoint();
          this.renderer3d.cancelTouchGhost();
          this.hideTouchPrecisionTray();
          this.hideCursorPill();
          this.hideTransientPopovers();
          this.send({ type: 'REROLL_MAP' });
        }
      );
    });

    // Sample Maze (2-Tap Guarded When Walls Exist + Undoable)
    const sampleBtn = document.getElementById('btn-demo-layout');
    sampleBtn?.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!this.ensureConnectedForAction()) return;
      const me = this.getLocalPlayer();
      if (!me || this.roomState?.phase !== 'BUILD') return;

      const hasWalls = me.towers.length > 0;
      this.armDestructiveButton(
        sampleBtn,
        hasWalls,
        'Replace Walls?',
        'wand',
        () => {
          const previousTowers = me.towers.map((t) => ({ x: t.x, y: t.y }));
          const previousUsedSampleMaze = Boolean(me.usedSampleMaze);
          const seq = this.nextSeq();
          this.redoStack = [];
          this.pushUndo({
            kind: 'BATCH_REPLACE',
            previousTowers,
            previousUsedSampleMaze,
            seq,
          });
          this.pendingMutations.push({ seq, kind: 'SAMPLE' });

          soundEngine.playBuild('SAMPLE', 0);
          soundEngine.haptic('build');
          this.renderer3d.cancelTouchGhost();
          this.hideTouchPrecisionTray();
          this.hideCursorPill();
          this.hideTransientPopovers();
          this.updateUndoAndToolAvailability();
          this.send({ type: 'LOAD_PRESET_DEMO', clientSeq: seq });
        }
      );
    });

    // Reset Camera View
    document
      .getElementById('btn-reset-camera')
      ?.addEventListener('click', () => {
        soundEngine.playUiClick();
        this.hideTransientPopovers();
        this.renderer3d.resetToMyIsland();
        this.syncSpectatorStateDOM();
        this.updateUndoAndToolAvailability();
        this.updateScoreboardDOM();
        this.scheduleHudSafeInsetsSync();
      });

    // Ready / Start Button (2-Tap Guarded on 0-Wall Solo Start)
    const readyBtn = document.getElementById('btn-ready-lock');
    readyBtn?.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!this.ensureConnectedForAction()) return;
      const me = this.getLocalPlayer();
      if (!me || this.roomState?.phase !== 'BUILD') return;

      const isEmptySoloStart =
        !me.ready && me.towers.length === 0 && this.getHumanCount() <= 1;

      this.armDestructiveButton(
        readyBtn,
        isEmptySoloStart,
        window.innerWidth <= 385 ? 'Empty?' : 'Start Empty?',
        'play',
        () => {
          const nextReady = !me.ready;
          const seq = this.nextSeq();
          me.ready = nextReady;
          this.pendingMutations.push({ seq, kind: 'READY', ready: nextReady });
          soundEngine.playReady(nextReady);
          soundEngine.haptic('ready');
          this.renderer3d.cancelTouchGhost();
          this.hideTouchPrecisionTray();
          this.hideCursorPill();
          this.hideTransientPopovers();
          this.updateTopBarAndResources();
          this.updateScoreboardDOM();
          this.send({ type: 'TOGGLE_READY', clientSeq: seq });
        }
      );
    });

    // Spectator Return to My Island
    document
      .getElementById('btn-return-my-island')
      ?.addEventListener('click', () => {
        soundEngine.playUiClick();
        if (this.localPlayerId) {
          this.renderer3d.focusOnPlayerIsland(this.localPlayerId);
          this.syncSpectatorStateDOM();
          this.updateUndoAndToolAvailability();
          this.updateScoreboardDOM();
          this.scheduleHudSafeInsetsSync();
        }
      });

    // Top Overview & Mobile Run Dock Overview Toggles
    document
      .getElementById('btn-camera-overview')
      ?.addEventListener('click', () => {
        soundEngine.playUiClick();
        this.toggleOverviewOrReturnHome();
      });

    document
      .getElementById('btn-run-overview-toggle')
      ?.addEventListener('click', () => {
        soundEngine.playUiClick();
        this.toggleOverviewOrReturnHome();
      });

    // Results Modal: View Mazes Peek Toggle & Next Round (Host + Guest Ready Vote)
    document
      .getElementById('btn-peek-mazes')
      ?.addEventListener('click', () => {
        soundEngine.playUiClick();
        const resultsModal = document.getElementById('results-modal');
        if (!resultsModal) return;
        const isPeeking = resultsModal.classList.toggle('peek-minimized');
        this.syncPeekMazesButton(isPeeking);
        this.syncModalOpenState();
        this.scheduleHudSafeInsetsSync();
      });

    document.getElementById('btn-next-round')?.addEventListener('click', () => {
      if (!this.ensureConnectedForAction()) return;
      soundEngine.playUiClick();
      const me = this.getLocalPlayer();
      if (me && !this.canControlRoomRules() && me.nextRoundReady) {
        this.showToast('Ready for next round. Waiting for other players.', true);
        return;
      }
      this.send({ type: 'NEXT_ROUND' });
    });

    // Audio Mute Toggles
    const handleToggleMute = () => {
      soundEngine.toggleMuted();
      this.syncAudioMuteButtons();
    };
    document
      .getElementById('btn-mute')
      ?.addEventListener('click', handleToggleMute);
    document
      .getElementById('btn-drawer-mute')
      ?.addEventListener('click', handleToggleMute);

    // Quick Guide Modal
    const helpModal = document.getElementById('help-modal')!;
    const closeHelp = () => {
      helpModal.classList.add('hidden');
      this.syncModalOpenState();
    };
    document.getElementById('btn-help')?.addEventListener('click', () => {
      soundEngine.playUiClick();
      this.dismissAllTransientOverlays();
      this.renderer3d.cancelTouchGhost();
      this.hideTouchPrecisionTray();
      this.hideCursorPill();
      helpModal.classList.remove('hidden');
      this.syncModalOpenState();
    });
    document
      .getElementById('btn-close-help')
      ?.addEventListener('click', closeHelp);
    document
      .getElementById('btn-close-help-x')
      ?.addEventListener('click', closeHelp);
    helpModal.addEventListener('click', (e) => {
      if (e.target === helpModal) {
        closeHelp();
      }
    });

    // Room Drawer Controls
    const roomCodeBadge = document.getElementById('room-code-badge');
    roomCodeBadge?.addEventListener('click', () => {
      soundEngine.playUiClick();
      this.shareOrCopyInviteLink();
    });
    roomCodeBadge?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        soundEngine.playUiClick();
        this.shareOrCopyInviteLink();
      }
    });

    const nameInput = document.getElementById(
      'player-name-input'
    ) as HTMLInputElement | null;
    const commitDrawerName = () => {
      const val = (nameInput?.value || '').trim().slice(0, 18);
      if (val) {
        this.playerName = val;
        try {
          localStorage.setItem(NAME_STORAGE_KEY, val);
        } catch {
          // ignore
        }
        const hubName = document.getElementById(
          'hub-player-name-input'
        ) as HTMLInputElement | null;
        if (hubName) hubName.value = val;
        this.send({ type: 'SET_NAME', playerName: val });
      }
    };
    nameInput?.addEventListener('change', commitDrawerName);
    nameInput?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        commitDrawerName();
        nameInput.blur();
      }
    });

    document
      .getElementById('btn-copy-invite')
      ?.addEventListener('click', () => {
        this.shareOrCopyInviteLink();
      });

    document.getElementById('btn-add-bot')?.addEventListener('click', () => {
      if (!this.ensureConnectedForAction()) return;
      if (!this.canControlRoomRules()) {
        this.showToast('Only the room host can add bots.');
        return;
      }
      soundEngine.playUiClick();
      this.send({ type: 'ADD_BOT' });
    });

    document.getElementById('btn-remove-bot')?.addEventListener('click', () => {
      if (!this.ensureConnectedForAction()) return;
      if (!this.canControlRoomRules()) {
        this.showToast('Only the room host can remove bots.');
        return;
      }
      soundEngine.playUiClick();
      this.send({ type: 'REMOVE_BOT' });
    });

    const fogChk = document.getElementById(
      'chk-fog'
    ) as HTMLInputElement | null;
    fogChk?.addEventListener('change', () => {
      if (!this.ensureConnectedForAction()) {
        fogChk.checked = Boolean(this.roomState?.settings?.fogOfWar);
        return;
      }
      if (!this.canControlRoomRules()) {
        fogChk.checked = Boolean(this.roomState?.settings?.fogOfWar);
        this.showToast('Only the room host can change rival visibility.');
        return;
      }
      soundEngine.playUiClick();
      this.send({
        type: 'UPDATE_SETTINGS',
        settings: { fogOfWar: fogChk.checked },
      });
    });

    const chatForm = document.getElementById(
      'chat-form'
    ) as HTMLFormElement | null;
    const chatInput = document.getElementById(
      'chat-input'
    ) as HTMLInputElement | null;
    chatInput?.addEventListener('focus', () => {
      lobbyDrawer.classList.add('chat-input-focused');
    });
    chatInput?.addEventListener('blur', () => {
      lobbyDrawer.classList.remove('chat-input-focused');
    });
    chatForm?.addEventListener('submit', (e) => {
      e.preventDefault();
      if (!chatInput) return;
      if (!this.ensureConnectedForAction()) return;
      const text = chatInput.value.trim();
      if (text) {
        this.send({ type: 'CHAT', text });
        chatInput.value = '';
      }
    });
  }

  private selectTool(tool: ActiveBuildTool) {
    this.renderer3d.activeTool = tool;
    if (tool === 'PAN') {
      this.renderer3d.cancelTouchGhost();
      this.hideTouchPrecisionTray();
      this.hideCursorPill();
    }
    document
      .querySelectorAll<HTMLButtonElement>('#tower-buttons .dock-tool-btn')
      .forEach((btn) => {
        btn.classList.toggle('active', btn.dataset.tool === tool);
      });
  }

  private renderRoundSelectorPills() {
    const container = document.getElementById('round-pills');
    if (!container) return;
    container.innerHTML = '';

    const canSwitchRounds = this.canControlRoomRules();
    const activeRoundIdx = this.roomState?.currentRoundIndex ?? 0;
    const activeMapId =
      this.roomState?.roundConfig?.mapId ??
      this.roomState?.roundConfig?.roundNumber ??
      1;
    const totalMatchRounds =
      this.roomState?.settings?.totalRounds || DEFAULT_MATCH_ROUNDS;

    const matchTabBtn = document.querySelector<HTMLButtonElement>(
      '#round-switcher-tabs .round-tab-btn[data-round-tab="match"]'
    );
    if (matchTabBtn) {
      matchTabBtn.textContent = `Match (${totalMatchRounds})`;
    }
    const catalogTabBtn = document.querySelector<HTMLButtonElement>(
      '#round-switcher-tabs .round-tab-btn[data-round-tab="catalog"]'
    );
    if (catalogTabBtn) {
      catalogTabBtn.textContent = `All ${ROUNDS.length} Maps`;
    }

    const closeRoundDropdown = () => {
      document.getElementById('round-dropdown')?.classList.add('hidden');
      const pickerBtn = document.getElementById('btn-round-picker');
      pickerBtn?.classList.remove('active');
      pickerBtn?.setAttribute('aria-expanded', 'false');
    };

    if (this.roundSwitcherTab === 'match') {
      const matchIds =
        this.roomState?.matchMapIds && this.roomState.matchMapIds.length > 0
          ? this.roomState.matchMapIds
          : ROUNDS.slice(0, totalMatchRounds).map(
              (r) => r.mapId ?? r.roundNumber
            );

      matchIds.forEach((mapId, idx) => {
        const r = getMapById(mapId);
        const btn = document.createElement('button');
        btn.type = 'button';
        const isActive = idx === activeRoundIdx;
        btn.className = `round-pill-btn${isActive ? ' active' : ''}${
          !canSwitchRounds && !isActive ? ' disabled' : ''
        }`;
        btn.dataset.roundIdx = String(idx);
        btn.setAttribute('aria-disabled', String(!canSwitchRounds && !isActive));
        const arch = RUNNER_ARCHETYPES[r.runnerType || 'SCOUT'];
        btn.innerHTML = `
          <span class="r-left">
            <span class="r-num">R${idx + 1}</span>
            <span class="r-title">${escapeHtml(r.title)}</span>
          </span>
          <span class="r-arch" title="${escapeHtml(arch.name)}">${getRunnerIcon(
            r.runnerType || 'SCOUT',
            14
          )}</span>
        `;
        btn.title = `Round ${idx + 1} · Map #${mapId}: ${r.title} (${arch.name} · ${r.subtitle})`;
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          if (this.roomState?.currentRoundIndex === idx) {
            closeRoundDropdown();
            return;
          }
          if (!this.canControlRoomRules()) {
            this.showToast('Only the room host can switch rounds.');
            return;
          }
          const me = this.getLocalPlayer();
          const hasWalls = Boolean(
            this.roomState?.phase === 'BUILD' && me && me.towers.length > 0
          );
          this.armDestructiveButton(
            btn,
            hasWalls,
            `Switch to R${idx + 1}?`,
            'arrowRight',
            () => {
              this.send({ type: 'JUMP_TO_ROUND', roundIndex: idx });
              closeRoundDropdown();
            }
          );
        });
        container.appendChild(btn);
      });
      return;
    }

    // All 58 Maps catalog browser
    const query = this.roundMapSearchQuery;
    const filtered = query
      ? ROUNDS.filter((r) => {
          const id = r.mapId ?? r.roundNumber;
          const arch = RUNNER_ARCHETYPES[r.runnerType || 'SCOUT'];
          const hay = `#${id} ${r.title} ${r.subtitle} ${arch.name}`.toLowerCase();
          return hay.includes(query);
        })
      : ROUNDS;

    if (filtered.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'round-pills-empty';
      empty.textContent = 'No maps match that filter.';
      container.appendChild(empty);
      return;
    }

    filtered.forEach((r) => {
      const mapId = r.mapId ?? r.roundNumber;
      const btn = document.createElement('button');
      btn.type = 'button';
      const isActive = mapId === activeMapId;
      btn.className = `round-pill-btn${isActive ? ' active' : ''}${
        !canSwitchRounds && !isActive ? ' disabled' : ''
      }`;
      btn.dataset.mapId = String(mapId);
      btn.setAttribute('aria-disabled', String(!canSwitchRounds && !isActive));
      const arch = RUNNER_ARCHETYPES[r.runnerType || 'SCOUT'];
      btn.innerHTML = `
        <span class="r-left">
          <span class="r-num">#${mapId}</span>
          <span class="r-title">${escapeHtml(r.title)}</span>
        </span>
        <span class="r-arch" title="${escapeHtml(arch.name)}">${getRunnerIcon(
          r.runnerType || 'SCOUT',
          14
        )}</span>
      `;
      btn.title = `Map #${mapId}: ${r.title} (${r.subtitle} · Par ${r.parTimeSeconds}s+)`;
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (
          (this.roomState?.roundConfig?.mapId ??
            this.roomState?.roundConfig?.roundNumber) === mapId
        ) {
          closeRoundDropdown();
          return;
        }
        if (!this.canControlRoomRules()) {
          this.showToast('Only the room host can switch maps.');
          return;
        }
        const me = this.getLocalPlayer();
        const hasWalls = Boolean(
          this.roomState?.phase === 'BUILD' && me && me.towers.length > 0
        );
        this.armDestructiveButton(
          btn,
          hasWalls,
          `Load #${mapId}?`,
          'arrowRight',
          () => {
            this.send({ type: 'JUMP_TO_ROUND', mapId });
            closeRoundDropdown();
          }
        );
      });
      container.appendChild(btn);
    });
  }

  // ==========================================================================
  // TOP BAR, STANDINGS, RESULTS MODAL & CHAT DOM UPDATES
  // ==========================================================================

  private updateTopBarAndResources() {
    if (!this.roomState) return;
    const round = this.roomState.roundConfig;
    const archKey = round.runnerType || 'SCOUT';
    const arch = RUNNER_ARCHETYPES[archKey];
    const totalRounds =
      this.roomState.settings?.totalRounds || DEFAULT_MATCH_ROUNDS;
    const effectivePar = round.parTimeSeconds;
    const mapId = round.mapId ?? round.roundNumber;

    const isDaily = this.roomState.mode === 'DAILY';
    document.getElementById('round-code-label')!.textContent = isDaily
      ? `DAILY #${this.roomState.dailyPuzzleNumber || 1}`
      : `R${round.roundNumber}/${totalRounds}`;
    document.getElementById('round-subtitle')!.textContent = isDaily
      ? round.title.replace(/^Daily #\d+\s*·\s*/i, '')
      : round.title;
    document.getElementById('btn-round-picker')!.title = isDaily
      ? `${round.title} · ${arch.name} (${arch.traitSummary})`
      : `Round ${round.roundNumber} · Map #${mapId}/${ROUNDS.length}: ${round.title} · ${arch.name} (${arch.traitSummary})`;

    const runnerBadge = document.getElementById('round-runner-badge');
    if (runnerBadge) {
      runnerBadge.innerHTML = getRunnerIcon(archKey, 13);
      runnerBadge.title = `${arch.name}: ${arch.traitSummary}`;
    }

    // Populate Round Inspect Header inside #round-dropdown
    const inspectTitle = document.getElementById('round-inspect-title');
    if (inspectTitle) {
      inspectTitle.textContent = isDaily
        ? round.title
        : `Round ${round.roundNumber} · ${round.title} (Map #${mapId})`;
    }
    const inspectRunner = document.getElementById('round-inspect-runner');
    if (inspectRunner) {
      inspectRunner.innerHTML = `${getRunnerIcon(archKey, 14)}<span>${escapeHtml(
        arch.name
      )} · ${escapeHtml(arch.traitSummary)}</span>`;
    }
    const inspectHint = document.getElementById('round-inspect-hint');
    if (inspectHint) {
      inspectHint.textContent = round.hint;
    }

    document.getElementById('room-code-badge')!.textContent =
      this.roomState.roomCode;
    const hubRoomBadge = document.getElementById('hub-active-room-badge');
    if (hubRoomBadge) {
      hubRoomBadge.textContent = this.roomState.roomCode;
    }

    document.getElementById('lobby-count-badge')!.textContent = String(
      this.roomState.players.length
    );

    const stormCount = round.preplacedSpires.filter(
      (s) => !s.spireType || s.spireType === 'THUNDERCLAP'
    ).length;
    const frostCount = round.preplacedSpires.filter(
      (s) => s.spireType === 'FROST_OBELISK'
    ).length;
    const chronoCount = round.preplacedSpires.filter(
      (s) => s.spireType === 'CHRONO_SPIRE'
    ).length;

    const featureParts: string[] = [];
    if (stormCount > 0) featureParts.push(`${stormCount} ${icon('bolt', 12)}`);
    if (frostCount > 0) featureParts.push(`${frostCount} ${icon('frost', 12)}`);
    if (chronoCount > 0)
      featureParts.push(`${chronoCount} ${icon('chrono', 12)}`);
    featureParts.push(`${round.obstacles.length} ${icon('keep', 12)}`);
    const waystoneCount = round.checkpoints?.length ?? 0;
    if (waystoneCount > 0) {
      featureParts.push(
        `${waystoneCount} ${icon('target', 12)} ${
          waystoneCount === 1 ? 'Waystone' : 'Waystones'
        }`
      );
    }

    const featuresEl = document.getElementById('map-features-summary');
    if (featuresEl) {
      featuresEl.innerHTML = featureParts.join(' · ');
    }

    const phaseDot = document.getElementById('phase-dot')!;
    const phaseLabel = document.getElementById('phase-label')!;
    const speedControls = document.getElementById('speed-controls')!;

    if (this.roomState.phase === 'PLANNING') {
      phaseDot.className = 'phase-dot plan';
      phaseLabel.textContent = 'PLAN';
      speedControls.classList.add('hidden');
    } else if (this.roomState.phase === 'BUILD') {
      phaseDot.className = 'phase-dot build';
      phaseLabel.textContent = 'BUILD';
      speedControls.classList.add('hidden');
    } else if (this.roomState.phase === 'RUN') {
      phaseDot.className = 'phase-dot run';
      phaseLabel.textContent = 'RUN';
      speedControls.classList.remove('hidden');
    } else {
      phaseDot.className = 'phase-dot build';
      phaseLabel.textContent =
        this.roomState.phase === 'GAME_OVER' ? 'FINAL' : 'STANDINGS';
      speedControls.classList.add('hidden');
    }

    this.updateTimerDOM(false);

    const canControlSpeed = this.canControlRoomRules();
    document.querySelectorAll<HTMLButtonElement>('.speed-btn').forEach((b) => {
      b.classList.toggle(
        'active',
        Number(b.dataset.speed) === this.roomState?.simSpeedMultiplier
      );
      b.disabled = !canControlSpeed;
      b.title = canControlSpeed
        ? `Run Speed ${b.dataset.speed}×`
        : 'Host controls run speed';
    });

    const me = this.getLocalPlayer();
    if (me) {
      const wallsLeft = Math.floor(me.gold / TOWER_SPECS.BLOCK.goldCost);

      // Optional legacy #gold-value / #walls-chip null-safe support
      const goldEl = document.getElementById('gold-value');
      if (goldEl) {
        goldEl.textContent = `${wallsLeft}`;
      }

      const dockBadge = document.getElementById('dock-pillars-badge');
      if (dockBadge) {
        dockBadge.textContent = `${wallsLeft}`;
        dockBadge.classList.toggle('empty', wallsLeft === 0);
      }

      const evalRun = this.renderer3d.getLocalMazeEval();
      const estSecs = evalRun?.finishTimeSeconds ?? 0;
      const parLabel = formatParTarget(effectivePar);
      const estEl = document.getElementById('est-time-value');
      if (estEl && this.roomState.phase !== 'RUN') {
        estEl.innerHTML = `<span class="time-verb">Est </span>${estSecs.toFixed(
          1
        )}s<span class="par-full"> · Par </span><span class="par-short">/</span>${escapeHtml(
          parLabel
        )}`;
        estEl.style.color =
          estSecs >= effectivePar
            ? 'var(--accent-sage)'
            : 'var(--text-primary)';
      }

      const timeChip = document.getElementById('time-chip');
      if (timeChip && evalRun) {
        timeChip.title = `Estimated Run: ${estSecs.toFixed(
          1
        )}s · Par ${parLabel} for +2 bonus pts · Spire Hits: ${
          evalRun.clapsTaken
        } · Linked Keeps: ${evalRun.linkedKeeps}/${
          round.obstacles.length
        } · Overcharge: ${evalRun.overchargedSpires}`;
      }

      const readyBtn = document.getElementById('btn-ready-lock')!;
      const readyText = document.getElementById('ready-btn-text')!;
      const readyIcon = document.getElementById('ready-btn-icon')!;
      if (!this.armedTimers.has(readyBtn)) {
        if (me.ready) {
          readyBtn.classList.add('locked-in');
          readyIcon.classList.remove('hidden');
          readyText.textContent = 'Ready';
        } else {
          readyBtn.classList.remove('locked-in');
          readyIcon.classList.add('hidden');
          readyText.textContent =
            this.getHumanCount() <= 1 ? 'Start' : 'Ready';
        }
      }
    }

    const canSwitchRounds = this.canControlRoomRules();
    const matchSig = `${(this.roomState.matchMapIds || []).join(',')}|${
      this.roomState.currentRoundIndex
    }|${mapId}|${canSwitchRounds}`;
    if (matchSig !== this.lastMatchMapSignature) {
      this.lastMatchMapSignature = matchSig;
      this.renderRoundSelectorPills();
    } else {
      document
        .querySelectorAll<HTMLButtonElement>('.round-pill-btn')
        .forEach((btn) => {
          const isActive =
            this.roundSwitcherTab === 'match'
              ? Number(btn.dataset.roundIdx) === this.roomState?.currentRoundIndex
              : Number(btn.dataset.mapId) === mapId;
          btn.classList.toggle('active', isActive);
          btn.classList.toggle('disabled', !canSwitchRounds && !isActive);
          btn.setAttribute(
            'aria-disabled',
            String(!canSwitchRounds && !isActive)
          );
        });
    }
    const switcherNote = document.querySelector<HTMLElement>(
      '#round-switcher-header .dropdown-subtle-note'
    );
    if (switcherNote) {
      switcherNote.textContent = canSwitchRounds
        ? 'Host · Resets current walls'
        : 'Host only';
    }
  }

  private updateTimerDOM(fromTick: boolean) {
    if (!this.roomState) return;
    if (
      this.roomState.phase === 'BUILD' &&
      this.roomState.settings?.buildTimeSeconds === 999
    ) {
      document.getElementById('timer-display')!.textContent = '∞';
      return;
    }

    const secs = Math.max(0, Math.ceil(this.roomState.phaseTimeRemaining));
    const mm = String(Math.floor(secs / 60)).padStart(2, '0');
    const ss = String(secs % 60).padStart(2, '0');
    document.getElementById('timer-display')!.textContent = `${mm}:${ss}`;

    // Subtle countdown ticks in the final 5s of BUILD when player hasn't readied yet
    if (
      fromTick &&
      this.roomState.phase === 'BUILD' &&
      secs >= 1 &&
      secs <= 5 &&
      secs !== this.lastCountdownTickSec &&
      !this.getLocalPlayer()?.ready &&
      !this.isHubOpen()
    ) {
      this.lastCountdownTickSec = secs;
      soundEngine.playCountdownTick(secs <= 2);
    }
  }

  private updateScoreboardDOM() {
    if (!this.roomState) return;
    const list = document.getElementById('scoreboard-list')!;
    list.innerHTML = '';

    const awayFromHome =
      this.renderer3d.arenaOverviewMode || this.isSpectatingRival();

    const overviewBtn = document.getElementById('btn-camera-overview')!;
    const overviewIcon = document.getElementById('overview-icon')!;
    const overviewLabel = document.getElementById('overview-label')!;
    overviewBtn.classList.toggle('active', this.renderer3d.arenaOverviewMode);
    overviewIcon.innerHTML = icon(awayFromHome ? 'sanctum' : 'overview', 17);
    overviewLabel.textContent = awayFromHome ? 'My Island' : 'All Islands';

    const runOverviewBtn = document.getElementById('btn-run-overview-toggle');
    const runOverviewLabel = document.getElementById('run-overview-label');
    if (runOverviewBtn && runOverviewLabel) {
      runOverviewBtn.classList.toggle(
        'active',
        this.renderer3d.arenaOverviewMode
      );
      const slot = runOverviewBtn.querySelector('.icon-slot');
      if (slot) {
        slot.innerHTML = icon(awayFromHome ? 'sanctum' : 'overview', 16);
      }
      runOverviewLabel.textContent = awayFromHome ? 'My Island' : 'All Islands';
    }

    const sorted = [...this.roomState.players].sort(
      (a, b) =>
        b.totalScore - a.totalScore ||
        (b.parStarsEarned || 0) - (a.parStarsEarned || 0) ||
        b.bestMazeTime - a.bestMazeTime
    );
    this.sortedStandingsIds = sorted.map((p) => p.id);

    const countMeta = document.getElementById('standings-count-meta');
    if (countMeta) {
      countMeta.textContent = `${sorted.length} ${
        sorted.length === 1 ? 'Player' : 'Players'
      }`;
    }

    const targetId =
      (!this.renderer3d.arenaOverviewMode && this.renderer3d.focusedPlayerId) ||
      this.localPlayerId;
    let featuredIdx = sorted.findIndex((p) => p.id === targetId);
    if (featuredIdx < 0) featuredIdx = 0;
    const featured = sorted[featuredIdx];

    if (featured) {
      const swatchEl = document.getElementById('standings-swatch');
      const summaryEl = document.getElementById('standings-summary');
      const scoreEl = document.getElementById('standings-score');
      const isMe = featured.id === this.localPlayerId;
      if (swatchEl) swatchEl.style.background = featured.color;
      if (summaryEl) {
        summaryEl.innerHTML = `<span class="rank-ord">${formatOrdinal(
          featuredIdx + 1
        )}</span><span class="rank-who"> · ${escapeHtml(
          isMe ? 'You' : featured.name
        )}</span>`;
      }
      if (scoreEl && this.roomState.phase !== 'RUN') {
        scoreEl.textContent = `${featured.totalScore} pts`;
        scoreEl.style.color = 'var(--text-secondary)';
      }
    }

    sorted.forEach((p, idx) => {
      const row = document.createElement('button');
      row.type = 'button';
      const isFocused =
        !this.renderer3d.arenaOverviewMode &&
        (this.renderer3d.focusedPlayerId || this.localPlayerId) === p.id;
      const isMe = p.id === this.localPlayerId;
      row.className = `standings-row${isFocused ? ' focused' : ''}${
        isMe ? ' is-me' : ''
      }`;

      const readyHtml =
        this.roomState?.phase === 'BUILD' && p.ready
          ? `<span class="standings-ready-icon" title="Ready">${icon(
              'check',
              13
            )}</span>`
          : '';
      const botHtml = p.isBot ? `<span class="bot-badge">BOT</span>` : '';
      const youHtml = isMe ? `<span class="you-badge">You</span>` : '';
      const distMeta = p.fogMasked ? 'Hidden' : `${p.pathDistance.toFixed(0)}m`;

      row.title = `View ${p.name}'s Island (${p.totalScore} pts · ${distMeta})`;
      row.innerHTML = `
        <span class="standings-row-left">
          <span class="standings-rank">${idx + 1}.</span>
          <span class="player-swatch" style="background:${escapeHtml(
            p.color
          )}"></span>
          <span class="standings-name">${escapeHtml(p.name)}</span>
          ${youHtml}
          ${botHtml}
          ${readyHtml}
        </span>
        <span class="standings-row-right" id="sub-telemetry-${p.id}">${
        p.totalScore
      } pts</span>
      `;

      row.addEventListener('click', () => {
        soundEngine.playUiClick();
        this.renderer3d.cancelTouchGhost();
        this.hideTouchPrecisionTray();
        this.hideCursorPill();
        this.renderer3d.focusOnPlayerIsland(p.id);
        document.getElementById('standings-dropdown')?.classList.add('hidden');
        document
          .getElementById('btn-standings-toggle')
          ?.classList.remove('active');
        document
          .getElementById('btn-standings-toggle')
          ?.setAttribute('aria-expanded', 'false');
        this.syncSpectatorStateDOM();
        this.updateUndoAndToolAvailability();
        this.updateScoreboardDOM();
        this.scheduleHudSafeInsetsSync();
      });

      list.appendChild(row);
    });
  }

  private renderDrawerRoster() {
    if (!this.roomState) return;
    const roster = document.getElementById('drawer-player-roster');
    if (roster) {
      roster.innerHTML = this.roomState.players
        .map((p) => {
          const isMe = p.id === this.localPlayerId;
          const offline = p.connected === false;
          const roleBadge = p.isBot
            ? '<span class="bot-badge">BOT</span>'
            : p.isHost
            ? '<span class="bot-badge">HOST</span>'
            : '';
          const youBadge = isMe ? '<span class="you-badge">You</span>' : '';
          const readyMark =
            this.roomState?.phase === 'BUILD' && p.ready
              ? `<span class="standings-ready-icon" title="Ready">${icon(
                  'check',
                  12
                )}</span>`
              : '';
          return `
            <span class="drawer-roster-chip${offline ? ' offline' : ''}">
              <span class="player-swatch" style="background:${escapeHtml(
                p.color
              )}"></span>
              <span>${escapeHtml(p.name)}</span>
              ${youBadge}
              ${roleBadge}
              ${readyMark}
              ${offline ? '<span class="inspect-meta">Offline</span>' : ''}
            </span>
          `;
        })
        .join('');
    }

    const canEdit = this.canControlRoomRules();
    const botCount = this.roomState.players.filter((p) => p.isBot).length;
    const addBotBtn = document.getElementById(
      'btn-add-bot'
    ) as HTMLButtonElement | null;
    if (addBotBtn) {
      addBotBtn.disabled = !canEdit || this.roomState.players.length >= 6;
    }
    const remBotBtn = document.getElementById(
      'btn-remove-bot'
    ) as HTMLButtonElement | null;
    if (remBotBtn) {
      remBotBtn.disabled = !canEdit || botCount <= 0;
    }
  }

  private updateLiveRunScoreboard() {
    if (!this.roomState) return;
    const activeTargetId =
      (!this.renderer3d.arenaOverviewMode && this.renderer3d.focusedPlayerId) ||
      this.localPlayerId;
    const pillScoreEl = document.getElementById('standings-score');
    const estEl = document.getElementById('est-time-value');
    const parSecs = this.roomState.roundConfig.parTimeSeconds;
    const parLabel = formatParTarget(parSecs);

    for (const [pid, sim] of this.simulators.entries()) {
      const liveSecs = sim.state.finished
        ? sim.state.finishTimeSeconds
        : sim.elapsedSeconds;
      const formatted = `${liveSecs.toFixed(1)}s`;
      const toneColor = sim.state.finished
        ? 'var(--accent-sage)'
        : 'var(--accent-gold)';

      const subKey = `sub:${pid}`;
      const subSig = `${sim.state.finished ? 'F' : 'R'}|${formatted}`;
      if (this.lastRunDomCache.get(subKey) !== subSig) {
        this.lastRunDomCache.set(subKey, subSig);
        const subEl = document.getElementById(`sub-telemetry-${pid}`);
        if (subEl) {
          subEl.innerHTML = sim.state.finished
            ? `${icon('flag', 12)} <span>${formatted}</span>`
            : formatted;
          subEl.style.color = toneColor;
        }
      }

      if (pid === activeTargetId) {
        const topKey = 'top:target';
        const beatPar = liveSecs >= parSecs;
        const topSig = `${pid}|${sim.state.finished ? 'F' : 'R'}|${formatted}|${
          beatPar ? 1 : 0
        }|${parLabel}`;
        if (this.lastRunDomCache.get(topKey) !== topSig) {
          this.lastRunDomCache.set(topKey, topSig);
          if (pillScoreEl) {
            pillScoreEl.textContent = formatted;
            pillScoreEl.style.color = toneColor;
          }
          if (estEl) {
            estEl.innerHTML = `<span class="time-verb">${
              sim.state.finished ? 'Done ' : 'Run '
            }</span>${formatted}<span class="par-full"> · Par </span><span class="par-short">/</span>${escapeHtml(
              parLabel
            )}`;
            estEl.style.color = beatPar
              ? 'var(--accent-sage)'
              : 'var(--text-primary)';
          }
        }
      }
    }
  }

  private updateResultsCountdownDOM() {
    if (!this.roomState) return;
    if (
      this.roomState.phase !== 'ROUND_RESULTS' &&
      this.roomState.phase !== 'GAME_OVER'
    ) {
      return;
    }
    const nextBtn = document.getElementById('btn-next-round');
    const nextBtnLabel = document.getElementById('next-round-label');
    if (!nextBtnLabel) return;

    const connectedHumans = this.roomState.players.filter(
      (p) => !p.isBot && p.connected !== false
    );
    const readyHumans = connectedHumans.filter((p) => p.nextRoundReady).length;
    const meReady = Boolean(this.getLocalPlayer()?.nextRoundReady);
    nextBtn?.classList.toggle('locked-in', meReady);

    if (this.roomState.phase === 'GAME_OVER') {
      if (connectedHumans.length > 1) {
        nextBtnLabel.textContent = meReady
          ? `Ready (${readyHumans}/${connectedHumans.length})`
          : `New Match (${readyHumans}/${connectedHumans.length})`;
      } else {
        nextBtnLabel.textContent = 'New Match';
      }
      return;
    }

    const secs = Math.max(0, Math.ceil(this.roomState.phaseTimeRemaining));
    if (connectedHumans.length > 1) {
      const prefix = meReady
        ? `Ready (${readyHumans}/${connectedHumans.length})`
        : `Next Round (${readyHumans}/${connectedHumans.length})`;
      nextBtnLabel.textContent = secs > 0 ? `${prefix} · ${secs}s` : prefix;
    } else {
      nextBtnLabel.textContent =
        secs > 0 ? `Next Round (${secs}s)` : 'Next Round';
    }
  }

  private renderRoundResultsModal(state: RoomState) {
    const round = state.roundConfig;
    const isDaily = state.mode === 'DAILY';
    const isGameOver = state.phase === 'GAME_OVER';
    const roundsDone = state.roundsCompleted || round.roundNumber;
    const totalRounds = state.settings?.totalRounds || DEFAULT_MATCH_ROUNDS;
    const parTarget =
      round.parTimeSeconds ||
      computeEffectivePar(28, state.settings?.goldMultiplier);
    const parLabel = formatParTarget(parTarget);

    const titleEl = document.getElementById('results-title')!;
    const subEl = document.getElementById('results-subtitle')!;
    const progressEl = document.getElementById('results-match-progress')!;
    const podiumEl = document.getElementById('results-podium')!;
    const recordCallout = document.getElementById('results-record-callout')!;
    const dailyPanel = document.getElementById('results-daily-panel');
    const tableEl = document.getElementById('results-table')!;
    const lbBtn = document.getElementById('btn-results-leaderboard');
    const shareDailyBtn = document.getElementById('btn-results-share-daily');
    const homeDailyBtn = document.getElementById('btn-results-home');
    const nextRoundBtn = document.getElementById('btn-next-round');

    if (isDaily) {
      const me = this.getLocalPlayer();
      const myTime = me?.lastRoundTime ?? 0;
      const beatPar = myTime >= parTarget;
      const d = this.dailyData;
      const standing = d?.myStanding;

      titleEl.textContent = `Daily Maze #${state.dailyPuzzleNumber || 1} Complete`;
      progressEl.textContent = d ? formatDailyDateLabel(d.dateKey) : 'Daily Maze';
      subEl.textContent = beatPar
        ? `You survived ${myTime.toFixed(2)}s and beat today's Par (${parLabel})!`
        : `You survived ${myTime.toFixed(2)}s · Today's Par was ${parLabel}.`;

      podiumEl.classList.add('hidden');
      recordCallout.classList.add('hidden');
      tableEl.classList.add('hidden');
      lbBtn?.classList.add('hidden');
      nextRoundBtn?.classList.add('hidden');
      shareDailyBtn?.classList.remove('hidden');
      homeDailyBtn?.classList.remove('hidden');

      const winnerPeekBtn = document.getElementById('btn-peek-winner');
      winnerPeekBtn?.classList.add('hidden');

      if (dailyPanel) {
        dailyPanel.classList.remove('hidden');
        const rankText = standing
          ? `#${standing.rank} of ${standing.totalParticipants} (Top ${standing.percentile}%)`
          : 'Recording rank…';
        dailyPanel.innerHTML = `
          <div class="daily-result-hero">
            <div class="daily-result-stat">
              <span class="daily-stat-label">Your Time</span>
              <strong>${myTime.toFixed(2)}s</strong>
            </div>
            <div class="daily-result-stat">
              <span class="daily-stat-label">Today's Rank</span>
              <strong>${escapeHtml(rankText)}</strong>
            </div>
            <div class="daily-result-stat">
              <span class="daily-stat-label">Spire Hits / Overcharge</span>
              <strong>${me?.lastRoundClaps || 0} / ${me?.lastRoundOvercharge || 0}</strong>
            </div>
          </div>
          <div class="daily-result-lb-head">Today's Top 10 Leaderboard</div>
          <div id="results-daily-top10" class="leaderboard-table-wrap daily-table-wrap"></div>
          ${
            standing && standing.rank > 10
              ? `<div class="daily-my-standing-bar">
                  <div class="standing-left">
                    <span class="you-badge">Your Position</span>
                    <strong>#${standing.rank}</strong>
                    <span>of ${standing.totalParticipants} (Top ${standing.percentile}%)</span>
                  </div>
                  <div class="standing-right">
                    <strong>${standing.entry.survivalTimeSeconds.toFixed(2)}s</strong>
                  </div>
                </div>`
              : ''
          }
        `;
        const top10Host = document.getElementById('results-daily-top10');
        if (top10Host && d) {
          this.renderDailyLeaderboardRows(top10Host, d);
        }
      }
      return;
    }

    // Standard Solo / Online Results view
    dailyPanel?.classList.add('hidden');
    tableEl.classList.remove('hidden');
    lbBtn?.classList.remove('hidden');
    nextRoundBtn?.classList.remove('hidden');
    shareDailyBtn?.classList.add('hidden');
    homeDailyBtn?.classList.add('hidden');

    // Inject / toggle Winner's Maze quick-focus button next to View Mazes
    const peekBtn = document.getElementById('btn-peek-mazes');
    let winnerPeekBtn = document.getElementById(
      'btn-peek-winner'
    ) as HTMLButtonElement | null;
    if (peekBtn && !winnerPeekBtn) {
      winnerPeekBtn = document.createElement('button');
      winnerPeekBtn.type = 'button';
      winnerPeekBtn.id = 'btn-peek-winner';
      winnerPeekBtn.className = 'mini-action-btn peek-winner-btn';
      winnerPeekBtn.title = "Focus Camera on the Leader's Maze";
      winnerPeekBtn.innerHTML = `${icon('crown', 14)}<span>Winner's Maze</span>`;
      winnerPeekBtn.addEventListener('click', () => {
        soundEngine.playUiClick();
        const resultsModal = document.getElementById('results-modal');
        if (resultsModal) {
          resultsModal.classList.add('peek-minimized');
          this.syncPeekMazesButton(true);
          this.syncModalOpenState();
        }
        const winnerId = this.renderer3d.focusWinnerIsland();
        if (winnerId) {
          this.syncSpectatorStateDOM();
          this.updateScoreboardDOM();
        }
        this.scheduleHudSafeInsetsSync();
      });
      peekBtn.parentElement?.insertBefore(winnerPeekBtn, peekBtn);
    }
    if (winnerPeekBtn) {
      winnerPeekBtn.classList.toggle('hidden', state.players.length <= 1);
    }

    progressEl.textContent = isGameOver
      ? `Final · ${totalRounds} Rounds`
      : `Round ${roundsDone} of ${totalRounds}`;

    if (state.newRecordHolders && state.newRecordHolders.length > 0) {
      recordCallout.classList.remove('hidden');
      recordCallout.innerHTML = `${icon(
        'trophy',
        15
      )} <span>New Top-5 Leaderboard Record on ${escapeHtml(
        round.title
      )} by ${escapeHtml(state.newRecordHolders.join(', '))}</span>`;
    } else {
      recordCallout.classList.add('hidden');
    }

    if (isGameOver) {
      titleEl.textContent = 'Match Complete';
      subEl.textContent = `Final career standings across ${totalRounds} rounds.`;
      this.updateResultsCountdownDOM();

      const overallRanked = [...state.players].sort(
        (a, b) =>
          b.totalScore - a.totalScore ||
          (b.parStarsEarned || 0) - (a.parStarsEarned || 0) ||
          b.bestMazeTime - a.bestMazeTime
      );
      podiumEl.classList.remove('hidden');
      podiumEl.innerHTML = '';

      overallRanked.slice(0, 3).forEach((p, idx) => {
        const card = document.createElement('div');
        const isMe = p.id === this.localPlayerId;
        const placeClass =
          idx === 0 ? ' first' : idx === 1 ? ' second' : ' third';
        card.className = `podium-card${placeClass}${isMe ? ' is-me' : ''}`;
        const medalSvg = getMedalBadge((idx + 1) as 1 | 2 | 3, 28);
        card.innerHTML = `
          <div class="podium-medal">${medalSvg}</div>
          <div class="podium-name">${escapeHtml(p.name)}${
          isMe ? ' (You)' : ''
        }</div>
          <div class="podium-pts">${p.totalScore} pts</div>
          <div class="podium-sub">Best ${p.bestMazeTime.toFixed(1)}s · ${
          p.parStarsEarned || 0
        } Par</div>
        `;
        podiumEl.appendChild(card);
      });
    } else {
      titleEl.textContent = `Round ${round.roundNumber} · ${round.title}`;
      const hasBots = state.players.some((p) => p.isBot);
      const skillSuffix = hasBots
        ? ` · Skill: ${formatBotSkillLabel(state.settings?.botDifficulty)}`
        : '';
      subEl.textContent = `Par Target: ${parLabel} (+2 bonus pts for beating Par)${skillSuffix}`;
      this.updateResultsCountdownDOM();
      podiumEl.classList.add('hidden');
    }

    const table = document.getElementById('results-table')!;
    table.innerHTML = '';

    const tableHead = document.createElement('div');
    tableHead.className = 'results-table-head';
    tableHead.innerHTML = isGameOver
      ? `
      <span>Player &amp; Match Totals</span>
      <span>Final Score &amp; Best Run</span>
    `
      : `
      <span>Player &amp; Maze Stats</span>
      <span>Run Time &amp; Score</span>
    `;
    table.appendChild(tableHead);

    const compareRoundRes = (a: PlayerState, b: PlayerState) =>
      (a.lastRoundRank ?? 99) - (b.lastRoundRank ?? 99) ||
      (b.lastRoundTime || 0) - (a.lastRoundTime || 0) ||
      (b.lastRoundOvercharge || 0) - (a.lastRoundOvercharge || 0) ||
      (b.lastRoundClaps || 0) - (a.lastRoundClaps || 0) ||
      (b.gold || 0) - (a.gold || 0);

    const ranked = [...state.players].sort((a, b) =>
      isGameOver
        ? b.totalScore - a.totalScore ||
          (b.parStarsEarned || 0) - (a.parStarsEarned || 0) ||
          b.bestMazeTime - a.bestMazeTime
        : compareRoundRes(a, b)
    );

    ranked.forEach((p, idx) => {
      const row = document.createElement('div');
      const isMe = p.id === this.localPlayerId;
      const displayRank = isGameOver ? idx + 1 : p.lastRoundRank ?? idx + 1;
      row.className = `result-row${displayRank === 1 ? ' winner' : ''}${
        isMe ? ' is-me' : ''
      }`;
      const rankHtml =
        displayRank <= 3
          ? getMedalBadge(displayRank as 1 | 2 | 3, 20)
          : `#${displayRank}`;
      const youBadge = isMe ? `<span class="you-badge">You</span>` : '';
      const botBadge = p.isBot ? `<span class="bot-badge">BOT</span>` : '';

      if (isGameOver) {
        const hist = p.roundHistory || [];
        const totalHits = hist.reduce((s, r) => s + (r.clapsTaken || 0), 0);
        const totalOver = hist.reduce(
          (s, r) => s + (r.overchargedSpires || 0),
          0
        );
        const roundsWon = hist.filter((r) => r.rank === 1).length;
        const parStars =
          p.parStarsEarned ?? hist.filter((r) => r.beatPar).length;
        const bestRun =
          p.bestMazeTime || Math.max(0, ...hist.map((r) => r.timeSeconds));
        const parBadge =
          parStars > 0
            ? `<span class="par-pill">${icon(
                'starFilled',
                10
              )}<span>${parStars} Par</span></span>`
            : '';
        const careerChips = `<span class="stat-chip" title="Match Totals">${icon(
          'trophy',
          11
        )} ${roundsWon}W · ${icon('bolt', 11)} ${totalHits} hits · ${icon(
          'diamondFilled',
          10
        )} ${totalOver}</span>`;

        row.innerHTML = `
          <div class="result-row-left">
            <span class="result-rank-slot">${rankHtml}</span>
            <span class="player-swatch" style="background:${escapeHtml(
              p.color
            )}"></span>
            <strong>${escapeHtml(p.name)}</strong>
            ${youBadge}
            ${botBadge}
            ${parBadge}
            ${careerChips}
          </div>
          <div class="result-stats">
            <strong style="color:var(--accent-sage)">${p.totalScore} pts</strong>
            <span style="color:var(--text-secondary)">Best ${bestRun.toFixed(
              1
            )}s</span>
          </div>
        `;
      } else {
        const beatPar =
          (p.lastRoundTime || 0) >= parTarget
            ? `<span class="par-pill">${icon(
                'starFilled',
                10
              )}<span>Par</span></span>`
            : '';
        const synBadges = `<span class="stat-chip" title="Spire Hits · Overcharge · Path">${icon(
          'bolt',
          11
        )} ${p.lastRoundClaps || 0} · ${icon('diamondFilled', 10)} ${
          p.lastRoundOvercharge || 0
        } · ${p.pathDistance.toFixed(0)}m</span>`;

        row.innerHTML = `
          <div class="result-row-left">
            <span class="result-rank-slot">${rankHtml}</span>
            <span class="player-swatch" style="background:${escapeHtml(
              p.color
            )}"></span>
            <strong>${escapeHtml(p.name)}</strong>
            ${youBadge}
            ${botBadge}
            ${beatPar}
            ${synBadges}
          </div>
          <div class="result-stats">
            <strong>${(p.lastRoundTime || 0).toFixed(2)}s</strong>
            <span style="color:var(--accent-sage)">+${p.lastRoundPoints} pts</span>
            <span style="color:var(--text-secondary)">(${p.totalScore} pts)</span>
          </div>
        `;
      }
      table.appendChild(row);
    });
  }

  private renderChat() {
    if (!this.roomState) return;
    const boxes = [
      document.getElementById('chat-messages'),
      document.getElementById('lobby-chat-messages'),
    ].filter((el): el is HTMLElement => Boolean(el));
    if (boxes.length === 0) return;

    const chat = this.roomState.chat;
    const last = chat[chat.length - 1];
    const chatSig = `${this.roomState.roomCode}|${chat.length}|${
      last ? `${last.id}|${last.text}` : ''
    }`;
    if (chatSig === this.lastChatSignature) return;
    this.lastChatSignature = chatSig;

    for (const box of boxes) {
      const prevScrollTop = box.scrollTop;
      const stickToBottom =
        box.scrollHeight - box.scrollTop - box.clientHeight < 48;
      box.innerHTML = '';
      for (const m of chat) {
        const div = document.createElement('div');
        div.className = `chat-line${m.isSystem ? ' system' : ''}`;
        if (m.isSystem) {
          div.textContent = m.text;
        } else {
          const swatch = document.createElement('span');
          swatch.className = 'player-swatch';
          swatch.style.background = m.senderColor;
          swatch.style.display = 'inline-block';
          swatch.style.verticalAlign = 'middle';
          swatch.style.marginRight = '5px';

          const strong = document.createElement('strong');
          strong.style.color = 'var(--text-primary)';
          strong.textContent = `${m.senderName}: `;

          const span = document.createElement('span');
          span.textContent = m.text;

          div.append(swatch, strong, span);
        }
        box.appendChild(div);
      }
      if (stickToBottom) {
        box.scrollTop = box.scrollHeight;
      } else {
        box.scrollTop = prevScrollTop;
      }
    }
  }

  private showToast(message: string, isPositive = false) {
    const container = document.getElementById('toast-container')!;
    // Cap stacked toasts at 3 (drop oldest) and skip exact duplicates already on screen
    const existing = Array.from(container.children) as HTMLElement[];
    if (existing.some((t) => t.textContent === message)) return;
    while (container.children.length >= 3) {
      container.firstElementChild?.remove();
    }
    const toast = document.createElement('div');
    toast.className = `toast-msg${isPositive ? ' positive' : ''}`;
    toast.textContent = message;
    container.appendChild(toast);
    setTimeout(() => {
      toast.remove();
    }, 3000);
  }
}

window.addEventListener('DOMContentLoaded', () => {
  new MazingContestClient();
});
