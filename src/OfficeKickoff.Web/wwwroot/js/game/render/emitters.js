// Particle recipes: every puff, spark, fleck and piece of confetti in the game is emitted here.
// Pure: the recipes only write into the particle pool of the runtime (R.P) and read colours from
// the match model (R.M.col), so they run headless.
//
// Conventions: positions and sizes in world units, speeds in units/s, angles in radians.
// `n` is the particle count at full density; R.density scales it (reduced motion).

import { clamp01, TAU } from './mathx.js';
import {
  emit, F_ADD, F_FADE_IN, F_LAND, F_SWAY, F_TOP, F_Z,
  K_FLAME, K_GLOW, K_HEART, K_PUFF, K_RECT, K_SOLID, K_STAR, K_STREAK,
} from './particles.js';

const rnd = Math.random;

/** n scaled by the particle density, rounded at random so small counts thin out evenly. */
export function amount(R, n) {
  const k = n * R.density;
  if (!(k > 0)) return 0;
  const whole = Math.floor(k);
  return whole + (rnd() < k - whole ? 1 : 0);
}

function pick(list) {
  return list[(rnd() * list.length) | 0];
}

/** Dust kicked up along `ang` (spread = full width of the fan). */
export function dust(R, x, y, ang, spread, speed, n, size) {
  const P = R.P, col = R.M.col.dust;
  for (let c = amount(R, n); c > 0; c--) {
    const a = ang + (rnd() - 0.5) * spread;
    const s = speed * (0.35 + 0.65 * rnd());
    const i = emit(P, x + (rnd() - 0.5) * 8, y + (rnd() - 0.5) * 8, Math.cos(a) * s, Math.sin(a) * s,
      0.36 + 0.4 * rnd(), size * (0.7 + 0.6 * rnd()), K_PUFF, col, 0);
    P.drag[i] = 3.2;
    P.grow[i] = size * 2.4;
    P.alpha[i] = 0.5;
  }
}

/** Grey smoke that hangs and rises a little (goal mouth, fire). */
export function smoke(R, x, y, n, size, spreadPx) {
  const P = R.P, col = R.M.col.smoke;
  for (let c = amount(R, n); c > 0; c--) {
    const i = emit(P, x + (rnd() - 0.5) * spreadPx, y + (rnd() - 0.5) * spreadPx, (rnd() - 0.5) * 50, (rnd() - 0.5) * 50,
      0.7 + 0.7 * rnd(), size * (0.7 + 0.6 * rnd()), K_PUFF, col, F_TOP | F_Z);
    P.g[i] = -40;
    P.drag[i] = 1.6;
    P.grow[i] = size * 1.5;
    P.alpha[i] = 0.32;
  }
}

/** Flecks of turf and soil hopping away along `ang`. */
export function turf(R, x, y, ang, spread, speed, n) {
  const P = R.P, C = R.M.col;
  for (let c = amount(R, n); c > 0; c--) {
    const a = ang + (rnd() - 0.5) * spread;
    const s = speed * (0.3 + 0.7 * rnd());
    const pickCol = rnd();
    const col = pickCol < 0.5 ? C.turfA : pickCol < 0.82 ? C.turfB : C.dirt;
    const i = emit(P, x, y, Math.cos(a) * s, Math.sin(a) * s, 0.45 + 0.5 * rnd(), 1.4 + 1.7 * rnd(), K_SOLID, col, F_Z);
    P.vz[i] = 110 + 190 * rnd();
    P.g[i] = 720;
    P.drag[i] = 1.4;
  }
}

/** Bright streaks thrown along `ang`. */
export function sparks(R, x, y, ang, spread, speed, n, col) {
  const P = R.P;
  for (let c = amount(R, n); c > 0; c--) {
    const a = ang + (rnd() - 0.5) * spread;
    const s = speed * (0.35 + 0.65 * rnd());
    const i = emit(P, x, y, Math.cos(a) * s, Math.sin(a) * s, 0.16 + 0.26 * rnd(), 1.3 + 1.2 * rnd(), K_STREAK, col, F_ADD | F_TOP);
    P.drag[i] = 3.6;
  }
}

/** Glowing motes flying out in every direction. */
export function glowBurst(R, x, y, n, speed, col, size, life) {
  const P = R.P;
  for (let c = amount(R, n); c > 0; c--) {
    const a = rnd() * TAU;
    const s = speed * (0.25 + 0.75 * rnd());
    const l = life * (0.6 + 0.4 * rnd());
    const i = emit(P, x, y, Math.cos(a) * s, Math.sin(a) * s, l, size * (0.6 + 0.6 * rnd()), K_GLOW, col, F_ADD | F_TOP);
    P.drag[i] = 2.6;
    P.grow[i] = (-size * 0.6) / l;
  }
}

