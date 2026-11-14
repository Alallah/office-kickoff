// Client-side prediction of the local player's footballer.
//
//   stepMotion()       line-for-line port of src/OfficeKickoff.Sim/PlayerMotion.cs. ANY change there
//                      must be mirrored here (and the other way round).
//   createPredictor()  reconciliation: after every snapshot the footballer is re-seeded from the
//                      server and every input the server has not applied yet is replayed on top.
//
// Pure: no DOM, no clocks. Everything here runs under the jscheck interpreter.

import { ACTION, KEY, PHASE, PLAYER_FLAG, TICK_SECONDS } from '../shared/protocol.js';
import { CONFIG } from './config.js';
import { angleDiff, clampCircle, finite, lerp, makePitch } from './geom.js';

/** MotionEvents (PlayerMotion.cs). */
export const MOTION = Object.freeze({
  SLIDE_STARTED: 1,
  DASH_STARTED: 2,
  DIVE_STARTED: 4,
  SLIDE_MISSED: 8,
  SHOT_RELEASED: 16,
});

// The simulation computes in 32-bit floats. Timers, stamina and charge are compared against
// thresholds, and a dash of 0.2 s lasts 12 or 13 ticks depending on how 0.2 - 12 * (1 / 60) rounds;
// so everything that feeds such a comparison is rounded to float exactly like the C# code does.
// Positions and velocities stay doubles: there the difference is far below a pixel.
const f = Math.fround;

/** The part of PlayerState the movement kernel reads and writes. */
export function newPlayerState() {
  return {
    isKeeper: false,
    diveSpeed: 0,
    diveCooldown: 0,
    speedFactor: 1,

    x: 0, y: 0, vx: 0, vy: 0,
    aim: 0,

    action: ACTION.NONE,
    actionT: 0,
    adx: 1, ady: 0,
    slideHit: false,

    stamina: 1,
    exhausted: false,
    regenDelay: 0,
    sprinting: false,

    charging: false,
    charge: 0,

    tackleCd: 0,
    kickCd: 0,
    stealLockout: 0,
    immune: 0,
  };
}

export function copyPlayerState(from, to) {
  to.isKeeper = from.isKeeper;
  to.diveSpeed = from.diveSpeed;
  to.diveCooldown = from.diveCooldown;
  to.speedFactor = from.speedFactor;
  to.x = from.x; to.y = from.y; to.vx = from.vx; to.vy = from.vy;
  to.aim = from.aim;
  to.action = from.action;
  to.actionT = from.actionT;
  to.adx = from.adx; to.ady = from.ady;
  to.slideHit = from.slideHit;
  to.stamina = from.stamina;
  to.exhausted = from.exhausted;
  to.regenDelay = from.regenDelay;
  to.sprinting = from.sprinting;
  to.charging = from.charging;
  to.charge = from.charge;
  to.tackleCd = from.tackleCd;
  to.kickCd = from.kickCd;
  to.stealLockout = from.stealLockout;
  to.immune = from.immune;
  return to;
}

/** PlayerInput as the kernel wants it. */
export function newMotionInput() {
  return { moveX: 0, moveY: 0, aimX: 0, aimY: 0, sprint: false, shoot: false, pass: false, tackle: false };
}

/** Wire input ({ s, mx, my, ax, ay, k }) -> kernel input. */
export function decodeInput(rec, out) {
  out.moveX = rec.mx;
  out.moveY = rec.my;
  out.aimX = rec.ax;
  out.aimY = rec.ay;
  out.sprint = (rec.k & KEY.SPRINT) !== 0;
  out.shoot = (rec.k & KEY.SHOOT) !== 0;
  out.pass = (rec.k & KEY.PASS) !== 0;
  out.tackle = (rec.k & KEY.TACKLE) !== 0;
  return out;
}

const clampOut = { x: 0, y: 0 };

/**
 * Advances ONE footballer by one tick from their input (PlayerMotion.Step).
 * @param p        footballer state (newPlayerState)
 * @param input    controls for this tick (newMotionInput)
 * @param hasBall  true when this footballer currently owns the ball
 * @param frozen   true during Intro / Kickoff countdowns: only aiming is allowed
 * @param dt       simulation seconds for this tick (already scaled by game speed / slow motion)
 * @param tuning   MatchInit.tuning
 * @param pitch    makePitch(MatchInit.pitch)
 * @param result   receives { events: MOTION bits, releasedCharge }
 */
