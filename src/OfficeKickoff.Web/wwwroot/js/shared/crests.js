// Team crests: one vector shape per crest id, usable both as inline SVG (lobby, scoreboard) and
// on a canvas (pitch, intro splash). Every shape is drawn in a 100 x 100 box.

export const CREST_PATHS = Object.freeze({
  shield: 'M50 4 L90 16 V50 C90 74 72 90 50 97 C28 90 10 74 10 50 V16 Z',
  circle: 'M50 5 A45 45 0 1 1 49.99 5 Z',
  diamond: 'M50 3 L95 50 L50 97 L5 50 Z',
  hexagon: 'M50 4 L91 27 V73 L50 96 L9 73 V27 Z',
  star: 'M50 4 L61.8 35.8 L95.7 37.2 L69 58.2 L78.2 90.8 L50 72 L21.8 90.8 L31 58.2 L4.3 37.2 L38.2 35.8 Z',
  bolt: 'M58 3 L18 56 H44 L36 97 L82 40 H55 Z',
  chevron: 'M10 8 H90 V62 L50 96 L10 62 Z',
  crown: 'M8 30 L28 52 L50 14 L72 52 L92 30 L84 88 H16 Z',
});

const HEX = /^#[0-9a-f]{6}$/i;

/** Returns `color` if it is a "#rrggbb" string, otherwise `fallback`. Never trust colours from the network in markup. */
export function safeColor(color, fallback = '#888888') {
  return typeof color === 'string' && HEX.test(color) ? color : fallback;
}

function shapeOf(shape) {
  return Object.prototype.hasOwnProperty.call(CREST_PATHS, shape) ? shape : 'shield';
}

let uid = 0;

/**
 * Inline SVG markup for a crest.
 * @param {string} shape     crest id (unknown ids fall back to "shield")
 * @param {string} primary   "#rrggbb" fill
 * @param {string} secondary "#rrggbb" outline and band
 * @param {{size?: number, title?: string}} [opts]
 * @returns {string} safe to assign to innerHTML (inputs are validated, the title is escaped)
 */
export function crestSvg(shape, primary, secondary, opts = {}) {
  const d = CREST_PATHS[shapeOf(shape)];
  const fill = safeColor(primary, '#3b82f6');
  const line = safeColor(secondary, '#ffffff');
  const size = Number.isFinite(opts.size) ? opts.size : 48;
  const id = `crest-clip-${++uid}`;
  const title = opts.title
    ? `<title>${String(opts.title).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)}</title>`
    : '';
  return (
    `<svg class="crest" width="${size}" height="${size}" viewBox="0 0 100 100" aria-hidden="${title ? 'false' : 'true'}">` +
    title +
    `<defs><clipPath id="${id}"><path d="${d}"/></clipPath></defs>` +
    `<path d="${d}" fill="${fill}"/>` +
    `<g clip-path="url(#${id})"><path d="M-10 78 L78 -10 L104 -10 L-10 104 Z" fill="${line}" opacity="0.9"/>` +
    `<path d="M0 0 H100 V42 H0 Z" fill="#ffffff" opacity="0.10"/></g>` +
    `<path d="${d}" fill="none" stroke="${line}" stroke-width="6" stroke-linejoin="round"/>` +
    `</svg>`
  );
}

const pathCache = new Map();

/**
 * Draws a crest centred on (x, y) on a 2D canvas.
 * @param {CanvasRenderingContext2D} ctx
 * @param {string} shape
 * @param {number} x @param {number} y  centre
 * @param {number} size  width and height in the context's current units
 * @param {string} primary @param {string} secondary
 * @param {number} [alpha=1]
 */
export function drawCrest(ctx, shape, x, y, size, primary, secondary, alpha = 1) {
  const key = shapeOf(shape);
  let path = pathCache.get(key);
  if (!path) {
    path = new Path2D(CREST_PATHS[key]);
    pathCache.set(key, path);
  }
  const fill = safeColor(primary, '#3b82f6');
  const line = safeColor(secondary, '#ffffff');
  ctx.save();
  ctx.globalAlpha *= alpha;
  ctx.translate(x - size / 2, y - size / 2);
  ctx.scale(size / 100, size / 100);
  ctx.fillStyle = fill;
  ctx.fill(path);
  ctx.save();
  ctx.clip(path);
  ctx.fillStyle = line;
  ctx.globalAlpha *= 0.9;
  ctx.beginPath();
  ctx.moveTo(-10, 78);
  ctx.lineTo(78, -10);
  ctx.lineTo(104, -10);
  ctx.lineTo(-10, 104);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
  ctx.lineJoin = 'round';
  ctx.lineWidth = 6;
  ctx.strokeStyle = line;
  ctx.stroke(path);
  ctx.restore();
}
