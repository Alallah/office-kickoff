// Top-centre scoreboard: crests, three-letter codes, kit bars, the score, the clock, and a
// marker under the side that is on the ball (which, during a kickoff countdown, is the side
// about to kick off).

import { PHASE } from '../../shared/protocol.js';
import { el, add, Shown, restart, setCrest } from './dom.js';
import { clockSeconds, clockText, count, num, possessionTeam, scoreboardCaption } from './format.js';

/** The clock turns red for the last seconds of regulation. */
const URGENT_SECONDS = 10;

function buildSide(index) {
  const team = el('div', 'sb-team');
  team.setAttribute('data-team', String(index));
  const crest = el('span', 'sb-crest');
  const code = el('span', 'sb-code display');
  const kit = el('span', 'sb-kit');
  // Mirrored: crest on the outside, kit bar next to the score.
  if (index === 0) add(team, crest, code, kit);
  else add(team, kit, code, crest);

  const score = el('div', 'sb-score');
  score.setAttribute('data-team', String(index));
  const digit = el('span', 'sb-digit display tnum', '0');
  score.appendChild(digit);

  return { team, crest, code, score, digit, shown: new Shown(team), value: -1 };
}

export function createScoreboard() {
  const root = el('div', 'sb');
  root.setAttribute('role', 'group');
  root.setAttribute('aria-label', 'Scoreboard');

  const sides = [buildSide(0), buildSide(1)];
  const clock = el('div', 'sb-clock');
  const mark = el('span', 'sb-mark', '∞');
  mark.setAttribute('aria-hidden', 'true');
  const time = el('span', 'sb-time display tnum', '00:00');
  add(clock, mark, time);

  const row = add(el('div', 'sb-row'), sides[0].team, sides[0].score, clock, sides[1].score, sides[1].team);
  const caption = el('div', 'sb-caption display');
  caption.hidden = true;
  add(root, row, caption);

  const shownRoot = new Shown(root);
  const shownClock = new Shown(clock);
  const shownTime = new Shown(time);
  let practice = false;
  let possession = -1;
  // The clock text is rebuilt once a second, not once a frame.
  let clockWhole = -1;
  let clockString = '00:00';

  function setMatch(teams, init) {
    practice = !!init?.practice;
    possession = -1;
    clockWhole = -1;
    for (let i = 0; i < 2; i++) {
      const side = sides[i];
      const team = teams[i];
      setCrest(side.crest, team, 48);
      side.code.textContent = team.code;
      side.team.title = team.name;
      // -1: the first score of a match is simply shown, only later changes flip.
      side.value = -1;
      side.digit.textContent = '0';
      side.digit.classList.remove('is-flip');
      side.score.classList.remove('is-hit');
      side.shown.flag('has-ball', false);
    }
    const text = scoreboardCaption(init);
    caption.textContent = text;
    caption.hidden = text === '';
    shownClock.flag('is-practice', practice);
  }

  function update(view) {
    const phase = view.phase;
    for (let i = 0; i < 2; i++) {
      const side = sides[i];
      const value = count(view.score?.[i]);
      if (value === side.value) continue;
      // Only a goal is celebrated: one more than before. Anything else (the first score seen
      // after a reload, a new match) is just shown.
      const scored = side.value >= 0 && value === side.value + 1;
      side.value = value;
      side.digit.textContent = String(value);
      if (scored) {
        restart(side.digit, 'is-flip');
        restart(side.score, 'is-hit');
      }
    }

    const over = phase === PHASE.FULL_TIME || phase === PHASE.ENDED;
    const golden = !practice && !over && view.overtime === true;
    const final = !practice && over;
    const ticking = !golden && !final;
    if (final) {
      shownTime.text('FT');
    } else if (golden) {
      shownTime.text('GOLDEN GOAL');
    } else {
      const whole = clockSeconds(view.clock, practice);
      if (whole !== clockWhole) {
        clockWhole = whole;
        clockString = clockText(whole);
      }
      shownTime.text(clockString);
    }
    shownClock.flag('is-gold', golden);
    shownClock.flag('is-final', final);
    const running = phase === PHASE.PLAYING;
    shownClock.flag('is-urgent', ticking && !practice && running && num(view.clock, 99) <= URGENT_SECONDS);
    shownClock.flag('is-paused', ticking && !running);

    // A replay shows the past: the ball it carries says nothing about who is on it now.
    if (!view.replay) possession = over ? -1 : possessionTeam(view.ball, view.players, possession);
    sides[0].shown.flag('has-ball', possession === 0);
    sides[1].shown.flag('has-ball', possession === 1);
    // During the countdown the marker means "kicks off", and says so by pulsing.
    shownRoot.flag('is-kickoff', phase === PHASE.KICKOFF && possession >= 0);
  }

  return { el: root, setMatch, update };
}
