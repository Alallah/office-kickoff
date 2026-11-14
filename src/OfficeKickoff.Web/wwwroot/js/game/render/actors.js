// Turns the frame's footballers into "actors": validated numbers, the pose each one is drawn in,
// the draw order, and everything a footballer's state gives off by itself (sprint dust, turf
// spray and the scuff of a slide, after-images, sweat, embers of a full charge).
// Pure: no canvas. footballers.js only draws what this prepares.

import { ACTION, PLAYER_FLAG } from '../../shared/protocol.js';
import { approach, clamp, clamp01, num, poseMatrix, TAU } from './mathx.js';
import { ellipseRadius } from './geom.js';
import { celebrationPose, joyPose, statePose } from './poses.js';
import { ctrlOf, myHumanId, myIndex, myTeam, playerAt } from './viewx.js';
import { FX_BEAM, ghostAdd, scuffBegin, scuffExtend } from './fxpool.js';
import { dust, embers, sweat, turf } from './emitters.js';

const rnd = Math.random;

/** Seconds a slide's scuff mark stays on the turf. */
export const SCUFF_LIFE = 4.5;

/** An AI footballer shows its surname while the ball is this close (and a little beyond, once shown). */
const NAME_NEAR = 150;
const NAME_KEEP = 200;

function sortKey(a) {
  return a.mine ? 1e9 : a.gy;
}

function knownAction(v) {
  return v === ACTION.SLIDE || v === ACTION.DASH || v === ACTION.DIVE || v === ACTION.STUNNED || v === ACTION.RECOVER
    ? v
    : ACTION.NONE;
}

function giveOff(R, a, info) {
  const M = R.M, dt = R.dt, r = M.playerR, q = a.pose;

  if (a.action === ACTION.SLIDE) {
    if (!scuffExtend(R.scuffs, a.scuff, a.scuffGen, a.x, a.y)) {
      a.scuff = scuffBegin(R.scuffs, a.x, a.y, r * 0.95, SCUFF_LIFE);
      a.scuffGen = R.scuffs.gen[a.scuff];
    }
    if (dt > 0 && a.visible) {
      const back = a.actionDir + Math.PI;
      const fx = a.x + Math.cos(a.actionDir) * r * 0.7, fy = a.y + Math.sin(a.actionDir) * r * 0.7;
      a.sprayAcc += dt * 46;
      let guard = 6;
      while (a.sprayAcc >= 1 && guard-- > 0) {
        a.sprayAcc -= 1;
        turf(R, fx, fy, back + (rnd() < 0.5 ? 0.9 : -0.9), 0.9, 170, 1);
      }
      if (a.sprayAcc >= 1) a.sprayAcc = 0;
      a.dustT -= dt;
      if (a.dustT <= 0) {
        a.dustT = 0.05;
        dust(R, a.x, a.y, back, 1.2, 60, 1, 5);
      }
    }
    return;
  }
  a.scuff = -1;

  if (a.action === ACTION.DASH || a.action === ACTION.DIVE) {
    if (dt > 0) {
      a.ghostT -= dt;
      if (a.ghostT <= 0) {
        a.ghostT = 0.02;
        ghostAdd(R.ghosts, a.x, a.y, q.dir, q.sa, q.sb, r, info ? info.cGhost : M.col.white, a.action === ACTION.DASH ? 0.24 : 0.2);
      }
    }
  } else {
    a.ghostT = 0;
    if ((a.flags & PLAYER_FLAG.SPRINTING) && a.action === ACTION.NONE && a.speed > M.sprintSpeed * 0.5 && dt > 0) {
      a.dustT -= dt;
      if (a.dustT <= 0 && a.visible) {
        a.dustT = 0.075 + 0.03 * rnd();
        const back = Math.atan2(-a.vy, -a.vx);
        dust(R, a.x + Math.cos(back) * r * 0.7, a.y + Math.sin(back) * r * 0.7, back, 0.9, 55, 1, 4.2);
      }
    }
  }

  if (!(dt > 0) || !a.visible) return;
  if (a.flags & PLAYER_FLAG.EXHAUSTED) {
    a.sweatT -= dt;
    if (a.sweatT <= 0) {
      a.sweatT = 0.14 + 0.2 * rnd();
      sweat(R, a.bx + (rnd() - 0.5) * r, a.by - r * 0.4);
    }
  }
  if ((a.flags & PLAYER_FLAG.CHARGING) && a.charge >= M.fire) {
    a.sparkT -= dt;
    if (a.sparkT <= 0) {
      a.sparkT = 0.045;
      const ang = rnd() * TAU;
      embers(R, a.x + Math.cos(ang) * r, a.y + Math.sin(ang) * r, Math.cos(ang) * 40, Math.sin(ang) * 40, 1);
    }
  }
}

/**
 * Fills R.actors, R.order and the local player's indices from the view.
 * Needs R.ball.v (this frame's ball), R.vis, R.t / R.dt and R.celeb to be up to date.
 */
