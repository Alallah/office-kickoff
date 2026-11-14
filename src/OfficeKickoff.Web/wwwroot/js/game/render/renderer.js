// The match renderer: draws the world and every in-world effect on one <canvas>.
// Contract: game/types.js (Renderer). main.js calls render(view) every frame and forwards game
// events to onEvent; nothing here ever throws back at it.
//
// How it is put together:
//   runtime.js     all state                      framestep.js   one frame of effect simulation
//   events.js      game events -> effects         actors.js / ballfx.js / celebrations.js / crowdfx.js
//   layers.js      cached pitch, stands, crowd    pitch.js / crowd.js   what goes into them
//   footballers.js, ball.js, effects.js, overlays.js   the per-frame drawing
//
// The canvas: CSS sizes it, main.js reports the size through resize(), and this file is the only
// place its backing store is written. World -> screen is the camera formula of types.js; shake,
// roll and zoom punch are added on top in geom.worldMatrix and never reach the aim.

import { prefersReducedMotion } from '../../shared/util.js';
import { clamp, isNum, num } from './mathx.js';
import { effectiveDpr } from './geom.js';
import { NIGHT } from './look.js';
import { buildModel } from './model.js';
import { createGovernor, governorStep } from './quality.js';
import { clearMatchState, createRuntime, resetRuntime } from './runtime.js';
import { createSprites } from './sprites.js';
import { createLayers, drawBackdrop, dropLayers, updateLayers } from './layers.js';
import { stepFrame } from './framestep.js';
import { handleEvent } from './events.js';
import { drawBoardGold, drawClosedBoxes, drawNet, drawPosts, drawRipples, drawScuffs } from './pitch.js';
import { drawFx, drawGhosts, drawParticles } from './effects.js';
import { drawFootballerBodies, drawFootballerGround, drawFootballerTops, drawHeldGloves } from './footballers.js';
import { drawBall, drawTrail } from './ball.js';
import {
  drawAimLine, drawBubbles, drawEdgeArrows, drawFlash, drawGrade, drawLetterbox, drawMinimap, drawPassLink,
  drawReticle, drawTags, letterbox,
} from './overlays.js';

/** The backing store never holds more pixels than this: what integrated graphics fill at 60 fps. */
const MAX_PIXELS = 2560 * 1440;

/** Seconds an emote bubble stays up. */
const BUBBLE_LIFE = 2.1;

const NO_DASH = [];

/**
 * @param {HTMLCanvasElement} canvas
 * @returns {import('../types.js').Renderer}
 */
