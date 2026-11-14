// Pitch geometry and screen maths for the renderer. Pure: no canvas, no DOM.
//
// World conventions (see PitchGeometry.cs): the playing area is [-halfW, halfW] x [-halfH, halfH]
// with rounded corners; team 0 defends the LEFT goal. "side" below is 0 for the left end of the
// pitch and 1 for the right end.

import { clamp, num } from './mathx.js';

/** Validated copy of MatchInit.pitch. Every number is finite and the shape is drawable. */
export function pitchMetrics(p) {
  const src = p || {};
  const width = clamp(num(src.width, 1500), 240, 20000);
  const height = clamp(num(src.height, 940), 200, 20000);
  const halfW = width / 2, halfH = height / 2;
  const goalWidth = clamp(num(src.goalWidth, 210), 30, height - 60);
  const goalHalf = goalWidth / 2;
  return {
    width, height, halfW, halfH, goalWidth, goalHalf,
    goalDepth: clamp(num(src.goalDepth, 64), 12, 400),
    postR: clamp(num(src.postRadius, 9), 2, 40),
    cornerR: clamp(num(src.cornerRadius, 110), 0, Math.max(0, Math.min(halfW, halfH - goalHalf) - 1)),
    boxDepth: clamp(num(src.boxDepth, 190), 20, halfW - 10),
    boxHalfW: clamp(num(src.boxHalfWidth, goalHalf + 140), goalHalf, halfH - 4),
    centerR: clamp(num(src.centerRadius, 125), 10, Math.min(halfW, halfH) - 10),
  };
}

/** -1 for the left end, +1 for the right end. */
export function sideSign(side) {
  return side === 0 ? -1 : 1;
}

/** Length of the outline of a rounded rectangle with half extents (hw, hh) and corner radius cr. */
export function loopLength(hw, hh, cr) {
  return 4 * (hw - cr) + 4 * (hh - cr) + 2 * Math.PI * cr;
}

/**
 * Point and outward normal at arc length s along a rounded rectangle centred on the origin.
 * The loop starts where the left edge meets the top-left corner and runs clockwise on screen
 * (top edge left to right first). s wraps.
 */
export function loopPoint(hw, hh, cr, s, out) {
  const total = loopLength(hw, hh, cr);
  let d = s % total;
  if (d < 0) d += total;
  const qa = Math.PI * cr / 2;
  const tx = 2 * (hw - cr), ty = 2 * (hh - cr);

  for (let seg = 0; seg < 8; seg++) {
    const isArc = (seg & 1) === 0;
    const len = isArc ? qa : (seg === 1 || seg === 5 ? tx : ty);
    if (d > len && seg < 7) {
      d -= len;
      continue;
    }
    if (isArc) {
      // Corners in order: top-left, top-right, bottom-right, bottom-left.
      const corner = seg >> 1;
      const cx = corner === 0 || corner === 3 ? -hw + cr : hw - cr;
      const cy = corner < 2 ? -hh + cr : hh - cr;
      const a = Math.PI + corner * (Math.PI / 2) + (cr > 0 ? d / cr : 0);
      const nx = Math.cos(a), ny = Math.sin(a);
      out.x = cx + nx * cr;
      out.y = cy + ny * cr;
      out.nx = nx;
      out.ny = ny;
    } else if (seg === 1) {
      out.x = -hw + cr + d; out.y = -hh; out.nx = 0; out.ny = -1;
    } else if (seg === 3) {
      out.x = hw; out.y = -hh + cr + d; out.nx = 1; out.ny = 0;
    } else if (seg === 5) {
      out.x = hw - cr - d; out.y = hh; out.nx = 0; out.ny = 1;
    } else {
      out.x = -hw; out.y = hh - cr - Math.min(d, ty); out.nx = -1; out.ny = 0;
    }
    return out;
  }
  return out;
}

/** Samples a rounded rectangle outline every `step` units (adjusted so the samples close the loop evenly). */
export function buildLoop(hw, hh, cr, step) {
  const total = loopLength(hw, hh, cr);
  const n = Math.max(8, Math.round(total / Math.max(1, step)));
  const loop = {
    n, total, step: total / n,
    x: new Float32Array(n), y: new Float32Array(n),
    nx: new Float32Array(n), ny: new Float32Array(n),
    gap: new Uint8Array(n),
  };
  const pt = { x: 0, y: 0, nx: 0, ny: 0 };
  for (let i = 0; i < n; i++) {
    loopPoint(hw, hh, cr, i * loop.step, pt);
    loop.x[i] = pt.x;
    loop.y[i] = pt.y;
    loop.nx[i] = pt.nx;
    loop.ny[i] = pt.ny;
  }
  return loop;
}

