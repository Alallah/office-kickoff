// Small pools for the effects that are not particles: one-shot shapes (rings, flashes, impact
// stars, comets), scuff marks on the turf, after-images and ripples running along the boards.
// Pure: typed arrays only, nothing allocates after the create functions.

// ---- one-shot shapes ---------------------------------------------------------------------------

/** Shapes (F.kind). */
export const FX_RING = 0;   // circle outline going from radius r0 to r1 (r0 > r1 closes in)
export const FX_GLOW = 1;   // soft flash swelling from r0 to r1
export const FX_STAR = 2;   // spiky impact star growing from r0 to r1
export const FX_BEAM = 3;   // comet running from (x, y) to (x2, y2)

/** Flags (F.flags). */
export const FXF_ADD = 1;   // additive blending
export const FXF_TOP = 2;   // drawn above the footballers (default: on the turf)

export function createFx(cap = 96) {
  const f32 = () => new Float32Array(cap);
  return {
    cap, n: 0, cursor: 0,
    kind: new Uint8Array(cap), flags: new Uint8Array(cap), col: new Uint16Array(cap),
    spikes: new Uint8Array(cap),
    /** Footballer whose position the shape sticks to (a beam: its far end), -1 = stays put. */
    follow: new Int8Array(cap),
    x: f32(), y: f32(), x2: f32(), y2: f32(), r0: f32(), r1: f32(), w: f32(),
    life: f32(), max: f32(), delay: f32(), alpha: f32(), rot: f32(),
  };
}

export function clearFx(F) {
  F.n = 0;
  F.cursor = 0;
}

/**
 * Adds a shape and returns its index so the caller can set the optional fields (alpha, rot,
 * spikes, delay, follow, x2 / y2), which all start at their neutral value. A full pool recycles
 * its entries round robin.
 * @param w    line width (rings, beams), world units
 * @param col  palette id
 */
export function spawnFx(F, kind, x, y, r0, r1, life, w, col, flags) {
  let i;
  if (F.n < F.cap) {
    i = F.n++;
  } else {
    i = F.cursor;
    F.cursor = (F.cursor + 1) % F.cap;
  }
  const ok = x - x === 0 && y - y === 0 && r0 - r0 === 0 && r1 - r1 === 0 && w - w === 0;
  F.kind[i] = kind;
  F.flags[i] = flags;
  F.col[i] = col;
  F.spikes[i] = 6;
  F.follow[i] = -1;
  F.x[i] = ok ? x : 0;
  F.y[i] = ok ? y : 0;
  F.x2[i] = F.x[i];
  F.y2[i] = F.y[i];
  F.r0[i] = ok && r0 > 0 ? r0 : 0;
  F.r1[i] = ok && r1 > 0 ? r1 : 0;
  F.w[i] = ok && w > 0 ? w : 0;
  const l = ok && life > 0.01 ? life : 0.01;
  F.life[i] = l;
  F.max[i] = l;
  F.delay[i] = 0;
  F.alpha[i] = 1;
  F.rot[i] = 0;
  return i;
}

function moveFx(F, from, to) {
  F.kind[to] = F.kind[from]; F.flags[to] = F.flags[from]; F.col[to] = F.col[from];
  F.spikes[to] = F.spikes[from]; F.follow[to] = F.follow[from];
  F.x[to] = F.x[from]; F.y[to] = F.y[from]; F.x2[to] = F.x2[from]; F.y2[to] = F.y2[from];
  F.r0[to] = F.r0[from]; F.r1[to] = F.r1[from]; F.w[to] = F.w[from];
  F.life[to] = F.life[from]; F.max[to] = F.max[from]; F.delay[to] = F.delay[from];
  F.alpha[to] = F.alpha[from]; F.rot[to] = F.rot[from];
}

/** Advances every shape by dt seconds; a shape waits out its delay before it starts ageing. */
export function stepFx(F, dt) {
  if (!(dt > 0)) return;
  let n = F.n;
  let i = 0;
  while (i < n) {
    if (F.delay[i] > 0) {
      F.delay[i] -= dt;
      i++;
      continue;
    }
    const l = F.life[i] - dt;
    if (l <= 0) {
      n--;
      if (i !== n) moveFx(F, n, i);
      continue;
    }
    F.life[i] = l;
    i++;
  }
  F.n = n;
}

/** Progress 0..1 of shape i, or -1 while it is still waiting to start. */
export function fxProgress(F, i) {
  if (F.delay[i] > 0) return -1;
  const u = 1 - F.life[i] / F.max[i];
  return u < 0 ? 0 : u > 1 ? 1 : u;
}

// ---- scuff marks -------------------------------------------------------------------------------
// A slide tackle scrapes a line into the turf. A slot is a segment (x0, y0) -> (x1, y1) that
// fades out; while the slide lasts its end follows the slider. Slots are never compacted, so the
// slider can keep (slot, generation) and extend its own mark.

