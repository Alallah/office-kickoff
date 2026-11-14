// The pitch. paintGround() draws everything that never changes during a match - grass, mown
// stripes, floodlight falloff, crests, markings, goal floors and the boards - once into a cached
// layer (layers.js). The rest of this file is what does change: scuff marks, the closed keeper
// box, the golden-goal glow and ripples on the boards, the nets and the posts.

import { drawCrest } from '../../shared/crests.js';
import { makeRng, TAU, wobble } from './mathx.js';
import { rgba } from './color.js';
import { postX, postY, sideSign } from './geom.js';
import { RIPPLE_SPEED, rippleAlive } from './fxpool.js';
import { BOARD_BODY, BOARD_RIM, BOARD_T, BOARD_TOP, GRASS, GRASS_STRIPE, INK, LINE_COLOR, LINE_W } from './look.js';
import { TOKENS } from './model.js';
import { boardHalfPath, roundRectPath, setWorld } from './shapes.js';

const NO_DASH = [];
const DASH_BOX = [16, 11];

/** World rectangle of the ground layer: the pitch, the nets and the boards, with room for their shadow. */
export function groundRect(M, out) {
  const pm = M.pm;
  const mx = pm.goalDepth + BOARD_T + 26, my = BOARD_T + 26;
  out.x = -(pm.halfW + mx);
  out.y = -(pm.halfH + my);
  out.w = 2 * (pm.halfW + mx);
  out.h = 2 * (pm.halfH + my);
  return out;
}

function softSpot(g, x, y, rx, ry, color, alpha) {
  g.save();
  g.translate(x, y);
  g.scale(rx, ry);
  const grad = g.createRadialGradient(0, 0, 0, 0, 0, 1);
  grad.addColorStop(0, rgba(color, alpha));
  grad.addColorStop(1, rgba(color, 0));
  g.fillStyle = grad;
  g.beginPath();
  g.arc(0, 0, 1, 0, TAU);
  g.fill();
  g.restore();
}

function strokeBoards(g, pm, off, width, style) {
  g.lineWidth = width;
  g.strokeStyle = style;
  g.beginPath();
  boardHalfPath(g, pm, off, -1);
  g.stroke();
  g.beginPath();
  boardHalfPath(g, pm, off, 1);
  g.stroke();
}

/**
 * Paints the static pitch. `g` must already map world units to the layer's pixels.
 * Outside the boards the layer stays transparent: the stands layer shows through.
 */
