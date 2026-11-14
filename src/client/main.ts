import { ROUNDS } from '../shared/rounds.js';
import {
  evaluateMazeRunTime,
  MazeRunnerSimulator,
  SIM_DT,
} from '../shared/simulation.js';
import {
  ClientToServerMessage,
  LeaderboardPayload,
  LobbyRoomSummary,
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
  hydrateStaticIcons,
  icon,
} from './icons.js';
import { Arena3DRenderer } from './renderer3d.js';

interface ExtendedArena3DRenderer extends Arena3DRenderer {
  clearTouchPreview?: () => void;
  resetCameraView?: () => void;
  dismissTransientUI?: () => boolean;
  onFocusChange?: () => void;
}

interface ExtendedHoverInfo {
  cell: { x: number; y: number } | null;
  screenX: number;
  screenY: number;
  valid: boolean;
  reason?: string;
  deltaTime?: number;
  deltaClaps?: number;
  deltaKeeps?: number;
  deltaOvercharge?: number;
  previewTime?: number;
  existingTower?: { id: string; x: number; y: number } | null;
  isTouchPreview?: boolean;
  offscreen?: boolean;
  isGestureMoving?: boolean;
  onConfirmTouchAction?: () => void;
  onCancelTouchAction?: () => void;
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

class MazingContestClient {
  private renderer3d: ExtendedArena3DRenderer;
  private ws: WebSocket | null = null;
  private localPlayerId: string | null = null;
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

  private touchConfirmAction: (() => void) | null = null;
  private touchCancelAction: (() => void) | null = null;
  private lastPillSignature = '';

  constructor() {
    hydrateStaticIcons();

    const viewport = document.getElementById('viewport-container')!;
    const labels = document.getElementById('world-labels')!;
    this.renderer3d = new Arena3DRenderer(
      viewport,
      labels
    ) as ExtendedArena3DRenderer;

    const urlParams = new URLSearchParams(window.location.search);
    const urlRoom = urlParams.get('room');
    this.roomCode = (urlRoom || 'ARENA1').toUpperCase().slice(0, 8);
    this.playerName =
      localStorage.getItem('mc2026_player_name') ||
      `Architect-${Math.floor(100 + Math.random() * 899)}`;

    const nameInput = document.getElementById(
      'player-name-input'
    ) as HTMLInputElement | null;
    if (nameInput) nameInput.value = this.playerName;

    const hubNameInput = document.getElementById(
      'hub-player-name-input'
    ) as HTMLInputElement | null;
    if (hubNameInput) hubNameInput.value = this.playerName;

    // Direct ?room= invite links enter the sunlit 3D arena immediately
    if (urlRoom) {
      document.getElementById('home-hub-modal')?.classList.add('hidden');
    }

    this.setupRendererCallbacks();
    this.setupUIEvents();
    this.setupHubEvents();
    this.renderRoundSelectorPills();
    this.renderLeaderboardRoundPills();
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
        this.roomCode = msg.state.roomCode;
        this.syncUrlRoomCode(this.roomCode);
        this.applyRoomState(msg.state);
        this.syncConfigFormFromSettings(msg.state.settings);
      } else if (msg.type === 'ROOM_STATE') {
        this.roomCode = msg.state.roomCode;
        this.applyRoomState(msg.state);
      } else if (msg.type === 'TIMER_TICK') {
        if (this.roomState) {
          this.roomState.phaseTimeRemaining = msg.phaseTimeRemaining;
          this.updateTimerDOM();
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
      url.searchParams.set('room', code);
      window.history.replaceState({}, '', url.toString());
    } catch {
      // ignore
    }
  }

  private send(msg: ClientToServerMessage) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  /**
   * Closes any open transient dropdowns/drawers and returns true if any was open.
   */
  private dismissAllTransientOverlays(): boolean {
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
    document.getElementById('round-dropdown')?.classList.add('hidden');
    document.getElementById('standings-dropdown')?.classList.add('hidden');
    document.getElementById('btn-standings-toggle')?.classList.remove('active');
    document.getElementById('dock-tools-popover')?.classList.add('hidden');
    document.getElementById('btn-dock-tools')?.classList.remove('active');
  }

  private hideCursorPill() {
    const pill = document.getElementById('cursor-telemetry-pill');
    if (pill) {
      pill.classList.add('hidden');
      pill.classList.remove('touch-interactive');
      pill.style.pointerEvents = '';
      pill.style.opacity = '';
    }
    this.touchConfirmAction = null;
    this.touchCancelAction = null;
    this.lastPillSignature = '';
  }

  private applyRoomState(state: RoomState) {
    const prevPhase = this.roomState?.phase;
    this.roomState = state;
    document.body.dataset.phase = state.phase;

    this.renderer3d.syncRoomState(state, this.localPlayerId);

    if (state.phase === 'RUN' && prevPhase !== 'RUN') {
      this.startClientRunPhase(state);
    } else if (state.phase !== 'RUN') {
      this.runPhaseActive = false;
    }

    // Auto-hide bottom dock and cursor pill when outside BUILD phase
    const bottomDock = document.getElementById('hud-bottom-dock')!;
    if (state.phase === 'BUILD') {
      bottomDock.classList.remove('dock-hidden');
    } else {
      bottomDock.classList.add('dock-hidden');
      document.getElementById('dock-tools-popover')?.classList.add('hidden');
      document.getElementById('btn-dock-tools')?.classList.remove('active');
      this.hideCursorPill();
    }

    const resultsModal = document.getElementById('results-modal')!;
    if (state.phase === 'ROUND_RESULTS' || state.phase === 'GAME_OVER') {
      if (prevPhase !== 'ROUND_RESULTS' && prevPhase !== 'GAME_OVER') {
        soundEngine.playFinish();
      }
      this.renderRoundResultsModal(state);
      resultsModal.classList.remove('hidden');
    } else {
      resultsModal.classList.add('hidden');
    }

    this.updateTopBarAndResources();
    this.updateScoreboardDOM();
    this.renderChat();
    this.renderLobbyBrowser();
  }