export function prepareActors(R, view) {
  const M = R.M;
  const list = view && Array.isArray(view.players) ? view.players : null;
  const n = list ? Math.min(list.length, R.actors.length) : 0;
  const ball = R.ball.v, vis = R.vis, C = R.celeb;
  R.mine = myIndex(view);
  if (R.mine >= n) R.mine = -1;
  R.myHuman = myHumanId(view);
  R.myTeam = myTeam(view);

  let shown = 0;
  for (let i = 0; i < R.actors.length; i++) {
    const a = R.actors[i];
    const p = i < n ? playerAt(view, i) : null;
    if (!p) {
      a.ok = false;
      a.seen = false;
      a.scuff = -1;
      continue;
    }
    const info = i < M.players.length ? M.players[i] : null;
    a.ok = true;
    if (info) {
      a.team = info.team;
      a.keeper = info.keeper;
      a.fill = info.fill;
      a.trim = info.trim;
      a.ink = info.ink;
      a.marker = info.marker;
      a.number = info.number;
      a.surname = info.surname;
    } else {
      // A footballer the match description does not know: dress it from what the view says.
      a.team = p.team === 1 ? 1 : 0;
      a.keeper = p.keeper === true;
      const kit = M.teams[a.team];
      a.fill = a.keeper ? kit.keeper : kit.primary;
      a.trim = kit.secondary;
      a.ink = a.keeper ? kit.keeperText : kit.text;
      a.marker = kit.trimBright;
      a.number = clamp(Math.round(num(p.number, i + 1)), 0, 99);
      a.surname = '';
    }
    a.x = p.x;
    a.y = p.y;
    a.vx = num(p.vx, 0);
    a.vy = num(p.vy, 0);
    a.speed = Math.sqrt(a.vx * a.vx + a.vy * a.vy);
    a.aim = num(p.aim, 0);
    a.action = knownAction(p.action);
    a.actionT = Math.max(0, num(p.actionT, 0));
    a.actionDir = num(p.actionDir, a.aim);
    a.stamina = clamp01(num(p.stamina, 1));
    a.charge = clamp01(num(p.charge, 0));
    a.cd = Math.max(0, num(p.cd, 0));
    a.flags = num(p.flags, 0) | 0;
    a.ctrl = ctrlOf(p);
    a.mine = i === R.mine;
    a.human = a.ctrl >= 0 ? M.humans[a.ctrl] : null;
    if (a.mine && !a.human && R.myHuman >= 0) a.human = M.humans[R.myHuman];
    a.hasBall = ball.ok && ball.owner === i;

    const q = a.pose;
    statePose(q, a, R.t, M.poseK);
    a.celeb = -1;
    if (C.on && C.i === i) {
      a.celeb = C.kind;
      celebrationPose(q, C.kind, R.t - C.t0);
    } else if (C.joy && a.team === C.team && a.action === ACTION.NONE) {
      joyPose(q, R.t, i);
    }
    poseMatrix(q.dir, q.sa, q.sb, q.spin, q.kx, q.ky, a.m);
    poseMatrix(q.dir, q.sa, q.sb, 0, Math.abs(q.kx), Math.abs(q.ky), a.ms);
    a.gx = a.x + q.ox;
    a.gy = a.y + q.oy;
    a.bx = a.gx;
    a.by = a.gy - q.lift;
    a.face = a.aim + q.spin;
    const k = (Math.abs(q.kx) + Math.abs(q.ky)) * 0.5;
    a.edge = ellipseRadius(M.playerR * q.sa * k, M.playerR * q.sb * k, q.dir, a.face);
    a.visible = a.x > vis.x0 - 90 && a.x < vis.x1 + 90 && a.y > vis.y0 - 90 && a.y < vis.y1 + 130;

    // Nothing is given off on the first frame after a cut: there is no "before" to compare with.
    if (!a.seen) {
      a.seen = true;
      a.prevAction = a.action;
    }
    giveOff(R, a, info);
    a.prevAction = a.action;

    let want = 0;
    if (!a.human && ball.ok) {
      const dx = ball.x - a.x, dy = ball.y - a.y;
      const lim = a.nameA > 0.5 ? NAME_KEEP : NAME_NEAR;
      want = dx * dx + dy * dy < lim * lim ? 1 : 0;
    }
    a.nameA = approach(a.nameA, want, 10, R.rdt);
    a.switchAge += R.rdt;

    R.order[shown++] = i;
  }

  // Lower on the screen is nearer the viewer; the local player's footballer is never covered.
  const order = R.order, actors = R.actors;
  for (let k = 1; k < shown; k++) {
    const idx = order[k];
    const key = sortKey(actors[idx]);
    let j = k - 1;
    while (j >= 0 && sortKey(actors[order[j]]) > key) {
      order[j + 1] = order[j];
      j--;
    }
    order[j + 1] = idx;
  }
  R.orderN = shown;
  R.count = n;

  // The cooldown pip pops the moment the tackle / dash is ready again.
  const me = R.mine >= 0 ? actors[R.mine] : null;
  if (me && me.ok) {
    const ready = me.cd <= 0;
    if (ready && !R.pipReady) R.pipPop = 0.3;
    R.pipReady = ready;
    const busy = me.stamina < 0.995 || (me.flags & PLAYER_FLAG.SPRINTING) !== 0;
    R.stamA = approach(R.stamA, busy ? 1 : 0.4, busy ? 14 : 2.5, R.rdt);
  }
  R.pipPop = Math.max(0, R.pipPop - R.rdt);
}

/** Shapes tied to a footballer (a lock-on ring, the far end of a swoosh) move with it. */
export function followFx(R) {
  const F = R.F, actors = R.actors;
  for (let i = 0; i < F.n; i++) {
    const f = F.follow[i];
    if (f < 0 || f >= actors.length) continue;
    const a = actors[f];
    if (!a.ok) continue;
    if (F.kind[i] === FX_BEAM) {
      F.x2[i] = a.gx;
      F.y2[i] = a.gy;
    } else {
      F.x[i] = a.gx;
      F.y[i] = a.gy;
    }
  }
}