export function paintGround(g, M) {
  const pm = M.pm, hw = pm.halfW, hh = pm.halfH;
  const rng = makeRng((Math.round(M.matchId) * 31 + 0x9e37) >>> 0);

  // ---- turf, clipped to the rounded playing area ------------------------------------------
  g.save();
  g.beginPath();
  roundRectPath(g, hw, hh, pm.cornerR);
  g.clip();

  g.fillStyle = GRASS;
  g.fillRect(-hw, -hh, pm.width, pm.height);

  // Mown stripes; an even count puts the halfway line on a seam.
  const stripes = Math.max(6, 2 * Math.round(pm.width / 220));
  const sw = pm.width / stripes;
  g.fillStyle = GRASS_STRIPE;
  for (let i = 0; i < stripes; i += 2) g.fillRect(-hw + i * sw, -hh, sw, pm.height);
  // The mower went across as well: a faint lattice.
  const bands = Math.max(4, 2 * Math.round(pm.height / 220));
  const sh = pm.height / bands;
  g.fillStyle = 'rgba(255,255,255,0.024)';
  for (let j = 0; j < bands; j += 2) g.fillRect(-hw, -hh + j * sh, pm.width, sh);

  // Blades catching the light, so the turf is not a flat fill.
  const specks = Math.round((pm.width * pm.height) / 640);
  g.fillStyle = 'rgba(255,255,255,0.045)';
  for (let k = 0; k < specks; k++) g.fillRect(-hw + rng() * pm.width, -hh + rng() * pm.height, 1.3 + rng() * 1.5, 2.2 + rng() * 2.6);
  g.fillStyle = 'rgba(0,22,10,0.075)';
  for (let k = 0; k < specks; k++) g.fillRect(-hw + rng() * pm.width, -hh + rng() * pm.height, 1.3 + rng() * 1.5, 2.2 + rng() * 2.6);

  // Worn turf in the goal mouths and round the centre spot.
  softSpot(g, -hw + 40, 0, 74, pm.goalHalf * 1.05, '#c4b260', 0.1);
  softSpot(g, hw - 40, 0, 74, pm.goalHalf * 1.05, '#c4b260', 0.1);
  softSpot(g, 0, 0, 52, 52, '#c4b260', 0.07);

  // Floodlights: bright in the middle, falling away into the corners, with a pool of light
  // where each corner mast is aimed.
  const reach = Math.sqrt(hw * hw + hh * hh);
  const fall = g.createRadialGradient(0, 0, Math.min(hw, hh) * 0.2, 0, 0, reach * 1.02);
  fall.addColorStop(0, 'rgba(255,255,255,0.075)');
  fall.addColorStop(0.55, 'rgba(255,255,255,0)');
  fall.addColorStop(1, 'rgba(0,12,6,0.38)');
  g.fillStyle = fall;
  g.fillRect(-hw, -hh, pm.width, pm.height);
  for (let c = 0; c < 4; c++) {
    softSpot(g, (c & 1 ? 1 : -1) * hw * 0.52, (c & 2 ? 1 : -1) * hh * 0.46, hh * 0.9, hh * 0.72, '#d6ffe2', 0.055);
  }

  // Team crests, faintly, between each keeper box and the centre circle.
  const inner = pm.centerR + 30, outer = hw - pm.boxDepth - 30;
  if (outer > inner + 60) {
    const size = Math.min((outer - inner) * 0.74, pm.height * 0.46, 300);
    const cx = (inner + outer) / 2;
    drawCrest(g, M.teams[0].crest, -cx, 0, size, M.teams[0].primary, M.teams[0].secondary, 0.13);
    drawCrest(g, M.teams[1].crest, cx, 0, size, M.teams[1].primary, M.teams[1].secondary, 0.13);
  }

  // ---- markings ---------------------------------------------------------------------------
  const inset = LINE_W / 2 + 1.5;
  g.globalAlpha = 0.93;
  g.strokeStyle = LINE_COLOR;
  g.fillStyle = LINE_COLOR;
  g.lineWidth = LINE_W;
  g.lineJoin = 'round';
  g.lineCap = 'butt';
  g.beginPath();
  roundRectPath(g, hw - inset, hh - inset, Math.max(0, pm.cornerR - inset));
  g.stroke();
  g.beginPath();
  g.moveTo(0, -hh + inset);
  g.lineTo(0, hh - inset);
  g.stroke();
  g.beginPath();
  g.arc(0, 0, pm.centerR, 0, TAU);
  g.stroke();
  g.beginPath();
  g.arc(0, 0, 6, 0, TAU);
  g.fill();
  for (let s = -1; s <= 1; s += 2) {
    g.beginPath();
    g.moveTo(s * (hw - inset), -pm.boxHalfW);
    g.lineTo(s * (hw - pm.boxDepth), -pm.boxHalfW);
    g.lineTo(s * (hw - pm.boxDepth), pm.boxHalfW);
    g.lineTo(s * (hw - inset), pm.boxHalfW);
    g.stroke();
    g.beginPath();
    g.arc(s * (hw - pm.boxDepth * 0.62), 0, 4.5, 0, TAU);
    g.fill();
  }
  g.globalAlpha = 1;
  g.restore();

  // ---- goal floors ------------------------------------------------------------------------
  for (let s = -1; s <= 1; s += 2) {
    const x0 = s < 0 ? -(hw + pm.goalDepth) : hw;
    g.fillStyle = '#0d3f26';
    g.fillRect(x0, -pm.goalHalf, pm.goalDepth, pm.goalWidth);
    const depth = g.createLinearGradient(s * hw, 0, s * (hw + pm.goalDepth), 0);
    depth.addColorStop(0, 'rgba(0,0,0,0)');
    depth.addColorStop(1, 'rgba(0,0,0,0.45)');
    g.fillStyle = depth;
    g.fillRect(x0, -pm.goalHalf, pm.goalDepth, pm.goalWidth);
  }

  // ---- boards -----------------------------------------------------------------------------
  g.lineCap = 'round';
  g.lineJoin = 'round';
  g.save();
  g.translate(2.5, 4);
  strokeBoards(g, pm, BOARD_T / 2, BOARD_T + 5, 'rgba(0,0,0,0.32)');
  g.restore();
  strokeBoards(g, pm, BOARD_T / 2, BOARD_T, BOARD_BODY);
  strokeBoards(g, pm, BOARD_T / 2, BOARD_T - 7, BOARD_TOP);
  // Home colours along the left half of the boards, away colours along the right.
  const tint = g.createLinearGradient(-hw, 0, hw, 0);
  tint.addColorStop(0, rgba(M.teams[0].bright, 0.5));
  tint.addColorStop(0.44, rgba(M.teams[0].bright, 0));
  tint.addColorStop(0.56, rgba(M.teams[1].bright, 0));
  tint.addColorStop(1, rgba(M.teams[1].bright, 0.5));
  strokeBoards(g, pm, BOARD_T / 2, BOARD_T - 7, tint);

  // Seams between the board panels.
  const loop = M.wall;
  g.lineCap = 'butt';
  g.strokeStyle = 'rgba(4,8,18,0.5)';
  g.lineWidth = 1.4;
  g.beginPath();
  for (let i = 0; i < loop.n; i += 6) {
    if (loop.gap[i]) continue;
    const x = loop.x[i], y = loop.y[i], nx = loop.nx[i], ny = loop.ny[i];
    g.moveTo(x + nx * 1.5, y + ny * 1.5);
    g.lineTo(x + nx * (BOARD_T - 1.5), y + ny * (BOARD_T - 1.5));
  }
  g.stroke();

  // The rim the ball bounces off, and a thin highlight on the far edge.
  g.lineCap = 'round';
  g.globalAlpha = 0.82;
  strokeBoards(g, pm, 1.3, 2.2, BOARD_RIM);
  g.globalAlpha = 1;
  strokeBoards(g, pm, BOARD_T - 1, 1.2, 'rgba(255,255,255,0.1)');
}

