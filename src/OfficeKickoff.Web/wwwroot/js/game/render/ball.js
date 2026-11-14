// Draws the ball prepared by ballfx.js: its trail, its shadow, the heat glow, the rolling panel
// pattern, squash and stretch.

import { TAU } from './mathx.js';
import { HEAT16 } from './color.js';
import { trailIndex, trailLive } from './fxmodel.js';
import { INK } from './look.js';
import { setLocal, setWorld, setWorldAt } from './shapes.js';

/** A dark panel is a cap of this angular radius on the ball (radians): its sine and cosine. */
const PATCH_SIN = 0.3894, PATCH_COS = 0.9211;

/** Most points a trail ribbon can have: every sample plus the ball itself. */
const RIBBON = 66;
const rx = new Float32Array(RIBBON), ry = new Float32Array(RIBBON);
const rw = new Float32Array(RIBBON), ra = new Float32Array(RIBBON), rc = new Float32Array(RIBBON);
const ex = new Float32Array(RIBBON), ey = new Float32Array(RIBBON);

/** The ball is joined to its trail while it is this close to the newest sample (world units). */
const HEAD_GAP = 70;

function ribbon(ctx, n, widthK, alphaK) {
  for (let k = 0; k + 1 < n; k++) {
    const a = (ra[k] + ra[k + 1]) * 0.5 * alphaK;
    if (!(a > 0.004)) continue;
    const w0 = rw[k] * widthK, w1 = rw[k + 1] * widthK;
    ctx.globalAlpha = a > 1 ? 1 : a;
    ctx.fillStyle = HEAT16[(rc[k] * 15 + 0.5) | 0];
    ctx.beginPath();
    ctx.moveTo(rx[k] + ex[k] * w0, ry[k] + ey[k] * w0);
    ctx.lineTo(rx[k + 1] + ex[k + 1] * w1, ry[k + 1] + ey[k + 1] * w1);
    ctx.lineTo(rx[k + 1] - ex[k + 1] * w1, ry[k + 1] - ey[k + 1] * w1);
    ctx.lineTo(rx[k] - ex[k] * w0, ry[k] - ey[k] * w0);
    ctx.fill();
  }
}

/**
 * The trail: a ribbon through the ball's recent positions, widest and whitest at the ball,
 * running through yellow to orange along its length when the ball is hot. A curling shot bends it.
 */
export function drawTrail(R) {
  const T = R.trail, B = R.ball, b = B.v, ctx = R.ctx, r = R.M.ballR;
  const live = trailLive(T, R.t);
  if (live < 1) return;

  // Ribbon points, newest first; the ball itself leads while it is still attached to its trail.
  let n = 0;
  const first = trailIndex(T, 0);
  if (b.ok && b.owner < 0 && !b.held) {
    const dx = b.x - T.x[first], dy = b.y - T.y[first];
    const d2 = dx * dx + dy * dy;
    if (d2 > 1 && d2 < HEAD_GAP * HEAD_GAP) {
      rx[0] = b.x;
      ry[0] = b.y;
      rw[0] = r * (0.9 + 0.35 * T.heat[first]);
      ra[0] = 1;
      rc[0] = T.heat[first] * 0.3;
      n = 1;
    }
  }
  for (let k = 0; k < live && n < RIBBON; k++) {
    const i = trailIndex(T, k);
    const age = (R.t - T.t[i]) / T.life[i];
    const left = age < 0 ? 1 : age > 1 ? 0 : 1 - age;
    const h = T.heat[i];
    rx[n] = T.x[i];
    ry[n] = T.y[i];
    rw[n] = r * (0.16 + 0.8 * left) * (0.8 + 0.45 * h);
    ra[n] = left;
    rc[n] = h * (0.3 + 0.7 * (1 - left));
    n++;
  }
  if (n < 2) return;

  // One normal per point (from its neighbours), so the ribbon bends without gaps or overlaps.
  for (let k = 0; k < n; k++) {
    const p = k > 0 ? k - 1 : k, q = k + 1 < n ? k + 1 : k;
    let dx = rx[q] - rx[p], dy = ry[q] - ry[p];
    const d = Math.sqrt(dx * dx + dy * dy);
    if (d > 1e-3) {
      dx /= d;
      dy /= d;
    } else {
      dx = 1;
      dy = 0;
    }
    ex[k] = -dy;
    ey[k] = dx;
  }

  setWorld(ctx, R.W);
  // A soft wide glow underneath, then the bright core.
  ctx.globalCompositeOperation = 'lighter';
  ribbon(ctx, n, 1.7, 0.2 + 0.25 * B.glow);
  ctx.globalCompositeOperation = 'source-over';
  ribbon(ctx, n, 0.62, 0.62);
  ctx.globalAlpha = 1;
}

export function drawBall(R) {
  const B = R.ball, b = B.v;
  if (!b.ok) return;
  const vis = R.vis;
  if (b.x < vis.x0 - 60 || b.x > vis.x1 + 60 || b.y < vis.y0 - 60 || b.y > vis.y1 + 60) return;
  const ctx = R.ctx, W = R.W, S = R.sprites, r = R.M.ballR;

  setWorldAt(ctx, W, b.x, b.y);
  ctx.globalAlpha = 0.9;
  const sh = r * 2.9;
  ctx.drawImage(S.shadow(), -sh, -sh + r * 0.22, 2 * sh, 2 * sh);

  // Heat: a glow that grows with the power of the strike, and flickers when the ball is on fire.
  if (B.glow > 0.02) {
    const flame = S.flame();
    const flicker = B.fire && !R.reduced ? 0.86 + 0.14 * Math.sin(R.t * 41) : 1;
    const g = r * (2 + 1.9 * B.glow) * flicker;
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = 0.8 * B.glow;
    ctx.drawImage(flame[B.fire ? 2 : 4], -g, -g, 2 * g, 2 * g);
    ctx.globalCompositeOperation = 'source-over';
  }

  // The ball, stretched along its flight.
  setLocal(ctx, W, B.m, b.x, b.y);
  ctx.globalAlpha = 1;
  ctx.fillStyle = INK;
  ctx.beginPath();
  ctx.arc(0, 0, r + 1.2, 0, TAU);
  ctx.fill();
  ctx.fillStyle = '#fbfdff';
  ctx.beginPath();
  ctx.arc(0, 0, r, 0, TAU);
  ctx.fill();

  // Panels: each dark patch is a cap on the sphere, seen as an ellipse that thins out towards
  // the rim. They roll with the ball (ballfx.js turns the points).
  const pts = B.pts, major = r * PATCH_SIN;
  ctx.fillStyle = '#1a2236';
  ctx.beginPath();
  for (let i = 0; i < 36; i += 3) {
    const z = pts[i + 2];
    if (z <= 0.06) continue;
    const px = pts[i], py = pts[i + 1];
    const rot = Math.atan2(py, px);
    const minor = major * z;
    const cx = px * r * PATCH_COS, cy = py * r * PATCH_COS;
    ctx.moveTo(cx + Math.cos(rot) * minor, cy + Math.sin(rot) * minor);
    ctx.ellipse(cx, cy, minor, major, rot, 0, TAU);
  }
  ctx.fill();
  ctx.drawImage(S.ballShade(), -r, -r, 2 * r, 2 * r);

  if (B.fire) {
    const flame = S.flame();
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = 0.45;
    ctx.drawImage(flame[1], -r * 1.5, -r * 1.5, r * 3, r * 3);
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
  }
}
