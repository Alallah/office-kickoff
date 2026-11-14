// The Home page: the nickname box, the three ways into a game, and the little match that plays
// by itself beside them.
//
// That ambient match (createAmbient / stepAmbient) is a toy, not the game's simulation: a ball,
// ten dots and two goals inside the same walled, round-cornered pitch, just enough to read as
// football seen from above. It is pure - no DOM, a seeded random source - so it can be tested
// headless; startPitch puts it on the canvas.

import { getPrefs, savePrefs, suggestNickname } from './shared/identity.js';
import { ROUTES } from './shared/protocol.js';
import { prefersReducedMotion } from './shared/util.js';
import { cleanNickname, extractRoomCode, isRoomCode } from './lobby/logic.js';

// =====================================================================================
//  Ambient match (pure)
// =====================================================================================

/** The toy pitch, in its own units: goal mouths in the middle of the two short walls. */
export const FIELD = Object.freeze({ w: 160, h: 100, goal: 24, net: 6, corner: 12, ball: 1.3, player: 2.6 });

const WALL_BOUNCE = 0.84;
const BALL_DRAG = 0.42;
const KICK_COOLDOWN = 0.55;
const CONTEST_COOLDOWN = 0.22;
const GOAL_PAUSE = 1.7;
const PASS_CHANCE = 0.38;
const SPEED = Object.freeze({ chase: 31, shape: 17, keeper: 23, home: 22 });

/** Keeper and a 2-2 for the side defending the left goal: [x, y] as fractions of the pitch. */
const SPOTS = Object.freeze([
  [0.045, 0.5],
  [0.24, 0.3],
  [0.24, 0.7],
  [0.42, 0.4],
  [0.42, 0.62],
]);

