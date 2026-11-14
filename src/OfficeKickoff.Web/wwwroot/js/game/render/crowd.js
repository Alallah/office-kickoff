// The stands and the people in them. Both are painted once into cached layers (layers.js):
// paintStands() the terraces fading into the night, paintCrowd() one third of the spectators of
// one stand. Per frame the twelve crowd layers are only blitted, each lifted by its own hop.

import { hash01, TAU } from './mathx.js';
import { lighten, mix, rgba } from './color.js';
import { AISLE_WIDTH, aisleCentres } from './geom.js';
import { BOARD_T, NIGHT } from './look.js';
import { roundRectPath } from './shapes.js';
import { crowdLift } from './crowdfx.js';

const TIER = '#151f3c';
const TIER_ALT = '#1b2647';
const APRON = '#0e1629';
const FENCE = '#27345c';
const SKIN = ['#f1c9a5', '#d9a577', '#b07a4f', '#7d5233', '#e8b98f'];
const NEUTRAL = ['#3a4566', '#59627d', '#8b93a8', '#2b3350', '#c8cedb'];
const HAT = '#20202a';

/**
 * Paints the empty stadium around the pitch. `g` must already map world units to the layer's
 * pixels; the layer covers model.stands (x0, y0, w, h).
 */
export function paintStands(g, M) {
  const pm = M.pm, st = M.stands;
  const hw0 = pm.halfW + st.ax, hh0 = pm.halfH + st.ay;
  const last = Math.max(1, st.rows - 1);

  g.fillStyle = NIGHT;
  g.fillRect(st.x0, st.y0, st.w, st.h);

  // Terraces from the back row forward: every tier covers the inside of the one behind it, and
  // the further back, the deeper into the night.
  for (let r = st.rows - 1; r >= 0; r--) {
    const out = (r + 1) * st.rowGap;
    const far = Math.pow(r / last, 0.8);
    g.fillStyle = mix(r & 1 ? TIER_ALT : TIER, NIGHT, 0.12 + 0.82 * far);
    g.beginPath();
    roundRectPath(g, hw0 + out, hh0 + out, st.cr + out);
    g.fill();
  }
  g.lineWidth = 1.2;
  for (let r = 1; r < st.rows; r++) {
    const out = r * st.rowGap;
    g.strokeStyle = `rgba(255,255,255,${(0.05 * (1 - Math.pow(r / last, 0.8))).toFixed(3)})`;
    g.beginPath();
    roundRectPath(g, hw0 + out, hh0 + out, st.cr + out);
    g.stroke();
  }

  // Aisles: stairs through the straight stands.
  g.fillStyle = 'rgba(150,170,225,0.05)';
  const along = aisleCentres(st, true);
  for (let k = 0; k < along.length; k++) {
    const c = along[k];
    g.fillRect(c - AISLE_WIDTH / 2, -(hh0 + st.depth), AISLE_WIDTH, st.depth);
    g.fillRect(c - AISLE_WIDTH / 2, hh0, AISLE_WIDTH, st.depth);
  }
  const ends = aisleCentres(st, false);
  for (let k = 0; k < ends.length; k++) {
    const c = ends[k];
    g.fillRect(-(hw0 + st.depth), c - AISLE_WIDTH / 2, st.depth, AISLE_WIDTH);
    g.fillRect(hw0, c - AISLE_WIDTH / 2, st.depth, AISLE_WIDTH);
  }

  // The apron between boards and stands, brighter where the floodlights spill over the boards.
  g.fillStyle = APRON;
  g.beginPath();
  roundRectPath(g, hw0, hh0, st.cr);
  g.fill();
  const spill = [34, 20, 9];
  for (let k = 0; k < spill.length; k++) {
    const w = spill[k], off = BOARD_T + w / 2;
    g.lineWidth = w;
    g.strokeStyle = 'rgba(150,180,255,0.045)';
    g.beginPath();
    roundRectPath(g, pm.halfW + off, pm.halfH + off, pm.cornerR + off);
    g.stroke();
  }

  // The fence in front of the first row; behind each goal it carries that end's colours
  // (the home fans stand behind the goal their team defends).
  g.lineJoin = 'round';
  g.strokeStyle = FENCE;
  g.lineWidth = 3;
  g.beginPath();
  roundRectPath(g, hw0 - 1.5, hh0 - 1.5, st.cr);
  g.stroke();
  g.strokeStyle = 'rgba(255,255,255,0.1)';
  g.lineWidth = 1;
  g.beginPath();
  roundRectPath(g, hw0 - 3.4, hh0 - 3.4, st.cr);
  g.stroke();
  g.lineCap = 'round';
  g.lineWidth = 3;
  for (let t = 0; t < 2; t++) {
    const x = (t === 0 ? -1 : 1) * (hw0 - 1.5);
    g.strokeStyle = rgba(M.teams[t].bright, 0.7);
    g.beginPath();
    g.moveTo(x, -st.straightY);
    g.lineTo(x, st.straightY);
    g.stroke();
  }
}

/**
 * Paints the spectators of one stand (strip: 0 top, 1 bottom, 2 left, 3 right) that belong to
 * one of the three hop groups. A spectator seen from above is a pair of shoulders and a head,
 * facing the pitch; rows further back are darker.
 */
export function paintCrowd(g, M, strip, group) {
  const seats = M.seats, st = M.stands, pm = M.pm;
  const last = Math.max(1, st.rows - 1);
  const cloth = [0, 1].map((t) => [M.teams[t].bright, lighten(M.teams[t].bright, 0.35), M.teams[t].trimBright]);

  for (let i = 0; i < seats.n; i++) {
    if (seats.strip[i] !== strip || seats.group[i] !== group) continue;
    const x = seats.x[i], y = seats.y[i], nx = seats.nx[i], ny = seats.ny[i];
    const tone = seats.tone[i], h2 = hash01(i * 7 + 3), h3 = hash01(i * 13 + 5);
    const lit = 0.84 - 0.74 * Math.pow(seats.row[i] / last, 0.75);

    // Ends belong to one team; along the touchlines the colours blend around the halfway line.
    const team = strip === 2 ? 0 : strip === 3 ? 1 : h3 < 0.5 - (x / pm.width) * 0.9 ? 0 : 1;
    const wear = tone < 0.5 ? cloth[team][0] : tone < 0.63 ? cloth[team][1] : tone < 0.75 ? cloth[team][2] : NEUTRAL[(h2 * NEUTRAL.length) | 0];

    g.fillStyle = mix(NIGHT, wear, lit);
    g.beginPath();
    g.ellipse(x, y, 6.3, 3.7, Math.atan2(ny, nx) + Math.PI / 2, 0, TAU);
    g.fill();
    g.fillStyle = mix(NIGHT, h3 > 0.8 ? HAT : SKIN[(h2 * SKIN.length) | 0], Math.min(1, lit * 1.08));
    g.beginPath();
    g.arc(x - nx * 0.7, y - ny * 0.7, 2.9, 0, TAU);
    g.fill();
  }
}

/** Blits the crowd layers. The context must be in world units. */
export function drawCrowd(R) {
  const L = R.layers, ctx = R.ctx, vis = R.vis;
  for (let strip = 0; strip < 4; strip++) {
    for (let group = 0; group < 3; group++) {
      const layer = L.crowd[strip * 3 + group];
      if (!layer) continue;
      if (layer.x > vis.x1 || layer.x + layer.w < vis.x0 || layer.y - 12 > vis.y1 || layer.y + layer.h < vis.y0) continue;
      ctx.drawImage(layer.c, layer.x, layer.y - crowdLift(R, strip, group), layer.w, layer.h);
    }
  }
}
