// Game events -> effects. One function per event type decides what it looks like: which shapes,
// how many particles, how hard the camera is shaken. Intensity follows evt.v wherever the event
// carries power or speed. Pure: only the runtime is touched, never a canvas.
//
// See GameEvent.cs for what a, b, v and f mean per event type.

import { EVT, PHASE, goalInfo } from '../../shared/protocol.js';
import { clamp, clamp01, isNum, num, TAU } from './mathx.js';
import { nearestLoopIndex, nearestPost, postX, postY, sideSign } from './geom.js';
import { addTrauma, kickShake, moodGoal, netBillow, netImpulse, netSideImpulse, punchZoom, winnerOf } from './fxmodel.js';
import { FX_BEAM, FX_GLOW, FX_RING, FX_STAR, FXF_ADD, FXF_TOP, rippleAdd, spawnFx } from './fxpool.js';
import { myHumanId, playerAt } from './viewx.js';
import { beginCelebration } from './celebrations.js';
import { dust, embers, flames, glowBurst, goalBurst, sparks, starPop, turf } from './emitters.js';

const rnd = Math.random;

/** Seconds over which the confetti rains after a goal. */
export const RAIN_TIME = 1.7;

// ---- building blocks ---------------------------------------------------------------------------

function shake(R, trauma, dx, dy, px, punch) {
  if (R.reduced) return;
  addTrauma(R.shake, trauma);
  if (px > 0) kickShake(R.shake, dx, dy, px);
  if (punch > 0) punchZoom(R.shake, punch);
}

function flash(R, alpha, gold) {
  if (R.reduced || !(alpha > R.flash)) return;
  R.flash = alpha;
  R.flashGold = gold;
}

/** Impact freeze: the effect clock stands still for a moment, so the hit hangs in the air. */
function freeze(R, seconds) {
  if (!R.reduced && seconds > R.hitStop) R.hitStop = seconds;
}

function ring(R, x, y, r0, r1, life, w, col, flags, alpha) {
  const F = R.F;
  const i = spawnFx(F, FX_RING, x, y, r0, r1, life, w, col, flags);
  F.alpha[i] = alpha;
  return i;
}

function glow(R, x, y, r0, r1, life, col, alpha) {
  const F = R.F;
  // Reduced motion: local glints stay, big flashes go.
  if (R.reduced && r1 > 44) return -1;
  const i = spawnFx(F, FX_GLOW, x, y, r0, r1, life, 0, col, FXF_ADD | FXF_TOP);
  F.alpha[i] = alpha;
  return i;
}

function star(R, x, y, r0, r1, life, spikes, col) {
  const F = R.F;
  const i = spawnFx(F, FX_STAR, x, y, r0, r1, life, 0, col, FXF_ADD | FXF_TOP);
  F.spikes[i] = spikes;
  F.rot[i] = rnd() * TAU;
  return i;
}

function beam(R, x0, y0, x1, y1, life, w, col, alpha) {
  const F = R.F;
  const i = spawnFx(F, FX_BEAM, x0, y0, 0, 0, life, w, col, FXF_ADD | FXF_TOP);
  F.x2[i] = x1;
  F.y2[i] = y1;
  F.alpha[i] = alpha;
  return i;
}

/** Direction a footballer strikes the ball in: where it faces, else where the ball is going. */
function strikeAngle(p, view) {
  if (p && isNum(p.aim)) return p.aim;
  const b = view && view.ball;
  if (b && isNum(b.vx) && isNum(b.vy) && (b.vx !== 0 || b.vy !== 0)) return Math.atan2(b.vy, b.vx);
  return 0;
}

/** Direction of a footballer's slide, dash or dive. */
function actionAngle(p) {
  if (!p) return 0;
  if (isNum(p.actionDir)) return p.actionDir;
  if (isNum(p.vx) && isNum(p.vy) && (p.vx !== 0 || p.vy !== 0)) return Math.atan2(p.vy, p.vx);
  return isNum(p.aim) ? p.aim : 0;
}

