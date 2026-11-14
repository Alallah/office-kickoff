// DOM helpers for the match HUD.
//
// The HUD is built once and then patched. `Shown` remembers what a node displays, so the 60 Hz
// update touches the document only when a value really changes.
//
// Text from the network always goes in through textContent. The single innerHTML write is
// setCrest: crestSvg validates its inputs and its result is documented as safe to assign.

import { crestSvg } from '../../shared/crests.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

export function el(tag, className = '', text = null) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== null && text !== undefined) node.textContent = String(text);
  return node;
}

/** Appends the children that exist (null / false entries are skipped) and returns the parent. */
export function add(parent, ...children) {
  for (const child of children) {
    if (child) parent.appendChild(child);
  }
  return parent;
}

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

export function later(fn, ms) {
  return setTimeout(fn, ms);
}

/** Wall clock in the unit of FrameView.now, for the calls that arrive without a frame (chat, results). */
export function nowSeconds() {
  return performance.now() / 1000;
}

/** A node plus a memory of what it shows: every setter is a no-op unless the value changed. */
export class Shown {
  constructor(node) {
    this.node = node;
    this.textValue = null;
    this.flags = {};
    this.vars = {};
    this.attrs = {};
    this.isHidden = node.hidden === true;
  }

  text(value) {
    if (value === this.textValue) return;
    this.textValue = value;
    this.node.textContent = value;
  }

  flag(name, on) {
    const next = !!on;
    if (this.flags[name] === next) return;
    this.flags[name] = next;
    this.node.classList.toggle(name, next);
  }

  hidden(hidden) {
    const next = !!hidden;
    if (this.isHidden === next) return;
    this.isHidden = next;
    this.node.hidden = next;
  }

  /** Sets a CSS custom property. */
  css(name, value) {
    if (this.vars[name] === value) return;
    this.vars[name] = value;
    this.node.style.setProperty(name, String(value));
  }

  attr(name, value) {
    if (this.attrs[name] === value) return;
    this.attrs[name] = value;
    this.node.setAttribute(name, String(value));
  }
}

/** Plays a CSS animation again from its first frame by re-adding the class that carries it. */
export function restart(node, className) {
  node.classList.remove(className);
  // Reading a layout property flushes the removal; without it the browser sees no change at all.
  void node.offsetWidth;
  node.classList.add(className);
}

/**
 * A button that never keeps keyboard focus after a mouse click. A focused button would be
 * re-activated by Space - the tackle key - and by Enter, which opens the chat.
 * @param {string} className
 * @param {(e: Event) => void} onPress
 */
export function button(className, onPress) {
  const node = el('button', className);
  node.type = 'button';
  node.addEventListener('mousedown', (e) => e.preventDefault());
  node.addEventListener('click', (e) => {
    // detail is 0 for a click made with the keyboard: there focus is how the user got here, keep it.
    if (e.detail !== 0) node.blur();
    onPress(e);
  });
  return node;
}

/**
 * A menu button: icon, label, a click sound and a hover sound. Only for menus and the results
 * screen - during play the cursor is the aim point and crosses the HUD all the time.
 * @param {{uiSound: (name: string) => void}} actions
 * @param {string} iconName  key of the icon set, or '' for none
 */
export function menuButton(actions, className, label, iconName, onPress) {
  const node = button(className, (e) => {
    actions.uiSound('click');
    onPress(e);
  });
  if (iconName) node.appendChild(icon(iconName));
  node.appendChild(el('span', 'btn-label', label));
  node.addEventListener('pointerenter', () => {
    if (!node.disabled) actions.uiSound('hover');
  });
  return node;
}

/** Changes the text of a button made with menuButton. */
export function setButtonLabel(node, text) {
  const label = node.querySelector('.btn-label');
  if (label && label.textContent !== text) label.textContent = text;
}

/** How long a "sure?" button stays armed. */
const ARM_MS = 3200;

/**
 * A menu button that asks first: one press arms it (the label turns into the question), a second
 * press while it is armed acts. It disarms by itself.
 * @returns {{node: HTMLButtonElement, disarm: () => void}}
 */
export function confirming(actions, className, label, question, iconName, fire) {
  let armed = false;
  let timer = 0;
  const node = menuButton(actions, className, label, iconName, () => {
    if (armed) {
      disarm();
      fire();
      return;
    }
    armed = true;
    node.classList.add('is-armed');
    setButtonLabel(node, question);
    timer = later(disarm, ARM_MS);
  });

  function disarm() {
    if (!armed) return;
    armed = false;
    clearTimeout(timer);
    node.classList.remove('is-armed');
    setButtonLabel(node, label);
  }

  return { node, disarm };
}

/** The controls inside `container` that can take keyboard focus right now, in document order. */
export function focusables(container) {
  const out = [];
  if (!container) return out;
  for (const node of container.querySelectorAll('button, input')) {
    // No client rects: the control or one of its ancestors is not displayed.
    if (node.disabled || node.getClientRects().length === 0) continue;
    out.push(node);
  }
  return out;
}

