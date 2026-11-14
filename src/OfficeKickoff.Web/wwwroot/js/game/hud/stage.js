// Centre stage: everything announced in big letters. The versus card of the intro, the kickoff
// countdown, the goal banner, the golden goal and full time announcements, and the replay tag.
// None of it takes the mouse, and all of it is gone again before play needs the pitch.

import { PHASE } from '../../shared/protocol.js';
import { el, add, clear, Shown, restart, setCrest, icon } from './dom.js';
import {
  LONG_WORD, clamp01, count, describeGoal, fullTimeVerdict, goalBannerTiming, longestWord, matchCaption, num, partyLabel,
  splashHumans,
} from './format.js';
import { Countdown, SHOW_GO, Timeline } from './logic.js';

// Leaving times in seconds (the .is-out animations in match.css run for exactly this long).
const SPLASH_OUT = 0.5;
const GOLD_OUT = 0.4;
const FULL_TIME_OUT = 0.3;
/** A banner that has to make way at once (replay starting, phase moved on). */
const CUT_OUT = 0.2;

/** An intro with less than this left when we first see it is not worth a card. */
const SPLASH_MIN = 1.2;
const GOLD_HOLD = 2.3;

/**
 * Couples a Timeline with the element it shows: `is-in` while up, `is-out` while leaving, hidden
 * when idle. The leaving animation in match.css takes its length from the --out property set
 * here, so the script and the stylesheet cannot drift apart.
 */
function createBanner(node) {
  const line = new Timeline();
  let state = 'idle';
  let leaving = -1;

  function setLeaving(seconds) {
    const next = Math.max(0, seconds);
    if (next === leaving) return;
    leaving = next;
    node.style.setProperty('--out', `${next}s`);
  }

  function apply(next) {
    if (next === state) return;
    state = next;
    if (next === 'out') {
      node.classList.remove('is-in');
      node.classList.add('is-out');
    } else if (next === 'idle') {
      node.hidden = true;
      node.classList.remove('is-in');
      node.classList.remove('is-out');
    }
  }

  return {
    show(now, hold, out) {
      line.start(now, hold, out);
      state = 'in';
      setLeaving(out);
      node.hidden = false;
      node.classList.remove('is-out');
      restart(node, 'is-in');
    },
    cut(now, out) {
      // A banner that is already leaving keeps its pace (and its animation).
      if (state === 'in') setLeaving(out);
      line.cut(now, out);
      apply(line.state);
    },
    stop() {
      line.stop();
      apply('idle');
    },
    step(now) {
      apply(line.step(now));
      return state;
    },
    get state() {
      return state;
    },
  };
}

/** "HOM 2 - 1 AWY" in big digits, used by the goal banner and the full time announcement. */
function createScoreLine(className) {
  const root = el('div', `${className} score-line display tnum`);
  const codes = [el('span', 'score-code'), el('span', 'score-code')];
  const nums = [el('span', 'score-num', '0'), el('span', 'score-num', '0')];
  codes[0].setAttribute('data-team', '0');
  codes[1].setAttribute('data-team', '1');
  add(root, codes[0], nums[0], el('span', 'score-dash', '–'), nums[1], codes[1]);
  const shown = [new Shown(nums[0]), new Shown(nums[1])];
  return {
    el: root,
    setTeams(teams) {
      codes[0].textContent = teams[0].code;
      codes[1].textContent = teams[1].code;
    },
    set(score) {
      shown[0].text(String(count(score?.[0])));
      shown[1].text(String(count(score?.[1])));
    },
    /** Marks the number that has just gone up (-1 = neither). */
    mark(team) {
      shown[0].flag('is-up', team === 0);
      shown[1].flag('is-up', team === 1);
    },
  };
}

function buildSplashSide(index) {
  const side = el('div', 'splash-side');
  side.setAttribute('data-team', String(index));
  const crest = el('div', 'splash-crest');
  const name = el('div', 'splash-name display');
  const humans = el('ul', 'splash-humans');
  add(side, crest, add(el('div', 'splash-text'), name, humans));
  return { side, crest, name, humans };
}