// ---- dynamic pitch -----------------------------------------------------------------------------

/** Marks left by slide tackles: a gouge in the turf with soil showing through. */
export function drawScuffs(R) {
  const S = R.scuffs, ctx = R.ctx, vis = R.vis;
  let ready = false;
  for (let s = 0; s < S.cap; s++) {
    const life = S.life[s];
    if (!(life > 0)) continue;
    const x0 = S.x0[s], y0 = S.y0[s], x1 = S.x1[s], y1 = S.y1[s];
    if (Math.max(x0, x1) < vis.x0 - 30 || Math.min(x0, x1) > vis.x1 + 30 || Math.max(y0, y1) < vis.y0 - 30 || Math.min(y0, y1) > vis.y1 + 30) continue;
    if (!ready) {
      setWorld(ctx, R.W);
      ctx.lineCap = 'round';
      ready = true;
    }
    const a = Math.min(1, life / 1.3);
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(x1, y1);
    ctx.globalAlpha = 0.5 * a;
    ctx.strokeStyle = '#0b3a22';
    ctx.lineWidth = S.w[s];
    ctx.stroke();
    ctx.globalAlpha = 0.42 * a;
    ctx.strokeStyle = '#6d5b3a';
    ctx.lineWidth = S.w[s] * 0.34;
    ctx.stroke();
  }
  if (ready) ctx.globalAlpha = 1;
}

/** The keeper holds the ball: opponents cannot enter that box. A quiet red wash and marching outline. */
export function drawClosedBoxes(R) {
  const M = R.M, pm = M.pm, ctx = R.ctx;
  for (let side = 0; side < 2; side++) {
    const a = R.boxA[side];
    if (!(a > 0.01)) continue;
    const s = sideSign(side);
    const x0 = s < 0 ? -pm.halfW : pm.halfW - pm.boxDepth;
    setWorld(ctx, R.W);
    ctx.globalAlpha = 0.085 * a;
    ctx.fillStyle = TOKENS.danger;
    ctx.fillRect(x0, -pm.boxHalfW, pm.boxDepth, 2 * pm.boxHalfW);
    ctx.globalAlpha = 0.7 * a;
    ctx.strokeStyle = TOKENS.danger;
    ctx.lineWidth = 3.5;
    ctx.lineCap = 'butt';
    ctx.lineJoin = 'round';
    ctx.setLineDash(DASH_BOX);
    ctx.lineDashOffset = -R.wall * 34;
    ctx.beginPath();
    ctx.moveTo(s * pm.halfW, -pm.boxHalfW);
    ctx.lineTo(s * (pm.halfW - pm.boxDepth), -pm.boxHalfW);
    ctx.lineTo(s * (pm.halfW - pm.boxDepth), pm.boxHalfW);
    ctx.lineTo(s * pm.halfW, pm.boxHalfW);
    ctx.stroke();
    ctx.setLineDash(NO_DASH);
    ctx.globalAlpha = 1;
  }
}