/** Takes keyboard focus off whatever control inside `root` has it. */
export function releaseFocus(root) {
  const active = document.activeElement;
  if (active && active !== document.body && root.contains(active) && typeof active.blur === 'function') active.blur();
}

export function keycap(label, className = '') {
  return el('kbd', className ? `key ${className}` : 'key', label);
}

/**
 * A key cap showing a mouse with one button lit.
 * @param {'left'|'right'|'move'} side  'move' lights no button (the mouse itself: aiming)
 */
export function mouseKey(side) {
  const lit = side === 'left' ? 'M10 2v10H2v-2a8 8 0 0 1 8-8z' : side === 'right' ? 'M10 2v10h8v-2a8 8 0 0 0-8-8z' : '';
  const drawing = svgNode(
    'svg',
    { class: 'mouse-glyph', viewBox: '0 0 20 28', 'aria-hidden': 'true', focusable: 'false' },
    lit ? svgNode('path', { class: 'mouse-lit', d: lit }) : null,
    svgNode('path', { class: 'mouse-line', d: 'M10 2a8 8 0 0 1 8 8v8a8 8 0 0 1-16 0v-8a8 8 0 0 1 8-8z M2 12h16 M10 2v10' }),
  );
  const cap = el('kbd', `key key-mouse key-mouse-${side}`);
  cap.appendChild(drawing);
  cap.setAttribute('aria-label', side === 'left' ? 'Left mouse button' : side === 'right' ? 'Right mouse button' : 'Mouse');
  return cap;
}

/** Draws a team's crest into `node`. `size` only sets the SVG's intrinsic size: CSS scales it. */
export function setCrest(node, team, size = 64) {
  node.innerHTML = crestSvg(team?.crest, team?.primary, team?.secondary, { size });
}

// Same drawing style as the lobby's icons (24 x 24, 2 px round strokes) so both pages look alike.
const ICONS = {
  copy: 'M9 9h10v11H9z M5 15V4h10',
  link: 'M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1.2 1.2 M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1.2-1.2',
  check: 'M5 12.5l4.5 4.5L19 7.5',
  close: 'M6 6l12 12 M18 6L6 18',
  exit: 'M10 4H5v16h5 M14 8l4 4-4 4 M18 12H9',
  bot: 'M6 9h12v9H6z M12 9V5 M9.5 13v1 M14.5 13v1 M3 13v3 M21 13v3',
  eye: 'M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
  warning: 'M12 4l9 16H3z M12 10v4 M12 17v.5',
  muted: 'M4 9.5h3.5L12 6v12l-4.5-3.5H4z M16 9.5l5 5 M21 9.5l-5 5',
  sound: 'M4 9.5h3.5L12 6v12l-4.5-3.5H4z M15.5 9.5a4 4 0 0 1 0 5 M18 7a7.5 7.5 0 0 1 0 10',
  again: 'M19 12a7 7 0 1 1-2.2-5.1 M19 4v4h-4',
  lobby: 'M4 11l8-7 8 7 M6.5 9.5V20h11V9.5 M10 20v-5h4v5',
  chat: 'M4 5h16v11H10l-4.5 3.5V16H4z',
  help: 'M9.2 9a3 3 0 1 1 4.6 2.5c-1 .7-1.8 1.3-1.8 2.7 M12 17.5v.5',
  trophy: 'M7 4h10v5a5 5 0 0 1-10 0z M7 6H4v1a3 3 0 0 0 3 3 M17 6h3v1a3 3 0 0 1-3 3 M12 14v4 M8 20h8',
  aim: 'M12 3v4 M12 17v4 M3 12h4 M17 12h4 M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
  play: 'M8 5l11 7-11 7z',
};

const FILLED = {
  crown: 'M3 8l4.5 4L12 5l4.5 7L21 8l-2 11H5z',
  ball: 'M12 5a7 7 0 1 0 0 14 7 7 0 0 0 0-14z',
};

/** A small decorative inline icon; the control around it carries the label. */
export function icon(name, className = '') {
  const filled = Object.prototype.hasOwnProperty.call(FILLED, name);
  const node = document.createElementNS(SVG_NS, 'svg');
  node.setAttribute('class', className ? `icon ${className}` : 'icon');
  node.setAttribute('viewBox', '0 0 24 24');
  node.setAttribute('fill', filled ? 'currentColor' : 'none');
  node.setAttribute('stroke', filled ? 'none' : 'currentColor');
  node.setAttribute('stroke-width', '2');
  node.setAttribute('stroke-linecap', 'round');
  node.setAttribute('stroke-linejoin', 'round');
  node.setAttribute('aria-hidden', 'true');
  node.setAttribute('focusable', 'false');
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', filled ? FILLED[name] : ICONS[name] ?? '');
  node.appendChild(path);
  return node;
}

/** An SVG element with the given attributes (for the hand-drawn pieces of the controls diagram). */
export function svgNode(tag, attrs = null, ...children) {
  const node = document.createElementNS(SVG_NS, tag);
  if (attrs) {
    for (const name of Object.keys(attrs)) node.setAttribute(name, String(attrs[name]));
  }
  for (const child of children) {
    if (child) node.appendChild(child);
  }
  return node;
}
