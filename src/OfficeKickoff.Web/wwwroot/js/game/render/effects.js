// Draws the pooled effects: particles (particles.js), one-shot shapes and after-images
// (fxpool.js). Glows are pre-rendered sprites blended additively - no shadowBlur, no gradients in
// the frame path - and nothing here allocates.
//
// Each pool is drawn twice per frame: once for what lies on the turf (beneath the footballers)
// and once for what flies above them.

import { ease, poseMatrix, TAU } from './mathx.js';
import {
  F_ADD, F_TOP, K_FLAME, K_GLOW, K_HEART, K_PUFF, K_RECT, K_SOLID, K_STAR, K_STREAK, particleAlpha, particleSize,
} from './particles.js';
import { FX_BEAM, FX_GLOW, FX_RING, FX_STAR, FXF_ADD, FXF_TOP, fxProgress } from './fxpool.js';
import { setLocal, setWorld, starPath } from './shapes.js';

/** Particles this far outside the picture (world units) are skipped. */
const CULL = 44;

/**
 * @param top  true: the particles flagged F_TOP (above the footballers); false: the rest
 */
export function drawParticles(R, top) {
  const P = R.P, n = P.n;
  if (n === 0) return;
  const ctx = R.ctx, W = R.W, vis = R.vis, css = R.pal.css, S = R.sprites;
  const want = top ? F_TOP : 0;
  const x0 = vis.x0 - CULL, x1 = vis.x1 + CULL, y0 = vis.y0 - CULL, y1 = vis.y1 + CULL;
  const flame = S.flame();
  const kind = P.kind, flags = P.flags, col = P.col;

  setWorld(ctx, W);
  ctx.globalCompositeOperation = 'source-over';
  ctx.lineCap = 'round';
  let add = false;
  let fillCol = -1, strokeCol = -1;

  for (let i = 0; i < n; i++) {
    const f = flags[i];
    if ((f & F_TOP) !== want) continue;
    const x = P.x[i], y = P.y[i] - P.z[i];
    if (x < x0 || x > x1 || y < y0 || y > y1) continue;
    let a = particleAlpha(P, i);
    if (!(a > 0.004)) continue;
    if (a > 1) a = 1;
    const s = particleSize(P, i);
    if (!(s > 0.05)) continue;
    const wantAdd = (f & F_ADD) !== 0;
    if (wantAdd !== add) {
      add = wantAdd;
      ctx.globalCompositeOperation = add ? 'lighter' : 'source-over';
    }
    ctx.globalAlpha = a;
    const c = col[i];

    switch (kind[i]) {
      case K_GLOW:
        // The sprite fades to nothing at its edge: drawn twice the size, its core is `s` wide.
        ctx.drawImage(S.glow(c), x - s * 2, y - s * 2, s * 4, s * 4);
        break;
      case K_PUFF:
        ctx.drawImage(S.puff(c), x - s * 1.5, y - s * 1.5, s * 3, s * 3);
        break;
      case K_SOLID:
        if (c !== fillCol) {
          ctx.fillStyle = css[c] || '#ffffff';
          fillCol = c;
        }
        ctx.fillRect(x - s, y - s, s * 2, s * 2);
        break;
      case K_RECT: {
        // Confetti tumbles: its visible height swings through zero as it turns over.
        if (c !== fillCol) {
          ctx.fillStyle = css[c] || '#ffffff';
          fillCol = c;
        }
        const rot = P.rot[i];
        const flip = Math.cos(rot * 1.7 + P.vrot[i] * 2.3);
        const ux = Math.cos(rot) * s * 1.5, uy = Math.sin(rot) * s * 1.5;
        const vx = -Math.sin(rot) * s * flip, vy = Math.cos(rot) * s * flip;
        ctx.globalAlpha = a * (0.6 + 0.4 * Math.abs(flip));
        ctx.beginPath();
        ctx.moveTo(x + ux + vx, y + uy + vy);
        ctx.lineTo(x - ux + vx, y - uy + vy);
        ctx.lineTo(x - ux - vx, y - uy - vy);
        ctx.lineTo(x + ux - vx, y + uy - vy);
        ctx.fill();
        break;
      }
      case K_STREAK: {
        if (c !== strokeCol) {
          ctx.strokeStyle = css[c] || '#ffffff';
          strokeCol = c;
        }
        const vx = P.vx[i], vy = P.vy[i];
        const speed = Math.sqrt(vx * vx + vy * vy);
        const len = speed > 1 ? Math.min(30, Math.max(2.5, speed * 0.04)) / speed : 0;
        ctx.lineWidth = s;
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x - vx * len, y - vy * len);
        ctx.stroke();
        break;
      }
      case K_FLAME: {
        // White hot when new, down the ramp to a dull red as it burns out.
        const u = 1 - P.life[i] / P.max[i];
        const k = u <= 0 ? 0 : u >= 1 ? 7 : (u * 8) | 0;
        ctx.drawImage(flame[k], x - s * 1.6, y - s * 1.6, s * 3.2, s * 3.2);
        break;
      }
      case K_HEART:
        ctx.drawImage(S.heart(c), x - s, y - s, s * 2, s * 2);
        break;
      case K_STAR: {
        const cr = Math.cos(P.rot[i]), sr = Math.sin(P.rot[i]);
        ctx.setTransform(
          W.a * cr + W.c * sr, W.b * cr + W.d * sr,
          W.c * cr - W.a * sr, W.d * cr - W.b * sr,
          W.a * x + W.c * y + W.e, W.b * x + W.d * y + W.f,
        );
        ctx.drawImage(S.star(c), -s, -s, s * 2, s * 2);
        setWorld(ctx, W);
        break;
      }
      default:
        break;
    }
  }
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = 1;
}