function accentOf(R, p) {
  const M = R.M;
  const c = p ? p.ctrl : -1;
  const human = isNum(c) && c >= 0 && c < M.humans.length && (c | 0) === c ? M.humans[c] : null;
  if (human) return human.cColor;
  return p && (p.team === 0 || p.team === 1) ? M.teams[p.team].cPrimary : M.col.white;
}

// ---- events ------------------------------------------------------------------------------------

function kick(R, x, y, v, firstTime, p, view) {
  const C = R.M.col, pw = clamp01(v);
  const ang = strikeAngle(p, view);
  const dx = Math.cos(ang), dy = Math.sin(ang);
  const hot = pw >= R.M.fire;

  ring(R, x, y, 6, 26 + 34 * pw, 0.22 + 0.1 * pw, 3 + 2 * pw, C.white, 0, 0.85);
  glow(R, x, y, 10, 22 + 22 * pw, 0.12, hot ? C.ember : C.white, 0.9);
  turf(R, x, y, ang, 1.3, 190 + 240 * pw, 3 + 9 * pw);
  sparks(R, x, y, ang, 0.9, 380 + 500 * pw, 2 + 6 * pw, C.spark);

  if (pw >= 0.55) {
    // A big shot: shockwave, and the camera is knocked along with the ball.
    ring(R, x, y, 10, 70 + 90 * pw, 0.4, 5 + 3 * pw, hot ? C.ember : C.white, FXF_ADD, 0.7);
    shake(R, 0.1 + 0.3 * pw, dx, dy, 4 + 9 * pw, 0.008 + 0.02 * pw);
  }
  if (hot) {
    ring(R, x, y, 14, 120, 0.5, 4, C.hot, FXF_ADD, 0.6);
    flames(R, x, y, dx * 220, dy * 220, 14, 11);
    embers(R, x, y, dx * 160, dy * 160, 10);
    freeze(R, 0.035);
  }
  if (firstTime) {
    ring(R, x, y, 4, 30, 0.2, 2, C.cyan, FXF_ADD, 0.9);
    sparks(R, x, y, ang, TAU, 300, 6, C.cyan);
  }
}

function pass(R, x, y, v, firstTime, p, view) {
  const C = R.M.col, pw = clamp01(v);
  const ang = strikeAngle(p, view);
  ring(R, x, y, 4, 15 + 9 * pw, 0.16, 2.2, C.white, 0, 0.7);
  turf(R, x, y, ang, 1.1, 150 + 90 * pw, 1 + 2 * pw);
  sparks(R, x, y, ang, 0.35, 320 + 240 * pw, 2, C.white);
  if (firstTime) ring(R, x, y, 4, 24, 0.18, 1.8, C.cyan, FXF_ADD, 0.85);
}

function trap(R, x, y, v) {
  const C = R.M.col, pw = clamp01(v);
  dust(R, x, y, rnd() * TAU, TAU, 40 + 50 * pw, 1 + 3 * pw, 4);
  ring(R, x, y, 5, 13 + 5 * pw, 0.15, 1.6, C.white, 0, 0.45);
}

function steal(R, x, y, pa, pb) {
  const C = R.M.col;
  let mx = x, my = y;
  if (pa && pb) {
    mx = (pa.x + pb.x) / 2;
    my = (pa.y + pb.y) / 2;
    beam(R, pb.x, pb.y, pa.x, pa.y, 0.12, 3, C.gold, 0.9);
  }
  sparks(R, mx, my, 0, TAU, 320, 8, C.spark);
  star(R, mx, my, 5, 17, 0.14, 4, C.white);
  shake(R, 0.06, 0, 0, 0, 0);
}

function slideStart(R, x, y, p) {
  const ang = actionAngle(p);
  dust(R, x, y, ang + Math.PI, 1.4, 150, 7, 6.5);
  turf(R, x, y, ang + Math.PI, 1.2, 180, 5);
  ring(R, x, y, 6, 26, 0.18, 2, R.M.col.dust, 0, 0.5);
}

