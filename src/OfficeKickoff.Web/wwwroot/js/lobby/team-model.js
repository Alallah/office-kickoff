// Pure team logic: cleaning a TeamConfigDto (typed, imported or remembered), comparing teams,
// import / export, and where the footballers of a formation stand on the mini pitch.
// No DOM, no storage: unit-testable headless.

import { safeColor } from '../shared/crests.js';
import { CRESTS, LIMITS } from '../shared/protocol.js';
import { cleanText } from './logic.js';

const HEX6 = /^#[0-9a-f]{6}$/i;
const HEX3 = /^#[0-9a-f]{3}$/i;
const FORMATION = /^\d(-\d){0,3}$/;

/** Team files are a few hundred bytes; anything far beyond that is not one. */
const MAX_IMPORT_CHARS = 20000;

/** Mirror of Formations.cs, used only if the server's catalogue has no entry for a team size. */
export const FALLBACK_FORMATIONS = Object.freeze({
  3: Object.freeze(['1-1', '2-0', '0-2']),
  4: Object.freeze(['1-2', '2-1', '1-1-1']),
  5: Object.freeze(['2-2', '1-2-1', '3-1', '1-3']),
  6: Object.freeze(['2-2-1', '2-1-2', '3-2', '1-3-1']),
  7: Object.freeze(['2-3-1', '3-2-1', '2-2-2', '3-1-2']),
});

export const DEFAULT_NUMBERS = Object.freeze([1, 4, 5, 8, 10, 7, 9]);

/** Last-resort values for fields that are missing everywhere else. */
export const DEFAULT_TEAM = Object.freeze({
  presetId: null,
  name: 'Custom Team',
  code: 'CUS',
  primary: '#3b82f6',
  secondary: '#ffffff',
  keeper: '#ffd166',
  crest: 'shield',
  formation: '',
  roster: Object.freeze(
    DEFAULT_NUMBERS.map((number, i) => Object.freeze({ name: i === 0 ? 'Keeper' : `Player ${i + 1}`, number })),
  ),
});

/** Kit colours that read well on the night pitch; offered next to the free colour pickers. */
export const KIT_SWATCHES = Object.freeze(
  [
    ['#e63946', 'Red'], ['#ff8a1f', 'Orange'], ['#ffd166', 'Yellow'], ['#b6ff3c', 'Lime'],
    ['#19b38a', 'Teal'], ['#2ee6ff', 'Cyan'], ['#3b82f6', 'Blue'], ['#6d5bff', 'Indigo'],
    ['#c05cff', 'Purple'], ['#ff6b9d', 'Pink'], ['#f4f7ff', 'White'], ['#1d2540', 'Navy'],
  ].map(([hex, name]) => Object.freeze({ hex, name })),
);

/** The turf colour footballers are drawn on (theme.css --pitch): a shirt this colour disappears. */
export const PITCH_GREEN = '#17603a';

export function isHexColor(value) {
  return typeof value === 'string' && HEX6.test(value);
}

/** Lower-case "#rrggbb" ("#rgb" is expanded), or `fallback` when the value is not a colour. */
export function normColor(value, fallback) {
  if (typeof value !== 'string') return fallback;
  const v = value.trim();
  if (HEX6.test(v)) return v.toLowerCase();
  if (HEX3.test(v)) return `#${v[1]}${v[1]}${v[2]}${v[2]}${v[3]}${v[3]}`.toLowerCase();
  return fallback;
}

function sameColor(a, b) {
  return String(a ?? '').toLowerCase() === String(b ?? '').toLowerCase();
}

/** Up to three characters of a scoreboard code: A-Z and digits, upper case. */
export function cleanTeamCode(text) {
  return String(text ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, LIMITS.teamCode);
}

/** A scoreboard code for a team name: initials when there are enough words, otherwise leading letters. */
export function codeFromName(name) {
  const words = String(name ?? '').toUpperCase().split(/[^A-Z0-9]+/).filter(Boolean);
  let code = '';
  if (words.length >= 3) code = words.map((w) => w[0]).join('');
  else if (words.length === 2) code = words[0][0] + words[1].slice(0, 2);
  else if (words.length === 1) code = words[0];
  return `${code}${words.join('')}XXX`.slice(0, LIMITS.teamCode);
}

