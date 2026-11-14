// The sound of the match, synthesised entirely with the Web Audio API (there are no audio files).
// Contract: AudioEngine in ./types.js.
//
//   audio/params.js    pure mapping from events and the frame view to sound parameters (unit-tested)
//   audio/mixer.js     output graph, noise buffers, voice cap and clean-up
//   audio/sfx.js       in-world one-shots: ball, tackles, keeper
//   audio/stadium.js   crowd bed, roar / groan / "ooh", sounds from the stands
//   audio/signals.js   whistles, stings, interface sounds, charge tone
//
// Nothing here may ever throw: every public method is guarded, and until an AudioContext exists
// and is running (browsers hold it suspended until the first user gesture) everything is a no-op.

import { PHASE, PLAYER_FLAG } from '../shared/protocol.js';
import {
  RULES, SLOWMO_RATE, approach, chantSyllables, clamp, clamp01, clapTimes, createLimiter, crowdTarget,
  describeEvent, excitementFor, matchConstants, num, oohFor, planLength, spatial, standGap, standPick,
  stingNotes, whistlePlan,
} from './audio/params.js';
import { createMixer } from './audio/mixer.js';
import { SFX } from './audio/sfx.js';
import { chant, claps, createCrowd, fanWhistle, groan, ooh, roar } from './audio/stadium.js';
import { UI_GAPS, createCharge, impact, pant, sting, switchBlip, uiSound, whistle } from './audio/signals.js';

/** Headroom under full volume so layered sounds reach the limiter gently. */
const MASTER_TRIM = 0.55;
const MAX_EXCITEMENT = 1.5;

