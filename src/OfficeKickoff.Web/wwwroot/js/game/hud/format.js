// Pure logic behind the match HUD: formatting, naming, and the small models (feed queue, roster,
// results) that the DOM modules render. Nothing in this file touches the document, so all of it
// can be unit-tested headless.

import { EVT, PHASE, EMOTES, LIMITS, goalInfo } from '../../shared/protocol.js';
import { safeColor } from '../../shared/crests.js';

/** Entries the event feed keeps on screen at once. */
export const FEED_MAX = 5;

export function num(value, fallback = 0) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** A counter from the network: a whole number that is never negative. */
export function count(value) {
  return Math.max(0, Math.round(num(value, 0)));
}

export function clamp01(value) {
  const v = num(value, 0);
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

// Control characters, line separators and bidi overrides: none of them belong in a one-line label.
function isUnprintable(code) {
  return code < 0x20 || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029 ||
    (code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069);
}

/** Network text as a single trimmed line of at most `max` UTF-16 units (never ending in half a surrogate pair). */
export function cleanText(value, max) {
  if (value === null || value === undefined) return '';
  // Bounded before the scan so a hostile megabyte of text costs nothing.
  const raw = String(value).slice(0, max * 4 + 64);
  let text = '';
  for (let i = 0; i < raw.length; i++) {
    text += isUnprintable(raw.charCodeAt(i)) ? ' ' : raw[i];
  }
  text = text.replace(/\s+/g, ' ').trim();
  if (text.length > max) {
    text = text.slice(0, max);
    const last = text.charCodeAt(text.length - 1);
    if (last >= 0xd800 && last <= 0xdbff) text = text.slice(0, -1);
    text = text.trim();
  }
  return text;
}

/** Length of the longest unbroken word of a label: what decides whether big type fits its box. */
export function longestWord(value) {
  let longest = 0;
  for (const word of String(value ?? '').split(/\s+/)) {
    if (word.length > longest) longest = word.length;
  }
  return longest;
}

/** A team name with a word this long gets smaller type on the versus card instead of a break mid-word. */
export const LONG_WORD = 10;

// ------------------------------------------------------------------------------------
//  Clock and score
// ------------------------------------------------------------------------------------

/**
 * Whole seconds a clock shows. A countdown rounds up, so 00:00 appears only when time is really
 * up; a stopwatch rounds down. The millisecond of slack absorbs interpolation noise (180.0004
 * must read 03:00, not 03:01).
 */
export function clockSeconds(seconds, countUp = false) {
  const s = Math.max(0, num(seconds, 0));
  const whole = countUp ? Math.floor(s + 0.001) : Math.ceil(s - 0.001);
  return Math.min(5999, Math.max(0, whole));
}

/** "mm:ss" for a whole number of seconds (capped at 99:59). */
export function clockText(wholeSeconds) {
  const whole = Math.min(5999, Math.max(0, Math.floor(num(wholeSeconds, 0))));
  const m = Math.floor(whole / 60);
  const s = whole - m * 60;
  return `${m < 10 ? '0' : ''}${m}:${s < 10 ? '0' : ''}${s}`;
}

export function formatClock(seconds, countUp = false) {
  return clockText(clockSeconds(seconds, countUp));
}

/**
 * The number the kickoff countdown shows for the real seconds left in the phase: 3, 2, 1.
 * Returns 0 while more than three seconds remain (a longer configured countdown stays quiet
 * until its last three seconds) and never drops below 1 while the phase lasts.
 */
export function countdownNumber(phaseTime) {
  const n = Math.ceil(num(phaseTime, 0) - 0.001);
  if (n > 3) return 0;
  return n < 1 ? 1 : n;
}

/**
 * Football-style minute of a goal: seconds 0-59 are the 1st minute. Goals after regulation
 * (golden goal) read like added time, e.g. "3+1'" in a three-minute match.
 * @param {number} time               real seconds of open play when the goal was scored
 * @param {number} [regulationMinutes] match length; 0 = no regulation (practice)
 */
export function goalMinute(time, regulationMinutes = 0) {
  const t = Math.max(0, num(time, 0));
  const regulation = Math.max(0, Math.floor(num(regulationMinutes, 0)));
  if (regulation > 0 && t >= regulation * 60) {
    return `${regulation}+${Math.floor((t - regulation * 60) / 60) + 1}'`;
  }
  return `${Math.floor(t / 60) + 1}'`;
}

/** "2 - 1" with a proper dash, for banners. */
export function scoreText(score) {
  return `${count(score?.[0])} – ${count(score?.[1])}`;
}

// ------------------------------------------------------------------------------------
//  Colour
// ------------------------------------------------------------------------------------

function channels(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** WCAG relative luminance of a "#rrggbb" colour: 0 = black, 1 = white. */
export function luminance(hex) {
  const [r, g, b] = channels(safeColor(hex, '#888888')).map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Text colour that reads on the given background. */
export function inkOn(hex) {
  return luminance(hex) > 0.4 ? '#111111' : '#ffffff';
}

export function mixHex(a, b, t) {
  const from = channels(safeColor(a, '#888888'));
  const to = channels(safeColor(b, '#888888'));
  const k = clamp01(t);
  let out = '#';
  for (let i = 0; i < 3; i++) {
    const v = Math.round(from[i] + (to[i] - from[i]) * k);
    out += (v < 16 ? '0' : '') + v.toString(16);
  }
  return out;
}

/**
 * A colour made legible as text or a thin line on the dark HUD glass: a navy or black shirt is
 * lifted towards white, anything already bright is returned unchanged.
 */
export function tintForDark(hex) {
  const color = safeColor(hex, '#a9b6d6');
  const lum = luminance(color);
  if (lum >= 0.2) return color;
  return mixHex(color, '#ffffff', lum < 0.03 ? 0.62 : lum < 0.1 ? 0.5 : 0.35);
}

// ------------------------------------------------------------------------------------
//  Connection
// ------------------------------------------------------------------------------------

/** @returns {'unknown'|'good'|'fair'|'poor'} */
export function pingLevel(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return 'unknown';
  if (ms < 70) return 'good';
  if (ms < 140) return 'fair';
  return 'poor';
}

/** Rounded milliseconds to show, or -1 when the ping is unknown. */
export function pingValue(ms) {
  return pingLevel(ms) === 'unknown' ? -1 : Math.min(999, Math.round(ms));
}

export function pingText(ms) {
  const value = pingValue(ms);
  return value < 0 ? '-- ms' : `${value} ms`;
}

// ------------------------------------------------------------------------------------
//  Teams and people
// ------------------------------------------------------------------------------------

const TEAM_FALLBACK = [
  { name: 'Home', code: 'HOM', primary: '#3b82f6', secondary: '#ffffff' },
  { name: 'Away', code: 'AWY', primary: '#f43f5e', secondary: '#ffffff' },
];

/**
 * Everything the HUD shows about a team, with every field validated. Reads the match's teams
 * (kit colours after clash resolution), falls back to the room's, then to neutral defaults.
 * @returns {{index:number, name:string, code:string, primary:string, secondary:string, ink:string, tint:string, crest:string}}
 */
export function teamInfo(init, room, index) {
  const i = index === 1 ? 1 : 0;
  const source = init?.teams?.[i] ?? room?.teams?.[i] ?? null;
  const config = source?.config ?? {};
  const kit = source?.kit ?? {};
  const fallback = TEAM_FALLBACK[i];
  const primary = safeColor(kit.primary, safeColor(config.primary, fallback.primary));
  const secondary = safeColor(kit.secondary, safeColor(config.secondary, fallback.secondary));
  const given = cleanText(config.name, LIMITS.teamName);
  const name = given || fallback.name;
  // A team without a code gets the first letters of its name (spaces and ASCII punctuation skipped).
  const code = cleanText(config.code, LIMITS.teamCode) ||
    given.replace(/[\s!-/:-@[-`{-~]+/g, '').slice(0, LIMITS.teamCode) ||
    fallback.code;
  return {
    index: i,
    name,
    code: code.toUpperCase(),
    primary,
    secondary,
    ink: safeColor(kit.text, inkOn(primary)),
    tint: tintForDark(primary),
    crest: typeof config.crest === 'string' ? config.crest : 'shield',
  };
}

export function humanById(init, humanId) {
  const list = init?.humans;
  if (!Array.isArray(list)) return null;
  for (const h of list) {
    if (h && h.humanId === humanId) return h;
  }
  return null;
}

export function humanByMember(init, memberId) {
  const list = init?.humans;
  if (!Array.isArray(list)) return null;
  for (const h of list) {
    if (h && h.memberId === memberId) return h;
  }
  return null;
}

export function memberById(room, id) {
  const list = room?.members;
  if (!Array.isArray(list)) return null;
  for (const m of list) {
    if (m && m.id === id) return m;
  }
  return null;
}

/** The host is whoever the room says it is right now; the role can move at any time. */
export function isHost(room, memberId) {
  return !!room && typeof memberId === 'number' && memberId > 0 && room.hostId === memberId;
}

/** The host's nickname, or "" when the room does not list them. */
export function hostName(room) {
  return cleanText(memberById(room, room?.hostId)?.name, LIMITS.nickname);
}

/** The room's join code as shown and copied, e.g. "ABCD" ("" when it is not known). */
export function roomCodeOf(room, fallback = '') {
  const code = cleanText(room?.code, LIMITS.roomCode * 2) || cleanText(fallback, LIMITS.roomCode * 2);
  return code.replace(/[^0-9a-z]/gi, '').toUpperCase();
}

/** The humans of one team for the versus card. */
export function splashHumans(init, teamIndex, memberId) {
  const out = [];
  for (const human of Array.isArray(init?.humans) ? init.humans : []) {
    if (!human || (human.team === 1 ? 1 : 0) !== teamIndex) continue;
    out.push({
      name: cleanText(human.name, LIMITS.nickname) || 'Player',
      color: tintForDark(safeColor(human.color, '#a9b6d6')),
      me: typeof memberId === 'number' && memberId > 0 && human.memberId === memberId,
    });
  }
  return out;
}

/** Short line under the versus card, e.g. "5-a-side · 3 min · golden goal". */
export function matchCaption(init) {
  const s = init?.settings ?? {};
  const parts = [];
  if (init?.practice) parts.push('Practice');
  const size = count(s.teamSize);
  if (size > 0) parts.push(`${size}-a-side`);
  if (s.keepers === false) parts.push('no keepers');
  if (init?.practice) {
    parts.push('no clock');
    return parts.join(' · ');
  }
  const minutes = count(s.minutes);
  if (minutes > 0) parts.push(`${minutes} min`);
  const limit = count(s.scoreLimit);
  if (limit > 0) parts.push(`first to ${limit}`);
  if (s.goldenGoal) parts.push('golden goal');
  return parts.join(' · ');
}

/** Small caption under the scoreboard clock ("" = none). */
export function scoreboardCaption(init) {
  if (init?.practice) return 'Practice';
  const limit = count(init?.settings?.scoreLimit);
  return limit > 0 ? `First to ${limit}` : '';
}

/** Who is ahead: used for the full-time announcement before the official result arrives. */
export function fullTimeVerdict(score, teams) {
  const home = count(score?.[0]);
  const away = count(score?.[1]);
  if (home === away) return { winner: -1, text: 'Draw' };
  const winner = home > away ? 0 : 1;
  return { winner, text: `${teams?.[winner]?.name ?? (winner === 0 ? 'Home' : 'Away')} win` };
}

// ------------------------------------------------------------------------------------
//  Goals
// ------------------------------------------------------------------------------------

/**
 * A scorer or assister. The human comes from the goal flag (who controlled the footballer AT THE
 * TOUCH), never from whoever controls the footballer now; an AI footballer is named from the roster.
 */
function partyOf(init, humanId, playerIndex) {
  if (humanId >= 0) {
    const human = humanById(init, humanId);
    if (human) {
      return {
        name: cleanText(human.name, LIMITS.nickname) || 'Player',
        number: 0,
        human: true,
        color: safeColor(human.color, ''),
      };
    }
  }
  const index = num(playerIndex, -1);
  const footballer = index >= 0 ? init?.players?.[index | 0] : null;
  if (!footballer) return null;
  return {
    name: cleanText(footballer.name, LIMITS.rosterName) || (footballer.keeper ? 'Keeper' : 'Player'),
    number: count(footballer.number),
    human: false,
    color: '',
  };
}

/**
 * Everything a goal announcement needs, unpacked from an EVT.GOAL event.
 * @returns {{team:number, ownGoal:boolean, decides:boolean,
 *            scorer:?{name:string,number:number,human:boolean,color:string},
 *            assist:?{name:string,number:number,human:boolean,color:string}}}
 */
export function describeGoal(evt, init) {
  const info = goalInfo(evt ?? { f: 0 });
  return {
    team: info.team,
    ownGoal: info.ownGoal,
    decides: info.decides,
    scorer: partyOf(init, info.scorerHuman, evt?.a),
    // An "assist" for putting the ball in your own net would be a cruel thing to credit.
    assist: info.ownGoal ? null : partyOf(init, info.assistHuman, evt?.b),
  };
}

/** "Nickname" for a human, "Roster Name #9" for an AI footballer. */
export function partyLabel(party) {
  if (!party) return '';
  return party.human || !(party.number > 0) ? party.name : `${party.name} #${party.number}`;
}

/**
 * How long the goal banner may stay: it has to be gone before the goal phase ends, because the
 * replay tag or the next countdown takes the screen then.
 * @returns {{hold:number, out:number, total:number}} seconds from the slam: start of the sweep-out, its length, and the end
 */
export function goalBannerTiming(phase, phaseTime, init, reduced = false) {
  const rules = init?.tuning?.rules ?? {};
  const configured = init?.settings?.celebrations === false
    ? num(rules.goalShortTime, 1.6)
    : num(rules.goalCelebrationTime, 3.2);
  const left = phase === PHASE.GOAL && num(phaseTime, 0) > 0 ? phaseTime : configured;
  const out = reduced ? 0.1 : 0.34;
  const total = Math.max(out + 0.45, Math.min(2.8, left - 0.15));
  return { hold: total - out, out, total };
}

// ------------------------------------------------------------------------------------
//  Event feed
// ------------------------------------------------------------------------------------

/** The footballer behind an event: named after the human at the controls right now, else from the roster. */
function actor(ctx, playerIndex) {
  const index = num(playerIndex, -1);
  if (index < 0) return null;
  const live = ctx?.players?.[index | 0] ?? null;
  const info = ctx?.init?.players?.[index | 0] ?? null;
  const source = live ?? info;
  if (!source) return null;
  const team = source.team === 1 ? 1 : 0;
  const human = live?.human ?? null;
  if (human) return { label: cleanText(human.name, LIMITS.nickname) || 'Player', team, human: true };
  const name = cleanText(source.name ?? info?.name, LIMITS.rosterName) || (source.keeper ? 'Keeper' : 'Player');
  const number = count(source.number ?? info?.number);
  return { label: number > 0 ? `${name} #${number}` : name, team, human: false };
}

/** A stop only makes the feed when it denied the other team's shot. */
function isShotStop(evt, shot, stopperTeam, time) {
  if (shot) return shot.team !== stopperTeam && time - shot.time < 3.5;
  // No strike on record (we joined mid-flight): judge by pace alone.
  return num(evt.v, 0) >= 0.5;
}

/**
 * Tracks the shot in flight so saves and post hits can be told from routine catches.
 * Feed it every event, AFTER feedForEvent has looked at the previous value.
 * @param {?{team:number, by:number, label:string, time:number}} shot
 * @param {{init:?object, players:?Array, time:number}} ctx
 */
export function nextShot(shot, evt, ctx) {
  switch (evt?.type) {
    case EVT.KICK: {
      const who = actor(ctx, evt.a);
      return who ? { team: who.team, by: evt.a | 0, label: who.label, time: num(ctx?.time, 0) } : null;
    }
    case EVT.PASS:
    case EVT.TRAP:
    case EVT.STEAL:
    case EVT.KEEPER_CATCH:
    case EVT.GOAL:
    case EVT.PHASE_CHANGE:
      return null;
    case EVT.TACKLE_HIT:
      return evt.f === 1 ? null : shot ?? null;
    default:
      return shot ?? null;   // deflections, parries, posts and walls keep the shot alive
  }
}

/**
 * The feed line for a game event, or null when the event is not news.
 * @param {object} evt  GameEvt
 * @param {{init:?object, players:?Array, shot:?object, time:number}} ctx
 *        players = FrameView.players at the moment of the event; shot = the value kept with nextShot
 * @returns {?{kind:string, team:number, tag:string, text:string}}
 */
export function feedForEvent(evt, ctx) {
  if (!evt) return null;
  switch (evt.type) {
    case EVT.GOAL: {
      const goal = describeGoal(evt, ctx?.init);
      const scorer = partyLabel(goal.scorer);
      if (goal.ownGoal) {
        return { kind: 'own', team: goal.team, tag: 'Own goal', text: scorer || 'Into their own net' };
      }
      const assist = goal.assist ? ` (assist ${partyLabel(goal.assist)})` : '';
      return { kind: 'goal', team: goal.team, tag: 'Goal', text: `${scorer || 'Scored'}${assist}` };
    }
    case EVT.KEEPER_CATCH:
    case EVT.KEEPER_PARRY:
    case EVT.BLOCK: {
      const stopper = actor(ctx, evt.a);
      if (!stopper) return null;
      const shot = ctx?.shot ?? null;
      const blocked = evt.type === EVT.BLOCK;
      // A block is by definition an on-target shot stopped; catches and parries must have denied one.
      if (!blocked && !isShotStop(evt, shot, stopper.team, num(ctx?.time, 0))) return null;
      const denied = shot && shot.team !== stopper.team ? ` denies ${shot.label}` : '';
      return { kind: 'save', team: stopper.team, tag: blocked ? 'Block' : 'Save', text: `${stopper.label}${denied}` };
    }
    case EVT.TACKLE_HIT: {
      if (evt.f !== 1) return null;
      const slider = actor(ctx, evt.a);
      if (!slider) return null;
      const victim = actor(ctx, evt.b);
      if (!slider.human && !(victim && victim.human)) return null;   // AI scuffles are not news
      const text = victim ? `${slider.label} robs ${victim.label}` : `${slider.label} wins the ball`;
      return { kind: 'tackle', team: slider.team, tag: 'Tackle', text };
    }
    case EVT.POST_HIT: {
      const shot = ctx?.shot ?? null;
      if (!shot || num(evt.v, 0) < 0.3 || num(ctx?.time, 0) - shot.time > 2.5) return null;
      return { kind: 'post', team: shot.team, tag: 'Woodwork', text: `${shot.label} hits the post` };
    }
    case EVT.OVERTIME:
      return { kind: 'gold', team: -1, tag: 'Golden goal', text: 'Next goal wins' };
    default:
      return null;
  }
}

/**
 * The feed line for a ChatDto. System announcements are shown exactly as the server worded them.
 * @returns {?{kind:string, team:number, name?:string, color?:string, tag?:string, text:string}}
 */
export function feedForChat(chat, room) {
  if (!chat) return null;
  if (chat.system) {
    const text = cleanText(chat.text, 200);
    return text ? { kind: 'system', team: -1, tag: '', text } : null;
  }
  const text = cleanText(chat.text, LIMITS.chat);
  if (!text) return null;
  const color = safeColor(memberById(room, chat.memberId)?.color, '');
  return {
    kind: 'chat',
    team: chat.team === 0 || chat.team === 1 ? chat.team : -1,
    name: cleanText(chat.name, LIMITS.nickname) || 'Someone',
    color: color ? tintForDark(color) : '',
    text,
  };
}

/** The feed line for an EmoteDto (the bubble above the footballer is the renderer's). */
export function feedForEmote(emote, room, init) {
  if (!emote) return null;
  const glyph = Number.isInteger(emote.emote) ? EMOTES[emote.emote] : undefined;
  if (typeof glyph !== 'string') return null;
  const member = memberById(room, emote.memberId);
  const human = num(emote.humanId, -1) >= 0 ? humanById(init, emote.humanId) : humanByMember(init, emote.memberId);
  const color = safeColor(member?.color ?? human?.color, '');
  let team = -1;
  if (human) team = human.team === 1 ? 1 : 0;
  else if (member && (member.team === 0 || member.team === 1)) team = member.team;
  return {
    kind: 'emote',
    team,
    who: num(emote.memberId, 0),
    name: cleanText(member?.name ?? human?.name, LIMITS.nickname) || 'Someone',
    color: color ? tintForDark(color) : '',
    text: glyph,
    glyphs: 1,
  };
}

/** Emotes one feed line holds before the next one starts a new line. */
export const EMOTE_RUN = 6;

/**
 * A burst of emotes from one person reads as one line ("Ana 😂😂🔥") instead of pushing the
 * goals out of the feed.
 * @param {?object} last   the newest feed entry
 * @param {?object} entry  the emote entry that has just arrived
 * @returns {?object} the entry to show in place of `last`, or null when `entry` needs its own line
 */
export function mergeEmote(last, entry) {
  if (!last || !entry || last.kind !== 'emote' || entry.kind !== 'emote') return null;
  if (!(last.who > 0) || last.who !== entry.who) return null;
  const glyphs = num(last.glyphs, 1);
  if (glyphs >= EMOTE_RUN) return null;
  return { ...last, text: `${last.text}${entry.text}`, glyphs: glyphs + 1 };
}

/** Seconds a feed entry stays up: goals linger, long chat lines get reading time. */
export function feedTtl(entry) {
  switch (entry?.kind) {
    case 'goal':
    case 'own':
    case 'gold':
      return 8;
    case 'chat':
      return Math.min(10, 5.5 + String(entry.text ?? '').length * 0.06);
    case 'system':
      return 6.5;
    case 'emote':
      return 4;
    default:
      return 4.5;
  }
}

const NOTHING = Object.freeze([]);

/**
 * The feed's bookkeeping: at most `max` entries, each with its own expiry. The DOM layer maps
 * item ids to elements.
 */
export class FeedQueue {
  constructor(max = FEED_MAX) {
    this.max = Math.max(1, max | 0);
    this.items = [];
    this.nextId = 1;
  }

  get size() {
    return this.items.length;
  }

  /** The newest item, or null. */
  get last() {
    return this.items.length > 0 ? this.items[this.items.length - 1] : null;
  }

  /** Adds an entry and returns it with the entries it pushed out (oldest first). */
  push(entry, now, ttl) {
    const item = { id: this.nextId++, entry, expires: num(now, 0) + Math.max(0.5, num(ttl, 4)) };
    this.items.push(item);
    const dropped = [];
    while (this.items.length > this.max) dropped.push(this.items.shift());
    return { item, dropped };
  }

  /** Replaces what an item shows and gives it a fresh lifetime. */
  renew(item, entry, now, ttl) {
    item.entry = entry;
    item.expires = num(now, 0) + Math.max(0.5, num(ttl, 4));
  }

  /** Removes and returns the entries whose time is up. Allocates nothing on the (usual) frame where none is. */
  expire(now) {
    let due = false;
    for (const item of this.items) {
      if (item.expires <= now) {
        due = true;
        break;
      }
    }
    if (!due) return NOTHING;
    const expired = [];
    const kept = [];
    for (const item of this.items) {
      if (item.expires <= now) expired.push(item);
      else kept.push(item);
    }
    this.items = kept;
    return expired;
  }

  clear() {
    const all = this.items;
    this.items = [];
    return all;
  }
}

// ------------------------------------------------------------------------------------
//  Possession
// ------------------------------------------------------------------------------------

/**
 * Team shown as "on the ball". A loose ball keeps the last team (a pass in flight is still
 * possession); a dead ball belongs to nobody.
 * @param {?{owner:number, dead:boolean}} ball
 * @param {?Array<{team:number}>} players  indexed like the snapshot
 * @param {number} previous                last value returned (-1 = nobody)
 */
export function possessionTeam(ball, players, previous) {
  if (!ball || ball.dead) return -1;
  const owner = num(ball.owner, -1);
  if (owner >= 0) {
    const team = players?.[owner | 0]?.team;
    if (team === 0 || team === 1) return team;
  }
  return previous === 0 || previous === 1 ? previous : -1;
}

// ------------------------------------------------------------------------------------
//  Roster (the Tab panel)
// ------------------------------------------------------------------------------------

/** Bit mask of the human ids that control a footballer right now. */
export function controllingHumans(players) {
  let mask = 0;
  if (Array.isArray(players)) {
    for (const p of players) {
      const id = num(p?.ctrl, -1);
      if (id >= 0 && id < 31) mask |= 1 << id;
    }
  }
  return mask;
}

/**
 * Who is in the match: the humans seated when it started (MatchInit.humans, fixed), joined with
 * the room's live member list for ping and presence, plus everybody else as spectators.
 *
 * presence: 'here' | 'away' (in the room but not at the controls: the AI has their footballer) |
 *           'offline' (connection lost, seat kept) | 'left' (no longer in the room).
 *
 * @param {?number} controlling  mask from controllingHumans(), or null when it means nothing
 *                               (no live play: results, full time)
 */
export function rosterModel(init, room, memberId, controlling = null) {
  // Without a member list nobody can be said to have left: the room state simply is not here yet.
  const listed = Array.isArray(room?.members);
  const members = listed ? room.members.filter(Boolean) : [];
  const hostId = room?.hostId;
  const teams = [[], []];
  const seated = new Set();
  const judgeControls = typeof controlling === 'number';
  for (const human of Array.isArray(init?.humans) ? init.humans : []) {
    if (!human) continue;
    const member = members.find((m) => m.id === human.memberId) ?? null;
    const humanId = num(human.humanId, -1);
    const atControls = !judgeControls || (humanId >= 0 && humanId < 31 && (controlling & (1 << humanId)) !== 0);
    let presence = atControls ? 'here' : 'away';
    if (listed && !member) presence = 'left';
    else if (member && member.connected === false) presence = 'offline';
    seated.add(human.memberId);
    teams[human.team === 1 ? 1 : 0].push({
      humanId,
      memberId: human.memberId,
      name: cleanText(member?.name ?? human.name, LIMITS.nickname) || 'Player',
      color: tintForDark(safeColor(member?.color, safeColor(human.color, '#a9b6d6'))),
      ping: member ? num(member.ping, -1) : -1,
      presence,
      me: human.memberId === memberId,
      host: !!member && member.id === hostId,
    });
  }
  const spectators = [];
  for (const member of members) {
    if (seated.has(member.id)) continue;
    spectators.push({
      memberId: member.id,
      name: cleanText(member.name, LIMITS.nickname) || 'Guest',
      color: tintForDark(safeColor(member.color, '#a9b6d6')),
      ping: num(member.ping, -1),
      presence: member.connected === false ? 'offline' : 'here',
      me: member.id === memberId,
      host: member.id === hostId,
    });
  }
  return { teams, spectators };
}

/** Label of a presence that needs one ("" for someone who is simply here). */
export function presenceLabel(presence) {
  switch (presence) {
    case 'away':
      return 'Away';
    case 'offline':
      return 'Offline';
    case 'left':
      return 'Left';
    default:
      return '';
  }
}

// ------------------------------------------------------------------------------------
//  Results
// ------------------------------------------------------------------------------------

function comparison(label, home, away, homeText, awayText) {
  const total = home + away;
  return {
    label,
    home: homeText ?? String(home),
    away: awayText ?? String(away),
    share: total > 0 ? home / total : 0.5,
    empty: total === 0,
  };
}

/**
 * Everything the results screen shows, as plain data.
 * @param {object} result  MatchResultDto
 * @returns {{score:number[], winner:number, overtime:boolean, headline:string, note:string, teams:object[],
 *            goals:Array<{minute:string, team:number, scorer:string, assist:string, ownGoal:boolean}>,
 *            humans:Array<object>, bars:Array<{label:string, home:string, away:string, share:number, empty:boolean}>}}
 */
export function resultsModel(result, init, room, memberId) {
  const r = result ?? {};
  const teams = [teamInfo(init, room, 0), teamInfo(init, room, 1)];
  const score = [count(r.score?.[0]), count(r.score?.[1])];
  const winner = r.winner === 0 || r.winner === 1 ? r.winner : -1;
  const regulation = init?.practice ? 0 : count(init?.settings?.minutes);

  const goals = (Array.isArray(r.goals) ? r.goals : [])
    .filter(Boolean)
    .map((g) => ({
      time: Math.max(0, num(g.time, 0)),
      minute: goalMinute(g.time, regulation),
      team: g.team === 1 ? 1 : 0,
      scorer: cleanText(g.scorer, 24) || 'Unknown',
      assist: g.ownGoal ? '' : cleanText(g.assist, 24),
      ownGoal: !!g.ownGoal,
    }))
    .sort((a, b) => a.time - b.time);

  const mvp = num(r.mvp, -1);
  const humans = (Array.isArray(r.humans) ? r.humans : [])
    .filter(Boolean)
    .map((h) => ({
      humanId: num(h.humanId, -1),
      name: cleanText(h.name, LIMITS.nickname) || 'Player',
      team: h.team === 1 ? 1 : 0,
      color: tintForDark(safeColor(h.color, '#a9b6d6')),
      me: typeof memberId === 'number' && memberId > 0 && h.memberId === memberId,
      mvp: mvp >= 0 && h.humanId === mvp,
      goals: count(h.goals),
      ownGoals: count(h.ownGoals),
      assists: count(h.assists),
      shots: count(h.shots),
      onTarget: count(h.shotsOnTarget),
      saves: count(h.saves),
      tackles: count(h.tackles),
      steals: count(h.steals),
      passes: `${count(h.passesCompleted)}/${count(h.passesAttempted)}`,
      rating: Math.round(num(h.rating, 0)),
    }))
    .sort((a, b) => (Number(b.mvp) - Number(a.mvp)) || (b.rating - a.rating) || (a.humanId - b.humanId));

  const home = r.teams?.[0] ?? {};
  const away = r.teams?.[1] ?? {};
  const bars = [
    comparison('Possession', count(home.possession), count(away.possession), `${count(home.possession)}%`, `${count(away.possession)}%`),
    comparison('Shots', count(home.shots), count(away.shots)),
    comparison('On target', count(home.shotsOnTarget), count(away.shotsOnTarget)),
    comparison('Passes', count(home.passesCompleted), count(away.passesCompleted),
      `${count(home.passesCompleted)}/${count(home.passesAttempted)}`,
      `${count(away.passesCompleted)}/${count(away.passesAttempted)}`),
    comparison('Tackles', count(home.tackles), count(away.tackles)),
    comparison('Saves', count(home.saves), count(away.saves)),
  ];

  return {
    score,
    winner,
    overtime: !!r.overtime,
    headline: winner >= 0 ? `${teams[winner].name} win` : 'Draw',
    note: r.overtime ? 'after golden goal' : '',
    teams,
    goals,
    humans,
    bars,
  };
}
