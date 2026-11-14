// Who this browser tab is, and what it remembers.
//
//  - playerId lives in sessionStorage: it survives reloads and page changes inside one tab, and
//    every tab gets its own (so several tabs on one machine are several players).
//  - preferences live in localStorage so they survive closing the browser. The nickname is also
//    mirrored into sessionStorage so two tabs can use different names at the same time.
//
// Storage can be unavailable (private windows, blocked site data): every access is guarded and
// the page keeps working with in-memory values.

const PREFS_KEY = 'ok.prefs';
const TEAMS_KEY = 'ok.myTeams';
const ID_KEY = 'ok.playerId';
const NICK_KEY = 'ok.nickname';

const SESSION = 'sessionStorage';
const LOCAL = 'localStorage';

const DEFAULT_PREFS = Object.freeze({
  nickname: '',
  color: '',            // '' = let the server pick
  celebration: 'spin',
  autoSwitch: true,
  volume: 0.7,
  muted: false,
  lastTeam: null,       // TeamConfigDto last used, offered again in the next lobby
});

const memory = new Map();

// `store` is the NAME of the storage object: with site data blocked, merely touching
// window.localStorage throws, so it must be looked up inside the guard.
function read(store, key) {
  try {
    const v = globalThis[store].getItem(key);
    return v === null ? memory.get(`${store}:${key}`) ?? null : v;
  } catch {
    return memory.get(`${store}:${key}`) ?? null;
  }
}

function write(store, key, value) {
  memory.set(`${store}:${key}`, value);
  try {
    globalThis[store].setItem(key, value);
  } catch {
    /* in-memory only */
  }
}

// crypto.randomUUID only exists in secure contexts; the game also runs over plain http.
function randomId() {
  try {
    if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
  } catch {
    /* fall through */
  }
  const bytes = new Uint8Array(16);
  try {
    crypto.getRandomValues(bytes);
  } catch {
    for (let i = 0; i < bytes.length; i++) bytes[i] = (Math.random() * 256) | 0;
  }
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Secret id of this tab (32+ characters); stable across reloads and lobby <-> match navigation. */
export function getPlayerId() {
  let id = read(SESSION, ID_KEY);
  if (!id) {
    id = randomId();
    write(SESSION, ID_KEY, id);
  }
  return id;
}

/** @returns {{nickname:string,color:string,celebration:string,autoSwitch:boolean,volume:number,muted:boolean,lastTeam:?object}} */
export function getPrefs() {
  let stored = {};
  try {
    stored = JSON.parse(read(LOCAL, PREFS_KEY) || '{}') || {};
  } catch {
    stored = {};
  }
  const prefs = { ...DEFAULT_PREFS, ...stored };
  const tabNick = read(SESSION, NICK_KEY);
  if (tabNick) prefs.nickname = tabNick;
  return prefs;
}

/** Merges the given fields into the stored preferences and returns the result. */
export function savePrefs(partial) {
  const next = { ...getPrefs(), ...partial };
  write(LOCAL, PREFS_KEY, JSON.stringify(next));
  if (typeof partial.nickname === 'string') write(SESSION, NICK_KEY, partial.nickname);
  return next;
}

/** A friendly default so nobody is forced to type a name. */
export function suggestNickname() {
  const a = ['Swift', 'Tidy', 'Clinical', 'Cheeky', 'Silky', 'Rapid', 'Steady', 'Lucky', 'Sneaky', 'Mighty'];
  const b = ['Striker', 'Winger', 'Sweeper', 'Playmaker', 'Poacher', 'Anchor', 'Finisher', 'Dribbler', 'Tackler', 'Maestro'];
  const pick = (list) => list[(Math.random() * list.length) | 0];
  return `${pick(a)}${pick(b)}`.slice(0, 16);
}

/** Custom teams saved on this machine. @returns {Array<{id:string, team:object}>} */
export function getMyTeams() {
  try {
    const list = JSON.parse(read(LOCAL, TEAMS_KEY) || '[]');
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

/** Saves (or replaces, by id) a custom team. Returns the stored entry. */
export function saveMyTeam(team, id = null) {
  const list = getMyTeams();
  const entry = { id: id ?? randomId().slice(0, 8), team };
  const at = list.findIndex((t) => t.id === entry.id);
  if (at >= 0) list[at] = entry;
  else list.push(entry);
  write(LOCAL, TEAMS_KEY, JSON.stringify(list.slice(-24)));
  return entry;
}

export function deleteMyTeam(id) {
  write(LOCAL, TEAMS_KEY, JSON.stringify(getMyTeams().filter((t) => t.id !== id)));
}