function toShirtNumber(value, fallback) {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isFinite(n)) return fallback;
  return Math.min(99, Math.max(1, Math.round(n)));
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Returns a complete, well-formed TeamConfigDto built from untrusted input. Text is cleaned and
 * clamped, colours and the crest are validated, the roster always has exactly seven entries, and
 * unknown fields are dropped. Anything missing or invalid is taken from `opts.fallback`.
 * @param {*} raw
 * @param {{fallback?: object, crests?: string[], formations?: string[]}} [opts]
 *        `formations`: every formation name the game knows (see allFormationNames); when given,
 *        a formation outside it counts as invalid. Without it only the "2-1-1" shape is checked.
 */
export function sanitizeTeam(raw, opts = {}) {
  const fb = isPlainObject(opts.fallback) ? opts.fallback : DEFAULT_TEAM;
  const crests = Array.isArray(opts.crests) && opts.crests.length > 0 ? opts.crests : CRESTS;
  const known = Array.isArray(opts.formations) && opts.formations.length > 0 ? opts.formations : null;
  const validFormation = (f) => typeof f === 'string' && FORMATION.test(f) && (known === null || known.includes(f));
  const src = isPlainObject(raw) ? raw : {};

  const name =
    cleanText(typeof src.name === 'string' ? src.name : '', LIMITS.teamName) ||
    cleanText(fb.name, LIMITS.teamName) ||
    DEFAULT_TEAM.name;

  let code = cleanTeamCode(typeof src.code === 'string' ? src.code : '');
  if (code.length < LIMITS.teamCode) code = `${code}${codeFromName(name)}`.slice(0, LIMITS.teamCode);

  const list = Array.isArray(src.roster) ? src.roster : [];
  const roster = [];
  for (let i = 0; i < LIMITS.rosterSize; i++) {
    const item = list[i];
    const entry = isPlainObject(item) ? item : typeof item === 'string' ? { name: item } : {};
    const fbEntry = isPlainObject(fb.roster?.[i]) ? fb.roster[i] : DEFAULT_TEAM.roster[i];
    roster.push({
      name:
        cleanText(typeof entry.name === 'string' ? entry.name : '', LIMITS.rosterName) ||
        cleanText(fbEntry.name, LIMITS.rosterName) ||
        DEFAULT_TEAM.roster[i].name,
      number: toShirtNumber(entry.number, toShirtNumber(fbEntry.number, DEFAULT_NUMBERS[i])),
    });
  }

  const fbCrest = crests.includes(fb.crest) ? fb.crest : crests[0];
  return {
    presetId: typeof src.presetId === 'string' && src.presetId !== '' && src.presetId.length <= 64 ? src.presetId : null,
    name,
    code,
    primary: normColor(src.primary, normColor(fb.primary, DEFAULT_TEAM.primary)),
    secondary: normColor(src.secondary, normColor(fb.secondary, DEFAULT_TEAM.secondary)),
    keeper: normColor(src.keeper, normColor(fb.keeper, DEFAULT_TEAM.keeper)),
    crest: typeof src.crest === 'string' && crests.includes(src.crest) ? src.crest : fbCrest,
    formation: validFormation(src.formation) ? src.formation : validFormation(fb.formation) ? fb.formation : '',
    roster,
  };
}

/** Field-by-field comparison of two team configs (presetId is never compared). */
export function teamsEqual(a, b, opts = {}) {
  return isPlainObject(a) && isPlainObject(b) && diffTeam(a, b, opts).length === 0;
}

/**
 * Names of the parts in which two team configs differ, in the order the editor shows them.
 * @returns {string[]}
 */
export function diffTeam(a, b, opts = {}) {
  const out = [];
  if ((a.name ?? '') !== (b.name ?? '')) out.push('name');
  if ((a.code ?? '') !== (b.code ?? '')) out.push('code');
  if (!sameColor(a.primary, b.primary)) out.push('shirt colour');
  if (!sameColor(a.secondary, b.secondary)) out.push('trim colour');
  if (!sameColor(a.keeper, b.keeper)) out.push('keeper colour');
  if ((a.crest ?? '') !== (b.crest ?? '')) out.push('crest');
  if (!opts.ignoreFormation && (a.formation ?? '') !== (b.formation ?? '')) out.push('formation');
  for (let i = 0; i < LIMITS.rosterSize; i++) {
    const x = a.roster?.[i];
    const y = b.roster?.[i];
    if ((x?.name ?? '') !== (y?.name ?? '') || (x?.number ?? 0) !== (y?.number ?? 0)) {
      out.push('roster');
      break;
    }
  }
  return out;
}