function tackleHit(R, x, y, pa, pb, wonBall) {
  const C = R.M.col;
  const ang = actionAngle(pa);
  const dx = Math.cos(ang), dy = Math.sin(ang);
  const big = !!pb;

  star(R, x, y, 14, big ? 50 : 34, 0.2, 8, C.white);
  if (big) star(R, x, y, 8, 30, 0.26, 5, C.gold);
  ring(R, x, y, 10, big ? 68 : 44, 0.28, 5, C.white, FXF_ADD, 0.8);
  glow(R, x, y, 16, big ? 58 : 40, 0.12, C.white, 1);
  turf(R, x, y, ang, 2.6, 330, big ? 16 : 9);
  dust(R, x, y, ang, 2.2, 130, 5, 7);
  sparks(R, x, y, ang, 2.4, 420, big ? 10 : 5, C.spark);
  if (big) starPop(R, pb.x, pb.y - R.M.playerR, 3, C.gold, 120);
  if (wonBall) ring(R, x, y, 6, 30, 0.22, 2, C.lime, FXF_ADD, 0.8);

  shake(R, big ? 0.5 : 0.28, dx, dy, big ? 10 : 6, big ? 0.04 : 0.02);
  freeze(R, big ? 0.07 : 0.035);
  if (big) flash(R, 0.14, false);
}

function slideMiss(R, x, y) {
  dust(R, x, y, rnd() * TAU, TAU, 70, 5, 6);
  starPop(R, x, y - R.M.playerR, 2, R.M.col.gold, 90);
}

function dash(R, x, y, p) {
  const ang = actionAngle(p);
  const col = accentOf(R, p);
  const dx = Math.cos(ang), dy = Math.sin(ang);
  sparks(R, x, y, ang + Math.PI, 0.7, 340, 6, col);
  ring(R, x, y, 8, 32, 0.2, 3, col, FXF_ADD, 0.7);
  beam(R, x - dx * 52, y - dy * 52, x + dx * 14, y + dy * 14, 0.16, 5, col, 0.75);
  dust(R, x, y, ang + Math.PI, 1, 110, 3, 5);
}

function deflect(R, x, y, v) {
  const C = R.M.col, pw = clamp01(v);
  sparks(R, x, y, 0, TAU, 260 + 240 * pw, 3 + 8 * pw, C.spark);
  ring(R, x, y, 5, 14 + 22 * pw, 0.16, 2.4, C.white, 0, 0.7);
  if (pw > 0.6) shake(R, 0.08 * pw, 0, 0, 0, 0);
}

function wallBounce(R, x, y, v) {
  const M = R.M, C = M.col, pw = clamp01(v), loop = M.wall;
  const idx = nearestLoopIndex(loop, x, y);
  rippleAdd(R.ripples, idx, clamp01(0.25 + pw), 0.45 + 0.3 * pw);
  glow(R, x, y, 8, 20 + 22 * pw, 0.14, C.white, 0.9);
  if (pw > 0.3) {
    // Back into the pitch, along the inward normal of the board that was hit.
    const inward = Math.atan2(-loop.ny[idx], -loop.nx[idx]);
    sparks(R, x, y, inward, 1.7, 200 + 300 * pw, 2 + 8 * pw, C.spark);
    dust(R, x, y, inward, 1.6, 70, 2, 4.5);
  }
  if (pw > 0.75) shake(R, 0.05 + 0.1 * pw, 0, 0, 0, 0);
}

