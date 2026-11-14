// Colour maths on "#rrggbb" strings. Pure: no canvas, no DOM.

const HEX6 = /^#[0-9a-f]{6}$/i;

export function isHex(c) {
  return typeof c === 'string' && HEX6.test(c);
}

/** c as a lower-case "#rrggbb", or the fallback when it is anything else. Colours arrive from the network. */
export function hexOr(c, fallback) {
  return isHex(c) ? c.toLowerCase() : fallback;
}

/** [r, g, b] in 0..255; mid grey for invalid input. */
export function rgbOf(hex) {
  if (!isHex(hex)) return [128, 128, 128];
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function hex2(v) {
  const b = v < 0 ? 0 : v > 255 ? 255 : Math.round(v);
  return (b < 16 ? '0' : '') + b.toString(16);
}

export function hexOf(r, g, b) {
  return `#${hex2(r)}${hex2(g)}${hex2(b)}`;
}

export function mix(a, b, t) {
  const ca = rgbOf(a), cb = rgbOf(b);
  const k = t < 0 ? 0 : t > 1 ? 1 : t;
  return hexOf(ca[0] + (cb[0] - ca[0]) * k, ca[1] + (cb[1] - ca[1]) * k, ca[2] + (cb[2] - ca[2]) * k);
}

export function lighten(hex, t) {
  return mix(hex, '#ffffff', t);
}

export function darken(hex, t) {
  return mix(hex, '#000000', t);
}

export function rgba(hex, alpha) {
  const c = rgbOf(hex);
  return `rgba(${c[0]},${c[1]},${c[2]},${alpha})`;
}

function linear(v) {
  const s = v / 255;
  return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}

/** Relative luminance, 0 (black) .. 1 (white). */
export function luminance(hex) {
  const c = rgbOf(hex);
  return 0.2126 * linear(c[0]) + 0.7152 * linear(c[1]) + 0.0722 * linear(c[2]);
}

/** Shirt-number ink for a fill colour. The threshold keeps white on mid tones such as red and royal blue. */
export function inkOn(hex) {
  return luminance(hex) > 0.36 ? '#111111' : '#ffffff';
}

/** Moves a colour towards the grey of the same brightness (t = 1 is fully grey). */
export function desaturate(hex, t) {
  const c = rgbOf(hex);
  const grey = 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2];
  return mix(hex, hexOf(grey, grey, grey), t);
}

/** Lightens a colour until it is bright enough to read as an accent on the dark pitch. */
export function vivid(hex, minLuminance = 0.2) {
  let h = hexOr(hex, '#ffffff');
  for (let i = 0; i < 10 && luminance(h) < minLuminance; i++) h = mix(h, '#ffffff', 0.18);
  return h;
}

/** n colours evenly sampled along a list of stops. */
export function ramp(stops, n) {
  const out = new Array(n);
  const last = stops.length - 1;
  for (let i = 0; i < n; i++) {
    const t = n > 1 ? (i / (n - 1)) * last : 0;
    const k = Math.min(last, Math.floor(t));
    out[i] = mix(stops[k], stops[Math.min(last, k + 1)], t - k);
  }
  return out;
}

/** Ball trail and fire: white through yellow to orange-red as things heat up. */
export const HEAT_STOPS = Object.freeze(['#ffffff', '#fff4c2', '#ffd166', '#ff9a2e', '#ff5a1f']);

/** The same ramp in sixteen steps, for things drawn per frame (trail, charge arc, power bar). */
export const HEAT16 = Object.freeze(ramp(HEAT_STOPS, 16));

/**
 * Registry that turns colours into small integers, so pooled effects store a colour in a typed
 * array and the draw loop reuses one string (and one tinted sprite) per colour.
 */
export function createPalette() {
  const css = [];
  const index = new Map();
  return {
    /** Colour strings by id. */
    css,
    id(hex) {
      const key = hexOr(hex, '#888888');
      let i = index.get(key);
      if (i === undefined) {
        i = css.length;
        css.push(key);
        index.set(key, i);
      }
      return i;
    },
    clear() {
      css.length = 0;
      index.clear();
    },
  };
}
