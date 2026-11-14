// Effect models that can be wrong in subtle ways, kept free of canvas and DOM so they are
// unit-testable: camera shake, the ball's trail buffer, the goal nets, the crowd's mood and a few
// timing curves.

import { approach, clamp, clamp01, ease, smoothstep, springStep, wobble } from './mathx.js';

// ---- camera shake ------------------------------------------------------------------------------
// "Trauma" model: hits add trauma, trauma decays linearly and the shake is its square, so a big
// hit starts violently and settles smoothly. On top: a directional kick (the camera recoils from
// a shot) and a zoom punch, both damped springs. Everything is in CSS pixels and purely visual.

const MAX_SHAKE_PX = 18;
const MAX_ROLL = 0.02;
const TRAUMA_DECAY = 1.1;
const KICK_STIFF = 320, KICK_DAMP = 26;
const PUNCH_STIFF = 300, PUNCH_DAMP = 24;
// Velocity that makes the springs above peak at a displacement of 1.
const KICK_GAIN = 39.9, PUNCH_GAIN = 37.4;

export function createShake() {
  return {
    trauma: 0, t: 0,
    kx: { x: 0, v: 0 }, ky: { x: 0, v: 0 }, punch: { x: 0, v: 0 },
    /** Outputs of stepShake: offset in CSS px, roll in radians, zoom factor. */
    ox: 0, oy: 0, rot: 0, zoom: 1,
  };
}

export function clearShake(S) {
  S.trauma = 0;
  S.kx.x = S.kx.v = S.ky.x = S.ky.v = S.punch.x = S.punch.v = 0;
  S.ox = S.oy = S.rot = 0;
  S.zoom = 1;
}

export function addTrauma(S, amount) {
  if (amount > 0) S.trauma = Math.min(1, S.trauma + amount);
}

/** Recoil of about `px` pixels along (dx, dy); the direction need not be normalised. */
export function kickShake(S, dx, dy, px) {
  const l = Math.sqrt(dx * dx + dy * dy);
  if (!(l > 1e-6) || !(px > 0)) return;
  S.kx.v += (dx / l) * px * KICK_GAIN;
  S.ky.v += (dy / l) * px * KICK_GAIN;
}

/** Zoom punch peaking at about `amount` (0.04 = four percent closer). */
export function punchZoom(S, amount) {
  if (amount - amount === 0) S.punch.v += amount * PUNCH_GAIN;
}

/** @param slow 0..1, how deep in slow motion the frame is: the shake then rumbles more slowly. */
export function stepShake(S, dt, slow) {
  S.t += dt * (1 - 0.45 * slow);
  S.trauma = Math.max(0, S.trauma - TRAUMA_DECAY * dt);
  springStep(S.kx, 0, KICK_STIFF, KICK_DAMP, dt);
  springStep(S.ky, 0, KICK_STIFF, KICK_DAMP, dt);
  springStep(S.punch, 0, PUNCH_STIFF, PUNCH_DAMP, dt);
  const amt = S.trauma * S.trauma;
  S.ox = MAX_SHAKE_PX * amt * wobble(S.t * 37, 1) + clamp(S.kx.x, -40, 40);
  S.oy = MAX_SHAKE_PX * amt * wobble(S.t * 37, 2) + clamp(S.ky.x, -40, 40);
  S.rot = MAX_ROLL * amt * wobble(S.t * 29, 3);
  S.zoom = 1 + clamp(S.punch.x, -0.06, 0.12);
}

// ---- ball trail --------------------------------------------------------------------------------
// Ring buffer of recent ball positions. Each sample carries its own lifetime (fast balls leave a
// longer trail) and a 0..1 "heat" that picks its colour.

export function createTrail(cap = 64) {
  return {
    cap, n: 0, head: 0,
    x: new Float32Array(cap), y: new Float32Array(cap),
    t: new Float64Array(cap), life: new Float32Array(cap), heat: new Float32Array(cap),
  };
}

export function trailClear(T) {
  T.n = 0;
  T.head = 0;
}

export function trailPush(T, x, y, t, life, heat) {
  const i = T.head;
  T.x[i] = x;
  T.y[i] = y;
  T.t[i] = t;
  T.life[i] = life;
  T.heat[i] = heat;
  T.head = (i + 1) % T.cap;
  if (T.n < T.cap) T.n++;
}