function postHit(R, x, y, v) {
  const M = R.M, C = M.col, pw = clamp01(v);
  const k = nearestPost(M.pm, x, y);
  const px = postX(M.pm, k), py = postY(M.pm, k);
  R.postShake[k] = Math.max(R.postShake[k], 0.35 + 0.3 * pw);

  glow(R, px, py, 14, 44 + 40 * pw, 0.16, C.white, 1);
  star(R, px, py, 10, 38 + 14 * pw, 0.18, 6, C.white);
  ring(R, px, py, 8, 50 + 40 * pw, 0.3, 4, C.white, FXF_ADD, 0.9);
  sparks(R, px, py, 0, TAU, 420 + 500 * pw, 12 + 22 * pw, C.spark);
  // The frame rings: the camera recoils away from the goal.
  shake(R, 0.3 + 0.35 * pw, px < 0 ? 1 : -1, 0, 6 + 6 * pw, 0.015 + 0.015 * pw);
  freeze(R, 0.04);
}

function netHit(R, x, y, v) {
  const M = R.M, pm = M.pm, pw = clamp01(v);
  const side = x < 0 ? 0 : 1;
  const N = R.nets[side];
  const depth = clamp01((Math.abs(x) - pm.halfW) / pm.goalDepth);
  const across = clamp01((y + pm.goalHalf) / pm.goalWidth);
  const strength = 260 + 900 * pw;
  if (depth < 0.7 && across < 0.14) netSideImpulse(N, true, depth, strength, 0.3);
  else if (depth < 0.7 && across > 0.86) netSideImpulse(N, false, depth, strength, 0.3);
  else netImpulse(N, across, strength, 0.14);
  glowBurst(R, x, y, 3 + 6 * pw, 120, M.col.white, 3, 0.3);
}

function keeperCatch(R, x, y, v, p) {
  const M = R.M, C = M.col, pw = clamp01(v);
  const light = p && (p.team === 0 || p.team === 1) ? M.teams[p.team].cLight : C.white;
  glow(R, x, y, 12, 30 + 14 * pw, 0.14, C.white, 1);
  // The ball is swallowed: one ring closes on the gloves, one rolls out sized by the shot.
  ring(R, x, y, 34 + 40 * pw, 9, 0.2, 3.5, C.white, 0, 0.9);
  ring(R, x, y, 10, 40 + 70 * pw, 0.3, 4, light, FXF_ADD, 0.75);
  dust(R, x, y, rnd() * TAU, TAU, 80, 2 + 4 * pw, 5);
  shake(R, 0.06 + 0.16 * pw, 0, 0, 0, 0);
}

function keeperParry(R, x, y, v, p, view) {
  const C = R.M.col, pw = clamp01(v);
  const b = view && view.ball;
  const away = b && isNum(b.vx) && isNum(b.vy) && (b.vx !== 0 || b.vy !== 0) ? Math.atan2(b.vy, b.vx) : rnd() * TAU;
  glow(R, x, y, 14, 34 + 10 * pw, 0.14, C.white, 1);
  ring(R, x, y, 10, 54 + 80 * pw, 0.3, 5, C.white, FXF_ADD, 0.9);
  star(R, x, y, 8, 26 + 14 * pw, 0.16, 6, C.white);
  sparks(R, x, y, away, 2.2, 380 + 420 * pw, 8 + 14 * pw, C.spark);
  shake(R, 0.14 + 0.3 * pw, Math.cos(away), Math.sin(away), 4 + 7 * pw, 0.01 + 0.02 * pw);
  if (pw > 0.5) freeze(R, 0.03 + 0.03 * pw);
}

function block(R, x, y, v) {
  const C = R.M.col, pw = clamp01(v);
  glow(R, x, y, 10, 26 + 14 * pw, 0.12, C.white, 0.9);
  ring(R, x, y, 8, 40 + 50 * pw, 0.26, 4, C.white, FXF_ADD, 0.8);
  turf(R, x, y, 0, TAU, 200, 4);
  sparks(R, x, y, 0, TAU, 300 + 300 * pw, 4 + 8 * pw, C.spark);
  shake(R, 0.08 + 0.2 * pw, 0, 0, 0, 0);
}

function dive(R, x, y, p) {
  const ang = actionAngle(p);
  const dx = Math.cos(ang), dy = Math.sin(ang);
  dust(R, x, y, ang + Math.PI, 1.2, 120, 5, 6);
  beam(R, x - dx * 44, y - dy * 44, x + dx * 10, y + dy * 10, 0.18, 6, R.M.col.white, 0.5);
}