/**
 * @param top  true: the shapes flagged FXF_TOP; false: the ones on the turf
 */
export function drawFx(R, top) {
  const F = R.F, n = F.n;
  if (n === 0) return;
  const ctx = R.ctx, css = R.pal.css, S = R.sprites;
  setWorld(ctx, R.W);
  ctx.globalCompositeOperation = 'source-over';
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  let add = false;

  for (let i = 0; i < n; i++) {
    const f = F.flags[i];
    if (((f & FXF_TOP) !== 0) !== top) continue;
    const u = fxProgress(F, i);
    if (u < 0) continue;
    const wantAdd = (f & FXF_ADD) !== 0;
    if (wantAdd !== add) {
      add = wantAdd;
      ctx.globalCompositeOperation = add ? 'lighter' : 'source-over';
    }
    const x = F.x[i], y = F.y[i];
    const color = css[F.col[i]] || '#ffffff';
    const alpha = F.alpha[i] > 1 ? 1 : F.alpha[i];

    switch (F.kind[i]) {
      case FX_RING: {
        const r = F.r0[i] + (F.r1[i] - F.r0[i]) * ease.outCubic(u);
        if (!(r > 0.2)) break;
        ctx.globalAlpha = alpha * (1 - u);
        ctx.strokeStyle = color;
        ctx.lineWidth = Math.max(0.4, F.w[i] * (1 - 0.75 * u));
        ctx.beginPath();
        ctx.arc(x, y, r, 0, TAU);
        ctx.stroke();
        break;
      }
      case FX_GLOW: {
        const r = F.r0[i] + (F.r1[i] - F.r0[i]) * ease.outQuad(u);
        if (!(r > 0.2)) break;
        ctx.globalAlpha = alpha * (1 - u) * (1 - u);
        ctx.drawImage(S.glow(F.col[i]), x - r, y - r, r * 2, r * 2);
        break;
      }
      case FX_STAR: {
        const ro = F.r0[i] + (F.r1[i] - F.r0[i]) * ease.outCubic(u);
        if (!(ro > 0.2)) break;
        ctx.globalAlpha = alpha * (1 - u);
        ctx.fillStyle = color;
        ctx.beginPath();
        starPath(ctx, x, y, F.spikes[i] > 2 ? F.spikes[i] : 3, ro, ro * 0.36, F.rot[i] + u * 0.6);
        ctx.fill();
        break;
      }
      case FX_BEAM: {
        // A comet: the head races to the far end, the tail catches up and thins out.
        const head = ease.outQuad(u > 0.8 ? 1 : u / 0.8);
        const tail = head > 0.5 ? (head - 0.5) * 2 * u : 0;
        const dx = F.x2[i] - x, dy = F.y2[i] - y;
        const hx = x + dx * head, hy = y + dy * head;
        const tx = x + dx * tail, ty = y + dy * tail;
        const w = F.w[i];
        ctx.globalAlpha = alpha * (1 - u * u);
        ctx.strokeStyle = color;
        ctx.lineWidth = w * 0.45;
        ctx.beginPath();
        ctx.moveTo(tx, ty);
        ctx.lineTo(hx, hy);
        ctx.stroke();
        ctx.lineWidth = w;
        ctx.beginPath();
        ctx.moveTo(tx + (hx - tx) * 0.55, ty + (hy - ty) * 0.55);
        ctx.lineTo(hx, hy);
        ctx.stroke();
        ctx.drawImage(S.glow(F.col[i]), hx - w * 2, hy - w * 2, w * 4, w * 4);
        break;
      }
      default:
        break;
    }
  }
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = 1;
}

const ghostM = { a: 1, b: 0, c: 0, d: 1 };

/** After-images of dashing and diving footballers: fading copies of the stretched body. */
export function drawGhosts(R) {
  const G = R.ghosts, ctx = R.ctx, css = R.pal.css, vis = R.vis;
  let any = false;
  for (let i = 0; i < G.cap; i++) {
    const life = G.life[i];
    if (!(life > 0)) continue;
    const x = G.x[i], y = G.y[i];
    if (x < vis.x0 - 60 || x > vis.x1 + 60 || y < vis.y0 - 60 || y > vis.y1 + 60) continue;
    const u = life / G.max[i];
    poseMatrix(G.dir[i], G.sa[i], G.sb[i], 0, 1, 1, ghostM);
    setLocal(ctx, R.W, ghostM, x, y);
    ctx.globalAlpha = 0.42 * u * u;
    ctx.fillStyle = css[G.col[i]] || '#ffffff';
    ctx.beginPath();
    ctx.arc(0, 0, G.r[i] * (0.82 + 0.18 * u), 0, TAU);
    ctx.fill();
    any = true;
  }
  if (any) ctx.globalAlpha = 1;
}