/** Storage index of the k-th newest sample (k = 0 is the newest; k must be below T.n). */
export function trailIndex(T, k) {
  return (T.head - 1 - k + T.cap * 2) % T.cap;
}

/**
 * Number of samples, counted from the newest, that are still alive at time t. Everything from
 * the first expired sample on is forgotten, so the trail never has holes.
 */
export function trailLive(T, t) {
  let k = 0;
  while (k < T.n) {
    const i = trailIndex(T, k);
    if (t - T.t[i] >= T.life[i]) break;
    k++;
  }
  T.n = k;
  return k;
}

/** Seconds a trail sample lives: longer for faster and hotter balls. */
export function trailLife(speedN, heat) {
  return 0.1 + 0.3 * clamp01(speedN * 1.15) + 0.14 * clamp01(heat);
}

/** 0..1 colour parameter of the trail and glow: white, through yellow, to orange. */
export function heatParam(speedN, heat) {
  return clamp01(Math.max(speedN * 0.8, heat));
}

// ---- goal net ----------------------------------------------------------------------------------
// Seen from above a net is its back edge and its two side edges. Each is a damped string of
// nodes with fixed ends; the value at a node is how far the net bulges OUTWARDS there (world
// units). A ball that hits the net plucks the string, the pluck travels along it as a ripple.

const NET_TENSION = 2600, NET_RESTORE = 110, NET_DAMP = 5.2, NET_MAX = 70, NET_SUBSTEP = 0.004;

export function createNet(ny = 14, nd = 4) {
  return {
    ny, nd, active: false,
    /** Back edge: ny + 1 nodes from the top post side (y = -goalHalf) to the bottom. */
    b: new Float32Array(ny + 1), vb: new Float32Array(ny + 1),
    /** Top and bottom side edges: nd + 1 nodes from the goal line to the back. */
    st: new Float32Array(nd + 1), vst: new Float32Array(nd + 1),
    sb: new Float32Array(nd + 1), vsb: new Float32Array(nd + 1),
  };
}

export function clearNet(N) {
  N.b.fill(0);
  N.vb.fill(0);
  N.st.fill(0);
  N.vst.fill(0);
  N.sb.fill(0);
  N.vsb.fill(0);
  N.active = false;
}

function pluck(vel, n, at, strength, spread) {
  const w = spread > 0.01 ? spread : 0.01;
  for (let k = 1; k < n; k++) {
    const d = (k / n - at) / w;
    vel[k] += strength * Math.exp(-d * d);
  }
}

/**
 * Hits the back of the net.
 * @param at        0..1 across the goal mouth (0 = the y = -goalHalf post)
 * @param strength  outward speed given to the net, units/s
 * @param spread    width of the hit as a fraction of the mouth
 */
export function netImpulse(N, at, strength, spread) {
  if (!(strength - strength === 0) || !(at - at === 0)) return;
  pluck(N.vb, N.ny, clamp01(at), strength, spread);
  N.active = true;
}

/** Hits a side of the net. top = the y = -goalHalf side; at = 0..1 from the goal line to the back. */
export function netSideImpulse(N, top, at, strength, spread) {
  if (!(strength - strength === 0) || !(at - at === 0)) return;
  pluck(top ? N.vst : N.vsb, N.nd, clamp01(at), strength, spread);
  N.active = true;
}

/** A gust through the whole net (a goal has just gone in). */
export function netBillow(N, strength) {
  if (!(strength - strength === 0)) return;
  for (let k = 1; k < N.ny; k++) N.vb[k] += strength * (0.55 + 0.45 * Math.sin((Math.PI * k) / N.ny));
  for (let j = 1; j < N.nd; j++) {
    const s = strength * 0.45 * Math.sin((Math.PI * j) / N.nd);
    N.vst[j] += s;
    N.vsb[j] += s;
  }
  N.active = true;
}

/** A ball resting against the back of the net holds it out by at least `depth` around `at`. */
export function netPress(N, at, depth, spread) {
  if (!(depth > 0) || !(at - at === 0)) return;
  const w = spread > 0.01 ? spread : 0.01;
  for (let k = 1; k < N.ny; k++) {
    const d = (k / N.ny - at) / w;
    const want = depth * Math.exp(-d * d);
    if (N.b[k] < want) {
      N.b[k] = want;
      if (N.vb[k] < 0) N.vb[k] = 0;
    }
  }
  N.active = true;
}

