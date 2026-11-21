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

export class SoundEngine {
  private ctx: AudioContext | null = null;
  private masterFilter: BiquadFilterNode | null = null;
  private masterCompressor: DynamicsCompressorNode | null = null;
  private masterGain: GainNode | null = null;

  private _muted = false;
  private unlocked = false;
  private lastCueTimeMs = new Map<string, number>();
  private lastHapticTimeMs = new Map<HapticKind, number>();

  constructor() {
    this._muted = this.readStoredMuted();
    this.installGestureUnlockListeners();
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

  private installGestureUnlockListeners(): void {
    if (typeof window === 'undefined') return;

    const unlock = () => {
      const ctx = this.initAudioGraph();
      if (!ctx) return;

      if (ctx.state === 'suspended') {
        ctx.resume().catch(() => {});
      }

      if (!this.unlocked) {
        try {
          // 1-sample silent buffer warm-up unlocks iOS Safari / mobile WebKit audio output
          const silentBuffer = ctx.createBuffer(1, 1, 22050);
          const source = ctx.createBufferSource();
          source.buffer = silentBuffer;
          source.connect(ctx.destination);
          source.start(0);
          this.unlocked = true;
        } catch {
          // Ignore unlock errors before user interaction settles
        }
      }

      if (ctx.state === 'running') {
        window.removeEventListener('pointerdown', unlock, true);
        window.removeEventListener('touchend', unlock, true);
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
    window.addEventListener('keydown', unlock, {
      capture: true,
      passive: true,
    });
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
        compressor.ratio.value = 4;
        compressor.attack.value = 0.003;
        compressor.release.value = 0.14;

        const gain = ctx.createGain();
        gain.gain.value = this._muted ? 0.0001 : 0.86;

        filter.connect(compressor);
        compressor.connect(gain);
        gain.connect(ctx.destination);

        this.ctx = ctx;
        this.masterFilter = filter;
        this.masterCompressor = compressor;
        this.masterGain = gain;
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

    if (ctx.state === 'suspended') {
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
    env.gain.linearRampToValueAtTime(Math.max(0.0002, opts.peakGain), t0 + attack);
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

  public playBuild(type = 'BLOCK', overchargeGained = 0): void {
    const ctx = this.ensureContext();
    if (!ctx || !this.canTrigger('build', 20)) return;

    const now = ctx.currentTime + 0.002;
    const jitter = 0.97 + Math.random() * 0.06;

    if (type !== 'BLOCK') {
      // Pleasant warm stone chord for batch/sample actions (no raw sawtooth)
      this.scheduleVoice(ctx, {
        type: 'sine',
        freqStart: 220,
        freqEnd: 165,
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

    // 1. Grounded limestone body thud (pitches downward as stone seats into turf)
    this.scheduleVoice(ctx, {
      type: 'sine',
      freqStart: 168 * jitter,
      freqEnd: 78 * jitter,
      startTime: now,
      duration: 0.09,
      peakGain: 0.22,
      attack: 0.003,
    });

    // 2. Subtle carved-masonry transient click
    this.scheduleVoice(ctx, {
      type: 'triangle',
      freqStart: 460 * jitter,
      freqEnd: 215 * jitter,
      startTime: now,
      duration: 0.038,
      peakGain: 0.085,
      attack: 0.002,
      filterFreq: 1350,
    });

    // 3. Radiant Overcharge (◆) harmonic lift when linking a Crimson Keep to a Spire
    if (overchargeGained > 0) {
      const notes =
        overchargeGained >= 2
          ? [587.33, 880, 1174.66]
          : [587.33, 880];
      notes.forEach((freq, idx) => {
        this.scheduleVoice(ctx, {
          type: 'sine',
          freqStart: freq,
          freqEnd: freq * 1.004,
          startTime: now + 0.028 + idx * 0.042,
          duration: 0.26,
          peakGain: 0.085,
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

    // Crisp upward pebble/stone lift (+1 Wall refunded)
    this.scheduleVoice(ctx, {
      type: 'sine',
      freqStart: 235 * jitter,
      freqEnd: 392 * jitter,
      startTime: now,
      duration: 0.08,
      peakGain: 0.13,
      attack: 0.003,
    });
    this.scheduleVoice(ctx, {
      type: 'triangle',
      freqStart: 470 * jitter,
      freqEnd: 660 * jitter,
      startTime: now + 0.01,
      duration: 0.06,
      peakGain: 0.045,
      attack: 0.002,
      filterFreq: 1600,
    });
  }

  public playTouchSnap(): void {
    const ctx = this.ensureContext();
    if (!ctx || !this.canTrigger('snap', 28)) return;

    const now = ctx.currentTime + 0.001;
    this.scheduleVoice(ctx, {
      type: 'sine',
      freqStart: 350,
      freqEnd: 245,
      startTime: now,
      duration: 0.018,
      peakGain: 0.038,
      attack: 0.002,
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
      duration: 0.024,
      peakGain: 0.05,
      attack: 0.002,
      filterFreq: 1700,
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
        peakGain: locked ? 0.11 : 0.075,
        attack: 0.004,
        filterFreq: 1900,
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
      duration: urgent ? 0.065 : 0.045,
      peakGain: urgent ? 0.095 : 0.06,
      attack: 0.002,
      filterFreq: 2100,
    });
  }

  public playError(): void {
    const ctx = this.ensureContext();
    if (!ctx || !this.canTrigger('error', 110)) return;

    const now = ctx.currentTime + 0.002;
    // Warm muted wooden double-knock instead of harsh digital sawtooth buzz
    this.scheduleVoice(ctx, {
      type: 'triangle',
      freqStart: 162,
      freqEnd: 126,
      startTime: now,
      duration: 0.075,
      peakGain: 0.12,
      attack: 0.003,
      filterFreq: 540,
    });
    this.scheduleVoice(ctx, {
      type: 'triangle',
      freqStart: 124,
      freqEnd: 94,
      startTime: now + 0.062,
      duration: 0.095,
      peakGain: 0.11,
      attack: 0.003,
      filterFreq: 480,
    });
  }

  public playSpirePulse(spireType: SpireType, overchargeTier = 0): void {
    const ctx = this.ensureContext();
    const key = `spire:${spireType}`;
    if (!ctx || !this.canTrigger(key, 55)) return;

    const now = ctx.currentTime + 0.002;
    const tier = Math.max(0, Math.min(3, overchargeTier));
    const tierLift = 1 + tier * 0.05;

    if (spireType === 'FROST_OBELISK') {
      // Crystalline glacial bell dyad + deep permafrost resonance
      this.scheduleVoice(ctx, {
        type: 'triangle',
        freqStart: 293.66,
        freqEnd: 196.0,
        startTime: now,
        duration: 0.21,
        peakGain: 0.11,
        attack: 0.005,
        filterFreq: 1400,
      });
      [1046.5 * tierLift, 1567.98 * tierLift].forEach((freq, idx) => {
        this.scheduleVoice(ctx, {
          type: 'sine',
          freqStart: freq,
          freqEnd: freq * 0.992,
          startTime: now + idx * 0.024,
          duration: 0.25,
          peakGain: 0.07,
          attack: 0.004,
        });
      });
      return;
    }

    if (spireType === 'CHRONO_SPIRE') {
      // Temporal harmonic warp + counter-sweep chime
      this.scheduleVoice(ctx, {
        type: 'sine',
        freqStart: 392.0,
        freqEnd: 587.33 * tierLift,
        startTime: now,
        duration: 0.25,
        peakGain: 0.13,
        attack: 0.006,
      });
      this.scheduleVoice(ctx, {
        type: 'triangle',
        freqStart: 1174.66 * tierLift,
        freqEnd: 783.99,
        startTime: now + 0.015,
        duration: 0.22,
        peakGain: 0.055,
        attack: 0.004,
        filterFreq: 2400,
      });
      return;
    }

    // THUNDERCLAP (Storm Spire): grounded sub-shockwave + warm electric snap
    this.scheduleVoice(ctx, {
      type: 'sine',
      freqStart: 152,
      freqEnd: 38,
      startTime: now,
      duration: 0.32,
      peakGain: 0.21,
      attack: 0.003,
    });
    this.scheduleVoice(ctx, {
      type: 'triangle',
      freqStart: 780 * tierLift,
      freqEnd: 195,
      startTime: now,
      duration: 0.15,
      peakGain: 0.08,
      attack: 0.002,
      filterFreq: 2500,
    });

    if (tier > 0) {
      this.scheduleVoice(ctx, {
        type: 'sine',
        freqStart: 1174.66,
        freqEnd: 880,
        startTime: now + 0.012,
        duration: 0.12,
        peakGain: 0.045,
        attack: 0.003,
      });
    }
  }

  public playThunderclap(): void {
    this.playSpirePulse('THUNDERCLAP', 0);
  }

  public playCheckpoint(): void {
    const ctx = this.ensureContext();
    if (!ctx || !this.canTrigger('checkpoint', 65)) return;

    const now = ctx.currentTime + 0.002;
    const freqs = [523.25, 659.25, 783.99];
    freqs.forEach((f, idx) => {
      this.scheduleVoice(ctx, {
        type: 'sine',
        freqStart: f,
        startTime: now + idx * 0.052,
        duration: 0.3,
        peakGain: 0.085,
        attack: 0.005,
      });
    });
  }

  public playChronoWarp(): void {
    const ctx = this.ensureContext();
    if (!ctx || !this.canTrigger('waygate', 65)) return;

    const now = ctx.currentTime + 0.002;
    this.scheduleVoice(ctx, {
      type: 'sine',
      freqStart: 260,
      freqEnd: 920,
      startTime: now,
      duration: 0.26,
      peakGain: 0.12,
      attack: 0.005,
    });
  }

  public playFinish(): void {
    const ctx = this.ensureContext();
    if (!ctx || !this.canTrigger('finish', 90)) return;

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
    if (this._muted) return;
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

    try {
      navigator.vibrate(HAPTIC_PATTERNS[kind]);
    } catch {
      // Ignore vibration permission blocks on desktop/unsupported browsers
    }
  }
}

export const soundEngine = new SoundEngine();
