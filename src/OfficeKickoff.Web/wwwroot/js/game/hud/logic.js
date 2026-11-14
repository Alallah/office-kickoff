// The HUD's state machines, free of the document so they can be unit-tested headless: which key
// does what in which situation, how long a banner stays, when the countdown beeps, and what the
// ability bar shows for the footballer under control.

import { PHASE, PLAYER_FLAG, TICK_RATE } from '../../shared/protocol.js';
import { num, clamp01, countdownNumber } from './format.js';

// ------------------------------------------------------------------------------------
//  Keys
// ------------------------------------------------------------------------------------

// Physical keys the game reads by position (move, switch, spectator follow). A layout that prints
// "h" or "m" on one of them must not make it a HUD key as well.
const GAME_CODES = ['KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ', 'KeyE', 'KeyF'];

function isLetterKey(key, code, letter, letterCode) {
  const typed = key.length === 1 ? key.toLowerCase() : '';
  if (typed >= 'a' && typed <= 'z') return typed === letter && !GAME_CODES.includes(code);
  // No Latin letter on this key (Cyrillic, Greek, ...): fall back to where the key sits.
  return code === letterCode;
}

function digitOf(key, code, typing) {
  if (key.length === 1 && key >= '1' && key <= '8') return key;
  // By position, so emotes also work with Shift held (sprinting) and on layouts whose number row
  // needs Shift. Not while typing: there the same keys print letters such as "é".
  if (!typing && code.length === 6 && code.startsWith('Digit')) {
    const d = code[5];
    if (d >= '1' && d <= '8') return d;
  }
  return '';
}

/**
 * Names the HUD key behind a keyboard event: 'enter', 'escape', 'tab', 'h', 'm', '1'..'8',
 * or '' for every key the HUD does not own.
 * @param {string} key     KeyboardEvent.key
 * @param {string} code    KeyboardEvent.code
 * @param {boolean} [typing]  the event comes from the chat input
 */
export function hudKey(key, code, typing = false) {
  const k = typeof key === 'string' ? key : '';
  const c = typeof code === 'string' ? code : '';
  if (k === 'Enter') return 'enter';
  if (k === 'Escape' || k === 'Esc') return 'escape';
  if (k === 'Tab') return 'tab';
  const digit = digitOf(k, c, typing);
  if (digit) return digit;
  if (typing) return '';
  if (isLetterKey(k, c, 'h', 'KeyH')) return 'h';
  if (isLetterKey(k, c, 'm', 'KeyM')) return 'm';
  return '';
}

const IGNORE = Object.freeze({ action: '', arg: 0, prevent: false });
const SWALLOW = Object.freeze({ action: '', arg: 0, prevent: true });

function act(action, arg = 0, prevent = true) {
  return { action, arg, prevent };
}

/**
 * Decides what a HUD key does right now.
 *
 * @param {string} id  result of hudKey()
 * @param {object} s
 * @param {boolean} [s.typing]     the event target is the chat input
 * @param {boolean} [s.composing]  an IME composition is in progress (its Enter / Escape belong to the IME)
 * @param {boolean} [s.chatEmpty]  the chat input holds no text
 * @param {boolean} [s.foreign]    the target is a text field that is not the HUD's
 * @param {boolean} [s.focused]    a HUD control (button, slider) has keyboard focus
 * @param {boolean} [s.repeat]     auto-repeat of a held key
 * @param {boolean} [s.shift]
 * @param {boolean} [s.modifier]   Ctrl, Alt or Meta is held: a browser or system shortcut
 * @param {boolean} [s.menu]       the pause menu is open
 * @param {boolean} [s.controls]   the controls overlay is open
 * @param {boolean} [s.results]    the results screen is up
 * @returns {{action:string, arg:number, prevent:boolean}}
 *   action: '' | 'chat-open' | 'chat-send' | 'chat-cancel' | 'quick' (arg = line index) |
 *           'emote' (arg = emote index) | 'menu-open' | 'menu-close' | 'controls-open' |
 *           'controls-close' | 'mute' | 'roster' (show while Tab is held) |
 *           'focus' (arg = +1 next, -1 previous)
 *   prevent: cancel the browser's default action for the key
 */
