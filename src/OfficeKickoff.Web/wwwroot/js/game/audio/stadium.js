// The crowd: a continuous bed that breathes with the game, the big collective reactions (roar,
// groan, "ooh") and the occasional sound from the stands (claps, chants, a fan's whistle).
//
// A crowd is not static because nothing in it holds still: the bed is two decorrelated noise
// streams shaped into a low murmur and a vowel-like band, and slow oscillators keep the vowel
// drifting, the two sides swelling independently and the level fluttering at speech rate.

import { lerp, breath } from './params.js';

const BED_LEVEL = 0.9;

/** Builds the bed (silent until the first set()). Its nodes live as long as the page. */
export function createCrowd(mix) {
  const ctx = mix.ctx;

  const gain = (value) => {
    const g = ctx.createGain();
    g.gain.value = value;
    return g;
  };
  const filter = (type, freq, q) => {
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = mix.hz(freq);
    f.Q.value = q;
    return f;
  };
  const loop = (rate) => {
    const src = ctx.createBufferSource();
    src.buffer = mix.pink;
    src.loop = true;
    src.playbackRate.value = rate;
    src.start(ctx.currentTime, mix.rnd() * Math.max(0, mix.pink.duration - 0.1));
    return src;
  };
  const lfo = (freq, depth, param) => {
    const o = ctx.createOscillator();
    o.frequency.value = freq;
    const d = gain(depth);
    o.connect(d);
    d.connect(param);
    o.start();
  };

  const level = gain(0);
  const tone = filter('lowpass', 1500, 0.4);
  tone.connect(level);
  level.connect(mix.buses.bed);

  function side(rate, pan, tune) {
    const src = loop(rate);
    const body = filter('bandpass', 430 * tune, 0.55);
    const bodyGain = gain(0.9);
    const voice = filter('bandpass', 980 * tune, 0.9);
    const voiceGain = gain(0.5);
    src.connect(body);
    body.connect(bodyGain);
    src.connect(voice);
    voice.connect(voiceGain);
    let out = gain(1);
    bodyGain.connect(out);
    voiceGain.connect(out);
    if (typeof ctx.createStereoPanner === 'function') {
      const panner = ctx.createStereoPanner();
      panner.pan.value = pan;
      out.connect(panner);
      out = panner;
    }
    out.connect(tone);
    return { src, voice, bodyGain, voiceGain };
  }

  const sides = [side(1, -0.45, 1), side(0.79, 0.45, 1.09)];
  const air = filter('highpass', 2400, 0.5);
  const airGain = gain(0.03);
  sides[0].src.connect(air);
  air.connect(airGain);
  airGain.connect(tone);

  lfo(0.11, 130, sides[0].voice.frequency);
  lfo(0.083, 110, sides[1].voice.frequency);
  lfo(0.19, 0.14, sides[0].bodyGain.gain);
  lfo(0.137, 0.14, sides[1].bodyGain.gain);
  lfo(4.3, 0.06, sides[0].voiceGain.gain);
  lfo(5.9, 0.06, sides[1].voiceGain.gain);

  return {
    /**
     * Moves the bed towards a target from params.crowdTarget.
     * @param {{level:number, bright:number}} target
     * @param {number} wallTime seconds; drives the slow breathing
     */
    set(target, wallTime) {
      const now = ctx.currentTime;
      const swell = 1 + 0.13 * breath(wallTime);
      level.gain.setTargetAtTime(BED_LEVEL * target.level * swell, now, 0.22);
      tone.frequency.setTargetAtTime(mix.hz(lerp(1300, 6000, target.bright)), now, 0.3);
      airGain.gain.setTargetAtTime(lerp(0.03, 0.4, target.bright), now, 0.3);
      const voices = lerp(0.4, 0.85, target.bright);
      for (const s of sides) s.voiceGain.gain.setTargetAtTime(voices, now, 0.3);
    },
  };
}

/**
 * A crowd vocalising together: pink noise through moving vowel bands under one envelope.
 * @param {{len:number, env:number[][], bands:{type?:string, path:number[][], q:number, gain:number, rate:number}[],
 *          lfos?:number[][]}} o   env and band paths are [seconds, value] points; lfos are [Hz, depth]
 */
function vocalise(mix, v, o) {
  const t = v.t0;
  const envelope = mix.gain(v, 0);
  // Modulation rides on its own unity stage so it scales with the envelope instead of adding to it.
  const motion = mix.gain(v, 1);
  motion.connect(envelope);
  envelope.connect(v.out);
  mix.shape(envelope.gain, t, o.env);
  for (const band of o.bands) {
    const src = mix.noise(v, mix.pink, t, band.rate);
    const filt = mix.filter(v, band.type || 'bandpass', band.path[0][1], band.q);
    mix.shape(filt.frequency, t, band.path.map(([at, f]) => [at, mix.hz(f)]));
    const g = mix.gain(v, band.gain);
    src.connect(filt);
    filt.connect(g);
    g.connect(motion);
  }
  for (const [rate, depth] of o.lfos || []) {
    const wave = mix.osc(v, 'sine', rate, t);
    const d = mix.gain(v, depth);
    wave.connect(d);
    d.connect(motion.gain);
  }
  mix.finish(v, t + o.len);
}

/**
 * The goal roar: swells in a fifth of a second, hangs, then takes seconds to die away.
 * @param {{size:number, len:number, pan?:number, bus?:string, delay?:number}} o
 */
