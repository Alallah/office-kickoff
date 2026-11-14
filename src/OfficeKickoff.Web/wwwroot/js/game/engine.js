// The frame pipeline of the match page, free of DOM and network so it can be run headless:
//
//   snapshots in  ->  server clock + interpolation (state.js)
//   controls in   ->  60 Hz input ticks, prediction and reconciliation (predict.js)
//                 ->  the ball at my feet, the ghost ball, convergence on the server ball
//                 ->  goal replays (replay.js), camera (camera.js)
//   out           ->  one FrameView per frame, events exactly once, inputs to send
//
// main.js feeds it (snapshots, wall time, viewport, cursor) and hands its output to the
// renderer, the audio engine and the HUD. See types.js for the FrameView contract.

import { ACTION, EVT, KEY, PHASE, PLAYER_FLAG, TICK_RATE, TICK_SECONDS, decodeSnap } from '../shared/protocol.js';
import { CONFIG } from './config.js';
import { aimDirection, carriedBallPos, copyBall, findPassTarget, launchPass, launchShot, newBall, stepFreeBall } from './ballphys.js';
import { createCamera, screenToWorld } from './camera.js';
import { clamp, fade, lerp, lerpAngle, moveAngleTowards } from './geom.js';
import { MODE, MOTION, createPredictor, isPredictedPhase } from './predict.js';
import { createReplay, findReplayWindow, planReplay } from './replay.js';
import { createTimeline, newWorld } from './state.js';

/** Where the drawn ball comes from. */
const BALL = Object.freeze({
  INTERP: 0,   // the server ball, interpolated at render time
  CARRIED: 1,  // attached to my drawn footballer
  GHOST: 2,    // my own kick, simulated locally until the server's kick is known
  LED: 3,      // the server ball, drawn ahead of render time by a lead that decays to zero
});

const RESET = Object.freeze({ reset: true });
const ORIGIN = Object.freeze({ x: 0, y: 0 });

function round1(v) {
  return Math.round(v * 10) / 10;
}

function isBallTouch(evt) {
  switch (evt.type) {
    case EVT.TRAP:
    case EVT.STEAL:
    case EVT.DEFLECT:
    case EVT.KEEPER_CATCH:
    case EVT.KEEPER_PARRY:
    case EVT.BLOCK:
    case EVT.KICK:
    case EVT.PASS:
      return true;
    case EVT.TACKLE_HIT:
      return evt.f === 1;
    default:
      return false;
  }
}

/**
 * @param io.input     (dto) => void          send one InputDto ({ s, mx, my, ax, ay, k }) to the hub
 * @param io.event     (evt, view, toHud) => void   deliver one game event; toHud is false for replayed events
 * @param io.reset     () => void             everything teleported: drop transient effects
 * @param io.controls  createControls() from input.js (sampled once per input tick)
 */
