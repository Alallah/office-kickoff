// The renderer's whole mutable state in one object ("R"), shared by every render module.
// Everything in here is plain data and typed arrays, so the modules that only compute (events,
// actors, ball, celebrations) can be driven headless. The canvas side (context, sprites, cached
// layers, labels) is attached by renderer.js.

import { createPalette } from './color.js';
import { createParticles, clearParticles } from './particles.js';
import { clearMood, clearNet, clearShake, createMood, createNet, createShake, createTrail, trailClear } from './fxmodel.js';
import {
  clearFx, clearGhosts, clearRipples, clearScuffs, createFx, createGhosts, createRipples, createScuffs,
} from './fxpool.js';
import { createPose } from './poses.js';
import { newBallView } from './viewx.js';

/** Most footballers a match can hold (7 a side) with room to spare. */
export const MAX_ACTORS = 32;

/** Speech bubbles that can be up at once. */
export const MAX_BUBBLES = 6;

function createActor(i) {
  return {
    /** False when the view has no drawable footballer at this index this frame. */
    ok: false,
    i,
    team: 0, keeper: false,
    /** Shirt, outline, number and facing-marker colours; shirt number; roster surname. */
    fill: '#888888', trim: '#ffffff', ink: '#ffffff', marker: '#ffffff', number: 0, surname: '',
    x: 0, y: 0, vx: 0, vy: 0, speed: 0, aim: 0,
    action: 0, actionT: 0, actionDir: 0,
    stamina: 1, charge: 0, cd: 0, flags: 0, ctrl: -1,
    /** Model entry of the controlling human, or null for the AI. */
    human: null,
    mine: false, hasBall: false,
    pose: createPose(),
    /** Body transform, and the same without spin or flip for the shadow. */
    m: { a: 1, b: 0, c: 0, d: 1 },
    ms: { a: 1, b: 0, c: 0, d: 1 },
    /** Where the footballer stands (pose offsets applied) and where the body is drawn (lifted). */
    gx: 0, gy: 0, bx: 0, by: 0,
    /** Distance from the body centre to its edge along the facing direction. */
    edge: 20,
    /** Facing as drawn: the aim, turned by a celebration spin. */
    face: 0,
    /** Celebration being performed (poses.CELEB), -1 = none. */
    celeb: -1,
    visible: false,
    /** Screen point (CSS pixels) above which a speech bubble goes; set when the name tags are drawn. */
    tagX: 0, tagY: 0,
    /** Shirt-number bitmap and what it was built for (footballers.js). */
    numSprite: null, numFor: null, numN: -1, numInk: '',
    /** Name-tag bitmap and what it was built for (overlays.js). */
    tagLabel: null, tagFor: null, tagEpoch: -1, tagText: '', tagColor: '', tagPx: 0,
    // ---- state that lives across frames (cleared by resetRuntime) ----
    seen: false,
    prevAction: 0,
    nameA: 0,
    dustT: 0, sweatT: 0, ghostT: 0, sparkT: 0, sprayAcc: 0,
    scuff: -1, scuffGen: 0,
    /** Seconds since the local player took this footballer over. */
    switchAge: 99,
  };
}

function clearActor(a) {
  a.ok = false;
  a.seen = false;
  a.prevAction = 0;
  a.nameA = 0;
  a.dustT = a.sweatT = a.ghostT = a.sparkT = a.sprayAcc = 0;
  a.scuff = -1;
  a.switchAge = 99;
  a.celeb = -1;
}

function createBall() {
  // The dark panels of the ball: the twelve corners of an icosahedron, rolled with the ball.
  const pts = new Float32Array(36);
  const phi = (1 + Math.sqrt(5)) / 2;
  const len = Math.sqrt(1 + phi * phi);
  const a = 1 / len, b = phi / len;
  const raw = [
    0, a, b, 0, a, -b, 0, -a, b, 0, -a, -b,
    a, b, 0, a, -b, 0, -a, b, 0, -a, -b, 0,
    b, 0, a, b, 0, -a, -b, 0, a, -b, 0, -a,
  ];
  for (let i = 0; i < 36; i++) pts[i] = raw[i];
  return {
    /** This frame's ball, made safe (viewx.readBall). */
    v: newBallView(),
    /** A previous frame is known, so the ball can roll from it. */
    has: false,
    px: 0, py: 0,
    pts,
    dir: 0, sa: 1, sb: 1,
    m: { a: 1, b: 0, c: 0, d: 1 },
    speedN: 0,
    fire: false,
    /** Glow strength 0..1, eased so it neither pops in nor out. */
    glow: 0,
    /** Net the ball lies in (0 = left, 1 = right), -1 = on the pitch. */
    inNet: -1,
    trailX: 0, trailY: 0,
    flameAcc: 0, emberAcc: 0, spinAcc: 0, spinPhase: 0,
  };
}

function createBubble() {
  return { on: false, player: -1, age: 0, life: 0, emoji: '', canvas: null, dirty: false, epoch: -1 };
}

export function createCelebrationState() {
  return {
    /** A scorer is celebrating. */
    on: false,
    i: -1, kind: 0, t0: 0, beats: 0, acc: 0,
    /** The scoring team (its footballers bounce while joy is set). */
    team: -1, joy: false,
    /** Started by a replayed goal: it ends with the replay, not with the GOAL phase. */
    replay: false,
    colA: 0, colB: 0,
  };
}