  private startClientRunPhase(state: RoomState) {
    this.simulators.clear();
    for (const p of state.players) {
      const sim = new MazeRunnerSimulator(p.id, state.roundConfig, p.towers);
      this.simulators.set(p.id, sim);
    }
    this.simAccumulator = 0;
    this.runPhaseActive = true;
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
        if (ev.type === 'CLAP') soundEngine.playThunderclap();
        else if (ev.type === 'WAYGATE') soundEngine.playChronoWarp();
        else if (ev.type === 'CHECKPOINT') soundEngine.playCheckpoint();
        else if (ev.type === 'FINISH') soundEngine.playFinish();
      }
    }

    const stateMap = new Map<string, RunnerSimState>();
    for (const [pid, sim] of this.simulators.entries()) {
      stateMap.set(pid, sim.state);
    }

    this.renderer3d.updateRunners(stateMap, allEvents);
    this.updateLiveRunScoreboard();
  }

  private setupRendererCallbacks() {
    this.renderer3d.onPlaceTower = (x, y) => {
      soundEngine.playBuild('BLOCK');
      this.send({ type: 'PLACE_TOWER', x, y });
    };

    this.renderer3d.onSellTower = (towerId) => {
      soundEngine.playSell();
      this.send({ type: 'SELL_TOWER', towerId });
    };

    // Intercept outside canvas taps when popovers/drawers are open so taps don't place pillars
    (this.renderer3d as ExtendedArena3DRenderer).dismissTransientUI = () => {
      return this.dismissAllTransientOverlays();
    };

    // Sync HUD Standings & Overview button whenever camera focus changes in 3D
    (this.renderer3d as ExtendedArena3DRenderer).onFocusChange = () => {
      this.updateScoreboardDOM();
    };

    // Support clicking/tapping projected .island-3d-badge labels in Arena Overview
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
        this.renderer3d.clearTouchPreview?.();
        this.hideCursorPill();
        this.renderer3d.focusOnPlayerIsland(targetPlayer.id);
        this.updateScoreboardDOM();
      }
    });

    const pill = document.getElementById('cursor-telemetry-pill')!;

    // Prevent taps on the floating touch confirm pill from falling through to the 3D canvas
    pill.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
    });

    pill.addEventListener('click', (e) => {
      e.stopPropagation();
      const target = e.target as HTMLElement;
      if (target.closest('[data-touch-action="confirm"]')) {
        const cb = this.touchConfirmAction;
        this.hideCursorPill();
        cb?.();
      } else if (target.closest('[data-touch-action="cancel"]')) {
        const cb = this.touchCancelAction;
        this.hideCursorPill();
        cb?.();
        this.renderer3d.clearTouchPreview?.();
      }
    });

    this.renderer3d.onHoverStatusChange = (rawInfo) => {
      const info = rawInfo as ExtendedHoverInfo;
      const hubOpen = !document
        .getElementById('home-hub-modal')
        ?.classList.contains('hidden');
      const helpOpen = !document
        .getElementById('help-modal')
        ?.classList.contains('hidden');

      if (
        !info.cell ||
        info.offscreen ||
        this.roomState?.phase !== 'BUILD' ||
        hubOpen ||
        helpOpen
      ) {
        this.hideCursorPill();
        return;
      }

      pill.classList.remove('hidden');

      // Suppress accidental taps on the floating pill while panning or pinching
      if (info.isGestureMoving) {
        pill.style.pointerEvents = 'none';
        pill.style.opacity = '0.45';
      } else {
        pill.style.pointerEvents = info.isTouchPreview ? 'auto' : 'none';
        pill.style.opacity = '1';
      }

      // Mobile / Touch Two-Stage Confirm Pill (64px ABOVE finger, clamped inside viewport)
      if (info.isTouchPreview) {
        this.touchConfirmAction = info.onConfirmTouchAction || null;
        this.touchCancelAction = info.onCancelTouchAction || null;

        let nextClass = 'cursor-telemetry-pill touch-interactive';
        let nextHtml = '';

        if (info.existingTower) {
          nextHtml = `
            <button type="button" class="touch-confirm-btn reclaim-action" data-touch-action="confirm">
              ${icon('reclaim', 15)}
              <span>Reclaim · +1 Pillar</span>
            </button>
            <button type="button" class="touch-cancel-btn" data-touch-action="cancel" aria-label="Dismiss">
              ${icon('close', 15)}
            </button>
          `;
        } else if (info.valid) {
          const dt = info.deltaTime ?? 0;
          const dOver = info.deltaOvercharge ?? 0;
          const sign = dt >= 0 ? '+' : '';
          const starPart =
            dOver > 0
              ? ` <span style="display:inline-flex;align-items:center;gap:1px">+${dOver}${icon('starFilled', 12)}</span>`
              : '';
          nextHtml = `
            <button type="button" class="touch-confirm-btn" data-touch-action="confirm">
              ${icon('pillar', 15)}
              <span>${sign}${dt.toFixed(1)}s</span>${starPart}<span>· Place Pillar</span>
            </button>
            <button type="button" class="touch-cancel-btn" data-touch-action="cancel" aria-label="Dismiss">
              ${icon('close', 15)}
            </button>
          `;
        } else {
          nextClass = 'cursor-telemetry-pill touch-interactive invalid';
          nextHtml = `
            <span class="touch-blocked-label">
              ${icon('close', 14)}
              <span>${escapeHtml(info.reason || 'Blocked')}</span>
            </span>
            <button type="button" class="touch-cancel-btn" data-touch-action="cancel" aria-label="Dismiss">
              ${icon('close', 15)}
            </button>
          `;
        }

        const sig = `touch|${nextClass}|${nextHtml}`;
        if (this.lastPillSignature !== sig) {
          pill.className = nextClass;
          pill.innerHTML = nextHtml;
          this.lastPillSignature = sig;
        }

        const pillW = pill.offsetWidth || 220;
        const pillH = pill.offsetHeight || 52;
        const minTop = window.innerWidth <= 980 ? 112 : 64;
        const maxTop = Math.max(minTop, window.innerHeight - pillH - 82);

        const clampedX = Math.max(
          10,
          Math.min(window.innerWidth - pillW - 10, info.screenX - pillW * 0.5)
        );
        const clampedY = Math.max(
          minTop,
          Math.min(maxTop, info.screenY - 64 - pillH * 0.5)
        );

        pill.style.transform = `translate3d(${Math.round(clampedX)}px, ${Math.round(clampedY)}px, 0)`;
        return;
      }

      // Desktop Mouse Hover Preview Pill (pointer-events: none)
      this.touchConfirmAction = null;
      this.touchCancelAction = null;

      let nextClass = 'cursor-telemetry-pill neutral';
      let nextHtml = '';

      if (info.existingTower) {
        const label =
          this.renderer3d.activeTool === 'SELL'
            ? 'Reclaim · +1 Pillar'
            : 'Right-click · +1 Pillar';
        nextClass = 'cursor-telemetry-pill neutral';
        nextHtml = `${icon('reclaim', 14)}<span>${label}</span>`;
      } else if (info.valid) {
        const dt = info.deltaTime ?? 0;
        const dOver = info.deltaOvercharge ?? 0;
        const sign = dt >= 0 ? '+' : '';
        const tone =
          dt > 0.05 || dOver > 0
            ? 'positive'
            : dt < -0.05
            ? 'negative'
            : 'neutral';
        nextClass = `cursor-telemetry-pill ${tone}`;
        const starBadge =
          dOver > 0
            ? `<span class="overcharge-star">+${dOver}${icon('starFilled', 12)}</span>`
            : '';
        nextHtml = `<span>${sign}${dt.toFixed(1)}s</span>${starBadge}`;
      } else {
        nextClass = 'cursor-telemetry-pill invalid';
        nextHtml = `${icon('close', 13)}<span>${escapeHtml(info.reason || 'Blocked')}</span>`;
      }

      const sig = `hover|${nextClass}|${nextHtml}`;
      if (this.lastPillSignature !== sig) {
        pill.className = nextClass;
        pill.innerHTML = nextHtml;
        this.lastPillSignature = sig;
      }

      const pillW = pill.offsetWidth || 120;
      const offsetX = Math.max(
        10,
        Math.min(window.innerWidth - pillW - 12, info.screenX + 18)
      );
      const offsetY = Math.max(
        64,
        Math.min(window.innerHeight - 76, info.screenY - 22)
      );
      pill.style.transform = `translate3d(${Math.round(offsetX)}px, ${Math.round(offsetY)}px, 0)`;
    };
  }

  private syncAudioMuteButtons() {
    const iconMarkup = icon(
      soundEngine.muted ? 'volumeOff' : 'volumeOn',
      18
    );
    const drawerIconMarkup = icon(
      soundEngine.muted ? 'volumeOff' : 'volumeOn',
      16
    );

    const muteBtn = document.getElementById('btn-mute');
    const muteIconSlot = document.getElementById('mute-icon-slot');
    if (muteIconSlot) muteIconSlot.innerHTML = iconMarkup;
    muteBtn?.classList.toggle('active', soundEngine.muted);

    const drawerMuteBtn = document.getElementById('btn-drawer-mute');
    const drawerMuteIconSlot = document.getElementById('drawer-mute-icon-slot');
    if (drawerMuteIconSlot) drawerMuteIconSlot.innerHTML = drawerIconMarkup;
    drawerMuteBtn?.classList.toggle('active', soundEngine.muted);
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
    }
    this.dismissAllTransientOverlays();
    this.hideCursorPill();
    this.renderer3d.clearTouchPreview?.();
    document.getElementById('home-hub-modal')?.classList.remove('hidden');
    this.send({ type: 'REQUEST_LOBBIES' });
  }

  private closeHub() {
    document.getElementById('home-hub-modal')?.classList.add('hidden');
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

  private setupHubEvents() {
    document.getElementById('btn-open-hub')?.addEventListener('click', () => {
      this.openHub('play');
    });

    document
      .getElementById('btn-open-leaderboard')
      ?.addEventListener('click', () => {
        this.openHub('leaderboard');
      });

    document
      .getElementById('btn-drawer-open-config')
      ?.addEventListener('click', () => {
        this.dismissAllTransientOverlays();
        this.openHub('play', 'setup');
      });

    document
      .getElementById('btn-results-leaderboard')
      ?.addEventListener('click', () => {
        if (this.roomState) {
          this.selectedLeaderboardRound =
            this.roomState.roundConfig.roundNumber;
          this.leaderboardMode = 'rounds';
        }
        this.openHub('leaderboard');
      });

    document.getElementById('btn-close-hub')?.addEventListener('click', () => {
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
          const tab = btn.dataset.hubTab as 'play' | 'leaderboard' | 'codex';
          this.switchHubTab(tab);
        });
      });

    // Mobile Sub-Tab Switcher (Active Rooms | Match Setup)
    document
      .querySelectorAll<HTMLButtonElement>('#hub-play-subtabs .subtab-pill')
      .forEach((btn) => {
        btn.addEventListener('click', () => {
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
        localStorage.setItem('mc2026_player_name', clean);
        if (hubNameInput) hubNameInput.value = clean;
        if (drawerNameInput) drawerNameInput.value = clean;
        this.send({ type: 'SET_NAME', playerName: clean });
      }
    };

    hubNameInput?.addEventListener('change', () =>
      commitName(hubNameInput.value)
    );

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
      });
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

    // Instant Solo Arena
    document.getElementById('btn-quick-solo')?.addEventListener('click', () => {
      const soloCode = `SOLO${Math.floor(10 + Math.random() * 89)}`;
      this.send({
        type: 'CREATE_ROOM',
        roomCode: soloCode,
        playerName: this.playerName,
        settings: {
          roomName: `${this.playerName}'s Sanctum`,
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

    // Restart Match
    document
      .getElementById('btn-hub-restart-match')
      ?.addEventListener('click', () => {
        this.send({ type: 'RESTART_MATCH' });
        this.showToast('Match restarted from Round 1', true);
        this.closeHub();
      });

    // Copy Invite URL
    document
      .getElementById('btn-hub-copy-invite')
      ?.addEventListener('click', () => {
        const shareUrl = `${window.location.origin}/?room=${this.roomCode}`;
        navigator.clipboard?.writeText(shareUrl).catch(() => {});
        this.showToast(`Invite link copied (${this.roomCode})`, true);
      });

    // Refresh Public Rooms
    document
      .getElementById('btn-refresh-lobbies')
      ?.addEventListener('click', () => {
        this.send({ type: 'REQUEST_LOBBIES' });
        this.fetchInitialHubData();
      });

    // Segmented Controls in Match Setup
    document
      .querySelectorAll<HTMLElement>('.match-config-pane .segmented-control')
      .forEach((group) => {
        group.querySelectorAll<HTMLButtonElement>('.seg-btn').forEach((btn) => {
          btn.addEventListener('click', () => {
            group
              .querySelectorAll<HTMLButtonElement>('.seg-btn')
              .forEach((b) => b.classList.remove('active'));
            btn.classList.add('active');
          });
        });
      });

    // Apply Settings to Current Room
    document
      .getElementById('btn-apply-room-settings')
      ?.addEventListener('click', () => {
        const settings = this.readConfigFormSettings();
        this.send({
          type: 'UPDATE_SETTINGS',
          settings,
        });
        this.showToast(
          `Updated rules for ${this.roomCode} (${settings.totalRounds} Rounds)`,
          true
        );
        this.closeHub();
      });

    // Create New Custom Room
    document
      .getElementById('btn-create-custom-room')
      ?.addEventListener('click', () => {
        const settings = this.readConfigFormSettings();
        const customCode = `CIT${Math.floor(100 + Math.random() * 899)}`;
        this.send({
          type: 'CREATE_ROOM',
          roomCode: customCode,
          playerName: this.playerName,
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
      nameInput?.value.trim().slice(0, 26) || `${this.playerName}'s Citadel`;

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
  }

  private renderLobbyBrowser() {
    const listEl = document.getElementById('lobby-browser-list');
    const countEl = document.getElementById('public-lobby-count');
    const mobileCountEl = document.getElementById('mobile-lobby-count');
    if (!listEl) return;

    const rooms = this.lobbies;
    if (countEl) {
      countEl.textContent = `${rooms.length} Active`;
    }
    if (mobileCountEl) {
      mobileCountEl.textContent = String(rooms.length);
    }

    listEl.innerHTML = '';
    if (rooms.length === 0) {
      listEl.innerHTML = `<div style="color:var(--text-secondary);font-size:12.5px;padding:14px">No public rooms active right now. Create a new room or start Instant Solo.</div>`;
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
          : `Results`;

      const paceDesc =
        r.settings.buildTimeSeconds === 999
          ? 'Relaxed'
          : r.settings.buildTimeSeconds > 0
          ? `${r.settings.buildTimeSeconds}s Timer`
          : 'Standard';

      const fogSuffix = r.settings.fogOfWar ? ' · Fog of War' : '';
      const subtitleText = `Host: ${escapeHtml(r.hostName)} · ${r.totalRounds} Rounds · ${paceDesc}${fogSuffix}`;

      card.innerHTML = `
        <div class="lobby-card-main">
          <div class="lobby-card-title-row">
            <span class="lobby-card-name">${escapeHtml(r.roomName)}</span>
            <span class="room-code-badge">${escapeHtml(r.roomCode)}</span>
            <span class="lobby-phase-dot${r.phase === 'RUN' ? ' running' : ''}">${phaseText}</span>
          </div>
          <div class="lobby-card-subtitle">${subtitleText}</div>
        </div>
        <div class="lobby-card-right">
          <span class="capacity-pill" title="${r.humanCount} Human · ${r.botCount} AI">
            ${icon('users', 14)}
            <span>${r.playerCount}/${r.maxPlayers}</span>
          </span>
          <button type="button" class="hub-action-pill ${isCurrent ? 'sage' : 'gold'}">
            ${isCurrent ? `${icon('check', 14)}<span>Active</span>` : `<span>Join</span>`}
          </button>
        </div>
      `;

      const btn = card.querySelector('button')!;
      btn.addEventListener('click', () => {
        if (isCurrent) {
          this.closeHub();
        } else {
          this.roomCode = r.roomCode;
          this.send({
            type: 'JOIN_ROOM',
            roomCode: r.roomCode,
            playerName: this.playerName,
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

    pillsWrap
      ?.querySelectorAll<HTMLButtonElement>('.lb-round-pill')
      .forEach((btn) => {
        btn.classList.toggle(
          'active',
          Number(btn.dataset.rnum) === this.selectedLeaderboardRound
        );
      });

    if (!this.leaderboard) {
      tableWrap.innerHTML = `<div style="color:var(--text-secondary);font-size:12.5px;padding:14px">Loading Hall of Fame...</div>`;
      return;
    }

    tableWrap.innerHTML = '';

    if (this.leaderboardMode === 'rounds') {
      pillsWrap?.classList.remove('hidden');
      const roundCfg =
        ROUNDS.find((r) => r.roundNumber === this.selectedLeaderboardRound) ||
        ROUNDS[0];
      const arch = RUNNER_ARCHETYPES[roundCfg.runnerType || 'SCOUT'];

      metaEl.innerHTML = `
        <div class="lb-meta-main">
          <strong>Round ${roundCfg.roundNumber}: ${escapeHtml(roundCfg.title)}</strong>
          <span class="lb-meta-trait">${getRunnerIcon(
            roundCfg.runnerType || 'SCOUT',
            14
          )} ${escapeHtml(arch.name)} — ${escapeHtml(arch.traitSummary)}</span>
        </div>
        <div class="par-pill">
          ${icon('starFilled', 11)}
          <span>Par ${roundCfg.parTimeSeconds.toFixed(1)}s</span>
        </div>
      `;

      const records =
        this.leaderboard.roundRecords[this.selectedLeaderboardRound] || [];
      if (records.length === 0) {
        tableWrap.innerHTML = `<div style="color:var(--text-secondary);font-size:12.5px;padding:14px">No survival records yet for Round ${this.selectedLeaderboardRound}. Complete a run to claim 1st place!</div>`;
        return;
      }

      records.forEach((rec, idx) => {
        const row = document.createElement('div');
        const rankClass = idx < 3 ? ` rank-${idx + 1}` : '';
        row.className = `lb-row${rankClass}`;
        const rankBadge =
          idx < 3
            ? getMedalBadge((idx + 1) as 1 | 2 | 3, 22)
            : `<span>#${idx + 1}</span>`;
        const parBadge = rec.beatPar
          ? `<span class="par-pill">${icon('starFilled', 10)}<span>Par</span></span>`
          : '';

        row.innerHTML = `
          <div class="lb-rank">${rankBadge}</div>
          <div class="lb-architect">
            <span class="player-swatch" style="background:${escapeHtml(rec.playerColor)}"></span>
            <span>${escapeHtml(rec.playerName)}</span>
          </div>
          <div class="lb-time-primary">
            <span>${rec.survivalTimeSeconds.toFixed(2)}s</span>
            ${parBadge}
          </div>
          <div class="lb-synergies">
            <span class="stat-chip" title="Spire Hits">${icon('bolt', 12)} ${rec.clapsTaken}</span>
            <span class="stat-chip" title="Overcharge Stars">${icon('starFilled', 11)} ${rec.overchargedSpires}</span>
            <span class="stat-chip" title="Linked Keeps">${icon('keep', 12)} ${rec.linkedKeeps}</span>
            <span class="stat-chip" title="Path Length">${rec.pathDistance.toFixed(0)}m</span>
          </div>
          <div class="lb-meta-right">
            ${escapeHtml(rec.roomCode)} · ${Math.round((rec.goldMultiplier || 1) * 100)}%
          </div>
        `;
        tableWrap.appendChild(row);
      });
    } else {
      pillsWrap?.classList.add('hidden');
      metaEl.innerHTML = `
        <div class="lb-meta-main">
          ${icon('crown', 16)}
          <strong>Citadel Career Champions</strong>
          <span class="lb-meta-trait">Ranked by total points, match victories &amp; Par stars</span>
        </div>
        <div class="meta-pill">All-Time</div>
      `;

      const champs = this.leaderboard.champions || [];
      if (champs.length === 0) {
        tableWrap.innerHTML = `<div style="color:var(--text-secondary);font-size:12.5px;padding:14px">Complete a full match to crown the first Citadel Champion!</div>`;
        return;
      }

      champs.forEach((c, idx) => {
        const row = document.createElement('div');
        const rankClass = idx < 3 ? ` rank-${idx + 1}` : '';
        row.className = `lb-row${rankClass}`;
        const rankBadge =
          idx < 3
            ? getMedalBadge((idx + 1) as 1 | 2 | 3, 22)
            : `<span>#${idx + 1}</span>`;

        row.innerHTML = `
          <div class="lb-rank">${rankBadge}</div>
          <div class="lb-architect">
            <span class="player-swatch" style="background:${escapeHtml(c.playerColor)}"></span>
            <span>${escapeHtml(c.playerName)}</span>
          </div>
          <div class="lb-time-primary" style="color:var(--accent-sage)">
            <span>${c.totalCareerPoints} pts</span>
          </div>
          <div class="lb-synergies">
            <span class="stat-chip">${icon('trophy', 12)} ${c.matchesWon} Wins</span>
            <span class="stat-chip">${icon('starFilled', 11)} ${c.parStarsEarned} Par</span>
            <span class="stat-chip">${c.roundsPlayed} Rounds</span>
            <span class="stat-chip">${icon('clock', 12)} ${c.bestSurvivalTime.toFixed(1)}s (R${c.bestRoundNumber})</span>
          </div>
          <div class="lb-meta-right">
            Architect
          </div>
        `;
        tableWrap.appendChild(row);
      });
    }
  }

  private setupUIEvents() {
    // Bottom Build / Reclaim Tools
    document
      .querySelectorAll<HTMLButtonElement>('.dock-tool-btn')
      .forEach((btn) => {
        btn.addEventListener('click', () => {
          const tool = btn.dataset.tool as 'BLOCK' | 'SELL';
          this.selectTool(tool);
        });
      });

    // Bottom Progressive-Disclosure Tools Popover
    const dockToolsBtn = document.getElementById('btn-dock-tools')!;
    const dockToolsPopover = document.getElementById('dock-tools-popover')!;
    dockToolsBtn.addEventListener('click', (e) => {
      e.stopPropagation();
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
      const willOpen = standingsDropdown.classList.contains('hidden');
      this.dismissAllTransientOverlays();
      if (willOpen) {
        standingsDropdown.classList.remove('hidden');
        standingsBtn.classList.add('active');
      }
    });

    // Round Selector Popover
    const roundDropdown = document.getElementById('round-dropdown')!;
    const roundPickerBtn = document.getElementById('btn-round-picker')!;
    roundPickerBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const willOpen = roundDropdown.classList.contains('hidden');
      this.dismissAllTransientOverlays();
      if (willOpen) {
        roundDropdown.classList.remove('hidden');
      }
    });

    // Room & Chat Slide-Over Drawer
    const lobbyDrawer = document.getElementById('lobby-drawer')!;
    const lobbyToggleBtn = document.getElementById('btn-toggle-lobby')!;
    lobbyToggleBtn.addEventListener('click', (e) => {
      e.stopPropagation();
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
        lobbyDrawer.classList.add('hidden');
        lobbyToggleBtn.classList.remove('active');
      });

    // Global Outside-Click Dismissal for Popovers & Drawers
    window.addEventListener('click', (e) => {
      const target = e.target as HTMLElement;
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

    // Desktop Keyboard Shortcuts (WASD free for camera pan; Q = Build, E / X = Reclaim)
    window.addEventListener('keydown', (e) => {
      if ((e.target as HTMLElement)?.tagName === 'INPUT') return;
      const key = e.key.toUpperCase();
      if (key === 'Q' || key === 'B') this.selectTool('BLOCK');
      else if (key === 'E' || key === 'X') this.selectTool('SELL');
      else if (key === 'H') this.openHub('play');
      else if (key === 'L') this.openHub('leaderboard');
      else if (e.code === 'Escape') {
        this.dismissAllTransientOverlays();
        document.getElementById('help-modal')?.classList.add('hidden');
        this.renderer3d.clearTouchPreview?.();
        this.hideCursorPill();
        this.closeHub();
      } else if (e.code === 'Space') {
        const hubOpen = !document
          .getElementById('home-hub-modal')
          ?.classList.contains('hidden');
        if (!hubOpen) {
          e.preventDefault();
          this.send({ type: 'TOGGLE_READY' });
        }
      } else if (key === '0' || e.code === 'Tab') {
        e.preventDefault();
        if (this.renderer3d.arenaOverviewMode && this.localPlayerId) {
          this.renderer3d.focusOnPlayerIsland(this.localPlayerId);
        } else {
          this.renderer3d.focusArenaOverview();
        }
        this.updateScoreboardDOM();
      } else if (['1', '2', '3', '4', '5', '6'].includes(key)) {
        const idx = Number(key) - 1;
        const target = this.roomState?.players[idx];
        if (target) {
          this.renderer3d.focusOnPlayerIsland(target.id);
          this.updateScoreboardDOM();
        }
      }
    });

    document
      .querySelectorAll<HTMLButtonElement>('.speed-btn')
      .forEach((btn) => {
        btn.addEventListener('click', () => {
          const spd = Number(btn.dataset.speed) as 1 | 2 | 4;
          this.send({ type: 'SET_SIM_SPEED', speed: spd });
        });
      });

    document.getElementById('btn-reroll-map')?.addEventListener('click', () => {
      soundEngine.playCheckpoint();
      this.renderer3d.clearTouchPreview?.();
      this.hideCursorPill();
      this.hideTransientPopovers();
      this.send({ type: 'REROLL_MAP' });
    });

    document
      .getElementById('btn-demo-layout')
      ?.addEventListener('click', () => {
        soundEngine.playBuild('THUNDERCLAP');
        this.renderer3d.clearTouchPreview?.();
        this.hideCursorPill();
        this.hideTransientPopovers();
        this.send({ type: 'LOAD_PRESET_DEMO' });
      });

    document
      .getElementById('btn-reset-camera')
      ?.addEventListener('click', () => {
        this.hideTransientPopovers();
        if (typeof this.renderer3d.resetCameraView === 'function') {
          this.renderer3d.resetCameraView();
        } else if (this.localPlayerId) {
          this.renderer3d.focusOnPlayerIsland(this.localPlayerId);
        }
        this.updateScoreboardDOM();
      });

    document.getElementById('btn-clear-maze')?.addEventListener('click', () => {
      soundEngine.playSell();
      this.renderer3d.clearTouchPreview?.();
      this.hideCursorPill();
      this.hideTransientPopovers();
      this.send({ type: 'CLEAR_TOWERS' });
    });

    document.getElementById('btn-ready-lock')?.addEventListener('click', () => {
      this.renderer3d.clearTouchPreview?.();
      this.hideCursorPill();
      this.hideTransientPopovers();
      this.send({ type: 'TOGGLE_READY' });
    });

    document.getElementById('btn-next-round')?.addEventListener('click', () => {
      this.send({ type: 'NEXT_ROUND' });
    });

    document
      .getElementById('btn-camera-overview')
      ?.addEventListener('click', () => {
        this.renderer3d.clearTouchPreview?.();
        this.hideCursorPill();
        if (this.renderer3d.arenaOverviewMode && this.localPlayerId) {
          this.renderer3d.focusOnPlayerIsland(this.localPlayerId);
        } else {
          this.renderer3d.focusArenaOverview();
        }
        this.updateScoreboardDOM();
      });

    const toggleMute = () => {
      soundEngine.muted = !soundEngine.muted;
      this.syncAudioMuteButtons();
    };
    document.getElementById('btn-mute')?.addEventListener('click', toggleMute);
    document
      .getElementById('btn-drawer-mute')
      ?.addEventListener('click', toggleMute);

    const helpModal = document.getElementById('help-modal')!;
    document.getElementById('btn-help')?.addEventListener('click', () => {
      this.dismissAllTransientOverlays();
      this.hideCursorPill();
      helpModal.classList.remove('hidden');
    });
    document.getElementById('btn-close-help')?.addEventListener('click', () => {
      helpModal.classList.add('hidden');
    });
    document
      .getElementById('btn-close-help-x')
      ?.addEventListener('click', () => {
        helpModal.classList.add('hidden');
      });
    helpModal.addEventListener('click', (e) => {
      if (e.target === helpModal) {
        helpModal.classList.add('hidden');
      }
    });

    const nameInput = document.getElementById(
      'player-name-input'
    ) as HTMLInputElement | null;
    nameInput?.addEventListener('change', () => {
      const val = nameInput.value.trim().slice(0, 18);
      if (val) {
        this.playerName = val;
        localStorage.setItem('mc2026_player_name', val);
        const hubName = document.getElementById(
          'hub-player-name-input'
        ) as HTMLInputElement | null;
        if (hubName) hubName.value = val;
        this.send({ type: 'SET_NAME', playerName: val });
      }
    });

    document
      .getElementById('btn-copy-invite')
      ?.addEventListener('click', () => {
        const shareUrl = `${window.location.origin}/?room=${this.roomCode}`;
        navigator.clipboard?.writeText(shareUrl).catch(() => {});
        this.showToast(`Invite link copied (${this.roomCode})`, true);
      });

    document.getElementById('btn-add-bot')?.addEventListener('click', () => {
      this.send({ type: 'ADD_BOT' });
    });

    document.getElementById('btn-remove-bot')?.addEventListener('click', () => {
      this.send({ type: 'REMOVE_BOT' });
    });

    const fogChk = document.getElementById(
      'chk-fog'
    ) as HTMLInputElement | null;
    fogChk?.addEventListener('change', () => {
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

  private selectTool(tool: 'BLOCK' | 'SELL') {
    this.renderer3d.activeTool = tool;
    this.renderer3d.clearTouchPreview?.();
    this.hideCursorPill();
    document
      .querySelectorAll<HTMLButtonElement>('.dock-tool-btn')
      .forEach((c) => {
        c.classList.toggle('active', c.dataset.tool === tool);
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
      btn.title = `${r.subtitle} (${arch.name}: ${arch.traitSummary}) — ${r.hint}`;
      btn.addEventListener('click', () => {
        this.send({ type: 'JUMP_TO_ROUND', roundIndex: idx });
        document.getElementById('round-dropdown')?.classList.add('hidden');
      });
      container.appendChild(btn);
    });
  }

  private updateTopBarAndResources() {
    if (!this.roomState) return;
    const round = this.roomState.roundConfig;
    const arch = RUNNER_ARCHETYPES[round.runnerType || 'SCOUT'];
    const totalRounds = this.roomState.settings?.totalRounds || ROUNDS.length;

    document.getElementById('round-code-label')!.textContent =
      `R${round.roundNumber}/${totalRounds}`;
    document.getElementById('round-subtitle')!.textContent = round.title;
    document.getElementById('btn-round-picker')!.title =
      `Round ${round.roundNumber}: ${round.title} — Runner: ${arch.name} (${arch.traitSummary})`;
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
    featureParts.push(
      `${getRunnerIcon(round.runnerType || 'SCOUT', 12)} ${escapeHtml(arch.name)}`
    );

    document.getElementById('map-features-summary')!.innerHTML =
      featureParts.join(' · ');

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
        this.roomState.phase === 'GAME_OVER' ? 'FINAL' : 'RESULTS';
      speedControls.classList.add('hidden');
    }

    this.updateTimerDOM();

    document.querySelectorAll<HTMLButtonElement>('.speed-btn').forEach((b) => {
      b.classList.toggle(
        'active',
        Number(b.dataset.speed) === this.roomState?.simSpeedMultiplier
      );
    });

    const me = this.roomState.players.find((p) => p.id === this.localPlayerId);
    if (me) {
      const wallsLeft = Math.floor(me.gold / TOWER_SPECS.BLOCK.goldCost);
      const goldEl = document.getElementById('gold-value')!;
      goldEl.textContent = `${wallsLeft}`;
      goldEl.style.color =
        wallsLeft === 0 ? 'var(--accent-coral)' : 'var(--text-primary)';
      document.getElementById('walls-chip')!.title =
        `${wallsLeft} Stone Pillars remaining (100% Pillar Refund on Reclaim)`;

      const dockBadge = document.getElementById('dock-pillars-badge');
      if (dockBadge) {
        dockBadge.textContent = `${wallsLeft}`;
        dockBadge.classList.toggle('empty', wallsLeft === 0);
      }

      const evalRun = evaluateMazeRunTime(round, me.towers);
      const estEl = document.getElementById('est-time-value')!;
      estEl.textContent = `${evalRun.finishTimeSeconds.toFixed(1)}s / ${round.parTimeSeconds.toFixed(0)}s`;
      estEl.style.color =
        evalRun.finishTimeSeconds >= round.parTimeSeconds
          ? 'var(--accent-sage)'
          : 'var(--text-primary)';

      const timeChip = document.getElementById('time-chip');
      if (timeChip) {
        timeChip.title = `Simulated Survival: ${evalRun.finishTimeSeconds.toFixed(1)}s (Par ${round.parTimeSeconds.toFixed(0)}s) · Spire Hits: ${evalRun.clapsTaken} · Linked Keeps: ${evalRun.linkedKeeps}/${round.obstacles.length} · Overcharge: ${evalRun.overchargedSpires}★`;
      }

      const readyBtn = document.getElementById('btn-ready-lock')!;
      const readyText = document.getElementById('ready-btn-text')!;
      const readyIcon = document.getElementById('ready-btn-icon')!;
      if (me.ready) {
        readyBtn.classList.add('locked-in');
        readyIcon.classList.remove('hidden');
        readyText.textContent = 'Locked';
      } else {
        readyBtn.classList.remove('locked-in');
        readyIcon.classList.add('hidden');
        readyText.textContent = 'Ready';
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

  private updateTimerDOM() {
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
  }

  private updateScoreboardDOM() {
    if (!this.roomState) return;
    const list = document.getElementById('scoreboard-list')!;
    list.innerHTML = '';

    const overviewBtn = document.getElementById('btn-camera-overview')!;
    const overviewIcon = document.getElementById('overview-icon')!;
    const overviewLabel = document.getElementById('overview-label')!;
    overviewBtn.classList.toggle('active', this.renderer3d.arenaOverviewMode);
    overviewIcon.innerHTML = icon(
      this.renderer3d.arenaOverviewMode ? 'sanctum' : 'overview',
      17
    );
    overviewLabel.textContent = this.renderer3d.arenaOverviewMode
      ? 'Sanctum'
      : 'Arena';

    const sorted = [...this.roomState.players].sort(
      (a, b) => b.totalScore - a.totalScore
    );

    const countMeta = document.getElementById('standings-count-meta');
    if (countMeta) {
      countMeta.textContent = `${sorted.length} ${
        sorted.length === 1 ? 'Player' : 'Players'
      }`;
    }

    // Update Compact Top-Left Standings Pill Summary
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
          ? `<span class="standings-ready-icon" title="Ready">${icon('check', 13)}</span>`
          : '';

      row.title = `Spectate ${p.name}${isMe ? ' (You)' : ''} — ${p.totalScore} pts · ${p.pathDistance.toFixed(0)}m path`;
      row.innerHTML = `
        <span class="standings-row-left">
          <span class="standings-rank">${idx + 1}.</span>
          <span class="player-swatch" style="background:${escapeHtml(p.color)}"></span>
          <span class="standings-name">${isMe ? 'You' : escapeHtml(p.name)}</span>
          ${readyHtml}
        </span>
        <span class="standings-row-right" id="sub-telemetry-${p.id}">${p.totalScore}p</span>
      `;

      row.addEventListener('click', () => {
        this.renderer3d.clearTouchPreview?.();
        this.hideCursorPill();
        this.renderer3d.focusOnPlayerIsland(p.id);
        document.getElementById('standings-dropdown')?.classList.add('hidden');
        document
          .getElementById('btn-standings-toggle')
          ?.classList.remove('active');
        this.updateScoreboardDOM();
      });

      list.appendChild(row);
    });
  }

  private updateLiveRunScoreboard() {
    const activeTargetId =
      (!this.renderer3d.arenaOverviewMode && this.renderer3d.focusedPlayerId) ||
      this.localPlayerId;
    const pillScoreEl = document.getElementById('standings-score');

    for (const [pid, sim] of this.simulators.entries()) {
      const formatted = sim.state.finished
        ? `${sim.state.finishTimeSeconds.toFixed(1)}s`
        : `${sim.elapsedSeconds.toFixed(1)}s`;
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

      if (pillScoreEl && pid === activeTargetId) {
        pillScoreEl.textContent = formatted;
        pillScoreEl.style.color = toneColor;
      }
    }
  }

  private renderRoundResultsModal(state: RoomState) {
    const round = state.roundConfig;
    const isGameOver = state.phase === 'GAME_OVER';
    const roundsDone = state.roundsCompleted || round.roundNumber;
    const totalRounds = state.settings?.totalRounds || ROUNDS.length;

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
      recordCallout.innerHTML = `${icon('trophy', 15)} <span>New Hall of Fame Top-5 Record on Round ${round.roundNumber} by ${escapeHtml(state.newRecordHolders.join(', '))}!</span>`;
    } else {
      recordCallout.classList.add('hidden');
    }

    if (isGameOver) {
      titleEl.textContent = 'Citadel Championship Complete';
      subEl.textContent = `Final standings across ${totalRounds} rounds — recorded to the Hall of Fame.`;
      nextBtnLabel.textContent = 'Play New Match';

      const overallRanked = [...state.players].sort(
        (a, b) =>
          b.totalScore - a.totalScore || b.bestMazeTime - a.bestMazeTime
      );
      podiumEl.classList.remove('hidden');
      podiumEl.innerHTML = '';

      overallRanked.slice(0, 3).forEach((p, idx) => {
        const card = document.createElement('div');
        card.className = `podium-card${idx === 0 ? ' first' : ''}`;
        const medalSvg = getMedalBadge((idx + 1) as 1 | 2 | 3, 28);
        card.innerHTML = `
          <div class="podium-medal">${medalSvg}</div>
          <div class="podium-name">${escapeHtml(p.name)}</div>
          <div class="podium-pts">${p.totalScore} pts</div>
          <div class="podium-sub">Best ${p.bestMazeTime.toFixed(1)}s · ${p.parStarsEarned || 0} Par</div>
        `;
        podiumEl.appendChild(card);
      });
    } else {
      titleEl.textContent = `Round ${round.roundNumber} · ${round.title}`;
      subEl.textContent = `Par Target: ${round.parTimeSeconds.toFixed(1)}s (+2 bonus points for beating Par)`;
      nextBtnLabel.textContent = 'Next Round';
      podiumEl.classList.add('hidden');
    }

    const table = document.getElementById('results-table')!;
    table.innerHTML = '';

    const ranked = [...state.players].sort((a, b) =>
      isGameOver
        ? b.totalScore - a.totalScore ||
          (b.lastRoundTime || 0) - (a.lastRoundTime || 0)
        : (b.lastRoundTime || 0) - (a.lastRoundTime || 0)
    );

    ranked.forEach((p, idx) => {
      const row = document.createElement('div');
      row.className = `result-row${idx === 0 ? ' winner' : ''}`;
      const rankHtml =
        idx < 3
          ? getMedalBadge((idx + 1) as 1 | 2 | 3, 20)
          : `#${idx + 1}`;
      const beatPar =
        (p.lastRoundTime || 0) >= round.parTimeSeconds
          ? `<span class="par-pill">${icon('starFilled', 10)}<span>Par</span></span>`
          : '';
      const synBadges = `<span class="stat-chip">${icon('bolt', 11)} ${p.lastRoundClaps || 0} · ${icon('starFilled', 10)} ${p.lastRoundOvercharge || 0} · ${p.pathDistance.toFixed(0)}m</span>`;

      row.innerHTML = `
        <div class="result-row-left">
          <span class="result-rank-slot">${rankHtml}</span>
          <span class="player-swatch" style="background:${escapeHtml(p.color)}"></span>
          <strong>${escapeHtml(p.name)}</strong>
          ${beatPar}
          ${synBadges}
        </div>
        <div class="result-stats">
          <strong>${(p.lastRoundTime || 0).toFixed(2)}s</strong>
          <span style="color:var(--accent-sage)">+${p.lastRoundPoints}p</span>
          <span style="color:var(--accent-gold)">(${p.totalScore}p)</span>
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
