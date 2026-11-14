// Turns a MatchInit message into the validated, pre-digested model the drawing code works from.
// Pure (the palette is a plain object), so it can be tested against malformed input: whatever
// arrives, every number in the model is finite and every colour is a "#rrggbb" string.

import { CELEBRATIONS } from '../../shared/protocol.js';
import { clamp, makeRng, num } from './mathx.js';
import { hexOr, inkOn, lighten, mix, vivid } from './color.js';
import { buildSeats, buildWallLoop, pitchMetrics, standGeometry, surname } from './geom.js';
import { celebrationIndex } from './poses.js';

const TEAM_FALLBACK = ['#3b82f6', '#f43f5e'];
const KEEPER_FALLBACK = ['#ffd166', '#5eead4'];
const HUMAN_FALLBACK = ['#ffd166', '#2ee6ff', '#ff6b9d', '#b6ff3c'];

/** Accent colours from css/theme.css. */
export const TOKENS = Object.freeze({
  lime: '#b6ff3c', cyan: '#2ee6ff', gold: '#ffd166', danger: '#ff4d6d', warn: '#ffb020',
  bg: '#070b16', text: '#eef3ff',
});

function text(v, max) {
  return typeof v === 'string' ? v.slice(0, max) : '';
}

/**
 * @param init  MatchInitDto (anything at all is tolerated)
 * @param pal   palette from color.createPalette(); the model registers the colours it needs
 */