function boardPaths(R) {
  let p = R.boardPaths;
  if (!p || p.M !== R.M) {
    p = R.boardPaths = { M: R.M, top: new Path2D(), bottom: new Path2D() };
    boardHalfPath(p.top, R.M.pm, BOARD_T / 2, -1);
    boardHalfPath(p.bottom, R.M.pm, BOARD_T / 2, 1);
  }
  return p;
}

/** Golden goal: the boards glow gold, breathing slowly. */
export function drawBoardGold(R) {
  const a = R.goldA;
  if (!(a > 0.01)) return;
  const ctx = R.ctx, p = boardPaths(R);
  const breath = 0.5 + 0.5 * Math.sin(R.wall * 2.1);
  setWorld(ctx, R.W);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = TOKENS.gold;
  ctx.globalAlpha = a * (0.3 + 0.22 * breath);
  ctx.lineWidth = BOARD_T - 5;
  ctx.stroke(p.top);
  ctx.stroke(p.bottom);
  ctx.globalCompositeOperation = 'lighter';
  ctx.globalAlpha = a * (0.1 + 0.14 * breath);
  ctx.lineWidth = BOARD_T + 12;
  ctx.stroke(p.top);
  ctx.stroke(p.bottom);
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = 1;
}

/** Half width, in loop samples, of the bulge that runs along a board after a hit. */
const RIPPLE_SPAN = 5;

/** Board ripples: after a bounce a bright bulge runs away from the contact point in both directions. */
export function drawRipples(R) {
  const Q = R.ripples, loop = R.M.wall, ctx = R.ctx, n = loop.n;
  let ready = false;
  for (let i = 0; i < Q.cap; i++) {
    if (!rippleAlive(Q, i)) continue;
    const u = Q.age[i] / Q.life[i];
    const fade = 1 - u, str = Q.str[i];
    const front = Q.age[i] * RIPPLE_SPEED;
    const amp = 5.5 * str * fade;
    if (!ready) {
      setWorld(ctx, R.W);
      ctx.globalCompositeOperation = 'lighter';
      ctx.strokeStyle = BOARD_RIM;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ready = true;
    }
    ctx.globalAlpha = Math.min(1, 0.95 * str * fade + 0.1 * fade);
    ctx.lineWidth = BOARD_T * (0.42 + 0.3 * fade);
    ctx.beginPath();
    for (let dir = -1; dir <= 1; dir += 2) {
      const centre = Q.idx[i] + dir * front;
      let open = false;
      for (let k = -RIPPLE_SPAN; k <= RIPPLE_SPAN; k++) {
        let idx = Math.round(centre + k) % n;
        if (idx < 0) idx += n;
        if (loop.gap[idx]) {
          open = false;
          continue;
        }
        const off = BOARD_T * 0.5 + amp * (1 - Math.abs(k) / (RIPPLE_SPAN + 1));
        const px = loop.x[idx] + loop.nx[idx] * off, py = loop.y[idx] + loop.ny[idx] * off;
        if (open) ctx.lineTo(px, py);
        else {
          ctx.moveTo(px, py);
          open = true;
        }
      }
    }
    ctx.stroke();
  }
  if (ready) {
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
  }
}

// ---- nets and posts ----------------------------------------------------------------------------

const netBuf = { n: 0, x: null, y: null };

/** How far beyond its resting shape a net can reach (world units), for culling. */
const NET_REACH = 74;