/** Small seeded generator (mulberry32), so a run can be repeated exactly. */
export function seededRandom(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function clamp(value, lo, hi) {
  return value < lo ? lo : value > hi ? hi : value;
}

/** A fresh kick-off: everyone on their spot, the ball on the centre spot and already rolling. */
export function createAmbient(seed = 1) {
  const players = [];
  for (let team = 0; team < 2; team++) {
    SPOTS.forEach(([fx, fy], slot) => {
      const hx = team === 0 ? fx * FIELD.w : FIELD.w - fx * FIELD.w;
      const hy = team === 0 ? fy * FIELD.h : FIELD.h - fy * FIELD.h;
      players.push({ team, keeper: slot === 0, hx, hy, x: hx, y: hy, cool: 0 });
    });
  }
  const rand = seededRandom(seed);
  const angle = rand() * Math.PI * 2;
  return {
    time: 0,
    rand,
    ball: { x: FIELD.w / 2, y: FIELD.h / 2, vx: Math.cos(angle) * 38, vy: Math.sin(angle) * 38 },
    players,
    /** Seconds left of the pause after a goal. */
    pause: 0,
    goals: [0, 0],
    kicks: 0,
    /** The goal (0 = left, 1 = right) the ball last went into, and when. */
    scoredSide: -1,
    scoredAt: -1,
  };
}

/** Moves towards a point, easing in rather than stopping dead on it. */
function moveToward(p, tx, ty, speed, dt) {
  const dx = tx - p.x;
  const dy = ty - p.y;
  const dist = Math.hypot(dx, dy);
  if (dist < 1e-6) return;
  const travel = Math.min(dist, speed * dt, dist * 6 * dt + 0.02);
  p.x += (dx / dist) * travel;
  p.y += (dy / dist) * travel;
}

/**
 * Keeps a disc inside the walls, rounded corners included. With `bounce` (the ball) the velocity
 * is reflected; footballers are simply held.
 */
function confine(o, r, bounce) {
  const { w, h, corner } = FIELD;
  const cx = o.x < corner ? corner : o.x > w - corner ? w - corner : -1;
  const cy = o.y < corner ? corner : o.y > h - corner ? h - corner : -1;
  if (cx >= 0 && cy >= 0) {
    const dx = o.x - cx;
    const dy = o.y - cy;
    const d = Math.hypot(dx, dy);
    const limit = corner - r;
    if (d > limit && d > 0) {
      const nx = dx / d;
      const ny = dy / d;
      o.x = cx + nx * limit;
      o.y = cy + ny * limit;
      if (bounce) {
        const vn = o.vx * nx + o.vy * ny;
        if (vn > 0) {
          o.vx -= (1 + WALL_BOUNCE) * vn * nx;
          o.vy -= (1 + WALL_BOUNCE) * vn * ny;
        }
      }
    }
    return;
  }
  if (o.x < r) {
    o.x = r;
    if (bounce) o.vx = Math.abs(o.vx) * WALL_BOUNCE;
  } else if (o.x > w - r) {
    o.x = w - r;
    if (bounce) o.vx = -Math.abs(o.vx) * WALL_BOUNCE;
  }
  if (o.y < r) {
    o.y = r;
    if (bounce) o.vy = Math.abs(o.vy) * WALL_BOUNCE;
  } else if (o.y > h - r) {
    o.y = h - r;
    if (bounce) o.vy = -Math.abs(o.vy) * WALL_BOUNCE;
  }
}

function runPlayers(s, dt) {
  const b = s.ball;
  const mid = FIELD.h / 2;
  for (let team = 0; team < 2; team++) {
    // The outfielder nearest the ball goes for it; the others hold a shape that leans towards it.
    let chaser = null;
    let best = Infinity;
    for (const p of s.players) {
      if (p.team !== team || p.keeper) continue;
      const d = Math.hypot(p.x - b.x, p.y - b.y);
      if (d < best) {
        best = d;
        chaser = p;
      }
    }
    const goalX = team === 0 ? 0 : FIELD.w;
    for (const p of s.players) {
      if (p.team !== team) continue;
      if (p.keeper) {
        const danger = Math.hypot(b.x - goalX, b.y - mid) < 26;
        if (danger) moveToward(p, b.x, b.y, SPEED.keeper, dt);
        else moveToward(p, p.hx, clamp(b.y, mid - FIELD.goal / 2 + 2, mid + FIELD.goal / 2 - 2), SPEED.keeper, dt);
      } else if (p === chaser) {
        moveToward(p, b.x + b.vx * 0.12, b.y + b.vy * 0.12, SPEED.chase, dt);
      } else {
        moveToward(p, p.hx + (b.x - FIELD.w / 2) * 0.3, p.hy + (b.y - mid) * 0.22, SPEED.shape, dt);
      }
      confine(p, FIELD.player, false);
    }
  }
}

function runKicks(s) {
  const b = s.ball;
  const reach = FIELD.player + FIELD.ball + 0.6;
  for (const p of s.players) {
    if (p.cool > 0) continue;
    const dx = b.x - p.x;
    const dy = b.y - p.y;
    if (dx * dx + dy * dy > reach * reach) continue;

    const forward = p.team === 0 ? 1 : -1;
    // A shot at the far goal by default ...
    let tx = p.team === 0 ? FIELD.w : 0;
    let ty = FIELD.h / 2 + (s.rand() - 0.5) * FIELD.goal * 0.7;
    let speed = 78 + s.rand() * 22;
    // ... but keepers always play it out, and outfielders now and then find a team-mate up the pitch.
    if (p.keeper || s.rand() < PASS_CHANCE) {
      const mates = s.players.filter((m) => m.team === p.team && m !== p && !m.keeper && (m.x - p.x) * forward > 4);
      if (mates.length > 0) {
        const mate = mates[Math.min(mates.length - 1, Math.floor(s.rand() * mates.length))];
        tx = mate.x + forward * 5;
        ty = mate.y;
        speed = 52 + s.rand() * 14;
      }
    }
    const angle = Math.atan2(ty - p.y, tx - p.x) + (s.rand() - 0.5) * 0.28;
    b.vx = Math.cos(angle) * speed;
    b.vy = Math.sin(angle) * speed;
    // The ball starts clear of the boot so that it is not struck twice.
    b.x = p.x + Math.cos(angle) * reach;
    b.y = p.y + Math.sin(angle) * reach;
    p.cool = KICK_COOLDOWN;
    // The other side needs a moment before it can hit the ball straight back.
    for (const other of s.players) {
      if (other.team !== p.team) other.cool = Math.max(other.cool, CONTEST_COOLDOWN);
    }
    s.kicks += 1;
    return;
  }
}

function runBall(s, dt) {
  const b = s.ball;
  const r = FIELD.ball;
  b.x += b.vx * dt;
  b.y += b.vy * dt;
  const drag = Math.exp(-BALL_DRAG * dt);
  b.vx *= drag;
  b.vy *= drag;

  // Between the posts there is no wall: the ball runs on, and once over the line it is a goal.
  const inMouth = Math.abs(b.y - FIELD.h / 2) < FIELD.goal / 2 - r;
  if (inMouth && (b.x < r || b.x > FIELD.w - r)) {
    if (b.x < 0 || b.x > FIELD.w) {
      const side = b.x < 0 ? 0 : 1;
      s.goals[1 - side] += 1;
      s.scoredSide = side;
      s.scoredAt = s.time;
      s.pause = GOAL_PAUSE;
      b.x = side === 0 ? -FIELD.net / 2 : FIELD.w + FIELD.net / 2;
      b.vx = 0;
      b.vy = 0;
    }
    return;
  }
  confine(b, r, true);
}

/**
 * Advances the ambient match.
 * @param {object} s    createAmbient(...)
 * @param {number} dt   seconds since the last step (long gaps are cut to a twentieth of a second)
 */
export function stepAmbient(s, dt) {
  const step = Math.min(dt, 0.05);
  if (!(step > 0)) return s;
  s.time += step;
  for (const p of s.players) p.cool = Math.max(0, p.cool - step);

  if (s.pause > 0) {
    // After a goal everyone walks back; then the ball is put on the centre spot.
    s.pause -= step;
    for (const p of s.players) moveToward(p, p.hx, p.hy, SPEED.home, step);
    if (s.pause <= 0) {
      s.pause = 0;
      s.ball.x = FIELD.w / 2;
      s.ball.y = FIELD.h / 2;
      s.ball.vx = 0;
      s.ball.vy = 0;
    }
    return s;
  }

  runPlayers(s, step);
  runKicks(s);
  runBall(s, step);
  return s;
}

/**
 * Where the pitch goes on the canvas: as large as fits inside the insets, centred.
 * @param {number} width @param {number} height  canvas size in CSS pixels
 * @param {{top: number, right: number, bottom: number, left: number}} inset
 * @returns {{scale: number, ox: number, oy: number}}  canvas = field * scale + (ox, oy)
 */
export function fitField(width, height, inset) {
  const availW = Math.max(1, width - inset.left - inset.right);
  const availH = Math.max(1, height - inset.top - inset.bottom);
  const scale = Math.min(availW / (FIELD.w + 2 * FIELD.net), availH / FIELD.h);
  return {
    scale,
    ox: inset.left + (availW - FIELD.w * scale) / 2,
    oy: inset.top + (availH - FIELD.h * scale) / 2,
  };
}

// =====================================================================================
//  Ambient match (canvas)
// =====================================================================================

const PAINT = Object.freeze({
  turf: '#124a31',
  turfAlt: '#15573a',
  line: 'rgba(255, 255, 255, 0.5)',
  net: 'rgba(255, 255, 255, 0.16)',
  home: '#3b82f6',
  away: '#f43f5e',
  keeper: '#ffd166',
  ball: '#ffffff',
  glow: '182, 255, 60',
});

const TRAIL_LENGTH = 16;

function pitchOutline(ctx) {
  const { w, h, corner: c } = FIELD;
  ctx.beginPath();
  ctx.moveTo(c, 0);
  ctx.lineTo(w - c, 0);
  ctx.arc(w - c, c, c, -Math.PI / 2, 0);
  ctx.lineTo(w, h - c);
  ctx.arc(w - c, h - c, c, 0, Math.PI / 2);
  ctx.lineTo(c, h);
  ctx.arc(c, h - c, c, Math.PI / 2, Math.PI);
  ctx.lineTo(0, c);
  ctx.arc(c, c, c, Math.PI, Math.PI * 1.5);
  ctx.closePath();
}

/** Everything that never moves, drawn once per size into its own canvas. */
function paintLayer(pixelWidth, pixelHeight, dpr, view) {
  const layer = document.createElement('canvas');
  layer.width = pixelWidth;
  layer.height = pixelHeight;
  const ctx = layer.getContext('2d');
  if (!ctx) return layer;
  const { w, h, goal, net } = FIELD;
  const mid = h / 2;
  ctx.setTransform(dpr * view.scale, 0, 0, dpr * view.scale, dpr * view.ox, dpr * view.oy);

  // Turf: mown stripes, darker towards the walls as if under floodlights.
  ctx.save();
  pitchOutline(ctx);
  ctx.clip();
  const stripes = 10;
  for (let i = 0; i < stripes; i++) {
    ctx.fillStyle = i % 2 === 0 ? PAINT.turf : PAINT.turfAlt;
    ctx.fillRect((i * w) / stripes, 0, w / stripes + 0.2, h);
  }
  const shade = ctx.createRadialGradient(w / 2, mid, h * 0.2, w / 2, mid, w * 0.62);
  shade.addColorStop(0, 'rgba(255, 255, 255, 0.07)');
  shade.addColorStop(1, 'rgba(0, 0, 0, 0.42)');
  ctx.fillStyle = shade;
  ctx.fillRect(0, 0, w, h);
  ctx.restore();

  // Nets behind both goal lines.
  ctx.fillStyle = PAINT.net;
  ctx.fillRect(-net, mid - goal / 2, net, goal);
  ctx.fillRect(w, mid - goal / 2, net, goal);

  ctx.strokeStyle = PAINT.line;
  ctx.lineWidth = 0.6;
  ctx.lineJoin = 'round';
  pitchOutline(ctx);
  ctx.stroke();
  ctx.strokeRect(-net, mid - goal / 2, net, goal);
  ctx.strokeRect(w, mid - goal / 2, net, goal);
  ctx.beginPath();
  ctx.moveTo(w / 2, 0);
  ctx.lineTo(w / 2, h);
  ctx.moveTo(w / 2 + 13, mid);
  ctx.arc(w / 2, mid, 13, 0, Math.PI * 2);
  ctx.stroke();
  ctx.strokeRect(0, mid - 26, 20, 52);
  ctx.strokeRect(w - 20, mid - 26, 20, 52);
  ctx.fillStyle = PAINT.line;
  ctx.beginPath();
  ctx.arc(w / 2, mid, 0.9, 0, Math.PI * 2);
  ctx.fill();
  return layer;
}

function paintFrame(ctx, layer, s, view, trail, dpr) {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, layer.width, layer.height);
  ctx.drawImage(layer, 0, 0);
  ctx.setTransform(dpr * view.scale, 0, 0, dpr * view.scale, dpr * view.ox, dpr * view.oy);
  const mid = FIELD.h / 2;

  // A goal: the net lights up and a ring runs out from the mouth.
  const since = s.scoredAt < 0 ? Infinity : s.time - s.scoredAt;
  if (since < 1.2) {
    const k = since / 1.2;
    const gx = s.scoredSide === 0 ? 0 : FIELD.w;
    ctx.fillStyle = `rgba(${PAINT.glow}, ${(0.45 * (1 - k)).toFixed(3)})`;
    ctx.fillRect(s.scoredSide === 0 ? -FIELD.net : FIELD.w, mid - FIELD.goal / 2, FIELD.net, FIELD.goal);
    ctx.strokeStyle = `rgba(${PAINT.glow}, ${(0.7 * (1 - k)).toFixed(3)})`;
    ctx.lineWidth = 0.9;
    ctx.beginPath();
    ctx.arc(gx, mid, 6 + k * 30, 0, Math.PI * 2);
    ctx.stroke();
  }

  for (const p of s.players) {
    ctx.fillStyle = 'rgba(0, 0, 0, 0.3)';
    ctx.beginPath();
    ctx.arc(p.x + 0.5, p.y + 0.7, FIELD.player, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = p.keeper ? PAINT.keeper : p.team === 0 ? PAINT.home : PAINT.away;
    ctx.beginPath();
    ctx.arc(p.x, p.y, FIELD.player, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.85)';
    ctx.lineWidth = 0.5;
    ctx.stroke();
  }

  for (let i = 0; i < trail.length; i++) {
    const k = (i + 1) / trail.length;
    ctx.fillStyle = `rgba(${PAINT.glow}, ${(0.32 * k * k).toFixed(3)})`;
    ctx.beginPath();
    ctx.arc(trail[i].x, trail[i].y, FIELD.ball * (0.35 + 0.65 * k), 0, Math.PI * 2);
    ctx.fill();
  }
  const b = s.ball;
  ctx.fillStyle = `rgba(${PAINT.glow}, 0.22)`;
  ctx.beginPath();
  ctx.arc(b.x, b.y, FIELD.ball * 2.4, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = PAINT.ball;
  ctx.beginPath();
  ctx.arc(b.x, b.y, FIELD.ball, 0, Math.PI * 2);
  ctx.fill();
}

/**
 * Runs the ambient match on a canvas that the stylesheet sizes. It stops while the tab is hidden
 * and stays a still picture of the kick-off when the user asked for reduced motion.
 */
function startPitch(canvas) {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const still = prefersReducedMotion();
  const state = createAmbient((Date.now() % 100000) + 1);
  if (still) {
    state.ball.vx = 0;
    state.ball.vy = 0;
  }
  const trail = [];
  let layer = null;
  let view = null;
  let dpr = 1;
  let raf = 0;
  let last = 0;

  function draw() {
    if (layer && view) paintFrame(ctx, layer, state, view, trail, dpr);
  }

  function resize() {
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    if (width < 2 || height < 2) return;
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    const pixelWidth = Math.round(width * dpr);
    const pixelHeight = Math.round(height * dpr);
    if (layer && layer.width === pixelWidth && layer.height === pixelHeight) return;
    canvas.width = pixelWidth;
    canvas.height = pixelHeight;
    // The how-to-play strip lies over the bottom of the canvas and the hero over its left side:
    // keep the pitch clear of both, unless that would leave it too small to read.
    const strip = document.getElementById('howto');
    const hero = document.querySelector('.hero');
    let left = 32;
    if (hero) {
      const clear = hero.getBoundingClientRect().right - canvas.getBoundingClientRect().left + 28;
      if (clear > left && width - clear - 32 >= 320) left = clear;
    }
    view = fitField(width, height, { top: 28, right: 32, bottom: (strip?.offsetHeight ?? 0) + 28, left });
    layer = paintLayer(pixelWidth, pixelHeight, dpr, view);
    draw();
  }

  function frame(now) {
    raf = 0;
    const dt = last > 0 ? (now - last) / 1000 : 0;
    last = now;
    stepAmbient(state, dt);
    if (state.pause > 0) trail.length = 0;
    else {
      trail.push({ x: state.ball.x, y: state.ball.y });
      if (trail.length > TRAIL_LENGTH) trail.shift();
    }
    draw();
    schedule();
  }

  function schedule() {
    if (!still && raf === 0 && !document.hidden) raf = requestAnimationFrame(frame);
  }

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      cancelAnimationFrame(raf);
      raf = 0;
      // The time spent hidden must not arrive as one giant step.
      last = 0;
    } else {
      schedule();
    }
  });
  if (typeof ResizeObserver === 'function') new ResizeObserver(resize).observe(canvas);
  else window.addEventListener('resize', resize);
  resize();
  schedule();
}

