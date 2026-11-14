// One frame of the renderer's own simulation: the clocks, the camera transform, the actors and
// the ball, the timed emitters, the crowd and every pool. Everything the draw calls need is
// worked out here and nothing here touches a canvas, so a whole match can be stepped headless.

import { PHASE } from '../../shared/protocol.js';
import { approach, clamp, clamp01, isNum, num } from './mathx.js';
import { pitchInside, visibleRect, worldMatrix } from './geom.js';
import { clearShake, stepNet, stepShake, winnerOf } from './fxmodel.js';
import { stepParticles } from './particles.js';
import { stepFx, stepGhosts, stepRipples, stepScuffs } from './fxpool.js';
import { readBall } from './viewx.js';
import { followFx, prepareActors } from './actors.js';
import { stepBall } from './ballfx.js';
import { stepCelebration } from './celebrations.js';
import { stepCrowd } from './crowdfx.js';
import { confettiRain } from './emitters.js';
import { RAIN_TIME } from './events.js';

/** Screen pixels the visible rectangle is grown by: room for the shake, its roll and the zoom punch. */
const VIS_MARGIN_PX = 70;

/** Speed of the effect clock once a replayed goal has gone in. */
const REPLAY_SLOW = 0.35;

const camRect = { x0: 0, x1: 0, y0: 0, y1: 0 };

/** Confetti over the part of the pitch that is on screen (it is drawn above where it will land). */
function rainOn(R, n, cols) {
  const pm = R.M.pm, vis = R.vis;
  confettiRain(R,
    Math.max(vis.x0, -pm.halfW - 30), Math.min(vis.x1, pm.halfW + 30),
    Math.max(vis.y0, -pm.halfH - 20), Math.min(vis.y1 + 120, pm.halfH + 20),
    n, cols);
}

/**
 * Advances the runtime to the frame described by `view`. R.M must be set.
 * @param view  FrameView (game/types.js); every field is read defensively
 */