export function buildModel(init, pal) {
  const src = init && typeof init === 'object' ? init : {};
  const tun = src.tuning && typeof src.tuning === 'object' ? src.tuning : {};
  const pm = pitchMetrics(src.pitch);

  const teams = [0, 1].map((t) => {
    const team = (Array.isArray(src.teams) && src.teams[t]) || {};
    const kit = team.kit || {};
    const cfg = team.config || {};
    const primary = hexOr(kit.primary, TEAM_FALLBACK[t]);
    const secondary = hexOr(kit.secondary, '#ffffff');
    const keeper = hexOr(kit.keeper, KEEPER_FALLBACK[t]);
    const bright = vivid(primary, 0.24);
    const trim = vivid(secondary, 0.24);
    return {
      primary, secondary, keeper,
      text: hexOr(kit.text, inkOn(primary)),
      keeperText: inkOn(keeper),
      crest: text(cfg.crest, 16) || 'shield',
      name: text(cfg.name, 24),
      code: text(cfg.code, 3),
      /** Bright enough to read as light on the dark pitch: particles, glows, rings. */
      bright,
      trimBright: trim,
      cPrimary: pal.id(bright),
      cSecondary: pal.id(trim),
      cLight: pal.id(lighten(bright, 0.55)),
      /** Confetti mix in this team's colours. */
      confetti: [pal.id(bright), pal.id(trim), pal.id(lighten(bright, 0.45)), pal.id('#ffffff')],
    };
  });

  const players = [];
  if (Array.isArray(src.players)) {
    for (let i = 0; i < src.players.length && i < 32; i++) {
      const p = src.players[i] || {};
      const name = text(p.name, 20);
      const team = p.team === 1 ? 1 : 0;
      const keeper = p.keeper === true;
      const kit = teams[team];
      const fill = keeper ? kit.keeper : kit.primary;
      players.push({
        index: i,
        team,
        keeper,
        name,
        surname: surname(name),
        number: clamp(Math.round(num(p.number, i + 1)), 0, 99),
        /** Shirt, outline and number colours, and the facing marker's. */
        fill,
        trim: kit.secondary,
        ink: keeper ? kit.keeperText : kit.text,
        marker: kit.trimBright,
        /** After-images. */
        cGhost: pal.id(lighten(fill, 0.3)),
      });
    }
  }

  // Indexed by human id (0..3); holes stay null.
  const humans = [null, null, null, null];
  if (Array.isArray(src.humans)) {
    for (const h of src.humans) {
      if (!h || !(h.humanId >= 0 && h.humanId < 4)) continue;
      const id = h.humanId | 0;
      const color = vivid(hexOr(h.color, HUMAN_FALLBACK[id]), 0.3);
      const celebration = celebrationIndex(h.celebration);
      humans[id] = {
        humanId: id,
        name: text(h.name, 16),
        team: h.team === 1 ? 1 : 0,
        color,
        light: lighten(color, 0.45),
        cColor: pal.id(color),
        cLight: pal.id(lighten(color, 0.5)),
        celebration: celebration >= 0 ? celebration : 0,
      };
    }
  }

  const grey = ['#aeb6c8', '#7f8aa3', '#d5dae6'];
  const matchId = num(src.matchId, 0);
  const stands = standGeometry(pm);
  const sprintSpeed = clamp(num(tun.player && tun.player.sprintSpeed, 395), 50, 5000);
  const slideTime = clamp(num(tun.tackle && tun.tackle.slideTime, 0.36), 0.05, 5);
  const diveTime = clamp(num(tun.keeper && tun.keeper.diveTime, 0.36), 0.05, 5);
  const recoverTime = clamp(num(tun.keeper && tun.keeper.diveRecover, 0.4), 0.05, 5);
  return {
    matchId,
    pm,
    stands,
    /** Every spectator's seat; the same crowd turns up whenever this match is rebuilt. */
    seats: buildSeats(pm, stands, makeRng((Math.round(matchId) * 7919 + 0x51ed) >>> 0)),
    wall: buildWallLoop(pm, 12),
    teams, players, humans,
    celebrations: !(src.settings && src.settings.celebrations === false),
    celebrationCount: CELEBRATIONS.length,

    playerR: clamp(num(tun.player && tun.player.radius, 20), 6, 80),
    ballR: clamp(num(tun.ball && tun.ball.radius, 11), 3, 50),
    sprintSpeed,
    shotMax: clamp(num(tun.kick && tun.kick.shotMaxSpeed, 1500), 100, 20000),
    fire: clamp(num(tun.kick && tun.kick.fireThreshold, 0.85), 0.05, 1),
    slideTime,
    cooldown: clamp(num(tun.tackle && tun.tackle.cooldown, 1.6), 0.05, 60),
    diveTime,
    recoverTime,
    /** What poses.statePose needs to know about the game's timing. */
    poseK: { sprintSpeed, slideTime, diveTime, recoverTime },
    slowMoScale: clamp(num(tun.rules && tun.rules.goalSlowMoScale, 0.3), 0.05, 1),
    introTime: clamp(num(tun.rules && tun.rules.introTime, 3.5), 0.1, 60),

    /** Palette ids of the fixed effect colours. */
    col: {
      white: pal.id('#ffffff'),
      dust: pal.id('#d9d3b6'),
      smoke: pal.id('#9aa3b5'),
      turfA: pal.id('#3aa864'),
      turfB: pal.id('#1f7442'),
      dirt: pal.id('#6d5b3a'),
      spark: pal.id('#fff1b8'),
      gold: pal.id(TOKENS.gold),
      lime: pal.id(TOKENS.lime),
      cyan: pal.id(TOKENS.cyan),
      ember: pal.id('#ff9a2e'),
      hot: pal.id('#ff5a1f'),
      sweat: pal.id('#a8e3ff'),
      pink: pal.id('#ff6b9d'),
      red: pal.id(TOKENS.danger),
      flashbulb: pal.id('#eaf2ff'),
      grey: grey.map((g) => pal.id(g)),
      /** Confetti for a drawn match: a bit of everything. */
      mixed: [pal.id(teams[0].bright), pal.id(teams[1].bright), pal.id('#ffffff'), pal.id(TOKENS.gold)],
      golden: [pal.id(TOKENS.gold), pal.id('#fff1b8'), pal.id('#ffffff'), pal.id(mix(TOKENS.gold, '#ff9a2e', 0.5))],
    },
  };
}

/**
 * Shirt colours of one footballer.
 * @returns {{fill: string, trim: string, ink: string}}
 */
export function kitOf(M, team, keeper) {
  const t = M.teams[team === 1 ? 1 : 0];
  return keeper
    ? { fill: t.keeper, trim: t.secondary, ink: t.keeperText }
    : { fill: t.primary, trim: t.secondary, ink: t.text };
}