/** The catalogue preset with this id, or null. */
export function presetById(presets, id) {
  if (!id || !Array.isArray(presets)) return null;
  return presets.find((p) => p?.presetId === id) ?? null;
}

/**
 * The catalogue preset this config still IS (nothing but the formation was changed), or null for
 * an edited or custom team. The formation is left out because it is a tactical choice, and
 * because the config's own formation is only a preference the team size may override.
 */
export function matchPreset(config, presets) {
  if (!isPlainObject(config) || !Array.isArray(presets)) return null;
  const same = (p) => isPlainObject(p) && teamsEqual(config, p, { ignoreFormation: true });
  return presets.find((p) => p?.presetId === config.presetId && same(p)) ?? presets.find(same) ?? null;
}

const TEAM_KEYS = ['name', 'code', 'primary', 'secondary', 'keeper', 'crest', 'formation', 'roster'];

function unwrapTeam(data) {
  let candidate = data;
  if (Array.isArray(candidate)) candidate = candidate[0];
  // Our own export wraps the team; "my teams" entries are { id, team }.
  if (isPlainObject(candidate) && isPlainObject(candidate.team)) candidate = candidate.team;
  if (!isPlainObject(candidate)) return null;
  if (typeof candidate.name !== 'string' || cleanText(candidate.name, LIMITS.teamName) === '') return null;
  const known = TEAM_KEYS.filter((k) => candidate[k] !== undefined && candidate[k] !== null).length;
  return known >= 2 ? candidate : null;
}

/**
 * Parses an exported team (file contents or pasted text).
 * @param {string} text
 * @param {{fallback?: object, crests?: string[], formations?: string[]}} [opts]  see sanitizeTeam
 * @returns {{ok: true, team: object, notes: string[]} | {ok: false, error: string}}
 *          `notes` lists what had to be adjusted to make the team valid.
 */
export function parseTeamImport(text, opts = {}) {
  const src = String(text ?? '').trim();
  if (src === '') return { ok: false, error: 'There is nothing to import: the text is empty.' };
  if (src.length > MAX_IMPORT_CHARS) return { ok: false, error: 'That is too big to be a team file.' };

  let data;
  try {
    data = JSON.parse(src);
  } catch {
    return { ok: false, error: 'That is not valid JSON. Team files are the .json files made by Export.' };
  }

  const raw = unwrapTeam(data);
  if (!raw) {
    return { ok: false, error: 'That JSON is not a team: it needs at least a "name" plus colours or a roster.' };
  }

  const team = sanitizeTeam({ ...raw, presetId: null }, opts);
  const notes = [];
  if (cleanText(raw.name, MAX_IMPORT_CHARS).length > LIMITS.teamName) {
    notes.push(`name shortened to ${LIMITS.teamName} characters`);
  }
  if (typeof raw.code !== 'string' || raw.code.trim().toUpperCase() !== team.code) notes.push(`code set to ${team.code}`);
  const badColours = ['primary', 'secondary', 'keeper'].filter(
    (k) => raw[k] !== undefined && normColor(raw[k], null) === null,
  ).length;
  if (badColours > 0) notes.push(`${badColours} invalid colour${badColours === 1 ? '' : 's'} replaced`);
  if (raw.crest !== undefined && raw.crest !== team.crest) notes.push('unknown crest replaced');
  // An empty formation just means "no preference"; only one that was given and refused is news.
  const noFormation = raw.formation === undefined || raw.formation === null || raw.formation === '';
  if (!noFormation && raw.formation !== team.formation) notes.push('unknown formation ignored');
  const given = Array.isArray(raw.roster) ? raw.roster.length : 0;
  if (given < LIMITS.rosterSize) notes.push(`roster filled up to ${LIMITS.rosterSize} players`);
  else if (given > LIMITS.rosterSize) notes.push(`roster cut to ${LIMITS.rosterSize} players`);
  return { ok: true, team, notes };
}

