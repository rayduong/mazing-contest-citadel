import { SpireType } from '../shared/types.js';

export type HapticKind =
  | 'snap'
  | 'nudge'
  | 'build'
  | 'sell'
  | 'undo'
  | 'ready'
  | 'error';

const MUTE_STORAGE_KEY = 'mc2026_muted';

const HAPTIC_PATTERNS: Record<HapticKind, number | number[]> = {
  snap: 5,
  nudge: 7,
  build: 12,
  sell: 8,
  undo: 9,
  ready: 15,
  error: [10, 28, 10],
};

const HAPTIC_MIN_INTERVAL_MS: Record<HapticKind, number> = {
  snap: 28,
  nudge: 24,
  build: 20,
  sell: 20,
  undo: 25,
  ready: 60,
  error: 120,
};

interface VoiceOptions {
  type: OscillatorType;
  freqStart: number;
  freqEnd?: number;
  startTime: number;
  duration: number;
  peakGain: number;
  attack?: number;
  filterFreq?: number;
}

interface NoiseBurstOptions {
  startTime: number;
  duration: number;
  peakGain: number;
  bandpassFreq: number;
  q?: number;
}

function clampVolumeScale(scale?: number): number {
  if (scale === undefined || Number.isNaN(scale)) return 1.0;
  return Math.max(0.08, Math.min(1.25, scale));
}

export class SoundEngine {
  private ctx: AudioContext | null = null;
  private masterFilter: BiquadFilterNode | null = null;
  private masterCompressor: DynamicsCompressorNode | null = null;
  private masterGain: GainNode | null = null;
  private masonryNoiseBuffer: AudioBuffer | null = null;

  private _muted = false;
  private unlocked = false;
  private unlockListenersBound = false;
  private lastCueTimeMs = new Map<string, number>();
  private lastHapticTimeMs = new Map<HapticKind, number>();

  // Tracks consecutive Spire hits within a 2.6s window for subtle Exposure pitch lift
  private spireComboStep = 0;
  private lastSpirePulseAtMs = 0;

  constructor() {
    this._muted = this.readStoredMuted();
    this.installGestureUnlockListeners();
    this.installLifecycleRecoveryListeners();
  }

  public get muted(): boolean {
    return this._muted;
  }

