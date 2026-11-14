// The server's world as the browser knows it: a buffer of decoded snapshots, an estimate of
// server time, a smooth render clock that runs a little behind it, interpolation of everything
// between the two snapshots around that clock, and the events waiting for the clock to reach them.
//
// Times are server seconds (tick / 60) unless a name says "now" or "arrival" (wall seconds).
// Pure: no DOM, no clocks of its own - the caller passes wall time in.

import { EVT, PHASE, TICK_RATE } from '../shared/protocol.js';
import { CONFIG } from './config.js';
import { advanceFreeBall, newBall } from './ballphys.js';
import { clamp, clampCircle, finite, lerp, lerpAngle } from './geom.js';

/** A reusable interpolated world (see createTimeline().sample). */
export function newWorld() {
  return {
    /** Snapshot at or before the sampled time, and the one after it (null when extrapolating). */
    snap: null,
    next: null,
    alpha: 0,
    /** Timeline position actually shown (the sampled time, or less while the picture holds). */
    time: 0,
    phase: PHASE.INTRO,
    phaseTime: 0,
    clock: 0,
    score: [0, 0],
    overtime: false,
    slowMo: false,
    ball: { x: 0, y: 0, vx: 0, vy: 0, spin: 0, owner: -1, heat: 0, held: false, dead: false },
    players: [],
  };
}

function newPose() {
  return { x: 0, y: 0, vx: 0, vy: 0, aim: 0, action: 0, actionT: 0, actionDir: 0, stamina: 1, charge: 0, ctrl: -1, cd: 0, flags: 0 };
}

function movesIn(phase) {
  return phase === PHASE.PLAYING || phase === PHASE.GOAL || phase === PHASE.FULL_TIME;
}

/**
 * @param {typeof CONFIG.net} net
 */
