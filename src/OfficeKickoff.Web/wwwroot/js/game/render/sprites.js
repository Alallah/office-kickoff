// Offscreen canvases: soft sprites tinted per colour, shadows, vignettes and text labels.
// Glows are drawn here once with gradients so the frame path only ever blits them
// (no shadowBlur and no per-frame gradients anywhere in the renderer).

import { TAU } from './mathx.js';
import { HEAT_STOPS, lighten, ramp, rgba } from './color.js';
import { heartPath, starPath } from './shapes.js';

export const FONT_DISPLAY = '"Bahnschrift", "DIN Alternate", "Oswald", "Arial Narrow", "Segoe UI", system-ui, sans-serif';
export const FONT_EMOJI = '"Segoe UI Emoji", "Apple Color Emoji", "Noto Color Emoji", sans-serif';

const MAX_CANVAS = 8192;

/** A canvas of at least 1 x 1 device pixels. */
export function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.min(MAX_CANVAS, Math.ceil(w) || 1));
  c.height = Math.max(1, Math.min(MAX_CANVAS, Math.ceil(h) || 1));
  return c;
}

function radial(g, size, stops) {
  const h = size / 2;
  const grad = g.createRadialGradient(h, h, 0, h, h, h);
  for (let i = 0; i < stops.length; i += 2) grad.addColorStop(stops[i], stops[i + 1]);
  g.fillStyle = grad;
  g.fillRect(0, 0, size, size);
}

function buildGlow(hex) {
  const c = makeCanvas(64, 64);
  radial(c.getContext('2d'), 64, [
    0, rgba(lighten(hex, 0.7), 1),
    0.22, rgba(lighten(hex, 0.25), 0.8),
    0.55, rgba(hex, 0.28),
    1, rgba(hex, 0),
  ]);
  return c;
}

function buildPuff(hex) {
  const c = makeCanvas(64, 64);
  radial(c.getContext('2d'), 64, [0, rgba(hex, 0.6), 0.5, rgba(hex, 0.36), 1, rgba(hex, 0)]);
  return c;
}

function buildStar(hex) {
  const c = makeCanvas(48, 48);
  const g = c.getContext('2d');
  g.lineJoin = 'round';
  g.beginPath();
  starPath(g, 24, 25, 5, 21, 9.5, -Math.PI / 2);
  g.fillStyle = hex;
  g.fill();
  g.lineWidth = 2;
  g.strokeStyle = rgba(lighten(hex, 0.55), 0.9);
  g.stroke();
  g.beginPath();
  starPath(g, 24, 25, 5, 10, 4.5, -Math.PI / 2);
  g.fillStyle = rgba(lighten(hex, 0.7), 0.9);
  g.fill();
  return c;
}

function buildHeart(hex) {
  const c = makeCanvas(48, 48);
  const g = c.getContext('2d');
  g.beginPath();
  heartPath(g, 24, 25, 40);
  g.fillStyle = hex;
  g.fill();
  g.lineWidth = 2;
  g.strokeStyle = rgba(lighten(hex, 0.5), 0.9);
  g.stroke();
  g.beginPath();
  g.ellipse(16, 17, 5, 3.2, -0.6, 0, TAU);
  g.fillStyle = 'rgba(255,255,255,0.55)';
  g.fill();
  return c;
}

/**
 * Shadow of something standing under four corner floodlights: a dark contact patch and four
 * faint shadows fanning out diagonally. The sprite spans 6.4 radii of the thing that casts it.
 */
