// Every client-side tuning number of the match page's engine room. Gameplay numbers are NOT
// here: they arrive from the server in MatchInit.tuning so prediction matches the simulation.
//
// Units: seconds, world units, radians - unless the name says otherwise.

const f = Object.freeze;

export const CONFIG = f({
  net: f({
    /** Snapshot history kept; goal replays read from it. */
    bufferSeconds: 10,
    /** Snapshots behind the median that estimates server time (1.5 s at 30 Hz). */
    offsetWindow: 45,
    /** Until this many snapshots have arrived the interpolation delay stays at its default. */
    minSamples: 8,
    /** Interpolation delay = delayIntervals * snapshot interval + delayJitterGain * measured lateness. */
    delayIntervals: 1.5,
    delayJitterGain: 2.0,
    delayDefaultIntervals: 2,
    delayMin: 0.05,
    delayMax: 0.2,
    /** How fast the delay follows its target per snapshot: quickly up, slowly down. */
    delayRise: 0.25,
    delayFall: 0.03,
    /** Render clock: rate correction per second of error, capped at slewMax; beyond snapError it jumps. */
    slewGain: 1.2,
    slewMax: 0.04,
    snapError: 0.15,
    /**
     * This many snapshots in a row arriving more than stepError off the server-time estimate, yet
     * within stepSpread of each other, mean the server's timeline moved: the estimate starts over.
     */
    stepSamples: 5,
    stepError: 0.1,
    stepSpread: 0.05,
    /** A late snapshot is bridged by extrapolating this long from velocity, then the picture holds. */
    maxExtrapolate: 0.1,
    /** An entity that moved further than this between two snapshots teleported: never interpolate it. */
    teleportDistance: 250,
    /** No snapshot for this long during a running match is reported as 'reconnecting'. */
    staleAfter: 1.0,
    /** A tick this far behind the newest one means the server timeline restarted. */
    restartGapTicks: 120,
    /** A hole this long in the buffer (page was frozen, connection dropped) makes everything before it stale. */
    holeSeconds: 1.0,
    /** A frame gap this long means the tab was not rendering: resynchronise instead of catching up. */
    resumeGap: 0.5,
    /** Without any snapshot for this long after a match starts, frames are built from a placeholder. */
    placeholderAfter: 0.75,
  }),

  input: f({
    /** Input ticks run from an accumulator; never more than this many per frame. */
    maxTicksPerFrame: 6,
    /** Unacknowledged inputs kept for replay. */
    maxPending: 180,
  }),

  predict: f({
    /** Correction of my own footballer: the visual offset is gone after about this long. */
    correctionTime: 0.08,
    /** A footballer I take over blends from where it was drawn over about this long. */
    gainTime: 0.08,
    /** A footballer I let go blends back to its interpolated pose over about this long. */
    releaseTime: 0.12,
    /** However large, a visual offset never shrinks faster than this (units per second). */
    maxCorrectionSpeed: 480,
    /** Corrections larger than this are teleports: snap. */
    snapDistance: 120,
    /** A predicted control switch the server has not confirmed after this long is dropped. */
    switchTimeout: 0.4,
    /** A server event matching one of my predicted events within this window is suppressed. */
    eventMatchWindow: 0.4,
    /** On a slow link the window stretches to round trip + interpolation delay + this. */
    eventMatchMargin: 0.15,
  }),

  ball: f({
    /** Ease-in when the ball becomes mine. */
    attachTime: 0.06,
    /** Blend when the ball leaves my feet without a kick of mine (robbed, tackled). */
    detachTime: 0.08,
    /** Without the server's kick after this long the ghost ball is dropped ... */
    ghostTimeout: 0.35,
    /** ... unless the connection is slow: the timeout never undercuts round trip + delay + this. */
    ghostTimeoutMargin: 0.12,
    /** Blend back to the server ball when the ghost was wrong. */
    ghostFallbackTime: 0.1,
    /** Blend that hides the small mismatch when the ghost hands over to the server ball. */
    handoverTime: 0.08,
    /** The lead of the drawn ball over the interpolated timeline decays to zero over this long. */
    leadDecayTime: 0.5,
    /** Sanity cap on that lead. */
    maxLead: 0.3,
    /** Blend when the lead is dropped at once (someone touched the ball, goal). */
    leadDropTime: 0.07,
    /** Ball offsets larger than this are not blended. */
    snapDistance: 220,
  }),

  camera: f({
    /** World units shown around the pitch (nets, crowd). */
    margin: 110,
    /** Whole-pitch camera when it fits at this zoom or better ... */
    fitMinZoom: 0.8,
    /** ... and never closer than this. */
    fitMaxZoom: 1.25,
    /** Follow camera: world units visible across, near and far from the ball. */
    unitsNear: 900,
    unitsFar: 1100,
    /** Ball distance (from my footballer) at which the zoom starts / finishes easing out. */
    farStart: 280,
    farEnd: 760,
    /** The follow camera never shows fewer world units than this top to bottom. */
    minUnitsDown: 540,
    followMaxZoom: 1.25,
    /** Weight of my footballer in the point the camera aims at (the ball gets the rest). */
    meWeight: 0.6,
    /** My footballer stays within this fraction of the half-view around the camera target. */
    keepInView: 0.72,
    /** Look-ahead towards the cursor: fraction of the cursor's offset from the screen centre, capped. */
    lookAhead: 0.14,
    lookAheadMax: 90,
    /** Critically damped spring. */
    smoothTime: 0.18,
    zoomSmoothTime: 0.35,
    /** Spectator free camera. */
    panSpeed: 1100,
    wheelZoomStep: 0.0012,
    maxUserZoom: 2.4,
  }),

  replay: f({
    /** Playback speed around the goal, relative to normal play. */
    slowSpeed: 0.35,
    /** The slow-down eases in between these two moments before the goal (seconds of play). */
    easeFrom: 0.8,
    easeTo: 0.3,
    /** Bounds for the speed of the build-up, which is solved so the replay fills its time slot. */
    maxSpeed: 2.5,
    minSpeed: 0.2,
    /** Seconds of standing at the kickoff shown when the goal came straight from it. */
    kickoffLead: 0.35,
    /** Less footage than this is not worth a replay. */
    minFootage: 0.25,
  }),
});