export function createScuffs(cap = 24) {
  const f32 = () => new Float32Array(cap);
  return {
    cap, cursor: 0,
    x0: f32(), y0: f32(), x1: f32(), y1: f32(), w: f32(), life: f32(), max: f32(),
    gen: new Uint16Array(cap),
  };
}

export function clearScuffs(S) {
  S.life.fill(0);
}

/** Starts a mark at (x, y); returns its slot. The oldest mark makes room when all are in use. */
export function scuffBegin(S, x, y, w, life) {
  let slot = -1;
  for (let k = 0; k < S.cap; k++) {
    const s = (S.cursor + k) % S.cap;
    if (S.life[s] <= 0) {
      slot = s;
      break;
    }
  }
  if (slot < 0) {
    // All busy: recycle the one with the least time left.
    slot = 0;
    for (let s = 1; s < S.cap; s++) if (S.life[s] < S.life[slot]) slot = s;
  }
  S.cursor = (slot + 1) % S.cap;
  const ok = x - x === 0 && y - y === 0;
  S.x0[slot] = S.x1[slot] = ok ? x : 0;
  S.y0[slot] = S.y1[slot] = ok ? y : 0;
  S.w[slot] = w > 0 ? w : 1;
  const l = ok && life > 0.05 ? life : 0.05;
  S.life[slot] = l;
  S.max[slot] = l;
  S.gen[slot] = (S.gen[slot] + 1) & 0xffff;
  return slot;
}

/** Moves the end of a mark while its slide lasts; false when the slot has been recycled. */
export function scuffExtend(S, slot, gen, x, y) {
  if (!(slot >= 0 && slot < S.cap) || S.gen[slot] !== gen || !(S.life[slot] > 0)) return false;
  if (!(x - x === 0 && y - y === 0)) return false;
  S.x1[slot] = x;
  S.y1[slot] = y;
  S.life[slot] = S.max[slot];
  return true;
}

export function stepScuffs(S, dt) {
  if (!(dt > 0)) return;
  for (let s = 0; s < S.cap; s++) {
    if (S.life[s] > 0) S.life[s] = Math.max(0, S.life[s] - dt);
  }
}

// ---- after-images ------------------------------------------------------------------------------

export function createGhosts(cap = 48) {
  const f32 = () => new Float32Array(cap);
  return {
    cap, cursor: 0,
    x: f32(), y: f32(), dir: f32(), sa: f32(), sb: f32(), r: f32(), life: f32(), max: f32(),
    col: new Uint16Array(cap),
  };
}

export function clearGhosts(G) {
  G.life.fill(0);
}

/** Leaves an after-image: an ellipse of radius r stretched by sa along dir and by sb across it. */
export function ghostAdd(G, x, y, dir, sa, sb, r, col, life) {
  if (!(x - x === 0 && y - y === 0 && dir - dir === 0 && sa - sa === 0 && sb - sb === 0 && r > 0)) return;
  const i = G.cursor;
  G.cursor = (i + 1) % G.cap;
  G.x[i] = x;
  G.y[i] = y;
  G.dir[i] = dir;
  G.sa[i] = sa > 0.05 ? sa : 0.05;
  G.sb[i] = sb > 0.05 ? sb : 0.05;
  G.r[i] = r;
  G.col[i] = col;
  const l = life > 0.02 ? life : 0.02;
  G.life[i] = l;
  G.max[i] = l;
}

export function stepGhosts(G, dt) {
  if (!(dt > 0)) return;
  for (let i = 0; i < G.cap; i++) {
    if (G.life[i] > 0) G.life[i] = Math.max(0, G.life[i] - dt);
  }
}

// ---- board ripples -----------------------------------------------------------------------------
// The ball hits a board: two wave fronts run away from the contact point along the wall loop.

/** Loop samples a wave front travels per second. */
export const RIPPLE_SPEED = 46;

export function createRipples(cap = 8) {
  return {
    cap, cursor: 0,
    idx: new Int32Array(cap),
    age: new Float32Array(cap).fill(1), life: new Float32Array(cap), str: new Float32Array(cap),
  };
}

export function clearRipples(Q) {
  Q.life.fill(0);
  Q.age.fill(1);
}

/** @param idx index of the wall-loop sample that was hit; @param strength 0..1 */
export function rippleAdd(Q, idx, strength, life) {
  if (!(idx >= 0) || !(strength > 0) || !(life > 0)) return;
  const i = Q.cursor;
  Q.cursor = (i + 1) % Q.cap;
  Q.idx[i] = idx | 0;
  Q.age[i] = 0;
  Q.life[i] = life;
  Q.str[i] = strength > 1 ? 1 : strength;
}

export function stepRipples(Q, dt) {
  if (!(dt > 0)) return;
  for (let i = 0; i < Q.cap; i++) {
    if (Q.age[i] < Q.life[i]) Q.age[i] += dt;
  }
}

/** True while ripple i is still running. */
export function rippleAlive(Q, i) {
  return Q.age[i] < Q.life[i];
}
