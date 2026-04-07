const SCREEN_W = 240;
const SCREEN_H = 135;
const CANVAS_SCALE = 3;
const TRACK_COUNT = 5;
const VOICE_BASS = 4;
const COLORS = {
  bg: "#000000",
  text: "#ffffff",
  dim: "#7f7f7f",
  green: "#2dff64",
  red: "#ff4c5c",
  cyan: "#45e3ff",
  track: ["#ff4c5c", "#ffe15a", "#45e3ff", "#ff6ce6", "#2dff64"],
};
const TRACK_NAMES = ["KICK", "SNARE", "HATS", "CRASH", "BASS"];
const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const BASS_ROOT_MIN = 24;
const BASS_ROOT_MAX = 48;
const STORAGE_KEY = "penosa-desktop-sim-slots-v2";
const UI_PAGES = ["performance", "track", "bass", "voice", "slots", "lab"];
let uiPage = "performance";
const pageSelectionIndex = {};

const PAGE_HINTS = {
  performance: "↑↓ escolher controle · A/D ajustar · Enter executar",
  track: "↑↓ escolher parâmetro · A/D ajustar · Enter toggle · Backspace volta",
  bass: "↑↓ escolher parâmetro · A/D ajustar · Enter toggle · Backspace volta",
  voice: "↑↓ escolher parâmetro · A/D ajustar · Enter toggle · Backspace volta",
  slots: "↑↓ escolher slot/ação · Enter confirmar · Backspace volta",
  lab: "↑↓ escolher ação · A/D ajustar seed · Enter confirmar · Backspace volta",
};

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function noteName(midi) {
  return `${NOTE_NAMES[((midi % 12) + 12) % 12]}${Math.floor(midi / 12) - 1}`;
}

function xorshift(state) {
  let next = state >>> 0;
  next ^= (next << 13) >>> 0;
  next ^= next >>> 17;
  next ^= (next << 5) >>> 0;
  return next >>> 0;
}

function createDefaultVoiceParams() {
  return [
    { pitch: 0.5, decay: 0.5, timbre: 0.0, drive: 0.0, snap: 0.0, harmonics: 0.0, mode: 0 },
    { pitch: 0.5, decay: 0.5, timbre: 0.5, drive: 0.0, snap: 0.0, harmonics: 0.0, mode: 0 },
    { pitch: 0.5, decay: 0.5, timbre: 0.5, drive: 0.0, snap: 0.0, harmonics: 0.0, mode: 0 },
    { pitch: 0.5, decay: 0.5, timbre: 0.5, drive: 0.0, snap: 0.0, harmonics: 0.0, mode: 0 },
    { pitch: 0.5, decay: 0.5, timbre: 0.5, drive: 0.0, snap: 0.5, harmonics: 0.5, mode: 0 },
  ];
}

function cloneVoiceParamsList(list) {
  return list.map((params) => ({ ...params }));
}

function normalizeVoiceParamsList(list) {
  const defaults = createDefaultVoiceParams();
  if (!Array.isArray(list)) return defaults;

  return defaults.map((voice, index) => {
    const item = list[index] || {};
    return {
      pitch: clamp(Number(item.pitch ?? voice.pitch), 0, 1),
      decay: clamp(Number(item.decay ?? voice.decay), 0, 1),
      timbre: clamp(Number(item.timbre ?? voice.timbre), 0, 1),
      drive: clamp(Number(item.drive ?? voice.drive), 0, 1),
      snap: clamp(Number(item.snap ?? voice.snap), 0, 1),
      harmonics: clamp(Number(item.harmonics ?? voice.harmonics), 0, 1),
      mode: Math.max(0, Math.min(2, Math.round(Number(item.mode ?? voice.mode)))),
    };
  });
}

function calculateEnvMul(seconds, sampleRate) {
  return Math.exp(-6.9078 / Math.max(1, seconds * sampleRate));
}

function softClip(x, cubicAmount = 0.1481) {
  if (x > 1.5) return 1.0;
  if (x < -1.5) return -1.0;
  return x - cubicAmount * x * x * x;
}

class BassGroove {
  constructor() {
    this.params = {
      rootNote: 36,
      scaleType: 0,
      octaveOffset: 0,
      mode: 0,
      density: 0.6,
      minIntervalMs: 150,
      range: 7,
      slideProb: 0.2,
    };
    this.degree = 0;
    this.octave = 0;
    this.lastNote = this.params.rootNote;
    this.restSteps = 0;
    this.kickReceived = false;
    this.timeSinceLastTriggerMs = 1000;
    this.rngState = 0x5eedcafe;
    this.cachedScale = [0, 2, 3, 5, 7, 8, 10];
    this.lastDebug = {
      reason: "init",
      probability: 0,
      gateRoll: 0,
      triggered: false,
      note: null,
      velocity: 0,
      slide: false,
      gateMs: 0,
      degree: 0,
      octave: 0,
      rhythmEnergy: 0,
      activeCount: 0,
      drumMask: "----",
      rngState: this.rngState,
    };
    this.updateScaleCache();
  }

  cloneParams() {
    return { ...this.params };
  }

  updateParams(nextParams) {
    const previousRoot = this.params.rootNote;
    this.params = {
      ...this.params,
      ...nextParams,
      density: clamp(nextParams.density ?? this.params.density, 0, 0.8),
      range: clamp(Math.round(nextParams.range ?? this.params.range), 1, 12),
      rootNote: clamp(Math.round(nextParams.rootNote ?? this.params.rootNote), BASS_ROOT_MIN, BASS_ROOT_MAX),
      scaleType: clamp(Math.round(nextParams.scaleType ?? this.params.scaleType), 0, 3),
    };
    if (Math.abs(this.params.rootNote - previousRoot) >= 5 || Math.abs(this.lastNote - this.params.rootNote) > this.params.range + 5) {
      this.lastNote = this.params.rootNote;
      this.degree = 0;
      this.octave = 0;
    }
    this.updateScaleCache();
  }

  updateScaleCache() {
    const scales = [
      [0, 2, 3, 5, 7, 8, 10],
      [0, 2, 4, 5, 7, 9, 11],
      [0, 2, 3, 5, 7, 9, 10],
      [0, 1, 3, 5, 7, 8, 10],
    ];
    this.cachedScale = scales[this.params.scaleType] ?? scales[0];
  }

  randomUnit() {
    this.rngState = xorshift(this.rngState || 0x5eedcafe);
    return this.rngState / 4294967295;
  }

  setSeed(seed) {
    const nextSeed = Number(seed) >>> 0;
    this.rngState = nextSeed === 0 ? 0x5eedcafe : nextSeed;
    this.lastDebug.rngState = this.rngState;
  }

  process(dtMs) {
    this.timeSinceLastTriggerMs += dtMs;
  }

  onKick() {
    this.kickReceived = true;
  }

  buildRhythmContext(currentStep, rhythm = {}, bassIsActive = false) {
    const kick = Boolean(rhythm.kick || this.kickReceived);
    const snare = Boolean(rhythm.snare);
    const hatClosed = Boolean(rhythm.hatClosed);
    const hatOpen = Boolean(rhythm.hatOpen);
    const kickVelocity = rhythm.kickVelocity ?? 0;
    const snareVelocity = rhythm.snareVelocity ?? 0;
    const hatClosedVelocity = rhythm.hatClosedVelocity ?? 0;
    const hatOpenVelocity = rhythm.hatOpenVelocity ?? 0;
    const activeCount = (kick ? 1 : 0) + (snare ? 1 : 0) + (hatClosed ? 1 : 0) + (hatOpen ? 1 : 0);
    const isDownbeat = currentStep % 16 === 0;
    const isBackbeat = currentStep % 8 === 4;
    const grooveEnergy =
      kickVelocity * 1.2 +
      snareVelocity * 0.95 +
      hatClosedVelocity * 0.35 +
      hatOpenVelocity * 0.55;
    return {
      kick,
      snare,
      hatClosed,
      hatOpen,
      kickVelocity,
      snareVelocity,
      hatClosedVelocity,
      hatOpenVelocity,
      activeCount,
      grooveEnergy,
      isDownbeat,
      isBackbeat,
      bassIsActive,
      drumMask: `${kick ? "K" : "-"}${snare ? "S" : "-"}${hatClosed ? "h" : "-"}${hatOpen ? "H" : "-"}`,
    };
  }

  computeTriggerProbability(context) {
    let probability = this.params.density * 0.18 + context.grooveEnergy * 0.36;
    if (context.isDownbeat) {
      probability = 0.95; // Downbeat fortemente privilegiado
    } else if (context.kick) {
      probability = 0.8 + this.params.density * 0.2; // Kick aumenta bastante a chance
    } else if (context.snare) {
      probability = Math.max(probability, 0.4 + this.params.density * 0.22);
    } else if (context.hatOpen) {
      probability = Math.max(probability, 0.26 + this.params.density * 0.18);
    } else if (context.hatClosed && this.restSteps > 0) {
      probability = Math.max(probability, 0.14 + this.params.density * 0.15);
    } else {
      // Off-beat sem contexto fica bem menos provável (penalizado)
      probability *= 0.3;
    }

    if (this.restSteps >= 3) probability += 0.12;
    if (context.activeCount >= 3) probability += 0.08;
    if (context.bassIsActive && !context.kick && !context.snare) probability *= 0.82;

    // Multiplicador do controle de probabilidade do baixo
    probability *= this.params.bassProb;

    return clamp(probability, 0, 1);
  }

  buildNoteCandidates() {
    const candidates = [];
    const maxDistance = Math.max(4, this.params.range + 2);
    for (let octave = -1; octave <= 1; octave += 1) {
      for (let degree = 0; degree < this.cachedScale.length; degree += 1) {
        const note =
          this.params.rootNote +
          this.cachedScale[degree] +
          (octave + this.params.octaveOffset) * 12;
        if (note < 0 || note > 127) continue;
        const rootDistance = Math.abs(note - this.params.rootNote);
        if (rootDistance > maxDistance) continue;
        candidates.push({
          note,
          degree,
          octave,
          rootDistance,
          intervalFromLast: Math.abs(note - this.lastNote),
        });
      }
    }
    return candidates;
  }

  weightedChoice(candidates) {
    const total = candidates.reduce((sum, candidate) => sum + candidate.weight, 0);
    if (total <= 0) return candidates[0] ?? null;
    let threshold = this.randomUnit() * total;
    for (const candidate of candidates) {
      threshold -= candidate.weight;
      if (threshold <= 0) return candidate;
    }
    return candidates[candidates.length - 1] ?? null;
  }

  chooseNote(context) {
    const candidates = this.buildNoteCandidates().map((candidate) => {
      let weight = 0.04;
      if (context.isDownbeat || context.kick) {
        if (candidate.degree === 0) weight += 3.8;
        if (candidate.degree === 4) weight += 2.1;
        if (candidate.degree === 2 && !context.kick) weight += 0.6;
      } else if (context.snare || context.isBackbeat) {
        if (candidate.degree === 2 || candidate.degree === 6) weight += 1.8;
        if (candidate.degree === 4) weight += 1.0;
      } else if (context.hatOpen || context.hatClosed) {
        if (candidate.intervalFromLast <= 3) weight += 1.6;
        if (candidate.degree === this.degree) weight += 0.8;
      } else {
        if (candidate.degree === this.degree) weight += 1.2;
        if (candidate.intervalFromLast <= 2) weight += 0.9;
      }

      if (candidate.note === this.lastNote && context.bassIsActive) weight += 0.65;
      if (candidate.intervalFromLast > 0 && candidate.intervalFromLast <= 5) weight += 1.2;
      if (candidate.intervalFromLast > Math.max(5, this.params.range)) weight *= 0.35;
      if (candidate.rootDistance > this.params.range) weight *= 0.3;
      if (Math.abs(candidate.octave) > 0) weight *= context.isDownbeat || context.kick ? 0.9 : 0.65;
      if (this.restSteps >= 2 && candidate.degree === 0) weight += 0.8;

      return {
        ...candidate,
        weight,
      };
    });

    return this.weightedChoice(candidates) ?? {
      note: this.params.rootNote,
      degree: 0,
      octave: 0,
      rootDistance: 0,
      intervalFromLast: 0,
      weight: 1,
    };
  }