// =====================================================================================
//  The page
// =====================================================================================

/** How long a pressed button stays "busy" if the next page never arrives. */
const SUBMIT_GUARD_MS = 8000;

const BUSY_LABEL = Object.freeze({ create: 'Creating room', join: 'Joining', practice: 'Warming up' });

/**
 * Wires up the Home page (Views/Home/Index.cshtml).
 * @returns {{commitName: () => string}} mainly for tests
 */
export function initHome() {
  const byId = (id) => document.getElementById(id);
  const nickname = byId('nickname');
  const code = byId('join-code');
  const joinError = byId('join-error');
  const create = byId('create-room');

  // ---- nickname ---------------------------------------------------------------------------
  /** Stores the name in the box (an empty box still gets one) and returns it. */
  function commitName() {
    let name = cleanNickname(nickname ? nickname.value : getPrefs().nickname);
    if (name === '') name = suggestNickname();
    if (nickname && nickname.value !== name) nickname.value = name;
    savePrefs({ nickname: name });
    return name;
  }

  if (nickname) {
    nickname.value = cleanNickname(getPrefs().nickname) || suggestNickname();
    nickname.addEventListener('change', commitName);
    nickname.addEventListener('keydown', (e) => {
      // The box is not part of a form: Enter moves on to the big button instead of doing nothing.
      if (e.key === 'Enter' && create) {
        e.preventDefault();
        commitName();
        create.focus();
      }
    });
    byId('nickname-shuffle')?.addEventListener('click', () => {
      nickname.value = suggestNickname();
      commitName();
      nickname.focus();
      nickname.select();
    });
  }

  // ---- room code --------------------------------------------------------------------------
  function setJoinError(text) {
    if (!joinError) return;
    joinError.textContent = text;
    joinError.hidden = text === '';
    if (code) {
      if (text === '') code.removeAttribute('aria-invalid');
      else code.setAttribute('aria-invalid', 'true');
    }
  }

  if (code) {
    code.addEventListener('input', () => {
      const next = extractRoomCode(code.value);
      if (next !== code.value) {
        const caret = Math.min(code.selectionStart ?? next.length, next.length);
        code.value = next;
        try {
          code.setSelectionRange(caret, caret);
        } catch {
          /* the caret simply goes to the end */
        }
      }
      setJoinError('');
    });
    // The box only holds four characters, so a pasted invite link would be cut to "http":
    // take the code out of whatever was pasted instead.
    code.addEventListener('paste', (e) => {
      const text = e.clipboardData?.getData('text') ?? '';
      if (text.trim() === '') return;
      e.preventDefault();
      const found = extractRoomCode(text);
      code.value = found;
      setJoinError(found === '' ? 'There is no room code in what you pasted.' : '');
    });
  }

  function checkCode() {
    if (!code) return true;
    const value = extractRoomCode(code.value);
    code.value = value;
    if (isRoomCode(value)) {
      setJoinError('');
      return true;
    }
    setJoinError(value === '' ? 'Type the four letters of the room code.' : 'A room code has four letters.');
    code.focus();
    code.classList.remove('is-shake');
    void code.offsetWidth;
    code.classList.add('is-shake');
    return false;
  }

  // ---- the three forms --------------------------------------------------------------------
  let busyForm = null;
  let busyTimer = 0;

  function clearBusy() {
    clearTimeout(busyTimer);
    if (!busyForm) return;
    const label = busyForm.querySelector('[data-label]');
    if (label && label.dataset.label) label.textContent = label.dataset.label;
    busyForm.classList.remove('is-busy');
    busyForm.removeAttribute('aria-busy');
    busyForm = null;
  }

  for (const form of document.querySelectorAll('form[data-play]')) {
    // The page works without this script too (plain forms); with it, validation is ours.
    form.noValidate = true;
    form.addEventListener('submit', (e) => {
      const kind = form.dataset.play;
      // One click is one room: a second submit while the first is on its way is dropped.
      if (busyForm || (kind === 'join' && !checkCode())) {
        e.preventDefault();
        return;
      }
      commitName();
      busyForm = form;
      form.classList.add('is-busy');
      form.setAttribute('aria-busy', 'true');
      const label = form.querySelector('[data-label]');
      if (label) {
        label.dataset.label = label.textContent;
        label.textContent = BUSY_LABEL[kind] ?? label.textContent;
      }
      busyTimer = setTimeout(clearBusy, SUBMIT_GUARD_MS);
    });
  }
  // Coming back with the Back button can restore this page exactly as it was left: mid-submit.
  window.addEventListener('pageshow', (e) => {
    if (e.persisted) clearBusy();
  });

  // ---- the message from the server --------------------------------------------------------
  const alert = byId('home-alert');
  byId('home-alert-close')?.addEventListener('click', () => {
    if (alert) alert.hidden = true;
    (code && code.value !== '' ? code : create)?.focus();
  });
  // It has been shown: a reload or a bookmark of this page should not bring it back.
  if (/[?&](error|code)=/.test(location.search)) {
    try {
      history.replaceState(null, '', ROUTES.home());
    } catch {
      /* the address simply keeps its query */
    }
  }

  // ---- where the keyboard starts ----------------------------------------------------------
  if (code && code.value !== '') {
    code.focus();
    code.select();
  } else if (create) {
    create.focus({ preventScroll: true });
  }

  const canvas = byId('pitch-bg');
  if (canvas && typeof canvas.getContext === 'function') startPitch(canvas);

  return { commitName };
}

if (typeof document !== 'undefined' && document.getElementById('home')) initHome();
