// The results screen: the final score with both crests, the verdict, the goal timeline, the
// table of the humans with the MVP crowned, the team comparison, and the ways on from here.
//
// It is filled each time a result is shown - never per frame - from the plain data that
// resultsModel() in format.js produces. Which buttons it offers depends on who the host is,
// and that can change while the screen is up: hud.js calls setRoom() on every room state.

import { el, add, clear, confirming, icon, later, menuButton, restart, setButtonLabel, setCrest } from './dom.js';

/** After a press, Rematch and Back to lobby rest this long: the server needs a moment to act. */
const BUSY_MS = 4000;

/** Rows that come in one after the other; later ones arrive together with this one. */
const STAGGER_MAX = 10;

/** Columns of the player table: field of the model, heading, what the heading stands for. */
const COLUMNS = [
  ['goals', 'G', 'Goals'],
  ['assists', 'A', 'Assists'],
  ['shots', 'SH', 'Shots'],
  ['onTarget', 'ON', 'Shots on target'],
  ['saves', 'SV', 'Saves'],
  ['tackles', 'TK', 'Tackles won'],
  ['steals', 'ST', 'Steals'],
  ['passes', 'PASS', 'Passes completed / attempted'],
  ['rating', 'RTG', 'Rating'],
];

function stagger(node, index) {
  node.style.setProperty('--i', String(Math.min(index, STAGGER_MAX)));
}

function section(className, title, ...children) {
  return add(el('section', `res-sec ${className}`), el('h3', 'sec-title display', title), ...children);
}

function buildSide(index) {
  const side = el('div', 'res-side');
  side.setAttribute('data-team', String(index));
  const crest = el('span', 'res-crest');
  const name = el('span', 'res-team display');
  add(side, crest, name);
  return { side, crest, name };
}

function goalRow(goal, index) {
  const row = el('li', goal.ownGoal ? 'res-goal is-own' : 'res-goal');
  row.setAttribute('data-team', String(goal.team));
  stagger(row, index);
  const who = el('span', 'res-goal-who');
  who.appendChild(el('b', 'res-goal-scorer', goal.scorer));
  if (goal.ownGoal) who.appendChild(el('span', 'tag tag-og display', 'Own goal'));
  else if (goal.assist) who.appendChild(el('span', 'res-goal-assist', `assist ${goal.assist}`));
  return add(row, who, el('span', 'res-goal-min display tnum', goal.minute));
}

function playerRow(human, index) {
  const row = el('tr', 'res-row');
  row.setAttribute('data-team', String(human.team));
  stagger(row, index);
  if (human.mvp) row.classList.add('is-mvp');
  if (human.me) row.classList.add('is-me');

  const name = el('td', 'res-name');
  const who = el('span', 'res-who');
  const dot = el('i', 'res-dot');
  // format.js only lets "#rrggbb" through, so the value is safe as a style.
  dot.style.background = human.color;
  add(who, dot, el('span', 'res-nick', human.name));
  if (human.mvp) who.appendChild(add(el('span', 'res-mvp display'), icon('crown'), el('span', '', 'MVP')));
  if (human.me) who.appendChild(el('span', 'tag tag-you display', 'You'));
  if (human.ownGoals > 0) {
    who.appendChild(el('span', 'tag tag-og display', human.ownGoals > 1 ? `${human.ownGoals} own goals` : 'Own goal'));
  }
  name.appendChild(who);
  row.appendChild(name);

  for (const [field] of COLUMNS) {
    const value = human[field];
    const cell = el('td', `res-cell res-${field} tnum`, value);
    if (value === 0 || value === '0/0') cell.classList.add('is-zero');
    row.appendChild(cell);
  }
  return row;
}

function barValue(text, team, leads) {
  const node = el('span', leads ? 'res-bar-val tnum is-lead' : 'res-bar-val tnum', text);
  node.setAttribute('data-team', String(team));
  return node;
}

function barRow(bar, index) {
  const row = el('li', bar.empty ? 'res-bar is-empty' : 'res-bar');
  stagger(row, index);
  row.style.setProperty('--share', String(Math.round(bar.share * 1000) / 1000));
  const lead = bar.empty || bar.share === 0.5 ? -1 : bar.share > 0.5 ? 0 : 1;
  const track = add(el('span', 'res-bar-track'), el('i', 'res-bar-home'), el('i', 'res-bar-away'));
  return add(
    row,
    barValue(bar.home, 0, lead === 0),
    add(el('span', 'res-bar-mid'), el('span', 'res-bar-label display', bar.label), track),
    barValue(bar.away, 1, lead === 1),
  );
}

/**
 * @param {object} actions  guarded HudActions
 * @param {{rematch: () => void, backToLobby: () => void, leave: () => void}} hooks
 */