export function createRenderer(canvas) {
  const R = createRuntime();
  const governor = createGovernor();
  R.canvas = canvas;
  // Opaque: every frame paints the whole canvas, so the browser need not blend it with the page.
  R.ctx = canvas && typeof canvas.getContext === 'function' ? canvas.getContext('2d', { alpha: false }) : null;
  R.sprites = createSprites(R.pal);
  R.layers = createLayers();

  let lastNow = NaN;
  let failures = 0;

  function readMotion() {
    R.reduced = prefersReducedMotion();
    R.density = R.reduced ? 0.35 : 1;
  }

  /** Last line of defence: say what went wrong (a few times at most) and leave the context clean. */
  function fail(err) {
    if (failures < 3) {
      failures++;
      try {
        console.error('[renderer]', err);
      } catch {
        /* no console */
      }
    }
    try {
      const ctx = R.ctx;
      if (ctx) {
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.globalAlpha = 1;
        ctx.globalCompositeOperation = 'source-over';
        ctx.setLineDash(NO_DASH);
      }
    } catch {
      /* the context itself is gone */
    }
  }

  function applySize() {
    if (!canvas) return;
    const edpr = effectiveDpr(R.cssW, R.cssH, R.dpr, governor.scale, MAX_PIXELS);
    const w = Math.max(1, Math.round(R.cssW * edpr)), h = Math.max(1, Math.round(R.cssH * edpr));
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== h) canvas.height = h;
    if (edpr !== R.edpr) {
      R.edpr = edpr;
      // Labels, bubbles and the minimap are bitmaps at this resolution.
      R.epoch++;
    }
  }

  function resize(cssWidth, cssHeight, dpr) {
    try {
      R.cssW = clamp(num(cssWidth, 0), 0, 8192);
      R.cssH = clamp(num(cssHeight, 0), 0, 8192);
      R.dpr = clamp(num(dpr, 1), 0.5, 4);
      readMotion();
      applySize();
    } catch (err) {
      fail(err);
    }
  }

  function setMatch(init) {
    try {
      R.pal.clear();
      R.sprites.clearTinted();
      R.M = buildModel(init, R.pal);
      clearMatchState(R);
      dropLayers(R.layers);
      R.labels = null;
      R.numbers = null;
      R.minimap = null;
      R.boardPaths = null;
      readMotion();
    } catch (err) {
      fail(err);
    }
  }

  /** The view knows which match it shows: follow it if setMatch was missed. */
  function ensureModel(view) {
    const init = view.init;
    if (!R.M) {
      setMatch(init);
      return;
    }
    if (init && typeof init === 'object' && isNum(init.matchId) && init.matchId !== R.M.matchId) setMatch(init);
  }

  function draw(view) {
    const ctx = R.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.setLineDash(NO_DASH);
    ctx.fillStyle = NIGHT;
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // The stadium and what lies on the turf.
    drawBackdrop(R);
    drawScuffs(R);
    drawClosedBoxes(R);
    drawBoardGold(R);
    drawRipples(R);
    drawFx(R, false);
    drawParticles(R, false);
    drawGhosts(R);
    drawFootballerGround(R);
    drawTrail(R);
    drawPassLink(R);
    drawAimLine(R, view);

    // Footballers and ball; the nets go over a ball that lies in them.
    drawFootballerBodies(R);
    drawBall(R);
    drawHeldGloves(R);
    drawNet(R, 0);
    drawNet(R, 1);
    drawPosts(R);
    drawFootballerTops(R);

    // What flies above them.
    drawParticles(R, true);
    drawFx(R, true);
    drawTags(R);
    drawBubbles(R);
    drawReticle(R);

    // The picture as a whole, then what must stay readable on top of it.
    drawGrade(R);
    const lift = letterbox(R);
    drawEdgeArrows(R, lift);
    drawMinimap(R, lift);
    drawLetterbox(R);
    drawFlash(R);
  }

  function frame(view) {
    if (!view || typeof view !== 'object' || !R.ctx) return;
    ensureModel(view);
    if (!R.M) return;

    if (!(R.cssW >= 1 && R.cssH >= 1)) {
      // resize() has not been called yet: the view's viewport is the canvas size in CSS pixels.
      const vp = view.viewport;
      if (!vp || !(vp.w >= 2) || !(vp.h >= 2)) return;
      resize(vp.w, vp.h, typeof window !== 'undefined' && window.devicePixelRatio ? window.devicePixelRatio : 1);
      if (!(R.cssW >= 1 && R.cssH >= 1)) return;
    }

    // The resolution governor judges true frame times, not the clamped ones in the view.
    if (isNum(view.now)) {
      if (isNum(lastNow) && governorStep(governor, view.now - lastNow)) applySize();
      lastNow = view.now;
    }

    stepFrame(R, view);
    updateLayers(R, R.zoom * R.edpr, R.rdt);
    draw(view);
  }

  function render(view) {
    try {
      frame(view);
    } catch (err) {
      fail(err);
    }
  }

  function onEvent(evt, view) {
    try {
      if (!R.M && view && typeof view === 'object') ensureModel(view);
      if (R.M) handleEvent(R, evt, view);
    } catch (err) {
      fail(err);
    }
  }

  function showEmote(playerIndex, emoji) {
    try {
      if (!(playerIndex >= 0 && playerIndex < R.actors.length && (playerIndex | 0) === playerIndex)) return;
      const text = typeof emoji === 'string' ? emoji.slice(0, 16) : '';
      if (!text) return;
      const bubbles = R.bubbles;
      // A footballer has one bubble; otherwise a free one, otherwise the one that has been up longest.
      let slot = null;
      for (let i = 0; i < bubbles.length && !slot; i++) if (bubbles[i].on && bubbles[i].player === playerIndex) slot = bubbles[i];
      for (let i = 0; i < bubbles.length && !slot; i++) if (!bubbles[i].on) slot = bubbles[i];
      if (!slot) {
        slot = bubbles[0];
        for (let i = 1; i < bubbles.length; i++) if (bubbles[i].age > slot.age) slot = bubbles[i];
      }
      slot.on = true;
      slot.player = playerIndex;
      slot.age = 0;
      slot.life = BUBBLE_LIFE;
      slot.emoji = text;
      slot.dirty = true;
    } catch (err) {
      fail(err);
    }
  }

  function reset() {
    try {
      resetRuntime(R);
    } catch (err) {
      fail(err);
    }
  }

  readMotion();
  return { resize, setMatch, render, onEvent, showEmote, reset };
}
