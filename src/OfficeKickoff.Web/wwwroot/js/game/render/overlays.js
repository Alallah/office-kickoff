// Everything drawn over the world: aiming aids, name tags and speech bubbles, the off-screen
// arrows and the minimap, and the full-screen treatments (golden-goal vignette, slow-motion and
// replay grade, letterbox, flash).
//
// Most of it is drawn in CSS pixels (ctx.setTransform(edpr, 0, 0, edpr, 0, 0)); world points are
// taken through the frame's world matrix, so tags follow the footballers through a camera shake.

import { PLAYER_FLAG } from '../../shared/protocol.js';
import { clamp, ease, smoothstep, TAU } from './mathx.js';
import { HEAT16 } from './color.js';
import { bubbleScale } from './fxmodel.js';
import { edgePoint, minimapLayout } from './geom.js';
import { INK, NIGHT, TAG_GAP_PX } from './look.js';
import { TOKENS } from './model.js';
import { arrowPath, roundRectPath, setWorld } from './shapes.js';
import { BUBBLE_H, BUBBLE_W, buildLabel, makeCanvas, paintBubble } from './sprites.js';

const NO_DASH = [];
const DASH_AIM = [3, 7];
const DASH_PASS = [0.5, 13];

const AI_NAME = '#c9d4ee';

/** Off-screen arrows sit this far inside the edge of the screen (CSS px). */
const ARROW_INSET = 36;

// ---- labels ------------------------------------------------------------------------------------

function labelCache(R) {
  let cache = R.labels;
  if (!cache || cache.epoch !== R.epoch || cache.M !== R.M) {
    cache = R.labels = { epoch: R.epoch, M: R.M, map: new Map(), initials: [null, null, null, null] };
  }
  return cache;
}

function label(R, text, px, color) {
  const cache = labelCache(R);
  const key = `${px}|${color}|${text}`;
  let l = cache.map.get(key);
  if (!l) {
    l = buildLabel(text, px, color, R.edpr);
    cache.map.set(key, l);
  }
  return l;
}

/** The name tag of a footballer; remembered on the actor so the frame path builds no keys. */
function actorLabel(R, a, text, px, color) {
  if (a.tagLabel && a.tagEpoch === R.epoch && a.tagFor === R.M && a.tagText === text && a.tagColor === color && a.tagPx === px) {
    return a.tagLabel;
  }
  a.tagLabel = label(R, text, px, color);
  a.tagEpoch = R.epoch;
  a.tagFor = R.M;
  a.tagText = text;
  a.tagColor = color;
  a.tagPx = px;
  return a.tagLabel;
}

// ---- aiming ------------------------------------------------------------------------------------

/** A dotted line from my footballer to the team-mate a pass would reach, dots marching towards them. */
export function drawPassLink(R) {
  if (R.passTarget < 0 || R.mine < 0) return;
  const a = R.actors[R.mine], t = R.actors[R.passTarget];
  if (!a.ok || !t.ok) return;
  let dx = t.gx - a.gx, dy = t.gy - a.gy;
  const d = Math.sqrt(dx * dx + dy * dy);
  const r = R.M.playerR;
  const from = r + 12, to = d - (r + 15);
  if (!(to > from)) return;
  dx /= d;
  dy /= d;
  const ctx = R.ctx;
  setWorld(ctx, R.W);
  ctx.globalAlpha = 0.8;
  ctx.strokeStyle = TOKENS.cyan;
  ctx.lineWidth = 4;
  ctx.lineCap = 'round';
  ctx.setLineDash(DASH_PASS);
  ctx.lineDashOffset = -R.wall * 62;
  ctx.beginPath();
  ctx.moveTo(a.gx + dx * from, a.gy + dy * from);
  ctx.lineTo(a.gx + dx * to, a.gy + dy * to);
  ctx.stroke();
  ctx.setLineDash(NO_DASH);
  ctx.globalAlpha = 1;
}

/** This frame's aim, in CSS pixels: worked out by drawAimLine, used again by drawReticle. */
const aimGeo = { ok: false, ax: 0, ay: 0, px: 0, py: 0, charge: 0, color: '#ffffff' };