export function stepMotion(p, input, hasBall, frozen, dt, tuning, pitch, result) {
  result.events = 0;
  result.releasedCharge = 0;
  const pt = tuning.player;
  const tk = tuning.tackle;
  dt = f(dt);

  // 1. Aim follows the cursor unless the footballer is committed to an action.
  if (p.action === ACTION.NONE || p.action === ACTION.DASH) {
    const tx = input.aimX - p.x;
    const ty = input.aimY - p.y;
    if (tx * tx + ty * ty > 1) p.aim = Math.atan2(ty, tx);
  }

  if (frozen) {
    p.vx = 0;
    p.vy = 0;
    p.charging = false;
    p.charge = 0;
    p.sprinting = false;
    return result;
  }

  // 2. Timers.
  p.tackleCd = f(Math.max(0, p.tackleCd - dt));
  p.kickCd = f(Math.max(0, p.kickCd - dt));
  p.stealLockout = f(Math.max(0, p.stealLockout - dt));
  p.immune = f(Math.max(0, p.immune - dt));

  // 3. A running action expires.
  if (p.action !== ACTION.NONE) {
    p.actionT = f(p.actionT - dt);
    if (p.actionT <= 0) {
      if (p.action === ACTION.SLIDE && p.slideHit) {
        p.action = ACTION.RECOVER;
        p.actionT = f(tk.hitRecover);
      } else if (p.action === ACTION.SLIDE) {
        p.action = ACTION.STUNNED;
        p.actionT = f(tk.missStun);
        result.events |= MOTION.SLIDE_MISSED;
      } else if (p.action === ACTION.DIVE) {
        p.action = ACTION.RECOVER;
        p.actionT = f(tuning.keeper.diveRecover);
      } else {
        p.action = ACTION.NONE;
        p.actionT = 0;
      }
    }
  }

  // 4. Start a slide (no ball), a dash (with ball) or a dive (keeper).
  if (input.tackle && p.action === ACTION.NONE && p.tackleCd <= 0) {
    let dirX;
    let dirY;
    const m2 = input.moveX * input.moveX + input.moveY * input.moveY;
    if (m2 > 0.04) {
      const l = Math.sqrt(m2);
      dirX = input.moveX / l;
      dirY = input.moveY / l;
    } else {
      dirX = Math.cos(p.aim);
      dirY = Math.sin(p.aim);
    }

    if (p.isKeeper) {
      const tx = input.aimX - p.x;
      const ty = input.aimY - p.y;
      const t2 = tx * tx + ty * ty;
      p.action = ACTION.DIVE;
      p.actionT = f(tuning.keeper.diveTime);
      if (t2 > 1) {
        const l = Math.sqrt(t2);
        p.adx = tx / l;
        p.ady = ty / l;
      } else {
        p.adx = dirX;
        p.ady = dirY;
      }
      p.tackleCd = f(p.diveCooldown);
      result.events |= MOTION.DIVE_STARTED;
    } else if (hasBall) {
      if (p.stamina >= f(tk.dashStaminaCost)) {
        p.stamina = f(p.stamina - f(tk.dashStaminaCost));
        p.regenDelay = f(pt.regenDelay);
        p.action = ACTION.DASH;
        p.actionT = f(tk.dashTime);
        p.adx = dirX;
        p.ady = dirY;
        p.immune = f(tk.dashImmune);
        p.tackleCd = f(tk.cooldown);
        result.events |= MOTION.DASH_STARTED;
      }
    } else {
      p.action = ACTION.SLIDE;
      p.actionT = f(tk.slideTime);
      p.adx = dirX;
      p.ady = dirY;
      p.slideHit = false;
      p.tackleCd = f(tk.cooldown);
      result.events |= MOTION.SLIDE_STARTED;
    }
  }

  // 5. Shot charging. Only possible while free to act; anything else cancels the charge.
  const canCharge = p.action === ACTION.NONE || p.action === ACTION.DASH;
  if (!canCharge) {
    p.charging = false;
    p.charge = 0;
  } else if (input.shoot) {
    p.charging = true;
    p.charge = f(Math.min(1, p.charge + f(dt / f(tuning.kick.chargeTime))));
  } else if (p.charging) {
    result.events |= MOTION.SHOT_RELEASED;
    result.releasedCharge = p.charge;
    p.charging = false;
    p.charge = 0;
  }

  // 6. Velocity.
  p.sprinting = false;
  switch (p.action) {
    case ACTION.NONE: {
      let mx = input.moveX;
      let my = input.moveY;
      const l2 = mx * mx + my * my;
      if (l2 > 1) {
        const l = Math.sqrt(l2);
        mx /= l;
        my /= l;
      }
      const moving = mx * mx + my * my > 0.01;
      const sprint = input.sprint && moving && !p.exhausted && p.stamina > 0;
      let max = (sprint ? pt.sprintSpeed : pt.runSpeed) * p.speedFactor;
      if (hasBall) max *= pt.dribbleSpeedFactor;
      if (p.charging) max *= pt.chargeMoveFactor;

      let dvx = mx * max - p.vx;
      let dvy = my * max - p.vy;
      const maxDv = (moving ? pt.accel : pt.decel) * dt;
      const dv2 = dvx * dvx + dvy * dvy;
      if (dv2 > maxDv * maxDv) {
        const d = Math.sqrt(dv2);
        dvx = (dvx / d) * maxDv;
        dvy = (dvy / d) * maxDv;
      }
      p.vx += dvx;
      p.vy += dvy;

      if (sprint) {
        p.sprinting = true;
        p.stamina = f(p.stamina - f(f(pt.sprintDrain) * dt));
        p.regenDelay = f(pt.regenDelay);
        if (p.stamina <= 0) {
          p.stamina = 0;
          p.exhausted = true;
        }
      } else {
        regenerate(p, pt, dt);
      }
      break;
    }
    case ACTION.SLIDE: {
      const k = 1 - clamp01(p.actionT / tk.slideTime);
      const speed = lerp(tk.slideSpeed, tk.slideEndSpeed, k);
      p.vx = p.adx * speed;
      p.vy = p.ady * speed;
      regenerate(p, pt, dt);
      break;
    }
    case ACTION.DASH:
      p.vx = p.adx * tk.dashSpeed;
      p.vy = p.ady * tk.dashSpeed;
      break;
    case ACTION.DIVE: {
      const k = clamp01(p.actionT / tuning.keeper.diveTime);
      const speed = p.diveSpeed * (0.35 + 0.65 * k);
      p.vx = p.adx * speed;
      p.vy = p.ady * speed;
      break;
    }
    default: {
      // Stunned, Recover
      const keep = Math.exp(-pt.stunFriction * dt);
      p.vx *= keep;
      p.vy *= keep;
      regenerate(p, pt, dt);
      break;
    }
  }

  // 7. Integrate and keep the footballer inside the walls.
  const wantedX = p.x + p.vx * dt;
  const wantedY = p.y + p.vy * dt;
  clampCircle(pitch, wantedX, wantedY, pt.radius, clampOut);
  if (clampOut.x !== wantedX || clampOut.y !== wantedY) {
    // Remove the velocity component that pushes into the wall.
    let nx = clampOut.x - wantedX;
    let ny = clampOut.y - wantedY;
    const l = Math.sqrt(nx * nx + ny * ny);
    if (l > 1e-6) {
      nx /= l;
      ny /= l;
    } else {
      nx = 0;
      ny = 0;
    }
    const vn = p.vx * nx + p.vy * ny;
    if (vn < 0) {
      p.vx -= nx * vn;
      p.vy -= ny * vn;
    }
  }

  p.x = clampOut.x;
  p.y = clampOut.y;
  return result;
}

