// Pure match-settings logic: validation (mirror of MatchSettings.Normalized), preset detection,
// labels, and the small state machine that keeps the host's panel steady while edits and
// RoomState echoes cross on the wire. No DOM: unit-testable headless.

import { LIMITS } from '../shared/protocol.js';

/** Defaults of MatchSettingsDto. */
export const SETTINGS_DEFAULTS = Object.freeze({
  preset: 'coffee',
  teamSize: 5,
  minutes: 3,
  scoreLimit: 0,
  goldenGoal: true,
  aiTeammates: 1,
  aiKeeper: 1,
  ballSpeed: 1,
  gameSpeed: 1,
  replays: true,
  celebrations: true,
});

/** Every rule field, i.e. everything except the preset id. */
export const RULE_FIELDS = Object.freeze([
  'teamSize', 'minutes', 'scoreLimit', 'goldenGoal', 'aiTeammates', 'aiKeeper',
  'ballSpeed', 'gameSpeed', 'replays', 'celebrations',
]);

export const AI_LEVELS = Object.freeze(['Easy', 'Normal', 'Hard']);

/** Step of the two speed sliders. */
export const SPEED_STEP = 0.05;

const SPEED_EPSILON = 0.004;

function intIn(value, lo, hi, fallback) {
  return Number.isInteger(value) && value >= lo && value <= hi ? value : fallback;
}

function speedIn(value, fallback) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  if (value < LIMITS.minSpeed - SPEED_EPSILON || value > LIMITS.maxSpeed + SPEED_EPSILON) return fallback;
  // The server stores a float; two decimals are all the sliders ever produce.
  return Math.min(LIMITS.maxSpeed, Math.max(LIMITS.minSpeed, Math.round(value * 100) / 100));
}

/** A complete settings object; any missing or invalid field becomes its default. */
export function normalizeSettings(raw) {
  const s = raw !== null && typeof raw === 'object' ? raw : {};
  const d = SETTINGS_DEFAULTS;
  return {
    preset: typeof s.preset === 'string' && s.preset !== '' ? s.preset : 'custom',
    teamSize: intIn(s.teamSize, LIMITS.minTeamSize, LIMITS.maxTeamSize, d.teamSize),
    minutes: intIn(s.minutes, LIMITS.minMinutes, LIMITS.maxMinutes, d.minutes),
    scoreLimit: intIn(s.scoreLimit, 0, LIMITS.maxScoreLimit, d.scoreLimit),
    goldenGoal: typeof s.goldenGoal === 'boolean' ? s.goldenGoal : d.goldenGoal,
    aiTeammates: intIn(s.aiTeammates, 0, 2, d.aiTeammates),
    aiKeeper: intIn(s.aiKeeper, 0, 2, d.aiKeeper),
    ballSpeed: speedIn(s.ballSpeed, d.ballSpeed),
    gameSpeed: speedIn(s.gameSpeed, d.gameSpeed),
    replays: typeof s.replays === 'boolean' ? s.replays : d.replays,
    celebrations: typeof s.celebrations === 'boolean' ? s.celebrations : d.celebrations,
  };
}

/** True when two NORMALISED settings objects describe the same rules (the preset id is not compared). */
export function sameRules(a, b) {
  return RULE_FIELDS.every((f) =>
    f === 'ballSpeed' || f === 'gameSpeed' ? Math.abs(a[f] - b[f]) < SPEED_EPSILON : a[f] === b[f],
  );
}

/**
 * Id of the preset whose rules these settings match, or "custom".
 * @param {object} settings  normalised settings
 * @param {Array<{id:string, settings:object}>} presets  catalog.settingsPresets
 * @param {string} [prefer]  wins when several presets match
 */
export function detectPreset(settings, presets, prefer) {
  const matches = (Array.isArray(presets) ? presets : []).filter(
    (p) => p && typeof p.id === 'string' && sameRules(normalizeSettings(p.settings), settings),
  );
  if (matches.length === 0) return 'custom';
  return (matches.find((p) => p.id === prefer) ?? matches[0]).id;
}