function goal(R, evt, x, y, v) {
  const M = R.M, pm = M.pm, C = M.col;
  const info = goalInfo(evt);
  const team = info.team === 1 ? 1 : 0;
  // The goal a team scores in is the one it attacks; where it happened wins when it is known.
  let side = team === 0 ? 1 : 0;
  if (isNum(evt.x) && Math.abs(evt.x) > pm.halfW * 0.5) side = evt.x > 0 ? 1 : 0;
  const sign = sideSign(side);
  const gx = sign * (pm.halfW + 4);
  const gy = clamp(y, -pm.goalHalf + 8, pm.goalHalf - 8);
  const muted = info.ownGoal;
  const pw = clamp01(v);
  const T = M.teams[team];

  const N = R.nets[side];
  netBillow(N, muted ? 240 : 400 + 260 * pw);
  netImpulse(N, (gy + pm.goalHalf) / pm.goalWidth, 480 + 700 * pw, 0.16);

  moodGoal(R.mood, team, muted);
  shake(R, muted ? 0.45 : 1, sign, 0, muted ? 6 : 14, muted ? 0.02 : 0.055);
  flash(R, muted ? 0.25 : 0.8, false);
  freeze(R, muted ? 0.03 : 0.08);

  goalBurst(R, gx, gy, -sign, pm.goalHalf, team, pw, muted);
  const F = R.F;
  for (let k = 0; k < (muted ? 1 : 3); k++) {
    const col = muted ? C.grey[0] : k === 0 ? T.cPrimary : k === 1 ? C.white : T.cLight;
    const i = ring(R, gx, gy, 20, 170 + 70 * k, 0.55, 7 - k, col, FXF_ADD, muted ? 0.5 : 0.85);
    F.delay[i] = 0.08 * k;
  }
  glow(R, gx, gy, 30, muted ? 90 : 190, 0.3, muted ? C.white : T.cLight, muted ? 0.5 : 0.95);

  R.rain = muted ? 0 : RAIN_TIME;
  R.rainTeam = team;
  R.rainGold = info.decides;
  R.rainAcc = 0;
  if (evt.replay === true) R.replayGoal = true;

  beginCelebration(R, evt, info);
}

function kickedOff(R) {
  const M = R.M;
  ring(R, 0, 0, M.pm.centerR * 0.2, M.pm.centerR * 1.08, 0.5, 6, M.col.white, FXF_ADD, 0.5);
}

function fullTime(R, view) {
  const winner = winnerOf(view && view.score);
  if (winner >= 0) moodGoal(R.mood, winner, false);
  else R.mood.roar = Math.max(R.mood.roar, 0.45);
  flash(R, 0.25, false);
  R.fullTimeAcc = 0;
}

function overtime(R) {
  const M = R.M, F = R.F;
  flash(R, 0.38, true);
  R.mood.roar = Math.max(R.mood.roar, 0.6);
  for (let k = 0; k < 2; k++) {
    const i = ring(R, 0, 0, M.pm.centerR * 0.3, M.pm.centerR * (1.6 + k), 0.9, 8 - 3 * k, M.col.gold, FXF_ADD, 0.8);
    F.delay[i] = 0.14 * k;
  }
}