export function roar(mix, o) {
  const v = mix.begin('goal', { gain: 0.95 * o.size, pan: o.pan, bus: o.bus || 'crowd', priority: 4, delay: o.delay });
  if (!v) return;
  const len = o.len;
  vocalise(mix, v, {
    len,
    env: [[0, 0], [0.2, 1], [Math.min(1.2, len * 0.3), 0.62], [len * 0.6, 0.26], [len, 0.001]],
    bands: [
      { path: [[0, 560], [0.3, 680], [len, 600]], q: 0.7, gain: 1, rate: 1 },
      // Mouths opening: the upper vowel band rises with the swell and sags as it fades.
      { path: [[0, 900], [0.3, 1380], [len, 1000]], q: 1, gain: 0.75, rate: 1.37 },
      { type: 'highpass', path: [[0, 2000], [0.3, 2600], [len, 2200]], q: 0.5, gain: 0.2, rate: 0.83 },
    ],
    lfos: [[0.9 * mix.vary(0.2), 0.1], [5.6 * mix.vary(0.15), 0.06]],
  });
}

/** Own goal: a deflated, falling "ohh". */
export function groan(mix, o) {
  const v = mix.begin('goal', { gain: 0.75 * o.size, pan: o.pan, bus: o.bus || 'crowd', priority: 4 });
  if (!v) return;
  const len = o.len;
  mix.tone(v, { f0: 196, f1: 138, glide: 0.9, at: v.t0 + 0.05, attack: 0.08, decay: Math.min(1, len * 0.6), gain: 0.1 });
  vocalise(mix, v, {
    len,
    env: [[0, 0], [0.28, 1], [Math.min(0.9, len * 0.5), 0.6], [len, 0.001]],
    bands: [
      { path: [[0, 480], [len, 300]], q: 1.3, gain: 1, rate: 0.9 },
      { path: [[0, 920], [len, 620]], q: 1.6, gain: 0.5, rate: 1.21 },
    ],
    lfos: [[4.8 * mix.vary(0.15), 0.05]],
  });
}

/** Near miss: a short collective "ooh". @param {number} strength 0..1 */
export function ooh(mix, strength, pan) {
  const v = mix.begin('ooh', { gain: 0.55 * strength, pan, bus: 'crowd', priority: 2 });
  if (!v) return;
  const len = lerp(0.8, 1.3, strength);
  vocalise(mix, v, {
    len,
    env: [[0, 0], [0.12, 1], [0.4, 0.7], [len, 0.001]],
    bands: [
      { path: [[0, 430], [0.15, 540], [len, 400]], q: 1.5, gain: 1, rate: 1 },
      { path: [[0, 820], [0.15, 1020], [len, 780]], q: 1.8, gain: 0.45, rate: 1.29 },
    ],
  });
}

/** A handful of people clapping roughly together, far away. @param {number[]} times onsets in seconds */
export function claps(mix, times, pan, level) {
  const v = mix.begin('stand', { gain: level, pan, bus: 'bed', priority: 0 });
  if (!v) return;
  const src = mix.noise(v, mix.white);
  for (const [freq, lag] of [[1250, 0], [1900, 0.014]]) {
    const filt = mix.filter(v, 'bandpass', freq * mix.vary(0.15), 1.6);
    const g = mix.gain(v, 0);
    src.connect(filt);
    filt.connect(g);
    g.connect(v.out);
    for (const at of times) {
      const start = v.t0 + at + lag;
      mix.env(g.gain, start, 0.5 + 0.5 * mix.rnd(), 0.003, 0.045);
      mix.extend(v, start + 0.07);
    }
  }
  mix.finish(v);
}

/** A wordless terrace chant: narrow, pitched bands of noise pulsed in rhythm. */
export function chant(mix, syllables, pan, level) {
  const v = mix.begin('stand', { gain: level, pan, bus: 'bed', priority: 0 });
  if (!v) return;
  const base = 330 * mix.vary(0.12);
  const src = mix.noise(v, mix.pink);
  const pulse = mix.gain(v, 0);
  pulse.connect(v.out);
  const bands = [[1, 7, 1.5], [2, 8, 0.7]].map(([ratio, q, level2]) => {
    const filt = mix.filter(v, 'bandpass', base * ratio, q);
    const g = mix.gain(v, level2);
    src.connect(filt);
    filt.connect(g);
    g.connect(pulse);
    return { filt, ratio };
  });
  for (const s of syllables) {
    const start = v.t0 + s.at;
    const pitch = base * Math.pow(2, s.step / 12);
    for (const b of bands) b.filt.frequency.setValueAtTime(mix.hz(pitch * b.ratio), start);
    const decay = Math.max(0.05, s.dur - 0.06);
    mix.env(pulse.gain, start, 1, 0.04, decay);
    mix.extend(v, start + 0.04 + decay + 0.03);
  }
  mix.finish(v);
}

/** A fan's finger whistle from somewhere up in the stand. */
export function fanWhistle(mix, pan, level) {
  const v = mix.begin('stand', { gain: level, pan, bus: 'bed', priority: 0 });
  if (!v) return;
  const t = v.t0;
  const f = 2500 * mix.vary(0.15);
  const twoTone = mix.rnd() < 0.5;
  const len = twoTone ? 0.52 : 0.3;
  const o = mix.osc(v, 'sine', f * 0.82, t);
  mix.shape(o.frequency, t, (twoTone
    ? [[0, f * 0.82], [0.12, f * 1.15], [0.3, f * 1.1], [len, f * 0.75]]
    : [[0, f * 0.85], [0.1, f * 1.1], [len, f * 1.22]]).map(([at, hz]) => [at, mix.hz(hz)]));
  const g = mix.gain(v, 0);
  mix.shape(g.gain, t, [[0, 0], [0.03, 1], [len - 0.08, 0.8], [len, 0.001]]);
  o.connect(g);
  g.connect(v.out);
  mix.finish(v, t + len + 0.02);
}