export function createTimeline(net = CONFIG.net) {
  /** Decoded snapshots, ascending by tick. Each gets .time, .arrival and .teleport on insert. */
  const snaps = [];
  let env = null;

  // ---- server time ---------------------------------------------------------------------------
  const ring = new Float64Array(Math.max(4, net.offsetWindow));
  const sorted = [];
  let samples = 0;
  let head = 0;
  /** The latest run of samples that disagree with the estimate (see addSample). */
  const stray = new Float64Array(Math.max(2, net.stepSamples));
  let strays = 0;
  let bufferSeconds = net.bufferSeconds;
  /** Server time minus wall time, as estimated from snapshot arrivals. */
  let offset = 0;
  let hasClock = false;
  let delay = 0;
  let interval = 2 / TICK_RATE;
  let lastArrival = -Infinity;

  // ---- render clock --------------------------------------------------------------------------
  let renderTime = 0;
  let running = false;
  /** Events of snapshots up to this tick have been handed out (or deliberately dropped). */
  let cursorTick = -1;
  let skipEvents = false;

  const clampOut = { x: 0, y: 0 };
  const freeBall = newBall();

  function defaultDelay() {
    return clamp(interval * net.delayDefaultIntervals, net.delayMin, net.delayMax);
  }

  function clearClock() {
    samples = 0;
    head = 0;
    strays = 0;
  }

  // A run of samples that all sit far from the estimate AND agree with each other means the
  // server's timeline itself moved against this machine's clock (the server stalled, this
  // machine slept). Averaging the two eras would send the render clock wandering for seconds,
  // so the estimate starts over from the run. A burst of delayed packets does not qualify: its
  // samples creep back towards the estimate, so they do not agree with each other.
  function steppedTo(value) {
    if (!hasClock || Math.abs(value - offset) <= net.stepError) {
      strays = 0;
      return false;
    }
    if (strays === stray.length) {
      stray.copyWithin(0, 1);
      strays--;
    }
    stray[strays++] = value;
    if (strays < stray.length) return false;
    let lo = stray[0];
    let hi = stray[0];
    for (let i = 1; i < strays; i++) {
      if (stray[i] < lo) lo = stray[i];
      if (stray[i] > hi) hi = stray[i];
    }
    return hi - lo <= net.stepSpread;
  }

  function reset() {
    snaps.length = 0;
    clearClock();
    hasClock = false;
    offset = 0;
    delay = defaultDelay();
    lastArrival = -Infinity;
    renderTime = 0;
    running = false;
    cursorTick = -1;
    skipEvents = false;
  }

  function addSample(value) {
    if (steppedTo(value)) {
      // Keep the run (it ends with this sample) as the whole history.
      samples = 0;
      head = 0;
      for (let i = 0; i < strays - 1; i++) {
        ring[head] = stray[i];
        head = (head + 1) % ring.length;
        samples++;
      }
      strays = 0;
    }

    ring[head] = value;
    head = (head + 1) % ring.length;
    if (samples < ring.length) samples++;

    sorted.length = samples;
    for (let i = 0; i < samples; i++) sorted[i] = ring[i];
    sorted.sort((a, b) => a - b);

    // Mean of the middle half: a late packet or two cannot move it, and neither can snapshots
    // that arrive in pairs.
    const lo = Math.floor(samples / 4);
    const hi = samples - lo;
    let sum = 0;
    for (let i = lo; i < hi; i++) sum += sorted[i];
    offset = sum / (hi - lo);
    hasClock = true;

    if (samples >= net.minSamples) {
      // Packets are only ever late, so the slow tail of the window is what the delay must cover.
      const late = Math.max(0, offset - sorted[Math.floor(samples * 0.1)]);
      const target = clamp(interval * net.delayIntervals + late * net.delayJitterGain, net.delayMin, net.delayMax);
      delay += (target - delay) * (target > delay ? net.delayRise : net.delayFall);
    }
  }

  /** Index of the last snapshot with time <= t, or -1. */
  function indexAt(t) {
    let lo = 0;
    let hi = snaps.length - 1;
    let found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (snaps[mid].time <= t) {
        found = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return found;
  }

  function simScale(snap) {
    return env ? env.gameSpeed * (snap.slowMo ? env.slowScale : 1) : 1;
  }

  /**
   * Ball between snapshots a and b (b may be null: `extra` seconds past a, already capped).
   * `hold` forces a's values (teleport between the two).
   */
  function fillBall(a, b, alpha, hold, extra, out) {
    const ba = a.ball;
    out.owner = ba.owner;
    out.held = ba.held;
    out.dead = ba.dead;
    if (b) {
      const bb = b.ball;
      const dx = bb.x - ba.x;
      const dy = bb.y - ba.y;
      const k = hold || dx * dx + dy * dy > net.teleportDistance * net.teleportDistance ? 0 : alpha;
      out.x = ba.x + dx * k;
      out.y = ba.y + dy * k;
      out.vx = lerp(ba.vx, bb.vx, k);
      out.vy = lerp(ba.vy, bb.vy, k);
      out.spin = lerp(ba.spin, bb.spin, k);
      out.heat = lerp(ba.heat, bb.heat, k);
      return out;
    }

    out.x = ba.x;
    out.y = ba.y;
    out.vx = ba.vx;
    out.vy = ba.vy;
    out.spin = ba.spin;
    out.heat = ba.heat;
    if (!(extra > 0) || ba.dead || !env || !movesIn(a.phase)) return out;

    const t = extra * simScale(a);
    if (ba.owner >= 0 && ba.owner < a.players.length) {
      // Carried: it goes where its owner goes.
      const o = a.players[ba.owner];
      out.x += o.vx * t;
      out.y += o.vy * t;
    } else if (ba.owner < 0) {
      freeBall.x = ba.x;
      freeBall.y = ba.y;
      freeBall.vx = ba.vx;
      freeBall.vy = ba.vy;
      freeBall.spin = ba.spin;
      freeBall.heat = ba.heat;
      freeBall.net = 0;
      advanceFreeBall(freeBall, t, env.dt, env.tuning, env.pitch);
      out.x = freeBall.x;
      out.y = freeBall.y;
      out.vx = freeBall.vx;
      out.vy = freeBall.vy;
      out.spin = freeBall.spin;
      out.heat = freeBall.heat;
    }
    return out;
  }

  return {
    /**
     * New match.
     * @param e { tuning, pitch, gameSpeed, slowScale, dt (simulation seconds per tick),
     *            bufferSeconds? (history a goal replay needs, when that is more than the default) }
     */
    configure(e) {
      env = e;
      interval = Math.max(1, finite(e.tuning.snapshotEveryTicks, 2)) / TICK_RATE;
      bufferSeconds = Math.max(net.bufferSeconds, finite(e.bufferSeconds, 0));
      reset();
    },

    /** Forget everything (new match: its ticks start over). */
    reset,

    get count() { return snaps.length; },
    get latest() { return snaps.length ? snaps[snaps.length - 1] : null; },
    get oldest() { return snaps.length ? snaps[0] : null; },
    get renderTime() { return renderTime; },
    get hasClock() { return hasClock; },
    /** Current interpolation delay in seconds. */
    get delay() { return delay; },
    get offset() { return offset; },
    /** Wall time the newest snapshot arrived at (-Infinity before the first). */
    get lastArrival() { return lastArrival; },

    /**
     * Inserts a decoded snapshot that arrived at wall time `now`.
     * @returns {boolean} false when it was a duplicate or out of order
     */
    push(snap, now) {
      const last = snaps.length ? snaps[snaps.length - 1] : null;
      if (last && snap.tick <= last.tick) {
        if (last.tick - snap.tick < net.restartGapTicks) return false;
        // The server's ticks started over without a MatchInit reaching us first.
        reset();
      }

      snap.time = snap.tick / TICK_RATE;
      snap.arrival = now;
      snap.teleport = false;
      for (let i = 0; i < snap.events.length; i++) {
        const e = snap.events[i];
        if (e.type === EVT.PHASE_CHANGE && e.f === PHASE.KICKOFF) snap.teleport = true;
      }
      snaps.push(snap);

      // Prune here, not in the frame loop: a hidden tab receives snapshots but renders nothing.
      const minTick = snap.tick - bufferSeconds * TICK_RATE;
      let drop = 0;
      while (drop < snaps.length - 2 && snaps[drop].tick < minTick) drop++;
      if (drop > 0) snaps.splice(0, drop);

      lastArrival = now;
      addSample(snap.time - now);
      return true;
    },

    /**
     * Advances the render clock by `dt` wall seconds towards (server time - delay). It slews by a
     * few percent to stay on target and jumps only when it is far off.
     * @returns {number} the render time
     */
    advance(now, dt) {
      if (!hasClock) return renderTime;
      const target = now + offset - delay;
      if (!running) {
        renderTime = target;
        running = true;
      } else {
        const err = target - renderTime;
        if (Math.abs(err) > net.snapError) renderTime = target;
        else renderTime += dt * (1 + clamp(err * net.slewGain, -net.slewMax, net.slewMax));
      }

      if (skipEvents) {
        skipEvents = false;
        const i = indexAt(renderTime);
        if (i >= 0 && snaps[i].tick > cursorTick) cursorTick = snaps[i].tick;
      }
      return renderTime;
    },

    /**
     * After the page was not rendering (hidden tab) or the connection was replaced: jump the clock
     * to the present, drop what happened meanwhile instead of replaying it, and discard the part
     * of the buffer that lies before a hole.
     */
    resync() {
      clearClock();
      running = false;
      skipEvents = true;
      for (let i = snaps.length - 1; i > 0; i--) {
        if (snaps[i].time - snaps[i - 1].time > net.holeSeconds) {
          snaps.splice(0, i);
          break;
        }
      }
    },

    /**
     * Calls visit(evt, snap) for every event the render clock has reached since the last call,
     * oldest first. Each event is handed out exactly once.
     */
    drainEvents(upTo, visit) {
      let i = snaps.length;
      while (i > 0 && snaps[i - 1].tick > cursorTick) i--;
      for (; i < snaps.length; i++) {
        const s = snaps[i];
        if (s.time > upTo) break;
        cursorTick = s.tick;
        for (let k = 0; k < s.events.length; k++) visit(s.events[k], s);
      }
    },

    /** Calls visit(evt, snap) for the events of every snapshot with after < time <= upTo. */
    eventsBetween(after, upTo, visit) {
      for (let i = indexAt(after) + 1; i < snaps.length; i++) {
        const s = snaps[i];
        if (s.time > upTo) break;
        for (let k = 0; k < s.events.length; k++) visit(s.events[k], s);
      }
    },

    /** Newest event accepted by `match` among the snapshots with time <= upTo, or null. */
    findLastEvent(upTo, match) {
      for (let i = indexAt(upTo); i >= 0; i--) {
        const s = snaps[i];
        for (let k = s.events.length - 1; k >= 0; k--) {
          if (match(s.events[k], s)) return s.events[k];
        }
      }
      return null;
    },

    /** Newest event accepted by `match` among the snapshots that arrived at or after `since`, or null. */
    findEventSince(since, match) {
      for (let i = snaps.length - 1; i >= 0; i--) {
        const s = snaps[i];
        if (s.arrival < since) break;
        for (let k = s.events.length - 1; k >= 0; k--) {
          if (match(s.events[k], s)) return s.events[k];
        }
      }
      return null;
    },

    /** True when a kickoff teleport lies after time t in the buffer. */
    teleportAfter(t) {
      for (let i = snaps.length - 1; i >= 0; i--) {
        const s = snaps[i];
        if (s.time <= t) break;
        if (s.teleport) return true;
      }
      return false;
    },

    /**
     * Fills `w` (newWorld) with the world at time t: positions interpolated linearly and angles
     * along the shortest arc between the two snapshots around t. Past the newest snapshot it
     * extrapolates from velocity for at most maxExtrapolate seconds, then holds. Never
     * interpolates across a teleport.
     * @returns the world, or null while the buffer is empty
     */
    sample(t, w) {
      const n = snaps.length;
      if (n === 0) return null;
      const i = indexAt(t);
      const a = i < 0 ? snaps[0] : snaps[i];
      const b = i >= 0 && i + 1 < n ? snaps[i + 1] : null;
      let alpha = 0;
      let extra = 0;
      let past = 0;
      if (b) {
        alpha = clamp((t - a.time) / (b.time - a.time), 0, 1);
      } else if (i >= 0) {
        past = t - a.time;
        extra = movesIn(a.phase) ? Math.min(past, net.maxExtrapolate) : 0;
      }
      const hold = b !== null && b.teleport;
      const k = hold ? 0 : alpha;

      w.snap = a;
      w.next = b;
      w.alpha = k;
      w.time = b ? (hold ? a.time : t) : a.time + extra;
      w.phase = a.phase;
      w.score = a.score;
      w.overtime = a.overtime;
      w.slowMo = a.slowMo;
      if (b) {
        w.phaseTime = b.phase === a.phase && b.phaseTime <= a.phaseTime ? lerp(a.phaseTime, b.phaseTime, k) : a.phaseTime;
        w.clock = b.phase === a.phase ? lerp(a.clock, b.clock, k) : a.clock;
      } else {
        // Countdowns keep counting through a short gap in the stream.
        const gap = Math.min(Math.max(0, past), net.maxExtrapolate);
        w.phaseTime = Math.max(0, a.phaseTime - gap);
        w.clock = a.clock;
      }

      const count = a.players.length;
      const players = w.players;
      while (players.length < count) players.push(newPose());
      players.length = count;
      const scale = extra > 0 ? extra * simScale(a) : 0;
      const tele2 = net.teleportDistance * net.teleportDistance;
      for (let p = 0; p < count; p++) {
        const pa = a.players[p];
        const out = players[p];
        out.action = pa.action;
        out.actionDir = pa.actionDir;
        out.ctrl = pa.ctrl;
        out.flags = pa.flags;
        const pb = b && p < b.players.length ? b.players[p] : null;
        if (pb) {
          const dx = pb.x - pa.x;
          const dy = pb.y - pa.y;
          const f = hold || dx * dx + dy * dy > tele2 ? 0 : alpha;
          out.x = pa.x + dx * f;
          out.y = pa.y + dy * f;
          out.vx = lerp(pa.vx, pb.vx, f);
          out.vy = lerp(pa.vy, pb.vy, f);
          out.aim = lerpAngle(pa.aim, pb.aim, f);
          out.stamina = lerp(pa.stamina, pb.stamina, f);
          // Values that count down interpolate; a jump back up belongs to the later snapshot.
          out.actionT = pb.action === pa.action && pb.actionT <= pa.actionT ? lerp(pa.actionT, pb.actionT, f) : pa.actionT;
          out.cd = pb.cd <= pa.cd ? lerp(pa.cd, pb.cd, f) : pa.cd;
          out.charge = pb.charge >= pa.charge ? lerp(pa.charge, pb.charge, f) : pa.charge;
        } else {
          out.x = pa.x;
          out.y = pa.y;
          if (scale > 0 && env) {
            clampCircle(env.pitch, pa.x + pa.vx * scale, pa.y + pa.vy * scale, env.tuning.player.radius, clampOut);
            out.x = clampOut.x;
            out.y = clampOut.y;
          }
          out.vx = pa.vx;
          out.vy = pa.vy;
          out.aim = pa.aim;
          out.stamina = pa.stamina;
          out.actionT = pa.actionT;
          out.cd = pa.cd;
          out.charge = pa.charge;
        }
      }

      fillBall(a, b, alpha, hold, extra, w.ball);
      return w;
    },

    /**
     * The ball alone at time t. Unlike sample() this may look up to `maxAhead` seconds past the
     * newest snapshot, following the free-ball rule (walls and posts, no footballers).
     * @returns `out` ({x, y, vx, vy, spin, owner, heat, held, dead}), or null while the buffer is empty
     */
    ballAt(t, maxAhead, out) {
      const n = snaps.length;
      if (n === 0) return null;
      const i = indexAt(t);
      if (i < 0) return fillBall(snaps[0], null, 0, false, 0, out);
      const a = snaps[i];
      if (i + 1 < n) {
        const b = snaps[i + 1];
        return fillBall(a, b, clamp((t - a.time) / (b.time - a.time), 0, 1), b.teleport, 0, out);
      }
      return fillBall(a, null, 0, false, clamp(t - a.time, 0, maxAhead), out);
    },
  };
}