  onTick(currentStep, bassIsActive, rhythm = {}) {
    const context = this.buildRhythmContext(currentStep, rhythm, bassIsActive);
    if (this.timeSinceLastTriggerMs < this.params.minIntervalMs) {
      this.kickReceived = false;
      this.restSteps += 1;
      this.lastDebug = {
        reason: "interval_guard",
        probability: 0,
        gateRoll: 0,
        triggered: false,
        note: null,
        velocity: 0,
        slide: false,
        gateMs: 0,
        degree: this.degree,
        octave: this.octave,
        rhythmEnergy: context.grooveEnergy,
        activeCount: context.activeCount,
        drumMask: context.drumMask,
        rngState: this.rngState,
      };
      return null;
    }

    if (context.isDownbeat) {
      this.degree = 0;
      this.octave = 0;
    }

    const probability = this.computeTriggerProbability(context);
    let event = null;
    const gateRoll = this.randomUnit();
    if (gateRoll < probability) {
      // Priorize downbeat and kick-step/structural pulse for accent
      const accent =
        context.isDownbeat ||
        context.kick ||
        (context.snare && this.randomUnit() < 0.3) ||
        this.randomUnit() < 0.15; // Moderate random chance

      const candidate = this.chooseNote(context);
      const note = candidate.note;
      this.degree = candidate.degree;
      this.octave = candidate.octave;
      const slideBias = context.hatClosed || context.hatOpen ? 1.15 : 0.85;
      const slide =
        this.params.slideProb > 0.01 &&
        context.bassIsActive &&
        candidate.intervalFromLast > 0 &&
        candidate.intervalFromLast <= 7 &&
        this.randomUnit() < clamp(this.params.slideProb * slideBias, 0, 0.95);
      const velocityBase = accent ? 0.84 : context.snare ? 0.67 : 0.6;
      const velocitySpan = accent ? 0.14 : 0.18;
      const gateMs = clamp(
        110 +
          this.params.density * 120 +
          (context.kick ? 120 : 0) +
          (context.snare ? 50 : 0) +
          (slide ? 80 : 0) +
          (accent ? 90 : 0),
        80,
        720,
      );
      event = {
        note,
        freq: 440 * Math.pow(2, (note - 69) / 12),
        velocity: clamp(velocityBase + this.randomUnit() * velocitySpan, 0.45, 1),
        slide,
        accent,
        gateMs,
        rhythmEnergy: context.grooveEnergy,
      };
      this.lastNote = note;
      this.timeSinceLastTriggerMs = 0;
      this.restSteps = 0;
    } else {
      this.restSteps += 1;
    }

    this.lastDebug = {
      reason: event ? "triggered" : (context.kick ? "kick_miss" : context.activeCount ? "groove_miss" : "probability_miss"),
      probability,
      gateRoll,
      triggered: Boolean(event),
      note: event?.note ?? null,
      velocity: event?.velocity ?? 0,
      slide: event?.slide ?? false,
      gateMs: event?.gateMs ?? 0,
      degree: this.degree,
      octave: this.octave,
      rhythmEnergy: context.grooveEnergy,
      activeCount: context.activeCount,
      drumMask: context.drumMask,
      rngState: this.rngState,
    };
    this.kickReceived = false;
    return event;
  }
}

class AudioEngine {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.bass = null;
    this.voiceParams = createDefaultVoiceParams();
    this.activeSources = new Set();
    this.driveCurveCache = new Map();
    this.drumCache = new Map();
  }

  ensureStarted() {
    if (this.ctx) {
      if (this.ctx.state === "suspended") {
        this.ctx.resume();
      }
      return;
    }

    this.ctx = new window.AudioContext();
    this.master = this.ctx.createGain();
    this.master.gain.value = 0.75;
    const comp = this.ctx.createDynamicsCompressor();
    comp.threshold.value = -16;
    comp.knee.value = 12;
    comp.ratio.value = 3;
    comp.attack.value = 0.003;
    comp.release.value = 0.12;
    this.master.connect(comp);
    comp.connect(this.ctx.destination);
    this.bass = this.createBassVoice();
    this.setVoiceParams(this.voiceParams);
  }

  setMaster(level) {
    if (!this.master) return;
    this.master.gain.setTargetAtTime(level, this.ctx.currentTime, 0.015);
  }

  setVoiceParams(params) {
    this.voiceParams = normalizeVoiceParamsList(params);
    if (this.drumCache) this.drumCache.clear();
    if (!this.ctx || !this.bass) return;
    const bassParams = this.voiceParams[VOICE_BASS];
    const harm = clamp(bassParams.harmonics, 0, 1);
    const sawMix = 0.34 + harm * 0.14;
    const triMix = 0.1 + harm * 0.18;
    const subMix = Math.max(0.3, 0.58 - harm * 0.16);
    this.bass.sawGain.gain.setTargetAtTime(sawMix, this.ctx.currentTime, 0.01);
    this.bass.triGain.gain.setTargetAtTime(triMix, this.ctx.currentTime, 0.01);
    this.bass.subGain.gain.setTargetAtTime(subMix, this.ctx.currentTime, 0.01);
    this.bass.filter.Q.setTargetAtTime(0.9 + bassParams.timbre * 2.2, this.ctx.currentTime, 0.01);
    this.bass.drive.curve = this.getDriveCurve(1 + bassParams.drive * 2.4);
  }

  stopAll() {
    if (!this.ctx) return;
    const time = this.ctx.currentTime;
    this.activeSources.forEach((source) => {
      try {
        source.stop(time);
        source.disconnect();
      } catch (_) {
        // Source may have already ended.
      }
    });
    this.activeSources.clear();
    if (this.bass) {
      this.bass.gain.gain.cancelScheduledValues(time);
      this.bass.gain.gain.setTargetAtTime(0.0001, time, 0.02);
    }
  }

  createBassVoice() {
    const osc = this.ctx.createOscillator();
    osc.type = "sawtooth";
    const tri = this.ctx.createOscillator();
    tri.type = "triangle";
    const sub = this.ctx.createOscillator();
    sub.type = "sine";
    const sawGain = this.ctx.createGain();
    const triGain = this.ctx.createGain();
    const subGain = this.ctx.createGain();
    const preDrive = this.ctx.createGain();
    const filter = this.ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.value = 220;
    filter.Q.value = 4.5;
    const drive = this.ctx.createWaveShaper();
    drive.oversample = "4x";
    const gain = this.ctx.createGain();
    gain.gain.value = 0.0001;
    sawGain.gain.value = 0.42;
    triGain.gain.value = 0.12;
    subGain.gain.value = 0.5;
    osc.connect(sawGain);
    tri.connect(triGain);
    sub.connect(subGain);
    sawGain.connect(preDrive);
    triGain.connect(preDrive);
    subGain.connect(preDrive);
    preDrive.connect(filter);
    filter.connect(drive);
    drive.connect(gain);
    gain.connect(this.master);
    osc.start();
    tri.start();
    sub.start();
    return { osc, tri, sub, sawGain, triGain, subGain, preDrive, filter, drive, gain };
  }

  getDriveCurve(amount) {
    const key = amount.toFixed(2);
    if (this.driveCurveCache.has(key)) return this.driveCurveCache.get(key);
    const curve = new Float32Array(1024);
    for (let i = 0; i < curve.length; i += 1) {
      const x = (i / (curve.length - 1)) * 2 - 1;
      curve[i] = Math.tanh(x * amount);
    }
    this.driveCurveCache.set(key, curve);
    return curve;
  }

  playBuffer(buffer, time = null) {
    const source = this.ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(this.master);
    source.addEventListener("ended", () => {
      source.disconnect();
      this.activeSources.delete(source);
    });
    this.activeSources.add(source);
    if (time !== null) {
      source.start(time);
    } else {
      source.start();
    }
    return source;
  }

  makeBuffer(seconds) {
    return this.ctx.createBuffer(1, Math.max(1, Math.ceil(seconds * this.ctx.sampleRate)), this.ctx.sampleRate);
  }

  buildKickBuffer(event) {
    const params = this.voiceParams[0];
    const buffer = this.makeBuffer(0.72);
    const out = buffer.getChannelData(0);
    const sr = this.ctx.sampleRate;
    const srInv = 1 / sr;
    const baseFreq = 35 + params.pitch * 50;
    const gainMul = 1 - (0.00025 + (1 - params.decay) * 0.002);
    const pitchMul = 0.96;

    let sweepAmount = 150 + params.timbre * 350;
    if (event.accent) sweepAmount *= 1.2;
    if (event.ghost) sweepAmount *= 0.6;

    let driveFactor = 1 + params.drive * 4;
    let cutoffBase = 0.04 + params.drive * 0.08;
    if (event.accent) cutoffBase *= 1.3;
    if (event.ghost) cutoffBase *= 0.7;

    const svfQ = 0.5 + params.timbre * 0.4;
    let envGain = event.velocity;
    if (event.ghost) envGain *= 0.7; // Reduce force further on ghost

    let envPitch = 1.0;
    let clickEnv = 1.0;
    if (event.ghost) clickEnv = 0.3; // Less click on ghost notes
    let phase = 0.0;
    let svfLow = 0.0;
    let svfBand = 0.0;
    let dcX1 = 0.0;
    let dcY1 = 0.0;

    for (let i = 0; i < out.length; i += 1) {
      envGain *= gainMul;
      envPitch *= pitchMul;
      if (envGain < 0.0008) break;

      const pitchEnv = envPitch * envPitch;
      const currentFreq = baseFreq + sweepAmount * pitchEnv;
      phase += currentFreq * srInv;
      if (phase >= 1.0) phase -= 1.0;

      const sine = Math.sin(phase * Math.PI * 2);
      let shaped = sine * (1 + 0.5 * sine * sine);
      if (clickEnv > 0.001) {
        shaped += clickEnv * (1 - 2 * phase) * (0.1 + params.timbre * 0.4);
        clickEnv *= 0.5;
      }

      const clipped = softClip(shaped * driveFactor, 0.1481);
      let sample = clipped * envGain;
      const cutoff = Math.min(0.9, (cutoffBase + pitchEnv * 0.05) * 2);
      const hp = sample - svfLow - svfQ * svfBand;
      svfBand += cutoff * hp;
      svfLow += cutoff * svfBand;
      sample = svfLow;

      const blocked = sample - dcX1 + 0.995 * dcY1;
      dcX1 = sample;
      dcY1 = blocked;
      out[i] = blocked * 0.9;
    }

    return buffer;
  }

  buildSnareBuffer(event) {
    const params = this.voiceParams[1];
    const buffer = this.makeBuffer(params.mode === 2 ? 0.85 : 0.52);
    const out = buffer.getChannelData(0);
    const sr = this.ctx.sampleRate;
    const srInv = 1 / sr;
    let rngState = 0x51a3f28d;
    const nextNoise = () => {
      rngState = xorshift(rngState);
      return ((rngState & 65535) / 32768) - 1;
    };

    const dynDecay = params.decay * (0.4 + event.velocity * 0.6);
    const dynTimbre = params.timbre * (0.5 + event.velocity * 0.5);

    if (params.mode === 1) {
      let rimMs = 20 + dynDecay * 100;
      if (event.ghost) rimMs *= 0.5;
      const envMulRim = calculateEnvMul(rimMs * 0.001, sr);
      const phaseInc = (800 + params.pitch * 1200) * srInv;
      let env = event.velocity;
      if (event.ghost) env *= 0.6;
      let phase = 0.0;
      for (let i = 0; i < out.length; i += 1) {
        env *= envMulRim;
        if (env < 0.0008) break;
        phase += phaseInc;
        if (phase >= 1.0) phase -= 1.0;
        const tone = Math.sin(phase * Math.PI * 2);
        out[i] = softClip((tone * 0.8 + nextNoise() * 0.2) * env * 2.0, 0.296);
      }
      return buffer;
    }

    if (params.mode === 2) {
      let noiseMs = 100 + dynDecay * 300;
      if (event.ghost) noiseMs *= 0.5;
      const envMulNoise = calculateEnvMul(noiseMs * 0.001, sr);
      let envNoise = event.velocity;
      if (event.ghost) envNoise *= 0.6;
      let wire1 = 0.0;
      let burstCount = 4;
      let burstSamples = 0;
      const burstEnvs = [envNoise, 0, 0, 0];
      for (let i = 0; i < out.length; i += 1) {
        envNoise *= envMulNoise;
        if (burstSamples > 0) {
          burstSamples -= 1;
        } else if (burstCount > 0) {
          const burstIdx = 4 - burstCount;
          if (burstIdx < 4) burstEnvs[burstIdx] = envNoise * (0.9 - burstIdx * 0.15);
          burstCount -= 1;
          const spacingBase = 900 - (4 - burstCount) * 150;
          rngState = xorshift(rngState);
          burstSamples = spacingBase + (rngState % 200);
        }

        const noise = nextNoise();
        wire1 += (noise - wire1) * 0.35;
        let burstSum = 0.0;
        for (let j = 0; j < burstEnvs.length; j += 1) {
          if (burstEnvs[j] > 0.001) {
            burstSum += wire1 * burstEnvs[j];
            burstEnvs[j] *= 0.92;
          }
        }
        out[i] = softClip(burstSum * 2.0, 0.296);
      }
      return buffer;
    }

    let bodyMs = 80 + dynDecay * 170;
    let wireMs = 60 + dynDecay * 390;
    let clickMs = 1.5 + dynTimbre * 1.5;
    if (event.ghost) {
      bodyMs *= 0.5;
      wireMs *= 0.5;
      clickMs *= 0.3;
    }
    const pitchMs = 15;
    const envMulBody = calculateEnvMul(bodyMs * 0.001, sr);
    const envMulNoise = calculateEnvMul(wireMs * 0.001, sr);
    const envMulClick = calculateEnvMul(clickMs * 0.001, sr);
    const envMulPitch = calculateEnvMul(pitchMs * 0.001, sr);
    const baseFreq = 170 + params.pitch * 70;
    const phaseInc = baseFreq * srInv;
    const phaseInc2 = baseFreq * 1.48 * srInv;
    const filterC1 = 0.12 + dynTimbre * 0.10;
    const filterC2 = 0.28 + dynTimbre * 0.15;
    const wireGain = 1 + dynTimbre * 0.8;
    const clickGain = 0.5 + dynTimbre * 1.0;
    let envBody = event.velocity;
    let envNoise = event.velocity;
    let envClick = event.velocity;
    if (event.ghost) {
      envBody *= 0.5;
      envNoise *= 0.6;
      envClick *= 0.2;
    }
    let envPitch = 1.0;
    let wire1 = 0.0;
    let wire2 = 0.0;
    let dcX1 = 0.0;
    let dcY1 = 0.0;
    let phase = 0.0;
    let phase2 = 0.0;

    for (let i = 0; i < out.length; i += 1) {
      envBody *= envMulBody;
      envNoise *= envMulNoise;
      envClick *= envMulClick;
      envPitch *= envMulPitch;
      if (envBody < 0.0008 && envNoise < 0.0008) break;

      const snap = envPitch * envPitch;
      phase += phaseInc * (1 + snap * 0.5);
      if (phase >= 1.0) phase -= 1.0;
      phase2 += phaseInc2;
      if (phase2 >= 1.0) phase2 -= 1.0;

      const b1 = Math.sin(phase * Math.PI * 2);
      const b2 = Math.sin(phase2 * Math.PI * 2);
      let membrane = (b1 * 0.65 + b2 * 0.35);
      membrane += membrane * membrane * 0.2;
      membrane = softClip(membrane * envBody * 1.1, 0.296);

      let click = 0.0;
      if (envClick > 0.001) click = softClip(envClick * (1 - 2 * phase) * clickGain, 0.296);

      const noise = nextNoise();
      wire1 += (noise - wire1) * filterC1;
      wire2 += (noise - wire2) * filterC2;
      const wire = (wire2 - wire1) * envNoise * wireGain;
      const sample = softClip((membrane * 0.9) + wire + (click * 0.6), 0.296);
      const blocked = sample - dcX1 + 0.995 * dcY1;
      dcX1 = sample;
      dcY1 = blocked;
      out[i] = blocked * 0.8;
    }

    return buffer;
  }

  buildHatBuffer(event, open) {
    const params = this.voiceParams[open ? 3 : 2];
    const buffer = this.makeBuffer(open ? 1.0 : 0.24);
    const out = buffer.getChannelData(0);
    const sr = this.ctx.sampleRate;
    const srInv = 1 / sr;
    const minMs = open ? 300 : 40;
    const maxMs = open ? 900 : 100;
    let envMs = minMs + params.decay * (maxMs - minMs);
    if (event.ghost) envMs *= 0.6; // Shorter decay for ghost

    let dynTimbre = params.timbre;
    if (event.accent) dynTimbre = clamp(dynTimbre + 0.2, 0, 1);
    if (event.ghost) dynTimbre = clamp(dynTimbre - 0.3, 0, 1);

    const envMul = calculateEnvMul(envMs * 0.001, sr);
    const baseFreq = 300 + dynTimbre * 300;
    const ratios = [1.0, 1.48, 2.15, 3.71];
    const phase = [0, 0, 0, 0];
    const inc = ratios.map((ratio) => baseFreq * ratio * srInv);
    let env = event.velocity;
    if (event.ghost) env *= 0.5; // Reduce overall energy for ghosts

    let svfLow = 0.0;
    let svfBand = 0.0;
    let rngState = open ? 0x7f3a2c91 : 0x1e9d4baf;
    for (let i = 0; i < out.length; i += 1) {
      env *= envMul;
      if (env < 0.0008) break;
      let metal = 0.0;
      for (let j = 0; j < 4; j += 1) {
        rngState = xorshift(rngState);
        const drift = 1 + ((((rngState & 1023) / 1023) * 2) - 1) * 0.005;
        phase[j] += inc[j] * drift;
        if (phase[j] >= 1.0) phase[j] -= 1.0;
        metal += Math.sin(phase[j] * Math.PI * 2);
      }
      metal *= 0.25;
      rngState = xorshift(rngState);
      const noise = ((rngState & 65535) / 32768) - 1;
      const mix = metal * (0.3 + dynTimbre * 0.7) + noise * (0.6 - dynTimbre * 0.4);
      let f = (0.15 + dynTimbre * 0.25) * 2;
      if (f > 0.9) f = 0.9;
      const q = 0.5 + dynTimbre * 0.5;
      const hp = mix - svfLow - q * svfBand;
      svfBand += f * hp;
      svfLow += f * svfBand;
      out[i] = hp * env * (open ? 0.55 : 0.42);
    }
    return buffer;
  }

  trigger(trackIndex, event, bassEvent = null, time = null) {
    if (!this.ctx) return;

    if (trackIndex >= 0 && trackIndex <= 3) {
      const cacheKey = `${trackIndex}-${event.velocity.toFixed(3)}-${event.accent ? 1 : 0}-${event.ghost ? 1 : 0}`;
      let buffer = this.drumCache.get(cacheKey);
      if (!buffer) {
        if (trackIndex === 0) buffer = this.buildKickBuffer(event);
        else if (trackIndex === 1) buffer = this.buildSnareBuffer(event);
        else if (trackIndex === 2) buffer = this.buildHatBuffer(event, false);
        else if (trackIndex === 3) buffer = this.buildHatBuffer(event, true);
        this.drumCache.set(cacheKey, buffer);
      }
      this.playBuffer(buffer, time);
      return;
    }

    if (trackIndex === 4 && bassEvent) {
      this.triggerBass(time !== null ? time : this.ctx.currentTime, bassEvent);
    }
  }

  triggerBass(time, event) {
    const params = this.voiceParams[VOICE_BASS];
    const gateSeconds = clamp((event.gateMs ?? (120 + params.decay * 420)) / 1000, 0.06, 0.85);
    const glideTime = event.slide ? 0.045 + params.timbre * 0.012 : 0.006 + params.timbre * 0.008;
    const filterPeak =
      110 +
      params.timbre * 540 +
      params.snap * 620 +
      event.velocity * 180 +
      (event.rhythmEnergy ?? 0) * 120 +
      (event.accent ? 80 : 0);
    const filterFloor = 70 + params.timbre * 140;
    const peakGain = clamp(0.1 + event.velocity * 0.16 + (event.accent ? 0.03 : 0), 0.08, 0.28);

    this.bass.osc.frequency.cancelScheduledValues(time);
    this.bass.tri.frequency.cancelScheduledValues(time);
    this.bass.sub.frequency.cancelScheduledValues(time);
    this.bass.filter.frequency.cancelScheduledValues(time);
    this.bass.filter.Q.cancelScheduledValues(time);
    this.bass.gain.gain.cancelScheduledValues(time);

    this.bass.osc.frequency.linearRampToValueAtTime(event.freq, time + glideTime);
    this.bass.tri.frequency.linearRampToValueAtTime(event.freq, time + glideTime);
    this.bass.sub.frequency.linearRampToValueAtTime(event.freq / 2, time + glideTime);
    this.bass.filter.frequency.setValueAtTime(filterPeak, time);
    this.bass.filter.frequency.exponentialRampToValueAtTime(Math.max(50, filterFloor), time + gateSeconds);
    this.bass.filter.Q.setTargetAtTime(0.85 + params.timbre * 1.5 + (event.accent ? 0.5 : 0), time, 0.008);
    if (event.slide) {
      this.bass.gain.gain.setTargetAtTime(peakGain * 0.95, time, 0.012);
    } else {
      this.bass.gain.gain.setValueAtTime(0.0001, time);
      this.bass.gain.gain.exponentialRampToValueAtTime(peakGain, time + 0.004);
    }
    this.bass.gain.gain.exponentialRampToValueAtTime(0.0001, time + gateSeconds);
  }
}