export function createStage(actions) {
  const root = el('div', 'stage');

  // ---- intro: versus card ----------------------------------------------------------
  const splashEl = el('div', 'splash');
  splashEl.hidden = true;
  const splashSides = [buildSplashSide(0), buildSplashSide(1)];
  const splashCaption = el('div', 'splash-caption display');
  add(
    splashEl,
    add(el('div', 'splash-card'), splashSides[0].side, el('div', 'splash-vs display', 'VS'), splashSides[1].side),
    splashCaption,
  );
  const splash = createBanner(splashEl);

  // ---- kickoff countdown -----------------------------------------------------------
  const countEl = el('div', 'count');
  countEl.hidden = true;
  const countNum = el('span', 'count-num display tnum');
  countEl.appendChild(countNum);
  const countdown = new Countdown();
  let countShown = 0;

  // ---- goal banner -----------------------------------------------------------------
  const goalEl = el('div', 'goal');
  goalEl.hidden = true;
  const goalFlag = el('div', 'goal-flag display');
  const goalFlagText = el('span');
  add(goalFlag, icon('crown'), goalFlagText);
  const goalWord = el('div', 'goal-word display', 'GOAL!');
  const goalScorer = el('div', 'goal-scorer display');
  const goalAssist = el('div', 'goal-assist');
  const goalAssistName = el('span', 'goal-assist-name');
  add(goalAssist, el('span', 'goal-assist-label display', 'Assist'), goalAssistName);
  const goalScore = createScoreLine('goal-score');
  // Assist and score share one line: the banner stays clear of the middle of the pitch.
  add(
    goalEl,
    goalFlag,
    add(el('div', 'goal-band'), goalWord),
    goalScorer,
    add(el('div', 'goal-meta'), goalAssist, goalScore.el),
  );
  const goalBanner = createBanner(goalEl);

  // ---- golden goal announcement ----------------------------------------------------
  const goldEl = el('div', 'announce is-gold');
  goldEl.hidden = true;
  add(goldEl, el('div', 'announce-title display', 'Golden goal'), el('div', 'announce-sub display', 'Next goal wins'));
  const gold = createBanner(goldEl);

  // ---- full time -------------------------------------------------------------------
  const fullEl = el('div', 'fulltime');
  fullEl.hidden = true;
  const fullScore = createScoreLine('fulltime-score');
  const fullVerdict = el('div', 'fulltime-verdict display');
  const fullNote = el('div', 'fulltime-note display', 'after golden goal');
  add(fullEl, el('div', 'fulltime-title display', 'Full time'), fullScore.el, fullVerdict, fullNote);
  const full = createBanner(fullEl);
  const shownVerdict = new Shown(fullVerdict);
  const shownFullNote = new Shown(fullNote);

  // ---- replay tag (lives under the scoreboard, not in the centre) ---------------------
  const replayEl = el('div', 'replay');
  replayEl.hidden = true;
  const replayFill = el('i');
  add(replayEl, el('span', 'replay-dot'), el('span', 'replay-word display', 'Replay'), add(el('span', 'replay-bar'), replayFill));
  const shownReplay = new Shown(replayEl);
  const shownReplayFill = new Shown(replayFill);

  add(root, splashEl, goldEl, goalEl, fullEl, countEl);

  let init = null;
  let teams = null;
  let reduced = false;
  let splashOffered = false;

  function setMatch(nextTeams, nextInit, memberId, reducedMotion) {
    init = nextInit ?? null;
    teams = nextTeams;
    reduced = !!reducedMotion;
    reset();
    splashOffered = false;

    for (let i = 0; i < 2; i++) {
      const side = splashSides[i];
      const team = teams[i];
      setCrest(side.crest, team, 160);
      side.name.textContent = team.name;
      side.name.classList.toggle('is-long', longestWord(team.name) > LONG_WORD);
      clear(side.humans);
      const humans = splashHumans(init, i, memberId);
      for (const human of humans) {
        const item = el('li', human.me ? 'splash-human is-me' : 'splash-human');
        const dot = el('i', 'splash-dot');
        dot.style.background = human.color;
        add(item, dot, el('span', 'splash-human-name', human.name));
        if (human.me) item.appendChild(el('span', 'tag tag-you display', 'You'));
        side.humans.appendChild(item);
      }
      if (humans.length === 0) {
        side.humans.appendChild(add(el('li', 'splash-human is-ai'), icon('bot'), el('span', 'splash-human-name', 'AI squad')));
      }
    }
    splashCaption.textContent = matchCaption(init);
    goalScore.setTeams(teams);
    fullScore.setTeams(teams);
  }

  /** Clears the stage at once: a new match, or the results screen taking over. */
  function reset() {
    splash.stop();
    goalBanner.stop();
    gold.stop();
    full.stop();
    countdown.reset();
    showCount(0);
    shownReplay.hidden(true);
  }

  function showCount(value) {
    if (value === countShown) return;
    countShown = value;
    if (value === 0) {
      countEl.hidden = true;
      return;
    }
    countEl.hidden = false;
    countNum.textContent = value === SHOW_GO ? 'GO!' : String(value);
    countEl.classList.toggle('is-go', value === SHOW_GO);
    restart(countNum, 'is-tick');
  }

  /** @param {object} evt  an EVT.GOAL event */
  function goal(evt, view, now) {
    if (!teams) return;
    const g = describeGoal(evt, init);
    goalEl.setAttribute('data-team', String(g.team));
    goalEl.classList.toggle('is-own', g.ownGoal);
    goalEl.classList.toggle('is-decider', g.decides);
    goalWord.textContent = g.ownGoal ? 'OWN GOAL' : 'GOAL!';
    goalFlagText.textContent = view?.overtime ? 'Golden goal' : 'Match winner';
    const scorer = partyLabel(g.scorer);
    goalScorer.textContent = scorer;
    goalScorer.hidden = scorer === '';
    const assist = partyLabel(g.assist);
    goalAssistName.textContent = assist;
    goalAssist.hidden = assist === '';
    goalScore.set(view?.score);
    goalScore.mark(g.team);

    // The golden goal banner may still be up when the winner goes in early in overtime.
    gold.cut(now, CUT_OUT);
    const timing = goalBannerTiming(view?.phase, view?.phaseTime, init, reduced);
    goalBanner.show(now, timing.hold, timing.out);
  }

  function overtime(now) {
    gold.show(now, GOLD_HOLD, GOLD_OUT);
  }

  function update(view, now, resultsUp) {
    const phase = view.phase;

    // Versus card: once per match, and only when enough of the intro is left to read it.
    if (phase === PHASE.INTRO && !resultsUp) {
      const left = num(view.phaseTime, 0);
      if (!splashOffered && teams && left > 0) {
        splashOffered = true;
        if (left >= SPLASH_MIN) splash.show(now, left - SPLASH_OUT - 0.1, SPLASH_OUT);
      }
    } else {
      splash.cut(now, CUT_OUT);
    }
    splash.step(now);

    // Countdown: this is the only place its sounds are triggered.
    const cue = resultsUp ? 0 : countdown.step(phase, view.phaseTime, now);
    showCount(resultsUp ? 0 : countdown.shown);
    if (cue > 0) actions.uiSound('countdown', cue);
    else if (cue === SHOW_GO) actions.uiSound('go');

    // Goal banner: must be off the screen before the replay tag or the next countdown.
    if (goalBanner.state !== 'idle') {
      // The score can lag the event by a frame; keep the banner on the live value.
      goalScore.set(view.score);
      if (view.replay || (phase !== PHASE.GOAL && phase !== PHASE.PLAYING)) goalBanner.cut(now, CUT_OUT);
      goalBanner.step(now);
    }

    if (gold.state !== 'idle') {
      if (phase === PHASE.FULL_TIME || phase === PHASE.ENDED) gold.cut(now, CUT_OUT);
      gold.step(now);
    }

    if (phase === PHASE.FULL_TIME && !resultsUp && teams) {
      if (full.state !== 'in') full.show(now, Infinity, FULL_TIME_OUT);
      fullScore.set(view.score);
      const verdict = fullTimeVerdict(view.score, teams);
      shownVerdict.text(verdict.text);
      shownVerdict.attr('data-team', String(verdict.winner));
      shownFullNote.hidden(!(view.overtime === true && verdict.winner >= 0));
    } else {
      full.cut(now, FULL_TIME_OUT);
    }
    full.step(now);

    const replay = view.replay ?? null;
    shownReplay.hidden(!replay || resultsUp);
    if (replay) shownReplayFill.css('--p', Math.round(clamp01(replay.progress) * 250) / 250);
  }

  return { el: root, replayEl, setMatch, reset, update, goal, overtime };
}
