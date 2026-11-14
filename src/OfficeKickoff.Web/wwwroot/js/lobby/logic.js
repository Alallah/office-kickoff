// Pure lobby logic: text cleaning, seating, the notes shown around Ready / Start, link building.
// Nothing here touches the DOM or storage, so all of it can be unit-tested headless.

import { LIMITS, ROUTES } from '../shared/protocol.js';

/** Human seats per team (Vocabulary.HumansPerTeam). */
export const SEATS_PER_TEAM = 2;

// C0 / C1 controls, line separators and bidi overrides: none of them belong in a name or a chat
// line. Tested by code unit so that no invisible character has to appear in this file.
function isUnwanted(c) {
  return (
    c <= 0x1f ||
    (c >= 0x7f && c <= 0x9f) ||
    c === 0x2028 ||
    c === 0x2029 ||
    (c >= 0x202a && c <= 0x202e) ||
    (c >= 0x2066 && c <= 0x2069)
  );
}

function stripUnwanted(s) {
  let out = '';
  for (let i = 0; i < s.length; i++) out += isUnwanted(s.charCodeAt(i)) ? ' ' : s[i];
  return out;
}

/** Cuts a string to `max` UTF-16 units without splitting a surrogate pair. */
export function clampText(text, max) {
  const s = String(text ?? '');
  if (s.length <= max) return s;
  let end = Math.max(0, max);
  const last = s.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return s.slice(0, end);
}

/** Single-line text as the server will want it: no control characters, single spaces, trimmed, clamped. */
export function cleanText(text, max) {
  const s = stripUnwanted(String(text ?? '')).replace(/\s+/g, ' ').trim();
  return clampText(s, max).trim();
}

export function cleanNickname(text) {
  return cleanText(text, LIMITS.nickname);
}

export function cleanChat(text) {
  return cleanText(text, LIMITS.chat);
}

/**
 * Room code from whatever was typed or pasted: a bare code, or a whole invite link
 * (".../room/ABCD") or join link ("...?code=ABCD"). Room codes are letters only, so anything
 * else that was typed is dropped; a pasted link without a code in it gives nothing at all
 * rather than the first letters of "http".
 */
export function extractRoomCode(text) {
  const s = String(text ?? '');
  const n = LIMITS.roomCode;
  const fromLink = new RegExp(`/room/([a-z]{${n}})(?![a-z0-9])`, 'i').exec(s);
  if (fromLink) return fromLink[1].toUpperCase();
  const fromQuery = new RegExp(`[?&]code=([a-z]{${n}})(?![a-z0-9])`, 'i').exec(s);
  if (fromQuery) return fromQuery[1].toUpperCase();
  if (/:\/\/|\/room\b|\bcode=/i.test(s)) return '';
  return s.replace(/[^a-z]/gi, '').slice(0, n).toUpperCase();
}

export function isRoomCode(text) {
  return new RegExp(`^[A-Z]{${LIMITS.roomCode}}$`).test(String(text ?? ''));
}

/** Home-page error code for a failed Join ('not_found' | 'invalid' | 'full' | 'unreachable'). */
export function homeErrorFor(joinError) {
  return joinError === 'full' ? 'full' : 'notfound';
}

/**
 * Home-page error code for a Closed(reason). Besides 'closed' and 'replaced' the reason can be a
 * Join error after a reconnect: a room that vanished meanwhile reads as closed, a seat that was
 * taken reads as full.
 */
export function closedErrorFor(reason) {
  if (reason === 'replaced') return 'replaced';
  if (reason === 'full') return 'full';
  return 'closed';
}

/** Adds the room code to a ROUTES.home(...) URL so the Home page can keep it in the join box. */
export function appendCode(url, code) {
  if (!code) return url;
  return `${url}${url.includes('?') ? '&' : '?'}code=${encodeURIComponent(code)}`;
}

/**
 * Where the lobby sends the browser when it has to give up on a room. The code rides along
 * whenever joining again could work (a mistyped link, a full room, a seat taken over by another
 * tab), so the Home page keeps it in the join box; a closed room's code is dead and is dropped.
 * @param {string} error  Home-page error code
 * @param {string} code   room code
 */
