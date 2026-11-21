import {
  computeCitadelCircuitry,
  validateTowerPlacement,
} from '../shared/pathfinding.js';
import { computeEffectivePar, ROUNDS } from '../shared/rounds.js';
import { MazeRunnerSimulator, SIM_DT } from '../shared/simulation.js';
import {
  ActiveBuildTool,
  ClientToServerMessage,
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
  | { kind: 'PLACE'; x: number; y: number; clientId: string }
  | { kind: 'SELL'; x: number; y: number }
  | { kind: 'BATCH_REPLACE'; previousTowers: GridPoint[] };

interface ArmedButtonEntry {
  timer: number;
  restoreHtml: string;
}

const NAME_STORAGE_KEY = 'mc2026_player_name';
const SESSION_STORAGE_KEY = 'mc2026_session_id';
const SESSION_LEGACY_KEY = 'mc2026_session';

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

function readOrCreateSessionId(): string {
  try {
    const existing =
      localStorage.getItem(SESSION_STORAGE_KEY) ||
      localStorage.getItem(SESSION_LEGACY_KEY);
    if (existing && existing.trim().length >= 8) {
      const clean = existing.trim();
      localStorage.setItem(SESSION_STORAGE_KEY, clean);
      localStorage.setItem(SESSION_LEGACY_KEY, clean);
      return clean;
    }
    const generated = `sess_${Date.now().toString(36)}_${Math.random()
      .toString(36)
      .slice(2, 10)}`;
    localStorage.setItem(SESSION_STORAGE_KEY, generated);
    localStorage.setItem(SESSION_LEGACY_KEY, generated);
    return generated;
  } catch {
    return `sess_${Math.random().toString(36).slice(2, 12)}`;
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
  private roomState: RoomState | null = null;
  private roomCode: string;
  private playerName: string;

  private lobbies: LobbyRoomSummary[] = [];
  private leaderboard: LeaderboardPayload | null = null;
  private activeHubTab: 'play' | 'leaderboard' | 'codex' = 'play';
  private leaderboardMode: 'rounds' | 'champions' = 'rounds';
  private selectedLeaderboardRound = 1;

  private simulators = new Map<string, MazeRunnerSimulator>();
  private simAccumulator = 0;
  private runPhaseActive = false;

  private undoStack: UndoEntry[] = [];
  private optSeq = 0;
  private lastUndoRoundSignature = '';
  private sortedStandingsIds: string[] = [];

  private armedTimers = new Map<HTMLElement, ArmedButtonEntry>();
  private lastPillSignature = '';
  private lastTraySignature = '';

  private lastBriefRoundSignature = '';
  private pendingRoundBrief = false;
  private briefDismissTimer: number | null = null;
  private lastCountdownTickSec = -1;

  private cachedTopHudBottom = 56;
  private cachedBottomHudInset = 84;
  private insetRafPending = false;

  constructor() {
    this.hydrateSingleSourceGuide();
    hydrateStaticIcons();
    this.initInputModeTracking();

    const viewport = document.getElementById('viewport-container')!;
    const labels = document.getElementById('world-labels')!;
    this.renderer3d = new Arena3DRenderer(viewport, labels);

    this.sessionId = readOrCreateSessionId();
    this.playerName = readOrCreatePlayerName();

    const urlParams = new URLSearchParams(window.location.search);
    const urlRoom = urlParams.get('room');
    this.roomCode = (urlRoom || 'ARENA1')
      .toUpperCase()
      .replace(/[^A-Z0-9-]/g, '')
      .slice(0, 8) || 'ARENA1';

    const nameInput = document.getElementById(
      'player-name-input'
    ) as HTMLInputElement | null;
    if (nameInput) nameInput.value = this.playerName;

    const hubNameInput = document.getElementById(
      'hub-player-name-input'
    ) as HTMLInputElement | null;
    if (hubNameInput) hubNameInput.value = this.playerName;

    // Direct ?room= invite links enter the sunlit 3D island immediately
    if (urlRoom) {
      document.getElementById('home-hub-modal')?.classList.add('hidden');
    }

    this.syncAudioMuteButtons();
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

      let minBottomTop = h - 16;
      const bottomCandidates = [
        document.getElementById('hud-bottom-dock'),
        document.getElementById('touch-precision-tray'),
        document.getElementById('spectator-bar'),
        document.getElementById('hud-run-dock'),
      ];

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
      this.cachedTopHudBottom = topPx;
      this.cachedBottomHudInset = bottomPx;
      this.renderer3d.setHudSafeInsets(topPx, bottomPx);
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

    if (this.armedTimers.has(btn)) {
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
    this.armedTimers.set(btn, { timer, restoreHtml });
  }

  // ==========================================================================
  // NETWORKING & LIFECYCLE
  // ==========================================================================

  private async fetchInitialHubData() {
    try {
      const [lobbiesRes, lbRes] = await Promise.all([
        fetch('/api/lobbies'),
        fetch('/api/leaderboard'),
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
    } catch {
      // WebSocket also supplies LOBBY_LIST & LEADERBOARD_DATA
    }
  }

  private connectWebSocket() {
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${proto}//${window.location.host}/ws`;
    this.ws = new WebSocket(wsUrl);

    this.ws.addEventListener('open', () => {
      this.send({
        type: 'JOIN_ROOM',
        roomCode: this.roomCode,
        playerName: this.playerName,
        sessionId: this.sessionId,
      });
    });

    this.ws.addEventListener('message', (ev) => {
      let msg: ServerToClientMessage;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }

      if (msg.type === 'WELCOME') {
        this.localPlayerId = msg.playerId;
        if (msg.sessionId) {
          this.sessionId = msg.sessionId;
          try {
            localStorage.setItem(SESSION_STORAGE_KEY, msg.sessionId);
            localStorage.setItem(SESSION_LEGACY_KEY, msg.sessionId);
          } catch {
            // ignore
          }
        }
        this.roomCode = msg.state.roomCode;
        this.syncUrlRoomCode(this.roomCode);
        this.applyRoomState(msg.state);
        this.syncConfigFormFromSettings(msg.state.settings);
      } else if (msg.type === 'ROOM_STATE') {
        this.roomCode = msg.state.roomCode;
        this.syncUrlRoomCode(this.roomCode);
        this.applyRoomState(msg.state);
      } else if (msg.type === 'TIMER_TICK') {
        if (this.roomState) {
          this.roomState.phaseTimeRemaining = msg.phaseTimeRemaining;
          if (typeof msg.runElapsed === 'number') {
            this.roomState.runElapsed = msg.runElapsed;
            this.reconcileRunDrift(msg.runElapsed);
          }
          this.updateTimerDOM(true);
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
      } else if (msg.type === 'CHAT_MESSAGE') {
        if (this.roomState) {
          this.roomState.chat.push(msg.message);
          this.renderChat();
        }
      } else if (msg.type === 'ERROR_TOAST') {
        soundEngine.playError();
        soundEngine.haptic('error');
        this.showToast(msg.message);
      }
    });

    this.ws.addEventListener('close', () => {
      setTimeout(() => this.connectWebSocket(), 2000);
    });
  }

  private syncUrlRoomCode(code: string) {
    try {
      const url = new URL(window.location.href);
      if (url.searchParams.get('room') !== code) {
        url.searchParams.set('room', code);
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
      document
        .getElementById('btn-standings-toggle')
        ?.classList.remove('active');
      document.getElementById('btn-dock-tools')?.classList.remove('active');
      document.getElementById('btn-toggle-lobby')?.classList.remove('active');
    }

    return anyOpen;
  }

  private hideTransientPopovers() {
    this.disarmAllButtons();
    document.getElementById('round-dropdown')?.classList.add('hidden');
    document.getElementById('standings-dropdown')?.classList.add('hidden');
    document.getElementById('btn-standings-toggle')?.classList.remove('active');
    document.getElementById('dock-tools-popover')?.classList.add('hidden');
    document.getElementById('btn-dock-tools')?.classList.remove('active');
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
    document.getElementById('round-brief-banner')?.classList.add('hidden');
  }

  private triggerRoundBriefBanner() {
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

    textEl.innerHTML = `${getRunnerIcon(archKey, 14)} <strong>${escapeHtml(
      arch.name
    )}:</strong> <span>${escapeHtml(arch.traitSummary)}</span>`;
    banner.classList.remove('hidden');

    if (this.briefDismissTimer !== null) {
      window.clearTimeout(this.briefDismissTimer);
    }
    this.briefDismissTimer = window.setTimeout(() => {
      banner.classList.add('hidden');
      this.briefDismissTimer = null;
    }, 4500);
  }

  // ==========================================================================
  // ROOM STATE APPLICATION & RUN SIMULATION
  // ==========================================================================

  private applyRoomState(state: RoomState) {
    const prevPhase = this.roomState?.phase;
    this.roomState = state;
    document.body.dataset.phase = state.phase;

    const undoSig = `${state.roomCode}|${state.roundConfig.roundNumber}|${
      state.roundConfig.seed ?? ''
    }`;
    if (state.phase !== 'BUILD' || undoSig !== this.lastUndoRoundSignature) {
      this.undoStack = [];
      this.lastUndoRoundSignature = undoSig;
      this.lastCountdownTickSec = -1;
    }

    this.renderer3d.syncRoomState(state, this.localPlayerId);

    if (state.phase === 'RUN') {
      if (prevPhase !== 'RUN' || !this.runPhaseActive) {
        this.startClientRunPhase(state);
      } else if (typeof state.runElapsed === 'number') {
        this.reconcileRunDrift(state.runElapsed);
      }
    } else {
      this.runPhaseActive = false;
    }

    // Trigger 4.5s Round Brief at start of each round's BUILD phase
    if (state.phase === 'BUILD') {
      const briefSig = `${state.roomCode}|${state.roundConfig.roundNumber}|${
        state.roundConfig.seed ?? ''
      }`;
      if (briefSig !== this.lastBriefRoundSignature) {
        this.lastBriefRoundSignature = briefSig;
        this.triggerRoundBriefBanner();
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
        soundEngine.playFinish();
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
    this.updateHubHeroStatus();
    this.renderChat();
    this.renderLobbyBrowser();
    this.scheduleHudSafeInsetsSync();
  }

  private startClientRunPhase(state: RoomState) {
    this.simulators.clear();
    const initialElapsed = Math.max(0, state.runElapsed || 0);
    for (const p of state.players) {
      const sim = new MazeRunnerSimulator(p.id, state.roundConfig, p.towers);
      if (initialElapsed > 0.04) {
        sim.fastForwardTo(initialElapsed);
      }
      this.simulators.set(p.id, sim);
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
    if (!this.runPhaseActive || serverElapsed <= 0) return;
    for (const sim of this.simulators.values()) {
      if (!sim.state.finished && serverElapsed - sim.elapsedSeconds > 1.25) {
        sim.fastForwardTo(serverElapsed);
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

    for (const ev of allEvents) {
      const isFocused =
        ev.playerId ===
        (this.renderer3d.focusedPlayerId || this.localPlayerId);
      if (isFocused || this.renderer3d.arenaOverviewMode) {
        if (ev.type === 'CLAP') {
          soundEngine.playSpirePulse(
            ev.spireType || 'THUNDERCLAP',
            ev.overchargeTier || 0
          );
        } else if (ev.type === 'WAYGATE') {
          soundEngine.playChronoWarp();
        } else if (ev.type === 'CHECKPOINT') {
          soundEngine.playCheckpoint();
        } else if (ev.type === 'FINISH') {
          soundEngine.playFinish();
        }
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
    const me = this.getLocalPlayer();
    if (!me) return;

    const wallCost = TOWER_SPECS.BLOCK.goldCost;
    if (me.gold < wallCost) {
      soundEngine.playError();
      soundEngine.haptic('error');
      this.showToast('No walls left. Remove a wall first.');
      return;
    }

    const validation = validateTowerPlacement(
      this.roomState.roundConfig,
      me.towers,
      x,
      y
    );
    if (!validation.valid || !validation.pathResult) {
      soundEngine.playError();
      soundEngine.haptic('error');
      if (validation.reason) {
        this.showToast(validation.reason);
      }
      return;
    }

    const prevOvercharge =
      this.renderer3d.getLocalMazeEval()?.overchargedSpires ??
      computeCitadelCircuitry(this.roomState.roundConfig, me.towers)
        .overchargedSpires;

    const clientId = `opt_${++this.optSeq}`;
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

    this.pushUndo({ kind: 'PLACE', x, y, clientId });

    this.renderer3d.syncRoomState(this.roomState, this.localPlayerId);
    const nextOvercharge =
      this.renderer3d.getLocalMazeEval()?.overchargedSpires ?? prevOvercharge;
    const gainedOvercharge = Math.max(0, nextOvercharge - prevOvercharge);

    soundEngine.playBuild('BLOCK', gainedOvercharge);
    soundEngine.haptic('build');

    this.updateUndoAndToolAvailability();
    this.updateTopBarAndResources();
    this.updateScoreboardDOM();

    this.send({ type: 'PLACE_TOWER', x, y, clientId });
  }

  private handleOptimisticSellTower(
    towerId: string,
    x?: number,
    y?: number
  ) {
    if (!this.roomState || this.roomState.phase !== 'BUILD') return;
    const me = this.getLocalPlayer();
    if (!me) return;

    const idx = me.towers.findIndex(
      (t) =>
        t.id === towerId ||
        (x !== undefined && y !== undefined && t.x === x && t.y === y)
    );
    if (idx === -1) return;

    const [removed] = me.towers.splice(idx, 1);
    me.gold += TOWER_SPECS.BLOCK.goldCost;
    me.ready = false;

    this.pushUndo({ kind: 'SELL', x: removed.x, y: removed.y });

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
    });
  }

  private pushUndo(entry: UndoEntry) {
    this.undoStack.push(entry);
    if (this.undoStack.length > 64) {
      this.undoStack.shift();
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
    const me = this.getLocalPlayer();
    if (!me) return;

    this.renderer3d.cancelTouchGhost();
    this.hideTouchPrecisionTray();
    this.disarmAllButtons();

    const entry = this.undoStack.pop()!;
    const wallCost = TOWER_SPECS.BLOCK.goldCost;

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
          this.renderer3d.syncRoomState(this.roomState, this.localPlayerId);
          soundEngine.playBuild('BLOCK', 0);
          soundEngine.haptic('undo');
          this.send({
            type: 'PLACE_TOWER',
            x: entry.x,
            y: entry.y,
            clientId,
          });
        }
      }
    } else if (entry.kind === 'BATCH_REPLACE') {
      const round = this.roomState.roundConfig;
      me.towers = [];
      me.gold = round.startingGold;
      me.usedSampleMaze = false;
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

      this.renderer3d.syncRoomState(this.roomState, this.localPlayerId);
      const evalRes = this.renderer3d.getLocalMazeEval();
      if (evalRes) {
        me.pathDistance = Number(evalRes.distance.toFixed(1));
      }
      soundEngine.playBuild('RESTORE', 0);
      soundEngine.haptic('undo');
      this.send({ type: 'RESTORE_TOWERS', towers: entry.previousTowers });
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

    tray
      .querySelectorAll<HTMLButtonElement>('.touch-nudge-btn')
      .forEach((btn) => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const dx = Number(btn.dataset.nudgeDx || 0);
          const dy = Number(btn.dataset.nudgeDy || 0);
          const moved = this.renderer3d.nudgeTouchGhost(dx, dy);
          if (!moved) {
            soundEngine.haptic('error');
          }
        });
      });

    document
      .getElementById('btn-touch-confirm')
      ?.addEventListener('click', (e) => {
        e.stopPropagation();
        const ok = this.renderer3d.confirmTouchGhost();
        if (ok) {
          this.hideTouchPrecisionTray();
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

    this.renderer3d.onHoverStatusChange = (info: HoverStatusInfo) => {
      if (this.renderer3d.modalOpen || !this.roomState) {
        this.hideCursorPill();
        this.hideTouchPrecisionTray();
        return;
      }

      // 1. Mobile Touch Two-Stage Precision Preview (Stationary Tray + Non-Blocking Micro-Tag)
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
          tagHtml = `${icon('reclaim', 12)}<span>Remove (+1)</span>`;
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
        const maxTop = Math.max(
          minTop,
          window.innerHeight - this.cachedBottomHudInset - pillH - 8
        );

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

      // 2. Desktop World Feature Inspection Card (Spire, Keep, Runner, Gate in BUILD & RUN)
      if (info.inspectedFeature && !info.offscreen) {
        const cardHtml = this.renderInspectedFeatureHtml(info.inspectedFeature);
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

      // 3. Desktop Build / Remove Hover Delta Pill
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
        nextClass = 'cursor-telemetry-pill neutral';
        nextHtml = `${icon('reclaim', 13)}<span>${label}</span>`;
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
              )}</span>`
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
    const maxTop = Math.max(minTop, window.innerHeight - pillH - 18);

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

    let btnClass = 'touch-confirm-btn';
    let btnDisabled = false;
    let btnHtml = '';

    if (info.existingTower) {
      btnClass = 'touch-confirm-btn reclaim-action';
      btnHtml = `${icon(
        'reclaim',
        15
      )}<span id="touch-confirm-label">Remove (+1)</span>`;
    } else if (info.valid) {
      const dt = info.deltaTime ?? 0;
      const dOver = info.deltaOvercharge ?? 0;
      const sign = dt >= 0 ? '+' : '';
      const overBadge =
        dOver > 0
          ? `<span class="overcharge-pips" style="color:#fef08a">+${dOver}${icon(
              'diamondFilled',
              11
            )}</span>`
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

    const sig = `${btnClass}|${btnDisabled}|${btnHtml}`;
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

  private renderInspectedFeatureHtml(f: InspectedWorldFeature): string {
    if (f.kind === 'SPIRE') {
      const spec = TOWER_SPECS[f.spireType];
      const pips = this.renderOverchargeDiamonds(f.overchargeTier);
      let statsLine = '';
      if (f.spireType === 'FROST_OBELISK') {
        const auraPct = Math.round((f.auraSlowPercent ?? 0.22) * 100);
        statsLine = `${auraPct}% ring chill · ${Math.round(
          f.slowPercent * 100
        )}% burst / ${f.effectiveCooldown.toFixed(
          1
        )}s · ${f.effectiveRange.toFixed(1)}m`;
      } else if (f.spireType === 'CHRONO_SPIRE') {
        statsLine = `${Math.round(
          f.slowPercent * 100
        )}% slow / ${f.effectiveCooldown.toFixed(1)}s · -${(
          f.cdrPulseSeconds ?? 1.2
        ).toFixed(1)}s spire recharge`;
      } else {
        statsLine = `${Math.round(
          f.slowPercent * 100
        )}% slow for ${f.slowDuration.toFixed(
          1
        )}s · Every ${f.effectiveCooldown.toFixed(
          1
        )}s · ${f.effectiveRange.toFixed(1)}m`;
      }

      const isRun = this.roomState?.phase === 'RUN';
      const metaLine = isRun
        ? `Pulses this run: ${f.projectedOrLiveHits}`
        : `Projected hits: ${f.projectedOrLiveHits}${
            f.overchargeTier < 3
              ? ' · Link Crimson Keeps to boost'
              : ' · Max Overcharge'
          }`;

      return `
        <div class="inspect-head">
          ${getSpireIcon(f.spireType, 14)}
          <span>${escapeHtml(spec.name)}</span>
          ${pips}
        </div>
        <div class="inspect-sub">${escapeHtml(statsLine)}</div>
        <div class="inspect-meta">${escapeHtml(metaLine)}</div>
      `;
    }

    if (f.kind === 'KEEP') {
      const badge = f.linked
        ? `<span class="overcharge-pips">${icon('diamondFilled', 11)} Linked</span>`
        : `<span class="inspect-meta">Unlinked</span>`;
      const desc = f.linked
        ? 'Connected to your walls. Grants +1 Overcharge to nearby Spires.'
        : 'Link Stone Walls here to Overcharge nearby Spires.';
      return `
        <div class="inspect-head">
          ${icon('keep', 14)}
          <span>Crimson Keep</span>
          ${badge}
        </div>
        <div class="inspect-sub">${escapeHtml(desc)}</div>
      `;
    }

    if (f.kind === 'RUNNER') {
      const arch = RUNNER_ARCHETYPES[f.archetype];
      const statusPart = f.statusLabel
        ? `<span class="inspect-meta">· ${escapeHtml(f.statusLabel)}</span>`
        : '';
      const subText =
        this.roomState?.phase === 'RUN'
          ? `Speed ${f.currentSpeed.toFixed(2)} m/s (base ${f.baseSpeed.toFixed(
              2
            )} m/s)`
          : arch.traitSummary;
      return `
        <div class="inspect-head">
          ${getRunnerIcon(f.archetype, 14)}
          <span>${escapeHtml(arch.name)}</span>
          ${statusPart}
        </div>
        <div class="inspect-sub">${escapeHtml(subText)}</div>
      `;
    }

    // GATE
    if (f.gateType === 'SPAWN') {
      return `
        <div class="inspect-head">
          ${icon('compass', 14)}
          <span>North Gate · Entrance</span>
        </div>
        <div class="inspect-sub">Runners enter here and route toward the South Shrine.</div>
      `;
    }

    return `
      <div class="inspect-head">
        ${icon('flag', 14)}
        <span>South Shrine · Exit</span>
      </div>
      <div class="inspect-sub">Round Par ${f.parTimeSeconds.toFixed(
        1
      )}s (+2 bonus points for beating Par)</div>
    `;
  }

  // ==========================================================================
  // AUDIO, SPECTATOR BAR & HOME HUB NAVIGATION
  // ==========================================================================

  private syncAudioMuteButtons() {
    const hudIcon = icon(soundEngine.muted ? 'volumeOff' : 'volumeOn', 18);
    const drawerIcon = icon(soundEngine.muted ? 'volumeOff' : 'volumeOn', 17);

    const muteBtn = document.getElementById('btn-mute');
    const muteIconSlot = document.getElementById('mute-icon-slot');
    if (muteIconSlot) muteIconSlot.innerHTML = hudIcon;
    muteBtn?.classList.toggle('active', soundEngine.muted);

    const drawerMuteBtn = document.getElementById('btn-drawer-mute');
    const drawerMuteIconSlot = document.getElementById('drawer-mute-icon-slot');
    if (drawerMuteIconSlot) drawerMuteIconSlot.innerHTML = drawerIcon;
    drawerMuteBtn?.classList.toggle('active', soundEngine.muted);
  }

  private syncSpectatorStateDOM() {
    const spectating = this.isSpectatingRival();
    document.body.dataset.spectating = spectating ? 'true' : 'false';

    const bar = document.getElementById('spectator-bar');
    const nameEl = document.getElementById('spectator-target-name');
    if (bar) {
      const showBar =
        spectating && Boolean(this.roomState && this.roomState.phase === 'BUILD');
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

  private openHub(
    tab?: 'play' | 'leaderboard' | 'codex',
    mobilePlayPane?: 'rooms' | 'setup'
  ) {
    if (tab) {
      this.switchHubTab(tab);
    }
    if (mobilePlayPane) {
      this.setMobilePlayPane(mobilePlayPane);
    }
    if (this.roomState) {
      this.syncConfigFormFromSettings(this.roomState.settings);
      this.updateHubHeroStatus();
    }
    this.dismissAllTransientOverlays();
    this.renderer3d.cancelTouchGhost();
    this.hideTouchPrecisionTray();
    this.hideCursorPill();
    document.getElementById('home-hub-modal')?.classList.remove('hidden');
    this.syncModalOpenState();
    this.send({ type: 'REQUEST_LOBBIES' });
  }

  private closeHub() {
    this.disarmAllButtons();
    document.getElementById('home-hub-modal')?.classList.add('hidden');
    this.syncModalOpenState();
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

  private switchHubTab(tab: 'play' | 'leaderboard' | 'codex') {
    this.activeHubTab = tab;
    document
      .querySelectorAll<HTMLButtonElement>('.hub-tab-btn')
      .forEach((btn) => {
        btn.classList.toggle('active', btn.dataset.hubTab === tab);
      });

    document
      .getElementById('hub-tab-play')
      ?.classList.toggle('hidden', tab !== 'play');
    document
      .getElementById('hub-tab-leaderboard')
      ?.classList.toggle('hidden', tab !== 'leaderboard');
    document
      .getElementById('hub-tab-codex')
      ?.classList.toggle('hidden', tab !== 'codex');

    if (tab === 'leaderboard') {
      this.renderLeaderboard();
    }
  }

  private updateHubHeroStatus() {
    const statusEl = document.getElementById('hub-hero-status');
    const heroPlayBtn = document.getElementById('btn-hero-play');
    if (!statusEl || !this.roomState) return;

    const rNum = this.roomState.roundConfig.roundNumber;
    const total = this.roomState.settings?.totalRounds || ROUNDS.length;
    const phaseDesc =
      this.roomState.phase === 'BUILD'
        ? `Round ${rNum}/${total} · Build phase`
        : this.roomState.phase === 'RUN'
        ? `Round ${rNum}/${total} · Run in progress`
        : `Round ${rNum}/${total} · Standings`;

    statusEl.innerHTML = `
      <span class="status-dot"></span>
      <span>Room <strong>${escapeHtml(
        this.roomState.roomCode
      )}</strong> · ${escapeHtml(phaseDesc)}</span>
    `;

    if (heroPlayBtn) {
      const me = this.getLocalPlayer();
      const label =
        me && me.towers.length > 0 ? 'Resume Match' : 'Play Now';
      heroPlayBtn.innerHTML = `${icon('play', 14)}<span>${label}</span>`;
    }
  }

  private async shareOrCopyInviteLink() {
    const shareUrl = `${window.location.origin}/?room=${this.roomCode}`;

    if (
      document.body.dataset.input === 'touch' &&
      typeof navigator.share === 'function'
    ) {
      try {
        await navigator.share({
          title: 'Mazing Contest',
          text: `Join room ${this.roomCode} in Mazing Contest`,
          url: shareUrl,
        });
        return;
      } catch (err) {
        if ((err as Error)?.name === 'AbortError') return;
      }
    }

    let copied = false;
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
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
      this.openHub('play');
    });

    document
      .getElementById('btn-open-leaderboard')
      ?.addEventListener('click', () => {
        soundEngine.playUiClick();
        this.openHub('leaderboard');
      });

    document
      .getElementById('btn-drawer-open-config')
      ?.addEventListener('click', () => {
        soundEngine.playUiClick();
        this.dismissAllTransientOverlays();
        this.openHub('play', 'setup');
      });

    document
      .getElementById('btn-results-leaderboard')
      ?.addEventListener('click', () => {
        soundEngine.playUiClick();
        if (this.roomState) {
          this.selectedLeaderboardRound =
            this.roomState.roundConfig.roundNumber;
          this.leaderboardMode = 'rounds';
        }
        this.openHub('leaderboard');
      });

    document.getElementById('btn-close-hub')?.addEventListener('click', () => {
      soundEngine.playUiClick();
      this.closeHub();
    });

    document.getElementById('btn-hero-play')?.addEventListener('click', () => {
      soundEngine.playUiClick();
      this.closeHub();
    });

    const hubModal = document.getElementById('home-hub-modal');
    hubModal?.addEventListener('click', (e) => {
      if (e.target === hubModal) {
        this.closeHub();
      }
    });

    document
      .querySelectorAll<HTMLButtonElement>('.hub-tab-btn')
      .forEach((btn) => {
        btn.addEventListener('click', () => {
          soundEngine.playUiClick();
          const tab = btn.dataset.hubTab as 'play' | 'leaderboard' | 'codex';
          this.switchHubTab(tab);
        });
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

    // Sync player name between Hub and Room Drawer inputs
    const hubNameInput = document.getElementById(
      'hub-player-name-input'
    ) as HTMLInputElement | null;
    const drawerNameInput = document.getElementById(
      'player-name-input'
    ) as HTMLInputElement | null;

    const commitName = (val: string) => {
      const clean = val.trim().slice(0, 18);
      if (clean) {
        this.playerName = clean;
        try {
          localStorage.setItem(NAME_STORAGE_KEY, clean);
        } catch {
          // ignore
        }
        if (hubNameInput) hubNameInput.value = clean;
        if (drawerNameInput) drawerNameInput.value = clean;
        this.send({ type: 'SET_NAME', playerName: clean });
      }
    };

    hubNameInput?.addEventListener('change', () =>
      commitName(hubNameInput.value)
    );
    hubNameInput?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        commitName(hubNameInput.value);
        hubNameInput.blur();
      }
    });

    // Join by Room Code
    const joinCodeInput = document.getElementById(
      'join-code-input'
    ) as HTMLInputElement | null;
    const handleJoinByCode = () => {
      const code = (joinCodeInput?.value || '')
        .trim()
        .toUpperCase()
        .replace(/[^A-Z0-9-]/g, '')
        .slice(0, 8);
      if (!code) {
        this.showToast('Enter a room code (for example ARENA1)');
        return;
      }
      this.roomCode = code;
      this.send({
        type: 'JOIN_ROOM',
        roomCode: code,
        playerName: this.playerName,
        sessionId: this.sessionId,
      });
      if (joinCodeInput) joinCodeInput.value = '';
      this.showToast(`Joined room ${code}`, true);
      this.closeHub();
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

    // Solo vs Bots (1-click private match)
    document.getElementById('btn-quick-solo')?.addEventListener('click', () => {
      soundEngine.playUiClick();
      const soloCode = `SOLO${Math.floor(10 + Math.random() * 89)}`;
      this.roomCode = soloCode;
      this.send({
        type: 'CREATE_ROOM',
        roomCode: soloCode,
        playerName: this.playerName,
        sessionId: this.sessionId,
        settings: {
          roomName: `${this.playerName}'s Island`,
          isPublic: false,
          totalRounds: 8,
          buildTimeSeconds: 0,
          goldMultiplier: 1.0,
          botCount: 3,
          botDifficulty: 'ARCHITECT',
          fogOfWar: false,
        },
      });
      this.showToast(`Started solo match (${soloCode})`, true);
      this.closeHub();
    });

    // Two-Tap Guarded Restart Match
    const restartBtn = document.getElementById('btn-hub-restart-match');
    restartBtn?.addEventListener('click', () => {
      if (!this.canControlRoomRules()) {
        this.showToast('Only the room host can restart the match.');
        return;
      }
      this.armDestructiveButton(
        restartBtn,
        true,
        'Confirm Restart',
        'refresh',
        () => {
          this.send({ type: 'RESTART_MATCH' });
          this.showToast('Match restarted at Round 1', true);
          this.closeHub();
        }
      );
    });

    // Invite Link
    document
      .getElementById('btn-hub-copy-invite')
      ?.addEventListener('click', () => {
        this.shareOrCopyInviteLink();
      });

    // Refresh Open Rooms
    document
      .getElementById('btn-refresh-lobbies')
      ?.addEventListener('click', () => {
        soundEngine.playUiClick();
        this.send({ type: 'REQUEST_LOBBIES' });
        this.fetchInitialHubData();
      });

    // Segmented Controls in Room Rules
    document
      .querySelectorAll<HTMLElement>('.match-config-pane .segmented-control')
      .forEach((group) => {
        group.querySelectorAll<HTMLButtonElement>('.seg-btn').forEach((btn) => {
          btn.addEventListener('click', () => {
            soundEngine.playUiClick();
            group
              .querySelectorAll<HTMLButtonElement>('.seg-btn')
              .forEach((b) => b.classList.remove('active'));
            btn.classList.add('active');
          });
        });
      });

    // Update Current Room Rules
    document
      .getElementById('btn-apply-room-settings')
      ?.addEventListener('click', () => {
        if (!this.canControlRoomRules()) {
          this.showToast('Only the room host can update room rules.');
          return;
        }
        soundEngine.playUiClick();
        const settings = this.readConfigFormSettings();
        this.send({
          type: 'UPDATE_SETTINGS',
          settings,
        });
        this.showToast(`Updated rules for ${this.roomCode}`, true);
        this.closeHub();
      });

    // Create New Custom Room
    document
      .getElementById('btn-create-custom-room')
      ?.addEventListener('click', () => {
        soundEngine.playUiClick();
        const settings = this.readConfigFormSettings();
        const customCode = `ROOM${Math.floor(100 + Math.random() * 899)}`;
        this.roomCode = customCode;
        this.send({
          type: 'CREATE_ROOM',
          roomCode: customCode,
          playerName: this.playerName,
          sessionId: this.sessionId,
          settings,
        });
        this.showToast(`Created room ${customCode}`, true);
        this.closeHub();
      });

    // Leaderboard Mode Switcher
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
      nameInput?.value.trim().slice(0, 26) || `${this.playerName}'s Room`;

    return {
      roomName,
      isPublic: getSegVal('cfg-public-group', 'true') === 'true',
      totalRounds: Number(getSegVal('cfg-rounds-group', '8')),
      buildTimeSeconds: Number(getSegVal('cfg-buildtime-group', '0')),
      goldMultiplier: Number(getSegVal('cfg-gold-group', '1')),
      botCount: Number(getSegVal('cfg-botcount-group', '3')),
      botDifficulty: getSegVal('cfg-botdiff-group', 'ARCHITECT') as
        | 'NOVICE'
        | 'ARCHITECT'
        | 'GRANDMASTER',
      fogOfWar: getSegVal('cfg-fog-group', 'false') === 'true',
    };
  }

  private syncConfigFormFromSettings(settings: RoomSettings) {
    const nameInput = document.getElementById(
      'cfg-room-name'
    ) as HTMLInputElement | null;
    if (nameInput && settings.roomName) {
      nameInput.value = settings.roomName;
    }

    const setSegVal = (groupId: string, val: string) => {
      const group = document.getElementById(groupId);
      if (!group) return;
      group.querySelectorAll<HTMLButtonElement>('.seg-btn').forEach((btn) => {
        btn.classList.toggle('active', btn.dataset.val === val);
      });
    };

    setSegVal('cfg-public-group', String(Boolean(settings.isPublic)));
    setSegVal('cfg-rounds-group', String(settings.totalRounds || 8));
    setSegVal('cfg-buildtime-group', String(settings.buildTimeSeconds || 0));
    setSegVal('cfg-gold-group', String(settings.goldMultiplier || 1));
    setSegVal('cfg-botcount-group', String(settings.botCount ?? 3));
    setSegVal('cfg-botdiff-group', settings.botDifficulty || 'ARCHITECT');
    setSegVal('cfg-fog-group', String(Boolean(settings.fogOfWar)));

    const fogChk = document.getElementById(
      'chk-fog'
    ) as HTMLInputElement | null;
    if (fogChk) {
      fogChk.checked = Boolean(settings.fogOfWar);
    }

    const canEditRules = this.canControlRoomRules();
    const applyBtn = document.getElementById(
      'btn-apply-room-settings'
    ) as HTMLButtonElement | null;
    if (applyBtn) {
      applyBtn.disabled = !canEditRules;
    }
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
    if (countEl) {
      countEl.textContent = `${rooms.length} Open`;
    }
    if (mobileCountEl) {
      mobileCountEl.textContent = String(rooms.length);
    }

    listEl.innerHTML = '';
    if (rooms.length === 0) {
      listEl.innerHTML = `<div style="color:var(--text-secondary);font-size:12.5px;padding:12px">No public rooms open right now. Start Solo vs Bots or create a new room.</div>`;
      return;
    }

    for (const r of rooms) {
      const isCurrent = r.roomCode === this.roomCode;
      const card = document.createElement('div');
      card.className = `lobby-card${isCurrent ? ' current-room' : ''}`;

      const phaseText =
        r.phase === 'BUILD'
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

      card.innerHTML = `
        <div class="lobby-card-main">
          <div class="lobby-card-title-row">
            <span class="lobby-card-name">${escapeHtml(r.roomName)}</span>
            <span class="room-code-badge">${escapeHtml(r.roomCode)}</span>
            <span class="lobby-phase-dot${
              r.phase === 'RUN' ? ' running' : ''
            }">${phaseText}</span>
          </div>
          <div class="lobby-card-subtitle">${subtitleText}</div>
        </div>
        <div class="lobby-card-right">
          <span class="capacity-pill" title="${r.humanCount} Players · ${
        r.botCount
      } Bots">
            ${icon('users', 14)}
            <span>${r.playerCount}/${r.maxPlayers}</span>
          </span>
          <button type="button" class="hub-action-pill ${
            isCurrent ? 'sage' : 'gold'
          }">
            ${
              isCurrent
                ? `${icon('check', 14)}<span>Active</span>`
                : `<span>Join</span>`
            }
          </button>
        </div>
      `;

      const btn = card.querySelector('button')!;
      btn.addEventListener('click', () => {
        soundEngine.playUiClick();
        if (isCurrent) {
          this.closeHub();
        } else {
          this.roomCode = r.roomCode;
          this.send({
            type: 'JOIN_ROOM',
            roomCode: r.roomCode,
            playerName: this.playerName,
            sessionId: this.sessionId,
          });
          this.showToast(`Joined ${r.roomName} (${r.roomCode})`, true);
          this.closeHub();
        }
      });

      listEl.appendChild(card);
    }
  }

  private renderLeaderboardRoundPills() {
    const container = document.getElementById('leaderboard-round-pills');
    if (!container) return;
    container.innerHTML = '';

    for (const r of ROUNDS) {
      const btn = document.createElement('button');
      btn.type = 'button';
      const arch = RUNNER_ARCHETYPES[r.runnerType || 'SCOUT'];
      btn.className = `lb-round-pill${
        r.roundNumber === this.selectedLeaderboardRound ? ' active' : ''
      }`;
      btn.dataset.rnum = String(r.roundNumber);
      btn.innerHTML = `<span>R${r.roundNumber}</span>${getRunnerIcon(
        r.runnerType || 'SCOUT',
        13
      )}`;
      btn.title = `Round ${r.roundNumber}: ${r.title} (${arch.name})`;
      btn.addEventListener('click', () => {
        soundEngine.playUiClick();
        this.selectedLeaderboardRound = r.roundNumber;
        this.renderLeaderboard();
      });
      container.appendChild(btn);
    }
  }

  private renderLeaderboard() {
    const pillsWrap = document.getElementById('leaderboard-round-pills');
    const metaEl = document.getElementById('leaderboard-round-meta');
    const tableWrap = document.getElementById('leaderboard-table-wrap');
    if (!tableWrap || !metaEl) return;

    const lbModeGroup = document.getElementById('leaderboard-mode-group');
    lbModeGroup
      ?.querySelectorAll<HTMLButtonElement>('.seg-btn')
      .forEach((btn) => {
        btn.classList.toggle('active', btn.dataset.lbMode === this.leaderboardMode);
      });

    pillsWrap
      ?.querySelectorAll<HTMLButtonElement>('.lb-round-pill')
      .forEach((btn) => {
        btn.classList.toggle(
          'active',
          Number(btn.dataset.rnum) === this.selectedLeaderboardRound
        );
      });

    if (!this.leaderboard) {
      tableWrap.innerHTML = `<div style="color:var(--text-secondary);font-size:12.5px;padding:14px">Loading leaderboard...</div>`;
      return;
    }

    tableWrap.innerHTML = '';
    const myLower = this.playerName.trim().toLowerCase();

    if (this.leaderboardMode === 'rounds') {
      pillsWrap?.classList.remove('hidden');
      const roundCfg =
        ROUNDS.find((r) => r.roundNumber === this.selectedLeaderboardRound) ||
        ROUNDS[0];
      const arch = RUNNER_ARCHETYPES[roundCfg.runnerType || 'SCOUT'];

      metaEl.innerHTML = `
        <div class="lb-meta-main">
          <strong>Round ${roundCfg.roundNumber} · ${escapeHtml(
        roundCfg.title
      )}</strong>
          <span class="lb-meta-trait">${getRunnerIcon(
            roundCfg.runnerType || 'SCOUT',
            14
          )} ${escapeHtml(arch.name)} · ${escapeHtml(arch.traitSummary)}</span>
        </div>
        <div class="par-pill">
          ${icon('starFilled', 11)}
          <span>Par ${roundCfg.parTimeSeconds.toFixed(1)}s</span>
        </div>
      `;

      const records =
        this.leaderboard.roundRecords[this.selectedLeaderboardRound] || [];
      if (records.length === 0) {
        tableWrap.innerHTML = `<div style="color:var(--text-secondary);font-size:12.5px;padding:14px">No survival records yet for Round ${this.selectedLeaderboardRound}. Complete a run to set the first record.</div>`;
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
            <span>${escapeHtml(rec.playerName)}</span>
            ${youBadge}
          </div>
          <div class="lb-time-primary">
            <span>${rec.survivalTimeSeconds.toFixed(2)}s</span>
            ${parBadge}
          </div>
          <div class="lb-synergies">
            <span class="stat-chip" title="Spire Pulses">${icon('bolt', 12)} ${
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
      pillsWrap?.classList.add('hidden');
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
          <div class="lb-meta-right">
            ${c.bestSurvivalTime.toFixed(1)}s · R${c.bestRoundNumber}
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

    // Undo Button
    document.getElementById('btn-undo')?.addEventListener('click', () => {
      this.performUndo();
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
      }
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
      }
    });

    document
      .getElementById('btn-close-lobby')
      ?.addEventListener('click', () => {
        soundEngine.playUiClick();
        lobbyDrawer.classList.add('hidden');
        lobbyToggleBtn.classList.remove('active');
      });

    // Global Outside-Click Dismissal for Popovers & Armed Buttons
    window.addEventListener('click', (e) => {
      const target = e.target as HTMLElement;
      if (!target.closest('[data-armed="true"]')) {
        this.disarmAllButtons();
      }
      if (!target.closest('.round-selector-wrap')) {
        roundDropdown.classList.add('hidden');
      }
      if (!target.closest('#standings-wrap')) {
        standingsDropdown.classList.add('hidden');
        standingsBtn.classList.remove('active');
      }
      if (!target.closest('#dock-tools-wrap')) {
        dockToolsPopover.classList.add('hidden');
        dockToolsBtn.classList.remove('active');
      }
      if (
        !target.closest('#lobby-drawer') &&
        !target.closest('#btn-toggle-lobby')
      ) {
        lobbyDrawer.classList.add('hidden');
        lobbyToggleBtn.classList.remove('active');
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
        const resultsModal = document.getElementById('results-modal');
        if (
          resultsModal &&
          !resultsModal.classList.contains('hidden') &&
          resultsModal.classList.contains('peek-minimized')
        ) {
          resultsModal.classList.remove('peek-minimized');
          this.syncPeekMazesButton(false);
          this.syncModalOpenState();
          return;
        }
        this.dismissAllTransientOverlays();
        document.getElementById('help-modal')?.classList.add('hidden');
        this.renderer3d.cancelTouchGhost();
        this.hideTouchPrecisionTray();
        this.hideCursorPill();
        this.closeHub();
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

      // Suppress arena hotkeys while Hub or Guide modal is open
      if (this.isHubOpen() || this.isHelpOpen()) {
        return;
      }

      const key = e.key.toUpperCase();

      if ((e.ctrlKey || e.metaKey) && key === 'Z') {
        e.preventDefault();
        this.performUndo();
        return;
      }
      if (e.ctrlKey || e.metaKey || e.altKey) return;

      if (key === 'Z') {
        e.preventDefault();
        this.performUndo();
      } else if (key === 'Q' || key === 'B') {
        this.selectTool('BLOCK');
      } else if (key === 'X' || key === 'E') {
        this.selectTool('SELL');
      } else if (key === 'R') {
        this.renderer3d.resetCameraView();
        this.updateScoreboardDOM();
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

    // Playback Speed Controls (Both Top Bar & Mobile #hud-run-dock)
    document
      .querySelectorAll<HTMLButtonElement>('.speed-btn')
      .forEach((btn) => {
        btn.addEventListener('click', () => {
          soundEngine.playUiClick();
          const spd = Number(btn.dataset.speed) as 1 | 2 | 4;
          this.send({ type: 'SET_SIM_SPEED', speed: spd });
        });
      });

    // Clear All (2-Tap Guarded + Undoable via BATCH_REPLACE)
    const clearMazeBtn = document.getElementById('btn-clear-maze');
    clearMazeBtn?.addEventListener('click', (e) => {
      e.stopPropagation();
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
          this.pushUndo({ kind: 'BATCH_REPLACE', previousTowers });

          me.towers = [];
          me.gold = this.roomState!.roundConfig.startingGold;
          me.usedSampleMaze = false;
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
          this.send({ type: 'CLEAR_TOWERS' });
        }
      );
    });

    // New Map (2-Tap Guarded)
    const rerollBtn = document.getElementById('btn-reroll-map');
    rerollBtn?.addEventListener('click', (e) => {
      e.stopPropagation();
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
          this.pushUndo({ kind: 'BATCH_REPLACE', previousTowers });

          soundEngine.playBuild('SAMPLE', 0);
          soundEngine.haptic('build');
          this.renderer3d.cancelTouchGhost();
          this.hideTouchPrecisionTray();
          this.hideCursorPill();
          this.hideTransientPopovers();
          this.updateUndoAndToolAvailability();
          this.send({ type: 'LOAD_PRESET_DEMO' });
        }
      );
    });

    // Reset Camera View
    document
      .getElementById('btn-reset-camera')
      ?.addEventListener('click', () => {
        soundEngine.playUiClick();
        this.hideTransientPopovers();
        if (this.localPlayerId) {
          this.renderer3d.focusOnPlayerIsland(this.localPlayerId);
        } else {
          this.renderer3d.resetCameraView();
        }
        this.syncSpectatorStateDOM();
        this.updateUndoAndToolAvailability();
        this.updateScoreboardDOM();
      });

    // Ready / Start Button (2-Tap Guarded on 0-Wall Solo Start)
    const readyBtn = document.getElementById('btn-ready-lock');
    readyBtn?.addEventListener('click', (e) => {
      e.stopPropagation();
      const me = this.getLocalPlayer();
      if (!me || this.roomState?.phase !== 'BUILD') return;

      const isEmptySoloStart =
        !me.ready && me.towers.length === 0 && this.getHumanCount() <= 1;

      this.armDestructiveButton(
        readyBtn,
        isEmptySoloStart,
        'Start Empty?',
        'play',
        () => {
          const nextReady = !me.ready;
          me.ready = nextReady;
          soundEngine.playReady(nextReady);
          soundEngine.haptic('ready');
          this.renderer3d.cancelTouchGhost();
          this.hideTouchPrecisionTray();
          this.hideCursorPill();
          this.hideTransientPopovers();
          this.updateTopBarAndResources();
          this.updateScoreboardDOM();
          this.send({ type: 'TOGGLE_READY' });
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

    // Results Modal: View Mazes Peek Toggle & Next Round
    document
      .getElementById('btn-peek-mazes')
      ?.addEventListener('click', () => {
        soundEngine.playUiClick();
        const resultsModal = document.getElementById('results-modal');
        if (!resultsModal) return;
        const isPeeking = resultsModal.classList.toggle('peek-minimized');
        this.syncPeekMazesButton(isPeeking);
        this.syncModalOpenState();
      });

    document.getElementById('btn-next-round')?.addEventListener('click', () => {
      soundEngine.playUiClick();
      if (!this.canControlRoomRules()) {
        this.showToast('Waiting for room host or auto-advance timer.');
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
      if (!this.canControlRoomRules()) {
        this.showToast('Only the room host can add bots.');
        return;
      }
      soundEngine.playUiClick();
      this.send({ type: 'ADD_BOT' });
    });

    document.getElementById('btn-remove-bot')?.addEventListener('click', () => {
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
    chatForm?.addEventListener('submit', (e) => {
      e.preventDefault();
      if (!chatInput) return;
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
    const container = document.getElementById('round-pills')!;
    container.innerHTML = '';

    ROUNDS.forEach((r, idx) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'round-pill-btn';
      const arch = RUNNER_ARCHETYPES[r.runnerType || 'SCOUT'];
      btn.innerHTML = `
        <span class="r-left">
          <span class="r-num">R${r.roundNumber}</span>
          <span class="r-title">${escapeHtml(r.title)}</span>
        </span>
        <span class="r-arch" title="${escapeHtml(arch.name)}">${getRunnerIcon(
          r.runnerType || 'SCOUT',
          14
        )}</span>
      `;
      btn.title = `${r.title} (${arch.name}: ${arch.traitSummary})`;
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (this.roomState?.currentRoundIndex === idx) {
          document.getElementById('round-dropdown')?.classList.add('hidden');
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
          `Switch to R${r.roundNumber}?`,
          'arrowRight',
          () => {
            this.send({ type: 'JUMP_TO_ROUND', roundIndex: idx });
            document.getElementById('round-dropdown')?.classList.add('hidden');
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
    const totalRounds = this.roomState.settings?.totalRounds || ROUNDS.length;
    const effectivePar = round.parTimeSeconds;

    document.getElementById('round-code-label')!.textContent =
      `R${round.roundNumber}/${totalRounds}`;
    document.getElementById('round-subtitle')!.textContent = round.title;
    document.getElementById('btn-round-picker')!.title =
      `Round ${round.roundNumber}: ${round.title} · ${arch.name} (${arch.traitSummary})`;

    const runnerBadge = document.getElementById('round-runner-badge');
    if (runnerBadge) {
      runnerBadge.innerHTML = getRunnerIcon(archKey, 13);
      runnerBadge.title = `${arch.name}: ${arch.traitSummary}`;
    }

    // Populate Round Inspect Header inside #round-dropdown
    const inspectTitle = document.getElementById('round-inspect-title');
    if (inspectTitle) {
      inspectTitle.textContent = `Round ${round.roundNumber} · ${round.title}`;
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

    const featuresEl = document.getElementById('map-features-summary');
    if (featuresEl) {
      featuresEl.innerHTML = featureParts.join(' · ');
    }

    const phaseDot = document.getElementById('phase-dot')!;
    const phaseLabel = document.getElementById('phase-label')!;
    const speedControls = document.getElementById('speed-controls')!;

    if (this.roomState.phase === 'BUILD') {
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

    document.querySelectorAll<HTMLButtonElement>('.speed-btn').forEach((b) => {
      b.classList.toggle(
        'active',
        Number(b.dataset.speed) === this.roomState?.simSpeedMultiplier
      );
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
      const estEl = document.getElementById('est-time-value');
      if (estEl && this.roomState.phase !== 'RUN') {
        estEl.textContent = `Est ${estSecs.toFixed(
          1
        )}s · Par ${effectivePar.toFixed(0)}s`;
        estEl.style.color =
          estSecs >= effectivePar
            ? 'var(--accent-sage)'
            : 'var(--text-primary)';
      }

      const timeChip = document.getElementById('time-chip');
      if (timeChip && evalRun) {
        timeChip.title = `Estimated Run: ${estSecs.toFixed(
          1
        )}s (Par ${effectivePar.toFixed(1)}s) · Spire Pulses: ${
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

    document
      .querySelectorAll<HTMLButtonElement>('.round-pill-btn')
      .forEach((btn, idx) => {
        btn.classList.toggle(
          'active',
          idx === this.roomState?.currentRoundIndex
        );
      });
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
      (a, b) => b.totalScore - a.totalScore
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
        summaryEl.textContent = `${formatOrdinal(featuredIdx + 1)} · ${
          isMe ? 'You' : featured.name
        }`;
      }
      if (scoreEl && this.roomState.phase !== 'RUN') {
        scoreEl.textContent = `${featured.totalScore}p`;
        scoreEl.style.color = 'var(--text-secondary)';
      }
    }

    sorted.forEach((p, idx) => {
      const row = document.createElement('button');
      row.type = 'button';
      const isFocused =
        !this.renderer3d.arenaOverviewMode &&
        (this.renderer3d.focusedPlayerId || this.localPlayerId) === p.id;
      row.className = `standings-row${isFocused ? ' focused' : ''}`;

      const isMe = p.id === this.localPlayerId;
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
      }p</span>
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
        this.syncSpectatorStateDOM();
        this.updateUndoAndToolAvailability();
        this.updateScoreboardDOM();
        this.scheduleHudSafeInsetsSync();
      });

      list.appendChild(row);
    });
  }

  private updateLiveRunScoreboard() {
    if (!this.roomState) return;
    const activeTargetId =
      (!this.renderer3d.arenaOverviewMode && this.renderer3d.focusedPlayerId) ||
      this.localPlayerId;
    const pillScoreEl = document.getElementById('standings-score');
    const estEl = document.getElementById('est-time-value');
    const parSecs = this.roomState.roundConfig.parTimeSeconds;

    for (const [pid, sim] of this.simulators.entries()) {
      const liveSecs = sim.state.finished
        ? sim.state.finishTimeSeconds
        : sim.elapsedSeconds;
      const formatted = `${liveSecs.toFixed(1)}s`;
      const toneColor = sim.state.finished
        ? 'var(--accent-sage)'
        : 'var(--accent-gold)';

      const subEl = document.getElementById(`sub-telemetry-${pid}`);
      if (subEl) {
        subEl.innerHTML = sim.state.finished
          ? `${icon('flag', 12)} <span>${formatted}</span>`
          : formatted;
        subEl.style.color = toneColor;
      }

      if (pid === activeTargetId) {
        if (pillScoreEl) {
          pillScoreEl.textContent = formatted;
          pillScoreEl.style.color = toneColor;
        }
        if (estEl) {
          estEl.textContent = `${
            sim.state.finished ? 'Done' : 'Run'
          } ${formatted} · Par ${parSecs.toFixed(0)}s`;
          estEl.style.color =
            liveSecs >= parSecs
              ? 'var(--accent-sage)'
              : 'var(--text-primary)';
        }
      }
    }
  }

  private updateResultsCountdownDOM() {
    if (!this.roomState || this.roomState.phase !== 'ROUND_RESULTS') return;
    const nextBtnLabel = document.getElementById('next-round-label');
    if (!nextBtnLabel) return;
    const secs = Math.max(0, Math.ceil(this.roomState.phaseTimeRemaining));
    nextBtnLabel.textContent = secs > 0 ? `Next Round (${secs}s)` : 'Next Round';
  }

  private renderRoundResultsModal(state: RoomState) {
    const round = state.roundConfig;
    const isGameOver = state.phase === 'GAME_OVER';
    const roundsDone = state.roundsCompleted || round.roundNumber;
    const totalRounds = state.settings?.totalRounds || ROUNDS.length;
    const parTarget = round.parTimeSeconds || computeEffectivePar(28, state.settings?.goldMultiplier);

    const titleEl = document.getElementById('results-title')!;
    const subEl = document.getElementById('results-subtitle')!;
    const progressEl = document.getElementById('results-match-progress')!;
    const podiumEl = document.getElementById('results-podium')!;
    const recordCallout = document.getElementById('results-record-callout')!;
    const nextBtnLabel = document.getElementById('next-round-label')!;

    progressEl.textContent = isGameOver
      ? `Final · ${totalRounds} Rounds`
      : `Round ${roundsDone} of ${totalRounds}`;

    if (state.newRecordHolders && state.newRecordHolders.length > 0) {
      recordCallout.classList.remove('hidden');
      recordCallout.innerHTML = `${icon(
        'trophy',
        15
      )} <span>New Top-5 Leaderboard Record on Round ${
        round.roundNumber
      } by ${escapeHtml(state.newRecordHolders.join(', '))}</span>`;
    } else {
      recordCallout.classList.add('hidden');
    }

    if (isGameOver) {
      titleEl.textContent = 'Match Complete';
      subEl.textContent = `Final standings across ${totalRounds} rounds.`;
      nextBtnLabel.textContent = 'New Match';

      const overallRanked = [...state.players].sort(
        (a, b) =>
          b.totalScore - a.totalScore || b.bestMazeTime - a.bestMazeTime
      );
      podiumEl.classList.remove('hidden');
      podiumEl.innerHTML = '';

      overallRanked.slice(0, 3).forEach((p, idx) => {
        const card = document.createElement('div');
        const isMe = p.id === this.localPlayerId;
        card.className = `podium-card${idx === 0 ? ' first' : ''}${
          isMe ? ' is-me' : ''
        }`;
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
      subEl.textContent = `Par Target: ${parTarget.toFixed(
        1
      )}s (+2 bonus points for beating Par) · Skill: ${formatBotSkillLabel(
        state.settings?.botDifficulty
      )}`;
      this.updateResultsCountdownDOM();
      podiumEl.classList.add('hidden');
    }

    const table = document.getElementById('results-table')!;
    table.innerHTML = '';

    const tableHead = document.createElement('div');
    tableHead.className = 'results-table-head';
    tableHead.innerHTML = `
      <span>Player &amp; Maze Stats</span>
      <span>Run Time &amp; Score</span>
    `;
    table.appendChild(tableHead);

    const ranked = [...state.players].sort((a, b) =>
      isGameOver
        ? b.totalScore - a.totalScore ||
          (b.lastRoundTime || 0) - (a.lastRoundTime || 0)
        : (b.lastRoundTime || 0) - (a.lastRoundTime || 0)
    );

    ranked.forEach((p, idx) => {
      const row = document.createElement('div');
      const isMe = p.id === this.localPlayerId;
      row.className = `result-row${idx === 0 ? ' winner' : ''}${
        isMe ? ' is-me' : ''
      }`;
      const rankHtml =
        idx < 3 ? getMedalBadge((idx + 1) as 1 | 2 | 3, 20) : `#${idx + 1}`;
      const beatPar =
        (p.lastRoundTime || 0) >= parTarget
          ? `<span class="par-pill">${icon('starFilled', 10)}<span>Par</span></span>`
          : '';
      const youBadge = isMe ? `<span class="you-badge">You</span>` : '';
      const botBadge = p.isBot ? `<span class="bot-badge">BOT</span>` : '';
      const synBadges = `<span class="stat-chip">${icon('bolt', 11)} ${
        p.lastRoundClaps || 0
      } · ${icon('diamondFilled', 10)} ${
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
          <span style="color:var(--accent-sage)">+${p.lastRoundPoints}p</span>
          <span style="color:var(--text-secondary)">(${p.totalScore}p)</span>
        </div>
      `;
      table.appendChild(row);
    });
  }

  private renderChat() {
    if (!this.roomState) return;
    const box = document.getElementById('chat-messages')!;
    box.innerHTML = '';
    for (const m of this.roomState.chat) {
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
    box.scrollTop = box.scrollHeight;
  }

  private showToast(message: string, isPositive = false) {
    const container = document.getElementById('toast-container')!;
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
