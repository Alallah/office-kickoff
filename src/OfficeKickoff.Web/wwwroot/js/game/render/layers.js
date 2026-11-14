// Cached layers: everything static is painted once into offscreen canvases and only blitted per
// frame. There are three kinds, each at the resolution it needs:
//
//   ground   pitch, markings, crests, goal floors, boards    - as sharp as the screen
//   stands   terraces, aisles, apron                         - dim and soft, low resolution
//   crowd    4 stands x 3 hop groups of spectators           - in between
//
// A layer remembers the world rectangle it covers, so it is drawn correctly whatever resolution
// it was painted at. Layers are repainted when the match changes (all at once) and when the
// zoom or the canvas resolution has moved far enough from what they were painted for (one layer
// per frame, so a zoom change never stalls a frame for long).

import { clamp } from './mathx.js';
import { layerScale, layerStale, stripRect } from './geom.js';
import { makeCanvas } from './sprites.js';
import { setWorld } from './shapes.js';
import { groundRect, paintGround } from './pitch.js';
import { drawCrowd, paintCrowd, paintStands } from './crowd.js';

const MAX_DIM = 4096;
const GROUND_AREA = 6.0e6;
const STANDS_AREA = 1.6e6;
const CROWD_AREA = 0.7e6;

/** Spectators near the edge of a stand's strip are painted whole: the layer is this much larger. */
const CROWD_PAD = 12;

const JOB_GROUND = 0, JOB_STANDS = 1, JOB_CROWD = 2;

export function createLayers() {
  return {
    /** Model the layers were painted for. */
    M: null,
    ground: null,
    stands: null,
    /** Index strip * 3 + group. */
    crowd: [null, null, null, null, null, null, null, null, null, null, null, null],
    /** Pixels per world unit the current set was painted for. */
    scale: 0,
    lastTarget: 0,
    settled: 0,
    queue: [],
  };
}

const rect = { x: 0, y: 0, w: 0, h: 0 };

function newLayer(x, y, w, h, s) {
  const c = makeCanvas(w * s, h * s);
  const g = c.getContext('2d');
  g.setTransform(s, 0, 0, s, -x * s, -y * s);
  // The canvas is a whole number of pixels: the layer covers exactly what those pixels hold.
  return { c, g, x, y, w: c.width / s, h: c.height / s, s };
}

function buildGround(R, target) {
  const M = R.M;
  groundRect(M, rect);
  const layer = newLayer(rect.x, rect.y, rect.w, rect.h, layerScale(target, rect.w, rect.h, MAX_DIM, GROUND_AREA));
  paintGround(layer.g, M);
  layer.g = null;
  R.layers.ground = layer;
}

function buildStands(R, target) {
  const M = R.M, st = M.stands;
  const layer = newLayer(st.x0, st.y0, st.w, st.h, layerScale(clamp(target * 0.6, 0.3, 1), st.w, st.h, MAX_DIM, STANDS_AREA));
  paintStands(layer.g, M);
  layer.g = null;
  R.layers.stands = layer;
}

function buildCrowd(R, target, strip) {
  const M = R.M;
  stripRect(M.stands, strip, rect);
  const x = rect.x - CROWD_PAD, y = rect.y - CROWD_PAD, w = rect.w + 2 * CROWD_PAD, h = rect.h + 2 * CROWD_PAD;
  const s = layerScale(clamp(target * 0.85, 0.45, 1.6), w, h, MAX_DIM, CROWD_AREA);
  for (let group = 0; group < 3; group++) {
    const layer = newLayer(x, y, w, h, s);
    paintCrowd(layer.g, M, strip, group);
    layer.g = null;
    R.layers.crowd[strip * 3 + group] = layer;
  }
}

function run(R, job, target) {
  if (job === JOB_GROUND) buildGround(R, target);
  else if (job === JOB_STANDS) buildStands(R, target);
  else buildCrowd(R, target, job - JOB_CROWD);
}

/** Forgets every layer; the next frame repaints them. */
export function dropLayers(L) {
  L.M = null;
  L.ground = null;
  L.stands = null;
  for (let i = 0; i < L.crowd.length; i++) L.crowd[i] = null;
  L.queue.length = 0;
  L.scale = 0;
  L.settled = 0;
}

/**
 * Keeps the layers in step with the match and the zoom.
 * @param target  device pixels per world unit this frame is drawn at (zoom x backing-store ratio)
 * @param dt      wall seconds since the previous frame
 */
export function updateLayers(R, target, dt) {
  const L = R.layers, M = R.M;
  if (!(target > 0)) return;
  if (L.M !== M) {
    dropLayers(L);
    L.M = M;
  }

  // The zoom glides while the camera follows play; repainting waits until it has come to rest.
  if (Math.abs(target - L.lastTarget) > L.lastTarget * 0.004) L.settled = 0;
  else L.settled += dt;
  L.lastTarget = target;

  if (!L.ground) {
    // First frame of a match: everything at once (the intro covers the hitch).
    L.scale = target;
    L.queue.length = 0;
    for (let job = 0; job < JOB_CROWD + 4; job++) run(R, job, target);
    return;
  }
  if (L.queue.length === 0 && layerStale(L.scale, target, L.settled)) {
    L.scale = target;
    for (let job = 0; job < JOB_CROWD + 4; job++) L.queue.push(job);
  }
  if (L.queue.length > 0) run(R, L.queue.shift(), L.scale);
}

function blit(ctx, layer) {
  ctx.drawImage(layer.c, layer.x, layer.y, layer.w, layer.h);
}

/** Draws the stadium: stands, crowd, then the pitch on top. */
export function drawBackdrop(R) {
  const L = R.layers, ctx = R.ctx;
  setWorld(ctx, R.W);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
  if (L.stands) blit(ctx, L.stands);
  drawCrowd(R);
  if (L.ground) blit(ctx, L.ground);
}