function aimGeometry(R, view) {
  aimGeo.ok = false;
  if (!(R.aimA > 0.02) || R.mine < 0) return false;
  const a = R.actors[R.mine];
  const aim = view.aim;
  if (!a.ok || !a.human || !aim || !(aim.x - aim.x === 0) || !(aim.y - aim.y === 0)) return false;
  const W = R.W, e = R.edpr;
  // The cursor by the camera formula, without the shake: the reticle stays under the mouse.
  aimGeo.ax = (aim.x - R.camX) * R.zoom + R.vw / 2;
  aimGeo.ay = (aim.y - R.camY) * R.zoom + R.vh / 2;
  aimGeo.px = (W.a * a.gx + W.c * a.gy + W.e) / e;
  aimGeo.py = (W.b * a.gx + W.d * a.gy + W.f) / e;
  aimGeo.charge = (a.flags & PLAYER_FLAG.CHARGING) !== 0 ? a.charge : 0;
  aimGeo.color = a.human.light;
  aimGeo.ok = true;
  return true;
}

/**
 * My aim: a quiet dotted line from my footballer towards the cursor. While a shot is charged it
 * fills with a power bar that grows and heats up. Drawn beneath the footballers.
 */
export function drawAimLine(R, view) {
  if (!aimGeometry(R, view)) return;
  const ctx = R.ctx, e = R.edpr, zoom = R.zoom, A = R.aimA;
  const px = aimGeo.px, py = aimGeo.py, charge = aimGeo.charge;
  let dx = aimGeo.ax - px, dy = aimGeo.ay - py;
  const d = Math.sqrt(dx * dx + dy * dy);
  if (!(d > 1)) return;
  dx /= d;
  dy /= d;
  const start = (R.M.playerR + 20) * zoom;
  const reach = Math.min(d - 13, (150 + 210 * charge) * zoom);
  if (!(reach > start + 4)) return;

  ctx.setTransform(e, 0, 0, e, 0, 0);
  ctx.lineCap = 'round';
  ctx.globalAlpha = A * (0.3 + 0.3 * charge);
  ctx.strokeStyle = aimGeo.color;
  ctx.lineWidth = 2;
  ctx.setLineDash(DASH_AIM);
  ctx.lineDashOffset = -R.wall * 30;
  ctx.beginPath();
  ctx.moveTo(px + dx * start, py + dy * start);
  ctx.lineTo(px + dx * reach, py + dy * reach);
  ctx.stroke();
  ctx.setLineDash(NO_DASH);

  if (charge > 0.02) {
    const hot = HEAT16[Math.round(charge * 15)];
    const tip = start + (reach - start) * charge;
    ctx.globalAlpha = A * (0.55 + 0.4 * charge);
    ctx.strokeStyle = hot;
    ctx.lineWidth = 3 + 3 * charge;
    ctx.beginPath();
    ctx.moveTo(px + dx * start, py + dy * start);
    ctx.lineTo(px + dx * tip, py + dy * tip);
    ctx.stroke();
    ctx.fillStyle = hot;
    ctx.beginPath();
    arrowPath(ctx, px + dx * tip, py + dy * tip, Math.atan2(dy, dx), 10 + 5 * charge, -2, 5 + 3 * charge);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}

/**
 * The reticle on the cursor: a ring with four ticks that closes in, turns and heats up while a
 * shot is charged. Drawn above the world. Needs drawAimLine to have run this frame.
 */
export function drawReticle(R) {
  if (!aimGeo.ok) return;
  const ctx = R.ctx, e = R.edpr, A = R.aimA;
  const ax = aimGeo.ax, ay = aimGeo.ay, charge = aimGeo.charge;
  const throb = charge >= 0.999 && !R.reduced ? 1.2 * Math.sin(R.wall * 22) : 0;
  const rr = 9 - 3 * charge + throb;
  const turn = charge > 0 ? R.wall * 3.2 : 0;

  ctx.setTransform(e, 0, 0, e, 0, 0);
  ctx.lineCap = 'round';
  ctx.globalAlpha = 0.5 * A;
  ctx.strokeStyle = INK;
  ctx.lineWidth = 4.2;
  ctx.beginPath();
  ctx.arc(ax, ay, rr, 0, TAU);
  ctx.stroke();
  ctx.globalAlpha = A;
  ctx.strokeStyle = charge > 0.02 ? HEAT16[Math.round(charge * 15)] : aimGeo.color;
  ctx.lineWidth = 2 + charge;
  ctx.beginPath();
  ctx.arc(ax, ay, rr, 0, TAU);
  for (let k = 0; k < 4; k++) {
    const ang = turn + (k * Math.PI) / 2;
    const c = Math.cos(ang), s = Math.sin(ang);
    ctx.moveTo(ax + c * (rr + 2.5), ay + s * (rr + 2.5));
    ctx.lineTo(ax + c * (rr + 7), ay + s * (rr + 7));
  }
  ctx.stroke();
  ctx.globalAlpha = 1;
}

// ---- name tags and speech bubbles --------------------------------------------------------------

/**
 * Names: every human's above their footballer in their colour; an AI footballer's surname, small
 * and dim, only while the ball is near. Also notes where each footballer's bubble would go.
 */
export function drawTags(R) {
  const ctx = R.ctx, W = R.W, e = R.edpr, r = R.M.playerR;
  const order = R.order, n = R.orderN, actors = R.actors;
  ctx.setTransform(e, 0, 0, e, 0, 0);
  for (let k = 0; k < n; k++) {
    const a = actors[order[k]];
    if (!a.visible) continue;
    // Clear of whatever surrounds the footballer: my arcs, a human's ring, or just the body.
    const top = a.human ? (a.mine ? r + 19.5 : r + 11.5) : r + 5;
    const wx = a.bx, wy = a.by - top;
    const X = (W.a * wx + W.c * wy + W.e) / e, Y = (W.b * wx + W.d * wy + W.f) / e;
    a.tagX = X;
    a.tagY = Y - 2;

    let tag = null, px = 12, alpha = 1;
    if (a.human) {
      px = a.mine ? 13 : 12;
      tag = actorLabel(R, a, a.human.name || `P${a.human.humanId + 1}`, px, a.human.light);
    } else if (a.nameA > 0.03 && a.surname) {
      px = 10;
      alpha = 0.62 * a.nameA;
      tag = actorLabel(R, a, a.surname, px, AI_NAME);
    }
    if (!tag) continue;
    // buildLabel puts the baseline at 1.08 px + 2 below the top of the bitmap.
    const ly = Y - TAG_GAP_PX - (px * 1.08 + 2);
    ctx.globalAlpha = alpha;
    ctx.drawImage(tag.c, X - tag.w / 2, ly, tag.w, tag.h);
    a.tagY = ly + px * 0.3;

    if (a.mine && a.switchAge < 1.2) {
      // "This one is you now": a chevron dropping in over the name after a switch.
      const bob = 3 * Math.abs(Math.sin(R.wall * 7));
      const cy = a.tagY - 9 - bob;
      ctx.globalAlpha = 1 - smoothstep(0.75, 1.2, a.switchAge);
      ctx.beginPath();
      arrowPath(ctx, X, cy, Math.PI / 2, 7, -5, 6.5);
      ctx.fillStyle = a.human.light;
      ctx.fill();
      ctx.strokeStyle = INK;
      ctx.lineWidth = 1.5;
      ctx.lineJoin = 'round';
      ctx.stroke();
      a.tagY = cy - 7;
    }
  }
  ctx.globalAlpha = 1;
}

/** Emote bubbles: they spring up above the name tag, sit for a moment and shrink away. */
export function drawBubbles(R) {
  const ctx = R.ctx, e = R.edpr, bubbles = R.bubbles;
  let ready = false;
  for (let i = 0; i < bubbles.length; i++) {
    const b = bubbles[i];
    if (!b.on || b.player < 0 || b.player >= R.actors.length) continue;
    const a = R.actors[b.player];
    if (!a.ok || !a.visible) continue;
    const s = bubbleScale(b.age, b.life);
    if (!(s > 0.01)) continue;
    if (b.dirty || b.epoch !== R.epoch || !b.canvas) {
      if (!b.canvas) b.canvas = makeCanvas(1, 1);
      paintBubble(b.canvas, b.emoji, R.edpr);
      b.dirty = false;
      b.epoch = R.epoch;
    }
    if (!ready) {
      ctx.setTransform(e, 0, 0, e, 0, 0);
      ctx.globalAlpha = 1;
      ready = true;
    }
    const w = BUBBLE_W * s, h = BUBBLE_H * s;
    ctx.drawImage(b.canvas, a.tagX - w / 2, a.tagY - 1 - h, w, h);
  }
}

// ---- minimap and off-screen arrows -------------------------------------------------------------

function minimapCache(R) {
  let mm = R.minimap;
  if (mm && mm.M === R.M && mm.epoch === R.epoch && mm.vw === R.vw && mm.vh === R.vh) return mm;
  if (!mm) {
    mm = R.minimap = { M: null, epoch: -1, vw: 0, vh: 0, c: null, lay: { s: 0, w: 0, h: 0, x: 0, y: 0, cx: 0, cy: 0, ok: false } };
  }
  mm.M = R.M;
  mm.epoch = R.epoch;
  mm.vw = R.vw;
  mm.vh = R.vh;
  mm.c = null;
  const pm = R.M.pm, lay = minimapLayout(pm, R.vw, R.vh, mm.lay);
  if (!lay.ok) return mm;

  const e = R.edpr;
  const c = makeCanvas(lay.w * e, lay.h * e);
  const g = c.getContext('2d');
  g.setTransform(e, 0, 0, e, 0, 0);
  g.beginPath();
  roundRectPath(g, lay.w / 2 - 0.5, lay.h / 2 - 0.5, 8, lay.w / 2, lay.h / 2);
  g.fillStyle = 'rgba(7,11,22,0.8)';
  g.fill();
  g.strokeStyle = 'rgba(255,255,255,0.16)';
  g.lineWidth = 1;
  g.stroke();

  const s = lay.s;
  g.translate(lay.w / 2, lay.h / 2);
  g.scale(s, s);
  g.beginPath();
  roundRectPath(g, pm.halfW, pm.halfH, pm.cornerR);
  g.fillStyle = '#17603a';
  g.fill();
  g.lineWidth = 1 / s;
  g.strokeStyle = 'rgba(255,255,255,0.6)';
  g.stroke();
  g.strokeStyle = 'rgba(255,255,255,0.32)';
  g.beginPath();
  g.moveTo(0, -pm.halfH);
  g.lineTo(0, pm.halfH);
  g.moveTo(pm.centerR, 0);
  g.arc(0, 0, pm.centerR, 0, TAU);
  for (let sg = -1; sg <= 1; sg += 2) {
    g.moveTo(sg * pm.halfW, -pm.boxHalfW);
    g.lineTo(sg * (pm.halfW - pm.boxDepth), -pm.boxHalfW);
    g.lineTo(sg * (pm.halfW - pm.boxDepth), pm.boxHalfW);
    g.lineTo(sg * pm.halfW, pm.boxHalfW);
  }
  g.stroke();
  // Each goal in the colours of the team that defends it.
  for (let t = 0; t < 2; t++) {
    g.fillStyle = R.M.teams[t].bright;
    g.fillRect(t === 0 ? -(pm.halfW + pm.goalDepth) : pm.halfW, -pm.goalHalf, pm.goalDepth, pm.goalWidth);
  }
  mm.c = c;
  return mm;
}

/**
 * The minimap, bottom right, whenever the whole pitch is not on screen.
 * @param lift  CSS px to raise it by (the letterbox of a replay takes the bottom of the screen)
 */
export function drawMinimap(R, lift) {
  const A = R.mapA;
  if (!(A > 0.02)) return;
  const mm = minimapCache(R);
  if (!mm.c) return;
  const lay = mm.lay, ctx = R.ctx, e = R.edpr, s = lay.s, M = R.M;
  const top = lay.y - lift, cx = lay.cx, cy = lay.cy - lift;

  ctx.setTransform(e, 0, 0, e, 0, 0);
  ctx.globalAlpha = A;
  ctx.drawImage(mm.c, lay.x, top, lay.w, lay.h);

  // What the camera sees.
  const hx = (R.vw / (2 * R.zoom)) * s, hy = (R.vh / (2 * R.zoom)) * s;
  const x0 = clamp(cx + R.camX * s - hx, lay.x + 2, lay.x + lay.w - 2);
  const x1 = clamp(cx + R.camX * s + hx, lay.x + 2, lay.x + lay.w - 2);
  const y0 = clamp(cy + R.camY * s - hy, top + 2, top + lay.h - 2);
  const y1 = clamp(cy + R.camY * s + hy, top + 2, top + lay.h - 2);
  ctx.strokeStyle = 'rgba(255,255,255,0.62)';
  ctx.lineWidth = 1;
  ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);

  const actors = R.actors;
  for (let i = 0; i < R.count; i++) {
    const a = actors[i];
    if (!a.ok) continue;
    const px = clamp(cx + a.x * s, lay.x + 3, lay.x + lay.w - 3), py = clamp(cy + a.y * s, top + 3, top + lay.h - 3);
    const kit = M.teams[a.team];
    ctx.fillStyle = a.keeper ? kit.keeper : kit.bright;
    ctx.beginPath();
    ctx.arc(px, py, a.mine ? 3.4 : 2.5, 0, TAU);
    ctx.fill();
    if (a.human) {
      ctx.strokeStyle = a.mine ? '#ffffff' : a.human.color;
      ctx.lineWidth = 1.3;
      ctx.beginPath();
      ctx.arc(px, py, a.mine ? 5.2 : 4.2, 0, TAU);
      ctx.stroke();
    }
  }
  const b = R.ball.v;
  if (b.ok) {
    const px = clamp(cx + b.x * s, lay.x + 3, lay.x + lay.w - 3), py = clamp(cy + b.y * s, top + 3, top + lay.h - 3);
    ctx.fillStyle = INK;
    ctx.beginPath();
    ctx.arc(px, py, 3.2, 0, TAU);
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(px, py, 2.3, 0, TAU);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}

const edge = { x: 0, y: 0, ang: 0 };

function badge(R, color, human) {
  const ctx = R.ctx;
  ctx.beginPath();
  arrowPath(ctx, edge.x, edge.y, edge.ang, 25, 14, 8);
  ctx.fillStyle = color;
  ctx.fill();
  ctx.strokeStyle = INK;
  ctx.lineWidth = 1.5;
  ctx.lineJoin = 'round';
  ctx.stroke();
  ctx.fillStyle = 'rgba(7,11,22,0.86)';
  ctx.beginPath();
  ctx.arc(edge.x, edge.y, 13, 0, TAU);
  ctx.fill();
  ctx.strokeStyle = color;
  ctx.lineWidth = 2.4;
  ctx.stroke();
  if (human) {
    const cache = labelCache(R);
    let l = cache.initials[human.humanId];
    if (!l) {
      const initial = (human.name || '').trim().slice(0, 1).toUpperCase() || String(human.humanId + 1);
      l = cache.initials[human.humanId] = buildLabel(initial, 12, human.light, R.edpr);
    }
    ctx.drawImage(l.c, edge.x - l.w / 2, edge.y - (12 * 0.72 + 2), l.w, l.h);
  } else {
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(edge.x, edge.y, 6, 0, TAU);
    ctx.fill();
    ctx.fillStyle = '#1a2236';
    ctx.beginPath();
    ctx.arc(edge.x, edge.y, 2.3, 0, TAU);
    ctx.fill();
  }
}

/** True when the screen point (x, y) lies outside the picture; then `edge` holds where its arrow goes. */
function offScreen(R, wx, wy, lift) {
  const W = R.W, e = R.edpr;
  const X = (W.a * wx + W.c * wy + W.e) / e, Y = (W.b * wx + W.d * wy + W.f) / e;
  if (!edgePoint(X, Y, R.vw, R.vh, ARROW_INSET, edge)) return false;
  // Keep clear of the minimap corner.
  const mm = R.minimap;
  if (R.mapA > 0.5 && mm && mm.c) {
    const left = mm.lay.x - 22, top = mm.lay.y - lift - 22;
    if (edge.x > left && edge.y > top) {
      if (edge.y > R.vh - ARROW_INSET - 2) edge.x = left;
      else edge.y = top;
    }
  }
  return true;
}

/**
 * Arrows at the edge of the screen pointing at the ball and at my human team-mate when the
 * camera does not show them.
 */
export function drawEdgeArrows(R, lift) {
  const A = R.arrowA;
  if (!(A > 0.02)) return;
  const ctx = R.ctx, e = R.edpr, b = R.ball.v;
  ctx.setTransform(e, 0, 0, e, 0, 0);
  ctx.globalAlpha = A;
  if (b.ok && offScreen(R, b.x, b.y, lift)) badge(R, '#ffffff', null);
  if (R.myTeam >= 0) {
    const actors = R.actors;
    for (let i = 0; i < R.count; i++) {
      const a = actors[i];
      if (!a.ok || !a.human || a.mine || a.team !== R.myTeam) continue;
      if (offScreen(R, a.gx, a.gy, lift)) badge(R, a.human.color, a.human);
    }
  }
  ctx.globalAlpha = 1;
}

// ---- full-screen treatments --------------------------------------------------------------------

/** Height (CSS px) of each letterbox bar right now. */
export function letterbox(R) {
  return Math.round(R.vh * 0.085) * ease.outCubic(R.replayA);
}

/**
 * Colour and light over the finished picture: the gold vignette of a golden goal, a dark one in
 * slow motion, and the replay look (drained colour, a cool cast, scan lines, a drifting band of
 * light).
 */
export function drawGrade(R) {
  const ctx = R.ctx, e = R.edpr, vw = R.vw, vh = R.vh, S = R.sprites;
  ctx.setTransform(e, 0, 0, e, 0, 0);
  ctx.globalCompositeOperation = 'source-over';

  if (R.goldA > 0.01) {
    ctx.globalAlpha = R.goldA * (0.3 + (R.reduced ? 0 : 0.2 * Math.sin(R.wall * 1.7)));
    ctx.drawImage(S.vignetteGold(), 0, 0, vw, vh);
  }
  const dark = Math.max(R.replayA * 0.8, R.slow * 0.5);
  if (dark > 0.01) {
    ctx.globalAlpha = dark;
    ctx.drawImage(S.vignetteDark(), 0, 0, vw, vh);
  }

  const A = R.replayA;
  if (A > 0.01) {
    // Not every browser has the blend mode; without it the colour simply stays.
    ctx.globalCompositeOperation = 'saturation';
    if (ctx.globalCompositeOperation === 'saturation') {
      ctx.globalAlpha = 0.4 * A;
      ctx.fillStyle = '#808080';
      ctx.fillRect(0, 0, vw, vh);
    }
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 0.1 * A;
    ctx.fillStyle = '#2a4a7c';
    ctx.fillRect(0, 0, vw, vh);

    if (!R.scanPattern) R.scanPattern = ctx.createPattern(S.scanTile(), 'repeat');
    if (R.scanPattern) {
      ctx.globalAlpha = 0.7 * A;
      ctx.fillStyle = R.scanPattern;
      ctx.fillRect(0, 0, vw, vh);
    }
    if (!R.reduced) {
      const bandH = Math.max(60, vh * 0.16);
      const y = (((R.wall * 0.3) % 1.4) - 0.2) * vh;
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = 0.55 * A;
      ctx.drawImage(S.band(), 0, y, vw, bandH);
      ctx.globalCompositeOperation = 'source-over';
    }
  }
  ctx.globalAlpha = 1;
}

/** Cinema bars for the replay. Drawn over everything but the flash. */
export function drawLetterbox(R) {
  const h = letterbox(R);
  if (h < 0.5) return;
  const ctx = R.ctx, e = R.edpr, vw = R.vw, vh = R.vh;
  ctx.setTransform(e, 0, 0, e, 0, 0);
  ctx.globalAlpha = 1;
  ctx.fillStyle = NIGHT;
  ctx.fillRect(0, 0, vw, h);
  ctx.fillRect(0, vh - h, vw, h);
  ctx.globalAlpha = 0.3;
  ctx.fillStyle = TOKENS.cyan;
  ctx.fillRect(0, h - 1, vw, 1);
  ctx.fillRect(0, vh - h, vw, 1);
  ctx.globalAlpha = 1;
}

/** The full-screen flash of a goal (white) or of golden goal beginning (gold). */
export function drawFlash(R) {
  if (!(R.flash > 0.004)) return;
  const ctx = R.ctx;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = R.flash > 1 ? 1 : R.flash;
  ctx.fillStyle = R.flashGold ? '#ffe9a8' : '#ffffff';
  ctx.fillRect(0, 0, R.canvas.width, R.canvas.height);
  ctx.globalAlpha = 1;
}
