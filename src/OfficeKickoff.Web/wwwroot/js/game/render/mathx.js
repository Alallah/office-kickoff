// Numeric helpers for the renderer. Pure: no canvas, no DOM, so everything here is unit-testable.

export const TAU = Math.PI * 2;

export function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

export function clamp01(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

export function lerp(a, b, t) {
  return a + (b - a) * t;
}

/** Where v sits between a and b, clamped to 0..1 (0 for an empty range). Works for a > b too. */
export function invLerp(a, b, v) {
  if (a === b) return 0;
  return clamp01((v - a) / (b - a));
}

export function smoothstep(e0, e1, x) {
  const t = invLerp(e0, e1, x);
  return t * t * (3 - 2 * t);
}

/** v when it is a finite number, otherwise the fallback. Views and events come off the network. */
export function num(v, fallback = 0) {
  return typeof v === 'number' && v - v === 0 ? v : fallback;
}

/** True for a finite number (not NaN, not infinite, not a numeric string). */
export function isNum(v) {
  return typeof v === 'number' && v - v === 0;
}

/** Frame-rate independent exponential approach of current towards target. */
export function approach(current, target, rate, dt) {
  return target + (current - target) * Math.exp(-rate * dt);
}

/** Shortest signed angle from a to b, in (-PI, PI]. */
export function angleDelta(a, b) {
  let d = (b - a) % TAU;
  if (d > Math.PI) d -= TAU;
  else if (d <= -Math.PI) d += TAU;
  return d;
}

export const ease = Object.freeze({
  outQuad: (t) => 1 - (1 - t) * (1 - t),
  outCubic: (t) => 1 - (1 - t) * (1 - t) * (1 - t),
  outQuint: (t) => 1 - Math.pow(1 - t, 5),
  inQuad: (t) => t * t,
  inCubic: (t) => t * t * t,
  inOutQuad: (t) => (t < 0.5 ? 2 * t * t : 1 - (2 - 2 * t) * (2 - 2 * t) / 2),
  /** Overshoots to about 1.1 before settling on 1. */
  outBack: (t) => {
    const u = t - 1;
    return 1 + 2.70158 * u * u * u + 1.70158 * u * u;
  },
  /** Springy settle on 1 (a few decaying wobbles). */
  outElastic: (t) => {
    if (t <= 0) return 0;
    if (t >= 1) return 1;
    return Math.pow(2, -10 * t) * Math.sin((t * 10 - 0.75) * (TAU / 3)) + 1;
  },
});

/**
 * Advances a damped spring {x, v} towards target. Sub-stepped so one long frame cannot make it
 * explode.
 */
export function springStep(s, target, stiffness, damping, dt) {
  let left = dt;
  while (left > 0) {
    const h = left > 0.008 ? 0.008 : left;
    s.v += ((target - s.x) * stiffness - s.v * damping) * h;
    s.x += s.v * h;
    left -= h;
  }
}

/** Deterministic integer hash to 0..1. */
export function hash01(n) {
  let h = Math.imul(n | 0, 0x9e3779b1);
  h ^= h >>> 15;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** Seeded generator (mulberry32) returning 0..1; used wherever a layout must be the same every build. */
export function makeRng(seed) {
  let a = seed >>> 0;
  return function rng() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Smooth pseudo-noise in about -1..1: three incommensurate sines. Good enough for camera shake. */
export function wobble(t, seed) {
  return (
    Math.sin(t + seed * 12.9898) +
    Math.sin(t * 2.31 + seed * 78.233) * 0.6 +
    Math.sin(t * 4.73 + seed * 37.719) * 0.35
  ) / 1.95;
}

/**
 * Linear part (a, b, c, d of a canvas transform) of a footballer's pose: the sprite is scaled by
 * (kx, ky), rotated by spin, then stretched by sa along direction dir and by sb across it. The
 * stretch is symmetric, so with spin = 0 a shirt number squashes but stays upright.
 */
export function poseMatrix(dir, sa, sb, spin, kx, ky, out) {
  const cs = Math.cos(dir), sn = Math.sin(dir);
  const m11 = sa * cs * cs + sb * sn * sn;
  const m12 = (sa - sb) * sn * cs;
  const m22 = sa * sn * sn + sb * cs * cs;
  const c2 = Math.cos(spin), s2 = Math.sin(spin);
  out.a = (m11 * c2 + m12 * s2) * kx;
  out.b = (m12 * c2 + m22 * s2) * kx;
  out.c = (m12 * c2 - m11 * s2) * ky;
  out.d = (m22 * c2 - m12 * s2) * ky;
  return out;
}

/**
 * Rotates the unit vectors packed in pts (x, y, z triples) the way a ball of the given radius
 * turns when it rolls by (dx, dy) on the ground seen from above, plus a twist about the vertical.
 */
export function rollPoints(pts, dx, dy, radius, twist) {
  const dist = Math.sqrt(dx * dx + dy * dy);
  const n = pts.length;
  if (dist > 1e-4 && radius > 0) {
    // Axis lies in the ground plane, at right angles to the travel direction.
    const kx = -dy / dist, ky = dx / dist;
    const ang = dist / radius;
    const c = Math.cos(ang), s = Math.sin(ang);
    for (let i = 0; i < n; i += 3) {
      const px = pts[i], py = pts[i + 1], pz = pts[i + 2];
      const dot = (kx * px + ky * py) * (1 - c);
      pts[i] = px * c + ky * pz * s + kx * dot;
      pts[i + 1] = py * c - kx * pz * s + ky * dot;
      pts[i + 2] = pz * c + (kx * py - ky * px) * s;
    }
  }
  if (twist !== 0) {
    const c = Math.cos(twist), s = Math.sin(twist);
    for (let i = 0; i < n; i += 3) {
      const px = pts[i], py = pts[i + 1];
      pts[i] = px * c - py * s;
      pts[i + 1] = px * s + py * c;
    }
  }
  // Many small rotations drift off the unit sphere; pull the points back.
  for (let i = 0; i < n; i += 3) {
    const l = Math.sqrt(pts[i] * pts[i] + pts[i + 1] * pts[i + 1] + pts[i + 2] * pts[i + 2]);
    if (l > 1e-6) {
      pts[i] /= l;
      pts[i + 1] /= l;
      pts[i + 2] /= l;
    }
  }
}
