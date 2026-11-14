// In-world one-shots: ball contact, tackles, keeper actions. Each recipe layers a pitched body
// with shaped noise and varies itself a little on every trigger so repeats never sound stamped out.
//
// Every recipe takes (mix, d, o, consts):
//   d       sound description from params.describeEvent (power 0..1 and per-sound flags)
//   o       { gain, pan, bus, rate } - placement and routing decided by the engine
//   consts  params.matchConstants(...)

import { RULES, kickParams, passParams, lerp } from './params.js';

function open(mix, kind, o, level) {
  return mix.begin(kind, {
    gain: level * (o.gain ?? 1), pan: o.pan, bus: o.bus, rate: o.rate, priority: RULES[kind]?.priority ?? 1,
  });
}

function kick(mix, d, o) {
  const k = kickParams(d.power, d.firstTime);
  const v = open(mix, 'kick', o, k.level * (d.mine ? 1.12 : 1));
  if (!v) return;
  const t = v.t0;
  const pitch = mix.vary(0.05);
  mix.tone(v, { f0: k.thudFrom * pitch, f1: k.thudTo * pitch, glide: k.thudDecay * 0.55, decay: k.thudDecay, gain: k.thudGain, attack: 0.002 });
  mix.tone(v, { type: 'triangle', f0: 320 * pitch, f1: 140, glide: 0.03, decay: 0.045, gain: 0.16 + 0.14 * k.power, attack: 0.001 });
  mix.burst(v, { f0: k.clickFreq * mix.vary(0.12), q: 0.9, decay: k.clickDecay, gain: k.clickGain });
  if (k.whoosh > 0) {
    // The ball tearing away: airy noise that falls in pitch as it leaves.
    const len = lerp(0.18, 0.4, k.whoosh);
    mix.burst(v, { f0: 2500 * mix.vary(0.1), f1: 620, glide: len, q: 1.2, at: t + 0.012, attack: 0.03, decay: len, gain: 0.2 * k.whoosh });
  }
  if (d.fire) {
    mix.burst(v, { buffer: mix.crackle, type: 'highpass', f0: 1800, q: 0.7, attack: 0.008, decay: 0.5, gain: 0.34 });
    mix.burst(v, { f0: 520, f1: 3200, glide: 0.16, q: 0.8, attack: 0.11, decay: 0.3, gain: 0.15 });
    const soften = mix.filter(v, 'lowpass', 2200 * v.rate, 0.7);
    soften.connect(v.out);
    mix.tone(v, { type: 'sawtooth', f0: 880 * pitch, f1: 190, glide: 0.2, decay: 0.24, gain: 0.07, dest: soften });
  }
  mix.finish(v);
}

function pass(mix, d, o) {
  const p = passParams(d.power, d.firstTime);
  const v = open(mix, 'pass', o, p.level * (d.mine ? 1.1 : 1));
  if (!v) return;
  const pitch = mix.vary(0.06);
  mix.tone(v, { f0: p.from * pitch, f1: p.to * pitch, glide: p.decay * 0.7, decay: p.decay, gain: 0.5, attack: 0.002 });
  mix.burst(v, { type: 'lowpass', f0: p.tickFreq * mix.vary(0.1), q: 0.7, decay: 0.02, gain: p.tickGain });
  mix.finish(v);
}

function trap(mix, d, o) {
  const v = open(mix, 'trap', o, lerp(0.3, 0.6, d.power));
  if (!v) return;
  mix.burst(v, { type: 'lowpass', f0: lerp(500, 900, d.power) * mix.vary(0.1), q: 0.6, attack: 0.006, decay: 0.07, gain: 0.3 });
  mix.tone(v, { f0: 150 * mix.vary(0.08), f1: 84, glide: 0.05, attack: 0.006, decay: 0.07, gain: 0.3 });
  mix.finish(v);
}

