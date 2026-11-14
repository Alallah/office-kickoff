// Pitch geometry and small numeric helpers shared by the engine modules. Pure: no DOM.
//
// World space (same as the simulation): origin at the pitch centre, +x right, +y down, angles in
// radians measured from +x towards +y. Team 0 attacks towards +x.

export const TAU = Math.PI * 2;

export function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

export function clamp01(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

export function lerp(a, b, t) {
  return a + (b - a) * t;
}

export function smoothstep(e0, e1, x) {
  if (e0 === e1) return x < e0 ? 0 : 1;
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
}

/** v when it is a finite number, otherwise the fallback. */
export function finite(v, fallback = 0) {
  return typeof v === 'number' && v - v === 0 ? v : fallback;
}

/** Wraps an angle to (-PI, PI]. (MathUtil.WrapAngle) */
export function wrapAngle(a) {
  if (!(a - a === 0)) return 0;
  a %= TAU;
  if (a > Math.PI) a -= TAU;
  else if (a <= -Math.PI) a += TAU;
  return a;
}

/** Signed shortest rotation from `from` to `to`. (MathUtil.AngleDiff) */
export function angleDiff(from, to) {
  return wrapAngle(to - from);
}

/** Rotates current towards target by at most maxDelta. (MathUtil.MoveAngleTowards) */
export function moveAngleTowards(current, target, maxDelta) {
  const d = angleDiff(current, target);
  if (Math.abs(d) <= maxDelta) return wrapAngle(target);
  return wrapAngle(current + Math.sign(d) * maxDelta);
}

/** Interpolates along the shortest arc. */
export function lerpAngle(a, b, t) {
  return wrapAngle(a + angleDiff(a, b) * t);
}

/** Fraction of an offset left after dt when it should be gone after about `duration`. */
export function fade(dt, duration) {
  return duration > 0 ? Math.exp((-3 * dt) / duration) : 0;
}

/** +1 for the team attacking towards +x (team 0), -1 for team 1. (PitchGeometry.AttackSign) */
export function attackSign(team) {
  return team === 0 ? 1 : -1;
}

/**
 * Pitch geometry from MatchInit.pitch (mirror of PitchGeometry).
 * @param {{width:number,height:number,goalWidth:number,goalDepth:number,postRadius:number,cornerRadius:number,boxDepth:number,boxHalfWidth:number,centerRadius:number}} dto
 */
export function makePitch(dto) {
  const width = finite(dto?.width, 1500) || 1500;
  const height = finite(dto?.height, 940) || 940;
  const halfW = width / 2;
  const halfH = height / 2;
  const goalWidth = finite(dto?.goalWidth, 210);
  const goalHalf = goalWidth / 2;
  return Object.freeze({
    width,
    height,
    halfW,
    halfH,
    goalWidth,
    goalHalf,
    goalDepth: finite(dto?.goalDepth, 64),
    postRadius: finite(dto?.postRadius, 9),
    cornerRadius: clamp(finite(dto?.cornerRadius, 110), 0, Math.max(0, Math.min(halfW, halfH) - 1)),
    boxDepth: finite(dto?.boxDepth, 190),
    boxHalfWidth: finite(dto?.boxHalfWidth, 245),
    centerRadius: finite(dto?.centerRadius, 125),
    // left-top, left-bottom, right-top, right-bottom
    posts: Object.freeze([
      Object.freeze({ x: -halfW, y: -goalHalf }),
      Object.freeze({ x: -halfW, y: goalHalf }),
      Object.freeze({ x: halfW, y: -goalHalf }),
      Object.freeze({ x: halfW, y: goalHalf }),
    ]),
  });
}

/**
 * Closest position at which a circle of the given radius lies fully inside the walls (rounded
 * corners included, goal mouths treated as closed). Port of PitchGeometry.ClampCircle.
 * @param {{x:number,y:number}} out  receives the result (may be the input object)
 */
export function clampCircle(pitch, px, py, radius, out) {
  const maxX = pitch.halfW - radius;
  const maxY = pitch.halfH - radius;
  let x = px < -maxX ? -maxX : px > maxX ? maxX : px;
  let y = py < -maxY ? -maxY : py > maxY ? maxY : py;

  const cx = pitch.halfW - pitch.cornerRadius;
  const cy = pitch.halfH - pitch.cornerRadius;
  const ax = Math.abs(x);
  const ay = Math.abs(y);
  if (ax > cx && ay > cy) {
    let dx = ax - cx;
    let dy = ay - cy;
    const limit = Math.max(0, pitch.cornerRadius - radius);
    const d2 = dx * dx + dy * dy;
    if (d2 > limit * limit) {
      const d = Math.sqrt(d2);
      dx = (dx / d) * limit;
      dy = (dy / d) * limit;
      x = x < 0 ? -(cx + dx) : cx + dx;
      y = y < 0 ? -(cy + dy) : cy + dy;
    }
  }

  out.x = x;
  out.y = y;
  return out;
}