export function createEngine(io) {
  const timeline = createTimeline();
  const predictor = createPredictor();
  const camera = createCamera();
  const replay = createReplay();
  const controls = io.controls;

  // ---- match ---------------------------------------------------------------------------------
  let init = null;
  let room = null;
  let memberId = 0;
  let env = null;
  let humanId = -1;
  let myTeam = -1;
  let myHuman = null;
  const humanById = [null, null, null, null];
  let count = 0;
  let matchSetAt = 0;

  // ---- connection ----------------------------------------------------------------------------
  let status = 'connected';
  let ping = -1;
  let results = false;
  let autoSwitch = true;

  // ---- time ----------------------------------------------------------------------------------
  let lastNow = -1;
  let acc = 0;
  /** Input sequence number: starts at 1 on page load and never resets. */
  let seq = 0;
  let wasSending = false;

  // ---- prediction ----------------------------------------------------------------------------
  let reconciledTick = -1;
  let wanted = false;
  let predicting = false;
  let aimX = 0;
  let aimY = 0;
  let cameraPrimed = false;

  // Per footballer: a visual offset on top of the pose it is drawn from (predicted for mine,
  // interpolated for the rest), so corrections and control switches blend instead of jumping.
  let offX = [];
  let offY = [];
  let offTime = [];
  let drawnX = [];
  let drawnY = [];
  let wasPredicted = [];
  let drawnValid = false;

  // ---- ball ----------------------------------------------------------------------------------
  /**
   * My own strike while it is ahead of the server: { kind (EVT.KICK / EVT.PASS), seq, kicker,
   * launched (wall time), led (the server's strike is known: draw its ball, led in time),
   * kickTick, kickTime, seenAt (wall time the server's strike reached the screen), lead0,
   * shown, touched }.
   */
  let ghost = null;
  const ghostCur = newBall();
  const ghostPrev = newBall();
  let dribOwner = -1;
  let dribCur = 0;
  let dribPrev = 0;
  let ballMode = BALL.INTERP;
  let ballBlend = 0;
  let ballOffX = 0;
  let ballOffY = 0;
  let ballOffTime = 0;
  let ballX = 0;
  let ballY = 0;
  let ballValid = false;

  // ---- events --------------------------------------------------------------------------------
  /** This frame's deliveries, in order: { evt, hud } or RESET. */
  const queue = [];
  /** My predicted events whose server copies are still to come: { type, a, time }. */
  const predicted = [];
  let replayTried = false;
  let frameNow = 0;
  let frameRender = 0;

  const live = newWorld();
  const past = newWorld();
  const sampled = { mx: 0, my: 0, k: 0 };
  const tmp = { x: 0, y: 0 };
  const dir = { x: 0, y: 0 };
  const led = { x: 0, y: 0, vx: 0, vy: 0, spin: 0, owner: -1, heat: 0, held: false, dead: false };
  const vp = { w: 1, h: 1 };
  const pan = { x: 0, y: 0 };

  function pushReset() {
    if (queue.length && queue[queue.length - 1] === RESET) return;
    queue.push(RESET);
  }

  /** Everything teleports (kickoff, replay start / end, resynchronisation): no blending across it. */
  function cut() {
    camera.snap();
    drawnValid = false;
    ballValid = false;
    ballOffX = 0;
    ballOffY = 0;
    for (let i = 0; i < count; i++) {
      offX[i] = 0;
      offY[i] = 0;
    }
  }

  function dropGhost(blend) {
    if (!ghost) return;
    ghost = null;
    ballBlend = blend;
  }

  /** The predicted strike turned out wrong: the ball is wherever the server says. */
  function cancelGhost() {
    if (!ghost) return;
    dropGhost(CONFIG.ball.ghostFallbackTime);
    predictor.clearKick();
  }

  function predictEvent(type, a, b, x, y, v, f) {
    const evt = { type, a, b, x, y, v, f, tick: Math.round(frameRender * TICK_RATE), predicted: true };
    queue.push({ evt, hud: true });
    predicted.push({ type, a, time: frameNow });
  }

  /**
   * How long the server's copy of a predicted event may take to reach the screen: the round trip
   * plus the interpolation delay. On a slow link that is more than the nominal window.
   */
  function eventWindow() {
    const rtt = ping > 0 ? ping / 1000 : 0;
    return Math.max(CONFIG.predict.eventMatchWindow, rtt + timeline.delay + CONFIG.predict.eventMatchMargin);
  }

  /** True when this server event is the copy of something already shown at the key press. */
  function takePredicted(evt) {
    const window = eventWindow();
    for (let i = 0; i < predicted.length; i++) {
      const p = predicted[i];
      // The footballer is the one that acted, not whichever is mine by now.
      if (p.type !== evt.type || p.a !== evt.a) continue;
      if (evt.type === EVT.SWITCH && evt.f !== humanId) continue;
      if (frameNow - p.time > window) continue;
      predicted.splice(i, 1);
      return true;
    }
    return false;
  }

  function visitLive(evt) {
    if (ghost && ghost.led && isBallTouch(evt)) {
      // Touches before my own strike reaches the screen are history; any after it mean the ball
      // is somebody else's business now.
      if (!ghost.shown && evt.type === ghost.kind && evt.a === ghost.kicker && evt.tick >= ghost.kickTick) ghost.shown = true;
      else if (ghost.shown) ghost.touched = true;
    }
    if (takePredicted(evt)) return;
    if (evt.type === EVT.PHASE_CHANGE && evt.f === PHASE.KICKOFF) {
      pushReset();
      cut();
    }
    queue.push({ evt, hud: true });
  }

  function visitReplay(evt) {
    queue.push({ evt: { type: evt.type, a: evt.a, b: evt.b, x: evt.x, y: evt.y, v: evt.v, f: evt.f, tick: evt.tick, replay: true }, hud: false });
  }

  // ---------------------------------------------------------------------------------------------
  //  Prediction
  // ---------------------------------------------------------------------------------------------

  function ghostTimeout() {
    const rtt = ping > 0 ? ping / 1000 : 0;
    return Math.max(CONFIG.ball.ghostTimeout, rtt + timeline.delay + CONFIG.ball.ghostTimeoutMargin);
  }

  function reconcile(latest, want, now) {
    const info = predictor.reconcile(latest, want, now, acc / TICK_SECONDS);
    reconciledTick = latest.tick;
    const me = info.me;
    if (info.exact && me >= 0 && me < count && (info.dx !== 0 || info.dy !== 0)) {
      // Same footballer, corrected by the server (usually a collision): keep it where it was drawn.
      const ox = offX[me] + info.dx;
      const oy = offY[me] + info.dy;
      if (ox * ox + oy * oy > CONFIG.predict.snapDistance * CONFIG.predict.snapDistance) {
        offX[me] = 0;
        offY[me] = 0;
      } else {
        offX[me] = ox;
        offY[me] = oy;
        offTime[me] = CONFIG.predict.correctionTime;
      }
    }

    if (ghost && !ghost.led) {
      const kind = ghost.kind;
      const kicker = ghost.kicker;
      const kick = timeline.findEventSince(ghost.launched, (e) => e.type === kind && e.a === kicker);
      if (kick) {
        // The server struck the ball too: from here on the real ball is drawn, ahead of render time.
        ghost.led = true;
        ghost.kickTick = kick.tick;
        ghost.kickTime = kick.tick / TICK_RATE;
      } else if (predictor.ack >= ghost.seq) {
        // The server applied that input and did not kick (robbed or stunned first).
        cancelGhost();
      }
    }

    // The ball at my feet: its angle around me is seeded once from the server, then follows my aim.
    if (want && predictor.ownsBall(latest)) {
      if (dribOwner !== me) {
        const o = latest.players[me];
        const seed = Math.atan2(latest.ball.y - o.y, latest.ball.x - o.x);
        const turned = predictor.pendingCount * env.dt * env.tuning.ball.dribbleTurnRate;
        dribCur = latest.phase === PHASE.PLAYING ? moveAngleTowards(seed, predictor.cur.aim, turned) : seed;
        dribPrev = dribCur;
        dribOwner = me;
      }
    } else {
      dribOwner = -1;
    }
  }

  function sendNeutral() {
    const rec = { s: ++seq, mx: 0, my: 0, ax: aimX, ay: aimY, k: 0 };
    io.input(rec);
    predictor.push(rec, timeline.latest, false);
  }

  function strike(rec, res, latest) {
    const me = predictor.me;
    const p = predictor.cur;
    const t = env.tuning;
    if (latest.phase !== PHASE.PLAYING || ghost || latest.ball.held || latest.ball.dead || !predictor.ownsBall(latest)) return;

    if (res.events & MOTION.SHOT_RELEASED) {
      launchShot(ghostCur, p, rec.ax, rec.ay, res.releasedCharge, t, env.pitch, env.ballSpeed);
      predictEvent(EVT.KICK, me, -1, ghostCur.x, ghostCur.y, res.releasedCharge, 0);
    } else if (rec.k & KEY.PASS) {
      aimDirection(p.x, p.y, rec.ax, rec.ay, p.aim, dir);
      const target = findPassTarget(latest.players, init.players, me, p.x, p.y, dir.x, dir.y, t.kick);
      const v0 = launchPass(ghostCur, p, rec.ax, rec.ay, target >= 0 ? latest.players[target] : null, t, env.pitch, env.ballSpeed);
      predictEvent(EVT.PASS, me, target, ghostCur.x, ghostCur.y, v0 / t.kick.passMaxSpeed, 0);
      // A pass to an AI outfield team-mate hands me that footballer at once.
      if (target >= 0 && latest.players[target].ctrl === -1 && !init.players[target].keeper) {
        const tp = latest.players[target];
        if (predictor.handOver(rec.s, target, latest, frameNow)) predictEvent(EVT.SWITCH, target, me, tp.x, tp.y, 0, humanId);
      }
    } else {
      return;
    }

    ghost = {
      kind: res.events & MOTION.SHOT_RELEASED ? EVT.KICK : EVT.PASS,
      seq: rec.s,
      kicker: me,
      launched: frameNow,
      led: false,
      kickTick: -1,
      kickTime: -1,
      seenAt: -1,
      lead0: 0,
      shown: false,
      touched: false,
    };
    copyBall(ghostCur, ghostPrev);
    predictor.markKick(rec.s);
    dribOwner = -1;
  }

  function tick(captured) {
    if (captured) {
      controls.clear();
      sampled.mx = 0;
      sampled.my = 0;
      sampled.k = 0;
    } else {
      controls.sample(sampled);
    }
    const rec = { s: ++seq, mx: sampled.mx, my: sampled.my, ax: aimX, ay: aimY, k: sampled.k };
    io.input(rec);

    const latest = timeline.latest;
    const res = predictor.push(rec, latest, predicting);
    if (!res || !latest) return;

    if (res.kind === MODE.PLAY) {
      const me = predictor.me;
      const p = predictor.cur;
      if (res.events & MOTION.SLIDE_STARTED) predictEvent(EVT.SLIDE_START, me, -1, p.x, p.y, 0, 0);
      if (res.events & MOTION.DASH_STARTED) predictEvent(EVT.DASH, me, -1, p.x, p.y, 0, 0);
      if ((res.events & MOTION.SHOT_RELEASED) || (rec.k & KEY.PASS)) strike(rec, res, latest);

      if (dribOwner >= 0 && dribOwner === predictor.me) {
        dribPrev = dribCur;
        dribCur = moveAngleTowards(dribCur, predictor.cur.aim, env.tuning.ball.dribbleTurnRate * env.dt);
      }
    } else {
      dribPrev = dribCur;
    }

    if (ghost && !ghost.led) {
      copyBall(ghostCur, ghostPrev);
      stepFreeBall(ghostCur, env.dt, env.tuning, env.pitch);
    }
  }

  // ---------------------------------------------------------------------------------------------
  //  Frame view
  // ---------------------------------------------------------------------------------------------

  function flagsOf(p) {
    return (p.charging ? PLAYER_FLAG.CHARGING : 0)
      | (p.exhausted ? PLAYER_FLAG.EXHAUSTED : 0)
      | (p.sprinting ? PLAYER_FLAG.SPRINTING : 0)
      | (p.slideHit ? PLAYER_FLAG.SLIDE_HIT : 0)
      | (p.immune > 0 ? PLAYER_FLAG.IMMUNE : 0);
  }

  /**
   * Exponential decay of a footballer's visual offset, but never faster than a footballer could
   * plausibly move: on a slow link a collision correction can be tens of units, and removing half
   * of that in one frame reads as a teleport.
   */
  function decayOffset(i, dt) {
    const ox = offX[i];
    const oy = offY[i];
    const len = Math.sqrt(ox * ox + oy * oy);
    if (len === 0) return;
    let next = len * fade(dt, offTime[i]);
    const floor = len - CONFIG.predict.maxCorrectionSpeed * dt;
    if (next < floor) next = floor;
    const k = next / len;
    offX[i] = ox * k;
    offY[i] = oy * k;
  }

  function buildPlayers(shown, inReplay, alpha, dt) {
    const players = new Array(count);
    const mine = inReplay ? -1 : predictor.me;
    for (let i = 0; i < count; i++) {
      const info = init.players[i];
      const src = shown.players[i];
      const predictedNow = !inReplay && predicting && i === mine;
      let x = src.x;
      let y = src.y;
      let vx = src.vx;
      let vy = src.vy;
      let aim = src.aim;
      let action = src.action;
      let actionT = src.actionT;
      let actionDir = src.actionDir;
      let stamina = src.stamina;
      let charge = src.charge;
      let cd = src.cd;
      let flags = src.flags;
      let ctrl = src.ctrl;

      if (predictedNow) {
        const c = predictor.cur;
        const pr = predictor.prev;
        x = lerp(pr.x, c.x, alpha);
        y = lerp(pr.y, c.y, alpha);
        vx = c.vx;
        vy = c.vy;
        action = c.action;
        actionT = Math.max(0, c.actionT);
        actionDir = Math.atan2(c.ady, c.adx);
        stamina = c.stamina;
        charge = c.charge;
        cd = c.tackleCd;
        flags = flagsOf(c);
      }

      if (inReplay) {
        // A replay is the buffer as it was: no offsets, no prediction.
      } else {
        // The offset decays first; a change of source re-anchors it on where this footballer
        // was drawn last frame.
        decayOffset(i, dt);
        if (Math.abs(offX[i]) < 0.02 && Math.abs(offY[i]) < 0.02) {
          offX[i] = 0;
          offY[i] = 0;
        }
        if (drawnValid && predictedNow !== wasPredicted[i]) {
          const ox = drawnX[i] - x;
          const oy = drawnY[i] - y;
          if (ox * ox + oy * oy > CONFIG.predict.snapDistance * CONFIG.predict.snapDistance) {
            offX[i] = 0;
            offY[i] = 0;
          } else {
            offX[i] = ox;
            offY[i] = oy;
            offTime[i] = predictedNow ? CONFIG.predict.gainTime : CONFIG.predict.releaseTime;
          }
        }
        x += offX[i];
        y += offY[i];
        drawnX[i] = x;
        drawnY[i] = y;
        wasPredicted[i] = predictedNow;

        if (humanId >= 0) {
          // My ring follows the newest snapshot (or my predicted switch), never an older one.
          if (i === mine) ctrl = humanId;
          else if (ctrl === humanId) ctrl = -1;
        }
      }

      if (predictedNow) {
        // Facing follows the cursor every frame, not every tick.
        const c = predictor.cur;
        const ax = aimX - x;
        const ay = aimY - y;
        if ((c.action === ACTION.NONE || c.action === ACTION.DASH) && ax * ax + ay * ay > 1) aim = Math.atan2(ay, ax);
        else aim = lerpAngle(predictor.prev.aim, c.aim, alpha);
      }

      players[i] = {
        i,
        team: info.team,
        slot: info.slot,
        keeper: info.keeper,
        name: info.name,
        number: info.number,
        x, y, vx, vy,
        aim,
        action,
        actionT,
        actionDir,
        stamina,
        charge,
        cd,
        flags,
        ctrl,
        human: ctrl >= 0 && ctrl < humanById.length ? humanById[ctrl] : null,
        isMe: humanId >= 0 && ctrl === humanId,
        hasBall: false,
      };
    }
    if (!inReplay) drawnValid = true;
    return players;
  }

  function blendTimeFor(from, to) {
    if (ballBlend > 0) return ballBlend;
    if (to === BALL.CARRIED) return CONFIG.ball.attachTime;
    if (from === BALL.CARRIED && to === BALL.INTERP) return CONFIG.ball.detachTime;
    if (from === BALL.GHOST && to === BALL.LED) return CONFIG.ball.handoverTime;
    return 0;
  }

  /** The live ball as drawn this frame; fills `out` and returns the mode it came from. */
  function buildLiveBall(world, latest, players, now, renderTime, alpha, dt, out) {
    const wb = world.ball;
    out.x = wb.x;
    out.y = wb.y;
    out.vx = wb.vx;
    out.vy = wb.vy;
    out.spin = wb.spin;
    out.owner = wb.owner;
    out.heat = wb.heat;
    out.held = wb.held;
    out.dead = wb.dead;

    const me = predictor.me;
    if (ghost && !predicting) cancelGhost();
    if (ghost && !ghost.led && now - ghost.launched > ghostTimeout()) cancelGhost();

    let mode = BALL.INTERP;
    if (ghost && ghost.led) {
      let lead;
      if (renderTime < ghost.kickTime) {
        // The server's kick is known but not on screen yet: keep the ball where the ghost would be.
        lead = ghost.kickTime + (now - ghost.launched) - renderTime;
        ghost.lead0 = clamp(lead, 0, CONFIG.ball.maxLead);
      } else {
        if (ghost.seenAt < 0) {
          ghost.seenAt = now;
          if (!(ghost.lead0 > 0)) ghost.lead0 = clamp(now - ghost.launched - (renderTime - ghost.kickTime), 0, CONFIG.ball.maxLead);
        }
        // Converge in time, not position: the lead shrinks linearly, the ball never hangs.
        lead = ghost.lead0 * (1 - (now - ghost.seenAt) / CONFIG.ball.leadDecayTime);
        if (ghost.touched || wb.dead || wb.owner >= 0) {
          // Someone else has it, or it is in the net: no more leading.
          dropGhost(CONFIG.ball.leadDropTime);
          lead = 0;
        } else if (lead <= 0) {
          dropGhost(0);
        }
      }
      if (ghost) {
        lead = clamp(lead, 0, CONFIG.ball.maxLead);
        if (timeline.ballAt(renderTime + lead, CONFIG.ball.maxLead, led)) {
          mode = BALL.LED;
          out.x = led.x;
          out.y = led.y;
          out.vx = led.vx;
          out.vy = led.vy;
          out.spin = led.spin;
          out.owner = led.owner;
          out.heat = led.heat;
          out.held = led.held;
          out.dead = led.dead;
        }
      }
    } else if (ghost) {
      mode = BALL.GHOST;
      out.x = lerp(ghostPrev.x, ghostCur.x, alpha);
      out.y = lerp(ghostPrev.y, ghostCur.y, alpha);
      out.vx = ghostCur.vx;
      out.vy = ghostCur.vy;
      out.spin = ghostCur.spin;
      out.owner = -1;
      out.heat = ghostCur.heat;
      out.held = false;
      out.dead = false;
    }

    if (mode !== BALL.GHOST && predicting && me >= 0 && dribOwner === me && predictor.ownsBall(latest)) {
      // Mine: attached to the footballer as drawn, by the carried-ball rule.
      if (ghost) dropGhost(0);
      const c = predictor.cur;
      const pv = players[me];
      carriedBallPos(pv.x, pv.y, lerpAngle(dribPrev, dribCur, alpha), c.sprinting, c.action === ACTION.DASH, myTeam, env.tuning, env.pitch, tmp);
      mode = BALL.CARRIED;
      out.x = tmp.x;
      out.y = tmp.y;
      out.vx = c.vx;
      out.vy = c.vy;
      out.spin = 0;
      out.owner = me;
      out.heat = latest.ball.heat;
      out.held = false;
      out.dead = false;
    } else if (humanId >= 0 && me >= 0 && out.owner === me && latest.ball.owner !== me) {
      // An older snapshot still shows the ball at my feet; the newest knows better.
      out.owner = -1;
      out.held = false;
    }

    // Blend across a change of source so the ball never pops.
    const k = fade(dt, ballOffTime);
    ballOffX *= k;
    ballOffY *= k;
    if (ballValid && mode !== ballMode) {
      const time = blendTimeFor(ballMode, mode);
      if (time > 0) {
        const ox = ballX - out.x;
        const oy = ballY - out.y;
        if (ox * ox + oy * oy > CONFIG.ball.snapDistance * CONFIG.ball.snapDistance) {
          ballOffX = 0;
          ballOffY = 0;
        } else {
          ballOffX = ox;
          ballOffY = oy;
          ballOffTime = time;
        }
      } else if (mode === BALL.GHOST) {
        // A kick leaves the foot at once.
        ballOffX = 0;
        ballOffY = 0;
      }
    }
    ballBlend = 0;
    out.x += ballOffX;
    out.y += ballOffY;
    ballX = out.x;
    ballY = out.y;
    ballMode = mode;
    ballValid = true;
    return mode;
  }

  function connectionNow(now, latest) {
    if (status !== 'connected') return status;
    const running = !results && (!room || room.phase === 'match') && !(latest && latest.phase === PHASE.ENDED);
    if (running && now - Math.max(timeline.lastArrival, matchSetAt) > CONFIG.net.staleAfter) return 'reconnecting';
    return 'connected';
  }

  function meOf(playerIndex, players) {
    return {
      humanId,
      memberId,
      team: myTeam,
      spectator: humanId < 0,
      playerIndex,
      player: playerIndex >= 0 && playerIndex < players.length ? players[playerIndex] : null,
      autoSwitch,
    };
  }

  function updateCamera(dt, o, meView, ballView, spectator) {
    let panX = 0;
    let panY = 0;
    let dragX = 0;
    let dragY = 0;
    let wheel = 0;
    if (spectator) {
      if (!o.captured) {
        controls.axis(pan);
        panX = pan.x;
        panY = pan.y;
      }
      dragX = o.dragX || 0;
      dragY = o.dragY || 0;
      wheel = o.wheel || 0;
    }
    if (controls.takeFollowToggle() && spectator && !o.captured) camera.toggleFollow();
    camera.update(dt, {
      pitch: env.pitch,
      viewport: vp,
      me: meView,
      ball: ballView,
      mouse: !spectator && o.mouse && o.mouse.known ? o.mouse : null,
      spectator,
      panX,
      panY,
      dragX,
      dragY,
      wheel,
    });
  }

  function flush(view) {
    for (let i = 0; i < queue.length; i++) {
      const item = queue[i];
      if (item === RESET) io.reset();
      else io.event(item.evt, view, item.hud);
    }
    queue.length = 0;
  }

  /** Nothing has arrived yet: an empty pitch, so the HUD can at least show the connection state. */
  function placeholder(now, dt, o) {
    const spectator = humanId < 0;
    const ball = { x: 0, y: 0, vx: 0, vy: 0, speed: 0, spin: 0, owner: -1, heat: 0, held: false, dead: false };
    // The camera runs from the first frame: the cursor is turned into an aim point through it.
    updateCamera(dt, o, null, ball, spectator);
    if (now - matchSetAt < CONFIG.net.placeholderAfter) return null;
    const players = [];
    const ended = results || (room && room.phase === 'results');
    const view = {
      now,
      dt,
      time: 0,
      phase: ended ? PHASE.ENDED : PHASE.INTRO,
      phaseTime: 0,
      clock: 0,
      score: [0, 0],
      overtime: false,
      slowMo: false,
      ball,
      players,
      me: meOf(-1, players),
      aim: { x: aimX, y: aimY },
      passTarget: -1,
      camera: { x: camera.x, y: camera.y, zoom: camera.zoom },
      viewport: { w: vp.w, h: vp.h },
      replay: null,
      init,
      room,
      ping,
      connection: connectionNow(now, null),
    };
    flush(view);
    return view;
  }

  function resume() {
    timeline.resync();
    pushReset();
    cut();
    dropGhost(0);
    predictor.clearKick();
    predicted.length = 0;
    acc = 0;
    reconciledTick = -1;
    // A goal replay still running picks up again where the live phase timer says it is.
    if (replay.active) replay.end();
    replayTried = false;
  }

  return {
    timeline,
    predictor,
    camera,

    /** True once a match has been set. */
    get ready() { return init !== null; },
    get humanId() { return humanId; },
    get seq() { return seq; },

    /**
     * New match (boot, rematch, re-join into a different match): every piece of match state
     * starts over. The input sequence number is the one thing that keeps counting.
     */
    setMatch(newInit, newMemberId, now) {
      init = newInit;
      memberId = newMemberId;
      humanId = -1;
      myTeam = -1;
      myHuman = null;
      for (let i = 0; i < humanById.length; i++) humanById[i] = null;
      for (const h of init.humans || []) {
        if (h.humanId >= 0 && h.humanId < humanById.length) humanById[h.humanId] = h;
        if (h.memberId === memberId) myHuman = h;
      }
      if (myHuman) {
        humanId = myHuman.humanId;
        myTeam = myHuman.team;
      }

      predictor.configure(init, humanId);
      env = predictor.env;
      const rules = env.tuning.rules;
      timeline.configure({
        tuning: env.tuning,
        pitch: env.pitch,
        gameSpeed: env.gameSpeed,
        slowScale: env.slowScale,
        dt: env.dt,
        // The start of a replay's footage is at most this old when the replay ends.
        bufferSeconds: rules.replayFootage + Math.max(rules.goalCelebrationTime, rules.goalShortTime) + rules.replayTime + 1,
      });

      count = (init.players || []).length;
      offX = new Array(count).fill(0);
      offY = new Array(count).fill(0);
      offTime = new Array(count).fill(CONFIG.predict.correctionTime);
      drawnX = new Array(count).fill(0);
      drawnY = new Array(count).fill(0);
      wasPredicted = new Array(count).fill(false);

      results = false;
      ghost = null;
      dribOwner = -1;
      ballMode = BALL.INTERP;
      ballBlend = 0;
      queue.length = 0;
      predicted.length = 0;
      replay.end();
      replayTried = false;
      acc = 0;
      reconciledTick = -1;
      wanted = false;
      predicting = false;
      wasSending = false;
      matchSetAt = Number.isFinite(now) ? now : 0;
      cameraPrimed = false;
      cut();
    },

    /** Latest RoomStateDto. */
    setRoom(state) {
      room = state;
    },

    /** 'connected' | 'reconnecting' | 'disconnected' from the hub connection. */
    setStatus(s) {
      status = s;
    },

    setPing(ms) {
      ping = ms;
    },

    /** Results screen up: the match is over, stop sending inputs. */
    setResults(on) {
      results = on;
    },

    setAutoSwitch(on) {
      autoSwitch = on;
    },

    /** A raw wire snapshot arrived at wall time `now` (seconds). */
    onSnap(wire, now) {
      if (!init || !wire || !Array.isArray(wire.p) || !Array.isArray(wire.b)) return;
      timeline.push(decodeSnap(wire), now);
    },

    /**
     * The connection was re-established and the server has a fresh input queue for me: inputs
     * still in flight are gone, and whatever happened meanwhile is not replayed.
     */
    rejoin() {
      predictor.reset();
      resume();
    },

    /** The page was not rendering for a while (hidden tab): jump to the present. */
    resume,

    /**
     * The window lost focus or the tab was hidden: ONE neutral input goes out at once so my
     * footballer stops, then nothing until focus returns (the server hands it to the AI).
     */
    focusLost() {
      if (!wasSending) return;
      wasSending = false;
      sendNeutral();
    },

    /** Footballer a human currently controls (my own from the prediction), or -1. */
    footballerOf(hid) {
      if (hid < 0) return -1;
      if (hid === humanId) return predictor.me;
      const latest = timeline.latest;
      if (!latest) return -1;
      for (let i = 0; i < latest.players.length; i++) {
        if (latest.players[i].ctrl === hid) return i;
      }
      return -1;
    },

    /**
     * Runs one frame.
     * @param now  wall seconds (performance.now() / 1000)
     * @param o    { viewport:{w,h}, mouse:{x,y,known}, captured:boolean, focused:boolean,
     *               dragX:number, dragY:number, wheel:number }
     *             mouse = cursor in canvas CSS pixels; captured = the HUD has the keyboard;
     *             focused = window focused and tab visible; drag / wheel = spectator camera input
     * @returns {?object} the FrameView, or null while there is nothing to show yet
     */
    frame(now, o) {
      if (!init) return null;
      let raw = lastNow < 0 ? 0 : now - lastNow;
      if (!(raw >= 0)) raw = 0;
      lastNow = now;
      if (raw > CONFIG.net.resumeGap) {
        resume();
        raw = 0;
      }
      const dt = Math.min(raw, 0.1);
      vp.w = Math.max(1, o.viewport.w || 0);
      vp.h = Math.max(1, o.viewport.h || 0);
      frameNow = now;

      const renderTime = timeline.advance(now, Math.min(raw, 0.25));
      frameRender = renderTime;
      const latest = timeline.latest;
      const spectator = humanId < 0;

      const matchWindow = eventWindow();
      for (let i = predicted.length - 1; i >= 0; i--) {
        if (now - predicted[i].time > matchWindow) predicted.splice(i, 1);
      }

      if (!cameraPrimed) {
        // First frame of a match: frame the kickoff so the cursor already maps to the right place.
        cameraPrimed = true;
        updateCamera(0, o, null, ORIGIN, spectator);
        camera.snap();
      }

      // The aim point is the cursor in the world as it was last drawn.
      if (o.mouse && o.mouse.known && !o.captured) {
        screenToWorld(o.mouse.x, o.mouse.y, camera, vp, tmp);
        aimX = round1(tmp.x);
        aimY = round1(tmp.y);
      }

      // Input flow is presence: every tick while I am seated and at the controls, in every phase.
      const sending = !spectator && o.focused === true && !results && status === 'connected' && (!room || room.phase === 'match');
      if (wasSending && !sending && o.focused !== true) sendNeutral();
      wasSending = sending;

      // Until a kickoff teleport is on screen my footballer stays with the interpolated world.
      const want = sending && latest !== null && isPredictedPhase(latest.phase) && !timeline.teleportAfter(renderTime);
      if (latest && (latest.tick !== reconciledTick || want !== wanted)) reconcile(latest, want, now);
      wanted = want;
      predicting = want && predictor.valid;

      if (sending) {
        acc += dt;
        let ticks = 0;
        while (acc >= TICK_SECONDS && ticks < CONFIG.input.maxTicksPerFrame) {
          acc -= TICK_SECONDS;
          ticks++;
          tick(o.captured === true);
        }
        if (acc >= TICK_SECONDS) acc %= TICK_SECONDS;
      } else {
        acc = 0;
        if (o.captured) controls.clear();
      }
      const alpha = clamp(acc / TICK_SECONDS, 0, 1);

      const world = latest ? timeline.sample(renderTime, live) : null;
      if (!world) return placeholder(now, dt, o);

      // ---- events and replay -----------------------------------------------------------------
      const rules = env.tuning.rules;
      if (replay.active && world.phase !== PHASE.REPLAY) {
        replay.end();
        pushReset();
        cut();
      }
      timeline.drainEvents(renderTime, visitLive);
      if (world.phase === PHASE.REPLAY) {
        // Where the playback stands is a function of the live phase timer alone.
        const liveProgress = 1 - world.phaseTime / Math.max(0.1, rules.replayTime);
        if (!replay.active && !replayTried) {
          replayTried = true;
          const found = findReplayWindow(timeline, renderTime, rules);
          const plan = found ? planReplay(found, rules, env.slowScale) : null;
          if (plan) {
            replay.begin(plan, liveProgress);
            pushReset();
            cut();
          }
        }
        if (replay.active) {
          const at = replay.update(liveProgress);
          timeline.sample(at, past);
          timeline.eventsBetween(replay.previousTime, at, visitReplay);
        }
      } else {
        replayTried = false;
      }
      const inReplay = replay.active;
      const shown = inReplay ? past : world;

      // ---- footballers and ball --------------------------------------------------------------
      const players = buildPlayers(shown, inReplay, alpha, dt);
      const ball = { x: 0, y: 0, vx: 0, vy: 0, speed: 0, spin: 0, owner: -1, heat: 0, held: false, dead: false };
      let mode = BALL.INTERP;
      if (inReplay) {
        const sb = shown.ball;
        ball.x = sb.x;
        ball.y = sb.y;
        ball.vx = sb.vx;
        ball.vy = sb.vy;
        ball.spin = sb.spin;
        ball.owner = sb.owner;
        ball.heat = sb.heat;
        ball.held = sb.held;
        ball.dead = sb.dead;
        if (ghost) dropGhost(0);
      } else {
        mode = buildLiveBall(world, latest, players, now, renderTime, alpha, dt, ball);
      }
      ball.speed = Math.sqrt(ball.vx * ball.vx + ball.vy * ball.vy);
      if (ball.owner >= 0 && ball.owner < players.length) players[ball.owner].hasBall = true;

      let myIndex = -1;
      if (!spectator) {
        if (inReplay) {
          for (let i = 0; i < players.length; i++) {
            if (players[i].ctrl === humanId) {
              myIndex = i;
              break;
            }
          }
        } else {
          myIndex = predictor.me;
        }
      }
      const me = meOf(myIndex, players);

      // ---- camera, then the cursor through the camera this frame is drawn with ----------------
      updateCamera(dt, o, me.player, ball, spectator);
      const cam = { x: camera.x, y: camera.y, zoom: camera.zoom };
      const aim = { x: aimX, y: aimY };
      if (o.mouse && o.mouse.known && !o.captured) screenToWorld(o.mouse.x, o.mouse.y, cam, vp, aim);

      let passTarget = -1;
      if (mode === BALL.CARRIED && me.player && !latest.ball.held && (latest.phase === PHASE.PLAYING || latest.phase === PHASE.KICKOFF)) {
        const c = predictor.cur;
        aimDirection(c.x, c.y, aimX, aimY, c.aim, dir);
        passTarget = findPassTarget(latest.players, init.players, myIndex, c.x, c.y, dir.x, dir.y, env.tuning.kick);
      }

      const view = {
        now,
        dt,
        time: shown.time,
        phase: world.phase,
        phaseTime: world.phaseTime,
        clock: world.clock,
        score: world.score,
        overtime: world.overtime,
        slowMo: inReplay ? false : world.slowMo,
        ball,
        players,
        me,
        aim,
        passTarget,
        camera: cam,
        viewport: { w: vp.w, h: vp.h },
        replay: inReplay ? { progress: replay.progress } : null,
        init,
        room,
        ping,
        connection: connectionNow(now, latest),
      };
      flush(view);
      return view;
    },
  };
}