function confettiPiece(R, x, y, vx, vy, z, vz, cols, fadeIn) {
  const P = R.P;
  // It flutters down at about g / drag = 200 units/s, then lies on the turf for a moment.
  const fall = Math.max(0, z) / 190 + Math.max(0, vz) / 260;
  const i = emit(P, x, y, vx, vy, Math.min(6, fall + 0.9 + 0.8 * rnd()), 2.6 + 2.2 * rnd(), K_RECT, pick(cols),
    F_Z | F_LAND | F_TOP | F_SWAY | (fadeIn ? F_FADE_IN : 0));
  P.z[i] = z;
  P.vz[i] = vz;
  P.g[i] = 300;
  P.drag[i] = 1.5;
  P.rot[i] = rnd() * TAU;
  P.vrot[i] = (rnd() - 0.5) * 16;
}

/** Confetti thrown up and out from one spot. @param cols palette ids */
export function confettiBurst(R, x, y, ang, spread, speed, n, cols, lift) {
  for (let c = amount(R, n); c > 0; c--) {
    const a = ang + (rnd() - 0.5) * spread;
    const s = speed * (0.2 + 0.8 * rnd());
    confettiPiece(R, x, y, Math.cos(a) * s, Math.sin(a) * s, 8 + 14 * rnd(), lift * (0.5 + 0.7 * rnd()), cols, false);
  }
}

/** Confetti falling out of the sky on to the rectangle (x0..x1, y0..y1). */
export function confettiRain(R, x0, x1, y0, y1, n, cols) {
  if (!(x1 > x0) || !(y1 > y0)) return;
  for (let c = amount(R, n); c > 0; c--) {
    confettiPiece(R, x0 + (x1 - x0) * rnd(), y0 + (y1 - y0) * rnd(), (rnd() - 0.5) * 70, (rnd() - 0.5) * 30,
      240 + 420 * rnd(), -(40 + 90 * rnd()), cols, true);
  }
}

/** Flames licking up from (x, y), carried along by (vx, vy). */
export function flames(R, x, y, vx, vy, n, size) {
  const P = R.P;
  for (let c = amount(R, n); c > 0; c--) {
    const i = emit(P, x + (rnd() - 0.5) * size * 0.9, y + (rnd() - 0.5) * size * 0.9,
      vx + (rnd() - 0.5) * 46, vy + (rnd() - 0.5) * 46, 0.2 + 0.22 * rnd(), size * (0.7 + 0.6 * rnd()), K_FLAME, 0, F_ADD | F_TOP | F_Z);
    P.g[i] = -240;
    P.vz[i] = 20;
    P.drag[i] = 2.2;
    P.grow[i] = -size * 1.5;
  }
}

/** Glowing embers hopping away. */
export function embers(R, x, y, vx, vy, n) {
  const P = R.P, C = R.M.col;
  for (let c = amount(R, n); c > 0; c--) {
    const i = emit(P, x, y, vx + (rnd() - 0.5) * 130, vy + (rnd() - 0.5) * 130, 0.4 + 0.5 * rnd(), 1.1 + 0.9 * rnd(),
      K_SOLID, rnd() < 0.5 ? C.ember : C.hot, F_ADD | F_TOP | F_Z);
    P.vz[i] = 60 + 120 * rnd();
    P.g[i] = 320;
    P.drag[i] = 1.2;
  }
}

/** Hearts drifting up from a footballer. */
export function hearts(R, x, y, n, col) {
  const P = R.P;
  for (let c = amount(R, n); c > 0; c--) {
    const i = emit(P, x + (rnd() - 0.5) * 18, y, (rnd() - 0.5) * 34, -12 * rnd(), 1.1 + 0.7 * rnd(), 5 + 3.5 * rnd(),
      K_HEART, col, F_TOP | F_Z | F_SWAY | F_FADE_IN);
    P.z[i] = 16 + 10 * rnd();
    P.vz[i] = 55 + 40 * rnd();
    P.g[i] = -30;
    P.drag[i] = 0.8;
  }
}