function stepString(x, v, n, h) {
  for (let k = 1; k < n; k++) {
    const a = NET_TENSION * (x[k - 1] + x[k + 1] - 2 * x[k]) - NET_RESTORE * x[k] - NET_DAMP * v[k];
    v[k] += a * h;
  }
  let most = 0;
  for (let k = 1; k < n; k++) {
    let p = x[k] + v[k] * h;
    if (p > NET_MAX) p = NET_MAX;
    else if (p < -NET_MAX) p = -NET_MAX;
    x[k] = p;
    const m = Math.abs(p) + Math.abs(v[k]) * 0.01;
    if (m > most) most = m;
  }
  return most;
}

/** Advances the net; clears N.active once it has come to rest. */
export function stepNet(N, dt) {
  if (!N.active || !(dt > 0)) return;
  let left = dt > 0.1 ? 0.1 : dt;
  let most = 0;
  while (left > 0) {
    const h = left > NET_SUBSTEP ? NET_SUBSTEP : left;
    most = Math.max(stepString(N.b, N.vb, N.ny, h), stepString(N.st, N.vst, N.nd, h), stepString(N.sb, N.vsb, N.nd, h));
    left -= h;
  }
  if (most < 0.03) clearNet(N);
}

// ---- crowd mood --------------------------------------------------------------------------------

export function createMood() {
  return {
    /** How excited each end is about the ball being near its goal: [left, right], 0..1. */
    surge: new Float32Array(2),
    /** Goal eruption, 1 just after a goal, falling to 0. */
    roar: 0,
    /** Team whose fans are loudest during the roar (-1 = nobody in particular). */
    roarTeam: -1,
  };
}

export function clearMood(C) {
  C.surge[0] = C.surge[1] = 0;
  C.roar = 0;
  C.roarTeam = -1;
}

/**
 * @param live  the ball is in play (not dead, match running)
 * @param pm    pitch metrics (halfW, boxDepth)
 */
export function stepMood(C, dt, ballX, ballY, live, pm) {
  for (let s = 0; s < 2; s++) {
    const gx = s === 0 ? -pm.halfW : pm.halfW;
    const dx = ballX - gx;
    const d = Math.sqrt(dx * dx + ballY * ballY);
    const target = live && d - d === 0 ? smoothstep(pm.boxDepth * 2.6, pm.boxDepth * 0.7, d) : 0;
    C.surge[s] = approach(C.surge[s], target, target > C.surge[s] ? 5 : 1.6, dt);
  }
  C.roar = Math.max(0, C.roar - dt * 0.27);
}

export function moodGoal(C, team, muted) {
  C.roar = Math.max(C.roar, muted ? 0.4 : 1);
  C.roarTeam = team === 0 || team === 1 ? team : -1;
}

/**
 * Excitement 0..1 of one stand. strip: 0 = top, 1 = bottom, 2 = left end, 3 = right end.
 * The home fans (team 0) sit at the left end, behind the goal their team defends.
 */
export function standExcitement(C, strip) {
  const roar = Math.pow(C.roar, 0.8);
  if (strip >= 2) {
    const end = strip - 2;
    const share = C.roarTeam < 0 || C.roarTeam === end ? 1 : 0.55;
    return clamp01(Math.max(C.surge[end], roar * share));
  }
  return clamp01(Math.max(0.75 * Math.max(C.surge[0], C.surge[1]), roar * 0.85));
}

// ---- small curves ------------------------------------------------------------------------------

/** Emote bubble: springs in, sits, shrinks away. Returns the scale; 0 once the bubble is over. */
export function bubbleScale(age, life) {
  if (!(age >= 0) || age >= life) return 0;
  const grow = ease.outElastic(clamp01(age / 0.55));
  const left = life - age;
  return left < 0.22 ? grow * ease.outQuad(left / 0.22) : grow;
}

/** 0, 1, or -1 for a draw (or a score that makes no sense). */
export function winnerOf(score) {
  if (!score || !(score[0] - score[0] === 0) || !(score[1] - score[1] === 0)) return -1;
  return score[0] > score[1] ? 0 : score[1] > score[0] ? 1 : -1;
}

/**
 * Half-rectified hop used for bobbing things (the crowd, celebrating team-mates): 0 on the
 * ground, 1 at the top of the jump, with a short pause between jumps.
 */
export function hop(phase) {
  const s = Math.sin(phase);
  return s > 0 ? Math.pow(s, 0.7) : 0;
}
