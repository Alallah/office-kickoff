// The ball rules the browser needs to repeat: the free-ball integrator, the carried-ball
// position, the pass target rule and the kick formulas. All of it mirrors the simulation's rules
// (Match.Step) and is used for three things only: the ball at my own feet, the ghost ball that
// leaves my foot before the server has heard of the kick, and short extrapolations of the server
// ball. Nothing here is authoritative. Pure: no DOM.

import { attackSign, clamp, clampCircle, lerp } from './geom.js';

/** A free ball: position, velocity, spin (-1..1), heat (0..1) and `net` (0 = on the pitch, -1 / +1 = in the left / right net). */
export function newBall() {
  return { x: 0, y: 0, vx: 0, vy: 0, spin: 0, heat: 0, net: 0 };
}

export function copyBall(from, to) {
  to.x = from.x;
  to.y = from.y;
  to.vx = from.vx;
  to.vy = from.vy;
  to.spin = from.spin;
  to.heat = from.heat;
  to.net = from.net;
  return to;
}

// n is the wall's outward unit normal. The normal speed comes back times `bounce`, the tangential
// speed is multiplied by `friction`.
function reflect(b, nx, ny, bounce, friction) {
  const vn = b.vx * nx + b.vy * ny;
  if (vn <= 0) return;
  const tx = b.vx - vn * nx;
  const ty = b.vy - vn * ny;
  b.vx = tx * friction - nx * vn * bounce;
  b.vy = ty * friction - ny * vn * bounce;
}

function collidePitch(b, tuning, pitch) {
  const r = tuning.ball.radius;
  const bounce = tuning.pitch.wallBounce;
  const friction = tuning.pitch.wallFriction;
  const hw = pitch.halfW;
  const hh = pitch.halfH;

  const cx = hw - pitch.cornerRadius;
  const cy = hh - pitch.cornerRadius;
  const ax = Math.abs(b.x);
  const ay = Math.abs(b.y);
  if (ax > cx && ay > cy) {
    // Corner square: the wall is the arc.
    const dx = ax - cx;
    const dy = ay - cy;
    const limit = Math.max(0, pitch.cornerRadius - r);
    const d2 = dx * dx + dy * dy;
    if (d2 > limit * limit) {
      const d = Math.sqrt(d2);
      const sx = b.x < 0 ? -1 : 1;
      const sy = b.y < 0 ? -1 : 1;
      reflect(b, (dx / d) * sx, (dy / d) * sy, bounce, friction);
      b.x = sx * (cx + (dx / d) * limit);
      b.y = sy * (cy + (dy / d) * limit);
    }
  } else {
    if (b.y > hh - r) {
      reflect(b, 0, 1, bounce, friction);
      b.y = hh - r;
    } else if (b.y < -(hh - r)) {
      reflect(b, 0, -1, bounce, friction);
      b.y = -(hh - r);
    }
    // The end walls are open between the posts.
    if (ay >= pitch.goalHalf) {
      if (b.x > hw - r) {
        reflect(b, 1, 0, bounce, friction);
        b.x = hw - r;
      } else if (b.x < -(hw - r)) {
        reflect(b, -1, 0, bounce, friction);
        b.x = -(hw - r);
      }
    }
  }

  const reach = r + pitch.postRadius;
  for (let i = 0; i < pitch.posts.length; i++) {
    const post = pitch.posts[i];
    const dx = b.x - post.x;
    const dy = b.y - post.y;
    const d2 = dx * dx + dy * dy;
    if (d2 >= reach * reach) continue;
    const d = Math.sqrt(d2);
    // Dead centre on a post cannot really happen; push back onto the pitch if it does.
    const nx = d > 1e-6 ? dx / d : post.x < 0 ? 1 : -1;
    const ny = d > 1e-6 ? dy / d : 0;
    const vn = b.vx * nx + b.vy * ny;
    if (vn < 0) {
      b.vx -= (1 + bounce) * vn * nx;
      b.vy -= (1 + bounce) * vn * ny;
    }
    b.x = post.x + nx * reach;
    b.y = post.y + ny * reach;
  }

  // Over the line between the posts: from here on the ball lives in the net.
  if (Math.abs(b.y) < pitch.goalHalf && Math.abs(b.x) > hw + r * 0.5) b.net = b.x < 0 ? -1 : 1;
}