/** Little stars popping up and tumbling down. */
export function starPop(R, x, y, n, col, speed) {
  const P = R.P;
  for (let c = amount(R, n); c > 0; c--) {
    const a = rnd() * TAU;
    const s = speed * (0.4 + 0.6 * rnd());
    const i = emit(P, x, y, Math.cos(a) * s, Math.sin(a) * s, 0.55 + 0.35 * rnd(), 4 + 3 * rnd(), K_STAR, col, F_TOP | F_Z);
    P.z[i] = 10;
    P.vz[i] = 150 + 120 * rnd();
    P.g[i] = 560;
    P.drag[i] = 1.2;
    P.rot[i] = rnd() * TAU;
    P.vrot[i] = (rnd() - 0.5) * 14;
  }
}

/** One drop of sweat flying off a tired footballer. */
export function sweat(R, x, y) {
  if (amount(R, 1) < 1) return;
  const P = R.P;
  const i = emit(P, x, y, (rnd() - 0.5) * 90, (rnd() - 0.5) * 50, 0.42 + 0.2 * rnd(), 1.5 + 0.7 * rnd(), K_SOLID, R.M.col.sweat, F_Z | F_TOP);
  P.z[i] = 14;
  P.vz[i] = 110 + 70 * rnd();
  P.g[i] = 620;
}

/** A camera flash in the stands. */
export function flashbulb(R, x, y) {
  const P = R.P;
  const i = emit(P, x, y, 0, 0, 0.07 + 0.1 * rnd(), 8 + 10 * rnd(), K_GLOW, R.M.col.flashbulb, F_ADD | F_TOP);
  P.alpha[i] = 0.95;
}

/** A mote left beside a spinning ball: together they draw the corkscrew of its trail. */
export function spinMote(R, x, y, col) {
  const P = R.P;
  const i = emit(P, x, y, 0, 0, 0.32, 2.4, K_GLOW, col, F_ADD);
  P.grow[i] = -4;
  P.alpha[i] = 0.85;
}

/**
 * The goal explosion: shards, sparks and confetti blown out of the goal mouth into the pitch.
 * @param dirx   -1 or +1: the way into the pitch
 * @param mouth  half width of the goal mouth
 * @param power  0..1 shot speed
 * @param muted  own goal: a fraction of the fireworks, drained of colour
 */
export function goalBurst(R, x, y, dirx, mouth, team, power, muted) {
  const P = R.P, C = R.M.col, T = R.M.teams[team === 1 ? 1 : 0];
  const k = muted ? 0.3 : 1;
  const p = 0.75 + 0.5 * clamp01(power);
  const ang = dirx < 0 ? Math.PI : 0;
  const glowCols = muted ? [C.grey[0], C.grey[1], C.white] : [T.cPrimary, T.cPrimary, T.cLight, T.cSecondary, C.white];

  for (let c = amount(R, 110 * k); c > 0; c--) {
    const a = ang + (rnd() - 0.5) * 2.5;
    const s = (220 + 900 * rnd()) * p;
    const i = emit(P, x, y + (rnd() - 0.5) * mouth * 1.5, Math.cos(a) * s, Math.sin(a) * s, 0.7 + 0.8 * rnd(), 3.5 + 5.5 * rnd(),
      K_GLOW, pick(glowCols), F_ADD | F_TOP | F_Z);
    P.vz[i] = 80 + 320 * rnd();
    P.g[i] = 460;
    P.drag[i] = 1.7;
    P.grow[i] = -2.5;
  }
  for (let c = amount(R, 70 * k); c > 0; c--) {
    const a = ang + (rnd() - 0.5) * 2.2;
    const s = (500 + 1100 * rnd()) * p;
    const i = emit(P, x, y + (rnd() - 0.5) * mouth * 1.2, Math.cos(a) * s, Math.sin(a) * s, 0.3 + 0.35 * rnd(), 1.6 + 1.4 * rnd(),
      K_STREAK, muted ? C.white : pick(glowCols), F_ADD | F_TOP);
    P.drag[i] = 3;
  }
  if (!muted) {
    for (let c = amount(R, 120); c > 0; c--) {
      const a = ang + (rnd() - 0.5) * 2.4;
      const s = (160 + 620 * rnd()) * p;
      confettiPiece(R, x, y + (rnd() - 0.5) * mouth * 1.6, Math.cos(a) * s, Math.sin(a) * s, 10 + 20 * rnd(), 260 + 320 * rnd(), T.confetti, false);
    }
  }
  smoke(R, x - dirx * 6, y, muted ? 4 : 9, 16, mouth * 1.4);
}