function steal(mix, d, o) {
  const v = open(mix, 'steal', o, 0.55);
  if (!v) return;
  mix.burst(v, { type: 'highpass', f0: 2200, q: 0.8, decay: 0.014, gain: 0.3 });
  mix.tone(v, { type: 'triangle', f0: 1050 * mix.vary(0.08), f1: 520, glide: 0.025, decay: 0.035, gain: 0.3, attack: 0.001 });
  mix.tone(v, { f0: 190, f1: 110, glide: 0.03, decay: 0.04, gain: 0.2 });
  mix.finish(v);
}

function slide(mix, d, o, consts) {
  const v = open(mix, 'slide', o, 0.55);
  if (!v) return;
  const len = consts.slideTime * 0.95;
  // Studs on turf: the scrape is chopped by a fast sawtooth so it growls instead of hissing.
  const grit = mix.gain(v, 0.6);
  const chop = mix.osc(v, 'sawtooth', 58 * mix.vary(0.15) * v.rate);
  const depth = mix.gain(v, 0.4);
  chop.connect(depth);
  depth.connect(grit.gain);
  grit.connect(v.out);
  mix.burst(v, { f0: 1300 * mix.vary(0.1), f1: 520, glide: len, q: 1.3, attack: 0.025, decay: len, gain: 0.5, dest: grit });
  mix.burst(v, { type: 'highpass', f0: 3200, q: 0.5, attack: 0.02, decay: len * 0.7, gain: 0.08, dest: grit });
  mix.finish(v);
}

function tackle(mix, d, o) {
  const v = open(mix, 'tackle', o, d.body ? 0.9 : 0.68);
  if (!v) return;
  const t = v.t0;
  mix.tone(v, { f0: 120 * mix.vary(0.08), f1: 46, glide: 0.09, decay: 0.16, gain: 0.8, attack: 0.002 });
  // Crunch: noise driven hard into a soft clipper, then rounded off.
  const crush = mix.shaper(v);
  const round = mix.filter(v, 'lowpass', 3200 * v.rate, 0.5);
  const level = mix.gain(v, 0.26);
  crush.connect(round);
  round.connect(level);
  level.connect(v.out);
  mix.burst(v, { f0: 1400 * mix.vary(0.15), q: 0.8, decay: 0.05, gain: 2.4, dest: crush });
  mix.burst(v, { f0: 900 * mix.vary(0.15), q: 0.9, at: t + 0.028, decay: 0.04, gain: 1.5, dest: crush });
  if (d.won) mix.tone(v, { type: 'triangle', f0: 1500, f1: 900, glide: 0.03, at: t + 0.01, decay: 0.04, gain: 0.1, attack: 0.001 });
  mix.finish(v);
}

function whiff(mix, d, o) {
  const v = open(mix, 'whiff', o, 0.5);
  if (!v) return;
  mix.burst(v, { f0: 1500 * mix.vary(0.1), f1: 420, glide: 0.14, q: 1.4, attack: 0.03, decay: 0.13, gain: 0.3 });
  mix.finish(v);
}

function dash(mix, d, o) {
  const v = open(mix, 'dash', o, d.mine ? 0.66 : 0.6);
  if (!v) return;
  mix.burst(v, { f0: 520 * mix.vary(0.1), f1: 2700, glide: 0.11, q: 1.2, attack: 0.05, decay: 0.12, gain: 0.34 });
  mix.tone(v, { f0: 300, f1: 640, glide: 0.1, attack: 0.03, decay: 0.09, gain: 0.07 });
  mix.finish(v);
}

/** Ball against a body: deflection (sharper) or an outfield block (heavier). */
function slap(kind) {
  const heavy = kind === 'block';
  return (mix, d, o) => {
    const v = open(mix, kind, o, lerp(0.35, 1, d.power));
    if (!v) return;
    mix.burst(v, { f0: (heavy ? 1300 : 1900) * mix.vary(0.15), q: 0.9, decay: lerp(0.03, 0.06, d.power), gain: 0.5 });
    mix.tone(v, {
      f0: (heavy ? 150 : 185) * mix.vary(0.08), f1: heavy ? 62 : 80, glide: 0.05,
      decay: lerp(0.05, 0.11, d.power), gain: heavy ? 0.6 : 0.42, attack: 0.002,
    });
    mix.finish(v);
  };
}