export function exitUrl(error, code) {
  const url = ROUTES.home(error);
  return error === 'closed' ? url : appendCode(url, code);
}

/** Absolute link from the page origin ("http://server") and an app path ("/kickoff/room/ABCD"). */
export function absoluteUrl(origin, path) {
  const base = String(origin ?? '').replace(/\/+$/, '');
  const rest = String(path ?? '');
  return `${base}${rest.startsWith('/') ? '' : '/'}${rest}`;
}

/** The link colleagues open to land in this lobby. */
export function inviteUrl(origin, code) {
  return absoluteUrl(origin, ROUTES.lobby(code));
}

/** First visible character of a name, for the avatar disc. */
export function initialOf(name) {
  const first = Array.from(String(name ?? '').trim())[0];
  return first ? first.toUpperCase() : '?';
}

/** 'good' | 'ok' | 'bad' | 'none' for a round-trip time in ms (-1 = unknown). */
export function pingTone(ms) {
  if (!Number.isFinite(ms) || ms < 0) return 'none';
  if (ms <= 70) return 'good';
  if (ms <= 140) return 'ok';
  return 'bad';
}

export function formatPing(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '-- ms';
  return ms > 999 ? '999+ ms' : `${Math.round(ms)} ms`;
}

/** "Sam", "Sam and Alex", "Sam, Alex and 2 more". */
export function listNames(names, max = 2) {
  const list = names.filter(Boolean);
  if (list.length === 0) return '';
  if (list.length === 1) return list[0];
  if (list.length <= max) return `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`;
  const rest = list.length - max;
  return `${list.slice(0, max).join(', ')} and ${rest} more`;
}

/**
 * Stable seating. The room only says which team a member is on, so the page decides which of the
 * team's seats to draw them in: a member keeps the seat they were last shown in and a newcomer
 * takes the first free one, so nobody jumps about when a team-mate leaves.
 * @param {?number[][]} prev   member id per seat for each team (0 = empty), from the previous call
 * @param {Array<{id:number, team:number}>} members
 * @returns {number[][]}
 */
export function assignSeats(prev, members) {
  const out = [];
  for (let team = 0; team < 2; team++) {
    const ids = members.filter((m) => m.team === team).map((m) => m.id);
    const before = Array.isArray(prev?.[team]) ? prev[team] : [];
    const seats = new Array(Math.max(SEATS_PER_TEAM, ids.length)).fill(0);
    const placed = new Set();
    before.forEach((id, i) => {
      if (id && i < seats.length && ids.includes(id) && !placed.has(id)) {
        seats[i] = id;
        placed.add(id);
      }
    });
    for (const id of ids) {
      if (placed.has(id)) continue;
      seats[seats.indexOf(0)] = id;
      placed.add(id);
    }
    out.push(seats);
  }
  return out;
}

/**
 * Everything the lobby derives from a RoomStateDto for the local member.
 * @param {object} room        RoomStateDto
 * @param {number} memberId    the local member's id
 * @param {?number[][]} prevSeats  seatIds of the previous view (see assignSeats)
 */
export function deriveLobby(room, memberId, prevSeats) {
  const members = Array.isArray(room?.members) ? room.members.filter((m) => m !== null && typeof m === 'object') : [];
  const byId = new Map(members.map((m) => [m.id, m]));
  const me = byId.get(memberId) ?? null;
  const host = byId.get(room?.hostId) ?? null;
  const isHost = me !== null && me.id === room?.hostId;
  const myTeam = me !== null && (me.team === 0 || me.team === 1) ? me.team : -1;
  const seatIds = assignSeats(prevSeats, members);
  const seats = seatIds.map((ids) => ids.map((id) => (id ? byId.get(id) ?? null : null)));
  return {
    members,
    byId,
    me,
    host,
    isHost,
    myTeam,
    seatIds,
    seats,
    spectators: members.filter((m) => m.team !== 0 && m.team !== 1),
    /** Who may change each team: the host, and the humans seated on it. */
    canEdit: [isHost || myTeam === 0, isHost || myTeam === 1],
    teamFull: seats.map((list) => list.filter(Boolean).length >= SEATS_PER_TEAM),
  };
}

