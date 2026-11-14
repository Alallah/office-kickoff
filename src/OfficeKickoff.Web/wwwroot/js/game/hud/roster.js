// The panel shown while Tab is held: who is playing for whom, their pings, who is away from the
// controls or offline, who is watching, and the rules of this match.
//
// It is built once; render() swaps the rows in only when the roster model actually changed, so
// holding Tab costs nothing per frame.

import { el, add, clear, Shown, icon, keycap, setCrest } from './dom.js';
import { count, matchCaption, pingLevel, pingText, presenceLabel } from './format.js';

function personRow(person) {
  const row = el('li', person.me ? 'ro-person is-me' : 'ro-person');
  row.setAttribute('data-presence', person.presence);
  const dot = el('i', 'ro-dot');
  // format.js only lets "#rrggbb" through, so the value is safe as a style.
  dot.style.background = person.color;
  add(row, dot, el('span', 'ro-name', person.name));
  if (person.me) row.appendChild(el('span', 'tag tag-you display', 'You'));
  if (person.host) row.appendChild(el('span', 'tag tag-host display', 'Host'));
  const label = presenceLabel(person.presence);
  if (label) row.appendChild(el('span', 'tag tag-away display', label));
  const reachable = person.presence === 'here' || person.presence === 'away';
  const ping = el('span', 'ro-ping tnum', reachable ? pingText(person.ping) : '');
  ping.setAttribute('data-level', reachable ? pingLevel(person.ping) : 'unknown');
  row.appendChild(ping);
  return row;
}

function buildSide(index) {
  const head = el('div', 'ro-team');
  head.setAttribute('data-team', String(index));
  const crest = el('span', 'ro-crest');
  const name = el('span', 'ro-team-name display');
  if (index === 0) add(head, crest, name);
  else add(head, name, crest);
  const list = el('ul', 'ro-list');
  list.setAttribute('data-team', String(index));
  return { head, crest, name, list };
}

export function createRoster() {
  const root = el('div', 'roster');
  root.hidden = true;
  root.setAttribute('role', 'region');
  root.setAttribute('aria-label', 'Players in this match');

  const sides = [buildSide(0), buildSide(1)];
  const nums = [el('span', 'ro-num', '0'), el('span', 'ro-num', '0')];
  const score = add(el('div', 'ro-score display tnum'), nums[0], el('span', 'ro-dash', '–'), nums[1]);
  const shownNums = [new Shown(nums[0]), new Shown(nums[1])];

  const watching = el('div', 'ro-watch');
  watching.hidden = true;
  const watchers = el('ul', 'ro-watchers');
  add(watching, icon('eye'), el('span', 'ro-watch-label display', 'Watching'), watchers);

  const caption = el('span', 'ro-caption display');
  const code = el('span', 'ro-code display');
  const shownCode = new Shown(code);

  add(
    root,
    add(el('div', 'ro-head'), sides[0].head, score, sides[1].head),
    add(el('div', 'ro-body'), sides[0].list, sides[1].list),
    watching,
    add(el('div', 'ro-foot'), caption, code, add(el('span', 'ro-hint'), keycap('Tab'), el('span', '', 'hold'))),
  );

  let signature = '';

  function setMatch(teams, init) {
    for (let i = 0; i < 2; i++) {
      setCrest(sides[i].crest, teams[i], 40);
      sides[i].name.textContent = teams[i].name;
    }
    caption.textContent = matchCaption(init);
    signature = '';
  }

  /** @param {string} roomCode  "" hides it */
  function setRoom(roomCode) {
    shownCode.text(roomCode ? `Room ${roomCode}` : '');
  }

  /** @param {{teams: object[][], spectators: object[]}} model  result of rosterModel() */
  function render(model) {
    const next = JSON.stringify(model);
    if (next === signature) return;
    signature = next;

    for (let i = 0; i < 2; i++) {
      const list = sides[i].list;
      clear(list);
      const people = model.teams[i] ?? [];
      for (const person of people) list.appendChild(personRow(person));
      if (people.length === 0) {
        list.appendChild(add(el('li', 'ro-person is-ai'), icon('bot'), el('span', 'ro-name', 'AI squad')));
      }
    }

    clear(watchers);
    for (const person of model.spectators) {
      const item = el('li', person.me ? 'ro-watcher is-me' : 'ro-watcher', person.name);
      if (person.presence === 'offline') item.classList.add('is-offline');
      watchers.appendChild(item);
    }
    watching.hidden = model.spectators.length === 0;
  }

  function setScore(value) {
    shownNums[0].text(String(count(value?.[0])));
    shownNums[1].text(String(count(value?.[1])));
  }

  return {
    el: root,
    setMatch,
    setRoom,
    render,
    setScore,
    get isOpen() {
      return !root.hidden;
    },
    show() {
      root.hidden = false;
    },
    hide() {
      root.hidden = true;
    },
  };
}