function wall(mix, d, o) {
  const v = open(mix, 'wall', o, lerp(0.25, 0.9, d.power));
  if (!v) return;
  mix.tone(v, { f0: 128 * mix.vary(0.1), f1: 64, glide: 0.05, decay: lerp(0.06, 0.13, d.power), gain: 0.6, attack: 0.002 });
  // The hollow of the boards: a narrow resonance, plus a little rattle on hard hits.
  mix.burst(v, { f0: 330 * mix.vary(0.12), q: 3, decay: lerp(0.05, 0.1, d.power), gain: 0.5 });
  mix.burst(v, { f0: 1100 * mix.vary(0.1), q: 1.5, decay: 0.02, gain: 0.1 + 0.15 * d.power });
  mix.finish(v);
}

function post(mix, d, o) {
  const v = open(mix, 'post', o, lerp(0.4, 1, d.power));
  if (!v) return;
  const f = 1180 * mix.vary(0.07);
  const ring = lerp(0.55, 1.15, d.power);
  // Inharmonic partials of a struck tube; the detuned pair beats so the ring shimmers.
  for (const [ratio, level, life] of [[1, 0.32, 1], [1.004, 0.2, 0.9], [2.76, 0.17, 0.62], [5.4, 0.08, 0.34]]) {
    mix.tone(v, { f0: f * ratio, attack: 0.001, decay: ring * life, gain: level });
  }
  mix.burst(v, { type: 'highpass', f0: 3000, q: 0.7, decay: 0.012, gain: 0.3 });
  mix.tone(v, { f0: 210, f1: 120, glide: 0.04, decay: 0.07, gain: 0.35, attack: 0.002 });
  mix.finish(v);
}

function net(mix, d, o) {
  const v = open(mix, 'net', o, lerp(0.35, 0.8, d.power));
  if (!v) return;
  mix.burst(v, { f0: 3600 * mix.vary(0.1), f1: 1300, glide: 0.25, q: 0.8, attack: 0.03, decay: 0.3, gain: 0.3 });
  mix.burst(v, { f0: 2400, f1: 900, glide: 0.3, q: 0.9, at: v.t0 + 0.05, attack: 0.04, decay: 0.32, gain: 0.16 });
  mix.finish(v);
}

function keeperCatch(mix, d, o) {
  const v = open(mix, 'catch', o, lerp(0.5, 1, d.power));
  if (!v) return;
  // Two gloves closing on the ball a moment apart.
  mix.burst(v, { type: 'lowpass', f0: 1700 * mix.vary(0.1), q: 0.8, decay: 0.045, gain: 0.55 });
  mix.burst(v, { type: 'lowpass', f0: 1300, q: 0.8, at: v.t0 + 0.018, decay: 0.035, gain: 0.3 });
  mix.tone(v, { f0: 165 * mix.vary(0.08), f1: 82, glide: 0.05, decay: 0.09, gain: 0.5, attack: 0.002 });
  mix.finish(v);
}

function parry(mix, d, o) {
  const v = open(mix, 'parry', o, lerp(0.5, 1, d.power));
  if (!v) return;
  mix.burst(v, { f0: 2100 * mix.vary(0.12), q: 0.9, decay: 0.04, gain: 0.6 });
  mix.tone(v, { f0: 210 * mix.vary(0.08), f1: 105, glide: 0.04, decay: 0.07, gain: 0.4, attack: 0.002 });
  mix.finish(v);
}

function dive(mix, d, o) {
  const v = open(mix, 'dive', o, 0.45);
  if (!v) return;
  mix.burst(v, { f0: 380 * mix.vary(0.1), f1: 1100, glide: 0.1, q: 1, attack: 0.06, decay: 0.16, gain: 0.3 });
  mix.finish(v);
}

/** Recipes by sound kind (see params.describeEvent). */
export const SFX = Object.freeze({
  kick, pass, trap, steal, slide, tackle, whiff, dash,
  deflect: slap('deflect'), block: slap('block'),
  wall, post, net, catch: keeperCatch, parry, dive,
});