export function routeKey(id, s) {
  if (!id || !s || s.modifier || s.foreign) return IGNORE;

  if (s.typing) {
    if (s.composing) return IGNORE;
    switch (id) {
      case 'enter':
        return s.repeat ? SWALLOW : act('chat-send');
      case 'escape':
        return act('chat-cancel');
      case 'tab':
        return SWALLOW;   // focus stays in the box
      case 'h':
      case 'm':
        return IGNORE;
      default:
        // A digit on an empty line is a quick-chat shortcut; after the first character it is text.
        if (!s.chatEmpty) return IGNORE;
        return s.repeat ? SWALLOW : act('quick', Number(id) - 1);
    }
  }

  const modal = !!(s.menu || s.controls);
  switch (id) {
    case 'escape':
      if (s.repeat) return IGNORE;
      if (s.controls) return act('controls-close');
      return act(s.menu ? 'menu-close' : 'menu-open');
    case 'enter':
      // A focused button is activated by the browser; opening the chat as well would do both.
      if (s.focused || s.repeat) return IGNORE;
      // The controls overlay is a "read this, then carry on" card: Enter is its OK.
      if (s.controls) return act('controls-close');
      if (s.menu) return IGNORE;
      return act('chat-open');
    case 'tab':
      // Always swallowed: Tab would walk focus out of the game and onto the browser's own controls.
      if (s.repeat && !(modal || s.results)) return SWALLOW;
      if (modal || s.results) return act('focus', s.shift ? -1 : 1);
      return act('roster');
    case 'h':
      if (s.repeat) return IGNORE;
      return act(s.controls ? 'controls-close' : 'controls-open', 0, false);
    case 'm':
      return s.repeat ? IGNORE : act('mute', 0, false);
    default:
      if (s.repeat || modal) return IGNORE;
      return act('emote', Number(id) - 1, false);
  }
}

// ------------------------------------------------------------------------------------
//  Timed banners
// ------------------------------------------------------------------------------------

/**
 * A banner's life: 'idle' -> 'in' (shown) -> 'out' (leaving) -> 'idle'. Driven by the frame clock,
 * so a banner can never outstay its slot even when frames are skipped.
 */
export class Timeline {
  constructor() {
    this.state = 'idle';
    this.outAt = 0;
    this.endAt = 0;
  }

  /** Shows the banner for `hold` seconds (Infinity = until cut), then lets it leave for `out` seconds. */
  start(now, hold, out) {
    this.state = 'in';
    this.outAt = now + Math.max(0, hold);
    this.endAt = this.outAt + Math.max(0, out);
  }

  /** Makes the banner leave now. One that is already leaving keeps its pace. */
  cut(now, out) {
    if (this.state !== 'in') return;
    this.state = 'out';
    this.outAt = now;
    this.endAt = now + Math.max(0, out);
  }

  /** Drops the banner at once, without a leaving animation. */
  stop() {
    this.state = 'idle';
  }

  /** @returns {'idle'|'in'|'out'} */
  step(now) {
    if (this.state === 'in' && now >= this.outAt) this.state = 'out';
    if (this.state === 'out' && now >= this.endAt) this.state = 'idle';
    return this.state;
  }
}

// ------------------------------------------------------------------------------------
//  Kickoff countdown
// ------------------------------------------------------------------------------------

/** Seconds "GO!" stays on screen. */
export const GO_TIME = 0.85;

/** Value of Countdown.shown while "GO!" is up. */
export const SHOW_GO = -1;

export class Countdown {
  constructor() {
    this.reset();
  }

  reset() {
    this.phase = -1;
    /** 3, 2, 1 = that number; 0 = nothing; SHOW_GO = "GO!". */
    this.shown = 0;
    this.goUntil = 0;
  }