/** @returns {import('./types.js').AudioEngine} */
export function createAudio() {
  /** @type {?AudioContext} */
  let ctx = null;
  let mix = null;
  let crowd = null;
  let charge = null;
  let unavailable = false;
  let attempts = 0;

  let volume = 0.7;
  let muted = false;

  let matchInit = null;
  let consts = matchConstants(null);
  const limiter = createLimiter();

  // Per-match state, cleared by setMatch.
  let excitement = 0;
  let standAt = -1;
  let crowdAt = -1;
  let sweptAt = 0;
  let breathIndex = -1;
  let wasEmpty = false;

  const isHidden = () => typeof document !== 'undefined' && document.hidden === true;
  const running = () => mix !== null && ctx.state === 'running';
  const quiet = (promise) => {
    if (promise && typeof promise.catch === 'function') promise.catch(() => {});
  };

  // A failure costs that one sound, never the frame. The first one is logged so it can be
  // diagnosed; after that the engine stays quiet about it rather than flooding the console.
  let reported = false;
  function report(err) {
    if (reported) return;
    reported = true;
    try {
      console.warn('[audio] a sound was skipped after an error:', err);
    } catch {
      /* no console */
    }
  }

  function applyMaster() {
    if (mix) mix.setMaster(muted ? 0 : volume * volume * MASTER_TRIM);
  }

  function create() {
    const Ctor = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (typeof Ctor !== 'function') {
      unavailable = true;
      return;
    }
    let made = null;
    try {
      made = new Ctor({ latencyHint: 'interactive' });
      const mixer = createMixer(made);
      crowd = createCrowd(mixer);
      charge = createCharge(mixer);
      ctx = made;
      mix = mixer;
      applyMaster();
    } catch {
      crowd = null;
      charge = null;
      if (made) {
        try {
          quiet(made.close());
        } catch {
          /* nothing left to release */
        }
      }
      // A failure can be transient (too many contexts open); give up after a few tries.
      if (++attempts >= 3) unavailable = true;
    }
  }

  function unlock() {
    try {
      if (unavailable) return;
      if (!ctx) create();
      if (!ctx || ctx.state === 'closed') return;
      if (isHidden()) {
        if (ctx.state === 'running') quiet(ctx.suspend());
        return;
      }
      // Before the first gesture this resume() just stays pending; the call made from inside a
      // gesture is the one that starts the context, so keep asking until it runs.
      if (ctx.state !== 'running') quiet(ctx.resume());
    } catch (err) {
      report(err);
    }
  }

  function onVisibility() {
    try {
      if (!ctx) return;
      if (isHidden()) {
        // Drop what is sounding so nothing stale plays on return, then stop the clock.
        if (mix) {
          mix.killAll(0.02);
          charge.stop();
        }
        if (ctx.state === 'running') quiet(ctx.suspend());
      } else {
        unlock();
      }
    } catch (err) {
      report(err);
    }
  }

  if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
    document.addEventListener('visibilitychange', onVisibility);
  }

  function setVolume(value) {
    const v = Number(value);
    if (!Number.isFinite(v)) return;
    volume = clamp01(v);
    try {
      applyMaster();
    } catch (err) {
      report(err);
    }
  }

  function setMuted(value) {
    muted = value === true;
    try {
      applyMaster();
    } catch (err) {
      report(err);
    }
  }

  function setMatch(init) {
    try {
      matchInit = init ?? null;
      consts = matchConstants(init);
      excitement = 0;
      standAt = -1;
      crowdAt = -1;
      breathIndex = -1;
      wasEmpty = false;
      limiter.reset();
      if (mix) {
        // A rematch can start while the last match's final whistle and roar are still ringing.
        mix.killAll(0.04);
        charge.stop();
      }
    } catch (err) {
      report(err);
    }
  }

  const lift = (amount) => {
    excitement = Math.min(MAX_EXCITEMENT, excitement + amount);
  };

  function playGoal(d) {
    const pan = d.side * 0.25;
    if (d.replay) {
      // A reminder of the moment, short enough to be gone before the restart countdown.
      if (d.flavour === 'own') groan(mix, { size: 0.6, len: 1.4, pan, bus: 'replay' });
      else roar(mix, { size: 0.6, len: 1.6, pan, bus: 'replay' });
      impact(mix, 0.6, 'replay');
      return;
    }
    if (d.flavour === 'own') {
      groan(mix, { size: 1, len: 2.6, pan });
      impact(mix, 0.55, 'world');
      return;
    }
    const decider = d.flavour === 'decider';
    roar(mix, { size: decider ? 1.3 : d.forMe ? 1 : 0.82, len: decider ? 8 : 5.5, pan });
    if (decider) roar(mix, { size: 0.9, len: 6, pan: -pan, delay: 1.1 });
    impact(mix, decider ? 1.15 : 0.9, 'world');
    sting(mix, stingNotes(d.flavour, d.forMe), decider ? 1.1 : d.forMe ? 1 : 0.8, { delay: 0.05 });
  }

  function play(d, evt, view, now) {
    const place = spatial(evt.x, evt.y, view);
    switch (d.kind) {
      case 'goal':
        playGoal(d);
        break;
      case 'whistle': {
        const plan = whistlePlan(d.pattern);
        whistle(mix, plan);
        mix.duckBed(0.55, planLength(plan) + 0.15);
        break;
      }
      case 'overtime': {
        const plan = whistlePlan('overtime');
        whistle(mix, plan);
        sting(mix, stingNotes('overtime'), 0.8, { delay: planLength(plan) + 0.05 });
        mix.duckBed(0.55, planLength(plan) + 0.3);
        lift(0.4);
        break;
      }
      case 'switch':
        switchBlip(mix);
        break;
      default: {
        const recipe = SFX[d.kind];
        if (recipe) {
          recipe(mix, d, {
            gain: place.gain,
            pan: place.pan,
            bus: d.replay ? 'replay' : 'world',
            rate: !d.replay && view?.slowMo === true ? SLOWMO_RATE : 1,
          }, consts);
        }
      }
    }
    if (d.replay) return;
    const rule = RULES[d.kind];
    if (rule.duck) mix.duckBed(rule.duck[0], rule.duck[1]);
    else if (d.kind === 'kick' && d.fire) mix.duckBed(0.75, 0.15);
    const excite = excitementFor(d);
    if (excite > 0) lift(excite);
    const gasp = oohFor(d);
    if (gasp > 0 && limiter.allow('ooh', now, 0.7)) ooh(mix, clamp01(gasp), place.pan * 0.5);
  }

  function onEvent(evt, view) {
    try {
      if (!running()) return;
      const me = view?.me;
      const d = describeEvent(evt, {
        humanId: me?.humanId ?? -1,
        playerIndex: me?.playerIndex ?? -1,
        team: me?.team ?? -1,
        fireThreshold: consts.fireThreshold,
      });
      if (!d) return;
      const now = ctx.currentTime;
      if (!limiter.allow(d.kind, now, RULES[d.kind].gap)) return;
      play(d, evt, view, now);
    } catch (err) {
      report(err);
    }
  }

  /** Occasional claps, chants and whistles from the stands, only in open play. */
  function stands(view, now, replaying) {
    if (replaying || view.phase !== PHASE.PLAYING) {
      standAt = -1;
      return;
    }
    if (standAt < 0) standAt = now + standGap(mix.rnd, clamp01(excitement));
    if (now < standAt) return;
    standAt = now + standGap(mix.rnd, clamp01(excitement));
    const pan = (mix.rnd() * 2 - 1) * 0.7;
    const pick = standPick(mix.rnd);
    if (pick === 'claps') claps(mix, clapTimes(mix.rnd), pan, 0.3);
    else if (pick === 'chant') chant(mix, chantSyllables(mix.rnd), pan, 0.5);
    else fanWhistle(mix, pan, 0.03);
  }

  /** Charge tone and out-of-breath cue for the local player's footballer. */
  function localCues(view, now, replaying) {
    // During a replay me.player is the buffered past, not the footballer under the player's hands.
    const p = replaying ? null : view.me?.player;
    if (!p) {
      charge.stop();
      breathIndex = -1;
      return;
    }
    charge.set(num(p.charge));

    const empty = !(p.stamina > 0.001) || (p.flags & PLAYER_FLAG.EXHAUSTED) !== 0;
    const index = num(view.me.playerIndex, -1);
    if (index !== breathIndex) {
      // Control just moved to this footballer: adopt their state without a cue.
      breathIndex = index;
    } else if (empty && !wasEmpty && limiter.allow('pant', now, 1.5)) {
      pant(mix);
    }
    wasEmpty = empty;
  }

  function update(view) {
    try {
      if (!view || !running()) return;
      if (view.init && view.init !== matchInit) {
        matchInit = view.init;
        consts = matchConstants(view.init);
      }
      const now = ctx.currentTime;
      const dt = clamp(num(view.dt, 1 / 60), 0, 0.1);
      const replaying = view.replay != null;
      excitement = approach(excitement, 0, 0.45, dt);

      if (now - sweptAt > 0.5 || now < sweptAt) {
        sweptAt = now;
        mix.sweepEnded(now);
      }

      // The bed glides between targets, so 20 updates a second are plenty.
      if (crowdAt < 0 || now - crowdAt >= 0.05 || now < crowdAt) {
        crowdAt = now;
        const ball = view.ball;
        const speed = Number.isFinite(ball?.speed) ? ball.speed : Math.hypot(num(ball?.vx), num(ball?.vy));
        crowd.set(crowdTarget({
          phase: view.phase,
          replay: replaying,
          ballX: num(ball?.x),
          ballY: num(ball?.y),
          ballSpeed: speed,
          ballDead: ball?.dead === true,
          excitement,
          overtime: view.overtime === true,
          halfW: consts.halfW,
          shotMaxSpeed: consts.shotMaxSpeed,
        }), num(view.now, now));
      }

      stands(view, now, replaying);
      localCues(view, now, replaying);
    } catch (err) {
      report(err);
    }
  }

  function ui(name, value) {
    try {
      if (!running() || typeof name !== 'string') return;
      if (!limiter.allow(`ui:${name}`, ctx.currentTime, UI_GAPS[name] ?? 0.02)) return;
      uiSound(mix, name, value);
    } catch (err) {
      report(err);
    }
  }

  return { unlock, setVolume, setMuted, setMatch, update, onEvent, ui };
}