function teamLabel(room, team) {
  const name = room?.teams?.[team]?.config?.name;
  return name || (team === 0 ? 'the home team' : 'the away team');
}

/**
 * The quiet line next to the host's Start button. Start is never blocked, so this only explains
 * what will happen: who is not ready, and where the AI steps in.
 */
export function hostNote(room, view) {
  const seated = view.seats.flat().filter(Boolean);
  if (room?.practice && seated.length <= 1) {
    return 'Practice: no clock, no score limit. The AI plays every other shirt.';
  }
  if (seated.length === 0) return 'Nobody has taken a seat, so the AI will play both teams.';

  const notes = [];
  const emptyTeams = [0, 1].filter((t) => !view.seats[t].some(Boolean));
  if (emptyTeams.length === 1) notes.push(`No humans on ${teamLabel(room, emptyTeams[0])}: AI will fill in.`);

  const others = seated.filter((m) => m.id !== view.me?.id);
  const away = others.filter((m) => !m.connected).map((m) => m.name);
  const waiting = others.filter((m) => m.connected && !m.ready).map((m) => m.name);
  if (away.length > 0) {
    notes.push(`${listNames(away)} ${away.length === 1 ? 'is' : 'are'} disconnected: AI covers until they are back.`);
  }
  if (waiting.length > 0) {
    notes.push(`${listNames(waiting)} ${waiting.length === 1 ? "isn't" : "aren't"} ready yet. You can start anyway.`);
  }
  if (notes.length === 0) return others.length > 0 ? 'Everyone is ready.' : 'Ready when you are.';
  return notes.join(' ');
}

/** What everyone except the host reads where the Start button would be. */
export function guestNote(view) {
  const host = view.host;
  if (!host) return 'Waiting for the host to start';
  if (!host.connected) return `Waiting for ${host.name} to start (they are reconnecting)`;
  return `Waiting for ${host.name} to start`;
}

/**
 * What the Ready / Start area shows for the local member.
 * @param {object} room   RoomStateDto
 * @param {object} view   deriveLobby(...)
 * @param {?boolean} [readyOverride]  the Ready state the member just asked for, while its echo is on the way
 * @returns {{showReady: boolean, ready: boolean, showStart: boolean, allReady: boolean, headline: string, detail: string}}
 */
export function startModel(room, view, readyOverride = null) {
  const seated = view.myTeam >= 0;
  const ready = seated && (typeof readyOverride === 'boolean' ? readyOverride : view.me?.ready === true);
  const others = view.seats.flat().filter((m) => m && m.id !== view.me?.id);
  const allReady = others.length > 0 && others.every((m) => m.connected && m.ready);
  if (view.isHost) {
    return { showReady: seated, ready, showStart: true, allReady, headline: '', detail: hostNote(room, view) };
  }
  let detail;
  if (!seated) detail = 'You are watching. Take a seat to play.';
  else if (ready) detail = 'You are ready.';
  else detail = 'Hit Ready when you are set.';
  return { showReady: seated, ready, showStart: false, allReady, headline: guestNote(view), detail };
}

/**
 * How one occupied seat (or spectator chip) reads.
 * @param {object} member  MemberDto
 * @param {number} memberId  the local member's id
 * @param {number} hostId    RoomStateDto.hostId
 */
export function seatModel(member, memberId, hostId) {
  const connected = member.connected !== false;
  let status = 'Not ready';
  let tone = 'idle';
  if (!connected) {
    status = 'Disconnected';
    tone = 'away';
  } else if (member.ready) {
    status = 'Ready';
    tone = 'ready';
  }
  return {
    id: member.id,
    name: member.name || 'Player',
    initial: initialOf(member.name),
    isMe: member.id === memberId,
    isHost: member.id === hostId,
    connected,
    status,
    tone,
    pingText: connected ? formatPing(member.ping) : '',
    pingTone: connected ? pingTone(member.ping) : 'none',
  };
}