class PenosaDesktopSim {
  constructor() {
    this.bpm = 120;
    this.masterVolume = 0.75;
    this.autoRotateDownbeat = false;
    this.isPlaying = false;
    this.currentStep = 0;
    this.activeTrack = 0;
    this.currentSlot = 0;
    this.trackMutes = Array(TRACK_COUNT).fill(false);
    this.trackColors = COLORS.track;
    this.globalRoot = 0;
    this.globalScale = 0;
    this.bassGroove = new BassGroove();
    this.voiceParams = createDefaultVoiceParams();
    this.scheduler = null;
    this.audio = new AudioEngine();
    this.pulseScale = 1;
    this.lastBeatStep = -1;
    this.bassVoicePitch = this.bassRootNoteToPitch(this.bassGroove.params.rootNote);
    this.seed = 0x5eedcafe;
    this.rngState = this.seed;
    this.bassVoiceHoldMs = 0;
    this.eventLog = [];
    this.lastTickEvents = [];
    this.slots = this.createFactorySlots();
    this.restoreSlots();
    this.bassGroove.setSeed(this.seed);
    this.loadSlot(0);
  }

  createTrack(steps, hits) {
    return {
      steps,
      hits,
      rotationOffset: 0,
      pattern: new Uint8Array(64),
      patternLen: 0,
    };
  }

  createFactorySlots() {
    const makeSlot = (overrides = {}) => ({
      bpm: 120,
      autoRotateDownbeat: false,
      ghostNotesProb: 0.15,
      globalRoot: 0,
      globalScale: 0,
      bassDensity: 0.6,
      bassProb: 1.0,
      bassRange: 7,
      bassRootNote: 36,
      voiceParams: createDefaultVoiceParams(),
      tracks: [
        { steps: 16, hits: 4, rotationOffset: 0 },
        { steps: 16, hits: 0, rotationOffset: 0 },
        { steps: 16, hits: 4, rotationOffset: 0 },
        { steps: 16, hits: 0, rotationOffset: 0 },
        { steps: 16, hits: 4, rotationOffset: 0 },
      ],
      ...overrides,
    });

    return [
      makeSlot({
        bpm: 125,
        globalScale: 1,
        voiceParams: (() => {
          const params = createDefaultVoiceParams();
          params[0].decay = 0.6;
          params[0].timbre = 0.8;
          return params;
        })(),
      }),
      makeSlot({
        bpm: 110,
        globalRoot: 2,
        globalScale: 2,
        tracks: [
          { steps: 13, hits: 5, rotationOffset: 0 },
          { steps: 7, hits: 3, rotationOffset: 0 },
          { steps: 16, hits: 4, rotationOffset: 0 },
          { steps: 16, hits: 4, rotationOffset: 0 },
          { steps: 16, hits: 4, rotationOffset: 0 },
        ],
        bassRootNote: 38,
      }),
      makeSlot({
        bpm: 110,
        globalRoot: 5,
        bassDensity: 0.45,
        bassRange: 5,
        bassRootNote: 41,
        voiceParams: (() => {
          const params = createDefaultVoiceParams();
          params[0].decay = 0.8;
          params[0].timbre = 0.2;
          params[1].mode = 2;
          return params;
        })(),
      }),
      makeSlot({
        bpm: 140,
        globalScale: 3,
        bassDensity: 0.72,
        bassRange: 10,
        voiceParams: (() => {
          const params = createDefaultVoiceParams();
          params.forEach((voice) => {
            voice.timbre = 1.0;
          });
          return params;
        })(),
        tracks: Array.from({ length: 5 }, () => ({ steps: 16, hits: 8, rotationOffset: 0 })),
      }),
      makeSlot({
        bpm: 80,
        globalRoot: 7,
        bassDensity: 0.22,
        bassRange: 3,
        bassRootNote: 31,
        voiceParams: (() => {
          const params = createDefaultVoiceParams();
          params.forEach((voice) => {
            voice.decay = 0.9;
          });
          return params;
        })(),
        tracks: Array.from({ length: 5 }, () => ({ steps: 16, hits: 2, rotationOffset: 0 })),
      }),
      makeSlot({
        bpm: 122,
        globalRoot: 9,
        globalScale: 1,
        bassDensity: 0.55,
        bassRange: 4,
        bassRootNote: 33,
        voiceParams: (() => {
          const params = createDefaultVoiceParams();
          params.forEach((voice) => {
            voice.decay = 0.1;
            voice.timbre = 0.9;
          });
          return params;
        })(),
        tracks: Array.from({ length: 5 }, () => ({ steps: 16, hits: 3, rotationOffset: 0 })),
      }),
    ];
  }