function buildFloodShadow() {
  const size = 128, unit = 20, c = makeCanvas(size, size);
  const g = c.getContext('2d');
  const mid = size / 2;
  const contact = g.createRadialGradient(mid, mid + 2, 0, mid, mid + 2, unit * 1.3);
  contact.addColorStop(0, 'rgba(0,0,0,0.42)');
  contact.addColorStop(0.7, 'rgba(0,0,0,0.26)');
  contact.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = contact;
  g.fillRect(0, 0, size, size);
  for (let k = 0; k < 4; k++) {
    g.save();
    g.translate(mid, mid);
    g.rotate(Math.PI / 4 + (k * Math.PI) / 2);
    g.translate(unit * 1.0, 0);
    g.scale(1.55, 0.72);
    const arm = g.createRadialGradient(0, 0, 0, 0, 0, unit);
    arm.addColorStop(0, 'rgba(0,0,0,0.2)');
    arm.addColorStop(0.6, 'rgba(0,0,0,0.12)');
    arm.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = arm;
    g.beginPath();
    g.arc(0, 0, unit, 0, TAU);
    g.fill();
    g.restore();
  }
  return c;
}

/** Shading laid over the ball: lit from the top left, dark towards the bottom right. */
function buildBallShade() {
  const size = 64, c = makeCanvas(size, size);
  const g = c.getContext('2d');
  g.beginPath();
  g.arc(32, 32, 31.5, 0, TAU);
  g.clip();
  const grad = g.createRadialGradient(24, 22, 4, 32, 32, 34);
  grad.addColorStop(0, 'rgba(255,255,255,0.3)');
  grad.addColorStop(0.35, 'rgba(255,255,255,0)');
  grad.addColorStop(0.72, 'rgba(12,22,48,0.1)');
  grad.addColorStop(1, 'rgba(12,22,48,0.5)');
  g.fillStyle = grad;
  g.fillRect(0, 0, size, size);
  return c;
}

/** Clear in the middle, the given colour towards the corners. Stretched over the whole view. */
function buildVignette(r, gr, b, edgeAlpha) {
  const size = 256, c = makeCanvas(size, size);
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(128, 128, size * 0.26, 128, 128, size * 0.72);
  grad.addColorStop(0, `rgba(${r},${gr},${b},0)`);
  grad.addColorStop(0.55, `rgba(${r},${gr},${b},${(edgeAlpha * 0.4).toFixed(3)})`);
  grad.addColorStop(1, `rgba(${r},${gr},${b},${edgeAlpha})`);
  g.fillStyle = grad;
  g.fillRect(0, 0, size, size);
  return c;
}

/** Horizontal scan lines, tiled over the picture during replays. */
function buildScanTile() {
  const c = makeCanvas(4, 4);
  const g = c.getContext('2d');
  g.fillStyle = 'rgba(255,255,255,0.05)';
  g.fillRect(0, 0, 4, 1);
  g.fillStyle = 'rgba(0,0,0,0.07)';
  g.fillRect(0, 2, 4, 1);
  return c;
}