/** Settings with one field changed and the preset id brought in line ("custom" once it differs). */
export function withField(settings, field, value, presets) {
  const next = normalizeSettings({ ...settings, [field]: value });
  next.preset = detectPreset(next, presets, settings.preset);
  return next;
}

/** The settings of a catalogue preset, or null when the id is unknown. */
export function settingsOfPreset(presets, id) {
  const preset = (Array.isArray(presets) ? presets : []).find((p) => p?.id === id);
  if (!preset) return null;
  return { ...normalizeSettings(preset.settings), preset: preset.id };
}

export function formatSpeed(value) {
  return `${Number(value).toFixed(2)}×`;
}

export function formatMinutes(value) {
  return `${value} min`;
}

export function formatScoreLimit(value) {
  return value > 0 ? `First to ${value}` : 'Off';
}

/** "5-a-side, 3 min" - the one-line version of the rules. */
export function summarizeSettings(settings) {
  const parts = [`${settings.teamSize}-a-side`, formatMinutes(settings.minutes)];
  if (settings.scoreLimit > 0) parts.push(formatScoreLimit(settings.scoreLimit).toLowerCase());
  return parts.join(', ');
}

/**
 * Keeps the settings panel steady for the host.
 *
 * The host's controls show `local`. An edit changes `local` at once and is sent a moment later;
 * meanwhile RoomStates keep arriving (other people's pings, the echo of an earlier send) carrying
 * OLDER settings, which must not yank a slider back under the host's finger. So a RoomState is
 * only adopted when there is no unsent edit and either nothing is on its way or the state matches
 * what was sent. If the echo never matches (the server refused or adjusted the change) the
 * server's version wins after `echoTimeoutMs`.
 *
 * Everyone else simply mirrors the server.
 * @param {Array<{id:string, settings:object}>} presets
 * @param {number} [echoTimeoutMs]
 */
export function createSettingsSync(presets, echoTimeoutMs = 1500) {
  let server = normalizeSettings(SETTINGS_DEFAULTS);
  let local = server;
  let host = false;
  let dirty = false;
  let sentAt = -1;

  const same = (a, b) => a.preset === b.preset && sameRules(a, b);

  function adopt() {
    const changed = !same(local, server);
    local = server;
    return changed;
  }

  return {
    /** What the panel shows. */
    get local() {
      return local;
    },
    /** True while an edit has not been sent yet. */
    get dirty() {
      return dirty;
    },
    /** True while a sent edit has not been confirmed by a matching RoomState. */
    get waiting() {
      return sentAt >= 0;
    },
    /** How long to wait for the echo of a send before calling `reconcile`. */
    echoTimeoutMs,

    /**
     * A RoomState arrived.
     * @returns {boolean} true when `local` changed and the panel must be redrawn
     */
    onServer(settings, isHost, now) {
      server = normalizeSettings(settings);
      const wasHost = host;
      host = isHost;
      if (!host || !wasHost) {
        dirty = false;
        sentAt = -1;
        return adopt();
      }
      if (dirty) return false;
      if (sentAt >= 0) {
        if (!same(server, local) && now - sentAt < echoTimeoutMs) return false;
        sentAt = -1;
      }
      return adopt();
    },

    /** The host changed one control. @returns {boolean} false when not allowed */
    edit(field, value) {
      if (!host) return false;
      local = withField(local, field, value, presets);
      dirty = true;
      return true;
    },

    /** The host clicked a preset chip. */
    choosePreset(id) {
      if (!host) return false;
      const next = settingsOfPreset(presets, id);
      if (!next) return false;
      local = next;
      dirty = true;
      return true;
    },

    /** The settings to send now (marks them sent), or null when there is nothing new. */
    takeOutgoing(now) {
      if (!host || !dirty) return null;
      dirty = false;
      sentAt = now;
      return { ...local };
    },

    /**
     * Gives up on an echo that never came and falls back to the server's settings.
     * @returns {boolean} true when `local` changed
     */
    reconcile(now) {
      if (dirty || sentAt < 0 || now - sentAt < echoTimeoutMs) return false;
      sentAt = -1;
      return adopt();
    },
  };
}
