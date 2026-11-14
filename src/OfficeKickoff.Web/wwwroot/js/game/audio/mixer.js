// Output graph and one-shot voice management.
//
//   voices -> world ----------------------------.
//   replayed voices -> replay (quiet, low-pass) -> world
//   crowd bed -> bed -> duck -> crowd -----------+-> master -> limiter -> destination
//   roars and stand sounds -> crowd -------------|
//   interface sounds -> ui ---------------------'
//
// A "voice" is one triggered sound: a handful of sources and shaping nodes behind a single output
// gain. Every voice is stopped and disconnected when it ends, and the number playing at once is
// capped. Only ordinary nodes are used: AudioWorklet does not exist on plain-http pages.

import {
  SAFETY_RANGE, clamp, num, chooseVictim, fillWhite, fillPink, fillCrackle, loopBlend, safetyCurve, shaperCurve,
} from './params.js';

export const MAX_VOICES = 22;

/** An envelope's decay time is the time it takes to fall by this factor (60 dB). */
const DECAY_FLOOR = 1e-3;
/** How far a held envelope sags before it is released. */
const HOLD_SAG = 0.75;

/** @param {AudioContext} ctx */
export function createMixer(ctx) {
  const sampleRate = ctx.sampleRate;
  const maxFreq = sampleRate * 0.45;
  const rnd = Math.random;
  const hz = (f) => clamp(num(f, 440), 20, maxFreq);
  const canPan = typeof ctx.createStereoPanner === 'function';

  const gainNode = (value) => {
    const g = ctx.createGain();
    g.gain.value = value;
    return g;
  };

  // The master gain starts silent; the engine ramps it to the user's volume.
  const master = gainNode(0);
  const limiter = ctx.createDynamicsCompressor();
  // Browsers add make-up gain from this curve (about +4 dB here), so the master runs with real
  // headroom and the fast attack catches most of the peak when a goal lands on a scramble.
  limiter.threshold.value = -12;
  limiter.knee.value = 6;
  limiter.ratio.value = 12;
  limiter.attack.value = 0.001;
  limiter.release.value = 0.2;
  // The few transients that slip past the attack are rounded off by a soft clipper that is a
  // straight line below -2.5 dBFS, so it never colours ordinary playing levels.
  const clipIn = gainNode(1 / SAFETY_RANGE);
  const clip = ctx.createWaveShaper();
  clip.curve = safetyCurve(2048);
  master.connect(limiter);
  limiter.connect(clipIn);
  clipIn.connect(clip);
  clip.connect(ctx.destination);

  const world = gainNode(1);
  const crowd = gainNode(1);
  const ui = gainNode(1);
  world.connect(master);
  crowd.connect(master);
  ui.connect(master);

  const bed = gainNode(1);
  const duck = gainNode(1);
  bed.connect(duck);
  duck.connect(crowd);

  const replay = gainNode(0.45);
  const replayTone = ctx.createBiquadFilter();
  replayTone.type = 'lowpass';
  replayTone.frequency.value = Math.min(2000, maxFreq);
  replayTone.Q.value = 0;
  replay.connect(replayTone);
  replayTone.connect(world);

  const buses = { world, crowd, bed, ui, replay };

  // Noise is generated once and shared by every voice (each plays it from a random offset).
  function makeBuffer(seconds, fill, fadeSeconds = 0) {
    const data = new Float32Array(Math.max(2, Math.floor(seconds * sampleRate)));
    fill(data);
    const length = fadeSeconds > 0 ? loopBlend(data, Math.floor(fadeSeconds * sampleRate)) : data.length;
    const buffer = ctx.createBuffer(1, length, sampleRate);
    buffer.getChannelData(0).set(data.subarray(0, length));
    return buffer;
  }
  const white = makeBuffer(1.5, (d) => fillWhite(d, rnd));
  const pink = makeBuffer(5.2, (d) => fillPink(d, rnd), 0.2);
  const crackle = makeBuffer(1.2, (d) => fillCrackle(d, rnd, sampleRate));
  const crunchCurve = shaperCurve(1024, 3.5);

  const voices = []; // every voice whose nodes are still connected
  let live = 0;      // of those, the ones not already being faded out

  /**
   * Opens a voice, or returns null when the mix is full of more important sounds.
   * @param {string} kind
   * @param {{gain?:number, pan?:number, bus?:string, priority?:number, rate?:number, delay?:number}} [o]
   *        pan places the voice in the stereo field (omit it for sounds that are not in the world);
   *        rate scales every pitch of the voice (slow motion); delay postpones its start.
   */
  function begin(kind, o = {}) {
    const priority = o.priority ?? 1;
    const now = ctx.currentTime;
    if (live >= MAX_VOICES) {
      const candidates = voices.filter((v) => !v.dying);
      const victim = chooseVictim(candidates, now, priority);
      if (victim < 0) return null;
      kill(candidates[victim]);
    }
    const level = Math.max(0, num(o.gain, 1));
    const out = gainNode(level);
    const nodes = [out];
    let tail = out;
    if (o.pan !== undefined) {
      // Equal-power panning puts a centred sound 3 dB down in each channel, so every placed voice
      // goes through a panner (or the same 3 dB) and its loudness does not depend on where it is.
      if (canPan) {
        const panner = ctx.createStereoPanner();
        panner.pan.value = clamp(num(o.pan), -1, 1);
        out.connect(panner);
        nodes.push(panner);
        tail = panner;
      } else {
        out.gain.value = level * Math.SQRT1_2;
      }
    }
    tail.connect(buses[o.bus] || world);
    const t0 = now + Math.max(0, num(o.delay));
    const v = {
      kind, priority, level, t0, end: t0, rate: clamp(num(o.rate, 1), 0.25, 4),
      out, nodes, sources: [], dying: false, done: false,
    };
    voices.push(v);
    live++;
    return v;
  }

  const extend = (v, t) => {
    if (t > v.end) v.end = t;
  };

  /**
   * Percussive envelope on a gain parameter that is otherwise 0: a linear attack, an optional
   * hold (sagging a little, for sounds that last as long as an action) and an exponential decay.
   * `decay` is the time to fall 60 dB, whatever the peak, so levels can be changed without
   * changing the shape. Returns the time the envelope is over.
   */
  function env(param, at, peak, attack, decay, hold = 0) {
    const top = Math.max(peak, 1e-5);
    let t = at + attack;
    param.setValueAtTime(0, at);
    param.linearRampToValueAtTime(top, t);
    if (hold > 0) {
      t += hold;
      param.exponentialRampToValueAtTime(top * HOLD_SAG, t);
    }
    t += decay;
    param.exponentialRampToValueAtTime(top * DECAY_FLOOR, t);
    return t;
  }

  /** Glide a parameter from one positive value to another. */
  function sweep(param, from, to, at, time) {
    param.setValueAtTime(from, at);
    if (to !== from && time > 0) param.exponentialRampToValueAtTime(to, at + time);
  }

  /**
   * Piecewise envelope from [seconds after `at`, value] points in time order. A segment is
   * exponential when both of its ends are positive, linear otherwise. Only ramps are used (never
   * setTarget), so each segment starts exactly where the previous one ended.
   */
  function shape(param, at, points) {
    let prev = points[0][1];
    param.setValueAtTime(prev, at + points[0][0]);
    for (let i = 1; i < points.length; i++) {
      const [offset, value] = points[i];
      if (prev > 0 && value > 0) param.exponentialRampToValueAtTime(value, at + offset);
      else param.linearRampToValueAtTime(value, at + offset);
      prev = value;
    }
  }

  function osc(v, type, freq, at = v.t0) {
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(hz(freq), at);
    o.start(at);
    v.sources.push(o);
    v.nodes.push(o);
    return o;
  }

  /** A slow sine added to a parameter (tremolo, drift). Unlike osc() the rate may be sub-audio. */
  function lfo(v, rate, depth, param, at = v.t0) {
    const o = ctx.createOscillator();
    o.frequency.value = clamp(num(rate, 1), 0.01, 200);
    const d = gainNode(depth);
    o.connect(d);
    d.connect(param);
    o.start(at);
    v.sources.push(o);
    v.nodes.push(o, d);
    return o;
  }

  function noise(v, buffer = white, at = v.t0, rate = 1) {
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.loop = true;
    src.playbackRate.value = rate;
    src.start(at, rnd() * Math.max(0, buffer.duration - 0.05));
    v.sources.push(src);
    v.nodes.push(src);
    return src;
  }

  function gain(v, value = 0) {
    const g = gainNode(value);
    v.nodes.push(g);
    return g;
  }

  function filter(v, type, freq, q = 1) {
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = hz(freq);
    f.Q.value = q;
    v.nodes.push(f);
    return f;
  }

  function shaper(v) {
    const s = ctx.createWaveShaper();
    s.curve = crunchCurve;
    v.nodes.push(s);
    return s;
  }

  /**
   * A place inside a voice's own stereo image: returns a node to connect a layer to. Used to
   * spread the layers of big sounds (a roar) instead of stacking them on one point.
   */
  function place(v, pan) {
    if (!canPan) return v.out;
    const panner = ctx.createStereoPanner();
    panner.pan.value = clamp(num(pan), -1, 1);
    panner.connect(v.out);
    v.nodes.push(panner);
    return panner;
  }

  /**
   * An enveloped oscillator, optionally gliding in pitch.
   * @param {{type?:string, f0:number, f1?:number, glide?:number, at?:number, attack?:number,
   *          hold?:number, decay?:number, gain?:number, dest?:AudioNode}} o
   */
  function tone(v, o) {
    const at = o.at ?? v.t0;
    const attack = o.attack ?? 0.004;
    const decay = o.decay ?? 0.1;
    const f0 = hz(o.f0 * v.rate);
    const f1 = hz((o.f1 ?? o.f0) * v.rate);
    const source = osc(v, o.type || 'sine', f0, at);
    if (f1 !== f0) source.frequency.exponentialRampToValueAtTime(f1, at + (o.glide ?? decay * 0.5));
    const g = gain(v);
    const end = env(g.gain, at, o.gain ?? 0.3, attack, decay, o.hold ?? 0);
    source.connect(g);
    g.connect(o.dest || v.out);
    extend(v, end + 0.02);
    return { osc: source, gain: g };
  }

  /**
   * An enveloped burst of filtered noise, optionally sweeping the filter.
   * @param {{buffer?:AudioBuffer, type?:string, f0?:number, f1?:number, glide?:number, q?:number,
   *          at?:number, attack?:number, hold?:number, decay?:number, gain?:number, rate?:number,
   *          dest?:AudioNode}} o
   *        type null = unfiltered.
   */
  function burst(v, o) {
    const at = o.at ?? v.t0;
    const attack = o.attack ?? 0.002;
    const decay = o.decay ?? 0.05;
    const hold = o.hold ?? 0;
    const source = noise(v, o.buffer || white, at, o.rate ?? 1);
    const g = gain(v);
    const end = env(g.gain, at, o.gain ?? 0.3, attack, decay, hold);
    let filt = null;
    if (o.type !== null) {
      const f0 = hz((o.f0 ?? 1000) * v.rate);
      const f1 = hz((o.f1 ?? o.f0 ?? 1000) * v.rate);
      filt = filter(v, o.type || 'bandpass', f0, o.q ?? 1);
      sweep(filt.frequency, f0, f1, at, o.glide ?? attack + hold + decay * 0.5);
      source.connect(filt);
      filt.connect(g);
    } else {
      source.connect(g);
    }
    g.connect(o.dest || v.out);
    extend(v, end + 0.02);
    return { source, filter: filt, gain: g };
  }

  /** Call once the voice is fully built: schedules the end of every source and the clean-up. */
  function finish(v, end) {
    if (end !== undefined) extend(v, end);
    for (const s of v.sources) {
      try {
        s.stop(v.end);
      } catch {
        /* never started */
      }
    }
    if (v.sources.length) v.sources[0].onended = () => dispose(v);
    else dispose(v);
  }

  function dispose(v) {
    if (v.done) return;
    v.done = true;
    if (!v.dying) live--;
    for (const s of v.sources) {
      s.onended = null;
      try {
        s.stop();
      } catch {
        /* already stopped */
      }
    }
    for (const n of v.nodes) {
      try {
        n.disconnect();
      } catch {
        /* already disconnected */
      }
    }
    const i = voices.indexOf(v);
    if (i >= 0) voices.splice(i, 1);
  }

  /** Fades a voice out quickly (no click) and lets it clean itself up. */
  function kill(v, timeConstant = 0.012) {
    if (v.done || v.dying) return;
    v.dying = true;
    live--;
    const now = ctx.currentTime;
    try {
      v.out.gain.cancelScheduledValues(now);
      v.out.gain.setTargetAtTime(0, now, timeConstant);
    } catch {
      /* fall through to the stop */
    }
    v.end = now + timeConstant * 6 + 0.01;
    for (const s of v.sources) {
      try {
        s.stop(v.end);
      } catch {
        /* never started */
      }
    }
    if (!v.sources.length) dispose(v);
  }

  function killAll(timeConstant = 0.03) {
    for (const v of voices.slice()) kill(v, timeConstant);
  }

  /** Safety net for voices whose "ended" event never arrived (or that were never finished). */
  function sweepEnded(now) {
    for (let i = voices.length - 1; i >= 0; i--) {
      if (now > voices[i].end + 0.3) dispose(voices[i]);
    }
  }

  let duckDepth = 1;
  let duckUntil = 0;

  /** Dips the crowd bed to `depth` (0..1) for `hold` seconds; overlapping dips keep the deepest and longest. */
  function duckBed(depth, hold) {
    const now = ctx.currentTime;
    const active = now < duckUntil;
    const until = Math.max(now + hold, active ? duckUntil : 0);
    const target = Math.min(clamp(depth, 0, 1), active ? duckDepth : 1);
    if (active && target === duckDepth && until === duckUntil) return;
    duckDepth = target;
    duckUntil = until;
    duck.gain.cancelScheduledValues(now);
    duck.gain.setTargetAtTime(target, now, 0.015);
    duck.gain.setTargetAtTime(1, until, 0.22);
  }

  /** Short ramp so volume and mute changes never click. */
  function setMaster(value, timeConstant = 0.02) {
    const now = ctx.currentTime;
    master.gain.cancelScheduledValues(now);
    master.gain.setTargetAtTime(clamp(num(value), 0, 1), now, timeConstant);
  }

  return {
    ctx, buses, white, pink, crackle, rnd, hz,
    /** 1 +- amount, for varying each trigger a little. */
    vary: (amount) => 1 + (rnd() * 2 - 1) * amount,
    begin, finish, kill, killAll, sweepEnded, extend,
    env, sweep, shape, osc, lfo, noise, gain, filter, shaper, place, tone, burst,
    duckBed, setMaster,
    stats: () => ({ voices: voices.length, live }),
  };
}