// A ball in the net stays in the net box, bouncing softly off the netting.
function collideNet(b, tuning, pitch) {
  const r = tuning.ball.radius;
  const bounce = tuning.pitch.netBounce;
  const side = b.net;
  const back = pitch.halfW + pitch.goalDepth - r;
  const wide = Math.max(0, pitch.goalHalf - r);
  // Mirror so the net is always on the +x side.
  let x = b.x * side;
  let vx = b.vx * side;
  if (x > back) {
    x = back;
    if (vx > 0) vx = -vx * bounce;
  } else if (x < pitch.halfW) {
    x = pitch.halfW;
    if (vx < 0) vx = -vx * bounce;
  }
  if (b.y > wide) {
    b.y = wide;
    if (b.vy > 0) b.vy = -b.vy * bounce;
  } else if (b.y < -wide) {
    b.y = -wide;
    if (b.vy < 0) b.vy = -b.vy * bounce;
  }
  b.x = x * side;
  b.vx = vx * side;
}

/**
 * One tick of the free-ball rule: spin, drag, rolling friction, move, walls, posts. Footballers
 * are not considered. Integrated in equal sub-steps so the ball never moves more than its radius
 * at a time.
 * @param dt simulation seconds
 */
export function stepFreeBall(b, dt, tuning, pitch) {
  if (!(dt > 0)) return b;
  const bt = tuning.ball;
  const speed0 = Math.sqrt(b.vx * b.vx + b.vy * b.vy);
  const steps = Math.min(64, Math.max(1, Math.ceil((speed0 * dt) / bt.radius)));
  const h = dt / steps;
  for (let s = 0; s < steps; s++) {
    if (b.spin !== 0) {
      const a = b.spin * bt.curveRate * h;
      const c = Math.cos(a);
      const sn = Math.sin(a);
      const vx = b.vx * c - b.vy * sn;
      b.vy = b.vx * sn + b.vy * c;
      b.vx = vx;
      b.spin *= Math.exp(-bt.spinDecay * h);
    }

    const keep = Math.exp(-bt.drag * h);
    b.vx *= keep;
    b.vy *= keep;
    let speed = Math.sqrt(b.vx * b.vx + b.vy * b.vy);
    if (speed > 0) {
      let next = speed - bt.rollFriction * h;
      if (next < bt.stopSpeed) next = 0;
      else if (next > bt.maxSpeed) next = bt.maxSpeed;
      b.vx *= next / speed;
      b.vy *= next / speed;
      speed = next;
    }
    b.heat = Math.max(0, b.heat - bt.heatDecay * h);

    if (speed === 0) break;
    b.x += b.vx * h;
    b.y += b.vy * h;
    if (b.net !== 0) collideNet(b, tuning, pitch);
    else collidePitch(b, tuning, pitch);
  }
  return b;
}

/**
 * Advances a free ball by `seconds` of simulation time in tick-sized pieces.
 * @param tickDt simulation seconds per tick
 */
export function advanceFreeBall(b, seconds, tickDt, tuning, pitch) {
  let left = seconds;
  let guard = 0;
  while (left > 1e-9 && guard++ < 240) {
    const h = left > tickDt ? tickDt : left;
    stepFreeBall(b, h, tuning, pitch);
    left -= h;
    if (b.vx === 0 && b.vy === 0) break;
  }
  return b;
}

/**
 * Where a carried ball sits: in front of its owner along the dribble angle, kept inside the walls
 * except in front of the goal mouth the carrier attacks, where it may cross the line (never during
 * a dash), and never inside a post.
 */
