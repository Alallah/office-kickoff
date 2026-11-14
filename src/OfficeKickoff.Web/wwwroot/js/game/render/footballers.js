// Draws the footballers prepared by actors.js, in three passes so that everything overlaps the
// right way round:
//
//   ground  shadows, light on the turf (charge glow, my halo), control rings
//   bodies  speed lines, the shirt with its number, the facing marker, keeper gloves
//   tops    dizzy stars, the tackle-immune shimmer, my stamina / charge arcs and cooldown pip
//
// A footballer is a circle seen from above; states are told by its pose (poses.js), by what it
// gives off (actors.js) and by the marks drawn here.

import { ACTION, PLAYER_FLAG } from '../../shared/protocol.js';
import { clamp01, num, TAU } from './mathx.js';
import { HEAT16 } from './color.js';
import { ellipseRadius } from './geom.js';
import { INK } from './look.js';
import { TOKENS } from './model.js';
import { arrowPath, setLocal, setWorld, setWorldAt } from './shapes.js';
import { FONT_DISPLAY, makeCanvas } from './sprites.js';

const NO_DASH = [];
const DASH_MINE = [9, 6.5];
const DASH_TARGET = [7, 6];

const GLOVE = '#f4f7ff';
const GLOVE_R = 5.3;

/** Pixels per world unit of the shirt-number sprites. */
const NUMBER_SS = 3;

/** Half spans of my stamina arc (below the footballer) and charge arc (above), radians. */
const STAMINA_SPAN = 1.05;
const CHARGE_SPAN = 1.25;
/** Where on my ring the cooldown pip sits (just right of centre, between the two arcs). */
const PIP_ANGLE = 0.1;

let measure = null;

function buildNumber(text, px, ink) {
  const font = `700 ${px}px ${FONT_DISPLAY}`;
  if (!measure) measure = makeCanvas(1, 1).getContext('2d');
  measure.font = font;
  const mt = measure.measureText(text);
  // Centred on the glyphs' own box, not on the font's line box: digits have no descenders.
  const asc = num(mt.actualBoundingBoxAscent, px * 0.72);
  const desc = num(mt.actualBoundingBoxDescent, 0);
  const pad = 3;
  const c = makeCanvas(num(mt.width, px * 0.6 * text.length) + pad * 2, asc + desc + pad * 2);
  const g = c.getContext('2d');
  g.font = font;
  g.textAlign = 'center';
  g.textBaseline = 'alphabetic';
  g.fillStyle = ink;
  g.fillText(text, c.width / 2, pad + asc);
  return { c, w: c.width / NUMBER_SS, h: c.height / NUMBER_SS };
}

/** The shirt-number bitmap of a footballer; remembered on the actor so the frame path builds no keys. */
function numberSprite(R, a) {
  if (a.numSprite && a.numFor === R.M && a.numN === a.number && a.numInk === a.ink) return a.numSprite;
  let cache = R.numbers;
  if (!cache || cache.M !== R.M) cache = R.numbers = { M: R.M, map: new Map() };
  const key = `${a.number}|${a.ink}`;
  let sprite = cache.map.get(key);
  if (!sprite) {
    sprite = buildNumber(String(a.number), Math.round(R.M.playerR * 1.02 * NUMBER_SS), a.ink);
    cache.map.set(key, sprite);
  }
  a.numFor = R.M;
  a.numN = a.number;
  a.numInk = a.ink;
  a.numSprite = sprite;
  return sprite;
}

function glove(ctx, x, y) {
  ctx.fillStyle = INK;
  ctx.beginPath();
  ctx.arc(x, y, GLOVE_R + 1.2, 0, TAU);
  ctx.fill();
  ctx.fillStyle = GLOVE;
  ctx.beginPath();
  ctx.arc(x, y, GLOVE_R, 0, TAU);
  ctx.fill();
}

/** A keeper's gloves: out to the sides at rest, together and reaching along the dive. */
function gloves(ctx, a, r) {
  const q = a.pose;
  const diving = a.action === ACTION.DIVE;
  const dir = diving ? a.actionDir : a.face;
  const spread = diving ? 0.3 : 0.64;
  const reach = diving ? 5 : 1.5;
  const k = (Math.abs(q.kx) + Math.abs(q.ky)) * 0.5;
  for (let s = -1; s <= 1; s += 2) {
    const ang = dir + s * spread;
    const d = ellipseRadius(r * q.sa * k, r * q.sb * k, q.dir, ang) + reach;
    glove(ctx, Math.cos(ang) * d, Math.sin(ang) * d);
  }
}

