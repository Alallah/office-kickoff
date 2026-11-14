// The crowd's behaviour: how excited each stand is, the hop phase that makes it bob, and the
// camera flashes that sparkle across the stands. Pure: no canvas. crowd.js draws it.

import { PHASE } from '../../shared/protocol.js';
import { approach } from './mathx.js';
import { hop, standExcitement, stepMood } from './fxmodel.js';
import { flashbulb } from './emitters.js';

const rnd = Math.random;

/** Rows further back than this are too dark for a flash to read. */
const FLASH_ROWS = 8;

/** sin(ph) and sin(0.6 ph) both repeat every 10 pi. */
const PHASE_WRAP = Math.PI * 10;

/**
 * How far (world units, up the screen) one of the three interleaved crowd layers of a stand is
 * lifted right now: a slow sway at rest, proper jumping when the stand is excited.
 */
export function crowdLift(R, strip, group) {
  const ph = R.crowdPhase[strip] + group * 2.1;
  const amp = R.crowdAmp[strip];
  const jump = hop(ph) * (0.5 + 7.5 * amp);
  return 0.7 * Math.sin(ph * 0.6 + group) + (R.reduced ? jump * 0.25 : jump);
}

/**
 * Needs R.ball.v, R.phase, R.live and R.vis for this frame.
 */
export function stepCrowd(R) {
  const M = R.M, C = R.mood, b = R.ball.v, dt = R.rdt;
  stepMood(C, dt, b.x, b.y, b.ok && R.live && !b.dead, M.pm);
  // A buzz of anticipation before the kick-off.
  if (R.phase === PHASE.INTRO) C.roar = Math.max(C.roar, 0.22);
  else if (R.phase === PHASE.KICKOFF) C.roar = Math.max(C.roar, 0.1);

  for (let strip = 0; strip < 4; strip++) {
    const e = standExcitement(C, strip);
    const amp = approach(R.crowdAmp[strip], e, e > R.crowdAmp[strip] ? 9 : 2.5, dt);
    R.crowdAmp[strip] = amp;
    // Wrapped at the common period of the hop and the sway (see crowdLift) so it never loses precision.
    let ph = R.crowdPhase[strip] + dt * (2.2 + 9.5 * amp);
    if (ph > PHASE_WRAP) ph -= PHASE_WRAP;
    R.crowdPhase[strip] = ph;
  }

  if (R.reduced) {
    R.flashAcc = 0;
    return;
  }
  // Camera flashes: the odd one all evening, a ripple when a chance builds, a storm after a goal.
  const surge = Math.max(C.surge[0], C.surge[1]);
  R.flashAcc += dt * (0.8 + 7 * surge + 85 * C.roar * C.roar);
  const seats = M.seats, vis = R.vis;
  let guard = 8;
  while (R.flashAcc >= 1 && guard-- > 0) {
    R.flashAcc -= 1;
    for (let tries = 0; tries < 4; tries++) {
      const i = (rnd() * seats.n) | 0;
      if (i >= seats.n || seats.row[i] > FLASH_ROWS) continue;
      const x = seats.x[i], y = seats.y[i];
      if (x < vis.x0 || x > vis.x1 || y < vis.y0 || y > vis.y1) continue;
      flashbulb(R, x, y - crowdLift(R, seats.strip[i], seats.group[i]) - 3);
      break;
    }
  }
  if (R.flashAcc >= 1) R.flashAcc = 0;
}