/**
 * Seats, as "team:index" keys, that now hold a member they did not hold in the previous view:
 * the ones that get the little bounce.
 * @param {?number[][]} prev  seatIds of the previous view (null on the first render: nothing bounces)
 * @param {number[][]} next
 * @returns {Set<string>}
 */
export function newlySeated(prev, next) {
  const out = new Set();
  if (!Array.isArray(prev)) return out;
  next.forEach((ids, team) => {
    ids.forEach((id, i) => {
      if (id && prev[team]?.[i] !== id) out.add(`${team}:${i}`);
    });
  });
  return out;
}

/**
 * Sliding-window limiter. The server silently drops chat beyond its rate limit; mirroring the
 * limit here lets the page say so instead of letting a line vanish.
 * @param {number} max       sends allowed per window
 * @param {number} windowMs
 */
export function createRateLimiter(max, windowMs) {
  let stamps = [];
  const prune = (now) => {
    stamps = stamps.filter((t) => now - t < windowMs);
  };
  return {
    /** Takes a slot when one is free. @returns {boolean} */
    tryTake(now) {
      prune(now);
      if (stamps.length >= max) return false;
      stamps.push(now);
      return true;
    },
    /** Gives the most recent slot back (the send never left the browser). */
    refund() {
      stamps.pop();
    },
    /** Milliseconds until a slot frees up; 0 when one is free now. */
    waitMs(now) {
      prune(now);
      return stamps.length < max ? 0 : Math.max(0, windowMs - (now - stamps[0]));
    },
  };
}

/**
 * A value the user just asked for, shown at once while the server's confirmation is on its way
 * (the Ready button, the nickname box). The request wins over what the server says until the
 * server agrees or `holdMs` have passed, so a RoomState that was already in flight cannot flick
 * the control back.
 * @param {number} [holdMs]
 */
export function createPendingValue(holdMs = 1200) {
  let wanted = null;
  let until = 0;
  return {
    /** The user asked for `value`. */
    request(value, now) {
      wanted = value;
      until = now + holdMs;
    },
    /** What to show, given what the server says now. */
    resolve(serverValue, now) {
      if (wanted === null) return serverValue;
      if (serverValue === wanted || now >= until) {
        wanted = null;
        return serverValue;
      }
      return wanted;
    },
    get pending() {
      return wanted !== null;
    },
    clear() {
      wanted = null;
    },
  };
}

/** True when a scrolling list shows its last line (so new lines should keep it pinned there). */
export function isNearBottom(scrollTop, clientHeight, scrollHeight, slack = 28) {
  return scrollHeight - (scrollTop + clientHeight) <= slack;
}

const CELEBRATIONS = Object.freeze({
  spin: Object.freeze({ label: 'Victory spin', emoji: '🌀' }),
  dab: Object.freeze({ label: 'The dab', emoji: '😎' }),
  confetti: Object.freeze({ label: 'Confetti cannon', emoji: '🎉' }),
  backflip: Object.freeze({ label: 'Backflip', emoji: '🤸' }),
  shockwave: Object.freeze({ label: 'Shockwave', emoji: '💥' }),
  hearts: Object.freeze({ label: 'Hearts', emoji: '💖' }),
});

/** Friendly name and emoji for a goal-celebration id; ids this page has never heard of still get a label. */
export function celebrationInfo(id) {
  const key = String(id ?? '');
  if (Object.prototype.hasOwnProperty.call(CELEBRATIONS, key)) return CELEBRATIONS[key];
  const words = cleanText(key.replace(/[-_]+/g, ' '), 24);
  return { label: words ? words[0].toUpperCase() + words.slice(1) : 'Celebration', emoji: '⚽' };
}

/** What the header says about the connection. */
export function connectionLabel(status) {
  if (status === 'reconnecting') return 'Reconnecting';
  if (status === 'disconnected') return 'Offline';
  return 'Connected';
}

/** "3 s" for the chat limiter's wait, never "0 s". */
export function formatWait(ms) {
  return `${Math.max(1, Math.ceil(ms / 1000))} s`;
}
