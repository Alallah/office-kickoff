// Signals rather than physics: the referee's whistle, musical stings, the goal's bass impact,
// interface sounds, and the two cues tied to the local player (shot charge, out of breath).

import { planLength, chargeTone, countdownFreq, GO_FREQ } from './params.js';

/**
 * Referee's pea whistle. One voice plays the whole pattern: the air column keeps sounding and a
 * gain opens for each blast, so consecutive blasts share the same pitch and trill.
 * @param {{at:number, dur:number, level:number}[]} plan  from params.whistlePlan
 */
export function whistle(mix, plan) {
  if (!plan.length) return;
  const v = mix.begin('whistle', { gain: 0.2, bus: 'world', priority: 4 });
  if (!v) return;
  const t = v.t0;
  const f = 2380 * mix.vary(0.025);

  const blast = mix.gain(v, 0);
  const trill = mix.gain(v, 1);
  const soften = mix.filter(v, 'lowpass', 5200, 0.6);
  trill.connect(blast);
  blast.connect(soften);
  soften.connect(v.out);

  // Two close pitches beat against each other; the pea flutters both loudness and pitch.
  const pea = mix.osc(v, 'triangle', 34 * mix.vary(0.1), t);
  const flutter = mix.gain(v, 0.28);
  const wobble = mix.gain(v, 55);
  pea.connect(flutter);
  flutter.connect(trill.gain);
  pea.connect(wobble);
  const pipes = [[1, 0.6], [1.085, 0.3]].map(([ratio, level]) => {
    const o = mix.osc(v, 'sine', f * ratio, t);
    const g = mix.gain(v, level);
    wobble.connect(o.frequency);
    o.connect(g);
    g.connect(trill);
    return { o, pitch: mix.hz(f * ratio) };
  });
  const air = mix.noise(v, mix.white, t);
  const airBand = mix.filter(v, 'bandpass', f * 1.02, 5);
  const airLevel = mix.gain(v, 0.5);
  air.connect(airBand);
  airBand.connect(airLevel);
  airLevel.connect(trill);

  for (const b of plan) {
    const start = t + b.at;
    const dur = Math.max(0.1, b.dur);
    mix.shape(blast.gain, start, [[0, 0], [0.012, b.level], [dur - 0.06, b.level * 0.9], [dur, 1e-4]]);
    // Each blast scoops up into pitch and sags as the breath runs out.
    for (const p of pipes) {
      mix.shape(p.o.frequency, start, [[0, p.pitch * 0.93], [0.035, p.pitch], [dur - 0.06, p.pitch], [dur, p.pitch * 0.955]]);
    }
  }
  mix.finish(v, t + planLength(plan) + 0.05);
}

/**
 * Plays notes from params.stingNotes: a soft triangle lead with an octave shimmer and a touch of
 * square for arcade bite, all rounded off by a low-pass.
 * @param {{at:number, freq:number, dur:number, gain:number}[]} notes
 */
export function sting(mix, notes, level, o = {}) {
  const v = mix.begin('sting', { gain: 0.5 * level, bus: o.bus || 'ui', priority: 4, delay: o.delay });
  if (!v) return;
  const soften = mix.filter(v, 'lowpass', 5200, 0.5);
  soften.connect(v.out);
  for (const n of notes) {
    const at = v.t0 + n.at;
    mix.tone(v, { type: 'triangle', f0: n.freq, at, attack: 0.006, decay: n.dur, gain: 0.3 * n.gain, dest: soften });
    mix.tone(v, { f0: n.freq * 2, at, attack: 0.004, decay: n.dur * 0.6, gain: 0.1 * n.gain, dest: soften });
    mix.tone(v, { type: 'square', f0: n.freq, at, attack: 0.004, decay: n.dur * 0.35, gain: 0.05 * n.gain, dest: soften });
  }
  mix.finish(v);
}

/** The thump under a goal. The octave-up layer keeps it audible on laptop speakers. */
export function impact(mix, size, bus) {
  const v = mix.begin('goal', { gain: 0.7 * size, bus, priority: 4 });
  if (!v) return;
  mix.tone(v, { f0: 86, f1: 31, glide: 0.3, attack: 0.004, decay: 0.6, gain: 0.8 });
  mix.tone(v, { type: 'triangle', f0: 172, f1: 62, glide: 0.22, attack: 0.004, decay: 0.3, gain: 0.25 });
  mix.burst(v, { type: 'lowpass', f0: 160, q: 0.7, attack: 0.004, decay: 0.22, gain: 0.5 });
  mix.burst(v, { f0: 1200, q: 0.7, decay: 0.05, gain: 0.12 });
  mix.finish(v);
}