  public set muted(val: boolean) {
    const next = Boolean(val);
    this._muted = next;
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem(MUTE_STORAGE_KEY, next ? '1' : '0');
      }
    } catch {
      // Ignore storage access errors in restricted webviews
    }

    if (this.masterGain && this.ctx) {
      const now = this.ctx.currentTime;
      this.masterGain.gain.cancelScheduledValues(now);
      this.masterGain.gain.setTargetAtTime(next ? 0.0001 : 0.86, now, 0.015);
    }
  }

  public toggleMuted(): boolean {
    this.muted = !this._muted;
    if (!this._muted) {
      this.playUiClick();
    }
    return this._muted;
  }

  private readStoredMuted(): boolean {
    try {
      if (typeof localStorage !== 'undefined') {
        return localStorage.getItem(MUTE_STORAGE_KEY) === '1';
      }
    } catch {
      // Ignore storage access errors
    }
    return false;
  }

  private isContextRunning(ctx: AudioContext): boolean {
    return (ctx.state as string) === 'running';
  }

  private installGestureUnlockListeners(): void {
    if (typeof window === 'undefined' || this.unlockListenersBound) return;
    this.unlockListenersBound = true;

    const unlock = () => {
      const ctx = this.initAudioGraph();
      if (!ctx) return;

      // Resume both standard 'suspended' and iOS Safari WebKit 'interrupted' states
      if (!this.isContextRunning(ctx)) {
        ctx.resume().catch(() => {});
      }

      // Play 1-sample silent buffer on every unlock gesture until ctx.state === 'running'
      // (iOS Safari often ignores passive pointerdown and unlocks on touchend/click)
      if (!this.unlocked || !this.isContextRunning(ctx)) {
        try {
          const silentBuffer = ctx.createBuffer(1, 1, 22050);
          const source = ctx.createBufferSource();
          source.buffer = silentBuffer;
          source.connect(ctx.destination);
          source.start(0);
        } catch {
          // Ignore transient pre-activation errors
        }
      }

      if (this.isContextRunning(ctx)) {
        this.unlocked = true;
        this.unlockListenersBound = false;
        window.removeEventListener('pointerdown', unlock, true);
        window.removeEventListener('touchend', unlock, true);
        window.removeEventListener('click', unlock, true);
        window.removeEventListener('keydown', unlock, true);
      }
    };

    window.addEventListener('pointerdown', unlock, {
      capture: true,
      passive: true,
    });
    window.addEventListener('touchend', unlock, {
      capture: true,
      passive: true,
    });
    window.addEventListener('click', unlock, {
      capture: true,
      passive: true,
    });
    window.addEventListener('keydown', unlock, {
      capture: true,
      passive: true,
    });
  }

  private installLifecycleRecoveryListeners(): void {
    if (typeof window === 'undefined' || typeof document === 'undefined') return;

    const recoverAudio = () => {
      if (!this.ctx) return;
      if (!this.isContextRunning(this.ctx)) {
        // Re-arm gesture unlock listeners in case iOS requires a fresh touch after 'interrupted'
        this.unlocked = false;
        this.installGestureUnlockListeners();
        if (!this._muted && document.visibilityState === 'visible') {
          this.ctx.resume().catch(() => {});
        }
      }
    };

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        recoverAudio();
      }
    });
    window.addEventListener('pageshow', recoverAudio);
    window.addEventListener('focus', recoverAudio);
  }

  private buildMasonryNoiseBuffer(ctx: AudioContext): AudioBuffer {
    const length = Math.max(256, Math.ceil(ctx.sampleRate * 0.04));
    const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    // Slightly smoothed pink-ish noise grain so stone clicks sound organic, never hissy
    let prev = 0;
    for (let i = 0; i < length; i++) {
      const white = Math.random() * 2 - 1;
      prev = prev * 0.52 + white * 0.48;
      const decay = 1 - i / length;
      data[i] = prev * decay;
    }
    return buffer;
  }

  private initAudioGraph(): AudioContext | null {
    if (typeof window === 'undefined') return null;

    if (!this.ctx) {
      const AudioCtx =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext?: typeof AudioContext })
          .webkitAudioContext;
      if (!AudioCtx) return null;

      try {
        const ctx = new AudioCtx();
        const filter = ctx.createBiquadFilter();
        filter.type = 'lowpass';
        filter.frequency.value = 3600;
        filter.Q.value = 0.65;

        const compressor = ctx.createDynamicsCompressor();
        compressor.threshold.value = -14;
        compressor.knee.value = 12;
        compressor.ratio.value = 4.5;
        compressor.attack.value = 0.003;
        compressor.release.value = 0.14;

        const gain = ctx.createGain();
        gain.gain.value = this._muted ? 0.0001 : 0.86;

        filter.connect(compressor);
        compressor.connect(gain);
        gain.connect(ctx.destination);

        ctx.addEventListener?.('statechange', () => {
          if (!this.isContextRunning(ctx)) {
            this.unlocked = false;
            this.installGestureUnlockListeners();
          }
        });

        this.ctx = ctx;
        this.masterFilter = filter;
        this.masterCompressor = compressor;
        this.masterGain = gain;
        this.masonryNoiseBuffer = this.buildMasonryNoiseBuffer(ctx);
      } catch {
        return null;
      }
    }

    return this.ctx;
  }

  private ensureContext(): AudioContext | null {
    if (this._muted) return null;
    const ctx = this.initAudioGraph();
    if (!ctx) return null;

    // Catch both 'suspended' and iOS WebKit 'interrupted' states
    if (!this.isContextRunning(ctx)) {
      this.installGestureUnlockListeners();
      ctx.resume().catch(() => {});
    }
    return ctx;
  }

  private canTrigger(key: string, minIntervalMs: number): boolean {
    const now =
      typeof performance !== 'undefined' ? performance.now() : Date.now();
    const prev = this.lastCueTimeMs.get(key) ?? -Infinity;
    if (now - prev < minIntervalMs) {
      return false;
    }
    this.lastCueTimeMs.set(key, now);
    return true;
  }

  private scheduleVoice(ctx: AudioContext, opts: VoiceOptions): void {
    if (!this.masterFilter) return;

    const t0 = Math.max(ctx.currentTime, opts.startTime);
    const attack = Math.min(opts.attack ?? 0.004, opts.duration * 0.45);
    const stopAt = t0 + opts.duration;

    const osc = ctx.createOscillator();
    const env = ctx.createGain();

    osc.type = opts.type;
    osc.frequency.setValueAtTime(Math.max(20, opts.freqStart), t0);
    if (opts.freqEnd !== undefined && opts.freqEnd !== opts.freqStart) {
      osc.frequency.exponentialRampToValueAtTime(
        Math.max(20, opts.freqEnd),
        stopAt
      );
    }

    // Soft linear attack eliminates t=0 DC-step clicks on phone speakers
    env.gain.setValueAtTime(0.0001, t0);
    env.gain.linearRampToValueAtTime(
      Math.max(0.0002, opts.peakGain),
      t0 + attack
    );
    env.gain.exponentialRampToValueAtTime(0.0001, stopAt);

    if (opts.filterFreq) {
      const voiceFilter = ctx.createBiquadFilter();
      voiceFilter.type = 'lowpass';
      voiceFilter.frequency.setValueAtTime(opts.filterFreq, t0);
      osc.connect(voiceFilter);
      voiceFilter.connect(env);
      env.connect(this.masterFilter);
      osc.onended = () => {
        osc.disconnect();
        voiceFilter.disconnect();
        env.disconnect();
      };
    } else {
      osc.connect(env);
      env.connect(this.masterFilter);
      osc.onended = () => {
        osc.disconnect();
        env.disconnect();
      };
    }

    osc.start(t0);
    osc.stop(stopAt + 0.008);
  }

  private scheduleNoiseBurst(ctx: AudioContext, opts: NoiseBurstOptions): void {
    if (!this.masterFilter) return;
    if (!this.masonryNoiseBuffer) {
      this.masonryNoiseBuffer = this.buildMasonryNoiseBuffer(ctx);
    }

    const t0 = Math.max(ctx.currentTime, opts.startTime);
    const stopAt = t0 + opts.duration;
    const attack = Math.min(0.002, opts.duration * 0.35);

    const src = ctx.createBufferSource();
    src.buffer = this.masonryNoiseBuffer;

    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.setValueAtTime(opts.bandpassFreq, t0);
    bp.Q.setValueAtTime(opts.q ?? 1.75, t0);

    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, t0);
    env.gain.linearRampToValueAtTime(
      Math.max(0.0002, opts.peakGain),
      t0 + attack
    );
    env.gain.exponentialRampToValueAtTime(0.0001, stopAt);

    src.connect(bp);
    bp.connect(env);
    env.connect(this.masterFilter);
    src.onended = () => {
      src.disconnect();
      bp.disconnect();
      env.disconnect();
    };

    src.start(t0);
    src.stop(stopAt + 0.004);
  }

  public playBuild(type = 'BLOCK', overchargeGained = 0): void {
    const ctx = this.ensureContext();
    if (!ctx || !this.canTrigger('build', 20)) return;

    const now = ctx.currentTime + 0.002;
    const jitter = 0.97 + Math.random() * 0.06;

    if (type !== 'BLOCK') {
      // Pleasant warm stone chord for batch/sample actions
      this.scheduleNoiseBurst(ctx, {
        startTime: now,
        duration: 0.022,
        peakGain: 0.045,
        bandpassFreq: 1050,
      });
      this.scheduleVoice(ctx, {
        type: 'sine',
        freqStart: 220,
        freqEnd: 155,
        startTime: now,
        duration: 0.14,
        peakGain: 0.16,
      });
      this.scheduleVoice(ctx, {
        type: 'triangle',
        freqStart: 329.63,
        freqEnd: 440,
        startTime: now + 0.03,
        duration: 0.18,
        peakGain: 0.09,
        filterFreq: 1800,
      });
      return;
    }

    // 1. Deep limestone seat thud (desktop sub-warmth)
    this.scheduleVoice(ctx, {
      type: 'sine',
      freqStart: 166 * jitter,
      freqEnd: 80 * jitter,
      startTime: now,
      duration: 0.088,
      peakGain: 0.19,
      attack: 0.003,
    });

    // 2. Upper-bass stone body (>180Hz so small mobile phone speakers convey weight)
    this.scheduleVoice(ctx, {
      type: 'triangle',
      freqStart: 252 * jitter,
      freqEnd: 138 * jitter,
      startTime: now,
      duration: 0.068,
      peakGain: 0.12,
      attack: 0.0025,
      filterFreq: 980,
    });

    // 3. Bandpass-filtered masonry impact transient (tactile stone-on-turf grain)
    this.scheduleNoiseBurst(ctx, {
      startTime: now,
      duration: 0.017,
      peakGain: 0.055,
      bandpassFreq: 1180 * jitter,
      q: 1.75,
    });

    // 4. Radiant Overcharge (◆) harmonic lift when linking a Crimson Keep to a Spire
    if (overchargeGained > 0) {
      const notes =
        overchargeGained >= 2 ? [587.33, 880, 1174.66] : [587.33, 880];
      notes.forEach((freq, idx) => {
        this.scheduleVoice(ctx, {
          type: 'sine',
          freqStart: freq,
          freqEnd: freq * 1.004,
          startTime: now + 0.028 + idx * 0.042,
          duration: 0.26,
          peakGain: 0.088,
          attack: 0.006,
        });
      });
    }
  }

  public playSell(): void {
    const ctx = this.ensureContext();
    if (!ctx || !this.canTrigger('sell', 20)) return;

    const now = ctx.currentTime + 0.002;
    const jitter = 0.98 + Math.random() * 0.04;

    // Crisp upward stone lift (+1 Wall refunded)
    this.scheduleNoiseBurst(ctx, {
      startTime: now,
      duration: 0.012,
      peakGain: 0.03,
      bandpassFreq: 1450 * jitter,
      q: 2.0,
    });
    this.scheduleVoice(ctx, {
      type: 'sine',
      freqStart: 240 * jitter,
      freqEnd: 396 * jitter,
      startTime: now,
      duration: 0.082,
      peakGain: 0.13,
      attack: 0.003,
    });
    this.scheduleVoice(ctx, {
      type: 'triangle',
      freqStart: 475 * jitter,
      freqEnd: 660 * jitter,
      startTime: now + 0.01,
      duration: 0.06,
      peakGain: 0.048,
      attack: 0.002,
      filterFreq: 1650,
    });
  }

  public playTouchSnap(): void {
    const ctx = this.ensureContext();
    if (!ctx || !this.canTrigger('snap', 26)) return;

    const now = ctx.currentTime + 0.001;
    // Audible carved-stone detent on iOS & Android phone speakers
    this.scheduleVoice(ctx, {
      type: 'triangle',
      freqStart: 440,
      freqEnd: 285,
      startTime: now,
      duration: 0.026,
      peakGain: 0.068,
      attack: 0.002,
      filterFreq: 1650,
    });
    this.scheduleNoiseBurst(ctx, {
      startTime: now,
      duration: 0.009,
      peakGain: 0.022,
      bandpassFreq: 1500,
      q: 2.2,
    });
  }

  public playUiClick(): void {
    const ctx = this.ensureContext();
    if (!ctx || !this.canTrigger('ui', 24)) return;

    const now = ctx.currentTime + 0.001;
    this.scheduleVoice(ctx, {
      type: 'triangle',
      freqStart: 520,
      freqEnd: 360,
      startTime: now,
      duration: 0.026,
      peakGain: 0.055,
      attack: 0.002,
      filterFreq: 1750,
    });
  }

  public playReady(locked: boolean): void {
    const ctx = this.ensureContext();
    if (!ctx || !this.canTrigger('ready', 50)) return;

    const now = ctx.currentTime + 0.002;
    const pair = locked ? [392.0, 587.33] : [523.25, 392.0];
    pair.forEach((freq, idx) => {
      this.scheduleVoice(ctx, {
        type: 'triangle',
        freqStart: freq,
        freqEnd: freq,
        startTime: now + idx * 0.048,
        duration: locked ? 0.18 : 0.12,
        peakGain: locked ? 0.115 : 0.075,
        attack: 0.004,
        filterFreq: 1950,
      });
    });
  }

  public playCountdownTick(urgent = false): void {
    const ctx = this.ensureContext();
    if (!ctx || !this.canTrigger('tick', 180)) return;

    const now = ctx.currentTime + 0.002;
    this.scheduleVoice(ctx, {
      type: 'triangle',
      freqStart: urgent ? 880 : 659.25,
      freqEnd: urgent ? 587.33 : 440,
      startTime: now,
      duration: urgent ? 0.068 : 0.048,
      peakGain: urgent ? 0.098 : 0.062,
      attack: 0.002,
      filterFreq: 2100,
    });
  }

  public playRunStart(): void {
    const ctx = this.ensureContext();
    if (!ctx || !this.canTrigger('runStart', 250)) return;

    this.spireComboStep = 0;
    const now = ctx.currentTime + 0.002;

    // Grounded kettledrum strike + warm gate-horn fifth (G3 -> D4)
    this.scheduleNoiseBurst(ctx, {
      startTime: now,
      duration: 0.022,
      peakGain: 0.045,
      bandpassFreq: 900,
      q: 1.5,
    });
    this.scheduleVoice(ctx, {
      type: 'sine',
      freqStart: 138,
      freqEnd: 68,
      startTime: now,
      duration: 0.22,
      peakGain: 0.18,
      attack: 0.003,
    });
    [196.0, 293.66, 392.0].forEach((freq, idx) => {
      this.scheduleVoice(ctx, {
        type: 'triangle',
        freqStart: freq * 0.985,
        freqEnd: freq,
        startTime: now + idx * 0.045,
        duration: 0.3,
        peakGain: idx === 2 ? 0.095 : 0.08,
        attack: 0.008,
        filterFreq: 1650,
      });
    });
  }

  public playArmorDeflect(volumeScale = 1): void {
    const scale = clampVolumeScale(volumeScale);
    const minGap = scale < 0.75 ? 110 : 65;
    const ctx = this.ensureContext();
    if (!ctx || !this.canTrigger('armorDeflect', minGap)) return;

    const now = ctx.currentTime + 0.002;
    // Crisp metallic shield clink when Iron Juggernaut resists an uncharged (0◆) Spire
    this.scheduleNoiseBurst(ctx, {
      startTime: now,
      duration: 0.012,
      peakGain: 0.036 * scale,
      bandpassFreq: 2500,
      q: 2.6,
    });
    this.scheduleVoice(ctx, {
      type: 'triangle',
      freqStart: 1318.51,
      freqEnd: 1174.66,
      startTime: now,
      duration: 0.11,
      peakGain: 0.075 * scale,
      attack: 0.002,
      filterFreq: 3100,
    });
    this.scheduleVoice(ctx, {
      type: 'sine',
      freqStart: 1975.53,
      freqEnd: 1760.0,
      startTime: now + 0.008,
      duration: 0.13,
      peakGain: 0.055 * scale,
      attack: 0.002,
    });
  }

  public playParAchieved(): void {
    const ctx = this.ensureContext();
    if (!ctx || !this.canTrigger('parAchieved', 400)) return;

    const now = ctx.currentTime + 0.002;
    // Bright gold ★ Par! chime arpeggio (C5 - E5 - G5 - C6)
    const notes = [523.25, 659.25, 783.99, 1046.5];
    notes.forEach((freq, idx) => {
      this.scheduleVoice(ctx, {
        type: idx === 3 ? 'triangle' : 'sine',
        freqStart: freq,
        freqEnd: freq * 1.003,
        startTime: now + idx * 0.048,
        duration: idx === 3 ? 0.42 : 0.28,
        peakGain: idx === 3 ? 0.105 : 0.082,
        attack: 0.004,
        filterFreq: 2800,
      });
    });
  }

  public playError(): void {
    const ctx = this.ensureContext();
    if (!ctx || !this.canTrigger('error', 110)) return;

    const now = ctx.currentTime + 0.002;
    // Muted wooden double-knock
    this.scheduleVoice(ctx, {
      type: 'triangle',
      freqStart: 176,
      freqEnd: 134,
      startTime: now,
      duration: 0.075,
      peakGain: 0.12,
      attack: 0.003,
      filterFreq: 580,
    });
    this.scheduleVoice(ctx, {
      type: 'triangle',
      freqStart: 132,
      freqEnd: 98,
      startTime: now + 0.062,
      duration: 0.095,
      peakGain: 0.11,
      attack: 0.003,
      filterFreq: 500,
    });
  }

  public playSpirePulse(
    spireType: SpireType,
    overchargeTier = 0,
    volumeScale = 1,
    exposureStacks?: number
  ): void {
    const scale = clampVolumeScale(volumeScale);
    const isDuckedOverview = scale < 0.75;
    const key = isDuckedOverview ? 'spire:overview' : `spire:${spireType}`;
    const minGap = isDuckedOverview ? 110 : 55;

    const ctx = this.ensureContext();
    if (!ctx || !this.canTrigger(key, minGap)) return;

    const perfNow =
      typeof performance !== 'undefined' ? performance.now() : Date.now();
    if (!isDuckedOverview) {
      if (perfNow - this.lastSpirePulseAtMs <= 2600) {
        this.spireComboStep = Math.min(4, this.spireComboStep + 1);
      } else {
        this.spireComboStep = 0;
      }
      this.lastSpirePulseAtMs = perfNow;
    }

    const comboStep =
      exposureStacks !== undefined
        ? Math.max(0, Math.min(4, exposureStacks - 1))
        : isDuckedOverview
        ? 0
        : this.spireComboStep;

    const now = ctx.currentTime + 0.002;
    const tier = Math.max(0, Math.min(3, overchargeTier));
    // Subtle upward Exposure pitch climb (+1.8% per consecutive hit) + Overcharge harmonic lift
    const pitchLift = (1 + tier * 0.045) * (1 + comboStep * 0.018);

    if (spireType === 'FROST_OBELISK') {
      this.scheduleVoice(ctx, {
        type: 'triangle',
        freqStart: 293.66 * pitchLift,
        freqEnd: 196.0,
        startTime: now,
        duration: 0.21,
        peakGain: 0.11 * scale,
        attack: 0.005,
        filterFreq: 1450,
      });
      [1046.5 * pitchLift, 1567.98 * pitchLift].forEach((freq, idx) => {
        this.scheduleVoice(ctx, {
          type: 'sine',
          freqStart: freq,
          freqEnd: freq * 0.992,
          startTime: now + idx * 0.024,
          duration: 0.25,
          peakGain: 0.072 * scale,
          attack: 0.004,
        });
      });
      return;
    }

    if (spireType === 'CHRONO_SPIRE') {
      this.scheduleVoice(ctx, {
        type: 'sine',
        freqStart: 392.0,
        freqEnd: 587.33 * pitchLift,
        startTime: now,
        duration: 0.25,
        peakGain: 0.13 * scale,
        attack: 0.006,
      });
      this.scheduleVoice(ctx, {
        type: 'triangle',
        freqStart: 1174.66 * pitchLift,
        freqEnd: 783.99,
        startTime: now + 0.015,
        duration: 0.22,
        peakGain: 0.055 * scale,
        attack: 0.004,
        filterFreq: 2400,
      });
      return;
    }

    // THUNDERCLAP (Storm Spire): sub-shockwave + phone-audible upper-bass punch + electric snap
    this.scheduleVoice(ctx, {
      type: 'sine',
      freqStart: 154,
      freqEnd: 40,
      startTime: now,
      duration: 0.3,
      peakGain: 0.19 * scale,
      attack: 0.003,
    });
    this.scheduleVoice(ctx, {
      type: 'triangle',
      freqStart: 240 * pitchLift,
      freqEnd: 118,
      startTime: now,
      duration: 0.14,
      peakGain: 0.095 * scale,
      attack: 0.003,
      filterFreq: 1100,
    });
    this.scheduleVoice(ctx, {
      type: 'triangle',
      freqStart: 780 * pitchLift,
      freqEnd: 195,
      startTime: now,
      duration: 0.15,
      peakGain: 0.078 * scale,
      attack: 0.002,
      filterFreq: 2500,
    });

    if (tier > 0) {
      this.scheduleVoice(ctx, {
        type: 'sine',
        freqStart: 1174.66 * pitchLift,
        freqEnd: 880,
        startTime: now + 0.012,
        duration: 0.13,
        peakGain: 0.048 * scale,
        attack: 0.003,
      });
    }
  }

  public playThunderclap(): void {
    this.playSpirePulse('THUNDERCLAP', 0, 1);
  }

  public playCheckpoint(volumeScale = 1): void {
    const scale = clampVolumeScale(volumeScale);
    const minGap = scale < 0.75 ? 115 : 65;
    const ctx = this.ensureContext();
    if (!ctx || !this.canTrigger('checkpoint', minGap)) return;

    const now = ctx.currentTime + 0.002;
    const freqs = [523.25, 659.25, 783.99];
    freqs.forEach((f, idx) => {
      this.scheduleVoice(ctx, {
        type: 'sine',
        freqStart: f,
        startTime: now + idx * 0.052,
        duration: 0.3,
        peakGain: 0.085 * scale,
        attack: 0.005,
      });
    });
  }

  public playChronoWarp(volumeScale = 1): void {
    const scale = clampVolumeScale(volumeScale);
    const minGap = scale < 0.75 ? 115 : 65;
    const ctx = this.ensureContext();
    if (!ctx || !this.canTrigger('waygate', minGap)) return;

    const now = ctx.currentTime + 0.002;
    this.scheduleVoice(ctx, {
      type: 'sine',
      freqStart: 260,
      freqEnd: 920,
      startTime: now,
      duration: 0.26,
      peakGain: 0.12 * scale,
      attack: 0.005,
    });
  }

  public playFinish(): void {
    const ctx = this.ensureContext();
    if (!ctx || !this.canTrigger('finish', 140)) return;

    const now = ctx.currentTime + 0.002;
    const freqs = [440, 554.37, 659.25, 880];
    freqs.forEach((f, idx) => {
      this.scheduleVoice(ctx, {
        type: 'triangle',
        freqStart: f,
        startTime: now + idx * 0.068,
        duration: 0.44,
        peakGain: 0.095,
        attack: 0.005,
        filterFreq: 2200,
      });
    });
  }

  public haptic(kind: HapticKind): void {
    if (
      typeof navigator === 'undefined' ||
      typeof navigator.vibrate !== 'function'
    ) {
      return;
    }

    const now =
      typeof performance !== 'undefined' ? performance.now() : Date.now();
    const minInterval = HAPTIC_MIN_INTERVAL_MS[kind] ?? 25;
    const prev = this.lastHapticTimeMs.get(kind) ?? -Infinity;
    if (now - prev < minInterval) return;
    this.lastHapticTimeMs.set(kind, now);

    // Keep subtle silent-commute micro-detents active even when audio is muted,
    // softening double-buzz error patterns to a quiet 8ms tap when muted.
    const pattern =
      this._muted && kind === 'error' ? 8 : HAPTIC_PATTERNS[kind];

    try {
      navigator.vibrate(pattern);
    } catch {
      // Ignore vibration permission blocks on desktop/unsupported browsers
    }
  }
}

export const soundEngine = new SoundEngine();