export function carriedBallPos(ox, oy, angle, sprinting, dashing, team, tuning, pitch, out) {
  const bt = tuning.ball;
  const r = bt.radius;
  const dist = tuning.player.radius + r + bt.dribbleGap + (sprinting ? bt.sprintDribbleGap : 0);
  const x = ox + Math.cos(angle) * dist;
  const y = oy + Math.sin(angle) * dist;
  const mayCross = !dashing && Math.abs(y) < pitch.goalHalf - r && x * attackSign(team) > pitch.halfW - r;
  if (mayCross) {
    out.x = x;
    out.y = y;
  } else {
    clampCircle(pitch, x, y, r, out);
  }

  const clear = pitch.postRadius + r;
  for (let i = 0; i < pitch.posts.length; i++) {
    const post = pitch.posts[i];
    const dx = out.x - post.x;
    const dy = out.y - post.y;
    const d2 = dx * dx + dy * dy;
    if (d2 >= clear * clear) continue;
    if (d2 > 1e-6) {
      const d = Math.sqrt(d2);
      out.x = post.x + (dx / d) * clear;
      out.y = post.y + (dy / d) * clear;
    } else {
      out.x = post.x + (post.x < 0 ? clear : -clear);
      out.y = post.y;
    }
  }
  return out;
}

/** dir = unit(AimPoint - p.Pos), falling back to p.Aim. */
export function aimDirection(px, py, aimX, aimY, aimAngle, out) {
  const dx = aimX - px;
  const dy = aimY - py;
  const l2 = dx * dx + dy * dy;
  if (l2 > 1) {
    const l = Math.sqrt(l2);
    out.x = dx / l;
    out.y = dy / l;
  } else {
    out.x = Math.cos(aimAngle);
    out.y = Math.sin(aimAngle);
  }
  return out;
}

const start = { x: 0, y: 0 };
const dir = { x: 0, y: 0 };
const lead = { x: 0, y: 0 };

/**
 * The shot rule: fills `ball` with a ball struck by footballer p (x, y, vx, vy, aim) towards the
 * aim point with charge c.
 */
export function launchShot(ball, p, aimX, aimY, c, tuning, pitch, ballSpeed) {
  const kick = tuning.kick;
  aimDirection(p.x, p.y, aimX, aimY, p.aim, dir);
  const speed = lerp(kick.shotMinSpeed, kick.shotMaxSpeed, c) * ballSpeed;
  const off = tuning.player.radius + tuning.ball.radius + 1;
  clampCircle(pitch, p.x + dir.x * off, p.y + dir.y * off, tuning.ball.radius, start);
  ball.x = start.x;
  ball.y = start.y;
  ball.vx = dir.x * speed + p.vx * kick.inheritVelocity;
  ball.vy = dir.y * speed + p.vy * kick.inheritVelocity;
  const v = Math.hypot(ball.vx, ball.vy);
  if (v > tuning.ball.maxSpeed) {
    ball.vx *= tuning.ball.maxSpeed / v;
    ball.vy *= tuning.ball.maxSpeed / v;
  }
  // A shot bends towards the side the shooter is moving (dir.Perp = (-y, x)).
  const sideways = p.vx * -dir.y + p.vy * dir.x;
  ball.spin = clamp((sideways / tuning.player.runSpeed) * kick.curveFromMove, -1, 1) * (0.35 + 0.65 * c);
  ball.heat = c;
  ball.net = 0;
  return ball;
}

const candIndex = [];
const candAngle = [];
const candDist = [];

/**
 * The pass target rule, literally: team-mates within PassConeDeg of the aim direction; outfield
 * team-mates first, the own goalkeeper only when no outfield team-mate is in the cone; everyone
 * within PassTieDeg of the best-aligned one is tied and the nearest of those gets the ball.
 * @param positions  {x, y} per footballer, indexed like the match
 * @param infos      MatchInit.players
 * @param me         index of the passer
 * @param px,py      position of the passer
 * @param dirX,dirY  unit aim direction
 * @returns {number} footballer index or -1
 */