/** Tiny confirmation that control moved to another footballer. */
export function switchBlip(mix) {
  const v = mix.begin('switch', { gain: 0.5, bus: 'ui', priority: 1 });
  if (!v) return;
  mix.tone(v, { f0: 880, f1: 1320, glide: 0.03, attack: 0.002, decay: 0.05, gain: 0.16 });
  mix.finish(v);
}

/** Two quick breaths: the sprint tank is empty. */
export function pant(mix) {
  const v = mix.begin('breath', { gain: 0.5, bus: 'ui', priority: 1 });
  if (!v) return;
  for (const [at, f, len, level] of [[0, 1100, 0.16, 0.2], [0.24, 850, 0.22, 0.26]]) {
    mix.burst(v, {
      buffer: mix.pink, f0: f, f1: f * 0.6, glide: len, q: 1.6,
      at: v.t0 + at, attack: len * 0.35, decay: len * 0.65, gain: level,
    });
  }
  mix.finish(v);
}

function twoNotes(mix, v, first, second) {
  mix.tone(v, { type: 'triangle', f0: first, attack: 0.003, decay: 0.09, gain: 0.16 });
  mix.tone(v, { type: 'triangle', f0: second, at: v.t0 + 0.06, attack: 0.003, decay: 0.12, gain: 0.16 });
}

const UI = {
  click(mix, v) {
    mix.tone(v, { type: 'triangle', f0: 1500 * mix.vary(0.03), f1: 950, glide: 0.02, attack: 0.001, decay: 0.035, gain: 0.22 });
    mix.burst(v, { type: 'highpass', f0: 2500, q: 0.7, decay: 0.008, gain: 0.1 });
  },
  hover(mix, v) {
    mix.tone(v, { f0: 1750 * mix.vary(0.03), attack: 0.002, decay: 0.022, gain: 0.07 });
  },
  open: (mix, v) => twoNotes(mix, v, 587.33, 880),
  close: (mix, v) => twoNotes(mix, v, 880, 587.33),
  chat(mix, v) {
    mix.tone(v, { f0: 720, f1: 540, glide: 0.04, attack: 0.003, decay: 0.07, gain: 0.2 });
    mix.tone(v, { f0: 1080, at: v.t0 + 0.07, attack: 0.003, decay: 0.08, gain: 0.12 });
  },
  emote(mix, v) {
    // A springy up-and-settle "boing".
    const o = mix.osc(v, 'sine', 440);
    mix.shape(o.frequency, v.t0, [[0, 440], [0.06, 920], [0.17, 700]]);
    const g = mix.gain(v, 0);
    mix.env(g.gain, v.t0, 0.2, 0.004, 0.17);
    o.connect(g);
    g.connect(v.out);
    mix.tone(v, { type: 'triangle', f0: 1400, f1: 1840, glide: 0.06, attack: 0.004, decay: 0.07, gain: 0.05 });
    mix.extend(v, v.t0 + 0.2);
  },
  error(mix, v) {
    const soften = mix.filter(v, 'lowpass', 900, 0.7);
    soften.connect(v.out);
    for (const at of [0, 0.11]) {
      mix.tone(v, { type: 'square', f0: 160, at: v.t0 + at, attack: 0.004, decay: 0.08, gain: 0.16, dest: soften });
      mix.tone(v, { f0: 120, at: v.t0 + at, attack: 0.004, decay: 0.08, gain: 0.14 });
    }
  },
  countdown(mix, v, value) {
    const f = countdownFreq(value);
    mix.tone(v, { f0: f, attack: 0.004, decay: 0.16, gain: 0.3 });
    mix.tone(v, { type: 'triangle', f0: f * 2, attack: 0.004, decay: 0.09, gain: 0.07 });
    mix.burst(v, { type: 'highpass', f0: 3000, q: 0.7, decay: 0.006, gain: 0.05 });
  },
  go(mix, v) {
    mix.tone(v, { f0: GO_FREQ * 0.5, f1: GO_FREQ, glide: 0.035, attack: 0.004, decay: 0.5, gain: 0.3 });
    mix.tone(v, { f0: GO_FREQ * 1.5, attack: 0.004, decay: 0.4, gain: 0.13 });
    mix.tone(v, { type: 'triangle', f0: GO_FREQ * 2, attack: 0.004, decay: 0.3, gain: 0.09 });
    mix.burst(v, { type: 'highpass', f0: 5000, q: 0.7, decay: 0.05, gain: 0.06 });
  },
};

export const UI_GAPS = Object.freeze({ hover: 0.05, countdown: 0.12, go: 0.3 });