  normalizeSlot(parsed, defaultSlot) {
    if (typeof parsed !== "object" || parsed === null) return defaultSlot;

    const bpm = clamp(Number(parsed.bpm ?? defaultSlot.bpm), 40, 240);
    const autoRotateDownbeat = Boolean(parsed.autoRotateDownbeat ?? defaultSlot.autoRotateDownbeat);
    const ghostNotesProb = clamp(Number(parsed.ghostNotesProb ?? defaultSlot.ghostNotesProb), 0, 1.0);
    const globalRoot = clamp(Number(parsed.globalRoot ?? defaultSlot.globalRoot), 0, 11);
    const globalScale = clamp(Number(parsed.globalScale ?? defaultSlot.globalScale), 0, 3);
    const bassDensity = clamp(Number(parsed.bassDensity ?? defaultSlot.bassDensity), 0, 0.8);
    const bassProb = clamp(Number(parsed.bassProb ?? defaultSlot.bassProb), 0, 1.0);
    const bassRange = clamp(Math.round(Number(parsed.bassRange ?? defaultSlot.bassRange)), 1, 12);
    const bassRootNote = clamp(Math.round(Number(parsed.bassRootNote ?? defaultSlot.bassRootNote)), BASS_ROOT_MIN, BASS_ROOT_MAX);
    const voiceParams = normalizeVoiceParamsList(parsed.voiceParams ?? defaultSlot.voiceParams);

    let tracks = defaultSlot.tracks;
    if (Array.isArray(parsed.tracks) && parsed.tracks.length === TRACK_COUNT) {
      tracks = parsed.tracks.map((track, i) => ({
        steps: clamp(Number(track.steps ?? defaultSlot.tracks[i].steps), 1, 64),
        hits: clamp(Number(track.hits ?? defaultSlot.tracks[i].hits), 0, 64),
        rotationOffset: Math.max(0, Number(track.rotationOffset ?? defaultSlot.tracks[i].rotationOffset)),
      }));
    }

    return {
      bpm,
      autoRotateDownbeat,
      ghostNotesProb,
      globalRoot,
      globalScale,
      bassDensity,
      bassProb,
      bassRange,
      bassRootNote,
      voiceParams,
      tracks,
    };
  }

  restoreSlots() {
    let saved = localStorage.getItem(STORAGE_KEY);
    if (!saved) {
      // Tenta recuperar os antigos da v1
      saved = localStorage.getItem("penosa-desktop-sim-slots-v1");
    }

    if (!saved) return;
    try {
      const parsed = JSON.parse(saved);
      if (Array.isArray(parsed) && parsed.length === this.slots.length) {
        this.slots = parsed.map((slot, i) => this.normalizeSlot(slot, this.slots[i]));
      } else {
        throw new Error("Formato de slots inválido");
      }
    } catch (error) {
      console.warn("Falha ao restaurar slots, usando de fábrica:", error);
      this.slots = this.createFactorySlots();
    }
  }

