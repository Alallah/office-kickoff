// How a footballer's sprite is stretched, turned and lifted for every state and celebration.
// Pure: a pose is a handful of numbers that footballers.js feeds to mathx.poseMatrix.
//
//   dir, sa, sb   stretch by sa along direction dir and by sb across it
//   spin          rotation of the whole sprite (radians)
//   kx, ky        scale along the screen axes before the rotation (ky < 0 shows the flip side)
//   lift          height above the turf: the body is drawn that far up, the shadow stays down
//   ox, oy        sideways offset of body and shadow

import { ACTION, CELEBRATIONS, PLAYER_FLAG } from '../../shared/protocol.js';
import { clamp01, ease, TAU } from './mathx.js';
import { hop } from './fxmodel.js';

export const CELEB = Object.freeze({ SPIN: 0, DAB: 1, CONFETTI: 2, BACKFLIP: 3, SHOCKWAVE: 4, HEARTS: 5 });

export function createPose() {
  return { dir: 0, sa: 1, sb: 1, spin: 0, kx: 1, ky: 1, lift: 0, ox: 0, oy: 0 };
}

/** Index of a celebration name in the protocol's list, or -1. */
export function celebrationIndex(name) {
  return typeof name === 'string' ? CELEBRATIONS.indexOf(name) : -1;
}

/** The celebration an AI footballer performs: fixed per footballer so replays match. */
export function celebrationForIndex(playerIndex) {
  const n = CELEBRATIONS.length;
  return (((playerIndex | 0) % n) + n) % n;
}

/**
 * Pose for the footballer's own state (running, sliding, stunned, ...).
 * @param p  PlayerView-like: i, vx, vy, aim, action, actionT, actionDir, flags, charge (all finite)
 * @param t  effect clock, seconds
 * @param k  { sprintSpeed, slideTime, diveTime, recoverTime }
 */
export function statePose(out, p, t, k) {
  const speed = Math.sqrt(p.vx * p.vx + p.vy * p.vy);
  const run = clamp01(speed / k.sprintSpeed);
  out.dir = speed > 8 ? Math.atan2(p.vy, p.vx) : p.aim;
  out.sa = 1 + 0.07 * run;
  out.sb = 1 - 0.035 * run;
  out.spin = 0;
  out.kx = 1;
  out.ky = 1;
  out.lift = 0;
  out.ox = 0;
  out.oy = 0;

  switch (p.action) {
    case ACTION.SLIDE: {
      const done = 1 - clamp01(p.actionT / k.slideTime);
      out.dir = p.actionDir;
      out.sa = 1.52 - 0.14 * done;
      out.sb = 0.7 + 0.04 * done;
      return out;
    }
    case ACTION.DASH:
      out.dir = p.actionDir;
      out.sa = 1.3;
      out.sb = 0.84;
      return out;
    case ACTION.DIVE: {
      const left = clamp01(p.actionT / k.diveTime);
      out.dir = p.actionDir;
      out.sa = 1.25 + 0.35 * left;
      out.sb = 0.86 - 0.14 * left;
      return out;
    }
    case ACTION.STUNNED: {
      const jelly = 0.07 * Math.sin(t * 13 + p.i);
      out.sa = 1;
      out.sb = 1;
      out.spin = 0.2 * Math.sin(t * 9 + p.i * 2.1);
      out.kx = 1 + jelly;
      out.ky = 1 - jelly;
      return out;
    }
    case ACTION.RECOVER: {
      const left = clamp01(p.actionT / k.recoverTime);
      out.dir = p.actionDir;
      out.sa = 1 + 0.3 * left;
      out.sb = 1 - 0.16 * left;
      return out;
    }
    default:
      break;
  }

  if (p.flags & PLAYER_FLAG.SPRINTING) {
    out.sa = 1.14;
    out.sb = 0.92;
  }
  if (run > 0.05) {
    // Footsteps: a tiny bounce at running cadence.
    const step = 0.022 * Math.min(1, run * 2) * Math.sin(t * (11 + 9 * run) + p.i * 1.7);
    out.kx += step;
    out.ky += step;
  }
  if (p.flags & PLAYER_FLAG.CHARGING) {
    const c = clamp01(p.charge);
    const swell = 0.04 * c + 0.03 * c * Math.sin(t * 22);
    out.kx += swell;
    out.ky += swell;
  } else if (p.flags & PLAYER_FLAG.EXHAUSTED) {
    const pant = 0.035 * Math.sin(t * 7.5 + p.i);
    out.kx += pant;
    out.ky -= pant * 0.6;
  }
  return out;
}

/** Beat length of each celebration, seconds, indexed by CELEB. */
export const CELEB_PERIOD = Object.freeze([0.35, 0.7, 0.42, 1.0, 1.05, 0.26]);

/** Where in its beat a celebration's one-shot moment falls (the dab hit, the landing, the stomp). */
export const CELEB_ACCENT = Object.freeze([0, 0.12, 0, 0.78, 0.6, 0]);

