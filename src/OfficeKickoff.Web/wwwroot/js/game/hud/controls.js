// The controls, twice: a diagram as an overlay (H toggles it; it opens by itself at the start of
// a practice match) and a compact list for the pause menu.

import { el, add, icon, keycap, menuButton, mouseKey, svgNode } from './dom.js';

/** A row of the compact list: key caps, then what they do. */
const REFERENCE = [
  [['W', 'A', 'S', 'D'], 'Move'],
  [['mouse:move'], 'Aim'],
  [['mouse:left'], 'Hold to charge, release to shoot'],
  [['mouse:right'], 'Pass'],
  [['Shift'], 'Sprint'],
  [['Space'], 'Slide tackle · dash with the ball'],
  [['Q'], 'Switch to nearest the ball'],
  [['E'], 'Switch to next'],
  [['1', '8'], 'Emotes'],
  [['Enter'], 'Chat'],
  [['Tab'], 'Scores (hold)'],
  [['Esc'], 'Menu'],
  [['M'], 'Mute'],
  [['H'], 'Controls'],
];

function cap(label, className = '') {
  return label.startsWith('mouse:') ? mouseKey(label.slice(6)) : keycap(label, className);
}

/** The compact control reference used inside the pause menu. */
export function controlList() {
  const list = el('ul', 'ctl-list');
  for (const [keys, text] of REFERENCE) {
    const caps = el('span', 'ctl-caps');
    for (let i = 0; i < keys.length; i++) {
      // "1 - 8": a range, not two separate keys.
      if (i > 0 && keys[0] === '1') caps.appendChild(el('span', 'ctl-dash', '–'));
      caps.appendChild(cap(keys[i]));
    }
    list.appendChild(add(el('li', 'ctl-item'), caps, el('span', 'ctl-text', text)));
  }
  return list;
}

function line(keys, title, detail) {
  const caps = el('span', 'ctl-caps');
  for (const key of keys) caps.appendChild(cap(key, 'key-lg'));
  const words = add(el('span', 'ctl-words'), el('b', 'ctl-what display', title));
  if (detail) words.appendChild(el('span', 'ctl-detail', detail));
  return add(el('li', 'ctl-line'), caps, words);
}

function card(title, ...children) {
  return add(el('section', 'ctl-card'), el('h3', 'ctl-title display', title), ...children);
}

/** A mouse seen from above, its two buttons in the colours the legend next to it uses. */
function mouseDrawing() {
  return svgNode(
    'svg',
    { class: 'ctl-mouse', viewBox: '0 0 100 150', 'aria-hidden': 'true', focusable: 'false' },
    svgNode('path', { class: 'ctl-mouse-left', d: 'M50 6C26 6 10 22 10 46v18h40z' }),
    svgNode('path', { class: 'ctl-mouse-right', d: 'M50 6c24 0 40 16 40 40v18H50z' }),
    svgNode('path', {
      class: 'ctl-mouse-body',
      d: 'M50 6c24 0 40 16 40 40v50c0 28-18 48-40 48S10 124 10 96V46C10 22 26 6 50 6z M10 64h80 M50 6v58',
    }),
    svgNode('rect', { class: 'ctl-mouse-wheel', x: 44, y: 22, width: 12, height: 24, rx: 6 }),
  );
}

/**
 * One entry of the legend beside a drawing.
 * @param {'lime'|'cyan'|'aim'} swatch  the colour the drawing uses for it; 'aim' is a crosshair
 */
function legend(swatch, title, detail) {
  const mark = swatch === 'aim' ? icon('aim', 'ctl-swatch is-aim') : el('i', `ctl-swatch is-${swatch}`);
  return add(
    el('li', 'ctl-legend-item'),
    mark,
    add(el('span', 'ctl-words'), el('b', 'ctl-what display', title), el('span', 'ctl-detail', detail)),
  );
}

/**
 * @param {object} actions       guarded HudActions
 * @param {() => void} dismiss   asks the HUD to close the overlay (it owns the open / close state)
 */