  /**
   * Advances to this frame.
   * @returns {number} the cue to play: 3, 2 or 1 when that number has just appeared, SHOW_GO when
   *                   "GO!" has just appeared, 0 for nothing
   */
  step(phase, phaseTime, now) {
    let cue = 0;
    if (phase === PHASE.KICKOFF) {
      let n = countdownNumber(phaseTime);
      // Within one countdown a number never comes back: interpolation noise around a boundary
      // (2.001 -> 1.999 -> 2.001) must not show and beep it twice.
      if (this.phase === PHASE.KICKOFF && this.shown > 0 && n > this.shown) n = this.shown;
      if (n > 0 && n !== this.shown) cue = n;
      this.shown = n;
    } else if (phase === PHASE.PLAYING && this.phase === PHASE.KICKOFF) {
      this.shown = SHOW_GO;
      this.goUntil = now + GO_TIME;
      cue = SHOW_GO;
    } else if (!(this.shown === SHOW_GO && phase === PHASE.PLAYING && now < this.goUntil)) {
      this.shown = 0;
    }
    this.phase = phase;
    return cue;
  }
}

// ------------------------------------------------------------------------------------
//  Ability bar
// ------------------------------------------------------------------------------------

/** Seconds a player may be without a footballer before the bar says the AI has it. */
export const AI_NOTICE_DELAY = 0.5;

/** Phases in which a human can have a footballer under control. */
export function isLivePhase(phase) {
  return phase === PHASE.INTRO || phase === PHASE.KICKOFF || phase === PHASE.PLAYING ||
    phase === PHASE.GOAL || phase === PHASE.REPLAY;
}

export function isSpectator(me) {
  if (!me) return true;
  if (me.spectator === true) return true;
  if (me.spectator === false) return false;
  return !(me.humanId >= 0) && !me.player;
}

/**
 * What the bottom-centre slot shows.
 *   'off'        nothing (no match on screen, full time, results)
 *   'spectator'  the spectating hint
 *   'player'     the ability bar with live values
 *   'ai'         "the AI has your player"
 *   'wait'       a player without a footballer for a moment (first input still on its way, a
 *                switch in flight): keep whatever is on screen rather than flash the AI notice
 */
export class AbilityTracker {
  constructor() {
    this.since = -1;
  }

  reset() {
    this.since = -1;
  }

  /**
   * @param {boolean} [covered]  something else has the screen (results, a goal replay)
   * @returns {'off'|'spectator'|'player'|'ai'|'wait'}
   */
  step(me, phase, now, covered = false) {
    if (!me || covered || !isLivePhase(phase)) {
      this.since = -1;
      return 'off';
    }
    if (isSpectator(me)) {
      this.since = -1;
      return 'spectator';
    }
    if (me.player) {
      this.since = -1;
      return 'player';
    }
    if (this.since < 0) this.since = now;
    return now - this.since >= AI_NOTICE_DELAY ? 'ai' : 'wait';
  }
}

function quantize(value, steps) {
  return Math.round(value * steps) / steps;
}

/**
 * The numbers behind the ability bar, rounded to what a bar of its size can show so that a value
 * that has not visibly moved does not touch the DOM.
 * @param {object} player     PlayerView under control
 * @param {?object} tuning    MatchInit.tuning
 * @param {number} passTarget FrameView.passTarget
 * @param {object} out        reused result object (no per-frame allocation)
 */
