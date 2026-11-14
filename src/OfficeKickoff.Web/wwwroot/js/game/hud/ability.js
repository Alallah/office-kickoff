// Bottom-centre ability bar: stamina, shot charge, pass, the tackle / dash cooldown and the
// switch keys - each labelled with its key, so the bar doubles as a control reminder.
// Spectators get a one-line hint instead, and a player whose footballer the AI is minding gets a
// calm notice rather than stale numbers.

import { el, add, Shown, icon, keycap, mouseKey } from './dom.js';
import { AbilityTracker, abilityValues, fireMark } from './logic.js';

function meter(className) {
  const fill = el('i', 'ab-fill');
  const bar = add(el('div', `ab-meter ${className}`), fill);
  return { bar, fill: new Shown(fill) };
}

function note(className, iconName, title, detail) {
  const node = el('div', `ab-note ${className}`);
  node.hidden = true;
  add(node, icon(iconName), el('span', 'ab-note-title display', title), el('span', 'ab-note-detail', detail));
  return node;
}

export function createAbilityBar() {
  const root = el('div', 'ability-slot');

  const bar = el('div', 'ability');
  bar.hidden = true;

  // Sprint: stamina.
  const stamina = meter('ab-stamina-meter');
  const staminaCell = add(
    el('div', 'ab-cell ab-stamina'),
    add(el('div', 'ab-label'), keycap('Shift'), el('span', 'ab-name display', 'Sprint')),
    stamina.bar,
  );

  // Shoot: charge, with a mark where the shot catches fire.
  const charge = meter('ab-charge-meter');
  const mark = el('b', 'ab-mark');
  charge.bar.appendChild(mark);
  const shotCell = add(
    el('div', 'ab-cell ab-shot'),
    add(el('div', 'ab-label'), mouseKey('left'), el('span', 'ab-name display', 'Shoot'), el('span', 'ab-hint', 'hold')),
    charge.bar,
  );

  const passCell = add(el('div', 'ab-cell ab-pass'), mouseKey('right'), el('span', 'ab-name display', 'Pass'));

  // Tackle / dash: the dark wedge over the key shrinks as the cooldown runs out.
  const sweep = el('i', 'ab-sweep');
  const tackleName = el('span', 'ab-name display', 'Tackle');
  const tackleCell = add(
    el('div', 'ab-cell ab-tackle'),
    add(el('div', 'ab-dial'), keycap('Space'), sweep),
    tackleName,
  );

  const auto = el('span', 'ab-auto display', 'Auto');
  auto.title = 'Auto-switch to the defender nearest the ball';
  const switchCell = add(
    el('div', 'ab-cell ab-switch'),
    add(el('div', 'ab-pair'), keycap('Q'), el('span', 'ab-name display', 'Nearest')),
    add(el('div', 'ab-pair'), keycap('E'), el('span', 'ab-name display', 'Next')),
    auto,
  );

  add(bar, staminaCell, shotCell, passCell, tackleCell, switchCell);

  const aiNote = note('ab-ai', 'bot', 'AI has your player', 'click the pitch to take over');
  const specNote = note('ab-spec', 'eye', 'Spectating', 'WASD pan · wheel zoom · F follow ball');
  add(root, bar, aiNote, specNote);

  const shownStamina = new Shown(staminaCell);
  const shownShot = new Shown(shotCell);
  const shownPass = new Shown(passCell);
  const shownTackle = new Shown(tackleCell);
  const shownTackleName = new Shown(tackleName);
  const shownSweep = new Shown(sweep);
  const shownAuto = new Shown(auto);

  const tracker = new AbilityTracker();
  const values = {};
  let tuning = null;
  let mode = 'off';

  function show(next) {
    if (next === mode) return;
    mode = next;
    bar.hidden = next !== 'player';
    aiNote.hidden = next !== 'ai';
    specNote.hidden = next !== 'spectator';
  }

  function setMatch(init) {
    tuning = init?.tuning ?? null;
    mark.style.left = `${Math.round(fireMark(tuning) * 100)}%`;
    tracker.reset();
    show('off');
  }

  function update(view, now, resultsUp) {
    // A replay shows the past: its stamina and charge are not mine to act on, so the slot clears.
    const next = tracker.step(view.me, view.phase, now, resultsUp || !!view.replay);
    // 'wait': a player between footballers for a moment; leave the bar as it is.
    if (next !== 'wait') show(next);
    if (next !== 'player') return;

    const v = abilityValues(view.me.player, tuning, view.passTarget, values);
    stamina.fill.css('--v', v.stamina);
    shownStamina.flag('is-exhausted', v.exhausted);
    shownStamina.flag('is-sprinting', v.sprinting);
    charge.fill.css('--v', v.charge);
    shownShot.flag('is-charging', v.charging);
    shownShot.flag('is-fire', v.fire);
    shownPass.flag('is-ready', v.pass);
    shownSweep.css('--cd', v.cooldown);
    shownTackle.flag('is-ready', v.ready);
    shownTackle.flag('is-blocked', v.blocked);
    shownTackleName.text(v.dash ? 'Dash' : 'Tackle');
    shownAuto.flag('is-on', view.me.autoSwitch !== false);
  }

  return { el: root, setMatch, update };
}