export function createControls(actions, dismiss) {
  const root = el('div', 'modal controls');
  root.hidden = true;

  const panel = el('div', 'panel controls-panel');
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-modal', 'true');
  panel.setAttribute('aria-label', 'Controls');

  const note = el('span', 'panel-note');
  const closer = menuButton(actions, 'icon-btn', 'Close', 'close', dismiss);
  const head = add(el('header', 'panel-head'), el('h2', 'panel-title display', 'Controls'), note, closer);

  // Both cards read the same way: a drawing, its legend in the drawing's colours (lime for the
  // main thing, cyan for the second), then the single keys.
  // The keys are laid out as they sit under the left hand, so the picture matches the keyboard.
  const cluster = add(
    el('div', 'ctl-cluster'),
    keycap('Q', 'key-lg is-cyan'), keycap('W', 'key-lg is-lime'), keycap('E', 'key-lg is-cyan'),
    keycap('A', 'key-lg is-lime'), keycap('S', 'key-lg is-lime'), keycap('D', 'key-lg is-lime'),
  );
  cluster.setAttribute('aria-hidden', 'true');
  const keysCard = card(
    'Keyboard',
    add(
      el('div', 'ctl-figure'),
      cluster,
      add(
        el('ul', 'ctl-legend'),
        legend('lime', 'W A S D', 'Move'),
        legend('cyan', 'Q', 'Switch to the team-mate nearest the ball'),
        legend('cyan', 'E', 'Switch to the next team-mate'),
      ),
    ),
    add(
      el('ul', 'ctl-lines'),
      line(['Shift'], 'Sprint', 'Hold - drains stamina'),
      line(['Space'], 'Slide tackle', 'Without the ball'),
      line(['Space'], 'Dash', 'With the ball - costs stamina'),
    ),
  );

  const mouseCard = card(
    'Mouse',
    add(
      el('div', 'ctl-figure'),
      mouseDrawing(),
      add(
        el('ul', 'ctl-legend'),
        legend('lime', 'Left button', 'Hold to charge, release to shoot'),
        legend('cyan', 'Right button', 'Pass to the team-mate you aim at'),
        legend('aim', 'Move', 'Aim - your footballer faces the cursor'),
      ),
    ),
    add(
      el('ul', 'ctl-tips'),
      el('li', 'ctl-tip', 'Charge past the mark on the meter and the shot catches fire.'),
      el('li', 'ctl-tip', 'Pass to an AI team-mate and you take over that footballer.'),
    ),
  );

  const digits = el('span', 'ctl-caps');
  add(digits, keycap('1'), el('span', 'ctl-dash', '–'), keycap('8'));
  const strip = el('ul', 'ctl-strip');
  const stripItems = [
    [digits, 'Emotes'],
    [keycap('Enter'), 'Chat'],
    [keycap('Tab'), 'Scores'],
    [keycap('Esc'), 'Menu'],
    [keycap('M'), 'Mute'],
    [keycap('H'), 'This card'],
  ];
  for (const [keys, text] of stripItems) {
    strip.appendChild(add(el('li', 'ctl-strip-item'), keys, el('span', 'ctl-strip-text display', text)));
  }

  const watching = add(
    el('div', 'ctl-watching'),
    icon('eye'),
    el('span', '', 'Spectating: WASD pan · wheel zoom · F follow ball'),
  );
  watching.hidden = true;

  const ok = menuButton(actions, 'btn btn-primary', 'Got it', 'check', dismiss);
  const foot = add(
    el('footer', 'panel-foot'),
    watching,
    add(el('span', 'ctl-close-hint'), keycap('H'), el('span', '', 'or'), keycap('Esc'), el('span', '', 'to close')),
    ok,
  );

  add(panel, head, add(el('div', 'ctl-grid'), keysCard, mouseCard), strip, foot);
  root.appendChild(panel);

  // A click on the dimmed pitch around the card closes it too.
  root.addEventListener('click', (e) => {
    if (e.target === root) dismiss();
  });

  return {
    el: root,
    get isOpen() {
      return !root.hidden;
    },
    /** @param {{practice?: boolean, spectator?: boolean}} [o] */
    open(o = {}) {
      note.textContent = o.practice ? 'Practice - nothing is at stake, try everything' : 'The match keeps running';
      watching.hidden = !o.spectator;
      root.hidden = false;
    },
    close() {
      root.hidden = true;
    },
  };
}
