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
import { Arena3DRenderer } from './renderer3d.js';

class MazingContestClient {
  private renderer3d: Arena3DRenderer;
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

  constructor() {
    const viewport = document.getElementById('viewport-container')!;
    const labels = document.getElementById('world-labels')!;
    this.renderer3d = new Arena3DRenderer(viewport, labels);

    const urlParams = new URLSearchParams(window.location.search);
    const urlRoom = urlParams.get('room');
    this.roomCode = (urlRoom || 'ARENA1').toUpperCase().slice(0, 8);
    this.playerName =
      localStorage.getItem('mc2026_player_name') ||
      `Architect-${Math.floor(100 + Math.random() * 899)}`;

    const nameInput = document.getElementById(
      'player-name-input'
    ) as HTMLInputElement;
    if (nameInput) nameInput.value = this.playerName;

    const hubNameInput = document.getElementById(
      'hub-player-name-input'
    ) as HTMLInputElement;
    if (hubNameInput) hubNameInput.value = this.playerName;

    // If user arrived via a direct ?room= invite link, drop straight into the 3D arena
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
      // WebSocket will also supply LOBBY_LIST & LEADERBOARD_DATA
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

  private applyRoomState(state: RoomState) {
    const prevPhase = this.roomState?.phase;
    this.roomState = state;

    this.renderer3d.syncRoomState(state, this.localPlayerId);

    if (state.phase === 'RUN' && prevPhase !== 'RUN') {
      this.startClientRunPhase(state);
    } else if (state.phase !== 'RUN') {
      this.runPhaseActive = false;
    }

    // Auto-hide bottom dock and cursor pill when not in BUILD phase
    const bottomDock = document.getElementById('hud-bottom-dock')!;
    const cursorPill = document.getElementById('cursor-telemetry-pill')!;
    if (state.phase === 'BUILD') {
      bottomDock.classList.remove('dock-hidden');
    } else {
      bottomDock.classList.add('dock-hidden');
      cursorPill.classList.add('hidden');
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
    if (!this.runPhaseActive || !this.roomState || this.roomState.phase !== 'RUN') {
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

    this.renderer3d.onHoverStatusChange = (info) => {
      const pill = document.getElementById('cursor-telemetry-pill')!;
      const hubOpen = !document
        .getElementById('home-hub-modal')
        ?.classList.contains('hidden');
      if (!info.cell || this.roomState?.phase !== 'BUILD' || hubOpen) {
        pill.classList.add('hidden');
        return;
      }

      pill.classList.remove('hidden');
      const offsetX = Math.min(window.innerWidth - 210, info.screenX + 18);
      const offsetY = Math.max(58, info.screenY - 22);
      pill.style.transform = `translate3d(${offsetX}px, ${offsetY}px, 0)`;

      if (info.existingTower) {
        pill.className = 'cursor-telemetry-pill neutral';
        pill.innerHTML = `♻️ +5G Refund`;
        return;
      }

      if (info.valid) {
        const dt = info.deltaTime ?? 0;
        const dc = info.deltaClaps ?? 0;
        const dk = info.deltaKeeps ?? 0;
        const dOver = info.deltaOvercharge ?? 0;
        const sign = dt >= 0 ? '+' : '';
        const tone =
          dt > 0.05 || dOver > 0
            ? 'positive'
            : dt < -0.05
            ? 'negative'
            : 'neutral';
        pill.className = `cursor-telemetry-pill ${tone}`;

        const clapBadge =
          dc !== 0
            ? `<span class="clap-delta">⚡${dc > 0 ? `+${dc}` : dc}</span>`
            : '';
        const keepBadge =
          dk > 0 ? `<span class="link-delta">🏰+${dk} Keep</span>` : '';
        const overchargeBadge =
          dOver > 0
            ? `<span class="overcharge-delta">🔥+${dOver}★</span>`
            : '';
        pill.innerHTML = `<span>${sign}${dt.toFixed(1)}s</span>${clapBadge}${keepBadge}${overchargeBadge}`;
      } else {
        pill.className = 'cursor-telemetry-pill invalid';
        pill.innerHTML = `✕ ${info.reason || 'Blocked'}`;
      }
    };
  }

  private openHub(tab?: 'play' | 'leaderboard' | 'codex') {
    if (tab) {
      this.switchHubTab(tab);
    }
    if (this.roomState) {
      this.syncConfigFormFromSettings(this.roomState.settings);
    }
    document.getElementById('home-hub-modal')?.classList.remove('hidden');
    document.getElementById('cursor-telemetry-pill')?.classList.add('hidden');
    this.send({ type: 'REQUEST_LOBBIES' });
  }

  private closeHub() {
    document.getElementById('home-hub-modal')?.classList.add('hidden');
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
        document.getElementById('lobby-drawer')?.classList.add('hidden');
        document.getElementById('btn-toggle-lobby')?.classList.remove('active');
        this.openHub('play');
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

    // Clicking outside hub-shell on the backdrop closes hub
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

    // Sync player name between Hub and Drawer inputs
    const hubNameInput = document.getElementById(
      'hub-player-name-input'
    ) as HTMLInputElement;
    const drawerNameInput = document.getElementById(
      'player-name-input'
    ) as HTMLInputElement;

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
    ) as HTMLInputElement;
    const handleJoinByCode = () => {
      const code = (joinCodeInput?.value || '')
        .trim()
        .toUpperCase()
        .replace(/[^A-Z0-9-]/g, '')
        .slice(0, 8);
      if (!code) {
        this.showToast('Enter a valid Room Code (e.g. ARENA1)');
        return;
      }
      this.roomCode = code;
      this.send({
        type: 'JOIN_ROOM',
        roomCode: code,
        playerName: this.playerName,
      });
      this.showToast(`Joined Lobby ${code}!`, true);
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
          roomName: `${this.playerName}'s Solo Sanctum`,
          isPublic: false,
          totalRounds: 8,
          buildTimeSeconds: 0,
          goldMultiplier: 1.0,
          botCount: 3,
          botDifficulty: 'ARCHITECT',
          fogOfWar: false,
        },
      });
      this.showToast(`Launched Solo Sandbox (${soloCode})!`, true);
      this.closeHub();
    });

    // Restart Match
    document
      .getElementById('btn-hub-restart-match')
      ?.addEventListener('click', () => {
        this.send({ type: 'RESTART_MATCH' });
        this.showToast('Match restarted from Round 1!', true);
        this.closeHub();
      });

    // Copy Invite URL
    document
      .getElementById('btn-hub-copy-invite')
      ?.addEventListener('click', () => {
        const shareUrl = `${window.location.origin}/?room=${this.roomCode}`;
        navigator.clipboard?.writeText(shareUrl).catch(() => {});
        this.showToast(`Copied invite link: ${shareUrl}`, true);
      });

    // Refresh Public Lobbies
    document
      .getElementById('btn-refresh-lobbies')
      ?.addEventListener('click', () => {
        this.send({ type: 'REQUEST_LOBBIES' });
        this.fetchInitialHubData();
      });

    // Segmented Controls in Match Configurator
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
          `Applied rules to ${this.roomCode} (${settings.totalRounds} Rounds · ${Math.round(
            settings.goldMultiplier * 100
          )}% Pillars)!`,
          true
        );
        this.closeHub();
      });

    // Create New Custom Lobby
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
        this.showToast(
          `Created Lobby ${customCode}: ${settings.roomName}!`,
          true
        );
        this.closeHub();
      });

    // Leaderboard Mode Switcher (Round Survival Records vs. Career Champions)
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
    ) as HTMLInputElement;
    const roomName =
      nameInput?.value.trim().slice(0, 26) ||
      `${this.playerName}'s Citadel`;

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
    ) as HTMLInputElement;
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

    const fogChk = document.getElementById('chk-fog') as HTMLInputElement;
    if (fogChk) {
      fogChk.checked = Boolean(settings.fogOfWar);
    }
  }

  private renderLobbyBrowser() {
    const listEl = document.getElementById('lobby-browser-list');
    const countEl = document.getElementById('public-lobby-count');
    if (!listEl) return;

    const rooms = this.lobbies;
    if (countEl) {
      countEl.textContent = `${rooms.length} Active`;
    }

    listEl.innerHTML = '';
    if (rooms.length === 0) {
      listEl.innerHTML = `<div style="color:#94a3b8;font-size:12px;padding:12px">No public lobbies found. Click "✨ Create New Lobby" to host one!</div>`;
      return;
    }

    for (const r of rooms) {
      const isCurrent = r.roomCode === this.roomCode;
      const card = document.createElement('div');
      card.className = `lobby-card${isCurrent ? ' current-room' : ''}`;

      const phaseBadge =
        r.phase === 'BUILD'
          ? `🟢 BUILD R${r.currentRound}/${r.totalRounds}`
          : r.phase === 'RUN'
          ? `🟠 RUN R${r.currentRound}/${r.totalRounds}`
          : `🏆 RESULTS`;

      const timerLabel =
        r.settings.buildTimeSeconds === 0
          ? '⏱ Default'
          : r.settings.buildTimeSeconds === 999
          ? '∞ Sandbox'
          : `⏱ ${r.settings.buildTimeSeconds}s`;

      const goldLabel = `🏰 ${Math.round(
        (r.settings.goldMultiplier || 1) * 100
      )}% Pillars`;
      const botLabel = `🤖 ${r.botCount} ${r.settings.botDifficulty}`;
      const fogLabel = r.settings.fogOfWar
        ? `<span class="rule-tag">🌫️ Blind Fog</span>`
        : '';

      card.innerHTML = `
        <div class="lobby-card-main">
          <div class="lobby-card-title-row">
            <span class="room-code-badge">${r.roomCode}</span>
            <span class="lobby-card-name">${r.roomName}</span>
            <span class="rule-tag">${phaseBadge}</span>
          </div>
          <div class="lobby-card-tags">
            <span class="rule-tag">👑 ${r.hostName}</span>
            <span class="rule-tag">${r.totalRounds} Rounds</span>
            <span class="rule-tag">${timerLabel}</span>
            <span class="rule-tag">${goldLabel}</span>
            <span class="rule-tag">${botLabel}</span>
            ${fogLabel}
          </div>
        </div>
        <div class="lobby-card-right">
          <span class="capacity-pill">👤 ${r.humanCount} · Total ${r.playerCount}/${r.maxPlayers}</span>
          <button class="hub-action-pill ${isCurrent ? 'emerald' : ''}">
            ${isCurrent ? '✓ Active — Enter' : 'Join →'}
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
          this.showToast(`Joined ${r.roomName} (${r.roomCode})!`, true);
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
      btn.textContent = `R${r.roundNumber} ${arch.icon}`;
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

    // Sync round filter pill active state
    pillsWrap
      ?.querySelectorAll<HTMLButtonElement>('.lb-round-pill')
      .forEach((btn) => {
        btn.classList.toggle(
          'active',
          Number(btn.dataset.rnum) === this.selectedLeaderboardRound
        );
      });

    if (!this.leaderboard) {
      tableWrap.innerHTML = `<div style="color:#94a3b8;font-size:12px;padding:12px">Loading Grand Citadel Hall of Fame...</div>`;
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
        <div>
          <strong>Round ${roundCfg.roundNumber}: ${roundCfg.title}</strong>
          <span style="color:#94a3b8;margin-left:8px">${arch.icon} ${arch.name} — ${arch.traitSummary}</span>
        </div>
        <div class="meta-pill" style="color:#4ade80;border-color:rgba(74,222,128,0.4)">
          ★ Par Target: ${roundCfg.parTimeSeconds.toFixed(1)}s
        </div>
      `;

      const records =
        this.leaderboard.roundRecords[this.selectedLeaderboardRound] || [];
      if (records.length === 0) {
        tableWrap.innerHTML = `<div style="color:#94a3b8;font-size:12px;padding:12px">No records recorded yet for Round ${this.selectedLeaderboardRound}. Complete a run to claim #1!</div>`;
        return;
      }

      records.forEach((rec, idx) => {
        const row = document.createElement('div');
        const rankClass = idx < 3 ? ` rank-${idx + 1}` : '';
        row.className = `lb-row${rankClass}`;
        const medal =
          idx === 0
            ? '🥇 #1'
            : idx === 1
            ? '🥈 #2'
            : idx === 2
            ? '🥉 #3'
            : `#${idx + 1}`;
        const parBadge = rec.beatPar
          ? `<span class="meta-pill" style="color:#4ade80;border-color:rgba(74,222,128,0.45)">★ PAR</span>`
          : '';

        row.innerHTML = `
          <div class="lb-rank">${medal}</div>
          <div class="lb-architect">
            <span class="player-swatch" style="background:${rec.playerColor}"></span>
            <span>${rec.playerName}</span>
          </div>
          <div class="lb-time-primary">
            <span>${rec.survivalTimeSeconds.toFixed(2)}s</span>
            ${parBadge}
          </div>
          <div class="lb-synergies">
            <span class="rule-tag" title="Elemental Spire Hits">⚡ ${rec.clapsTaken} Claps</span>
            <span class="rule-tag" title="Overcharge Stars">🔥 ${rec.overchargedSpires}★</span>
            <span class="rule-tag" title="Linked Red Keeps">🧱 ${rec.linkedKeeps} Keeps</span>
            <span class="rule-tag" title="Total Labyrinth Distance">📏 ${rec.pathDistance.toFixed(0)}m</span>
          </div>
          <div class="lb-meta-right">
            ${rec.roomCode} · ${Math.round((rec.goldMultiplier || 1) * 100)}%
          </div>
        `;
        tableWrap.appendChild(row);
      });
    } else {
      pillsWrap?.classList.add('hidden');
      metaEl.innerHTML = `
        <div>
          <strong>👑 Grand Citadel Career Champions</strong>
          <span style="color:#94a3b8;margin-left:8px">Ranked by Total Career Points, Match Championships &amp; Par Stars Earned</span>
        </div>
        <div class="meta-pill">All-Time Standings</div>
      `;

      const champs = this.leaderboard.champions || [];
      champs.forEach((c, idx) => {
        const row = document.createElement('div');
        const rankClass = idx < 3 ? ` rank-${idx + 1}` : '';
        row.className = `lb-row${rankClass}`;
        const medal =
          idx === 0
            ? '🥇 #1'
            : idx === 1
            ? '🥈 #2'
            : idx === 2
            ? '🥉 #3'
            : `#${idx + 1}`;

        row.innerHTML = `
          <div class="lb-rank">${medal}</div>
          <div class="lb-architect">
            <span class="player-swatch" style="background:${c.playerColor}"></span>
            <span>${c.playerName}</span>
          </div>
          <div class="lb-time-primary" style="color:#4ade80">
            <span>${c.totalCareerPoints} PTS</span>
          </div>
          <div class="lb-synergies">
            <span class="rule-tag">🏆 ${c.matchesWon} Wins</span>
            <span class="rule-tag">★ ${c.parStarsEarned} Par Stars</span>
            <span class="rule-tag">⚔️ ${c.roundsPlayed} Rounds</span>
            <span class="rule-tag">⏱ Best: ${c.bestSurvivalTime.toFixed(2)}s (R${c.bestRoundNumber})</span>
          </div>
          <div class="lb-meta-right">
            Citadel Master
          </div>
        `;
        tableWrap.appendChild(row);
      });
    }
  }

  private setupUIEvents() {
    const toolBtns =
      document.querySelectorAll<HTMLButtonElement>('.dock-tool-btn');
    toolBtns.forEach((btn) => {
      btn.addEventListener('click', () => {
        const tool = btn.dataset.tool as 'BLOCK' | 'SELL';
        this.selectTool(tool);
      });
    });

    const roundDropdown = document.getElementById('round-dropdown')!;
    const roundPickerBtn = document.getElementById('btn-round-picker')!;
    roundPickerBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      roundDropdown.classList.toggle('hidden');
    });

    const lobbyDrawer = document.getElementById('lobby-drawer')!;
    const lobbyToggleBtn = document.getElementById('btn-toggle-lobby')!;
    lobbyToggleBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      lobbyDrawer.classList.toggle('hidden');
      lobbyToggleBtn.classList.toggle(
        'active',
        !lobbyDrawer.classList.contains('hidden')
      );
    });
    document.getElementById('btn-close-lobby')?.addEventListener('click', () => {
      lobbyDrawer.classList.add('hidden');
      lobbyToggleBtn.classList.remove('active');
    });

    window.addEventListener('click', (e) => {
      const target = e.target as HTMLElement;
      if (!target.closest('.round-selector-wrap')) {
        roundDropdown.classList.add('hidden');
      }
      if (
        !target.closest('#lobby-drawer') &&
        !target.closest('#btn-toggle-lobby')
      ) {
        lobbyDrawer.classList.add('hidden');
        lobbyToggleBtn.classList.remove('active');
      }
    });

    window.addEventListener('keydown', (e) => {
      if ((e.target as HTMLElement)?.tagName === 'INPUT') return;
      const key = e.key.toUpperCase();
      if (key === 'Q' || key === 'B') this.selectTool('BLOCK');
      else if (key === 'S') this.selectTool('SELL');
      else if (key === 'H') this.openHub('play');
      else if (key === 'L') this.openHub('leaderboard');
      else if (e.code === 'Escape') {
        roundDropdown.classList.add('hidden');
        lobbyDrawer.classList.add('hidden');
        lobbyToggleBtn.classList.remove('active');
        document.getElementById('help-modal')?.classList.add('hidden');
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

    document.querySelectorAll<HTMLButtonElement>('.speed-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const spd = Number(btn.dataset.speed) as 1 | 2 | 4;
        this.send({ type: 'SET_SIM_SPEED', speed: spd });
      });
    });

    document.getElementById('btn-reroll-map')?.addEventListener('click', () => {
      soundEngine.playCheckpoint();
      this.send({ type: 'REROLL_MAP' });
    });

    document.getElementById('btn-demo-layout')?.addEventListener('click', () => {
      soundEngine.playBuild('THUNDERCLAP');
      this.send({ type: 'LOAD_PRESET_DEMO' });
    });

    document.getElementById('btn-clear-maze')?.addEventListener('click', () => {
      soundEngine.playSell();
      this.send({ type: 'CLEAR_TOWERS' });
    });

    document.getElementById('btn-ready-lock')?.addEventListener('click', () => {
      this.send({ type: 'TOGGLE_READY' });
    });

    document.getElementById('btn-next-round')?.addEventListener('click', () => {
      this.send({ type: 'NEXT_ROUND' });
    });

    document
      .getElementById('btn-camera-overview')
      ?.addEventListener('click', () => {
        if (this.renderer3d.arenaOverviewMode && this.localPlayerId) {
          this.renderer3d.focusOnPlayerIsland(this.localPlayerId);
        } else {
          this.renderer3d.focusArenaOverview();
        }
        this.updateScoreboardDOM();
      });

    const muteBtn = document.getElementById('btn-mute')!;
    muteBtn.addEventListener('click', () => {
      soundEngine.muted = !soundEngine.muted;
      muteBtn.textContent = soundEngine.muted ? '🔇' : '🔊';
    });

    const helpModal = document.getElementById('help-modal')!;
    document.getElementById('btn-help')?.addEventListener('click', () => {
      helpModal.classList.remove('hidden');
    });
    document.getElementById('btn-close-help')?.addEventListener('click', () => {
      helpModal.classList.add('hidden');
    });

    const nameInput = document.getElementById(
      'player-name-input'
    ) as HTMLInputElement;
    nameInput?.addEventListener('change', () => {
      const val = nameInput.value.trim().slice(0, 18);
      if (val) {
        this.playerName = val;
        localStorage.setItem('mc2026_player_name', val);
        const hubName = document.getElementById(
          'hub-player-name-input'
        ) as HTMLInputElement;
        if (hubName) hubName.value = val;
        this.send({ type: 'SET_NAME', playerName: val });
      }
    });

    document.getElementById('btn-copy-invite')?.addEventListener('click', () => {
      const shareUrl = `${window.location.origin}/?room=${this.roomCode}`;
      navigator.clipboard?.writeText(shareUrl).catch(() => {});
      this.showToast(`Copied invite link: ${shareUrl}`, true);
    });

    document.getElementById('btn-add-bot')?.addEventListener('click', () => {
      this.send({ type: 'ADD_BOT' });
    });

    document.getElementById('btn-remove-bot')?.addEventListener('click', () => {
      this.send({ type: 'REMOVE_BOT' });
    });

    const fogChk = document.getElementById('chk-fog') as HTMLInputElement;
    fogChk?.addEventListener('change', () => {
      this.send({
        type: 'UPDATE_SETTINGS',
        settings: { fogOfWar: fogChk.checked },
      });
    });

    const chatForm = document.getElementById('chat-form') as HTMLFormElement;
    const chatInput = document.getElementById('chat-input') as HTMLInputElement;
    chatForm?.addEventListener('submit', (e) => {
      e.preventDefault();
      const text = chatInput.value.trim();
      if (text) {
        this.send({ type: 'CHAT', text });
        chatInput.value = '';
      }
    });
  }

  private selectTool(tool: 'BLOCK' | 'SELL') {
    this.renderer3d.activeTool = tool;
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
      btn.className = 'round-pill-btn';
      const arch = RUNNER_ARCHETYPES[r.runnerType || 'SCOUT'];
      btn.innerHTML = `<span class="r-num">R${r.roundNumber}</span><span>${r.title}</span><span class="r-arch" title="${arch.name}: ${arch.traitSummary}">${arch.icon}</span>`;
      btn.title = `${r.subtitle} (${arch.icon} ${arch.name}: ${arch.traitSummary}) — ${r.hint}`;
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
    document.getElementById('round-subtitle')!.textContent =
      `${arch.icon} ${round.title}`;
    document.getElementById('btn-round-picker')!.title =
      `Round ${round.roundNumber}: ${round.title} — Runner: ${arch.icon} ${arch.name} (${arch.traitSummary})`;
    document.getElementById('room-code-badge')!.textContent =
      this.roomState.roomCode;
    const hubRoomBadge = document.getElementById('hub-active-room-badge');
    if (hubRoomBadge) {
      hubRoomBadge.textContent = `ROOM: ${this.roomState.roomCode}`;
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

    const featureTags: string[] = [];
    if (stormCount > 0) featureTags.push(`${stormCount}⚡`);
    if (frostCount > 0) featureTags.push(`${frostCount}❄️`);
    if (chronoCount > 0) featureTags.push(`${chronoCount}🔮`);
    featureTags.push(`${round.obstacles.length}🧱 Keeps`);
    featureTags.push(`${arch.icon} ${arch.name}`);
    document.getElementById('map-features-summary')!.textContent =
      featureTags.join(' · ');

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
      goldEl.style.color = wallsLeft === 0 ? '#fda4af' : '#f8fafc';
      document.getElementById('walls-chip')!.title =
        `${wallsLeft} Castle Pillars Remaining (${me.gold} Gold · 5G per 2×2 Pillar)`;

      const evalRun = evaluateMazeRunTime(round, me.towers);
      const estEl = document.getElementById('est-time-value')!;
      estEl.textContent = `${evalRun.finishTimeSeconds.toFixed(1)}s / ${round.parTimeSeconds.toFixed(0)}s`;
      estEl.style.color =
        evalRun.finishTimeSeconds >= round.parTimeSeconds ? '#4ade80' : '#f8fafc';

      const clapsEl = document.getElementById('est-claps-value')!;
      clapsEl.textContent =
        evalRun.overchargedSpires > 0
          ? `${evalRun.clapsTaken} · 🔥${evalRun.overchargedSpires}★`
          : `${evalRun.clapsTaken}`;
      const clapChip = clapsEl.closest('.clap-chip') as HTMLElement | null;
      if (clapChip) {
        clapChip.title = `Predicted Spire Hits: ${evalRun.clapsTaken} | Linked Red Keeps: ${evalRun.linkedKeeps}/${round.obstacles.length} | Spire Overcharge Stars: ${evalRun.overchargedSpires}★`;
      }

      const readyBtn = document.getElementById('btn-ready-lock')!;
      const readyText = document.getElementById('ready-btn-text')!;
      if (me.ready) {
        readyBtn.classList.add('locked-in');
        readyText.textContent = '✓ READY';
      } else {
        readyBtn.classList.remove('locked-in');
        readyText.textContent = 'LOCK IN';
      }
    }

    document
      .querySelectorAll<HTMLButtonElement>('.round-pill-btn')
      .forEach((btn, idx) => {
        btn.classList.toggle('active', idx === this.roomState?.currentRoundIndex);
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
    overviewIcon.textContent = this.renderer3d.arenaOverviewMode ? '🎯' : '🌐';
    overviewLabel.textContent = this.renderer3d.arenaOverviewMode
      ? 'Sanctum'
      : 'Arena';

    const sorted = [...this.roomState.players].sort(
      (a, b) => b.totalScore - a.totalScore
    );

    sorted.forEach((p, idx) => {
      const chip = document.createElement('button');
      const isFocused =
        !this.renderer3d.arenaOverviewMode &&
        this.renderer3d.focusedPlayerId === p.id;
      chip.className = `player-micro-chip${isFocused ? ' focused' : ''}`;

      const isMe = p.id === this.localPlayerId;
      const readyMark =
        this.roomState?.phase === 'BUILD' && p.ready ? ' ✓' : '';

      chip.title = `${p.name}${isMe ? ' (You)' : ''} — ${p.totalScore} pts · ${p.pathDistance.toFixed(0)}m path [Hotkey: ${idx + 1}]`;
      chip.innerHTML = `
        <span class="player-swatch" style="background:${p.color}"></span>
        <span class="chip-name">${idx + 1}. ${isMe ? 'You' : p.name}${readyMark}</span>
        <span class="chip-score" id="sub-telemetry-${p.id}">${p.totalScore}p</span>
      `;

      chip.addEventListener('click', () => {
        this.renderer3d.focusOnPlayerIsland(p.id);
        this.updateScoreboardDOM();
      });

      list.appendChild(chip);
    });
  }

  private updateLiveRunScoreboard() {
    for (const [pid, sim] of this.simulators.entries()) {
      const subEl = document.getElementById(`sub-telemetry-${pid}`);
      if (!subEl) continue;
      if (sim.state.finished) {
        subEl.textContent = `🏁${sim.state.finishTimeSeconds.toFixed(1)}s`;
        subEl.style.color = '#4ade80';
      } else {
        subEl.textContent = `${sim.elapsedSeconds.toFixed(1)}s`;
        subEl.style.color = '#fde047';
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
    const nextBtn = document.getElementById('btn-next-round')!;

    progressEl.textContent = isGameOver
      ? `Championship Final (${totalRounds} Rounds)`
      : `Match Progress: ${roundsDone} / ${totalRounds} Rounds`;

    if (state.newRecordHolders && state.newRecordHolders.length > 0) {
      recordCallout.classList.remove('hidden');
      recordCallout.textContent = `🔥 NEW HALL OF FAME TOP-5 RECORD on Round ${round.roundNumber} by ${state.newRecordHolders.join(', ')}!`;
    } else {
      recordCallout.classList.add('hidden');
    }

    if (isGameOver) {
      titleEl.textContent = `👑 GRAND CITADEL CHAMPIONSHIP COMPLETE`;
      subEl.textContent = `Final Standings across ${totalRounds} Rounds — All scores recorded to the Hall of Fame!`;
      nextBtn.textContent = '🔄 Play New Match';

      const overallRanked = [...state.players].sort(
        (a, b) => b.totalScore - a.totalScore || b.bestMazeTime - a.bestMazeTime
      );
      podiumEl.classList.remove('hidden');
      podiumEl.innerHTML = '';

      overallRanked.slice(0, 3).forEach((p, idx) => {
        const card = document.createElement('div');
        card.className = `podium-card${idx === 0 ? ' first' : ''}`;
        const medal = idx === 0 ? '🥇' : idx === 1 ? '🥈' : '🥉';
        card.innerHTML = `
          <div class="podium-medal">${medal}</div>
          <div class="podium-name">${p.name}</div>
          <div class="podium-pts">${p.totalScore} PTS</div>
          <div class="podium-sub">Best: ${p.bestMazeTime.toFixed(1)}s · ★${p.parStarsEarned || 0} Par</div>
        `;
        podiumEl.appendChild(card);
      });
    } else {
      titleEl.textContent = `ROUND ${round.roundNumber} COMPLETE — ${round.title.toUpperCase()}`;
      subEl.textContent = `Par Time: ${round.parTimeSeconds.toFixed(1)}s (+2 Bonus Points for beating Par!)`;
      nextBtn.textContent = 'Next Round →';
      podiumEl.classList.add('hidden');
    }

    const table = document.getElementById('results-table')!;
    table.innerHTML = '';

    const ranked = [...state.players].sort((a, b) =>
      isGameOver
        ? b.totalScore - a.totalScore || (b.lastRoundTime || 0) - (a.lastRoundTime || 0)
        : (b.lastRoundTime || 0) - (a.lastRoundTime || 0)
    );

    ranked.forEach((p, idx) => {
      const row = document.createElement('div');
      row.className = `result-row${idx === 0 ? ' winner' : ''}`;
      const medal =
        idx === 0 ? '🥇' : idx === 1 ? '🥈' : idx === 2 ? '🥉' : `#${idx + 1}`;
      const beatPar =
        (p.lastRoundTime || 0) >= round.parTimeSeconds
          ? `<span class="meta-pill" style="margin-left:6px;color:#4ade80">★ PAR</span>`
          : '';
      const synBadges = `<span class="rule-tag" style="margin-left:6px">⚡${p.lastRoundClaps || 0} · 🔥${p.lastRoundOvercharge || 0}★ · ${p.pathDistance.toFixed(0)}m</span>`;

      row.innerHTML = `
        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
          <span style="font-size:17px">${medal}</span>
          <span class="player-swatch" style="background:${p.color}"></span>
          <strong>${p.name}</strong>
          ${beatPar}
          ${synBadges}
        </div>
        <div style="font-family:var(--font-mono);font-size:13px;white-space:nowrap">
          <strong>${(p.lastRoundTime || 0).toFixed(2)}s</strong>
          <span style="color:#4ade80;margin-left:8px">+${p.lastRoundPoints}p</span>
          <span style="color:#fde047;margin-left:8px">(${p.totalScore}p)</span>
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
        div.textContent = `◆ ${m.text}`;
      } else {
        div.innerHTML = `<strong style="color:${m.senderColor}">${m.senderName}:</strong> `;
        const span = document.createElement('span');
        span.textContent = m.text;
        div.appendChild(span);
      }
      box.appendChild(div);
    }
    box.scrollTop = box.scrollHeight;
  }

  private showToast(message: string, isPositive = false) {
    const container = document.getElementById('toast-container')!;
    const toast = document.createElement('div');
    toast.className = 'toast-msg';
    if (isPositive) {
      toast.style.background = 'rgba(16, 185, 129, 0.92)';
      toast.style.borderColor = '#6ee7b7';
    }
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
