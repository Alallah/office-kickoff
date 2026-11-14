// Pure sound-parameter mapping for the match audio engine: game events and the frame view go in,
// plain numbers come out. Nothing here touches Web Audio, the DOM or timers, so all of it can be
// unit-tested in a bare interpreter. Levels are linear gains; times are seconds; pitches are Hz.

import { EVT, PHASE, goalInfo } from '../../shared/protocol.js';

export const clamp = (v, lo, hi) => (v > lo ? (v < hi ? v : hi) : lo);
/** 0..1; NaN becomes 0. */
export const clamp01 = (v) => (v > 0 ? (v < 1 ? v : 1) : 0);
export const lerp = (a, b, t) => a + (b - a) * t;
export const num = (v, fallback = 0) => (Number.isFinite(v) ? v : fallback);
const positive = (v, fallback) => (Number.isFinite(v) && v > 0 ? v : fallback);

export function smoothstep(edge0, edge1, x) {
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

/** Frame-rate independent easing of `current` towards `target` (rate = 1 / time constant). */
export function approach(current, target, rate, dt) {
  return current + (target - current) * (1 - Math.exp(-rate * Math.max(0, dt)));
}

/** Small seedable generator so tests are repeatable; the engine itself runs on Math.random. */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Slow-motion pitch factor for world sounds. */
export const SLOWMO_RATE = 0.82;

/** The few numbers of a MatchInitDto the sound depends on, with safe defaults for anything missing. */
export function matchConstants(init) {
  const pitch = init?.pitch;
  const tuning = init?.tuning;
  const fire = tuning?.kick?.fireThreshold;
  return {
    halfW: positive(pitch?.width, 1500) / 2,
    halfH: positive(pitch?.height, 940) / 2,
    shotMaxSpeed: positive(tuning?.kick?.shotMaxSpeed, 1500),
    fireThreshold: Number.isFinite(fire) && fire > 0 ? fire : 0.85,
    slideTime: clamp(positive(tuning?.tackle?.slideTime, 0.36), 0.15, 0.8),
  };
}

/**
 * Where a world position sits in the stereo field and how much distance takes off it.
 * Uses the same world -> screen transform as the renderer (see types.js).
 * @returns {{pan:number, gain:number, dist:number}} dist is in half-screens from the centre
 */
export function spatial(x, y, view) {
  const cam = view?.camera;
  const vp = view?.viewport;
  const zoom = num(cam?.zoom);
  const w = num(vp?.w);
  const h = num(vp?.h);
  if (!(zoom > 0) || !(w > 0) || !(h > 0) || !Number.isFinite(x) || !Number.isFinite(y)) {
    return { pan: 0, gain: 1, dist: 0 };
  }
  const dx = ((x - num(cam.x)) * zoom) / (w / 2);
  const dy = ((y - num(cam.y)) * zoom) / (h / 2);
  const dist = Math.hypot(dx, dy);
  return {
    pan: clamp(dx * 0.75, -0.9, 0.9),
    // On screen (dist <= 1) nearly full level; off screen it thins out but never vanishes.
    gain: Math.max(0.16, 1 / (1 + 0.3 * dist * dist)),
    dist,
  };
}

/** Shot: weight (lower, longer thud) and brightness (click) both grow with charge. */
export function kickParams(charge, firstTime) {
  const p = clamp01(charge);
  const lift = firstTime ? 1.07 : 1;
  return {
    power: p,
    level: lerp(0.55, 1, p),
    thudFrom: lerp(185, 150, p) * lift,
    thudTo: lerp(80, 44, p),
    thudDecay: lerp(0.07, 0.26, p),
    thudGain: lerp(0.34, 0.9, p),
    clickFreq: lerp(1500, 3600, p) * lift,
    clickGain: lerp(0.14, 0.4, p),
    clickDecay: lerp(0.016, 0.034, p),
    whoosh: smoothstep(0.45, 1, p),
  };
}

/** Pass: a light tap whose weight follows the pass speed. */
export function passParams(speed, firstTime) {
  const p = clamp01(speed);
  const lift = firstTime ? 1.08 : 1;
  return {
    power: p,
    level: lerp(0.4, 0.7, p),
    from: lerp(210, 250, p) * lift,
    to: lerp(105, 88, p),
    decay: lerp(0.04, 0.075, p),
    tickFreq: lerp(1200, 1900, p) * lift,
    tickGain: lerp(0.08, 0.2, p),
  };
}

/** Per-sound housekeeping: minimum gap between repeats (s), voice priority, crowd-bed ducking. */
export const RULES = Object.freeze({
  kick: { gap: 0.035, priority: 2 },
  pass: { gap: 0.035, priority: 1 },
  trap: { gap: 0.05, priority: 0 },
  steal: { gap: 0.06, priority: 1 },
  slide: { gap: 0.05, priority: 1 },
  tackle: { gap: 0.06, priority: 2, duck: [0.8, 0.12] },
  whiff: { gap: 0.08, priority: 0 },
  dash: { gap: 0.06, priority: 1 },
  deflect: { gap: 0.05, priority: 1 },
  block: { gap: 0.05, priority: 2 },
  wall: { gap: 0.07, priority: 0 },
  post: { gap: 0.09, priority: 3, duck: [0.7, 0.2] },
  catch: { gap: 0.08, priority: 2 },
  parry: { gap: 0.08, priority: 2 },
  dive: { gap: 0.1, priority: 0 },
  net: { gap: 0.15, priority: 1 },
  goal: { gap: 0.5, priority: 4, duck: [0.6, 0.35] },
  whistle: { gap: 0.2, priority: 4 },
  overtime: { gap: 1, priority: 4 },
  switch: { gap: 0.04, priority: 1 },
});

/**
 * Turns a game event into a sound description, or null when it makes no sound.
 * @param {object} evt   GameEvt (see protocol.js)
 * @param {{humanId:number, playerIndex:number, team:number, fireThreshold:number}} me
 */
export function describeEvent(evt, me) {
  if (!evt || typeof evt !== 'object') return null;
  const replay = evt.replay === true;
  const power = clamp01(num(evt.v));
  const mine = !replay && evt.a >= 0 && evt.a === me?.playerIndex;
  const base = { replay, mine, power };
  switch (evt.type) {
    case EVT.KICK:
      return { ...base, kind: 'kick', fire: power >= (me?.fireThreshold ?? 0.85), firstTime: evt.f === 1 };
    case EVT.PASS: return { ...base, kind: 'pass', firstTime: evt.f === 1 };
    case EVT.TRAP: return { ...base, kind: 'trap' };
    case EVT.STEAL: return { ...base, kind: 'steal' };
    case EVT.SLIDE_START: return { ...base, kind: 'slide' };
    case EVT.TACKLE_HIT: return { ...base, kind: 'tackle', won: evt.f === 1, body: evt.b >= 0 };
    case EVT.SLIDE_MISS: return { ...base, kind: 'whiff' };
    case EVT.DASH: return { ...base, kind: 'dash' };
    case EVT.DEFLECT: return { ...base, kind: 'deflect' };
    case EVT.BLOCK: return { ...base, kind: 'block' };
    case EVT.WALL_BOUNCE: return power < 0.02 ? null : { ...base, kind: 'wall' };
    case EVT.POST_HIT: return { ...base, kind: 'post' };
    case EVT.KEEPER_CATCH: return { ...base, kind: 'catch' };
    case EVT.KEEPER_PARRY: return { ...base, kind: 'parry' };
    case EVT.DIVE: return { ...base, kind: 'dive' };
    case EVT.NET_HIT: return { ...base, kind: 'net' };
    case EVT.GOAL: {
      const info = goalInfo(evt);
      const flavour = info.ownGoal ? 'own' : info.decides ? 'decider' : 'goal';
      // Spectators (team -1) hear every goal as a home crowd would.
      const forMe = me?.team === 0 || me?.team === 1 ? info.team === me.team : true;
      return { ...base, kind: 'goal', flavour, forMe, side: Math.sign(num(evt.x)) };
    }
    case EVT.PHASE_CHANGE: {
      if (replay) return null;
      const pattern = evt.f === PHASE.PLAYING ? 'kickoff'
        : evt.f === PHASE.GOAL ? 'goal'
        : evt.f === PHASE.FULL_TIME ? 'fulltime' : null;
      return pattern ? { ...base, kind: 'whistle', pattern } : null;
    }
    case EVT.OVERTIME: return replay ? null : { ...base, kind: 'overtime' };
    case EVT.SWITCH:
      return !replay && me?.humanId >= 0 && evt.f === me.humanId ? { ...base, kind: 'switch' } : null;
    default: return null;
  }
}

/** How much a described sound lifts the crowd (0 = not at all). Near misses lift it most. */
export function excitementFor(d) {
  if (!d || d.replay) return 0;
  switch (d.kind) {
    case 'post': return 0.5 + 0.4 * d.power;
    case 'parry': return 0.4 + 0.4 * d.power;
    case 'catch': return 0.28 + 0.3 * d.power;
    case 'block': return 0.25 + 0.25 * d.power;
    case 'kick': return d.fire ? 0.3 : d.power > 0.5 ? 0.15 * d.power : 0;
    case 'tackle': return d.body ? 0.15 : 0.08;
    case 'goal': return d.flavour === 'own' ? 0.5 : 1;
    default: return 0;
  }
}

/** Strength (0 = none) of the crowd's collective "ooh" for a near miss. */
export function oohFor(d) {
  if (!d || d.replay) return 0;
  switch (d.kind) {
    case 'post': return 0.6 + 0.4 * d.power;
    case 'parry': return 0.45 + 0.4 * d.power;
    case 'catch': return d.power > 0.35 ? 0.3 + 0.3 * d.power : 0;
    case 'block': return d.power > 0.3 ? 0.3 + 0.2 * d.power : 0;
    default: return 0;
  }
}

/** 0 at the centre circle, 1 in either goal mouth. */
export function goalProximity(x, y, halfW) {
  const toLine = Math.max(0, halfW - Math.abs(num(x)));
  const d = Math.hypot(toLine, num(y) * 0.7);
  return 1 - smoothstep(halfW * 0.12, halfW * 0.82, d);
}

/**
 * Level and brightness the crowd bed should move towards.
 * @param {{phase:number, replay:boolean, ballX:number, ballY:number, ballSpeed:number, ballDead:boolean,
 *          excitement:number, overtime:boolean, halfW:number, shotMaxSpeed:number}} s
 * @returns {{level:number, bright:number}} level 0..1.2, bright 0..1
 */
export function crowdTarget(s) {
  const exc = clamp(num(s.excitement), 0, 1.5);
  if (s.replay) return { level: 0.2, bright: 0.14 };
  let level;
  let bright;
  switch (s.phase) {
    case PHASE.INTRO: level = 0.3; bright = 0.22; break;
    case PHASE.KICKOFF: level = 0.13; bright = 0.1; break;
    case PHASE.PLAYING: {
      const prox = s.ballDead ? 0 : goalProximity(s.ballX, s.ballY, s.halfW);
      const speed = s.ballDead ? 0 : clamp01(num(s.ballSpeed) / s.shotMaxSpeed);
      level = 0.4 + 0.3 * prox + 0.16 * speed * (0.4 + 0.6 * prox) + 0.3 * exc + (s.overtime ? 0.07 : 0);
      bright = 0.24 + 0.38 * prox + 0.2 * speed + 0.3 * exc + (s.overtime ? 0.05 : 0);
      break;
    }
    case PHASE.GOAL: level = 0.82 + 0.2 * exc; bright = 0.7 + 0.2 * exc; break;
    case PHASE.REPLAY: level = 0.22; bright = 0.15; break;
    case PHASE.FULL_TIME: level = 0.62 + 0.2 * exc; bright = 0.5; break;
    default: level = 0.26; bright = 0.2; break;
  }
  return { level: clamp(level, 0, 1.2), bright: clamp01(bright) };
}

/** Slow, never-repeating-sounding swell (-1..1) that makes the crowd breathe. */
export function breath(t) {
  return 0.5 * Math.sin(0.37 * t + 1.3) + 0.3 * Math.sin(0.83 * t + 4.1) + 0.2 * Math.sin(1.93 * t);
}

/** The charge tone rises and tightens (faster, shallower wobble; beating detune closes) towards full. */
export function chargeTone(charge) {
  const c = clamp01(charge);
  return {
    freq: 196 * Math.pow(2, 1.6 * c),
    detune: lerp(26, 0, c),
    wobbleRate: lerp(7, 26, c * c),
    wobbleDepth: lerp(0.45, 0.1, c),
    cutoff: lerp(700, 3800, c),
    gain: lerp(0.035, 0.085, c),
    ready: c >= 0.995,
  };
}

/** Countdown beeps climb a step each number: 3 -> C5, 2 -> D5, 1 -> E5 (and 'go' lands on C6). */
export function countdownFreq(n) {
  const k = clamp(Math.round(num(n, 3)), 1, 9);
  return 659.25 * Math.pow(2, (-(k - 1) * 2) / 12);
}
export const GO_FREQ = 1046.5;

/** Referee whistle blasts: start offset, length, relative level. */
export function whistlePlan(pattern) {
  switch (pattern) {
    case 'kickoff': return [{ at: 0, dur: 0.2, level: 1 }];
    case 'goal': return [{ at: 0, dur: 0.72, level: 1 }];
    case 'fulltime': return [{ at: 0, dur: 0.24, level: 1 }, { at: 0.4, dur: 0.24, level: 1 }, { at: 0.8, dur: 1.0, level: 1 }];
    case 'overtime': return [{ at: 0, dur: 0.15, level: 0.95 }, { at: 0.25, dur: 0.15, level: 1 }];
    default: return [];
  }
}

export const planLength = (plan) => plan.reduce((end, b) => Math.max(end, b.at + b.dur), 0);

const C5 = 523.25, E5 = 659.25, G5 = 783.99, B5 = 987.77, C6 = 1046.5, E6 = 1318.5, G6 = 1567.98;

/**
 * Notes of a musical sting. 'goal' is a rising major arpeggio (shorter and softer when the other
 * team scored), 'decider' the full fanfare with a held chord, 'overtime' a tense rising figure.
 * @returns {{at:number, freq:number, dur:number, gain:number}[]}
 */
export function stingNotes(flavour, forMe = true) {
  const run = (freqs, step, gain, lastDur) => freqs.map((freq, i) => ({
    at: i * step, freq, dur: i === freqs.length - 1 ? lastDur : step * 2.2, gain,
  }));
  if (flavour === 'decider') {
    return [
      ...run([C5, E5, G5, C6, E6, G6], 0.07, 0.9, 0.3),
      { at: 0.5, freq: C6, dur: 1.3, gain: 0.8 }, { at: 0.5, freq: E6, dur: 1.3, gain: 0.6 },
      { at: 0.5, freq: G6, dur: 1.3, gain: 0.55 },
    ];
  }
  if (flavour === 'overtime') return run([E5, G5, B5, E6], 0.08, 0.7, 0.5);
  return forMe ? run([C5, E5, G5, C6], 0.075, 1, 0.6) : run([E5, G5, C6], 0.075, 0.6, 0.4);
}

/** Seconds until the next sound from the stands; they come a little more often when it is lively. */
export function standGap(rng, energy) {
  return lerp(17, 8, clamp01(energy)) * (0.55 + 0.9 * rng());
}

export function standPick(rng) {
  const r = rng();
  return r < 0.45 ? 'claps' : r < 0.8 ? 'chant' : 'whistle';
}

/** Onset times of a short burst of distant clapping: steady, or a "x x xxx" terrace rhythm. */
export function clapTimes(rng) {
  const beat = lerp(0.26, 0.36, rng());
  const pattern = rng() < 0.5 ? [0, 1, 2, 3, 4, 5, 6, 7] : [0, 1, 2, 2.5, 3, 5, 6, 7, 7.5, 8];
  const count = Math.max(4, Math.round(pattern.length * lerp(0.6, 1, rng())));
  return pattern.slice(0, count).map((b) => b * beat + (rng() - 0.5) * 0.03 + 0.02);
}

/** Syllables of a wordless chant: onset, length and pitch step (semitones) for each. */
export function chantSyllables(rng) {
  const beat = lerp(0.3, 0.4, rng());
  const shapes = [
    [[0, 1, 0], [1, 1, 0], [2, 0.5, 2], [2.5, 0.5, 2], [3, 1.6, 0]],
    [[0, 0.5, 0], [0.5, 0.5, 0], [1, 1, 3], [2, 0.5, 0], [2.5, 0.5, 0], [3, 1.6, -2]],
    [[0, 1.5, 0], [1.5, 0.5, 2], [2, 1.8, 4]],
  ];
  const shape = shapes[Math.min(shapes.length - 1, Math.floor(rng() * shapes.length))];
  const repeats = rng() < 0.5 ? 2 : 1;
  const out = [];
  for (let r = 0; r < repeats; r++) {
    for (const [b, len, step] of shape) out.push({ at: (b + r * 5) * beat, dur: len * beat * 0.8, step });
  }
  return out;
}

/** Remembers when each sound last played so identical ones cannot machine-gun. */
export function createLimiter() {
  const last = new Map();
  return {
    allow(key, now, gap) {
      const t = last.get(key);
      if (t !== undefined && now >= t && now - t < gap) return false;
      last.set(key, now);
      return true;
    },
    reset: () => last.clear(),
  };
}

/**
 * Which voice to drop when the mix is full: the least important, then the quietest right now
 * (envelopes decay, so an old voice counts for less), then the oldest. Returns -1 when the
 * incoming sound is itself the least important and should be skipped instead.
 * @param {{priority:number, level:number, t0:number, end:number}[]} voices
 */
export function chooseVictim(voices, now, incomingPriority) {
  let best = -1;
  let bestP = Infinity;
  let bestLoud = Infinity;
  for (let i = 0; i < voices.length; i++) {
    const v = voices[i];
    const span = Math.max(1e-3, v.end - v.t0);
    const loud = v.level * clamp01((v.end - now) / span);
    if (v.priority < bestP || (v.priority === bestP && loud < bestLoud - 1e-9)) {
      best = i;
      bestP = v.priority;
      bestLoud = loud;
    }
  }
  return best >= 0 && bestP <= incomingPriority ? best : -1;
}

export function fillWhite(data, rng) {
  for (let i = 0; i < data.length; i++) data[i] = rng() * 2 - 1;
}

/** Pink (1/f) noise, Paul Kellet's filter, normalised to a 0.9 peak. */
export function fillPink(data, rng) {
  let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0, peak = 1e-9;
  for (let i = 0; i < data.length; i++) {
    const w = rng() * 2 - 1;
    b0 = 0.99886 * b0 + w * 0.0555179;
    b1 = 0.99332 * b1 + w * 0.0750759;
    b2 = 0.969 * b2 + w * 0.153852;
    b3 = 0.8665 * b3 + w * 0.3104856;
    b4 = 0.55 * b4 + w * 0.5329522;
    b5 = -0.7616 * b5 - w * 0.016898;
    const s = b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362;
    b6 = w * 0.115926;
    data[i] = s;
    if (s > peak) peak = s; else if (-s > peak) peak = -s;
  }
  const k = 0.9 / peak;
  for (let i = 0; i < data.length; i++) data[i] *= k;
}

/** Sparse, randomly sized clicks with tiny decays: the crackle of a shot that is on fire. */
export function fillCrackle(data, rng, sampleRate) {
  data.fill(0);
  const tail = Math.max(2, Math.floor(sampleRate * 0.0012));
  let i = Math.floor(rng() * sampleRate * 0.01);
  while (i < data.length) {
    const amp = (0.25 + 0.75 * rng()) * (rng() < 0.5 ? -1 : 1);
    for (let j = 0; j < tail && i + j < data.length; j++) data[i + j] += amp * (1 - j / tail) * (rng() * 0.6 + 0.4);
    i += 1 + Math.floor(sampleRate * (0.002 + 0.02 * rng() * rng()));
  }
  for (let n = 0; n < data.length; n++) data[n] = clamp(data[n], -1, 1);
}

/**
 * Makes a noise buffer loop without a click: the last `fade` samples are cross-faded (equal power)
 * into the first ones. Returns the loopable length, data.length - fade.
 */
export function loopBlend(data, fade) {
  const n = Math.max(0, Math.min(fade | 0, data.length >> 1));
  const body = data.length - n;
  for (let i = 0; i < n; i++) {
    const w = i / n;
    data[i] = data[i] * Math.sqrt(w) + data[body + i] * Math.sqrt(1 - w);
  }
  return body;
}

/** Input range (linear, either sign) the output safety clipper handles before it saturates flat. */
export const SAFETY_RANGE = 2;
const SAFETY_KNEE = 0.75;
const SAFETY_CEILING = 0.98;

/** Safety clipper on a signal already scaled by 1 / SAFETY_RANGE: transparent below the knee, then
 *  bending smoothly towards a ceiling just under full scale. */
export function safetyTransfer(y) {
  const a = Math.abs(y);
  if (a <= SAFETY_KNEE) return y;
  const room = SAFETY_CEILING - SAFETY_KNEE;
  return Math.sign(y) * (SAFETY_KNEE + room * Math.tanh((a - SAFETY_KNEE) / room));
}

export function safetyCurve(size) {
  const curve = new Float32Array(size);
  for (let i = 0; i < size; i++) curve[i] = safetyTransfer(((i / (size - 1)) * 2 - 1) * SAFETY_RANGE);
  return curve;
}

/** Soft-clipping curve for a WaveShaper: adds grit without harsh edges. */
export function shaperCurve(size, drive) {
  const curve = new Float32Array(size);
  const norm = Math.tanh(drive);
  for (let i = 0; i < size; i++) curve[i] = Math.tanh(((i / (size - 1)) * 2 - 1) * drive) / norm;
  return curve;
}