/** The gloves of the keeper who holds the ball, wrapped round it. Drawn after the ball. */
export function drawHeldGloves(R) {
  const b = R.ball.v;
  if (!b.ok || !b.held || b.owner < 0 || b.owner >= R.actors.length) return;
  const a = R.actors[b.owner];
  if (!a.ok || !a.visible) return;
  const ctx = R.ctx, br = R.M.ballR;
  let dx = b.x - a.gx, dy = b.y - a.gy;
  const d = Math.sqrt(dx * dx + dy * dy);
  if (d > 1) {
    dx /= d;
    dy /= d;
  } else {
    dx = Math.cos(a.face);
    dy = Math.sin(a.face);
  }
  setWorld(ctx, R.W);
  ctx.globalAlpha = 1;
  for (let s = -1; s <= 1; s += 2) {
    glove(ctx, b.x - dy * s * br * 0.86 - dx * br * 0.2, b.y + dx * s * br * 0.86 - dy * br * 0.2);
  }
}

// ---- pass 1: on the turf ------------------------------------------------------------------------

export function drawFootballerGround(R) {
  const M = R.M, ctx = R.ctx, W = R.W, S = R.sprites, r = M.playerR;
  const order = R.order, n = R.orderN, actors = R.actors;

  // Shadows shrink and pale as a footballer leaves the ground.
  const shadow = S.shadow();
  for (let k = 0; k < n; k++) {
    const a = actors[order[k]];
    if (!a.visible) continue;
    const lift = a.pose.lift;
    const half = (3.2 * r) / (1 + lift / 110);
    ctx.globalAlpha = 0.95 / (1 + lift / 45);
    setLocal(ctx, W, a.ms, a.gx, a.gy);
    ctx.drawImage(shadow, -half, -half + r * 0.1, 2 * half, 2 * half);
  }
  ctx.globalAlpha = 1;

  // Light: the halo under my footballer, and the glow of a shot being charged.
  let lit = false;
  const flame = S.flame();
  for (let k = 0; k < n; k++) {
    const a = actors[order[k]];
    if (!a.visible) continue;
    const charging = (a.flags & PLAYER_FLAG.CHARGING) !== 0 && a.charge > 0.02;
    const halo = a.mine && a.human !== null;
    if (!charging && !halo) continue;
    if (!lit) {
      setWorld(ctx, W);
      ctx.globalCompositeOperation = 'lighter';
      lit = true;
    }
    if (halo) {
      const g = (r + 18) * (1 + 0.05 * Math.sin(R.wall * 5.2));
      ctx.globalAlpha = 0.42;
      ctx.drawImage(S.glow(a.human.cColor), a.gx - g, a.gy - g, 2 * g, 2 * g);
    }
    if (charging) {
      const c = a.charge, hot = c >= M.fire;
      const g = r * (1.5 + 1.5 * c) * (1 + 0.07 * Math.sin(R.t * (12 + 18 * c))) * (hot ? 1.12 : 1);
      ctx.globalAlpha = Math.min(1, 0.35 + 0.55 * c);
      ctx.drawImage(flame[hot ? 1 : Math.round(6 - 4 * c)], a.gx - g, a.gy - g, 2 * g, 2 * g);
    }
  }
  if (lit) {
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
  }

  // Rings: every human-controlled footballer wears its human's colour; mine is brighter and
  // turns; the team-mate a pass would go to gets a cyan one.
  ctx.lineCap = 'butt';
  for (let k = 0; k < n; k++) {
    const a = actors[order[k]];
    if (!a.visible) continue;
    const human = a.human, target = a.i === R.passTarget;
    if (!human && !target) continue;
    setWorldAt(ctx, W, a.gx, a.gy);
    if (human) {
      const rr = r + 6.5;
      ctx.globalAlpha = 0.55;
      ctx.strokeStyle = INK;
      ctx.lineWidth = a.mine ? 6 : 5.2;
      ctx.beginPath();
      ctx.arc(0, 0, rr, 0, TAU);
      ctx.stroke();
      if (a.mine) {
        ctx.globalAlpha = 1;
        ctx.strokeStyle = human.light;
        ctx.lineWidth = 3.8;
        ctx.setLineDash(DASH_MINE);
        ctx.lineDashOffset = -R.wall * 28;
        ctx.beginPath();
        ctx.arc(0, 0, rr, 0, TAU);
        ctx.stroke();
        ctx.setLineDash(NO_DASH);
        ctx.strokeStyle = human.color;
        ctx.lineWidth = 1.4;
        ctx.beginPath();
        ctx.arc(0, 0, rr - 3.3, 0, TAU);
        ctx.stroke();
      } else {
        ctx.globalAlpha = 0.95;
        ctx.strokeStyle = human.color;
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.arc(0, 0, rr, 0, TAU);
        ctx.stroke();
      }
    }
    if (target) {
      const rr = r + 11.5 + 1.8 * Math.sin(R.wall * 9);
      ctx.globalAlpha = 0.9;
      ctx.strokeStyle = TOKENS.cyan;
      ctx.lineWidth = 3;
      ctx.setLineDash(DASH_TARGET);
      ctx.lineDashOffset = R.wall * 34;
      ctx.beginPath();
      ctx.arc(0, 0, rr, 0, TAU);
      ctx.stroke();
      ctx.setLineDash(NO_DASH);
    }
  }
  ctx.globalAlpha = 1;
}

