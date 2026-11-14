// =====================================================================================
//  WIRE PROTOCOL (browser side). Mirror of:
//    src/OfficeKickoff.Web/Protocol/Dtos.cs        - message shapes (camelCase in JS)
//    src/OfficeKickoff.Sim/MatchState.cs           - MatchPhase, PlayerAction
//    src/OfficeKickoff.Sim/GameEvent.cs            - GameEventType and per-type field usage
//  Keep the numbers here identical to the C# enums.
// =====================================================================================

export const TICK_RATE = 60;
export const TICK_SECONDS = 1 / TICK_RATE;

/** MatchPhase */
export const PHASE = Object.freeze({
  INTRO: 0,       // "A vs B" splash, footballers frozen
  KICKOFF: 1,     // countdown, footballers frozen (can aim)
  PLAYING: 2,     // open play, clock runs
  GOAL: 3,        // slow motion then celebration; ball is dead
  REPLAY: 4,      // server paused; client shows the goal replay
  FULL_TIME: 5,   // final whistle hold
  ENDED: 6,       // results
});

/** PlayerAction */
export const ACTION = Object.freeze({
  NONE: 0,
  SLIDE: 1,
  DASH: 2,
  DIVE: 3,
  STUNNED: 4,
  RECOVER: 5,
});

/** GameEventType. See GameEvent.cs for what a, b, v (value) and f (flag) mean per type. */
export const EVT = Object.freeze({
  KICK: 1,          // a=kicker            v=charge 0..1            f=1 first-time
  PASS: 2,          // a=passer b=target   v=speed/PassMaxSpeed     f=1 first-time
  TRAP: 3,          // a=new owner         v=relSpeed/ControlSpeed
  STEAL: 4,         // a=new owner b=robbed
  SLIDE_START: 5,   // a=slider
  TACKLE_HIT: 6,    // a=slider b=victim|-1                          f=1 won the ball
  SLIDE_MISS: 7,    // a=slider
  DASH: 8,          // a=player
  DEFLECT: 9,       // a=player hit        v=speed/ShotMaxSpeed
  WALL_BOUNCE: 10,  //                     v=speed/ShotMaxSpeed
  POST_HIT: 11,     //                     v=speed/ShotMaxSpeed
  KEEPER_CATCH: 12, // a=keeper            v=speed/ShotMaxSpeed
  KEEPER_PARRY: 13, // a=keeper            v=speed/ShotMaxSpeed
  BLOCK: 14,        // a=blocker           v=speed/ShotMaxSpeed
  DIVE: 15,         // a=keeper
  GOAL: 16,         // a=scorer|-1 b=assister|-1 v=speed/ShotMaxSpeed  f: packed, ALWAYS read it with goalInfo(evt)
  PHASE_CHANGE: 17, //                     v=previous phase          f=new phase
  SWITCH: 18,       // a=new footballer b=old|-1                     f=human id
  NET_HIT: 19,      //                     v=speed/ShotMaxSpeed
  OVERTIME: 20,     // golden goal begins
});

/**
 * Unpacks the flag of an EVT.GOAL event (mirror of GoalFlags in GameEvent.cs).
 * scorerHuman / assistHuman are the human ids that controlled the scorer / assister AT THE TOUCH,
 * or -1 for an AI footballer (or no assist). Control often moves before the ball crosses the line,
 * so take the scorer's name and celebration from here (via MatchInit.humans), never from whoever
 * controls footballer `a` when the event arrives.
 * @param {{f:number}} evt
 * @returns {{team:number, ownGoal:boolean, decides:boolean, scorerHuman:number, assistHuman:number}}
 */
export function goalInfo(evt) {
  const f = evt.f | 0;
  return {
    team: f & 1,
    ownGoal: (f & 2) !== 0,
    decides: (f & 4) !== 0,
    scorerHuman: ((f >> 4) & 7) - 1,
    assistHuman: ((f >> 8) & 7) - 1,
  };
}

/** Bits of InputDto.k */
export const KEY = Object.freeze({
  SPRINT: 1,       // held
  SHOOT: 2,        // held (charge), release fires
  PASS: 4,         // edge
  TACKLE: 8,       // edge: slide without the ball, dash with it
  SWITCH_BEST: 16, // edge
  SWITCH_NEXT: 32, // edge
});

/** Snapshot flag bits (snap.f) */
export const SNAP_FLAG = Object.freeze({ OVERTIME: 1, SLOW_MO: 2, AWAY_KICKOFF: 4 });

/** Per-footballer flag bits */
export const PLAYER_FLAG = Object.freeze({ CHARGING: 1, EXHAUSTED: 2, SPRINTING: 4, SLIDE_HIT: 8, IMMUNE: 16 });

/** Ball flag bits */
export const BALL_FLAG = Object.freeze({ HELD: 1, DEAD: 2 });

/** Numbers per footballer in snap.p */
export const PLAYER_STRIDE = 13;