/** A soft horizontal band of light (1 px wide, stretched across the screen). */
function buildBand() {
  const c = makeCanvas(1, 64);
  const g = c.getContext('2d');
  const grad = g.createLinearGradient(0, 0, 0, 64);
  grad.addColorStop(0, 'rgba(190,225,255,0)');
  grad.addColorStop(0.5, 'rgba(190,225,255,0.16)');
  grad.addColorStop(1, 'rgba(190,225,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 1, 64);
  return c;
}

/**
 * Sprite store. Tinted sprites are keyed by palette id and built on first use.
 * @param pal  palette from color.createPalette()
 */
export function createSprites(pal) {
  const glow = [], puff = [], star = [], heart = [];
  let flame = null, shadow = null, ballShade = null, vigDark = null, vigGold = null, scan = null, band = null;

  return {
    glow(id) {
      return glow[id] || (glow[id] = buildGlow(pal.css[id] || '#ffffff'));
    },
    puff(id) {
      return puff[id] || (puff[id] = buildPuff(pal.css[id] || '#ffffff'));
    },
    star(id) {
      return star[id] || (star[id] = buildStar(pal.css[id] || '#ffffff'));
    },
    heart(id) {
      return heart[id] || (heart[id] = buildHeart(pal.css[id] || '#ffffff'));
    },
    /** Eight glows along the heat ramp: index 0 is white hot, 7 is dull orange-red. */
    flame() {
      if (!flame) flame = ramp(HEAT_STOPS, 8).map(buildGlow);
      return flame;
    },
    shadow() {
      return shadow || (shadow = buildFloodShadow());
    },
    ballShade() {
      return ballShade || (ballShade = buildBallShade());
    },
    vignetteDark() {
      return vigDark || (vigDark = buildVignette(2, 4, 12, 0.62));
    },
    vignetteGold() {
      return vigGold || (vigGold = buildVignette(255, 196, 70, 0.5));
    },
    scanTile() {
      return scan || (scan = buildScanTile());
    },
    band() {
      return band || (band = buildBand());
    },
    /** Forget the tinted sprites (the palette was reset). */
    clearTinted() {
      glow.length = 0;
      puff.length = 0;
      star.length = 0;
      heart.length = 0;
    },
  };
}

let measureCtx = null;

/**
 * Renders a line of text with a dark outline into its own canvas.
 * @returns {{c: HTMLCanvasElement, w: number, h: number}} canvas plus its size in CSS pixels
 */
export function buildLabel(text, px, color, dpr, weight = 700) {
  const font = `${weight} ${px}px ${FONT_DISPLAY}`;
  if (!measureCtx) measureCtx = makeCanvas(1, 1).getContext('2d');
  measureCtx.font = font;
  const pad = 4;
  const w = Math.ceil(measureCtx.measureText(text).width) + pad * 2;
  const h = Math.ceil(px * 1.45) + pad;
  const c = makeCanvas(w * dpr, h * dpr);
  const g = c.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.font = font;
  g.textAlign = 'center';
  g.textBaseline = 'alphabetic';
  g.lineJoin = 'round';
  g.lineWidth = 3;
  g.strokeStyle = 'rgba(4,8,18,0.85)';
  const base = px * 1.08 + pad / 2;
  g.strokeText(text, w / 2, base);
  g.fillStyle = color;
  g.fillText(text, w / 2, base);
  return { c, w, h };
}

export const BUBBLE_W = 56, BUBBLE_H = 62;

/** Draws a speech bubble holding one emoji into an existing canvas (resized to fit the dpr). */
export function paintBubble(canvas, emoji, dpr) {
  const w = Math.ceil(BUBBLE_W * dpr), h = Math.ceil(BUBBLE_H * dpr);
  if (canvas.width !== w) canvas.width = w;
  if (canvas.height !== h) canvas.height = h;
  const g = canvas.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, BUBBLE_W, BUBBLE_H);
  const x0 = 3, y0 = 3, x1 = BUBBLE_W - 3, y1 = 47, r = 15, mid = BUBBLE_W / 2;
  g.beginPath();
  g.moveTo(x0 + r, y0);
  g.lineTo(x1 - r, y0);
  g.arc(x1 - r, y0 + r, r, -Math.PI / 2, 0);
  g.lineTo(x1, y1 - r);
  g.arc(x1 - r, y1 - r, r, 0, Math.PI / 2);
  g.lineTo(mid + 7, y1);
  g.lineTo(mid, y1 + 11);
  g.lineTo(mid - 7, y1);
  g.lineTo(x0 + r, y1);
  g.arc(x0 + r, y1 - r, r, Math.PI / 2, Math.PI);
  g.lineTo(x0, y0 + r);
  g.arc(x0 + r, y0 + r, r, Math.PI, Math.PI * 1.5);
  g.closePath();
  g.fillStyle = 'rgba(255,255,255,0.97)';
  g.fill();
  g.lineJoin = 'round';
  g.lineWidth = 2;
  g.strokeStyle = 'rgba(8,12,24,0.6)';
  g.stroke();
  g.font = `28px ${FONT_EMOJI}`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillStyle = '#111111';
  g.fillText(emoji, mid, (y0 + y1) / 2 + 1.5);
}