export function abilityValues(player, tuning, passTarget, out) {
  const flags = num(player?.flags, 0) | 0;
  const tackle = tuning?.tackle ?? {};
  const stamina = clamp01(player?.stamina);
  const cooldownMax = Math.max(0.05, num(tackle.cooldown, 1.6));

  out.stamina = quantize(stamina, 200);
  out.exhausted = (flags & PLAYER_FLAG.EXHAUSTED) !== 0;
  out.sprinting = (flags & PLAYER_FLAG.SPRINTING) !== 0;
  out.charging = (flags & PLAYER_FLAG.CHARGING) !== 0;
  out.charge = out.charging ? quantize(clamp01(player?.charge), 100) : 0;
  out.fire = out.charging && num(player?.charge, 0) >= num(tuning?.kick?.fireThreshold, 0.85);
  out.cooldown = quantize(clamp01(num(player?.cd, 0) / cooldownMax), 120);
  // Space is a dash with the ball and a slide tackle without it; the dash costs stamina.
  out.dash = !!player?.hasBall;
  out.blocked = out.dash && stamina < num(tackle.dashStaminaCost, 0.2);
  out.ready = out.cooldown === 0 && !out.blocked;
  out.pass = num(passTarget, -1) >= 0;
  return out;
}

/** Where the "on fire" mark sits on the charge meter, 0..1. */
export function fireMark(tuning) {
  const threshold = num(tuning?.kick?.fireThreshold, 0.85);
  return threshold > 0 && threshold < 1 ? threshold : 0.85;
}

// ------------------------------------------------------------------------------------
//  Small pure helpers used by the menus
// ------------------------------------------------------------------------------------

/** Slider position (0..100) for a stored volume (0..1). */
export function volumeToSlider(volume) {
  return Math.round(clamp01(num(volume, 0.7)) * 100);
}

/** Volume (0..1) for a slider position; tolerates the string a range input reports. */
export function sliderToVolume(position) {
  const n = Number(position);
  return Number.isFinite(n) ? clamp01(n / 100) : 0;
}

/** Index of the control that gets focus next when Tab walks through `count` controls. */
export function nextFocusIndex(current, count, step) {
  if (!(count > 0)) return -1;
  if (current < 0 || current >= count) return step < 0 ? count - 1 : 0;
  return (current + (step < 0 ? -1 : 1) + count) % count;
}

/** The sound and control preferences the HUD shows, whatever shape getPrefs() came back in. */
export function readPrefs(raw) {
  const p = raw && typeof raw === 'object' ? raw : {};
  return {
    volume: clamp01(num(p.volume, 0.7)),
    muted: p.muted === true,
    autoSwitch: p.autoSwitch !== false,
  };
}

/** A practice match younger than this still counts as "just started". */
const FRESH_PRACTICE_SECONDS = 30;

/**
 * True when the controls overlay should open by itself: a practice match that has only just
 * begun. Reloading the page ten minutes into a kickabout must not put the card back up.
 */
export function offersControls(init) {
  if (!init || init.practice !== true) return false;
  const age = num(init.tick, 0) / TICK_RATE;
  return age < FRESH_PRACTICE_SECONDS;
}

const ACTION_NAMES = ['chat', 'emote', 'setVolume', 'setMuted', 'setAutoSwitch', 'rematch', 'backToLobby', 'leave', 'uiSound'];

/**
 * HudActions that cannot hurt the HUD: a missing callback is a no-op and one that throws is
 * reported once (per callback) instead of unwinding a frame half-way through.
 * @param {?object} actions                       HudActions as main.js provides them
 * @param {(name:string, err:*) => void} [report] told about the first failure of each callback
 */
export function guardActions(actions, report) {
  const failed = {};
  const fail = (name, err) => {
    if (failed[name]) return;
    failed[name] = true;
    if (typeof report === 'function') report(name, err);
  };
  const safe = {};
  for (const name of ACTION_NAMES) {
    safe[name] = (...args) => {
      try {
        const fn = actions ? actions[name] : undefined;
        if (typeof fn === 'function') fn.apply(actions, args);
      } catch (err) {
        fail(name, err);
      }
    };
  }
  safe.getPrefs = () => {
    try {
      const fn = actions ? actions.getPrefs : undefined;
      return readPrefs(typeof fn === 'function' ? fn.call(actions) : null);
    } catch (err) {
      fail('getPrefs', err);
      return readPrefs(null);
    }
  };
  return safe;
}
