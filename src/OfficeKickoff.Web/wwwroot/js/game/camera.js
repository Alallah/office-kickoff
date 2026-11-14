// The camera, and the one formula every module uses to go between world and screen.
//
//   sx = (wx - camera.x) * camera.zoom + viewport.w / 2
//   sy = (wy - camera.y) * camera.zoom + viewport.h / 2
//
// camera.x / camera.y is the world point at the centre of the screen. Screen coordinates are CSS
// pixels of the canvas. Purely visual offsets (shake) belong to the renderer and never pass
// through here, so aiming is unaffected by them. Pure: no DOM.

import { CONFIG } from './config.js';
import { clamp, lerp, smoothstep } from './geom.js';

/** World -> screen (CSS pixels). */
export function worldToScreen(wx, wy, camera, viewport, out = { x: 0, y: 0 }) {
  out.x = (wx - camera.x) * camera.zoom + viewport.w / 2;
  out.y = (wy - camera.y) * camera.zoom + viewport.h / 2;
  return out;
}

/** Screen (CSS pixels) -> world. */
export function screenToWorld(sx, sy, camera, viewport, out = { x: 0, y: 0 }) {
  out.x = (sx - viewport.w / 2) / camera.zoom + camera.x;
  out.y = (sy - viewport.h / 2) / camera.zoom + camera.y;
  return out;
}

/** Largest zoom at which the whole pitch plus `margin` world units all round fits the viewport. */
export function fitZoom(pitch, viewport, margin) {
  return Math.min(
    Math.max(1, viewport.w) / (pitch.width + 2 * margin),
    Math.max(1, viewport.h) / (pitch.height + 2 * margin),
  );
}

// Critically damped spring towards `target`; s is { x, v }.
function smoothDamp(s, target, smoothTime, dt) {
  const omega = 2 / Math.max(1e-4, smoothTime);
  const k = omega * dt;
  const e = 1 / (1 + k + 0.48 * k * k + 0.235 * k * k * k);
  const change = s.x - target;
  const temp = (s.v + omega * change) * dt;
  s.v = (s.v - omega * temp) * e;
  s.x = target + (change + temp) * e;
}

// Centre position that keeps the view within `limit` of the pitch centre on one axis; a view
// wider than that is simply centred.
function bound(c, halfView, limit) {
  const max = limit - halfView;
  return max <= 0 ? 0 : clamp(c, -max, max);
}

/**
 * @param {typeof CONFIG.camera} cfg
 */