function netNodes(N, pm, side) {
  const cols = N.ny + 1, rows = N.nd + 1, total = cols * rows;
  if (netBuf.n < total) {
    netBuf.x = new Float32Array(total);
    netBuf.y = new Float32Array(total);
    netBuf.n = total;
  }
  const X = netBuf.x, Y = netBuf.y, s = sideSign(side);
  for (let j = 0; j < rows; j++) {
    const fj = j / N.nd;
    // The back of the net bulges most at the back, and not at all on the goal line.
    const depth = Math.pow(fj, 1.6);
    const bx = s * (pm.halfW + pm.goalDepth * fj);
    for (let k = 0; k < cols; k++) {
      const fk = k / N.ny;
      const i = j * cols + k;
      X[i] = bx + s * N.b[k] * depth;
      Y[i] = -pm.goalHalf + pm.goalWidth * fk - N.st[j] * (1 - fk) * (1 - fk) + N.sb[j] * fk * fk;
    }
  }
}

/** One goal net seen from above: a diamond mesh inside a frame, bulging where the net model says. */
export function drawNet(R, side) {
  const pm = R.M.pm, N = R.nets[side], ctx = R.ctx, vis = R.vis;
  const s = sideSign(side);
  const xa = s * pm.halfW, xb = s * (pm.halfW + pm.goalDepth + NET_REACH);
  if (Math.max(xa, xb) < vis.x0 || Math.min(xa, xb) > vis.x1) return;
  if (pm.goalHalf + NET_REACH < vis.y0 || -pm.goalHalf - NET_REACH > vis.y1) return;

  netNodes(N, pm, side);
  const cols = N.ny + 1, rows = N.nd + 1, X = netBuf.x, Y = netBuf.y;
  setWorld(ctx, R.W);
  ctx.globalAlpha = 1;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  ctx.beginPath();
  for (let j = 0; j < rows - 1; j++) {
    for (let k = 0; k < cols - 1; k++) {
      const a = j * cols + k, b = a + cols + 1, c = a + 1, d = a + cols;
      ctx.moveTo(X[a], Y[a]);
      ctx.lineTo(X[b], Y[b]);
      ctx.moveTo(X[c], Y[c]);
      ctx.lineTo(X[d], Y[d]);
    }
  }
  ctx.strokeStyle = 'rgba(232,240,255,0.42)';
  ctx.lineWidth = 1.05;
  ctx.stroke();

  // Frame: down the top side, along the back, up the bottom side.
  ctx.beginPath();
  ctx.moveTo(X[0], Y[0]);
  for (let j = 1; j < rows; j++) ctx.lineTo(X[j * cols], Y[j * cols]);
  for (let k = 1; k < cols; k++) ctx.lineTo(X[(rows - 1) * cols + k], Y[(rows - 1) * cols + k]);
  for (let j = rows - 2; j >= 0; j--) ctx.lineTo(X[j * cols + cols - 1], Y[j * cols + cols - 1]);
  ctx.strokeStyle = 'rgba(240,246,255,0.9)';
  ctx.lineWidth = 2.6;
  ctx.stroke();
}

/** The four goal posts; a post that has just been hit rings for a moment. */
export function drawPosts(R) {
  const pm = R.M.pm, ctx = R.ctx, vis = R.vis, r = pm.postR;
  let ready = false;
  for (let k = 0; k < 4; k++) {
    let x = postX(pm, k), y = postY(pm, k);
    if (x < vis.x0 - 20 || x > vis.x1 + 20 || y < vis.y0 - 20 || y > vis.y1 + 20) continue;
    if (!ready) {
      setWorld(ctx, R.W);
      ctx.globalAlpha = 1;
      ready = true;
    }
    const ring = R.postShake[k];
    if (ring > 0 && !R.reduced) {
      const amp = Math.min(1, ring / 0.35) * 2.6;
      x += wobble(R.wall * 95, k + 1) * amp;
      y += wobble(R.wall * 95, k + 7) * amp;
    }
    ctx.fillStyle = INK;
    ctx.beginPath();
    ctx.arc(x, y, r + 1.4, 0, TAU);
    ctx.fill();
    ctx.fillStyle = '#e9effc';
    ctx.beginPath();
    ctx.arc(x, y, r, 0, TAU);
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(x - r * 0.26, y - r * 0.26, r * 0.44, 0, TAU);
    ctx.fill();
  }
}
