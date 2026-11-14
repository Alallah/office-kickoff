// What the ball does between frames: it rolls, stretches with its speed, feeds its trail, burns
// when it is hot enough, leaves a corkscrew when it spins and leans into the net it lies in.
// Pure: no canvas. ball.js only draws what this prepares.

import { approach, clamp01, poseMatrix, rollPoints } from './mathx.js';
import { heatParam, netPress, trailClear, trailLife, trailPush } from './fxmodel.js';
import { embers, flames, spinMote } from './emitters.js';

/** A jump this long between two frames is a teleport (kickoff, replay cut), not a roll. */
const TELEPORT = 240;

/** The trail gets a new sample once the ball has moved this far (squared, world units). */
const TRAIL_STEP2 = 16;

/**
 * Needs R.ball.v to hold this frame's ball (viewx.readBall), and R.t / R.dt.
 */
export function stepBall(R) {
  const B = R.ball, b = B.v, M = R.M, dt = R.dt, pm = M.pm;
  if (!b.ok) {
    B.has = false;
    B.inNet = -1;
    B.glow = 0;
    B.fire = false;
    return;
  }

  if (B.has) {
    const dx = b.x - B.px, dy = b.y - B.py;
    if (dx * dx + dy * dy < TELEPORT * TELEPORT) rollPoints(B.pts, dx, dy, M.ballR, b.owner < 0 ? b.spin * dt * 7 : 0);
    else trailClear(R.trail);
  }
  B.px = b.x;
  B.py = b.y;
  B.has = true;

  B.speedN = clamp01(b.speed / M.shotMax);
  const stretch = b.held || b.dead ? 0 : Math.pow(B.speedN, 0.8);
  if (b.speed > 25) B.dir = Math.atan2(b.vy, b.vx);
  B.sa = 1 + 0.26 * stretch;
  B.sb = 1 - 0.11 * stretch;
  poseMatrix(B.dir, B.sa, B.sb, 0, 1, 1, B.m);

  B.fire = b.heat >= M.fire && !b.held;
  B.glow = approach(B.glow, b.held ? 0 : clamp01((b.heat - 0.2) / 0.6), 12, R.rdt);
  B.inNet = Math.abs(b.x) > pm.halfW && Math.abs(b.y) < pm.goalHalf + 6 ? (b.x < 0 ? 0 : 1) : -1;

  const free = b.owner < 0 && !b.held;
  const T = R.trail;
  if (free && b.speed > 70) {
    const tx = b.x - B.trailX, ty = b.y - B.trailY;
    if (T.n === 0 || tx * tx + ty * ty >= TRAIL_STEP2) {
      trailPush(T, b.x, b.y, R.t, trailLife(B.speedN, b.heat), heatParam(B.speedN, b.heat));
      B.trailX = b.x;
      B.trailY = b.y;
    }
  }

  // A curling ball: motes laid alternately left and right of its path draw a corkscrew.
  const spin = Math.abs(b.spin);
  if (free && spin > 0.1 && b.speed > 160 && dt > 0) {
    B.spinPhase += dt * (16 + 14 * spin) * (b.spin < 0 ? -1 : 1);
    B.spinAcc += dt * 70;
    const inv = 1 / b.speed;
    const nx = -b.vy * inv, ny = b.vx * inv;
    let guard = 6;
    while (B.spinAcc >= 1 && guard-- > 0) {
      B.spinAcc -= 1;
      const off = Math.sin(B.spinPhase) * M.ballR * (0.9 + 1.3 * spin);
      spinMote(R, b.x + nx * off, b.y + ny * off, M.col.cyan);
    }
    if (B.spinAcc >= 1) B.spinAcc = 0;
  } else {
    B.spinAcc = 0;
  }

  if (B.fire && dt > 0) {
    B.flameAcc += dt * 95;
    B.emberAcc += dt * 26;
    const cvx = b.vx * 0.12, cvy = b.vy * 0.12;
    let guard = 12;
    while (B.flameAcc >= 1 && guard-- > 0) {
      B.flameAcc -= 1;
      flames(R, b.x, b.y, cvx, cvy, 1, M.ballR * 0.95);
    }
    if (B.flameAcc >= 1) B.flameAcc = 0;
    guard = 4;
    while (B.emberAcc >= 1 && guard-- > 0) {
      B.emberAcc -= 1;
      embers(R, b.x, b.y, cvx, cvy, 1);
    }
    if (B.emberAcc >= 1) B.emberAcc = 0;
  } else if (!B.fire) {
    B.flameAcc = 0;
    B.emberAcc = 0;
  }

  // A ball lying against the back of the net holds it out.
  if (B.inNet >= 0) {
    const back = pm.halfW + pm.goalDepth - Math.abs(b.x);
    const reach = M.ballR + 8;
    if (back < reach) netPress(R.nets[B.inNet], (b.y + pm.goalHalf) / pm.goalWidth, (reach - back) * 0.9, 0.085);
  }
}