export function createRuntime() {
  const actors = [];
  for (let i = 0; i < MAX_ACTORS; i++) actors.push(createActor(i));
  const bubbles = [];
  for (let i = 0; i < MAX_BUBBLES; i++) bubbles.push(createBubble());

  return {
    // ---- match -------------------------------------------------------------------------------
    pal: createPalette(),
    /** model.buildModel() of the current match, or null before the first setMatch. */
    M: null,

    // ---- canvas (owned by renderer.js) -------------------------------------------------------
    canvas: null, ctx: null, sprites: null, layers: null,
    /** Caches of small bitmaps and paths, each rebuilt by the module that draws it. */
    labels: null, numbers: null, minimap: null, boardPaths: null, scanPattern: null,
    cssW: 0, cssH: 0,
    /** Device pixel ratio as reported, and backing-store pixels per CSS pixel actually used. */
    dpr: 1, edpr: 1,
    /** Bumped whenever edpr changes: bitmaps cached per resolution are rebuilt. */
    epoch: 0,

    // ---- this frame --------------------------------------------------------------------------
    vw: 1, vh: 1, camX: 0, camY: 0, zoom: 1,
    /** World -> device pixel transform (shake included), and the world rectangle on screen. */
    W: { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 },
    vis: { x0: -1e9, x1: 1e9, y0: -1e9, y1: 1e9 },
    phase: 0, overtime: false, inReplay: false, live: false,

    // ---- clocks ------------------------------------------------------------------------------
    /** Wall clock and wall frame time (seconds). */
    wall: 0, rdt: 0,
    /** Effect clock: runs slower in slow motion and stands still during an impact freeze. */
    t: 0, dt: 0,
    /** Speed of the effect clock (1 = real time) and how deep in slow motion it is (0..1). */
    scale: 1, slow: 0,
    hitStop: 0,
    frame: 0,
    lastViewTime: NaN,

    /** prefers-reduced-motion: no shake, no flashes, fewer particles. */
    reduced: false,
    /** Multiplier on particle counts. */
    density: 1,

    // ---- pools -------------------------------------------------------------------------------
    P: createParticles(2000),
    F: createFx(96),
    scuffs: createScuffs(24),
    ghosts: createGhosts(48),
    ripples: createRipples(8),
    shake: createShake(),
    trail: createTrail(64),
    nets: [createNet(), createNet()],
    mood: createMood(),

    // ---- footballers and ball ----------------------------------------------------------------
    actors,
    count: 0,
    order: new Int8Array(MAX_ACTORS),
    orderN: 0,
    /** Index of the local player's footballer (-1 = none), their human id and team. */
    mine: -1, myHuman: -1, myTeam: -1,
    /** Team-mate a pass would go to right now, when that is to be shown (-1 = nothing to show). */
    passTarget: -1,
    ball: createBall(),
    celeb: createCelebrationState(),
    bubbles,

    // ---- one-off states ----------------------------------------------------------------------
    /** Full-screen flash: opacity now, and whether it is gold rather than white. */
    flash: 0, flashGold: false,
    /** Seconds of post ringing left per goal post (PitchGeometry.Posts order). */
    postShake: new Float32Array(4),
    /** Opacity of the "box closed" marking per end. */
    boxA: new Float32Array(2),
    /** Confetti still to rain after a goal: seconds left, team colours, golden mix. */
    rain: 0, rainTeam: 0, rainGold: false, rainAcc: 0,
    fullTimeAcc: 0,
    /** A replayed goal has gone in: the rest of the replay is slow motion. */
    replayGoal: false,
    /** Crowd: hop phase per stand, and the fractional camera flashes owed. */
    crowdPhase: new Float32Array(4),
    crowdAmp: new Float32Array(4),
    flashAcc: 0,
    // ---- eased overlay opacities -------------------------------------------------------------
    replayA: 0, goldA: 0, mapA: 0, aimA: 0, arrowA: 0, stamA: 0.35,
    pipReady: true, pipPop: 0,
  };
}

/**
 * Drops everything transient (particles, trails, shapes, scuffs, after-images, bubbles, the
 * celebration, shake) and keeps what belongs to the match: model, cached layers, crowd mood.
 */
export function resetRuntime(R) {
  clearParticles(R.P);
  clearFx(R.F);
  clearScuffs(R.scuffs);
  clearGhosts(R.ghosts);
  clearRipples(R.ripples);
  clearShake(R.shake);
  trailClear(R.trail);
  clearNet(R.nets[0]);
  clearNet(R.nets[1]);
  for (let i = 0; i < R.actors.length; i++) clearActor(R.actors[i]);
  for (let i = 0; i < R.bubbles.length; i++) R.bubbles[i].on = false;
  const C = R.celeb;
  C.on = false;
  C.joy = false;
  C.i = -1;
  C.team = -1;
  R.ball.has = false;
  R.ball.glow = 0;
  R.ball.inNet = -1;
  R.ball.flameAcc = R.ball.emberAcc = R.ball.spinAcc = 0;
  R.flash = 0;
  R.hitStop = 0;
  R.postShake.fill(0);
  R.rain = 0;
  R.rainAcc = 0;
  R.fullTimeAcc = 0;
  R.replayGoal = false;
  R.lastViewTime = NaN;
  R.pipPop = 0;
}

/** A new match: also forget what belonged to the old one. */
export function clearMatchState(R) {
  resetRuntime(R);
  clearMood(R.mood);
  R.crowdPhase.fill(0);
  R.crowdAmp.fill(0);
  R.boxA.fill(0);
  R.flashAcc = 0;
  R.replayA = 0;
  R.goldA = 0;
  R.mapA = 0;
  R.aimA = 0;
  R.scale = 1;
  R.slow = 0;
  R.pipReady = true;
}