/**
 * Decoded snapshot.
 * @typedef {Object} Snapshot
 * @property {number} tick       server tick (60 per second)
 * @property {number} phase      PHASE.*
 * @property {number} phaseTime  real seconds left in the phase (0 while playing)
 * @property {number} clock      seconds of regulation left (practice: seconds played)
 * @property {number[]} score    [home, away]
 * @property {boolean} overtime
 * @property {boolean} slowMo
 * @property {number} kickoffTeam
 * @property {{x:number,y:number,vx:number,vy:number,spin:number,owner:number,heat:number,held:boolean,dead:boolean}} ball
 * @property {SnapPlayer[]} players
 * @property {number[]} acks     last input seq applied, per human id
 * @property {GameEvt[]} events
 *
 * @typedef {Object} SnapPlayer
 * @property {number} x @property {number} y @property {number} vx @property {number} vy
 * @property {number} aim        radians
 * @property {number} action     ACTION.*
 * @property {number} actionT    seconds left of the action
 * @property {number} actionDir  radians: direction of the current slide / dash / dive
 * @property {number} stamina    0..1
 * @property {number} charge     0..1
 * @property {number} ctrl       human id controlling this footballer, -1 = AI
 * @property {number} cd         tackle / dash cooldown, seconds left
 * @property {number} flags      PLAYER_FLAG bits
 *
 * @typedef {Object} GameEvt
 * @property {number} type       EVT.*
 * @property {number} a @property {number} b
 * @property {number} x @property {number} y
 * @property {number} v          value
 * @property {number} f          flag
 * @property {number} tick       server tick of the snapshot that carried it
 * @property {boolean} [predicted]  true when generated locally ahead of the server
 * @property {boolean} [replay]     true when re-fired during a goal replay
 */

/**
 * Turns the compact wire snapshot into a {@link Snapshot}.
 * @param {{t:number,ph:number,pt:number,ck:number,sc:number[],f:number,b:number[],p:number[],a:number[],e?:number[][]}} w
 * @returns {Snapshot}
 */
export function decodeSnap(w) {
  const b = w.b;
  const n = (w.p.length / PLAYER_STRIDE) | 0;
  const players = new Array(n);
  for (let i = 0, o = 0; i < n; i++, o += PLAYER_STRIDE) {
    players[i] = {
      x: w.p[o], y: w.p[o + 1], vx: w.p[o + 2], vy: w.p[o + 3],
      aim: w.p[o + 4], action: w.p[o + 5], actionT: w.p[o + 6], actionDir: w.p[o + 7],
      stamina: w.p[o + 8], charge: w.p[o + 9], ctrl: w.p[o + 10],
      cd: w.p[o + 11], flags: w.p[o + 12],
    };
  }
  const events = [];
  if (w.e) {
    for (const e of w.e) {
      events.push({ type: e[0], a: e[1], b: e[2], x: e[3], y: e[4], v: e[5], f: e[6], tick: w.t });
    }
  }
  return {
    tick: w.t,
    phase: w.ph,
    phaseTime: w.pt,
    clock: w.ck,
    score: w.sc,
    overtime: (w.f & SNAP_FLAG.OVERTIME) !== 0,
    slowMo: (w.f & SNAP_FLAG.SLOW_MO) !== 0,
    kickoffTeam: (w.f & SNAP_FLAG.AWAY_KICKOFF) !== 0 ? 1 : 0,
    ball: {
      x: b[0], y: b[1], vx: b[2], vy: b[3], spin: b[4], owner: b[5], heat: b[6],
      held: (b[7] & BALL_FLAG.HELD) !== 0, dead: (b[7] & BALL_FLAG.DEAD) !== 0,
    },
    players,
    acks: w.a,
    events,
  };
}

/** Fixed vocabulary; the server also sends these in JoinResult.catalog. */
export const CELEBRATIONS = Object.freeze(['spin', 'dab', 'confetti', 'backflip', 'shockwave', 'hearts']);
export const CRESTS = Object.freeze(['shield', 'circle', 'diamond', 'hexagon', 'star', 'bolt', 'chevron', 'crown']);
export const EMOTES = Object.freeze(['😂', '👏', '😭', '🔥', '😎', '😡', '🫡', '💤']);
export const QUICK_CHAT = Object.freeze(['Nice shot!', 'Great pass!', 'My bad', 'Pass!', 'Defend!', 'Unlucky', 'Wow!', 'GG']);

export const LIMITS = Object.freeze({
  nickname: 16, teamName: 24, teamCode: 3, rosterName: 20, chat: 80, roomCode: 4, rosterSize: 7,
  minTeamSize: 3, maxTeamSize: 7, minMinutes: 1, maxMinutes: 10, maxScoreLimit: 20, minSpeed: 0.75, maxSpeed: 1.5,
});

/**
 * Application base path, always ending in "/". The layout emits it as
 * <meta name="ok-base" content="/"> (or "/kickoff/" when IIS hosts the app under a sub-path),
 * so never hard-code a leading "/" in a URL: build every link with ROUTES.
 */
export const BASE = (() => {
  const meta = typeof document !== 'undefined' ? document.querySelector('meta[name="ok-base"]') : null;
  const base = meta?.content || '/';
  return base.endsWith('/') ? base : `${base}/`;
})();

/**
 * URL helpers so every module builds links the same way.
 * ROUTES.home accepts an error code shown on the Home page: "notfound", "closed", "full", "busy", "replaced".
 */
export const ROUTES = Object.freeze({
  home: (error) => (error ? `${BASE}?error=${encodeURIComponent(error)}` : BASE),
  lobby: (code) => `${BASE}room/${encodeURIComponent(code)}`,
  match: (code) => `${BASE}room/${encodeURIComponent(code)}/match`,
  hub: `${BASE}hub/game`,
});