/** Interface sound by name; unknown names are ignored. Returns true when something was played. */
export function uiSound(mix, name, value) {
  if (!Object.prototype.hasOwnProperty.call(UI, name)) return false;
  const v = mix.begin(`ui-${name}`, { gain: 0.55, bus: 'ui', priority: 3 });
  if (!v) return false;
  UI[name](mix, v, value);
  mix.finish(v);
  return true;
}

/**
 * The shot-charge tone. Nodes exist only while the local player is charging: set(charge) builds
 * them on demand and follows the charge, stop() fades them out and tears them down.
 */
export function createCharge(mix) {
  const ctx = mix.ctx;
  let rig = null;
  let wasReady = false;
  let last = -1;

  function build() {
    const nodes = [];
    const sources = [];
    const gain = (value) => {
      const g = ctx.createGain();
      g.gain.value = value;
      nodes.push(g);
      return g;
    };
    const osc = (type, freq) => {
      const o = ctx.createOscillator();
      o.type = type;
      o.frequency.value = freq;
      o.start();
      nodes.push(o);
      sources.push(o);
      return o;
    };
    const out = gain(0);
    const wobble = gain(1);
    const tone = ctx.createBiquadFilter();
    tone.type = 'lowpass';
    tone.frequency.value = 700;
    tone.Q.value = 1.5;
    nodes.push(tone);
    const a = osc('triangle', 196);
    const b = osc('sine', 196);
    const lfo = osc('sine', 7);
    const depth = gain(0.45);
    a.connect(tone);
    b.connect(tone);
    tone.connect(wobble);
    lfo.connect(depth);
    depth.connect(wobble.gain);
    wobble.connect(out);
    // "Ready": a high partial with a quick shimmer, silent until the charge is full.
    const glint = osc('sine', 784);
    const glintLevel = gain(0);
    const shimmer = gain(0.6);
    const shimmerLfo = osc('sine', 13);
    const shimmerDepth = gain(0.4);
    glint.connect(shimmer);
    shimmerLfo.connect(shimmerDepth);
    shimmerDepth.connect(shimmer.gain);
    shimmer.connect(glintLevel);
    glintLevel.connect(out);
    out.connect(mix.buses.ui);
    return { nodes, sources, out, tone, a, b, lfo, depth, glint, glintLevel };
  }

  function sparkle() {
    const v = mix.begin('ready', { gain: 0.5, bus: 'ui', priority: 2 });
    if (!v) return;
    mix.tone(v, { f0: 1568, attack: 0.003, decay: 0.12, gain: 0.12 });
    mix.tone(v, { f0: 2093, at: v.t0 + 0.05, attack: 0.003, decay: 0.2, gain: 0.1 });
    mix.finish(v);
  }

  function stop() {
    wasReady = false;
    last = -1;
    if (!rig) return;
    const r = rig;
    rig = null;
    const now = ctx.currentTime;
    r.out.gain.setTargetAtTime(0, now, 0.02);
    const release = () => {
      for (const s of r.sources) s.onended = null;
      for (const n of r.nodes) {
        try {
          n.disconnect();
        } catch {
          /* already disconnected */
        }
      }
    };
    r.sources[0].onended = release;
    for (const s of r.sources) {
      try {
        s.stop(now + 0.15);
      } catch {
        /* already stopped */
      }
    }
  }

  return {
    /** @param {number} charge 0..1; 0 or less stops the tone */
    set(charge) {
      if (!(charge > 0)) {
        stop();
        return;
      }
      // Held at the same charge (typically full): the tone is already where it should be.
      if (rig && Math.abs(charge - last) < 1e-4) return;
      last = charge;
      if (!rig) rig = build();
      const p = chargeTone(charge);
      const now = ctx.currentTime;
      const quick = 0.03;
      rig.a.frequency.setTargetAtTime(mix.hz(p.freq), now, quick);
      rig.b.frequency.setTargetAtTime(mix.hz(p.freq), now, quick);
      rig.b.detune.setTargetAtTime(p.detune, now, quick);
      rig.glint.frequency.setTargetAtTime(mix.hz(p.freq * 4), now, quick);
      rig.lfo.frequency.setTargetAtTime(p.wobbleRate, now, quick);
      rig.depth.gain.setTargetAtTime(p.wobbleDepth, now, quick);
      rig.tone.frequency.setTargetAtTime(mix.hz(p.cutoff), now, quick);
      rig.out.gain.setTargetAtTime(p.gain, now, 0.025);
      rig.glintLevel.gain.setTargetAtTime(p.ready ? 0.35 : 0, now, 0.03);
      if (p.ready && !wasReady) sparkle();
      wasReady = p.ready;
    },
    stop,
    get active() {
      return rig !== null;
    },
  };
}