/**
 * Number of accents that have happened by time t (0 before the first). The runtime compares it
 * with the previous frame's count to fire particles exactly once per beat.
 */
export function celebrationBeats(kind, t) {
  const period = CELEB_PERIOD[kind];
  if (!(period > 0) || !(t >= 0)) return 0;
  const first = CELEB_ACCENT[kind] * period;
  return t < first ? 0 : Math.floor((t - first) / period) + 1;
}

/**
 * 0..1 strength of the dab pose at time t, and which way it leans.
 * @returns {number} signed: negative leans left, positive right; magnitude is the strength
 */
export function dabStrike(t) {
  const period = CELEB_PERIOD[CELEB.DAB];
  const beat = Math.floor(t / period);
  const u = t / period - beat;
  const side = (beat & 1) === 0 ? -1 : 1;
  const e = u < 0.18 ? ease.outBack(u / 0.18) : u < 0.72 ? 1 : 1 - ease.inQuad((u - 0.72) / 0.28);
  return side * e;
}

/**
 * Overrides a pose with a celebration. t = seconds since it started (effect clock).
 * Every celebration loops for as long as it is asked for.
 */
export function celebrationPose(out, kind, t) {
  out.sa = 1;
  out.sb = 1;
  out.spin = 0;
  out.kx = 1;
  out.ky = 1;
  out.lift = 0;
  out.ox = 0;
  out.oy = 0;
  if (!(t >= 0)) return out;

  switch (kind) {
    case CELEB.SPIN: {
      // A top winding up: the turn rate ramps, the stretch axis turns with it so the wobble shows.
      const wind = 1 - Math.exp(-t * 3.5);
      const angle = 17 * t - 3.4 * wind;
      out.spin = angle;
      out.dir = angle;
      out.sa = 1 + 0.1 * wind;
      out.sb = 1 - 0.06 * wind;
      out.lift = 5 * wind * (1 + Math.sin(t * 8.5));
      break;
    }
    case CELEB.DAB: {
      const s = dabStrike(t);
      const e = Math.abs(s), side = s < 0 ? -1 : 1;
      out.dir = -Math.PI / 2 + side * 0.8;
      out.sa = 1 + 0.2 * e;
      out.sb = 1 - 0.1 * e;
      out.spin = side * 0.42 * e;
      out.ox = side * 3 * e;
      out.oy = -2 * e;
      break;
    }
    case CELEB.CONFETTI: {
      const u = t / CELEB_PERIOD[CELEB.CONFETTI];
      const f = u - Math.floor(u);
      const land = Math.exp(-f * 12);
      const air = Math.sin(Math.PI * f);
      out.lift = 16 * air;
      out.kx = 1 + 0.12 * land - 0.04 * air;
      out.ky = 1 - 0.16 * land + 0.08 * air;
      break;
    }
    case CELEB.BACKFLIP: {
      const u = t / CELEB_PERIOD[CELEB.BACKFLIP];
      const f = u - Math.floor(u);
      if (f < 0.16) {
        const c = Math.sin((f / 0.16) * Math.PI * 0.5);
        out.kx = 1 + 0.14 * c;
        out.ky = 1 - 0.22 * c;
      } else if (f < 0.78) {
        const a = (f - 0.16) / 0.62;
        out.lift = 208 * a * (1 - a);
        out.ky = Math.cos(TAU * a);
        // Never quite edge-on, so the footballer does not vanish for a frame.
        if (Math.abs(out.ky) < 0.08) out.ky = out.ky < 0 ? -0.08 : 0.08;
      } else {
        const c = (f - 0.78) / 0.22;
        const squash = Math.exp(-c * 5) * (1 - c);
        out.kx = 1 + 0.18 * squash;
        out.ky = 1 - 0.25 * squash;
      }
      break;
    }
    case CELEB.SHOCKWAVE: {
      const u = t / CELEB_PERIOD[CELEB.SHOCKWAVE];
      const f = u - Math.floor(u);
      let s;
      if (f < 0.6) {
        const c = f / 0.6;
        s = 1 - 0.2 * c + 0.03 * c * Math.sin(t * 60);
      } else if (f < 0.72) {
        s = 0.8 + 0.55 * ease.outCubic((f - 0.6) / 0.12);
      } else {
        s = 1.35 - 0.35 * ease.outCubic((f - 0.72) / 0.28);
      }
      out.kx = s;
      out.ky = s;
      break;
    }
    case CELEB.HEARTS: {
      const sway = Math.sin(t * 5.2);
      const beat = Math.max(0, Math.sin(t * 10.4));
      out.ox = 6 * sway;
      out.spin = 0.16 * sway;
      out.kx = 1 + 0.07 * beat;
      out.ky = 1 + 0.07 * beat;
      break;
    }
    default:
      break;
  }
  return out;
}

/** Team-mates of the scorer bounce on the spot. Adds to an existing pose. */
export function joyPose(out, t, playerIndex) {
  const h = hop(t * 8 + playerIndex * 1.3);
  out.lift += 10 * h;
  out.ky += 0.06 * h;
  return out;
}