function switched(R, evt, x, y, pa, pb, view) {
  const M = R.M, F = R.F;
  const h = evt.f;
  const human = isNum(h) && h >= 0 && h < M.humans.length && (h | 0) === h ? M.humans[h] : null;
  if (!human) return;
  const mine = h === myHumanId(view);
  const tx = pa ? pa.x : x, ty = pa ? pa.y : y;
  const r = M.playerR;
  const target = pa ? evt.a : -1;

  if (!mine) {
    // Somebody else changed footballer: a blink is enough.
    const i = ring(R, tx, ty, r + 20, r + 7, 0.2, 2.5, human.cColor, FXF_ADD, 0.5);
    F.follow[i] = target;
    return;
  }

  // Mine: a swoosh from the old footballer to the new one, which then locks on.
  if (pb && (pb.x !== tx || pb.y !== ty)) {
    const i = beam(R, pb.x, pb.y, tx, ty, 0.17, 7, human.cLight, 1);
    F.follow[i] = target;
    const o = ring(R, pb.x, pb.y, r + 6, r + 26, 0.22, 2.5, human.cColor, FXF_ADD, 0.6);
    F.follow[o] = evt.b;
  }
  const lock = ring(R, tx, ty, r + 34, r + 7, 0.24, 4.5, human.cLight, FXF_ADD, 1);
  F.follow[lock] = target;
  F.delay[lock] = pb ? 0.1 : 0;
  const out = ring(R, tx, ty, r + 7, r + 44, 0.34, 3, human.cColor, FXF_ADD, 0.7);
  F.follow[out] = target;
  F.delay[out] = pb ? 0.2 : 0.1;
  if (target >= 0 && target < R.actors.length) R.actors[target].switchAge = 0;
}

/**
 * @param evt   GameEvt (shared/protocol.js); replayed and predicted events are handled alike
 * @param view  the FrameView the event was delivered with
 */
export function handleEvent(R, evt, view) {
  const M = R.M;
  if (!M || !evt || typeof evt !== 'object') return;
  const pa = playerAt(view, evt.a), pb = playerAt(view, evt.b);

  let x = evt.x, y = evt.y;
  let located = isNum(x) && isNum(y);
  if (!located && pa) {
    x = pa.x;
    y = pa.y;
    located = true;
  }
  if (located) {
    // Nothing happens outside the stadium: a wild position must not send effects into the void.
    const lx = M.pm.halfW + M.pm.goalDepth + 60, ly = M.pm.halfH + 60;
    x = clamp(x, -lx, lx);
    y = clamp(y, -ly, ly);
  } else {
    x = 0;
    y = 0;
  }
  const v = clamp(num(evt.v, 0), 0, 1.5);

  switch (evt.type) {
    case EVT.KICK: if (located) kick(R, x, y, v, evt.f === 1, pa, view); break;
    case EVT.PASS: if (located) pass(R, x, y, v, evt.f === 1, pa, view); break;
    case EVT.TRAP: if (located) trap(R, x, y, v); break;
    case EVT.STEAL: if (located) steal(R, x, y, pa, pb); break;
    case EVT.SLIDE_START: if (located) slideStart(R, x, y, pa); break;
    case EVT.TACKLE_HIT: if (located) tackleHit(R, x, y, pa, pb, evt.f === 1); break;
    case EVT.SLIDE_MISS: if (located) slideMiss(R, x, y); break;
    case EVT.DASH: if (located) dash(R, x, y, pa); break;
    case EVT.DEFLECT: if (located) deflect(R, x, y, v); break;
    case EVT.WALL_BOUNCE: if (located) wallBounce(R, x, y, v); break;
    case EVT.POST_HIT: if (located) postHit(R, x, y, v); break;
    case EVT.KEEPER_CATCH: if (located) keeperCatch(R, x, y, v, pa); break;
    case EVT.KEEPER_PARRY: if (located) keeperParry(R, x, y, v, pa, view); break;
    case EVT.BLOCK: if (located) block(R, x, y, v); break;
    case EVT.DIVE: if (located) dive(R, x, y, pa); break;
    case EVT.NET_HIT: if (located) netHit(R, x, y, v); break;
    case EVT.GOAL: goal(R, evt, x, y, v); break;
    case EVT.PHASE_CHANGE:
      if (evt.f === PHASE.PLAYING && num(evt.v, -1) === PHASE.KICKOFF) kickedOff(R);
      else if (evt.f === PHASE.FULL_TIME) fullTime(R, view);
      break;
    case EVT.OVERTIME: overtime(R); break;
    case EVT.SWITCH: switched(R, evt, x, y, pa, pb, view); break;
    default: break;
  }
}