export function createCamera(cfg = CONFIG.camera) {
  const px = { x: 0, v: 0 };
  const py = { x: 0, v: 0 };
  const pz = { x: 1, v: 0 };
  let cut = true;

  // Spectators only.
  let follow = true;
  let userZoom = 1;
  let freeX = 0;
  let freeY = 0;

  return {
    get x() { return px.x; },
    get y() { return py.x; },
    get zoom() { return pz.x; },
    /** Spectator: true while the camera follows the ball. */
    get following() { return follow; },

    /** The next update jumps straight to its target (kickoff teleports, replay cuts, resize of a fixed view). */
    snap() {
      cut = true;
    },

    /** Spectator: F key. */
    toggleFollow() {
      follow = !follow;
      freeX = px.x;
      freeY = py.x;
    },

    /**
     * @param dt wall seconds
     * @param s  { pitch, viewport:{w,h}, me:?{x,y}, ball:{x,y}, mouse:?{x,y}, spectator:boolean,
     *             panX:number, panY:number, dragX:number, dragY:number, wheel:number }
     *           me = my drawn footballer; mouse = cursor in screen pixels; pan = spectator keys
     *           (-1..1); drag = pixels dragged since the last update; wheel = wheel delta in pixels.
     */
    update(dt, s) {
      const vw = Math.max(1, s.viewport.w);
      const vh = Math.max(1, s.viewport.h);
      const fit = fitZoom(s.pitch, s.viewport, cfg.margin);
      const limitX = s.pitch.halfW + cfg.margin;
      const limitY = s.pitch.halfH + cfg.margin;
      const whole = fit >= cfg.fitMinZoom;

      let tx = 0;
      let ty = 0;
      let tz;
      let smooth = cfg.smoothTime;
      let fixed = false;

      if (s.spectator) {
        const base = whole ? Math.min(fit, cfg.fitMaxZoom) : Math.min(vw / cfg.unitsFar, vh / cfg.minUnitsDown, cfg.followMaxZoom);
        const lowest = Math.min(fit, base);
        if (s.wheel) userZoom *= Math.exp(-s.wheel * cfg.wheelZoomStep);
        tz = clamp(base * userZoom, lowest, Math.max(lowest, cfg.maxUserZoom));
        userZoom = tz / base;

        const dragging = s.dragX !== 0 || s.dragY !== 0;
        if (follow && (s.panX !== 0 || s.panY !== 0 || dragging)) {
          follow = false;
          freeX = px.x;
          freeY = py.x;
        }
        if (follow) {
          tx = s.ball.x;
          ty = s.ball.y;
        } else {
          const z = pz.x > 0 ? pz.x : tz;
          freeX += (s.panX * cfg.panSpeed * dt - s.dragX) / z;
          freeY += (s.panY * cfg.panSpeed * dt - s.dragY) / z;
          freeX = bound(freeX, vw / (2 * tz), limitX);
          freeY = bound(freeY, vh / (2 * tz), limitY);
          tx = freeX;
          ty = freeY;
          // A drag must stick to the cursor; key panning may glide a little.
          smooth = dragging ? 0 : cfg.smoothTime * 0.4;
        }
      } else if (whole) {
        // Seeing everything is best for this game: no camera movement at all.
        tz = Math.min(fit, cfg.fitMaxZoom);
        fixed = true;
      } else {
        const me = s.me;
        const far = me ? smoothstep(cfg.farStart, cfg.farEnd, Math.hypot(s.ball.x - me.x, s.ball.y - me.y)) : 1;
        const units = lerp(cfg.unitsNear, cfg.unitsFar, far);
        tz = Math.max(fit, Math.min(vw / units, vh / cfg.minUnitsDown, cfg.followMaxZoom));
        const halfW = vw / (2 * tz);
        const halfH = vh / (2 * tz);
        if (me) {
          tx = me.x * cfg.meWeight + s.ball.x * (1 - cfg.meWeight);
          ty = me.y * cfg.meWeight + s.ball.y * (1 - cfg.meWeight);
          if (s.mouse) {
            tx += clamp(((s.mouse.x - vw / 2) / tz) * cfg.lookAhead, -cfg.lookAheadMax, cfg.lookAheadMax);
            ty += clamp(((s.mouse.y - vh / 2) / tz) * cfg.lookAhead, -cfg.lookAheadMax, cfg.lookAheadMax);
          }
          // However far away the ball is, my footballer stays comfortably on screen.
          tx = clamp(tx, me.x - halfW * cfg.keepInView, me.x + halfW * cfg.keepInView);
          ty = clamp(ty, me.y - halfH * cfg.keepInView, me.y + halfH * cfg.keepInView);
        } else {
          tx = s.ball.x;
          ty = s.ball.y;
        }
      }

      tx = bound(tx, vw / (2 * tz), limitX);
      ty = bound(ty, vh / (2 * tz), limitY);

      if (cut || fixed || !(dt > 0)) {
        px.x = tx;
        py.x = ty;
        pz.x = tz;
        px.v = 0;
        py.v = 0;
        pz.v = 0;
        // A fixed view has nothing to cut to later; a moving one has used its cut.
        cut = fixed;
      } else {
        if (smooth > 0) {
          smoothDamp(px, tx, smooth, dt);
          smoothDamp(py, ty, smooth, dt);
        } else {
          px.x = tx;
          py.x = ty;
          px.v = 0;
          py.v = 0;
        }
        smoothDamp(pz, tz, cfg.zoomSmoothTime, dt);
        // The zoom is still easing, so re-apply the bounds for the zoom actually shown.
        px.x = bound(px.x, vw / (2 * pz.x), limitX);
        py.x = bound(py.x, vh / (2 * pz.x), limitY);
      }
      return this;
    },
  };
}