/** The wall of the pitch as a sampled loop; samples that fall in a goal mouth are flagged in loop.gap. */
export function buildWallLoop(pm, step) {
  const loop = buildLoop(pm.halfW, pm.halfH, pm.cornerR, step);
  for (let i = 0; i < loop.n; i++) {
    const onEnd = Math.abs(loop.x[i]) > pm.halfW - 0.5;
    loop.gap[i] = onEnd && Math.abs(loop.y[i]) < pm.goalHalf ? 1 : 0;
  }
  return loop;
}

/** Index of the loop sample nearest to (x, y). */
export function nearestLoopIndex(loop, x, y) {
  let best = 0, bestD = Infinity;
  for (let i = 0; i < loop.n; i++) {
    const dx = loop.x[i] - x, dy = loop.y[i] - y;
    const d = dx * dx + dy * dy;
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

/** World rectangle shown by a camera, grown by marginPx screen pixels on every side. */
export function visibleRect(camX, camY, zoom, vw, vh, marginPx, out) {
  const z = zoom > 1e-6 ? zoom : 1e-6;
  const hx = (vw / 2 + marginPx) / z, hy = (vh / 2 + marginPx) / z;
  out.x0 = camX - hx;
  out.x1 = camX + hx;
  out.y0 = camY - hy;
  out.y1 = camY + hy;
  return out;
}

/** True when the playing area and both nets lie inside the rectangle. */
export function pitchInside(pm, rect) {
  const ex = pm.halfW + pm.goalDepth;
  return rect.x0 <= -ex && rect.x1 >= ex && rect.y0 <= -pm.halfH && rect.y1 >= pm.halfH;
}

/**
 * Where to put an off-screen indicator for a target at screen position (sx, sy).
 * Returns false when the target is on screen. Otherwise fills out.x / out.y with the point where
 * the line from the screen centre to the target crosses the viewport inset by `inset`, and
 * out.ang with the direction towards the target.
 */
export function edgePoint(sx, sy, vw, vh, inset, out) {
  if (sx >= 0 && sx <= vw && sy >= 0 && sy <= vh) return false;
  const cx = vw / 2, cy = vh / 2;
  const hx = cx - inset, hy = cy - inset;
  if (!(hx > 0 && hy > 0)) return false;
  const dx = sx - cx, dy = sy - cy;
  const ax = Math.abs(dx), ay = Math.abs(dy);
  const t = Math.min(ax > 1e-6 ? hx / ax : Infinity, ay > 1e-6 ? hy / ay : Infinity);
  if (!(t < Infinity)) return false;
  out.x = cx + dx * t;
  out.y = cy + dy * t;
  out.ang = Math.atan2(dy, dx);
  return true;
}

/** Pixels per world unit for a cached layer: the wanted scale, limited so the bitmap stays affordable. */
export function layerScale(target, worldW, worldH, maxDim, maxArea) {
  const s = Math.min(target, maxDim / worldW, maxDim / worldH, Math.sqrt(maxArea / (worldW * worldH)));
  return s > 0.05 ? s : 0.05;
}

/**
 * Decides when a cached layer drawn at `current` px/unit should be re-rendered for `target`.
 * A small mismatch is tolerated (the bitmap is simply scaled); a visible one waits until the
 * zoom has settled so a smooth zoom does not re-render every frame; a large one does not wait.
 */
export function layerStale(current, target, settledSeconds) {
  if (!(current > 0)) return true;
  const ratio = target / current;
  if (ratio > 1.5 || ratio < 0.4) return settledSeconds > 0.05;
  if (ratio > 1.04 || ratio < 0.7) return settledSeconds > 0.25;
  return false;
}

/** Last word of a roster name ("Rico Vale" -> "Vale"). */
export function surname(name) {
  const s = typeof name === 'string' ? name.trim() : '';
  if (!s) return '';
  const cut = s.lastIndexOf(' ');
  return cut >= 0 ? s.slice(cut + 1) : s;
}

/**
 * Distance from the centre of an ellipse with semi-axes (a along `dir`, b across it) to its edge
 * in direction `ang`. Used to keep markers on the edge of a stretched footballer.
 */
export function ellipseRadius(a, b, dir, ang) {
  const c = Math.cos(ang - dir), s = Math.sin(ang - dir);
  const q = (c * c) / (a * a) + (s * s) / (b * b);
  return q > 1e-9 ? 1 / Math.sqrt(q) : a;
}

/** Layout of the stands around a pitch: where the crowd sits and how big the cached layers are. */
export function standGeometry(pm) {
  // The camera never shows more than about 110 units beyond the pitch, so the front rows sit
  // close: near enough to be seen along the touchlines, clear of the nets behind the goals.
  const ax = pm.goalDepth + 30;   // gap behind each goal line
  const ay = 42;                  // gap along the touchlines
  const rows = 11, rowGap = 17;
  const depth = rows * rowGap;
  const marginX = ax + depth + 30, marginY = ay + depth + 30;
  // The front of the stands is a rounded rectangle with half extents (halfW + ax, halfH + ay);
  // its corners are the pitch's corners pushed out by the touchline gap.
  const cr = pm.cornerR + ay;
  return {
    ax, ay, rows, rowGap, depth, marginX, marginY, cr,
    x0: -(pm.halfW + marginX), y0: -(pm.halfH + marginY),
    w: 2 * (pm.halfW + marginX), h: 2 * (pm.halfH + marginY),
    // The crowd is cached in four strips. Seats with |y| > yCut go to the top / bottom strip
    // (these run the full width, corners included); the rest go to the left / right strip,
    // whose inner edge is at |x| = xCut.
    yCut: pm.halfH + ay - 9,
    xCut: pm.halfW + ax - 9,
    // Half lengths of the straight parts of the stands (aisles only cut through those).
    straightX: Math.max(0, pm.halfW + ax - cr),
    straightY: Math.max(0, pm.halfH - pm.cornerR),
  };
}

const AISLE_GAP = 240, AISLE_HALF = 8.5;

/**
 * Centres of the aisles along one straight stand, as offsets from its middle. Along the
 * touchlines they sit at +-120, +-360, ... so the halfway line faces seats; behind the goals at
 * 0, +-240, ... so there is a tunnel behind each net.
 * @param touchline  true for the top / bottom stands
 * @returns {number[]}
 */
export function aisleCentres(st, touchline) {
  const out = [];
  const limit = (touchline ? st.straightX : st.straightY) - AISLE_HALF;
  for (let c = touchline ? AISLE_GAP / 2 : 0; c <= limit; c += AISLE_GAP) {
    out.push(c);
    if (c > 0) out.push(-c);
  }
  return out;
}

/** True when a seat at (x, y) would stand in an aisle. */
export function inAisle(st, x, y) {
  const ax = Math.abs(x), ay = Math.abs(y);
  const touchline = ay > st.yCut;
  const along = touchline ? ax : ay;
  if (along > (touchline ? st.straightX : st.straightY)) return false;
  const d = (((along - (touchline ? AISLE_GAP / 2 : 0)) % AISLE_GAP) + AISLE_GAP) % AISLE_GAP;
  return Math.min(d, AISLE_GAP - d) < AISLE_HALF;
}

export const AISLE_WIDTH = AISLE_HALF * 2;

/**
 * Every spectator's seat: rows of seats following the rounded front of the stands.
 * strip: 0 = top, 1 = bottom, 2 = left end, 3 = right end. group: which of the three
 * interleaved crowd layers the spectator bobs with. tone: 0..1, picks the clothes.
 * @param rng  seeded generator returning 0..1
 */
export function buildSeats(pm, st, rng) {
  const gap = 15;
  let cap = 0;
  for (let r = 0; r < st.rows; r++) {
    const off = (r + 0.5) * st.rowGap;
    cap += Math.floor(loopLength(pm.halfW + st.ax + off, pm.halfH + st.ay + off, st.cr + off) / gap);
  }
  const seats = {
    n: 0,
    x: new Float32Array(cap), y: new Float32Array(cap),
    nx: new Float32Array(cap), ny: new Float32Array(cap),
    tone: new Float32Array(cap),
    row: new Uint8Array(cap), strip: new Uint8Array(cap), group: new Uint8Array(cap),
  };
  const pt = { x: 0, y: 0, nx: 0, ny: 0 };
  for (let r = 0; r < st.rows; r++) {
    const off = (r + 0.5) * st.rowGap;
    const hw = pm.halfW + st.ax + off, hh = pm.halfH + st.ay + off, cr = st.cr + off;
    const total = loopLength(hw, hh, cr);
    const count = Math.floor(total / gap);
    if (count < 1) continue;
    const step = total / count;
    for (let k = 0; k < count; k++) {
      // Alternate rows are offset by half a seat, like real terraces.
      loopPoint(hw, hh, cr, (k + (r & 1) * 0.5) * step, pt);
      const tone = rng(), group = rng(), empty = rng();
      if (empty < 0.06 || inAisle(st, pt.x, pt.y)) continue;
      const i = seats.n++;
      seats.x[i] = pt.x;
      seats.y[i] = pt.y;
      seats.nx[i] = pt.nx;
      seats.ny[i] = pt.ny;
      seats.tone[i] = tone;
      seats.row[i] = r;
      seats.group[i] = group < 1 / 3 ? 0 : group < 2 / 3 ? 1 : 2;
      seats.strip[i] = Math.abs(pt.y) > st.yCut ? (pt.y < 0 ? 0 : 1) : pt.x < 0 ? 2 : 3;
    }
  }
  return seats;
}

/** World rectangle of one crowd strip (see standGeometry): 0 = top, 1 = bottom, 2 = left, 3 = right. */
export function stripRect(st, strip, out) {
  if (strip < 2) {
    out.x = st.x0;
    out.w = st.w;
    out.h = -st.yCut - st.y0;
    out.y = strip === 0 ? st.y0 : st.yCut;
  } else {
    out.y = -st.yCut;
    out.h = 2 * st.yCut;
    out.w = -st.xCut - st.x0;
    out.x = strip === 2 ? st.x0 : st.xCut;
  }
  return out;
}

/**
 * World -> device-pixel matrix of a frame (a, b, c, d, e, f of a canvas transform). It is the
 * contract's camera formula
 *     sx = (wx - cam.x) * zoom + vw / 2,   sy = (wy - cam.y) * zoom + vh / 2      (CSS pixels)
 * times the backing-store ratio, with the renderer's purely visual extras on top: a shake offset
 * (ox, oy, CSS pixels), and a roll and a zoom punch about the centre of the screen.
 */
export function worldMatrix(out, camX, camY, zoom, vw, vh, dpr, ox, oy, rot, punch) {
  const k = zoom * punch * dpr;
  const c = Math.cos(rot) * k, s = Math.sin(rot) * k;
  out.a = c;
  out.b = s;
  out.c = -s;
  out.d = c;
  out.e = (vw / 2 + ox) * dpr - (c * camX - s * camY);
  out.f = (vh / 2 + oy) * dpr - (s * camX + c * camY);
  return out;
}

/**
 * Backing-store pixels per CSS pixel: the device ratio, scaled by the quality governor and
 * capped so the canvas never holds more than maxPixels (what an integrated GPU fills at 60 fps).
 */
export function effectiveDpr(cssW, cssH, dpr, scale, maxPixels) {
  const d = clamp(num(dpr, 1), 0.5, 4) * clamp(num(scale, 1), 0.25, 1);
  const area = cssW * cssH;
  if (!(area > 0) || !(maxPixels > 0)) return d;
  return Math.min(d, Math.sqrt(maxPixels / area));
}

/**
 * Where the minimap goes: the bottom-right corner, 16 px in, at most 220 x 150 CSS pixels
 * (the DOM overlays keep that corner free) and never more than a third of a small window.
 * out.s is map pixels per world unit; (out.cx, out.cy) is where the pitch centre lands.
 */
export function minimapLayout(pm, vw, vh, out) {
  const pad = 7, inset = 16;
  const worldW = pm.width + 2 * (pm.goalDepth + 4), worldH = pm.height + 8;
  const maxW = Math.min(220, vw / 3), maxH = Math.min(150, vh / 3);
  const s = Math.min((maxW - 2 * pad) / worldW, (maxH - 2 * pad) / worldH);
  out.s = s > 0 ? s : 0;
  out.w = worldW * out.s + 2 * pad;
  out.h = worldH * out.s + 2 * pad;
  out.x = vw - inset - out.w;
  out.y = vh - inset - out.h;
  out.cx = out.x + out.w / 2;
  out.cy = out.y + out.h / 2;
  out.ok = out.s > 0.02 && out.x > 0 && out.y > 0;
  return out;
}

/** Index (0..3: left-top, left-bottom, right-top, right-bottom) of the goal post nearest to (x, y). */
export function nearestPost(pm, x, y) {
  return (x < 0 ? 0 : 2) + (y < 0 ? 0 : 1);
}

/** Centre of goal post k (same order as PitchGeometry.Posts). */
export function postX(pm, k) {
  return k < 2 ? -pm.halfW : pm.halfW;
}

export function postY(pm, k) {
  return (k & 1) === 0 ? -pm.goalHalf : pm.goalHalf;
}
