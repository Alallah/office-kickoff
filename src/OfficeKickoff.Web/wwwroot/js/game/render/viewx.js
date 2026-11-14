// Defensive readers for the FrameView. Whatever main.js hands over (a placeholder view, a
// footballer missing during a rematch, a number that is NaN), these return something drawable
// or say clearly that there is nothing to draw. Pure.

import { clamp, clamp01, isNum, num } from './mathx.js';

/** view.players[i] when it exists and has a finite position, otherwise null. */
export function playerAt(view, i) {
  const list = view && view.players;
  if (!Array.isArray(list) || !isNum(i) || i < 0 || i >= list.length || (i | 0) !== i) return null;
  const p = list[i];
  return p && isNum(p.x) && isNum(p.y) ? p : null;
}

export function newBallView() {
  return { ok: false, x: 0, y: 0, vx: 0, vy: 0, speed: 0, spin: 0, heat: 0, owner: -1, held: false, dead: false };
}

/** Copies view.ball into `out` with every field made safe; out.ok is false when it has no position. */
export function readBall(view, out) {
  const b = view && view.ball;
  out.ok = !!b && isNum(b.x) && isNum(b.y);
  out.x = out.ok ? b.x : 0;
  out.y = out.ok ? b.y : 0;
  out.vx = num(b && b.vx, 0);
  out.vy = num(b && b.vy, 0);
  out.speed = Math.sqrt(out.vx * out.vx + out.vy * out.vy);
  out.spin = clamp(num(b && b.spin, 0), -1, 1);
  out.heat = clamp01(num(b && b.heat, 0));
  const owner = b ? b.owner : -1;
  out.owner = isNum(owner) && owner >= 0 && (owner | 0) === owner ? owner : -1;
  out.held = !!b && b.held === true;
  out.dead = !!b && b.dead === true;
  return out;
}

/**
 * Index of the local player's footballer, or -1: spectators, a player whose footballer the AI
 * has for the moment, or a view that does not hold together.
 */
export function myIndex(view) {
  const me = view && view.me;
  if (!me || me.spectator === true || !me.player) return -1;
  const i = me.playerIndex;
  return playerAt(view, i) ? i : -1;
}

/** The local player's human id, or -1 for spectators. */
export function myHumanId(view) {
  const me = view && view.me;
  const id = me && me.spectator !== true ? me.humanId : -1;
  return isNum(id) && id >= 0 && id < 4 && (id | 0) === id ? id : -1;
}

/** Team of the local player (0 / 1), or -1. */
export function myTeam(view) {
  const me = view && view.me;
  return me && me.spectator !== true && (me.team === 0 || me.team === 1) ? me.team : -1;
}

/** Human id controlling a footballer view, or -1 for the AI. */
export function ctrlOf(p) {
  const c = p ? p.ctrl : -1;
  return isNum(c) && c >= 0 && c < 4 && (c | 0) === c ? c : -1;
}