  persistSlots() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(this.slots));
  }

  resetFactorySlots() {
    this.slots = this.createFactorySlots();
    this.persistSlots();
    this.loadSlot(0);
  }

  loadSlot(index) {
    this.currentSlot = index;
    const slot = this.slots[index];
    this.bpm = slot.bpm;
    this.autoRotateDownbeat = slot.autoRotateDownbeat;
    this.ghostNotesProb = slot.ghostNotesProb ?? 0.15;
    this.globalRoot = slot.globalRoot;
    this.globalScale = slot.globalScale;
    this.tracks = slot.tracks.map((track) => this.createTrack(track.steps, track.hits));
    this.tracks.forEach((track, idx) => {
      track.rotationOffset = slot.tracks[idx].rotationOffset;
      this.recalculatePattern(idx);
    });
    this.voiceParams = normalizeVoiceParamsList(slot.voiceParams);
    this.bassGroove.updateParams({
      rootNote: slot.bassRootNote,
      scaleType: slot.globalScale,
      density: slot.bassDensity,
      bassProb: slot.bassProb ?? 1.0,
      range: slot.bassRange,
    });
    this.bassVoicePitch = this.bassRootNoteToPitch(slot.bassRootNote);
    this.voiceParams[VOICE_BASS].pitch = this.bassVoicePitch;
    this.resetClock();
    this.eventLog = [];
    this.syncBassFromGlobals();
    this.audio.setVoiceParams(this.voiceParams);
    this.restartScheduler();
  }

  saveCurrentSlot() {
    const bass = this.bassGroove.cloneParams();
    this.slots[this.currentSlot] = {
      bpm: this.bpm,
      autoRotateDownbeat: this.autoRotateDownbeat,
      ghostNotesProb: this.ghostNotesProb,
      globalRoot: this.globalRoot,
      globalScale: this.globalScale,
      bassDensity: bass.density,
      bassProb: bass.bassProb,
      bassRange: bass.range,
      bassRootNote: bass.rootNote,
      voiceParams: normalizeVoiceParamsList(this.voiceParams),
      tracks: this.tracks.map((track) => ({
        steps: track.steps,
        hits: track.hits,
        rotationOffset: track.rotationOffset,
      })),
    };
    this.persistSlots();
  }

  setSeed(seed) {
    this.seed = (Number(seed) >>> 0) || 0x5eedcafe;
    this.rngState = this.seed;
    this.bassGroove.setSeed(this.seed);
    this.resetClock();
    this.eventLog = [];
  }

  resetClock() {
    this.currentStep = 0;
    this.lastBeatStep = -1;
    this.lastTickEvents = [];
    this.bassVoiceHoldMs = 0;
  }

  randomUnit() {
    this.rngState = xorshift(this.rngState || this.seed || 0x5eedcafe);
    return this.rngState / 4294967295;
  }

  bassRootNoteToPitch(rootNote) {
    return (clamp(rootNote, BASS_ROOT_MIN, BASS_ROOT_MAX) - BASS_ROOT_MIN) / (BASS_ROOT_MAX - BASS_ROOT_MIN);
  }

  pitchToBassRootNote(pitch) {
    return Math.round(BASS_ROOT_MIN + clamp(pitch, 0, 1) * (BASS_ROOT_MAX - BASS_ROOT_MIN));
  }

  syncBassFromGlobals() {
    const bass = this.bassGroove.cloneParams();
    const octaveBase = Math.floor(bass.rootNote / 12) * 12;
    let candidate = octaveBase + ((this.globalRoot % 12) + 12) % 12;
    while (candidate < BASS_ROOT_MIN) candidate += 12;
    while (candidate > BASS_ROOT_MAX) candidate -= 12;
    this.bassGroove.updateParams({
      rootNote: candidate,
      scaleType: this.globalScale,
    });
    this.bassVoicePitch = this.bassRootNoteToPitch(candidate);
    this.voiceParams[VOICE_BASS].pitch = this.bassVoicePitch;
    this.audio.setVoiceParams(this.voiceParams);
  }

  syncGlobalsFromBass() {
    const bass = this.bassGroove.cloneParams();
    this.globalRoot = bass.rootNote % 12;
    this.globalScale = bass.scaleType;
    this.bassVoicePitch = this.bassRootNoteToPitch(bass.rootNote);
    this.voiceParams[VOICE_BASS].pitch = this.bassVoicePitch;
    this.audio.setVoiceParams(this.voiceParams);
  }

  syncBassFromPitch(pitch) {
    this.bassVoicePitch = clamp(pitch, 0, 1);
    this.bassGroove.updateParams({ rootNote: this.pitchToBassRootNote(this.bassVoicePitch) });
    this.voiceParams[VOICE_BASS].pitch = this.bassVoicePitch;
    this.syncGlobalsFromBass();
  }

  setVoiceParam(trackIndex, nextParams) {
    this.voiceParams[trackIndex] = {
      ...this.voiceParams[trackIndex],
      ...nextParams,
    };
    this.voiceParams[trackIndex].pitch = clamp(this.voiceParams[trackIndex].pitch ?? 0.5, 0, 1);
    this.voiceParams[trackIndex].decay = clamp(this.voiceParams[trackIndex].decay ?? 0.5, 0, 1);
    this.voiceParams[trackIndex].timbre = clamp(this.voiceParams[trackIndex].timbre ?? 0.5, 0, 1);
    this.voiceParams[trackIndex].drive = clamp(this.voiceParams[trackIndex].drive ?? 0, 0, 1);
    this.voiceParams[trackIndex].snap = clamp(this.voiceParams[trackIndex].snap ?? 0, 0, 1);
    this.voiceParams[trackIndex].harmonics = clamp(this.voiceParams[trackIndex].harmonics ?? 0, 0, 1);
    this.voiceParams[trackIndex].mode = Math.max(0, Math.min(2, Math.round(this.voiceParams[trackIndex].mode ?? 0)));
    if (trackIndex === VOICE_BASS && nextParams.pitch !== undefined) {
      this.syncBassFromPitch(this.voiceParams[trackIndex].pitch);
      return;
    }
    this.audio.setVoiceParams(this.voiceParams);
  }

  recalculatePattern(trackIndex) {
    const track = this.tracks[trackIndex];
    const steps = clamp(track.steps, 1, 64);
    const hits = clamp(track.hits, 0, steps);
    track.steps = steps;
    track.hits = hits;

    if (hits <= 0) {
      track.pattern.fill(0, 0, steps);
    } else if (hits >= steps) {
      track.pattern.fill(1, 0, steps);
    } else {
      let bucket = 0;
      for (let i = 0; i < steps; i += 1) {
        bucket += hits;
        track.pattern[i] = bucket >= steps ? 1 : 0;
        if (bucket >= steps) bucket -= steps;
      }
    }

    track.patternLen = steps;
    if (this.autoRotateDownbeat && steps > 0 && hits > 0 && hits < steps) {
      let rotations = 0;
      while (track.pattern[0] === 0 && rotations < steps) {
        const first = track.pattern[0];
        track.pattern.copyWithin(0, 1, steps);
        track.pattern[steps - 1] = first;
        rotations += 1;
      }
    }

    let rotation = track.rotationOffset % steps;
    if (rotation < 0) rotation += steps;
    if (rotation > 0) {
      const temp = Array.from(track.pattern.slice(0, steps));
      for (let i = 0; i < steps; i += 1) {
        track.pattern[(i + rotation) % steps] = temp[i];
      }
    }

    let firstHitFound = false;
    for (let i = 0; i < steps; i += 1) {
      if (track.pattern[i] !== 0) {
        // Primeiro hit encontrado no pattern final rotacionado => velocity forte (127)
        // Demais hits => velocity base (85)
        let baseVelocity = firstHitFound ? 85 : 127;
        firstHitFound = true;

        // Aplicar humanização ±5 nos hits ativos
        let hum = Math.floor(this.randomUnit() * 11) - 5;
        track.pattern[i] = clamp(baseVelocity + hum, 1, 127);
      } else {
        // Em tracks SNARE (1), HATS (2) e CRASH (3), injetar ghost notes
        // em steps vazios usando a probabilidade global (ghostNotesProb) e velocity 20..34
        if (trackIndex >= 1 && trackIndex <= 3 && this.ghostNotesProb > 0) {
          if (this.randomUnit() < this.ghostNotesProb) {
            let ghostVelocity = 20 + Math.floor(this.randomUnit() * 15);
            track.pattern[i] = clamp(ghostVelocity, 1, 127);
          }
        }
      }
    }
  }

  randomize() {
    for (let i = 0; i < TRACK_COUNT; i += 1) {
      const variation = Math.floor(this.randomUnit() * 5) - 2;
      this.tracks[i].hits = clamp(this.tracks[i].hits + variation, 0, this.tracks[i].steps);
      this.tracks[i].rotationOffset = Math.floor(this.randomUnit() * Math.max(1, this.tracks[i].steps));
      this.recalculatePattern(i);
    }
  }

  serializeState() {
    return JSON.stringify(
      {
        bpm: this.bpm,
        autoRotateDownbeat: this.autoRotateDownbeat,
        ghostNotesProb: this.ghostNotesProb,
        globalRoot: this.globalRoot,
        globalScale: this.globalScale,
        masterVolume: this.masterVolume,
        seed: this.seed,
        rngState: this.rngState,
        activeTrack: this.activeTrack,
        currentStep: this.currentStep,
        bass: this.bassGroove.cloneParams(),
        voiceParams: normalizeVoiceParamsList(this.voiceParams),
        trackMutes: this.trackMutes,
        tracks: this.tracks.map((track) => ({
          steps: track.steps,
          hits: track.hits,
          rotationOffset: track.rotationOffset,
        })),
      },
      null,
      2,
    );
  }

  importState(jsonText) {
    const parsed = JSON.parse(jsonText);
    this.bpm = clamp(Number(parsed.bpm ?? this.bpm), 40, 240);
    this.autoRotateDownbeat = Boolean(parsed.autoRotateDownbeat);
    this.ghostNotesProb = clamp(Number(parsed.ghostNotesProb ?? this.ghostNotesProb ?? 0.15), 0, 1.0);
    this.globalRoot = clamp(Number(parsed.globalRoot ?? this.globalRoot), 0, 11);
    this.globalScale = clamp(Number(parsed.globalScale ?? this.globalScale), 0, 3);
    this.masterVolume = clamp(Number(parsed.masterVolume ?? this.masterVolume), 0, 1);
    this.activeTrack = clamp(Number(parsed.activeTrack ?? this.activeTrack), 0, TRACK_COUNT - 1);
    if (parsed.seed !== undefined) this.setSeed(parsed.seed);
    if (parsed.rngState !== undefined) this.rngState = (Number(parsed.rngState) >>> 0) || this.seed;
    if (Array.isArray(parsed.voiceParams) && parsed.voiceParams.length === TRACK_COUNT) {
      this.voiceParams = normalizeVoiceParamsList(parsed.voiceParams);
    }
    if (Array.isArray(parsed.trackMutes) && parsed.trackMutes.length === TRACK_COUNT) {
      this.trackMutes = parsed.trackMutes.map(Boolean);
    }
    if (Array.isArray(parsed.tracks) && parsed.tracks.length === TRACK_COUNT) {
      this.tracks = parsed.tracks.map((track) => this.createTrack(track.steps, track.hits));
      this.tracks.forEach((track, index) => {
        track.rotationOffset = Number(parsed.tracks[index].rotationOffset ?? 0);
        this.recalculatePattern(index);
      });
    }
    if (parsed.bass) {
      this.bassGroove.updateParams(parsed.bass);
      this.syncGlobalsFromBass();
    } else {
      this.syncBassFromGlobals();
    }
    this.currentStep = Math.max(0, Math.floor(Number(parsed.currentStep ?? 0)));
    this.lastBeatStep = -1;
    this.lastTickEvents = [];
    this.eventLog = [];
    this.audio.ensureStarted();
    this.audio.setVoiceParams(this.voiceParams);
    this.audio.setMaster(this.masterVolume);
    this.restartScheduler();
  }

  patternStrings() {
    return this.tracks.map((track, index) => {
      const cells = [];
      for (let i = 0; i < track.patternLen; i += 1) {
        const value = track.pattern[i];
        if (value >= 110) cells.push("X");
        else if (value > 40) cells.push("x");
        else if (value > 0) cells.push("g"); // Ghost
        else cells.push(".");
      }
      return `${TRACK_NAMES[index].padEnd(5, " ")} st:${String(track.patternLen).padStart(2, "0")} ht:${String(track.hits).padStart(2, "0")} rt:${String(track.rotationOffset).padStart(2, "0")} | ${cells.join("")}`;
    });
  }

  pushEventLog(step, events) {
    const entry = {
      step,
      events,
      bass: this.bassGroove.lastDebug,
    };
    this.eventLog.unshift(entry);
    this.eventLog = this.eventLog.slice(0, 12);
    this.lastTickEvents = events;
  }

  stepOnce() {
    this.audio.ensureStarted();
    this.tick();
  }

  setPlaying(next) {
    this.audio.ensureStarted();
    this.isPlaying = next;
    if (!next) this.audio.stopAll();
    this.restartScheduler();
  }

  restartScheduler() {
    if (this.scheduler) {
      clearInterval(this.scheduler);
      this.scheduler = null;
    }
    if (!this.isPlaying) return;
    const stepMs = 60000 / (this.bpm * 4);
    this.scheduler = setInterval(() => this.tick(), stepMs);
  }

  tick(offlineTime = null) {
    const stepMs = 60000 / (this.bpm * 4);

    // We only process timing ms offline if it's passed explicitly
    if (offlineTime === null) {
      this.bassGroove.process(stepMs);
    }
    const step = this.currentStep;

    if (offlineTime === null) {
      this.bassVoiceHoldMs = Math.max(0, this.bassVoiceHoldMs - stepMs);
    }
    let bassIsActive = this.bassVoiceHoldMs > 0;
    const events = [];
    const rhythm = {
      kick: false,
      snare: false,
      hatClosed: false,
      hatOpen: false,
      kickVelocity: 0,
      snareVelocity: 0,
      hatClosedVelocity: 0,
      hatOpenVelocity: 0,
    };

    for (let i = 0; i < TRACK_COUNT; i += 1) {
      const track = this.tracks[i];
      if (track.patternLen <= 0 || this.trackMutes[i]) continue;
      const value = track.pattern[step % track.patternLen];
      if (value <= 0) continue;

      const velocity = value === 1 ? 0.9 : value / 127;
      const accent = value >= 110;
      const ghost = value > 0 && value < 40;

      const event = {
        velocity,
        accent,
        ghost,
        rawValue: value,
        trackIndex: i
      };

      if (i === 0) {
        this.bassGroove.onKick();
        rhythm.kick = true;
        rhythm.kickVelocity = velocity;
      }
      if (i === 1) {
        rhythm.snare = true;
        rhythm.snareVelocity = velocity;
      }
      if (i === 2) {
        rhythm.hatClosed = true;
        rhythm.hatClosedVelocity = velocity;
      }
      if (i === 3) {
        rhythm.hatOpen = true;
        rhythm.hatOpenVelocity = velocity;
      }
      if (i !== VOICE_BASS) {
        this.audio.trigger(i, event, null, offlineTime);
        const typeStr = accent ? "[ACCENT]" : (ghost ? "[GHOST]" : "[HIT]");
        events.push(`${TRACK_NAMES[i]} ${typeStr}:${velocity.toFixed(2)}`);
      }
    }

    if (!this.trackMutes[VOICE_BASS]) {
      const bassEvent = this.bassGroove.onTick(step, bassIsActive, rhythm);
      if (bassEvent) {
        this.audio.trigger(VOICE_BASS, bassEvent, bassEvent, offlineTime);
        bassIsActive = true;
        this.bassVoiceHoldMs = bassEvent.gateMs ?? (120 + this.voiceParams[VOICE_BASS].decay * 420);
        const bassTypeStr = bassEvent.accent ? "[ACCENT]" : "[HIT]";
        events.push(`BASS ${bassTypeStr}:${noteName(bassEvent.note)}:${bassEvent.velocity.toFixed(2)}${bassEvent.slide ? ":slide" : ""}`);
      }
    }

    if (offlineTime === null) {
      this.pushEventLog(step, events);
    }
    this.currentStep += 1;
    if (offlineTime === null && this.currentStep !== this.lastBeatStep) {
      this.pulseScale = 1.4;
      this.lastBeatStep = this.currentStep;
    }
  }

  async exportWAV() {
    const stepMs = 60000 / (this.bpm * 4);
    const patternSteps = 64; // Export 4 bars (64 steps)
    const durationMs = stepMs * patternSteps;
    const durationSec = durationMs / 1000;

    const sampleRate = 44100;
    const offlineCtx = new window.OfflineAudioContext(2, sampleRate * durationSec, sampleRate);

    // Create completely isolated simulation instance for export
    const offlineSim = new PenosaDesktopSim();
    offlineSim.importState(this.serializeState()); // Clone current setup

    offlineSim.audio.ctx = offlineCtx;
    offlineSim.audio.master = offlineCtx.createGain();
    offlineSim.audio.master.gain.value = this.masterVolume;

    const comp = offlineCtx.createDynamicsCompressor();
    comp.threshold.value = -16;
    comp.knee.value = 12;
    comp.ratio.value = 3;
    comp.attack.value = 0.003;
    comp.release.value = 0.12;
    offlineSim.audio.master.connect(comp);
    comp.connect(offlineCtx.destination);

    // Create new bass node for offline
    offlineSim.audio.bass = offlineSim.audio.createBassVoice();
    offlineSim.audio.setVoiceParams(this.voiceParams);

    // Start with deterministic seeds and step 0
    offlineSim.setSeed(this.seed);
    offlineSim.currentStep = 0;
    offlineSim.bassVoiceHoldMs = 0;

    // Schedule ticks isolated from main app
    for (let s = 0; s < patternSteps; s++) {
      const time = s * (stepMs / 1000);
      offlineSim.bassGroove.process(stepMs);
      offlineSim.tick(time);
    }

    // Render
    const renderedBuffer = await offlineCtx.startRendering();

    // Convert to WAV
    const wavBlob = this.audioBufferToWav(renderedBuffer);
    const url = URL.createObjectURL(wavBlob);

    const a = document.createElement("a");
    a.href = url;
    a.download = "penosa-export.wav";
    a.click();

    URL.revokeObjectURL(url);

    // Cleanup isolated instances
    try { offlineSim.audio.stopAll(); } catch(e){}
  }

  audioBufferToWav(buffer) {
    const numChannels = buffer.numberOfChannels;
    const sampleRate = buffer.sampleRate;
    const format = 1; // PCM
    const bitDepth = 16;

    const result = new Float32Array(buffer.length * numChannels);
    for (let channel = 0; channel < numChannels; channel++) {
      const channelData = buffer.getChannelData(channel);
      for (let i = 0; i < buffer.length; i++) {
        result[i * numChannels + channel] = channelData[i];
      }
    }

    const dataLength = result.length * (bitDepth / 8);
    const bufferArray = new ArrayBuffer(44 + dataLength);
    const view = new DataView(bufferArray);

    // RIFF chunk descriptor
    this.writeString(view, 0, "RIFF");
    view.setUint32(4, 36 + dataLength, true);
    this.writeString(view, 8, "WAVE");

    // fmt sub-chunk
    this.writeString(view, 12, "fmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, format, true);
    view.setUint16(22, numChannels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * numChannels * (bitDepth / 8), true);
    view.setUint16(32, numChannels * (bitDepth / 8), true);
    view.setUint16(34, bitDepth, true);

    // data sub-chunk
    this.writeString(view, 36, "data");
    view.setUint32(40, dataLength, true);

    // write PCM samples
    let offset = 44;
    for (let i = 0; i < result.length; i++) {
      const sample = Math.max(-1, Math.min(1, result[i]));
      view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7FFF, true);
      offset += 2;
    }

    return new Blob([view], { type: "audio/wav" });
  }

  writeString(view, offset, string) {
    for (let i = 0; i < string.length; i++) {
      view.setUint8(offset + i, string.charCodeAt(i));
    }
  }

  exportMIDI() {
    const patternSteps = 64; // 4 bars
    const ticksPerBeat = 96;
    const ticksPerStep = ticksPerBeat / 4; // 16th notes = 24 ticks
    const drumChannel = 9; // 0-indexed channel 10
    const bassChannel = 0; // 0-indexed channel 1

    // Drum Map: Kick=36, Snare=38, HatClosed=42, HatOpen=46
    const drumNotes = [36, 38, 42, 46];

    // Create completely isolated simulation instance for export
    const offlineSim = new PenosaDesktopSim();
    offlineSim.importState(this.serializeState()); // Clone current setup

    offlineSim.setSeed(this.seed);
    offlineSim.currentStep = 0;
    offlineSim.bassVoiceHoldMs = 0;

    let bassEvents = [];
    let drumEvents = [];

    let pendingBassNoteOff = null;

    for (let s = 0; s < patternSteps; s++) {
      const stepMs = 60000 / (offlineSim.bpm * 4); // Keep for RNG calls
      offlineSim.bassGroove.process(stepMs);

      const rhythm = {
        kick: false,
        snare: false,
        hatClosed: false,
        hatOpen: false,
        kickVelocity: 0,
        snareVelocity: 0,
        hatClosedVelocity: 0,
        hatOpenVelocity: 0,
      };

      let bassIsActive = false; // We ignore actual time here, just use RNG state

      for (let i = 0; i < TRACK_COUNT; i += 1) {
        const track = offlineSim.tracks[i];
        if (track.patternLen <= 0 || offlineSim.trackMutes[i]) continue;
        const value = track.pattern[s % track.patternLen];
        if (value <= 0) continue;
        const velocity = value === 1 ? 0.9 : value / 127;

        if (i === 0) {
          offlineSim.bassGroove.onKick();
          rhythm.kick = true;
          rhythm.kickVelocity = velocity;
        } else if (i === 1) {
          rhythm.snare = true;
          rhythm.snareVelocity = velocity;
        } else if (i === 2) {
          rhythm.hatClosed = true;
          rhythm.hatClosedVelocity = velocity;
        } else if (i === 3) {
          rhythm.hatOpen = true;
          rhythm.hatOpenVelocity = velocity;
        }

        if (i < 4) {
          const midiVel = Math.round(velocity * 127);
          drumEvents.push({ type: 'noteOn', tick: s * ticksPerStep, channel: drumChannel, note: drumNotes[i], velocity: midiVel });
          drumEvents.push({ type: 'noteOff', tick: s * ticksPerStep + (ticksPerStep - 2), channel: drumChannel, note: drumNotes[i], velocity: 0 });
        }
      }

      if (!offlineSim.trackMutes[VOICE_BASS]) {
        const bassEvent = offlineSim.bassGroove.onTick(s, bassIsActive, rhythm);
        if (bassEvent) {
          if (pendingBassNoteOff) {
            // Note off before note on if sliding
            pendingBassNoteOff.tick = s * ticksPerStep - (bassEvent.slide ? 0 : 2);
            bassEvents.push(pendingBassNoteOff);
          }
          const midiVel = Math.round(bassEvent.velocity * 127);
          bassEvents.push({ type: 'noteOn', tick: s * ticksPerStep, channel: bassChannel, note: bassEvent.note, velocity: midiVel });

          const gateTicks = Math.round((bassEvent.gateMs / stepMs) * ticksPerStep);
          pendingBassNoteOff = { type: 'noteOff', tick: s * ticksPerStep + gateTicks, channel: bassChannel, note: bassEvent.note, velocity: 0 };
        }
      }
      offlineSim.currentStep += 1;
    }

    if (pendingBassNoteOff) {
      bassEvents.push(pendingBassNoteOff);
    }

    const serializeTrack = (events, trackName) => {
      events.sort((a, b) => a.tick - b.tick);

      const trackData = [];

      // Track Name Meta Event
      trackData.push(0x00, 0xFF, 0x03, trackName.length, ...[...trackName].map(c => c.charCodeAt(0)));

      let lastTick = 0;
      for (const ev of events) {
        let delta = Math.max(0, ev.tick - lastTick);
        lastTick = ev.tick;

        // Write Variable Length Quantity (VLQ)
        const vlq = [];
        let buffer = delta & 0x7F;
        while ((delta >>= 7) > 0) {
          buffer <<= 8;
          buffer |= (delta & 0x7F) | 0x80;
        }
        while (true) {
          vlq.push(buffer & 0xFF);
          if (buffer & 0x80) buffer >>= 8;
          else break;
        }
        trackData.push(...vlq);

        if (ev.type === 'noteOn') {
          trackData.push(0x90 | ev.channel, ev.note, ev.velocity);
        } else if (ev.type === 'noteOff') {
          trackData.push(0x80 | ev.channel, ev.note, ev.velocity);
        }
      }
      // End of Track
      trackData.push(0x00, 0xFF, 0x2F, 0x00);
      return trackData;
    };

    const header = [
      0x4D, 0x54, 0x68, 0x64, // MThd
      0x00, 0x00, 0x00, 0x06, // Header size
      0x00, 0x01,             // Format 1 (multi-track)
      0x00, 0x03,             // 3 tracks (Tempo, Drums, Bass)
      (ticksPerBeat >> 8) & 0xFF, ticksPerBeat & 0xFF // Resolution
    ];

    const tempoTrack = [
      0x00, 0xFF, 0x03, 0x0C, ...[..."Tempo & Time"].map(c => c.charCodeAt(0)), // Name
      0x00, 0xFF, 0x58, 0x04, 0x04, 0x02, 0x18, 0x08, // Time Signature 4/4
      0x00, 0xFF, 0x51, 0x03, ...[0,0,0].map((_, i) => (Math.round(60000000 / this.bpm) >> ((2 - i) * 8)) & 0xFF), // Tempo
      0x00, 0xFF, 0x2F, 0x00 // End of track
    ];

    const drumTrackData = serializeTrack(drumEvents, "Penosa Drums");
    const bassTrackData = serializeTrack(bassEvents, "Penosa Bass");

    const writeTrackChunk = (data) => {
      const len = data.length;
      return [0x4D, 0x54, 0x72, 0x6B, (len >> 24) & 0xFF, (len >> 16) & 0xFF, (len >> 8) & 0xFF, len & 0xFF, ...data];
    };

    const midiData = new Uint8Array([
      ...header,
      ...writeTrackChunk(tempoTrack),
      ...writeTrackChunk(drumTrackData),
      ...writeTrackChunk(bassTrackData)
    ]);

    const blob = new Blob([midiData], { type: "audio/midi" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "penosa-export.mid";
    a.click();
    URL.revokeObjectURL(url);
  }
}

const sim = new PenosaDesktopSim();
const canvas = document.getElementById("tft");
const ctx = canvas.getContext("2d");
ctx.imageSmoothingEnabled = false;

function drawText(x, y, text, color, size = 1, align = "left") {
  ctx.fillStyle = color;
  ctx.font = `${size * 8 * CANVAS_SCALE}px Consolas, monospace`;
  ctx.textAlign = align;
  ctx.textBaseline = "top";
  ctx.fillText(text, x * CANVAS_SCALE, y * CANVAS_SCALE);
}

function fillCircle(x, y, radius, color) {
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(x * CANVAS_SCALE, y * CANVAS_SCALE, radius * CANVAS_SCALE, 0, Math.PI * 2);
  ctx.fill();
}

function strokeCircle(x, y, radius, color, width = 1) {
  ctx.strokeStyle = color;
  ctx.lineWidth = width * CANVAS_SCALE;
  ctx.beginPath();
  ctx.arc(x * CANVAS_SCALE, y * CANVAS_SCALE, radius * CANVAS_SCALE, 0, Math.PI * 2);
  ctx.stroke();
}

function drawPixel(x, y, color) {
  ctx.fillStyle = color;
  ctx.fillRect(x * CANVAS_SCALE, y * CANVAS_SCALE, CANVAS_SCALE, CANVAS_SCALE);
}

function drawHeader() {
  ctx.fillStyle = COLORS.bg;
  ctx.fillRect(0, 0, canvas.width, 28 * CANVAS_SCALE);
  drawText(6, 6, "BPM", COLORS.dim, 2);
  drawText(50, 6, String(sim.bpm), COLORS.cyan, 2);

  if (sim.isPlaying) {
    ctx.fillStyle = COLORS.green;
    ctx.beginPath();
    ctx.moveTo(220 * CANVAS_SCALE, 8 * CANVAS_SCALE);
    ctx.lineTo(220 * CANVAS_SCALE, 22 * CANVAS_SCALE);
    ctx.lineTo(235 * CANVAS_SCALE, 15 * CANVAS_SCALE);
    ctx.closePath();
    ctx.fill();
  } else {
    ctx.fillStyle = COLORS.red;
    ctx.fillRect(220 * CANVAS_SCALE, 8 * CANVAS_SCALE, 14 * CANVAS_SCALE, 14 * CANVAS_SCALE);
  }
}

function drawPerformanceView() {
  if (sim.activeTrack === VOICE_BASS) {
    drawBassView();
    return;
  }

  const track = sim.tracks[sim.activeTrack];
  ctx.fillStyle = COLORS.bg;
  ctx.fillRect(0, 25 * CANVAS_SCALE, 120 * CANVAS_SCALE, 110 * CANVAS_SCALE);

  drawText(2, 40, ">", COLORS.green, 2);
  drawText(14, 40, "Stp:", COLORS.green, 2);
  drawText(62, 40, String(track.steps), COLORS.green, 2);
  drawText(2, 62, ">", COLORS.green, 2);
  drawText(14, 62, "Hit:", COLORS.green, 2);
  drawText(62, 62, String(track.hits), COLORS.green, 2);
  drawText(2, 84, ">", COLORS.green, 2);
  drawText(14, 84, "Rot:", COLORS.green, 2);
  drawText(62, 84, String(track.rotationOffset), COLORS.green, 2);
  drawText(14, 108, TRACK_NAMES[sim.activeTrack], sim.trackColors[sim.activeTrack], 2);
  if (sim.trackMutes[sim.activeTrack]) drawText(2, 124, "MUTE", COLORS.red, 2);

  ctx.fillStyle = COLORS.bg;
  ctx.fillRect(105 * CANVAS_SCALE, 25 * CANVAS_SCALE, 135 * CANVAS_SCALE, 110 * CANVAS_SCALE);

  const cx = 170;
  const cy = 70;
  for (let t = 0; t < TRACK_COUNT; t += 1) {
    if (t === VOICE_BASS) continue;
    const len = sim.tracks[t].patternLen;
    if (!len) continue;
    const radius = 45 - t * 9;
    for (let i = 0; i < len; i += 1) {
      const angle = (i * ((Math.PI * 2) / len)) - Math.PI / 2;
      const px = cx + Math.round(Math.cos(angle) * radius);
      const py = cy + Math.round(Math.sin(angle) * radius);
      const vel = sim.tracks[t].pattern[i];
      if (vel > 0) {
        fillCircle(px, py, t === sim.activeTrack ? 2 : 1, sim.trackColors[t]);
      } else if (t === sim.activeTrack) {
        drawPixel(px, py, COLORS.dim);
      }
    }
  }

  const progressAngle = ((sim.currentStep % 16) / 16) * Math.PI * 2 - Math.PI / 2;
  fillCircle(cx, cy, 2, COLORS.dim);
  fillCircle(cx + Math.round(Math.cos(progressAngle) * 6), cy + Math.round(Math.sin(progressAngle) * 6), 2, COLORS.text);

  const currentBeat = Math.floor(sim.currentStep / 4) % 4;
  if (sim.pulseScale > 1) sim.pulseScale = Math.max(1, sim.pulseScale - 0.08);

  for (let i = 0; i < 4; i += 1) {
    const angle = i * (Math.PI / 2) - Math.PI / 2;
    const bx = cx + Math.round(Math.cos(angle) * 60);
    const by = cy + Math.round(Math.sin(angle) * 60);
    if (sim.isPlaying && i === currentBeat) {
      const pulse = Math.round(4 * sim.pulseScale);
      if (sim.pulseScale > 1.1) strokeCircle(bx, by, pulse + 2, COLORS.green, 1);
      fillCircle(bx, by, pulse, COLORS.green);
    } else {
      strokeCircle(bx, by, 2, COLORS.dim, 1);
    }
  }
}

function drawBassView() {
  const bass = sim.bassGroove.cloneParams();
  ctx.fillStyle = COLORS.bg;
  ctx.fillRect(0, 25 * CANVAS_SCALE, canvas.width, 110 * CANVAS_SCALE);
  drawText(6, 40, ">", COLORS.green, 2);
  drawText(18, 45, "Dens:", COLORS.green, 1);
  drawText(66, 40, String(Math.round(bass.density * 100)), COLORS.green, 2);
  drawText(102, 40, "%", COLORS.green, 2);
  drawText(6, 62, ">", COLORS.green, 2);
  drawText(18, 67, "Rnge:", COLORS.green, 1);
  drawText(66, 62, String(bass.range), COLORS.green, 2);
  drawText(120, 40, ">", COLORS.green, 2);
  drawText(132, 45, "Scl:", COLORS.green, 1);
  drawText(178, 40, ["MIN", "MAJ", "DOR", "PHR"][bass.scaleType], COLORS.green, 2);
  drawText(120, 62, ">", COLORS.green, 2);
  drawText(132, 67, "Root:", COLORS.green, 1);
  drawText(178, 62, noteName(bass.rootNote), COLORS.green, 2);
  drawText(18, 108, "BASS", COLORS.track[4], 2);
  if (sim.trackMutes[VOICE_BASS]) drawText(160, 108, "MUTE", COLORS.red, 2);
}

function render() {
  ctx.fillStyle = COLORS.bg;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  drawHeader();
  drawPerformanceView();
  requestAnimationFrame(render);
}

function renderUiPage() {
  document.querySelectorAll(".page-panel").forEach((panel) => {
    panel.classList.toggle("active", panel.dataset.page === uiPage);
  });
  document.querySelectorAll(".mode-btn").forEach((button) => {
    button.classList.toggle("active", button.dataset.page === uiPage);
  });
}

function isControlVisible(control) {
  if (!control) return false;
  if (control.disabled) return false;
  if (control.offsetParent === null) return false;
  return true;
}

function getPageControls(page) {
  const controlMap = {
    performance: ["playToggle", "stepBtn", "randomizeBtn", "panicBtn", "bpm", "autoRotate", "ghostNotes", "master"],
    track: ["steps", "hits", "rotation", ...TRACK_NAMES.map((_, index) => `track-btn-${index}`), ...TRACK_NAMES.map((_, index) => `mute-btn-${index}`)],
    bass: ["density", "bassProb", "range", "scale", "root"],
    voice: [
      "kickTune",
      "kickLength",
      "kickPunch",
      "kickDrive",
      "snareTone",
      "snareDecay",
      "snareTimbre",
      "snareMode",
      "hatDecay",
      "hatTimbre",
      "bassRelease",
      "bassBrightness",
      "bassHarmonics",
      "bassDrive",
      "bassSnap",
    ],
    slots: [...sim.slots.map((_, index) => `slot-btn-${index}`), "saveSlotBtn", "resetSlotsBtn"],
    lab: ["seedInput", "applySeedBtn", "exportStateBtn", "importStateBtn", "exportWavBtn", "exportMidiBtn"],
  };

  return (controlMap[page] || [])
    .map((id) => {
      if (id.startsWith("track-btn-")) return document.querySelectorAll(".track-btn")[Number(id.split("-").pop())];
      if (id.startsWith("mute-btn-")) return document.querySelectorAll(".mute-btn")[Number(id.split("-").pop())];
      if (id.startsWith("slot-btn-")) return document.querySelectorAll(".slot-btn")[Number(id.split("-").pop())];
      return document.getElementById(id);
    })
    .filter(isControlVisible);
}

function updateFooterHints() {
  const pageHint = document.getElementById("pageInputHint");
  if (pageHint) pageHint.textContent = PAGE_HINTS[uiPage] || PAGE_HINTS.performance;
}

function updateKeyboardSelectionVisual() {
  document.querySelectorAll(".kbd-selected").forEach((element) => element.classList.remove("kbd-selected"));
  const controls = getPageControls(uiPage);
  if (!controls.length) return;
  const nextIndex = clamp(pageSelectionIndex[uiPage] ?? 0, 0, controls.length - 1);
  pageSelectionIndex[uiPage] = nextIndex;
  controls[nextIndex].classList.add("kbd-selected");
}

function selectControlOffset(offset) {
  const controls = getPageControls(uiPage);
  if (!controls.length) return false;
  const current = clamp(pageSelectionIndex[uiPage] ?? 0, 0, controls.length - 1);
  const next = (current + offset + controls.length) % controls.length;
  pageSelectionIndex[uiPage] = next;
  updateKeyboardSelectionVisual();
  controls[next].focus({ preventScroll: true });
  return true;
}

function adjustControl(control, direction) {
  if (!control) return false;
  if (control.tagName === "INPUT" && control.type === "range") {
    const step = Number(control.step || 1);
    const min = Number(control.min ?? 0);
    const max = Number(control.max ?? 100);
    const nextValue = clamp(Number(control.value) + (direction * step), min, max);
    if (nextValue === Number(control.value)) return false;
    control.value = String(nextValue);
    control.dispatchEvent(new Event("input", { bubbles: true }));
    control.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  }
  if (control.tagName === "SELECT") {
    const nextIndex = clamp(control.selectedIndex + direction, 0, control.options.length - 1);
    if (nextIndex === control.selectedIndex) return false;
    control.selectedIndex = nextIndex;
    control.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  }
  if (control.tagName === "INPUT" && control.type === "number") {
    const step = Number(control.step || 1);
    const min = Number(control.min ?? 0);
    const max = Number(control.max ?? Number.MAX_SAFE_INTEGER);
    const nextValue = clamp(Number(control.value) + (direction * step), min, max);
    control.value = String(Math.round(nextValue));
    control.dispatchEvent(new Event("input", { bubbles: true }));
    control.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  }
  if (control.tagName === "INPUT" && control.type === "checkbox") {
    control.checked = !control.checked;
    control.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  }
  return false;
}

function confirmControl(control) {
  if (!control) return false;
  if (control.tagName === "INPUT" && control.type === "checkbox") {
    control.checked = !control.checked;
    control.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  }
  control.click();
  return true;
}

function setUiPage(nextPage) {
  if (!UI_PAGES.includes(nextPage)) return;
  uiPage = nextPage;
  if (typeof pageSelectionIndex[uiPage] !== "number") pageSelectionIndex[uiPage] = 0;
  renderUiPage();
  updateFooterHints();
  updateKeyboardSelectionVisual();
}

const inputMap = {
  performance: {
    select: (direction) => selectControlOffset(direction),
    increment: () => {
      const controls = getPageControls("performance");
      return adjustControl(controls[pageSelectionIndex.performance ?? 0], 1);
    },
    decrement: () => {
      const controls = getPageControls("performance");
      return adjustControl(controls[pageSelectionIndex.performance ?? 0], -1);
    },
    confirm: () => {
      const controls = getPageControls("performance");
      return confirmControl(controls[pageSelectionIndex.performance ?? 0]);
    },
    back: () => false,
  },
  track: {
    select: (direction) => selectControlOffset(direction),
    increment: () => adjustControl(getPageControls("track")[pageSelectionIndex.track ?? 0], 1),
    decrement: () => adjustControl(getPageControls("track")[pageSelectionIndex.track ?? 0], -1),
    confirm: () => confirmControl(getPageControls("track")[pageSelectionIndex.track ?? 0]),
    back: () => {
      setUiPage("performance");
      updateUi();
      return true;
    },
  },
  bass: {
    select: (direction) => selectControlOffset(direction),
    increment: () => adjustControl(getPageControls("bass")[pageSelectionIndex.bass ?? 0], 1),
    decrement: () => adjustControl(getPageControls("bass")[pageSelectionIndex.bass ?? 0], -1),
    confirm: () => confirmControl(getPageControls("bass")[pageSelectionIndex.bass ?? 0]),
    back: () => {
      setUiPage("performance");
      updateUi();
      return true;
    },
  },
  voice: {
    select: (direction) => selectControlOffset(direction),
    increment: () => adjustControl(getPageControls("voice")[pageSelectionIndex.voice ?? 0], 1),
    decrement: () => adjustControl(getPageControls("voice")[pageSelectionIndex.voice ?? 0], -1),
    confirm: () => confirmControl(getPageControls("voice")[pageSelectionIndex.voice ?? 0]),
    back: () => {
      setUiPage("track");
      updateUi();
      return true;
    },
  },
  slots: {
    select: (direction) => selectControlOffset(direction),
    increment: () => adjustControl(getPageControls("slots")[pageSelectionIndex.slots ?? 0], 1),
    decrement: () => adjustControl(getPageControls("slots")[pageSelectionIndex.slots ?? 0], -1),
    confirm: () => confirmControl(getPageControls("slots")[pageSelectionIndex.slots ?? 0]),
    back: () => {
      setUiPage("performance");
      updateUi();
      return true;
    },
  },
  lab: {
    select: (direction) => selectControlOffset(direction),
    increment: () => adjustControl(getPageControls("lab")[pageSelectionIndex.lab ?? 0], 1),
    decrement: () => adjustControl(getPageControls("lab")[pageSelectionIndex.lab ?? 0], -1),
    confirm: () => confirmControl(getPageControls("lab")[pageSelectionIndex.lab ?? 0]),
    back: () => {
      setUiPage("performance");
      updateUi();
      return true;
    },
  },
};

function updateUi() {
  document.getElementById("playToggle").textContent = sim.isPlaying ? "Stop" : "Play";
  document.getElementById("bpm").value = sim.bpm;
  document.getElementById("bpmValue").textContent = String(sim.bpm);
  document.getElementById("autoRotate").checked = sim.autoRotateDownbeat;
  document.getElementById("ghostNotes").value = Math.round(sim.ghostNotesProb * 100);
  document.getElementById("ghostNotesValue").textContent = `${Math.round(sim.ghostNotesProb * 100)}%`;
  document.getElementById("master").value = Math.round(sim.masterVolume * 100);
  document.getElementById("masterValue").textContent = `${Math.round(sim.masterVolume * 100)}%`;
  document.getElementById("seedInput").value = String(sim.seed >>> 0);

  document.querySelectorAll(".track-btn").forEach((button, index) => {
    button.classList.toggle("active", index === sim.activeTrack);
  });
  document.querySelectorAll(".mute-btn").forEach((button, index) => {
    button.classList.toggle("muted", sim.trackMutes[index]);
    button.textContent = sim.trackMutes[index] ? `${TRACK_NAMES[index]} OFF` : `${TRACK_NAMES[index]} ON`;
  });
  document.querySelectorAll(".slot-btn").forEach((button, index) => {
    button.classList.toggle("active", index === sim.currentSlot);
  });

  const drumEditor = document.getElementById("drumEditor");
  const kickVoiceEditor = document.getElementById("kickVoiceEditor");
  const snareVoiceEditor = document.getElementById("snareVoiceEditor");
  const hatVoiceEditor = document.getElementById("hatVoiceEditor");
  const bassVoiceEditor = document.getElementById("bassVoiceEditor");
  document.getElementById("editorTitle").textContent = `Edit ${TRACK_NAMES[sim.activeTrack]}`;

  const bass = sim.bassGroove.cloneParams();
  const bassVoice = sim.voiceParams[VOICE_BASS];
  document.getElementById("density").value = Math.round(bass.density * 100);
  document.getElementById("densityValue").textContent = `${Math.round(bass.density * 100)}%`;
  document.getElementById("bassProb").value = Math.round(bass.bassProb * 100);
  document.getElementById("bassProbValue").textContent = `${Math.round(bass.bassProb * 100)}%`;
  document.getElementById("range").value = bass.range;
  document.getElementById("rangeValue").textContent = String(bass.range);
  document.getElementById("scale").value = String(bass.scaleType);
  document.getElementById("root").value = bass.rootNote;
  document.getElementById("rootValue").textContent = noteName(bass.rootNote);
  document.getElementById("bassRelease").value = Math.round(bassVoice.decay * 100);
  document.getElementById("bassReleaseValue").textContent = `${Math.round(bassVoice.decay * 100)}%`;
  document.getElementById("bassBrightness").value = Math.round(bassVoice.timbre * 100);
  document.getElementById("bassBrightnessValue").textContent = `${Math.round(bassVoice.timbre * 100)}%`;
  document.getElementById("bassHarmonics").value = Math.round(bassVoice.harmonics * 100);
  document.getElementById("bassHarmonicsValue").textContent = `${Math.round(bassVoice.harmonics * 100)}%`;
  document.getElementById("bassDrive").value = Math.round(bassVoice.drive * 100);
  document.getElementById("bassDriveValue").textContent = `${Math.round(bassVoice.drive * 100)}%`;
  document.getElementById("bassSnap").value = Math.round(bassVoice.snap * 100);
  document.getElementById("bassSnapValue").textContent = `${Math.round(bassVoice.snap * 100)}%`;

  const isBassTrack = sim.activeTrack === VOICE_BASS;
  drumEditor.classList.toggle("hidden", isBassTrack);

  if (!isBassTrack) {
    const track = sim.tracks[sim.activeTrack];
    document.getElementById("steps").value = track.steps;
    document.getElementById("stepsValue").textContent = String(track.steps);
    document.getElementById("hits").value = track.hits;
    document.getElementById("hits").max = track.steps;
    document.getElementById("hitsValue").textContent = String(track.hits);
    document.getElementById("rotation").value = track.rotationOffset;
    document.getElementById("rotation").max = Math.max(0, track.steps - 1);
    document.getElementById("rotationValue").textContent = String(track.rotationOffset);
  }

  kickVoiceEditor.classList.toggle("hidden", sim.activeTrack !== 0);
  snareVoiceEditor.classList.toggle("hidden", sim.activeTrack !== 1);
  hatVoiceEditor.classList.toggle("hidden", sim.activeTrack !== 2 && sim.activeTrack !== 3);
  bassVoiceEditor.classList.toggle("hidden", !isBassTrack);

  if (sim.activeTrack === 0) {
    const voice = sim.voiceParams[0];
    document.getElementById("kickTune").value = Math.round(voice.pitch * 100);
    document.getElementById("kickTuneValue").textContent = `${Math.round(voice.pitch * 100)}%`;
    document.getElementById("kickLength").value = Math.round(voice.decay * 100);
    document.getElementById("kickLengthValue").textContent = `${Math.round(voice.decay * 100)}%`;
    document.getElementById("kickPunch").value = Math.round(voice.timbre * 100);
    document.getElementById("kickPunchValue").textContent = `${Math.round(voice.timbre * 100)}%`;
    document.getElementById("kickDrive").value = Math.round(voice.drive * 100);
    document.getElementById("kickDriveValue").textContent = `${Math.round(voice.drive * 100)}%`;
  } else if (sim.activeTrack === 1) {
    const voice = sim.voiceParams[1];
    document.getElementById("snareTone").value = Math.round(voice.pitch * 100);
    document.getElementById("snareToneValue").textContent = `${Math.round(voice.pitch * 100)}%`;
    document.getElementById("snareDecay").value = Math.round(voice.decay * 100);
    document.getElementById("snareDecayValue").textContent = `${Math.round(voice.decay * 100)}%`;
    document.getElementById("snareTimbre").value = Math.round(voice.timbre * 100);
    document.getElementById("snareTimbreValue").textContent = `${Math.round(voice.timbre * 100)}%`;
    document.getElementById("snareMode").value = String(voice.mode);
  } else if (sim.activeTrack === 2 || sim.activeTrack === 3) {
    const voice = sim.voiceParams[sim.activeTrack];
    document.getElementById("hatModeLabel").textContent = sim.activeTrack === 2 ? "Closed hat model" : "Open hat model";
    document.getElementById("hatDecay").value = Math.round(voice.decay * 100);
    document.getElementById("hatDecayValue").textContent = `${Math.round(voice.decay * 100)}%`;
    document.getElementById("hatTimbre").value = Math.round(voice.timbre * 100);
    document.getElementById("hatTimbreValue").textContent = `${Math.round(voice.timbre * 100)}%`;
  }

  const debug = sim.bassGroove.lastDebug;
  const recentEvents = sim.eventLog
    .slice(0, 6)
    .map((entry) => `s${String(entry.step).padStart(2, "0")}: ${entry.events.length ? entry.events.join(" | ") : "silence"}`)
    .join("\n");
  document.getElementById("debugSummary").textContent = [
    `clock step: ${sim.currentStep}`,
    `last tick: ${sim.lastTickEvents.length ? sim.lastTickEvents.join(" | ") : "silence"}`,
    "",
    "bass decision",
    `reason: ${debug.reason}`,
    `prob: ${Number.isFinite(debug.probability) ? debug.probability.toFixed(3) : "--"} | roll: ${Number.isFinite(debug.gateRoll) ? debug.gateRoll.toFixed(3) : "--"}`,
    `note: ${debug.note != null ? noteName(debug.note) : "--"} | vel: ${Number.isFinite(debug.velocity) ? debug.velocity.toFixed(2) : "--"} | slide: ${debug.slide ? "yes" : "no"}`,
    `drums: ${debug.drumMask || "----"} | energy: ${Number.isFinite(debug.rhythmEnergy) ? debug.rhythmEnergy.toFixed(2) : "--"} | voices: ${debug.activeCount ?? 0}`,
    `gate: ${Number.isFinite(debug.gateMs) ? Math.round(debug.gateMs) : 0}ms`,
    `degree: ${debug.degree} | octave: ${debug.octave} | rng: ${debug.rngState >>> 0}`,
    "",
    "recent events",
    recentEvents || "none yet",
  ].join("\n");
  document.getElementById("patternSummary").textContent = sim.patternStrings().join("\n");
  updateFooterHints();
  updateKeyboardSelectionVisual();
}

function bindUi() {
  const trackButtons = document.getElementById("trackButtons");
  const muteButtons = document.getElementById("muteButtons");
  const slotButtons = document.getElementById("slotButtons");

  document.querySelectorAll(".mode-btn").forEach((button) => {
    button.addEventListener("click", () => {
      setUiPage(button.dataset.page);
    });
  });

  TRACK_NAMES.forEach((name, index) => {
    const button = document.createElement("button");
    button.className = "track-btn";
    button.textContent = name;
    button.addEventListener("click", () => {
      sim.activeTrack = index;
      setUiPage("track");
      updateUi();
    });
    trackButtons.appendChild(button);

    const muteButton = document.createElement("button");
    muteButton.className = "mute-btn";
    muteButton.addEventListener("click", () => {
      sim.trackMutes[index] = !sim.trackMutes[index];
      updateUi();
    });
    muteButtons.appendChild(muteButton);
  });

  sim.slots.forEach((_, index) => {
    const button = document.createElement("button");
    button.className = "slot-btn";
    button.textContent = `Slot ${index + 1}`;
    button.addEventListener("click", () => {
      sim.loadSlot(index);
      updateUi();
    });
    slotButtons.appendChild(button);
  });

  document.getElementById("playToggle").addEventListener("click", () => {
    sim.audio.ensureStarted();
    sim.setPlaying(!sim.isPlaying);
    sim.audio.setMaster(sim.masterVolume);
    updateUi();
  });
  document.getElementById("stepBtn").addEventListener("click", () => {
    sim.stepOnce();
    updateUi();
  });
  document.getElementById("randomizeBtn").addEventListener("click", () => {
    sim.randomize();
    updateUi();
  });
  document.getElementById("panicBtn").addEventListener("click", () => sim.audio.stopAll());
  document.getElementById("saveSlotBtn").addEventListener("click", () => sim.saveCurrentSlot());
  document.getElementById("resetSlotsBtn").addEventListener("click", () => {
    sim.resetFactorySlots();
    updateUi();
  });

  document.getElementById("bpm").addEventListener("input", (event) => {
    sim.bpm = Number(event.target.value);
    sim.restartScheduler();
    updateUi();
  });
  document.getElementById("autoRotate").addEventListener("change", (event) => {
    sim.autoRotateDownbeat = event.target.checked;
    for (let i = 0; i < TRACK_COUNT; i += 1) sim.recalculatePattern(i);
    updateUi();
  });
  document.getElementById("ghostNotes").addEventListener("input", (event) => {
    sim.ghostNotesProb = Number(event.target.value) / 100;
    for (let i = 0; i < TRACK_COUNT; i += 1) sim.recalculatePattern(i);
    updateUi();
  });
  document.getElementById("master").addEventListener("input", (event) => {
    sim.masterVolume = Number(event.target.value) / 100;
    sim.audio.ensureStarted();
    sim.audio.setMaster(sim.masterVolume);
    updateUi();
  });

  document.getElementById("steps").addEventListener("input", (event) => {
    const track = sim.tracks[sim.activeTrack];
    track.steps = Number(event.target.value);
    track.hits = clamp(track.hits, 0, track.steps);
    track.rotationOffset = clamp(track.rotationOffset, 0, Math.max(0, track.steps - 1));
    sim.recalculatePattern(sim.activeTrack);
    updateUi();
  });
  document.getElementById("hits").addEventListener("input", (event) => {
    sim.tracks[sim.activeTrack].hits = Number(event.target.value);
    sim.recalculatePattern(sim.activeTrack);
    updateUi();
  });
  document.getElementById("rotation").addEventListener("input", (event) => {
    sim.tracks[sim.activeTrack].rotationOffset = Number(event.target.value);
    sim.recalculatePattern(sim.activeTrack);
    updateUi();
  });

  document.getElementById("density").addEventListener("input", (event) => {
    sim.bassGroove.updateParams({ density: Number(event.target.value) / 100 });
    updateUi();
  });
  document.getElementById("bassProb").addEventListener("input", (event) => {
    sim.bassGroove.updateParams({ bassProb: Number(event.target.value) / 100 });
    updateUi();
  });
  document.getElementById("range").addEventListener("input", (event) => {
    sim.bassGroove.updateParams({ range: Number(event.target.value) });
    updateUi();
  });
  document.getElementById("scale").addEventListener("change", (event) => {
    sim.bassGroove.updateParams({ scaleType: Number(event.target.value) });
    sim.syncGlobalsFromBass();
    updateUi();
  });
  document.getElementById("root").addEventListener("input", (event) => {
    sim.bassGroove.updateParams({ rootNote: Number(event.target.value) });
    sim.syncGlobalsFromBass();
    updateUi();
  });
  document.getElementById("kickTune").addEventListener("input", (event) => {
    sim.setVoiceParam(0, { pitch: Number(event.target.value) / 100 });
    updateUi();
  });
  document.getElementById("kickLength").addEventListener("input", (event) => {
    sim.setVoiceParam(0, { decay: Number(event.target.value) / 100 });
    updateUi();
  });
  document.getElementById("kickPunch").addEventListener("input", (event) => {
    sim.setVoiceParam(0, { timbre: Number(event.target.value) / 100 });
    updateUi();
  });
  document.getElementById("kickDrive").addEventListener("input", (event) => {
    sim.setVoiceParam(0, { drive: Number(event.target.value) / 100 });
    updateUi();
  });
  document.getElementById("snareTone").addEventListener("input", (event) => {
    sim.setVoiceParam(1, { pitch: Number(event.target.value) / 100 });
    updateUi();
  });
  document.getElementById("snareDecay").addEventListener("input", (event) => {
    sim.setVoiceParam(1, { decay: Number(event.target.value) / 100 });
    updateUi();
  });
  document.getElementById("snareTimbre").addEventListener("input", (event) => {
    sim.setVoiceParam(1, { timbre: Number(event.target.value) / 100 });
    updateUi();
  });
  document.getElementById("snareMode").addEventListener("change", (event) => {
    sim.setVoiceParam(1, { mode: Number(event.target.value) });
    updateUi();
  });
  document.getElementById("hatDecay").addEventListener("input", (event) => {
    sim.setVoiceParam(sim.activeTrack, { decay: Number(event.target.value) / 100 });
    updateUi();
  });
  document.getElementById("hatTimbre").addEventListener("input", (event) => {
    sim.setVoiceParam(sim.activeTrack, { timbre: Number(event.target.value) / 100 });
    updateUi();
  });
  document.getElementById("bassRelease").addEventListener("input", (event) => {
    sim.setVoiceParam(VOICE_BASS, { decay: Number(event.target.value) / 100 });
    updateUi();
  });
  document.getElementById("bassBrightness").addEventListener("input", (event) => {
    sim.setVoiceParam(VOICE_BASS, { timbre: Number(event.target.value) / 100 });
    updateUi();
  });
  document.getElementById("bassHarmonics").addEventListener("input", (event) => {
    sim.setVoiceParam(VOICE_BASS, { harmonics: Number(event.target.value) / 100 });
    updateUi();
  });
  document.getElementById("bassDrive").addEventListener("input", (event) => {
    sim.setVoiceParam(VOICE_BASS, { drive: Number(event.target.value) / 100 });
    updateUi();
  });
  document.getElementById("bassSnap").addEventListener("input", (event) => {
    sim.setVoiceParam(VOICE_BASS, { snap: Number(event.target.value) / 100 });
    updateUi();
  });
  document.getElementById("applySeedBtn").addEventListener("click", () => {
    sim.setSeed(document.getElementById("seedInput").value);
    updateUi();
  });
  document.getElementById("exportStateBtn").addEventListener("click", async () => {
    const dump = sim.serializeState();
    const textarea = document.getElementById("stateDump");
    textarea.value = dump;
    try {
      await navigator.clipboard.writeText(dump);
    } catch (_) {
      // Clipboard may be unavailable for file:// or older browsers.
    }
    updateUi();
  });
  document.getElementById("importStateBtn").addEventListener("click", () => {
    const dump = document.getElementById("stateDump").value.trim();
    if (!dump) return;
    try {
      sim.importState(dump);
      sim.audio.ensureStarted();
      sim.audio.setMaster(sim.masterVolume);
      updateUi();
    } catch (error) {
      window.alert(`JSON invalido: ${error.message}`);
    }
  });

  document.getElementById("exportWavBtn").addEventListener("click", async () => {
    const btn = document.getElementById("exportWavBtn");
    const origText = btn.textContent;
    btn.textContent = "Rendering...";
    btn.disabled = true;
    try {
      await sim.exportWAV();
    } catch (error) {
      window.alert(`Erro ao exportar WAV: ${error.message}`);
      console.error(error);
    } finally {
      btn.textContent = origText;
      btn.disabled = false;
    }
  });

  document.getElementById("exportMidiBtn").addEventListener("click", () => {
    try {
      sim.exportMIDI();
    } catch (error) {
      window.alert(`Erro ao exportar MIDI: ${error.message}`);
      console.error(error);
    }
  });

  document.addEventListener("focusin", (event) => {
    const controls = getPageControls(uiPage);
    const focusedIndex = controls.indexOf(event.target);
    if (focusedIndex >= 0) {
      pageSelectionIndex[uiPage] = focusedIndex;
      updateKeyboardSelectionVisual();
    }
  });

  window.addEventListener("keydown", (event) => {
    const target = event.target;
    const isFocusedMappedControl = target && getPageControls(uiPage).includes(target);
    const isTypingField =
      target &&
      ((target.tagName === "TEXTAREA") ||
        (target.tagName === "INPUT" && !["range", "checkbox", "button"].includes(target.type)));
    if (isTypingField && !isFocusedMappedControl && !["Escape"].includes(event.key)) return;

    if (event.code === "Space") {
      event.preventDefault();
      sim.audio.ensureStarted();
      sim.setPlaying(!sim.isPlaying);
      updateUi();
      return;
    }
    if (event.code === "ArrowRight" && !sim.isPlaying) {
      event.preventDefault();
      sim.stepOnce();
      updateUi();
      return;
    }

    const context = inputMap[uiPage];
    if (context) {
      if (event.code === "ArrowUp" || event.code === "ArrowLeft") {
        event.preventDefault();
        context.select(-1);
        return;
      }
      if (event.code === "ArrowDown") {
        event.preventDefault();
        context.select(1);
        return;
      }
      if (event.key.toLowerCase() === "a") {
        event.preventDefault();
        context.decrement();
        updateUi();
        return;
      }
      if (event.key.toLowerCase() === "d") {
        event.preventDefault();
        context.increment();
        updateUi();
        return;
      }
      if (event.code === "Enter") {
        event.preventDefault();
        context.confirm();
        updateUi();
        return;
      }
      if (event.code === "Backspace") {
        event.preventDefault();
        context.back();
        return;
      }
    }

    const trackIndex = Number(event.key) - 1;
    if (trackIndex >= 0 && trackIndex < TRACK_COUNT) {
      sim.activeTrack = trackIndex;
      updateUi();
    }
  });
}
bindUi();
renderUiPage();
updateUi();
render();
