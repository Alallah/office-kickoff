// Goal celebrations: who celebrates, with which of the six, for how long, and what each one
// throws into the air on its beat. The poses themselves are in poses.js; actors.js applies them.
// Pure: no canvas.

import { PHASE } from '../../shared/protocol.js';
import { TAU } from './mathx.js';
import { addTrauma, punchZoom } from './fxmodel.js';
import { CELEB, celebrationBeats, celebrationForIndex, dabStrike } from './poses.js';
import { playerAt } from './viewx.js';
import { FX_GLOW, FX_RING, FX_STAR, FXF_ADD, FXF_TOP, spawnFx } from './fxpool.js';
import { confettiBurst, dust, hearts, sparks, starPop, turf } from './emitters.js';

const rnd = Math.random;

/**
 * The phase a goal event arrives in can lag the event by a frame or two; the celebration is not
 * judged "over" before this many seconds.
 */
const GRACE = 0.35;

/**
 * Starts the celebration for a goal.
 * @param evt   the EVT.GOAL event (a = scorer or -1)
 * @param info  goalInfo(evt): the scorer's human comes from here, never from the current controller
 */
export function beginCelebration(R, evt, info) {
  const M = R.M, C = R.celeb;
  C.on = false;
  C.joy = false;
  C.i = -1;
  C.team = info.team === 1 ? 1 : 0;
  C.replay = evt.replay === true;
  C.t0 = R.t;
  C.beats = 0;
  C.acc = 0;
  if (!M.celebrations || info.ownGoal) return;

  // The whole team is happy; the scorer, when there is one, does the number.
  C.joy = true;
  const i = evt.a;
  if (!(i >= 0 && i < R.actors.length && (i | 0) === i)) return;
  const h = info.scorerHuman;
  const human = h >= 0 && h < M.humans.length ? M.humans[h] : null;
  const team = M.teams[C.team];
  C.on = true;
  C.i = i;
  C.kind = human ? human.celebration : celebrationForIndex(i);
  C.colA = human ? human.cColor : team.cPrimary;
  C.colB = human ? human.cLight : team.cLight;
}

export function endCelebration(R) {
  const C = R.celeb;
  C.on = false;
  C.joy = false;
  C.i = -1;
}

function accent(R, C, x, y, t) {
  const M = R.M, F = R.F, r = M.playerR;
  switch (C.kind) {
    case CELEB.SPIN: {
      // Sparks flung off the rim of the spinning top.
      const a0 = rnd() * TAU;
      for (let k = 0; k < 5; k++) {
        const ang = a0 + (k * TAU) / 5;
        sparks(R, x + Math.cos(ang) * r, y + Math.sin(ang) * r, ang + 1.25, 0.5, 300, 1, C.colB);
      }
      const i = spawnFx(F, FX_RING, x, y, r, r + 30, 0.3, 2.5, C.colA, FXF_ADD);
      F.follow[i] = C.i;
      break;
    }
    case CELEB.DAB: {
      const side = dabStrike(t) < 0 ? -1 : 1;
      const dir = -Math.PI / 2 + side * 0.8;
      const px = x + Math.cos(dir) * (r + 14), py = y + Math.sin(dir) * (r + 14);
      const i = spawnFx(F, FX_STAR, px, py, 6, 26, 0.22, 0, C.colB, FXF_ADD | FXF_TOP);
      F.spikes[i] = 4;
      F.rot[i] = rnd() * TAU;
      sparks(R, px, py, dir, 0.9, 420, 7, C.colA);
      if (!R.reduced) addTrauma(R.shake, 0.07);
      break;
    }
    case CELEB.CONFETTI: {
      confettiBurst(R, x, y - 6, -Math.PI / 2, TAU, 170, 16, M.teams[C.team].confetti, 380);
      const i = spawnFx(F, FX_RING, x, y, r * 0.7, r + 22, 0.25, 2.5, C.colB, 0);
      F.alpha[i] = 0.6;
      break;
    }
    case CELEB.BACKFLIP: {
      // The landing.
      for (let k = 0; k < 8; k++) {
        const ang = (k * TAU) / 8;
        dust(R, x + Math.cos(ang) * r * 0.6, y + Math.sin(ang) * r * 0.6, ang, 0.5, 120, 1, 5.5);
      }
      const i = spawnFx(F, FX_RING, x, y, r, r + 36, 0.3, 3, M.col.white, 0);
      F.alpha[i] = 0.7;
      starPop(R, x, y - r, 3, M.col.gold, 110);
      if (!R.reduced) addTrauma(R.shake, 0.1);
      break;
    }
    case CELEB.SHOCKWAVE: {
      // The stomp.
      spawnFx(F, FX_RING, x, y, r * 0.8, 150, 0.5, 7, C.colA, FXF_ADD);
      const i = spawnFx(F, FX_RING, x, y, r * 0.8, 205, 0.6, 4, C.colB, FXF_ADD);
      F.delay[i] = 0.09;
      const g = spawnFx(F, FX_GLOW, x, y, 20, 72, 0.16, 0, C.colB, FXF_ADD);
      F.alpha[g] = 0.8;
      turf(R, x, y, 0, TAU, 260, 14);
      if (!R.reduced) {
        addTrauma(R.shake, 0.28);
        punchZoom(R.shake, 0.012);
      }
      break;
    }
    case CELEB.HEARTS:
      hearts(R, x, y - r * 0.4, 1 + (C.beats & 1), C.beats % 3 === 0 ? C.colA : M.col.pink);
      break;
    default:
      break;
  }
}

/** Ends the celebration when its time is up, and fires the effect of each beat exactly once. */
export function stepCelebration(R, view) {
  const C = R.celeb;
  if (!C.on && !C.joy) return;
  C.acc += R.rdt;
  const over = C.replay ? !(view && view.replay) : !view || view.phase !== PHASE.GOAL;
  if (over && C.acc > GRACE) {
    endCelebration(R);
    return;
  }
  if (!C.on || !(R.dt > 0)) return;
  const p = playerAt(view, C.i);
  if (!p) return;
  const t = R.t - C.t0;
  const beats = celebrationBeats(C.kind, t);
  if (beats > C.beats) {
    C.beats = beats;
    accent(R, C, p.x, p.y, t);
  }
}