/** The text of an exported team file. */
export function exportTeam(team) {
  const t = sanitizeTeam(team);
  return JSON.stringify(
    {
      app: 'office-kickoff',
      kind: 'team',
      version: 1,
      team: {
        name: t.name,
        code: t.code,
        primary: t.primary,
        secondary: t.secondary,
        keeper: t.keeper,
        crest: t.crest,
        formation: t.formation,
        roster: t.roster.map((r) => ({ number: r.number, name: r.name })),
      },
    },
    null,
    2,
  );
}

export function exportFileName(team) {
  const slug = String(team?.name ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `office-kickoff-${slug || 'team'}.json`;
}

/** Formations valid for a team size; the first entry is the default. */
export function formationsFor(teamSize, formations) {
  const list = formations?.[String(teamSize)];
  if (Array.isArray(list) && list.length > 0) return list;
  return FALLBACK_FORMATIONS[teamSize] ?? FALLBACK_FORMATIONS[5];
}

/** `name` if it is valid for the team size, otherwise the default (Formations.Resolve). */
export function resolveFormation(name, teamSize, formations) {
  const list = formationsFor(teamSize, formations);
  return list.includes(name) ? name : list[0];
}

/** Every formation name the game knows, over all team sizes. */
export function allFormationNames(formations) {
  const names = new Set();
  for (let size = LIMITS.minTeamSize; size <= LIMITS.maxTeamSize; size++) {
    for (const name of formationsFor(size, formations)) names.add(name);
  }
  return [...names];
}

/**
 * A team config ready for SetTeamConfig: sanitised, and with a preferred formation the server
 * will keep as it is - one from the catalogue, a missing or unknown one becoming the default for
 * the current team size - so that what comes back can be compared with what was sent.
 * @param {*} config
 * @param {{crests?: string[], formations?: object, teamSize: number}} opts  `formations` is catalog.formations
 */
export function teamForSend(config, opts) {
  const team = sanitizeTeam(config, { crests: opts.crests, formations: allFormationNames(opts.formations) });
  if (team.formation === '') team.formation = resolveFormation('', opts.teamSize, opts.formations);
  return team;
}

/**
 * What became of a SetTeamConfig, judged from the room state that followed it.
 * @param {object} sent       the config that was sent
 * @param {?object} before    the side's config before the send
 * @param {?object} accepted  the side's config now
 * @param {(a: string, b: string) => boolean} [sameFormation]  when two preferred formations count
 *        as the same; the lobby passes "they give the same line-up at the current team size",
 *        because the server is free to store the preference either as sent or resolved
 * @returns {{status: 'accepted'|'adjusted'|'refused', changed: string[]}}
 *          `changed` names the parts in which the server's version differs from what was sent.
 */
export function applyOutcome(sent, before, accepted, sameFormation = (a, b) => a === b) {
  if (!isPlainObject(accepted)) return { status: 'refused', changed: [] };
  const changed = diffTeam(sent, accepted, { ignoreFormation: true });
  if (!sameFormation(sent.formation ?? '', accepted.formation ?? '')) {
    // Same order as diffTeam: the formation comes before the roster.
    const roster = changed.indexOf('roster');
    changed.splice(roster < 0 ? changed.length : roster, 0, 'formation');
  }
  if (changed.length === 0) return { status: 'accepted', changed };
  // Nothing moved although something should have: the server ignored the call.
  if (isPlainObject(before) && teamsEqual(accepted, before) && !teamsEqual(sent, before)) {
    return { status: 'refused', changed };
  }
  return { status: 'adjusted', changed };
}

/**
 * Follows SetTeamConfig calls until the room state shows what became of them. The hub method
 * returns nothing, and RoomStates that were already on their way still show the old team, so a
 * send only counts as refused once `timeoutMs` have passed without the team moving.
 * @param {number} [timeoutMs]
 */
export function createApplyTracker(timeoutMs = 3000) {
  const pending = [null, null];
  return {
    timeoutMs,
    /**
     * A config was sent for a side.
     * @param {*} [tag]  anything the caller wants back when the send settles
     * @returns {*} the tag of an unanswered send this one replaces, or undefined
     */
    begin(team, sent, before, now, tag) {
      const replaced = pending[team]?.tag;
      pending[team] = { sent, before, at: now, tag };
      return replaced;
    },
    isPending(team) {
      return Boolean(pending[team]);
    },
    /**
     * Call on every RoomState, and again once the timeout of a waiting send has passed.
     * @param {?Array} teams  RoomStateDto.teams as it is now
     * @returns {Array<{team: number, status: 'accepted'|'adjusted'|'refused', changed: string[],
     *           accepted: ?object, sent: object, tag: *}>} the sends that are now settled
     */
    settle(teams, now, sameFormation) {
      const done = [];
      for (let team = 0; team < pending.length; team++) {
        const p = pending[team];
        if (!p) continue;
        const accepted = teams?.[team]?.config;
        const outcome = applyOutcome(p.sent, p.before, accepted, sameFormation);
        if (outcome.status === 'refused' && now - p.at < timeoutMs) continue;
        pending[team] = null;
        done.push({ team, ...outcome, accepted: isPlainObject(accepted) ? accepted : null, sent: p.sent, tag: p.tag });
      }
      return done;
    },
    /** Milliseconds until the oldest waiting send times out, or -1 when nothing is waiting. */
    untilTimeout(now) {
      const waiting = pending.filter(Boolean);
      if (waiting.length === 0) return -1;
      return Math.max(0, Math.min(...waiting.map((p) => p.at + timeoutMs - now)));
    },
  };
}

/** Port of Formations.Spots: outfield spots, defence to attack, each row from -1 to +1 across the pitch. */
export function formationSpots(name) {
  const rows = String(name ?? '').split('-').map((n) => Number.parseInt(n, 10));
  if (rows.some((n) => !Number.isInteger(n) || n < 0 || n > 6)) return [];
  const spots = [];
  rows.forEach((n, r) => {
    const depth = rows.length === 1 ? 0.55 : 0.26 + (0.84 - 0.26) * (r / (rows.length - 1));
    const spread = Math.min(0.88, 0.42 + 0.14 * n);
    for (let i = 0; i < n; i++) {
      const lateral = n === 1 ? 0 : ((i + 0.5) / n - 0.5) * 2 * spread;
      spots.push({ row: r, rowCount: rows.length, depth, lateral });
    }
  });
  return spots;
}

/** Where the keeper stands on the schematic half pitch (the real line offset would hide in the goal). */
const KEEPER_U = 0.065;

/** Depth of the sweeper who takes slot 0 without goalkeepers (Formations.SweeperDepth). */
const SWEEPER_DEPTH = 0.13;

/** Percent of the mini pitch kept clear at each end, so shirts and name tags stay inside it. */
const PITCH_PAD_X = 7;
const PITCH_SPAN_X = 100 - 2 * PITCH_PAD_X;

/** Percent of the mini pitch's height that one unit of `v` covers. */
const PITCH_SPAN_Y = 44;

/**
 * Where a lineup entry sits on the mini pitch, in percent of its box. The home side defends the
 * left end; `flip` gives the away side (the same layout rotated 180 degrees, as on the real pitch).
 * @param {{u:number, v:number}} entry  see lineup
 * @param {boolean} flip
 * @returns {{left:number, top:number}}
 */
export function pitchPoint(entry, flip) {
  const u = flip ? 1 - entry.u : entry.u;
  const v = flip ? -entry.v : entry.v;
  return { left: PITCH_PAD_X + u * PITCH_SPAN_X, top: 50 + v * PITCH_SPAN_Y };
}

/**
 * Kickoff positions on a half pitch, per slot, following Formations.HomePositions: slot 0 is the
 * keeper, or with `keepers` false an ordinary footballer playing as a deep central sweeper.
 * u runs from the team's own goal line (0) to the halfway line (1), v from -1 to +1 across.
 * These are for the home side; the away side is the same layout rotated 180 degrees.
 * @param {string} formation
 * @param {number} teamSize
 * @param {boolean} [keepers]  MatchSettingsDto.keepers
 * @returns {Array<{slot:number, keeper:boolean, u:number, v:number}>}
 */
export function lineup(formation, teamSize, keepers = true) {
  const spots = formationSpots(formation);
  const out = [keepers ? { slot: 0, keeper: true, u: KEEPER_U, v: 0 } : { slot: 0, keeper: false, u: SWEEPER_DEPTH * 0.94, v: 0 }];
  for (let i = 0; i < spots.length && i + 1 < teamSize; i++) {
    out.push({ slot: i + 1, keeper: false, u: spots[i].depth * 0.94, v: spots[i].lateral });
  }
  return out;
}

/** Perceived brightness of a colour, 0 (black) .. 255 (white). */
function brightness(hex) {
  const c = normColor(hex, '#000000');
  const r = Number.parseInt(c.slice(1, 3), 16);
  const g = Number.parseInt(c.slice(3, 5), 16);
  const b = Number.parseInt(c.slice(5, 7), 16);
  return (r * 299 + g * 587 + b * 114) / 1000;
}

/** "#ffffff" or "#111111", whichever reads better on the colour (same idea as KitDto.text). */
export function textOn(hex) {
  return brightness(hex) >= 150 ? '#111111' : '#ffffff';
}

/**
 * A colour to write a name in on the dark panels: the colour itself when it is bright enough to
 * read there, otherwise '' (use the normal text colour).
 */
export function inkOnDark(hex) {
  const c = normColor(hex, '');
  return c !== '' && brightness(c) >= 90 ? c : '';
}

/**
 * The colours a team takes the pitch in, safe to put into styles: the kit the server resolved
 * (TeamDto.kit, after clash handling), falling back to the team's own colours.
 * @param {?object} teamDto  TeamDto
 * @returns {{primary: string, secondary: string, keeper: string, text: string, swapped: boolean}}
 */
export function kitOf(teamDto) {
  const config = isPlainObject(teamDto?.config) ? teamDto.config : {};
  const kit = isPlainObject(teamDto?.kit) ? teamDto.kit : {};
  const primary = safeColor(kit.primary, safeColor(config.primary, DEFAULT_TEAM.primary));
  return {
    primary,
    secondary: safeColor(kit.secondary, safeColor(config.secondary, DEFAULT_TEAM.secondary)),
    keeper: safeColor(kit.keeper, safeColor(config.keeper, DEFAULT_TEAM.keeper)),
    text: safeColor(kit.text, textOn(primary)),
    swapped: kit.swapped === true,
  };
}

/** The kit of a team that only exists in the editor: its own colours, nothing resolved. */
export function kitOfConfig(config) {
  return kitOf({ config, kit: null });
}

/** Distance between two colours in RGB space (0 = identical, ~441 = black against white). */
export function colorDistance(a, b) {
  const x = normColor(a, '#000000');
  const y = normColor(b, '#000000');
  let sum = 0;
  for (let i = 1; i < 7; i += 2) {
    const d = Number.parseInt(x.slice(i, i + 2), 16) - Number.parseInt(y.slice(i, i + 2), 16);
    sum += d * d;
  }
  return Math.sqrt(sum);
}

/** A label that fits under a dot on the mini pitch: the last word of the name, cut if still too long. */
export function shortName(name, max = 11) {
  const full = String(name ?? '').trim();
  const words = full.split(' ').filter(Boolean);
  const last = words.length > 1 && words[words.length - 1].length >= 2 ? words[words.length - 1] : full;
  const chars = Array.from(last);
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : last;
}

/** Shirt numbers worn by more than one footballer among the first `count` roster entries. */
export function duplicateNumbers(roster, count = LIMITS.rosterSize) {
  const seen = new Map();
  for (const entry of (roster ?? []).slice(0, count)) {
    seen.set(entry.number, (seen.get(entry.number) ?? 0) + 1);
  }
  return [...seen.entries()].filter(([, n]) => n > 1).map(([number]) => number);
}

/** Two colours closer than this (RGB distance) are hard to tell apart at a glance on the pitch. */
const CLASH_DISTANCE = 96;

/**
 * Friendly warnings about a team as it stands in the editor. They only predict: the server
 * resolves kit clashes itself (KitDto), and the lobby shows what it decided.
 * @param {object} team  sanitised TeamConfigDto
 * @param {{otherName?: string, otherPrimary?: string, teamSize?: number}} [ctx]
 *        the other side as it will take the pitch, and how many footballers play
 * @returns {string[]}
 */
export function teamWarnings(team, ctx = {}) {
  const out = [];
  if (colorDistance(team.primary, PITCH_GREEN) < CLASH_DISTANCE) {
    out.push('The shirt is close to the green of the pitch, so the players will be hard to see.');
  } else if (isHexColor(ctx.otherPrimary) && colorDistance(team.primary, ctx.otherPrimary) < CLASH_DISTANCE) {
    out.push(`The shirt is close to ${ctx.otherName || 'the other team'}'s. When two kits clash, one side plays in its trim colour.`);
  }
  if (colorDistance(team.primary, team.secondary) < CLASH_DISTANCE / 2) {
    out.push('Shirt and trim are almost the same colour, so the trim will not show.');
  }
  if (colorDistance(team.keeper, team.primary) < CLASH_DISTANCE) {
    out.push('The keeper is hard to tell from the outfield shirts, so the keeper may be given another colour.');
  }
  const playing = Number.isInteger(ctx.teamSize) ? ctx.teamSize : LIMITS.rosterSize;
  const dupes = duplicateNumbers(team.roster, playing).sort((a, b) => a - b);
  if (dupes.length === 1) out.push(`Number ${dupes[0]} is worn twice.`);
  else if (dupes.length > 1) out.push(`Numbers ${dupes.slice(0, -1).join(', ')} and ${dupes[dupes.length - 1]} are worn twice.`);
  return out;
}

/** "Shield" for the crest id "shield": the name read out for a crest in the picker. */
export function crestLabel(id) {
  const words = cleanText(String(id ?? '').replace(/[-_]+/g, ' '), 24);
  return words ? words[0].toUpperCase() + words.slice(1) : 'Crest';
}

/**
 * "My teams" as read from storage, made safe to use: entries that are not `{ id, team }` are
 * dropped (storage can hold anything), duplicated ids are kept once, every team is sanitised.
 * @param {*} list   getMyTeams()
 * @param {{crests?: string[]}} [opts]  see sanitizeTeam
 * @returns {Array<{id: string, team: object}>}
 */
export function cleanSavedTeams(list, opts = {}) {
  if (!Array.isArray(list)) return [];
  const out = [];
  const seen = new Set();
  for (const entry of list) {
    if (!isPlainObject(entry) || typeof entry.id !== 'string' || entry.id === '' || seen.has(entry.id)) continue;
    if (!isPlainObject(entry.team) || typeof entry.team.name !== 'string') continue;
    seen.add(entry.id);
    out.push({ id: entry.id, team: sanitizeTeam(entry.team, { crests: opts.crests }) });
  }
  return out;
}

/** Id of the saved team with this name (case-insensitive), or null. Saving under the same name replaces it. */
export function savedIdByName(saved, name) {
  const wanted = String(name ?? '').trim().toLowerCase();
  if (wanted === '') return null;
  return saved.find((entry) => entry.team.name.trim().toLowerCase() === wanted)?.id ?? null;
}

/**
 * The side on which to offer "Use my last team", or -1. The offer is only made to a seated player
 * whose side still shows an untouched catalogue preset (a team somebody already customised is
 * left alone), and never for a team that either side is already using.
 * @param {object} room      RoomStateDto
 * @param {number} myTeam    0 | 1 | -1
 * @param {object[]} presets catalog.teamPresets
 * @param {?object} lastTeam the remembered TeamConfigDto
 */
export function lastTeamOfferFor(room, myTeam, presets, lastTeam) {
  if (myTeam !== 0 && myTeam !== 1) return -1;
  if (!isPlainObject(lastTeam) || typeof lastTeam.name !== 'string') return -1;
  const mine = room?.teams?.[myTeam]?.config;
  if (!matchPreset(mine, presets)) return -1;
  const last = sanitizeTeam(lastTeam);
  const inUse = (config) => isPlainObject(config) && teamsEqual(last, config, { ignoreFormation: true });
  if (inUse(mine) || inUse(room?.teams?.[1 - myTeam]?.config)) return -1;
  return myTeam;
}

/**
 * Id of the catalogue preset a team is based on: the preset it still equals, else the one its
 * presetId names, else `previous` (what the same side was based on before it was edited).
 */
export function basePresetId(config, presets, previous = null) {
  const untouched = matchPreset(config, presets);
  if (untouched) return untouched.presetId ?? previous;
  return presetById(presets, config?.presetId)?.presetId ?? previous;
}