export function createResults(actions, hooks) {
  const root = el('div', 'results');
  root.hidden = true;

  const panel = el('div', 'res-panel');
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', 'Match result');

  // ---- header: crest, name, score, name, crest ------------------------------------------
  const sides = [buildSide(0), buildSide(1)];
  const nums = [el('span', 'res-num', '0'), el('span', 'res-num', '0')];
  nums[0].setAttribute('data-team', '0');
  nums[1].setAttribute('data-team', '1');
  const score = add(el('div', 'res-score display tnum'), nums[0], el('span', 'res-dash', '–'), nums[1]);
  const kicker = el('div', 'res-kicker display', 'Full time');
  const head = add(
    el('header', 'res-head'),
    sides[0].side,
    add(el('div', 'res-mid'), kicker, score),
    sides[1].side,
  );

  const verdictText = el('span', 'res-verdict-text display');
  const verdictNote = el('span', 'res-verdict-note display');
  const verdict = add(el('div', 'res-verdict'), icon('trophy'), verdictText);
  const verdictRow = add(el('div', 'res-verdict-row'), verdict, verdictNote);

  // ---- body -----------------------------------------------------------------------------
  const timeline = el('ol', 'res-timeline');
  const noGoals = el('p', 'res-empty', 'No goals. The keepers send their regards.');
  const goalsSec = section('res-goals', 'Goals', timeline, noGoals);

  const bars = el('ul', 'res-bars');
  const legend = [el('span', 'res-legend-code display'), el('span', 'res-legend-code display')];
  legend[0].setAttribute('data-team', '0');
  legend[1].setAttribute('data-team', '1');
  const statsSec = section('res-stats', 'Match stats', add(el('div', 'res-legend'), legend[0], legend[1]), bars);

  const table = el('table', 'res-table');
  const headRow = el('tr');
  const nameHead = el('th', 'res-th-name', 'Player');
  nameHead.setAttribute('scope', 'col');
  headRow.appendChild(nameHead);
  for (const [, label, meaning] of COLUMNS) {
    const th = el('th', 'res-th', label);
    th.setAttribute('scope', 'col');
    th.title = meaning;
    th.setAttribute('aria-label', meaning);
    headRow.appendChild(th);
  }
  const tbody = el('tbody');
  add(table, add(el('thead'), headRow), tbody);
  const playersSec = section('res-players', 'Players', table);

  const body = add(el('div', 'res-body'), goalsSec, statsSec, playersSec);

  // ---- ways on --------------------------------------------------------------------------
  const waitText = el('span', 'res-wait-text');
  const wait = add(
    el('div', 'res-wait'),
    waitText,
    add(el('span', 'res-dots'), el('i'), el('i'), el('i')),
  );
  wait.setAttribute('role', 'status');

  /** Makes a button rest after a press, so a double click cannot ask the server twice. */
  function resting(className, label, busyLabel, iconName, fire) {
    let timer = 0;
    const node = menuButton(actions, className, label, iconName, () => {
      if (node.disabled) return;
      set(true);
      fire();
    });
    function set(busy) {
      clearTimeout(timer);
      node.disabled = busy;
      node.classList.toggle('is-busy', busy);
      setButtonLabel(node, busy ? busyLabel : label);
      if (busy) timer = later(() => set(false), BUSY_MS);
    }
    return { node, wake: () => set(false) };
  }

  const rematch = resting('btn btn-primary btn-big', 'Rematch', 'Starting', 'again', hooks.rematch);
  const lobby = resting('btn', 'Back to lobby', 'Heading back', 'lobby', hooks.backToLobby);
  const leave = confirming(actions, 'btn btn-danger', 'Leave', 'Leave - sure?', 'exit', hooks.leave);
  rematch.node.hidden = true;
  lobby.node.hidden = true;
  const foot = add(
    el('footer', 'res-foot'),
    wait,
    add(el('div', 'res-actions'), leave.node, lobby.node, rematch.node),
  );

  add(panel, head, verdictRow, body, foot);
  root.appendChild(panel);

  function settle() {
    rematch.wake();
    lobby.wake();
    leave.disarm();
  }

  return {
    el: root,
    get isOpen() {
      return !root.hidden;
    },

    /** @param {object} model  result of resultsModel() */
    show(model) {
      for (let i = 0; i < 2; i++) {
        const team = model.teams[i];
        setCrest(sides[i].crest, team, 96);
        sides[i].name.textContent = team.name;
        sides[i].side.classList.toggle('is-winner', model.winner === i);
        sides[i].side.classList.toggle('is-loser', model.winner >= 0 && model.winner !== i);
        nums[i].textContent = String(model.score[i]);
        nums[i].classList.toggle('is-winner', model.winner === i);
        legend[i].textContent = team.code;
      }
      verdict.setAttribute('data-team', String(model.winner));
      verdict.classList.toggle('is-draw', model.winner < 0);
      verdictText.textContent = model.headline;
      verdictNote.textContent = model.note;
      verdictNote.hidden = model.note === '';

      clear(timeline);
      for (let i = 0; i < model.goals.length; i++) timeline.appendChild(goalRow(model.goals[i], i));
      timeline.hidden = model.goals.length === 0;
      noGoals.hidden = model.goals.length > 0;

      clear(bars);
      for (let i = 0; i < model.bars.length; i++) bars.appendChild(barRow(model.bars[i], i));

      clear(tbody);
      for (let i = 0; i < model.humans.length; i++) tbody.appendChild(playerRow(model.humans[i], i));
      playersSec.hidden = model.humans.length === 0;

      settle();
      root.hidden = false;
      panel.scrollTop = 0;
      restart(panel, 'is-in');
    },

    hide() {
      settle();
      root.hidden = true;
    },

    /**
     * @param {boolean} isHost    the local member is the host right now
     * @param {string} hostName   "" when the room does not list the host
     */
    setRoom(isHost, hostName) {
      const host = !!isHost;
      if (rematch.node.hidden === host) {
        // The role has just moved: whatever was half-pressed belongs to the old arrangement.
        rematch.wake();
        lobby.wake();
        rematch.node.hidden = !host;
        lobby.node.hidden = !host;
      }
      wait.hidden = host;
      const text = hostName ? `Waiting for ${hostName}` : 'Waiting for the host';
      if (waitText.textContent !== text) waitText.textContent = text;
    },
  };
}