// ---- pass 2: bodies ------------------------------------------------------------------------------

export function drawFootballerBodies(R) {
  const M = R.M, ctx = R.ctx, W = R.W, r = M.playerR;
  const order = R.order, n = R.orderN, actors = R.actors;
  const holder = R.ball.v.ok && R.ball.v.held ? R.ball.v.owner : -1;

  // Speed lines streaming behind sprinters.
  let lines = false;
  for (let k = 0; k < n; k++) {
    const a = actors[order[k]];
    if (!a.visible || !(a.flags & PLAYER_FLAG.SPRINTING) || a.action !== ACTION.NONE || a.speed < M.sprintSpeed * 0.55) continue;
    if (!lines) {
      setWorld(ctx, W);
      ctx.globalAlpha = 1;
      ctx.strokeStyle = 'rgba(255,255,255,0.42)';
      ctx.lineWidth = 2.2;
      ctx.lineCap = 'round';
      ctx.beginPath();
      lines = true;
    }
    const inv = 1 / a.speed;
    const ux = a.vx * inv, uy = a.vy * inv;
    for (let j = -1; j <= 1; j++) {
      const flick = 0.55 + 0.45 * Math.sin(R.t * 31 + a.i * 2.3 + j * 1.9);
      const len = (j === 0 ? 20 : 13) * flick;
      const x0 = a.gx - ux * (r + 4) - uy * j * 9, y0 = a.gy - uy * (r + 4) + ux * j * 9;
      ctx.moveTo(x0, y0);
      ctx.lineTo(x0 - ux * len, y0 - uy * len);
    }
  }
  if (lines) ctx.stroke();

  ctx.globalAlpha = 1;
  ctx.lineJoin = 'round';
  for (let k = 0; k < n; k++) {
    const a = actors[order[k]];
    if (!a.visible) continue;

    // The shirt: ink edge, trim ring, shirt colour, a soft highlight, the number.
    setLocal(ctx, W, a.m, a.bx, a.by);
    ctx.fillStyle = INK;
    ctx.beginPath();
    ctx.arc(0, 0, r + 1.1, 0, TAU);
    ctx.fill();
    ctx.fillStyle = a.trim;
    ctx.beginPath();
    ctx.arc(0, 0, r - 0.3, 0, TAU);
    ctx.fill();
    ctx.fillStyle = a.fill;
    ctx.beginPath();
    ctx.arc(0, 0, r - 3.5, 0, TAU);
    ctx.fill();
    if (a.keeper) {
      ctx.globalAlpha = 0.75;
      ctx.strokeStyle = a.trim;
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.arc(0, 0, r * 0.74, 0, TAU);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
    ctx.fillStyle = 'rgba(255,255,255,0.16)';
    ctx.beginPath();
    ctx.ellipse(-r * 0.28, -r * 0.36, r * 0.46, r * 0.26, -0.55, 0, TAU);
    ctx.fill();
    const digits = numberSprite(R, a);
    ctx.drawImage(digits.c, -digits.w / 2, -digits.h / 2, digits.w, digits.h);
    if (a.action === ACTION.STUNNED) {
      // Seeing stars: the lights go down on the shirt.
      ctx.fillStyle = 'rgba(8,12,28,0.3)';
      ctx.beginPath();
      ctx.arc(0, 0, r - 0.3, 0, TAU);
      ctx.fill();
    }

    // Which way it faces: a nose on outfield footballers, the gloves on a keeper.
    setWorldAt(ctx, W, a.bx, a.by);
    if (a.keeper) {
      if (a.i !== holder) gloves(ctx, a, r);
    } else {
      ctx.beginPath();
      arrowPath(ctx, 0, 0, a.face, a.edge + 7.5, a.edge - 0.6, 5.4);
      ctx.fillStyle = a.marker;
      ctx.fill();
      ctx.strokeStyle = INK;
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
  }
}

// ---- pass 3: above the bodies -----------------------------------------------------------------

function myHud(R, a) {
  const ctx = R.ctx, M = R.M, ra = M.playerR + 13.5;
  setWorldAt(ctx, R.W, a.gx, a.gy);
  ctx.lineCap = 'round';

  // Stamina: an arc below the footballer that drains towards the left.
  const s0 = Math.PI / 2 - STAMINA_SPAN, s1 = Math.PI / 2 + STAMINA_SPAN;
  const exhausted = (a.flags & PLAYER_FLAG.EXHAUSTED) !== 0;
  ctx.globalAlpha = 0.5 * R.stamA;
  ctx.strokeStyle = INK;
  ctx.lineWidth = 5.4;
  ctx.beginPath();
  ctx.arc(0, 0, ra, s0, s1);
  ctx.stroke();
  if (a.stamina > 0.01) {
    ctx.globalAlpha = (exhausted ? 0.5 : 1) * R.stamA;
    ctx.strokeStyle = exhausted ? TOKENS.danger : a.stamina < 0.3 ? TOKENS.warn : TOKENS.lime;
    ctx.lineWidth = 3.2;
    ctx.beginPath();
    ctx.arc(0, 0, ra, s1 - 2 * STAMINA_SPAN * a.stamina, s1);
    ctx.stroke();
  }

  // Shot charge: an arc above the footballer that fills left to right and heats up as it does;
  // past the notch the shot is on fire.
  if ((a.flags & PLAYER_FLAG.CHARGING) !== 0 || a.charge > 0.01) {
    const c = a.charge, hot = c >= M.fire;
    const c0 = -Math.PI / 2 - CHARGE_SPAN, c1 = -Math.PI / 2 + CHARGE_SPAN;
    ctx.globalAlpha = 0.55;
    ctx.strokeStyle = INK;
    ctx.lineWidth = 6.4;
    ctx.beginPath();
    ctx.arc(0, 0, ra, c0, c1);
    ctx.stroke();
    if (c > 0.005) {
      ctx.globalAlpha = 1;
      ctx.strokeStyle = HEAT16[Math.round(c * 15)];
      ctx.lineWidth = 4.2;
      ctx.beginPath();
      ctx.arc(0, 0, ra, c0, c0 + 2 * CHARGE_SPAN * c);
      ctx.stroke();
      if (hot) {
        ctx.globalCompositeOperation = 'lighter';
        ctx.globalAlpha = R.reduced ? 0.5 : 0.45 + 0.3 * Math.sin(R.wall * 38);
        ctx.strokeStyle = '#ffb347';
        ctx.lineWidth = 8.5;
        ctx.stroke();
        ctx.globalCompositeOperation = 'source-over';
      }
    }
    const fa = c0 + 2 * CHARGE_SPAN * M.fire;
    ctx.globalAlpha = 0.9;
    ctx.strokeStyle = TOKENS.gold;
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.moveTo(Math.cos(fa) * (ra - 4.4), Math.sin(fa) * (ra - 4.4));
    ctx.lineTo(Math.cos(fa) * (ra + 4.4), Math.sin(fa) * (ra + 4.4));
    ctx.stroke();
  }

  // Tackle / dash cooldown: a pip that fills like a clock and pops when it is ready again.
  const px = Math.cos(PIP_ANGLE) * ra, py = Math.sin(PIP_ANGLE) * ra;
  const left = clamp01(a.cd / M.cooldown);
  if (left > 0) {
    ctx.globalAlpha = 0.62;
    ctx.fillStyle = INK;
    ctx.beginPath();
    ctx.arc(px, py, 4.7, 0, TAU);
    ctx.fill();
    ctx.globalAlpha = 0.8;
    ctx.fillStyle = TOKENS.cyan;
    ctx.beginPath();
    ctx.moveTo(px, py);
    ctx.arc(px, py, 3.6, -Math.PI / 2, -Math.PI / 2 + TAU * (1 - left));
    ctx.closePath();
    ctx.fill();
  } else {
    const pop = 1 + 1.1 * clamp01(R.pipPop / 0.3);
    ctx.globalAlpha = 1;
    ctx.fillStyle = INK;
    ctx.beginPath();
    ctx.arc(px, py, 4.5 * pop, 0, TAU);
    ctx.fill();
    ctx.fillStyle = TOKENS.cyan;
    ctx.beginPath();
    ctx.arc(px, py, 3.3 * pop, 0, TAU);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}

export function drawFootballerTops(R) {
  const M = R.M, ctx = R.ctx, W = R.W, S = R.sprites, r = M.playerR;
  const order = R.order, n = R.orderN, actors = R.actors;

  for (let k = 0; k < n; k++) {
    const a = actors[order[k]];
    if (!a.visible) continue;

    if (a.action === ACTION.STUNNED) {
      // Dizzy: three stars circling the head.
      const star = S.star(M.col.gold);
      setWorld(ctx, W);
      ctx.globalAlpha = 1;
      for (let j = 0; j < 3; j++) {
        const ph = R.t * 6.5 + (j * TAU) / 3 + a.i;
        const half = 5.2 + 1.2 * Math.sin(ph);
        ctx.drawImage(star, a.bx + Math.cos(ph) * r * 0.78 - half, a.by - r - 7 + Math.sin(ph) * 4.5 - half, 2 * half, 2 * half);
      }
    } else if (a.action === ACTION.RECOVER) {
      // Getting up: a ring that closes as the recovery runs out.
      const done = 1 - clamp01(a.actionT / M.recoverTime);
      setWorldAt(ctx, W, a.gx, a.gy);
      ctx.globalAlpha = 0.55;
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 2.2;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.arc(0, 0, r + 4.5, -Math.PI / 2, -Math.PI / 2 + TAU * Math.max(0.02, done));
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    if (a.flags & PLAYER_FLAG.IMMUNE) {
      // Tackle-immune: two bright arcs racing round the body.
      const ph = R.t * 19 + a.i;
      const g = r + 13;
      setWorldAt(ctx, W, a.bx, a.by);
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = 0.3;
      ctx.drawImage(S.glow(M.col.cyan), -g, -g, 2 * g, 2 * g);
      ctx.globalAlpha = 0.85;
      ctx.strokeStyle = '#dff8ff';
      ctx.lineWidth = 2.8;
      ctx.lineCap = 'round';
      for (let j = 0; j < 2; j++) {
        ctx.beginPath();
        ctx.arc(0, 0, r + 3.2, ph + j * Math.PI, ph + j * Math.PI + 1.25);
        ctx.stroke();
      }
      ctx.globalCompositeOperation = 'source-over';
      ctx.globalAlpha = 1;
    }

    if (a.i === R.passTarget) {
      // "The pass goes here": a chevron bobbing over the team-mate.
      const bob = 2.5 * Math.sin(R.wall * 9);
      setWorldAt(ctx, W, a.bx, a.by - r - 15 - bob);
      ctx.beginPath();
      arrowPath(ctx, 0, 0, Math.PI / 2, 6, -5, 6.5);
      ctx.globalAlpha = 1;
      ctx.fillStyle = TOKENS.cyan;
      ctx.fill();
      ctx.strokeStyle = INK;
      ctx.lineWidth = 1.5;
      ctx.lineJoin = 'round';
      ctx.stroke();
    }
  }

  if (R.mine >= 0) {
    const me = actors[R.mine];
    if (me.ok && me.visible && me.human) myHud(R, me);
  }
}