function regenerate(p, pt, dt) {
  if (p.regenDelay > 0) {
    p.regenDelay = f(Math.max(0, p.regenDelay - dt));
    return;
  }

  p.stamina = f(Math.min(1, p.stamina + f(f(pt.staminaRegen) * dt)));
  if (p.exhausted && p.stamina >= f(pt.exhaustedRecover)) p.exhausted = false;
}

function clamp01(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

// ---------------------------------------------------------------------------------------------
//  Which rules apply to an input that the server has not applied yet
// ---------------------------------------------------------------------------------------------

export const MODE = Object.freeze({ NONE: 0, FROZEN: 1, PLAY: 2 });

/** Phases in which the local footballer is predicted at all. */
export function isPredictedPhase(phase) {
  return phase === PHASE.INTRO || phase === PHASE.KICKOFF || phase === PHASE.PLAYING || phase === PHASE.GOAL;
}

/**
 * How the server will treat the input it applies `ticksAhead` ticks after the given snapshot.
 * The server applies one input per tick, so the k-th unacknowledged input lands k ticks after the
 * snapshot: a kickoff countdown that runs out before then no longer freezes it, and post-goal slow
 * motion that ends before then no longer slows it.
 * @param out receives { kind: MODE.*, dt: simulation seconds }
 */
export function phaseMode(snap, ticksAhead, env, out) {
  const ahead = ticksAhead * TICK_SECONDS;
  out.kind = MODE.NONE;
  out.dt = env.dt;
  switch (snap.phase) {
    case PHASE.INTRO:
      out.kind = MODE.FROZEN;
      break;
    case PHASE.KICKOFF:
      out.kind = ahead >= snap.phaseTime - 1e-3 ? MODE.PLAY : MODE.FROZEN;
      break;
    case PHASE.PLAYING:
      out.kind = MODE.PLAY;
      break;
    case PHASE.GOAL: {
      // What follows the celebration is a pause (replay) or a teleport (kickoff): not predictable.
      if (ahead >= snap.phaseTime - 1e-3) break;
      out.kind = MODE.PLAY;
      if (snap.slowMo) {
        const slowLeft = env.goalSlowMoTime - (env.goalPhaseTime - snap.phaseTime);
        if (ahead < slowLeft + 1e-3) out.dt = env.dtSlow;
      }
      break;
    }
    default:
      break;
  }
  return out;
}

/** The numbers prediction needs from a MatchInit. */
export function makePredictEnv(init) {
  const tuning = init.tuning;
  const settings = init.settings || {};
  const rules = tuning.rules;
  const level = ['easy', 'normal', 'hard'][settings.aiKeeper | 0] || 'normal';
  const gameSpeed = finite(settings.gameSpeed, 1) || 1;
  const slowScale = finite(rules.goalSlowMoScale, 1);
  // simDt = dtReal * GameSpeed * (SlowMo ? GoalSlowMoScale : 1), in floats like the simulation.
  const dt = f(f(TICK_SECONDS) * f(gameSpeed));
  return {
    tuning,
    pitch: makePitch(init.pitch),
    players: init.players || [],
    gameSpeed,
    ballSpeed: finite(settings.ballSpeed, 1) || 1,
    slowScale,
    dt,
    dtSlow: f(dt * f(slowScale)),
    goalSlowMoTime: finite(rules.goalSlowMoTime, 0),
    goalPhaseTime: settings.celebrations === false ? rules.goalShortTime : rules.goalCelebrationTime,
    keeperDiveSpeed: finite(tuning.keeper?.diveSpeed?.[level], 0),
    keeperDiveCooldown: finite(tuning.keeper?.diveCooldown?.[level], 0),
  };
}

// ---------------------------------------------------------------------------------------------
//  Reconciliation
// ---------------------------------------------------------------------------------------------

const HISTORY = 64;

// Snapshots are rounded (positions and velocities to 0.1, everything else to 0.001). When the
// server's value agrees with what was predicted for the same input within that rounding, the
// prediction is the more precise of the two and is kept; a real difference takes the server's.
const POS_TOL = 0.08;
const VEL_TOL = 0.12;
const ANGLE_TOL = 1.2e-3;
const SMALL_TOL = 9e-4;

/**
 * Owns the unacknowledged inputs and the predicted state of the local footballer.
 *
 * `prev` and `cur` are the footballer before and after the newest input, so the caller can draw
 * between ticks. The state predicted after each input is remembered: it supplies what a snapshot
 * does not carry (stamina regeneration delay, the length of the dash immunity, kick and steal
 * lock-outs) and the digits a snapshot rounds away.
 */
export function createPredictor() {
  /** @type {?ReturnType<typeof makePredictEnv>} */
  let env = null;
  let humanId = -1;

  /** Inputs sent but not yet acknowledged, ascending by s. */
  const pending = [];
  let lastSentSeq = 0;
  /** Newest input the server has applied, as far as the snapshots say (0 = none since the last reset). */
  let lastAck = 0;

  let me = -1;
  let valid = false;
  const cur = newPlayerState();
  const prev = newPlayerState();

  /** s of my predicted shot / pass while the server has not applied it: later inputs have no ball. */
  let kickSeq = 0;
  /** Predicted control hand-over after my pass: { seq, from, to, time }. */
  let handover = null;

  const history = [];
  for (let i = 0; i < HISTORY; i++) history.push({ seq: -1, index: -1, s: newPlayerState() });

  const input = newMotionInput();
  const result = { events: 0, releasedCharge: 0 };
  const mode = { kind: MODE.NONE, dt: 0 };
  const info = { me: -1, exact: false, dx: 0, dy: 0 };
  const pushed = { events: 0, releasedCharge: 0, kind: MODE.NONE };

  function remember(seq) {
    const h = history[seq & (HISTORY - 1)];
    h.seq = seq;
    h.index = me;
    copyPlayerState(cur, h.s);
  }

  function seed(state, snap, index, ack) {
    const sp = snap.players[index];
    const pt = env.tuning.player;
    const tk = env.tuning.tackle;
    const flags = sp.flags | 0;
    const who = env.players[index];
    const h = ack > 0 ? history[ack & (HISTORY - 1)] : null;
    /** What I predicted for this footballer after the acknowledged input, if I did. */
    const mine = h !== null && h.seq === ack && h.index === index ? h.s : null;

    state.isKeeper = !!(who && who.keeper);
    state.diveSpeed = env.keeperDiveSpeed;
    state.diveCooldown = env.keeperDiveCooldown;
    // A human-controlled footballer always moves at full speed.
    state.speedFactor = 1;

    if (mine && Math.abs(mine.x - sp.x) <= POS_TOL && Math.abs(mine.y - sp.y) <= POS_TOL) {
      state.x = mine.x;
      state.y = mine.y;
    } else {
      state.x = sp.x;
      state.y = sp.y;
    }
    if (mine && Math.abs(mine.vx - sp.vx) <= VEL_TOL && Math.abs(mine.vy - sp.vy) <= VEL_TOL) {
      state.vx = mine.vx;
      state.vy = mine.vy;
    } else {
      state.vx = sp.vx;
      state.vy = sp.vy;
    }
    state.aim = mine && Math.abs(angleDiff(mine.aim, sp.aim)) <= ANGLE_TOL ? mine.aim : sp.aim;

    state.action = sp.action;
    const sameAction = mine !== null && mine.action === sp.action;
    state.actionT = sameAction && Math.abs(mine.actionT - sp.actionT) <= SMALL_TOL ? mine.actionT : f(sp.actionT);
    const adx = Math.cos(sp.actionDir);
    const ady = Math.sin(sp.actionDir);
    if (sameAction && Math.abs(mine.adx - adx) <= ANGLE_TOL && Math.abs(mine.ady - ady) <= ANGLE_TOL) {
      state.adx = mine.adx;
      state.ady = mine.ady;
    } else {
      state.adx = adx;
      state.ady = ady;
    }
    state.slideHit = (flags & PLAYER_FLAG.SLIDE_HIT) !== 0;

    state.stamina = mine && Math.abs(mine.stamina - sp.stamina) <= SMALL_TOL ? mine.stamina : f(sp.stamina);
    state.exhausted = (flags & PLAYER_FLAG.EXHAUSTED) !== 0;
    state.sprinting = (flags & PLAYER_FLAG.SPRINTING) !== 0;
    state.charging = (flags & PLAYER_FLAG.CHARGING) !== 0;
    state.charge = mine && Math.abs(mine.charge - sp.charge) <= SMALL_TOL ? mine.charge : f(sp.charge);
    state.tackleCd = mine && Math.abs(mine.tackleCd - sp.cd) <= SMALL_TOL ? mine.tackleCd : f(sp.cd);

    // Not in the snapshot. Sprinting and dashing reset the regeneration delay to its full value
    // and a dash starts the immunity, so those moments are exact; otherwise trust the prediction.
    if (state.sprinting) state.regenDelay = f(pt.regenDelay);
    else if (mine) state.regenDelay = mine.regenDelay;
    else if (sp.action === ACTION.DASH) state.regenDelay = f(Math.max(0, pt.regenDelay - (tk.dashTime - sp.actionT)));
    else state.regenDelay = 0;

    if ((flags & PLAYER_FLAG.IMMUNE) === 0) state.immune = 0;
    else if (mine && mine.immune > 0) state.immune = mine.immune;
    else if (sp.action === ACTION.DASH) state.immune = f(Math.max(0, tk.dashImmune - (tk.dashTime - sp.actionT)));
    else state.immune = f(2 * TICK_SECONDS);

    state.kickCd = mine ? mine.kickCd : 0;
    state.stealLockout = mine ? mine.stealLockout : 0;
  }

  function hasBallFor(snap, seq) {
    return snap.ball.owner === me && !(kickSeq > 0 && seq > kickSeq);
  }

  /** Replays every pending input after `fromSeq` on `cur`; `prev` ends up one input behind. */
  function replay(snap, fromSeq) {
    const n = pending.length;
    let stepped = false;
    for (let i = 0; i < n; i++) {
      const rec = pending[i];
      if (rec.s <= fromSeq) continue;
      if (i === n - 1) {
        copyPlayerState(cur, prev);
        stepped = true;
      }
      phaseMode(snap, i + 1, env, mode);
      if (mode.kind !== MODE.NONE) {
        stepMotion(cur, decodeInput(rec, input), hasBallFor(snap, rec.s), mode.kind === MODE.FROZEN, mode.dt, env.tuning, env.pitch, result);
      }
      remember(rec.s);
    }
    if (!stepped) copyPlayerState(cur, prev);
  }

  /** The hand-over target is still AI-driven until the server applies my pass: let it run on. */
  function coastUntilHandover(state) {
    let n = 0;
    for (let i = 0; i < pending.length; i++) {
      if (pending[i].s <= handover.seq) n++;
    }
    if (n === 0) return;
    const t = n * env.dt;
    clampCircle(env.pitch, state.x + state.vx * t, state.y + state.vy * t, env.tuning.player.radius, clampOut);
    state.x = clampOut.x;
    state.y = clampOut.y;
  }

  return {
    /** New match: take its tuning and which human I am (-1 = spectator). */
    configure(init, myHumanId) {
      env = makePredictEnv(init);
      humanId = myHumanId;
      this.reset();
    },

    /** Forget every unacknowledged input and the predicted state (new match, re-join). */
    reset() {
      pending.length = 0;
      lastAck = 0;
      me = -1;
      valid = false;
      kickSeq = 0;
      handover = null;
      for (const h of history) h.seq = -1;
    },

    get env() { return env; },
    /** Newest of my inputs the server has applied (0 = none yet). */
    get ack() { return lastAck; },
    /** Footballer my inputs drive as far as the prediction knows, -1 = none. */
    get me() { return me; },
    /** True while prev / cur hold a prediction for `me`. */
    get valid() { return valid; },
    get cur() { return cur; },
    get prev() { return prev; },
    get pendingCount() { return pending.length; },
    get lastSentSeq() { return lastSentSeq; },
    /** True between my predicted kick and the server applying that input. */
    get kicked() { return kickSeq > 0; },
    get handover() { return handover; },

    /** True when, as far as the prediction knows, my footballer has the ball right now. */
    ownsBall(snap) {
      return valid && me >= 0 && snap.ball.owner === me && kickSeq === 0;
    },

    /**
     * Records an input that has just been sent and, when `active`, predicts it.
     * @returns {?{events:number, releasedCharge:number, kind:number}} null when nothing was predicted
     */
    push(rec, snap, active) {
      pending.push(rec);
      if (pending.length > CONFIG.input.maxPending) pending.shift();
      lastSentSeq = rec.s;
      if (!active || !valid || !snap || !env) return null;

      copyPlayerState(cur, prev);
      phaseMode(snap, pending.length, env, mode);
      pushed.events = 0;
      pushed.releasedCharge = 0;
      pushed.kind = mode.kind;
      if (mode.kind !== MODE.NONE) {
        stepMotion(cur, decodeInput(rec, input), hasBallFor(snap, rec.s), mode.kind === MODE.FROZEN, mode.dt, env.tuning, env.pitch, result);
        pushed.events = result.events;
        pushed.releasedCharge = result.releasedCharge;
      }
      remember(rec.s);
      return pushed;
    },

    /** My footballer has (predictedly) struck the ball with input `seq`. */
    markKick(seq) {
      kickSeq = seq;
    },

    /** The predicted strike is off (never confirmed): the ball is mine again if the server says so. */
    clearKick() {
      kickSeq = 0;
    },

    /**
     * Predicts the control switch that follows my pass to an AI team-mate: from now on my inputs
     * drive `to`, seeded from the newest snapshot and moved on by the inputs still in flight.
     */
    handOver(seq, to, snap, now) {
      if (!env || !snap || to < 0 || to >= snap.players.length) return false;
      handover = { seq, from: me, to, time: now };
      me = to;
      seed(cur, snap, to, 0);
      coastUntilHandover(cur);
      copyPlayerState(cur, prev);
      valid = true;
      return true;
    },

    /**
     * Re-bases the prediction on a snapshot.
     * @param snap    newest snapshot
     * @param active  false = only bookkeeping (acks, control), nothing is predicted
     * @param now     wall seconds, for timing out a predicted hand-over
     * @param alpha   0..1 position between prev and cur at which my footballer was last drawn
     * @returns {{me:number, exact:boolean, dx:number, dy:number}} dx, dy = how far the pose at
     *          `alpha` moved because of the correction (old minus new), valid when `exact`
     */
    reconcile(snap, active, now, alpha) {
      info.exact = false;
      info.dx = 0;
      info.dy = 0;
      if (!env || !snap) {
        me = -1;
        valid = false;
        info.me = -1;
        return info;
      }

      const ackRaw = humanId >= 0 && snap.acks ? snap.acks[humanId] | 0 : 0;
      // 0 = nothing applied since the server last reset my queue; a number I never sent is stale.
      const ack = ackRaw > 0 && ackRaw <= lastSentSeq ? ackRaw : 0;
      if (ack > 0) {
        let drop = 0;
        while (drop < pending.length && pending[drop].s <= ack) drop++;
        if (drop > 0) pending.splice(0, drop);
        if (kickSeq > 0 && ack >= kickSeq) kickSeq = 0;
        if (ack > lastAck) lastAck = ack;
      }

      let serverMine = -1;
      if (humanId >= 0) {
        for (let i = 0; i < snap.players.length; i++) {
          if (snap.players[i].ctrl === humanId) {
            serverMine = i;
            break;
          }
        }
      }

      if (handover) {
        const decided = ack > 0 && ack >= handover.seq;
        const moved = serverMine !== handover.from;
        const stale = now - handover.time > CONFIG.predict.switchTimeout;
        if (decided || moved || stale) handover = null;
      }

      const next = handover ? handover.to : serverMine;
      const same = valid && next === me;
      let oldX = 0;
      let oldY = 0;
      if (same) {
        oldX = lerp(prev.x, cur.x, alpha);
        oldY = lerp(prev.y, cur.y, alpha);
      }

      me = next;
      info.me = me;
      if (!active || me < 0 || me >= snap.players.length) {
        valid = false;
        return info;
      }

      if (handover) {
        seed(cur, snap, me, 0);
        coastUntilHandover(cur);
        replay(snap, handover.seq);
      } else {
        seed(cur, snap, me, ack);
        replay(snap, ack);
      }
      valid = true;

      if (same) {
        info.exact = true;
        info.dx = oldX - lerp(prev.x, cur.x, alpha);
        info.dy = oldY - lerp(prev.y, cur.y, alpha);
      }
      return info;
    },
  };
}
