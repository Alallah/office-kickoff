// Path builders and transform helpers shared by the drawing modules. Every function takes the
// thing to draw on (a 2D context, or a Path2D where noted) and allocates nothing.

import { TAU } from './mathx.js';

/**
 * Appends a rounded rectangle centred on (cx, cy) with half extents (hw, hh). Works on a context
 * or a Path2D. (ctx.roundRect is too new to rely on.)
 */
export function roundRectPath(p, hw, hh, cr, cx = 0, cy = 0) {
  const r = Math.max(0, Math.min(cr, hw, hh));
  p.moveTo(cx - hw + r, cy - hh);
  p.lineTo(cx + hw - r, cy - hh);
  if (r > 0) p.arc(cx + hw - r, cy - hh + r, r, -Math.PI / 2, 0);
  p.lineTo(cx + hw, cy + hh - r);
  if (r > 0) p.arc(cx + hw - r, cy + hh - r, r, 0, Math.PI / 2);
  p.lineTo(cx - hw + r, cy + hh);
  if (r > 0) p.arc(cx - hw + r, cy + hh - r, r, Math.PI / 2, Math.PI);
  p.lineTo(cx - hw, cy - hh + r);
  if (r > 0) p.arc(cx - hw + r, cy - hh + r, r, Math.PI, Math.PI * 1.5);
  p.closePath();
}

/**
 * Appends one half of the wall around the pitch, `off` units outside the playing area: from the
 * left goal post, round the two corners, to the right goal post. sign -1 = the half above the
 * goals (y < 0), +1 = the half below. The goal mouths stay open.
 */
export function boardHalfPath(p, pm, off, sign) {
  const hw = pm.halfW + off, hh = pm.halfH + off, cr = pm.cornerR + off;
  p.moveTo(-hw, sign * pm.goalHalf);
  p.lineTo(-hw, sign * (hh - cr));
  if (sign < 0) p.arc(-hw + cr, -hh + cr, cr, Math.PI, Math.PI * 1.5);
  else p.arc(-hw + cr, hh - cr, cr, Math.PI, Math.PI / 2, true);
  p.lineTo(hw - cr, sign * hh);
  if (sign < 0) p.arc(hw - cr, -hh + cr, cr, Math.PI * 1.5, TAU);
  else p.arc(hw - cr, hh - cr, cr, Math.PI / 2, 0, true);
  p.lineTo(hw, sign * pm.goalHalf);
}

/** Appends a star with `spikes` points: outer radius ro, inner radius ri, first point at angle rot. */
export function starPath(p, cx, cy, spikes, ro, ri, rot) {
  const n = spikes * 2;
  for (let i = 0; i < n; i++) {
    const a = rot + (i * Math.PI) / spikes;
    const r = (i & 1) === 0 ? ro : ri;
    const x = cx + Math.cos(a) * r, y = cy + Math.sin(a) * r;
    if (i === 0) p.moveTo(x, y);
    else p.lineTo(x, y);
  }
  p.closePath();
}

/** Appends a heart about `size` wide and tall, centred on (cx, cy). */
export function heartPath(p, cx, cy, size) {
  const s = size / 2;
  p.moveTo(cx, cy + s * 0.9);
  p.bezierCurveTo(cx - s * 1.45, cy - s * 0.05, cx - s * 0.75, cy - s * 1.15, cx, cy - s * 0.4);
  p.bezierCurveTo(cx + s * 0.75, cy - s * 1.15, cx + s * 1.45, cy - s * 0.05, cx, cy + s * 0.9);
  p.closePath();
}

/** Appends an isosceles triangle pointing along `ang`: tip `tip` from (cx, cy), base `base` from it, half-width hw. */
export function arrowPath(p, cx, cy, ang, tip, base, hw) {
  const c = Math.cos(ang), s = Math.sin(ang);
  p.moveTo(cx + c * tip, cy + s * tip);
  p.lineTo(cx + c * base - s * hw, cy + s * base + c * hw);
  p.lineTo(cx + c * base + s * hw, cy + s * base - c * hw);
  p.closePath();
}

/** Makes the context draw in world units through the frame's world matrix W (device pixels). */
export function setWorld(ctx, W) {
  ctx.setTransform(W.a, W.b, W.c, W.d, W.e, W.f);
}

/**
 * Makes the context draw in a footballer's local frame: the 2x2 pose matrix m (a, b, c, d)
 * placed at world point (x, y), seen through the world matrix W.
 */
export function setLocal(ctx, W, m, x, y) {
  ctx.setTransform(
    W.a * m.a + W.c * m.b,
    W.b * m.a + W.d * m.b,
    W.a * m.c + W.c * m.d,
    W.b * m.c + W.d * m.d,
    W.a * x + W.c * y + W.e,
    W.b * x + W.d * y + W.f,
  );
}

/** World units at (x, y), no local deformation: the world matrix moved so (x, y) is the origin. */
export function setWorldAt(ctx, W, x, y) {
  ctx.setTransform(W.a, W.b, W.c, W.d, W.a * x + W.c * y + W.e, W.b * x + W.d * y + W.f);
}