export function findPassTarget(positions, infos, me, px, py, dirX, dirY, kick) {
  const who = infos[me];
  if (!who) return -1;
  const cone = (kick.passConeDeg * Math.PI) / 180;
  const tie = (kick.passTieDeg * Math.PI) / 180;
  const n = Math.min(positions.length, infos.length);
  candIndex.length = 0;
  candAngle.length = 0;
  candDist.length = 0;
  let keeper = -1;
  let best = Infinity;
  for (let j = 0; j < n; j++) {
    const info = infos[j];
    if (j === me || !info || info.team !== who.team) continue;
    const dx = positions[j].x - px;
    const dy = positions[j].y - py;
    const d = Math.sqrt(dx * dx + dy * dy);
    if (d < 1e-6) continue;
    const angle = Math.acos(clamp((dx * dirX + dy * dirY) / d, -1, 1));
    if (angle > cone) continue;
    if (info.keeper) {
      keeper = j;
      continue;
    }
    candIndex.push(j);
    candAngle.push(angle);
    candDist.push(d);
    if (angle < best) best = angle;
  }
  if (candIndex.length === 0) return keeper;

  let target = -1;
  let nearest = Infinity;
  for (let i = 0; i < candIndex.length; i++) {
    if (candAngle[i] <= best + tie && candDist[i] < nearest) {
      nearest = candDist[i];
      target = candIndex[i];
    }
  }
  return target;
}

/**
 * The pass rule: fills `ball` with a pass by footballer p. `target` is the receiver's
 * {x, y, vx, vy} or null for a pass into space along the aim direction.
 * @returns {number} v0, the speed the ball leaves at
 */
export function launchPass(ball, p, aimX, aimY, target, tuning, pitch, ballSpeed) {
  const kick = tuning.kick;
  const r = tuning.ball.radius;
  const off = tuning.player.radius + r + 1;
  const lo = kick.passMinSpeed * ballSpeed;
  const hi = kick.passMaxSpeed * Math.max(1, ballSpeed);
  const weight = (d) => clamp(kick.passArriveSpeed * ballSpeed + tuning.ball.drag * d, lo, hi);

  let v0;
  let tx = 0;
  let ty = 0;
  let tl = 0;
  if (target) {
    tx = target.x - p.x;
    ty = target.y - p.y;
    tl = Math.sqrt(tx * tx + ty * ty);
  }
  if (target && tl > 1e-6) {
    // Weight for the receiver's feet first, then lead the receiver by that flight time. The lead
    // is a place the receiver can actually stand, so it is kept a footballer's radius off the walls.
    clampCircle(pitch, p.x + (tx / tl) * off, p.y + (ty / tl) * off, r, start);
    const d0 = Math.hypot(target.x - start.x, target.y - start.y);
    v0 = weight(d0);
    const flight = (d0 / Math.max(v0, 1)) * kick.passLead;
    clampCircle(pitch, target.x + target.vx * flight, target.y + target.vy * flight, tuning.player.radius, lead);
    const lx = lead.x - p.x;
    const ly = lead.y - p.y;
    const ll = Math.sqrt(lx * lx + ly * ly);
    if (ll > 1) {
      dir.x = lx / ll;
      dir.y = ly / ll;
    } else {
      dir.x = tx / tl;
      dir.y = ty / tl;
    }
    clampCircle(pitch, p.x + dir.x * off, p.y + dir.y * off, r, start);
    v0 = weight(Math.hypot(lead.x - start.x, lead.y - start.y));
  } else {
    aimDirection(p.x, p.y, aimX, aimY, p.aim, dir);
    clampCircle(pitch, p.x + dir.x * off, p.y + dir.y * off, r, start);
    v0 = weight(Math.hypot(aimX - start.x, aimY - start.y));
  }

  ball.x = start.x;
  ball.y = start.y;
  ball.vx = dir.x * v0;
  ball.vy = dir.y * v0;
  ball.spin = 0;
  ball.heat = 0.15;
  ball.net = 0;
  return v0;
}
