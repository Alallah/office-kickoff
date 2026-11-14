// Pooled particles in typed arrays. Pure: nothing here touches a canvas, and nothing allocates
// after createParticles().
//
// A particle lives on the ground plane (x, y) and may have a height z: it is drawn at (x, y - z),
// which is what makes confetti rain and turf hop in a top-down view.

/** Shapes (P.kind). */
export const K_GLOW = 0;    // soft glowing dot
export const K_PUFF = 1;    // soft cloud that grows and thins out (dust, smoke)
export const K_SOLID = 2;   // small hard square (turf, embers, droplets)
export const K_RECT = 3;    // tumbling confetti
export const K_STREAK = 4;  // line along the velocity (sparks)
export const K_FLAME = 5;   // glow that runs down the heat ramp as it ages
export const K_HEART = 6;
export const K_STAR = 7;

/** Flags (P.flags). */
export const F_ADD = 1;       // additive blending
export const F_Z = 2;         // has height and falls with gravity P.g (negative g rises)
export const F_LAND = 4;      // with F_Z: comes to rest where it lands instead of bouncing
export const F_TOP = 8;       // drawn above the footballers (default: beneath them)
export const F_FADE_IN = 16;  // alpha ramps up over the first fifth of the life
export const F_SWAY = 32;     // flutters sideways while airborne
export const F_RESTING = 64;  // set by the integrator once an F_LAND particle has landed

const SWAY_SPEED = 30;

export function createParticles(cap = 2000) {
  const f32 = () => new Float32Array(cap);
  return {
    cap, n: 0, cursor: 0,
    x: f32(), y: f32(), z: f32(), vx: f32(), vy: f32(), vz: f32(),
    g: f32(), drag: f32(), life: f32(), max: f32(), size: f32(), grow: f32(),
    rot: f32(), vrot: f32(), alpha: f32(),
    kind: new Uint8Array(cap), flags: new Uint8Array(cap), col: new Uint16Array(cap),
  };
}

export function clearParticles(P) {
  P.n = 0;
  P.cursor = 0;
}

/**
 * Adds a particle and returns its index so the caller can set the optional fields
 * (z, vz, g, drag, grow, rot, vrot, alpha), which all start at their neutral value.
 * When the pool is full the new particle replaces an existing one, round robin.
 * @param size  radius in world units
 * @param col   palette id
 */
export function emit(P, x, y, vx, vy, life, size, kind, col, flags) {
  let i;
  if (P.n < P.cap) {
    i = P.n++;
  } else {
    i = P.cursor;
    P.cursor = (P.cursor + 1) % P.cap;
  }
  // A non-finite particle would poison every draw call it reaches: park it and let it expire.
  const ok = x - x === 0 && y - y === 0 && vx - vx === 0 && vy - vy === 0 && size - size === 0;
  P.x[i] = ok ? x : 0;
  P.y[i] = ok ? y : 0;
  P.z[i] = 0;
  P.vx[i] = ok ? vx : 0;
  P.vy[i] = ok ? vy : 0;
  P.vz[i] = 0;
  P.g[i] = 0;
  P.drag[i] = 0;
  const l = ok && life > 0.01 ? life : 0.01;
  P.life[i] = l;
  P.max[i] = l;
  P.size[i] = ok ? size : 0;
  P.grow[i] = 0;
  P.rot[i] = 0;
  P.vrot[i] = 0;
  P.alpha[i] = 1;
  P.kind[i] = kind;
  P.flags[i] = flags;
  P.col[i] = col;
  return i;
}

function move(P, from, to) {
  P.x[to] = P.x[from]; P.y[to] = P.y[from]; P.z[to] = P.z[from];
  P.vx[to] = P.vx[from]; P.vy[to] = P.vy[from]; P.vz[to] = P.vz[from];
  P.g[to] = P.g[from]; P.drag[to] = P.drag[from];
  P.life[to] = P.life[from]; P.max[to] = P.max[from];
  P.size[to] = P.size[from]; P.grow[to] = P.grow[from];
  P.rot[to] = P.rot[from]; P.vrot[to] = P.vrot[from]; P.alpha[to] = P.alpha[from];
  P.kind[to] = P.kind[from]; P.flags[to] = P.flags[from]; P.col[to] = P.col[from];
}

/** Advances every particle by dt seconds and drops the ones whose life ran out. */
export function stepParticles(P, dt) {
  if (!(dt > 0)) return;
  const { x, y, z, vx, vy, vz, g, drag, life, max, rot, vrot, flags } = P;
  let n = P.n;
  let i = 0;
  while (i < n) {
    const l = life[i] - dt;
    if (l <= 0) {
      n--;
      if (i !== n) move(P, n, i);
      continue;
    }
    life[i] = l;
    const f = flags[i];
    if (f & F_RESTING) {
      i++;
      continue;
    }
    // Implicit drag: stable for any dt.
    const k = 1 / (1 + drag[i] * dt);
    const pvx = vx[i] * k, pvy = vy[i] * k;
    vx[i] = pvx;
    vy[i] = pvy;
    x[i] += pvx * dt;
    y[i] += pvy * dt;
    if (f & F_Z) {
      let pvz = (vz[i] - g[i] * dt) * k;
      let pz = z[i] + pvz * dt;
      if (pz <= 0 && pvz < 0) {
        pz = 0;
        if (f & F_LAND) {
          flags[i] = f | F_RESTING;
          vx[i] = 0;
          vy[i] = 0;
          pvz = 0;
        } else {
          pvz = -pvz * 0.35;
        }
      }
      z[i] = pz;
      vz[i] = pvz;
      if (f & F_SWAY) x[i] += Math.sin((max[i] - l) * 5.3 + i * 1.9) * SWAY_SPEED * dt;
    }
    rot[i] += vrot[i] * dt;
    i++;
  }
  P.n = n;
}

/** Opacity of particle i right now: its base alpha, faded out over the last part of its life. */
export function particleAlpha(P, i) {
  const l = P.life[i], m = P.max[i];
  let a = P.alpha[i];
  const tail = l / (m * 0.45);
  if (tail < 1) a *= tail;
  if (P.flags[i] & F_FADE_IN) {
    const head = (m - l) / (m * 0.2);
    if (head < 1) a *= head;
  }
  return a;
}

/** Radius of particle i right now (never negative). */
export function particleSize(P, i) {
  const s = P.size[i] + P.grow[i] * (P.max[i] - P.life[i]);
  return s > 0 ? s : 0;
}