export function stepFrame(R, view) {
  const M = R.M;

  // ---- wall clock ----------------------------------------------------------------------------
  const now = num(view.now, R.wall + 1 / 60);
  const rdt = clamp(num(view.dt, now - R.wall), 0, 0.1);
  R.wall = now;
  R.rdt = rdt;
  R.frame++;

  R.phase = num(view.phase, PHASE.INTRO) | 0;
  R.inReplay = view.replay !== null && view.replay !== undefined;
  R.overtime = view.overtime === true;
  R.live = R.phase === PHASE.PLAYING || R.inReplay;

  // ---- effect clock --------------------------------------------------------------------------
  // Slow motion slows every effect with it. A replay runs at its own changing speed: effects
  // keep pace with the footage, and once the goal has gone in they are slow like the first time.
  let want = 1;
  if (R.inReplay) {
    let rate = 1;
    if (isNum(view.time) && isNum(R.lastViewTime) && rdt > 0.001) rate = (view.time - R.lastViewTime) / rdt;
    want = R.replayGoal ? REPLAY_SLOW : clamp(rate, 0.3, 1);
  } else if (view.slowMo === true) {
    want = M.slowMoScale;
  }
  R.lastViewTime = isNum(view.time) ? view.time : NaN;
  R.scale = approach(R.scale, want, 14, rdt);
  if (Math.abs(R.scale - want) < 0.005) R.scale = want;
  R.slow = clamp01((1 - R.scale) / Math.max(0.05, 1 - M.slowMoScale));
  if (R.hitStop > 0) {
    R.hitStop = Math.max(0, R.hitStop - rdt);
    R.dt = 0;
  } else {
    R.dt = rdt * R.scale;
  }
  R.t += R.dt;

  // ---- camera --------------------------------------------------------------------------------
  const cam = view.camera, vp = view.viewport;
  let vw = vp ? num(vp.w, 0) : 0, vh = vp ? num(vp.h, 0) : 0;
  if (!(vw >= 2)) vw = R.cssW;
  if (!(vh >= 2)) vh = R.cssH;
  R.vw = vw >= 1 ? vw : 1;
  R.vh = vh >= 1 ? vh : 1;
  R.camX = cam ? num(cam.x, 0) : 0;
  R.camY = cam ? num(cam.y, 0) : 0;
  R.zoom = clamp(cam ? num(cam.zoom, 1) : 1, 0.02, 40);
  const S = R.shake;
  if (R.reduced) clearShake(S);
  else stepShake(S, rdt, R.slow);
  worldMatrix(R.W, R.camX, R.camY, R.zoom, R.vw, R.vh, R.edpr, S.ox, S.oy, S.rot, S.zoom);
  visibleRect(R.camX, R.camY, R.zoom * S.zoom, R.vw, R.vh, VIS_MARGIN_PX, R.vis);

  // ---- the world -----------------------------------------------------------------------------
  const b = readBall(view, R.ball.v);
  stepCelebration(R, view);
  prepareActors(R, view);
  stepBall(R);
  followFx(R);

  // ---- what is shown -------------------------------------------------------------------------
  const me = R.mine >= 0 ? R.actors[R.mine] : null;
  const mine = me !== null && me.ok;
  const aiming = mine && !R.inReplay && (R.phase === PHASE.PLAYING || R.phase === PHASE.KICKOFF);
  const pt = view.passTarget;
  R.passTarget = aiming && isNum(pt) && pt >= 0 && pt < R.count && (pt | 0) === pt && pt !== R.mine && R.actors[pt].ok ? pt : -1;
  R.aimA = approach(R.aimA, aiming ? 1 : 0, 12, rdt);
  R.replayA = approach(R.replayA, R.inReplay ? 1 : 0, 9, rdt);

  const inPlay = R.phase === PHASE.KICKOFF || R.phase === PHASE.PLAYING || R.phase === PHASE.GOAL;
  R.goldA = approach(R.goldA, R.overtime && inPlay && !R.inReplay ? 1 : 0, 3, rdt);
  R.arrowA = approach(R.arrowA, inPlay && !R.inReplay ? 1 : 0, 10, rdt);
  visibleRect(R.camX, R.camY, R.zoom, R.vw, R.vh, 0, camRect);
  R.mapA = approach(R.mapA, pitchInside(M.pm, camRect) || R.phase === PHASE.ENDED ? 0 : 1, 10, rdt);

  // The keeper box is closed to opponents while its keeper holds the ball.
  let closed = -1;
  if (b.ok && b.held && b.owner >= 0 && b.owner < R.count && R.actors[b.owner].ok) closed = R.actors[b.owner].team;
  R.boxA[0] = approach(R.boxA[0], closed === 0 ? 1 : 0, 10, rdt);
  R.boxA[1] = approach(R.boxA[1], closed === 1 ? 1 : 0, 10, rdt);

  // ---- timed emitters ------------------------------------------------------------------------
  if (R.dt > 0) {
    if (R.rain > 0) {
      // Confetti after a goal: a downpour that thins out.
      const k = R.rain / RAIN_TIME;
      R.rain = Math.max(0, R.rain - R.dt);
      R.rainAcc += R.dt * 300 * (0.35 + 0.65 * k);
      let c = Math.floor(R.rainAcc);
      R.rainAcc -= c;
      if (c > 40) c = 40;
      if (c > 0) rainOn(R, c, R.rainGold && Math.random() < 0.4 ? M.col.golden : M.teams[R.rainTeam === 1 ? 1 : 0].confetti);
    }
    if (R.phase === PHASE.FULL_TIME && !R.inReplay) {
      // Full time: the winners' colours come down; a draw gets a sprinkle of everything.
      const winner = winnerOf(view.score);
      R.fullTimeAcc += R.dt * (winner >= 0 ? 85 : 30);
      let c = Math.floor(R.fullTimeAcc);
      R.fullTimeAcc -= c;
      if (c > 20) c = 20;
      if (c > 0) rainOn(R, c, winner >= 0 ? M.teams[winner].confetti : M.col.mixed);
    }
  }

  stepCrowd(R);

  // ---- pools ---------------------------------------------------------------------------------
  stepParticles(R.P, R.dt);
  stepFx(R.F, R.dt);
  stepScuffs(R.scuffs, R.dt);
  stepGhosts(R.ghosts, R.dt);
  stepRipples(R.ripples, R.dt);
  stepNet(R.nets[0], R.dt);
  stepNet(R.nets[1], R.dt);

  if (R.flash > 0) R.flash = Math.max(0, R.flash * Math.exp(-7 * rdt) - 0.25 * rdt);
  for (let k = 0; k < 4; k++) {
    if (R.postShake[k] > 0) R.postShake[k] = Math.max(0, R.postShake[k] - rdt);
  }
  for (let i = 0; i < R.bubbles.length; i++) {
    const bubble = R.bubbles[i];
    if (!bubble.on) continue;
    bubble.age += rdt;
    if (bubble.age >= bubble.life) bubble.on = false;
  }
}
