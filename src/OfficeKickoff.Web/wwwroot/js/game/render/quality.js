// Resolution governor: keeps the frame rate up on weak graphics hardware by lowering the
// canvas resolution, and backs off when that turns out not to be what was slow. Pure state
// machine, fed one frame time per frame.
//
//   - Frames are judged in windows. A window is "overloaded" when most of its frames took
//     clearly longer than a 60 Hz frame.
//   - Two overloaded windows in a row step the resolution down one level, then the next window
//     decides: better -> the level is kept; still overloaded -> one more level is tried; still
//     overloaded at the lowest level -> resolution was never the problem (a 30 Hz display, a
//     browser in power-saving mode, a busy machine), so the last good level is restored and the
//     governor stops for good.

const WINDOW = 90;
const SLOW_FRAME = 0.0235;
const OVERLOADED = 0.6;
/** Frames ignored after a change: the cached layers are rebuilt, which hitches once. */
const SETTLE = 45;
/** A gap this long is a hidden tab or a one-off stall, not a slow frame. */
const HITCH = 0.25;

/** Resolution multipliers by level. */
export const QUALITY_LEVELS = Object.freeze([1, 0.75, 0.56]);

export function createGovernor() {
  return {
    /** Multiplier on the device pixel ratio. */
    scale: 1,
    level: 0,
    /** Last level known to be good enough (the one to fall back to when a trial fails). */
    base: 0,
    frames: 0, slow: 0,
    wait: 0, strikes: 0,
    /** A step down is on trial: the next window says whether it helped. */
    trial: false,
    locked: false,
  };
}

function setLevel(G, level) {
  G.level = level;
  G.scale = QUALITY_LEVELS[level];
  G.wait = SETTLE;
  G.frames = 0;
  G.slow = 0;
}

/**
 * Feeds one frame.
 * @param dt  wall seconds since the previous frame, unclamped
 * @returns {boolean} true when G.scale changed (the caller resizes the canvas)
 */
export function governorStep(G, dt) {
  if (G.locked || !(dt >= 0) || dt > HITCH) return false;
  if (G.wait > 0) {
    G.wait--;
    return false;
  }
  G.frames++;
  if (dt > SLOW_FRAME) G.slow++;
  if (G.frames < WINDOW) return false;

  const overloaded = G.slow / G.frames >= OVERLOADED;
  G.frames = 0;
  G.slow = 0;

  if (!overloaded) {
    G.strikes = 0;
    if (G.trial) {
      G.trial = false;
      G.base = G.level;
    }
    return false;
  }

  const lowest = QUALITY_LEVELS.length - 1;
  if (G.trial) {
    if (G.level < lowest) {
      setLevel(G, G.level + 1);
      return true;
    }
    // Nothing helped: give the pixels back and stop meddling.
    G.trial = false;
    G.locked = true;
    if (G.level === G.base) return false;
    setLevel(G, G.base);
    return true;
  }

  if (++G.strikes < 2 || G.level >= lowest) return false;
  G.strikes = 0;
  G.trial = true;
  setLevel(G, G.level + 1);
  return true;
}
