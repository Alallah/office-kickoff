// DOM helpers for the lobby: element builders, patch-style setters, icons, toasts, popovers.
//
// The lobby is built once and then PATCHED on every RoomState (text set only when it changed,
// inputs left alone while they have focus), never re-created: that is what keeps focus, scroll
// positions and half-typed text where the user left them.
//
// Text always goes in through textContent / value, never innerHTML.

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Set as DOM properties; every other key of `props` becomes an attribute. */
const PROPERTIES = new Set(['value', 'checked', 'disabled', 'hidden', 'readOnly', 'tabIndex', 'htmlFor', 'selected']);

function append(parent, children) {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    if (Array.isArray(child)) append(parent, child);
    else parent.appendChild(child instanceof Node ? child : document.createTextNode(String(child)));
  }
}

/**
 * Creates an HTML element.
 * @param {string} tag
 * @param {?Object} [props]  class, text, dataset, style (object; "--name" sets a custom property),
 *                           onEvent handlers, the properties listed in PROPERTIES, anything else = attribute
 * @param {...(Node|string|number|Array|null|false)} children
 */
export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  const late = [];
  for (const [key, value] of Object.entries(props ?? {})) {
    if (value === null || value === undefined) continue;
    if (key === 'class') el.className = value;
    else if (key === 'text') el.textContent = value;
    else if (key === 'dataset') Object.assign(el.dataset, value);
    else if (key === 'style') setStyles(el, value);
    else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2).toLowerCase(), value);
    // value / checked depend on type, min, max and step being in place first.
    else if (PROPERTIES.has(key)) late.push([key, value]);
    else if (value === true) el.setAttribute(key, '');
    else if (value !== false) el.setAttribute(key, String(value));
  }
  for (const [key, value] of late) el[key] = value;
  append(el, children);
  return el;
}

/** Creates an SVG element; `props` are attributes, plus `text`. */
export function svg(tag, props, ...children) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(props ?? {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'text') el.textContent = value;
    else el.setAttribute(key, String(value));
  }
  append(el, children);
  return el;
}

export function setStyles(el, styles) {
  for (const [name, value] of Object.entries(styles)) {
    if (name.startsWith('--')) el.style.setProperty(name, value);
    else el.style[name] = value;
  }
}

/** Sets textContent only when it differs (keeps selections and avoids needless layout). */
export function setText(node, text) {
  const next = String(text ?? '');
  if (node.textContent !== next) node.textContent = next;
}

/** Sets, or with null / false removes, an attribute - only when it differs. */
export function setAttr(node, name, value) {
  if (value === null || value === undefined || value === false) {
    if (node.hasAttribute(name)) node.removeAttribute(name);
    return;
  }
  const next = value === true ? '' : String(value);
  if (node.getAttribute(name) !== next) node.setAttribute(name, next);
}

export function setHidden(node, hidden) {
  if (node.hidden !== hidden) node.hidden = hidden;
}

export function hasFocus(el) {
  return document.activeElement === el;
}

/** Adds or removes a class - only when that changes something. */
export function setClass(node, name, on) {
  if (node.classList.contains(name) !== on) node.classList.toggle(name, on);
}

/** Plays a one-shot CSS animation class from its start, also when it is already on the element. */
export function replay(node, className) {
  node.classList.remove(className);
  // Reading a layout property makes the browser notice the removal before the class returns.
  void node.offsetWidth;
  node.classList.add(className);
}

/** True when the element is in the page and takes up space (not hidden, not inside something hidden). */
export function isShown(node) {
  return node instanceof Element && node.isConnected && node.getClientRects().length > 0;
}

/**
 * Writes a server value into a text input unless the user is typing in it.
 * @returns {boolean} false when the input was skipped because it has focus
 */
export function setValue(input, value) {
  if (hasFocus(input)) return false;
  const next = String(value ?? '');
  if (input.value !== next) input.value = next;
  return true;
}

const ICONS = {
  copy: 'M9 9h10v11H9z M5 15V4h10',
  link: 'M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1.2 1.2 M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1.2-1.2',
  check: 'M5 12.5l4.5 4.5L19 7.5',
  exit: 'M10 4H5v16h5 M14 8l4 4-4 4 M18 12H9',
  pencil: 'M4 20l1-4L16 5l3 3L8 19z M14 7l3 3',
  shirt: 'M8 4L3 7l2 4 3-1v10h8V10l3 1 2-4-5-3c-1 2-7 2-8 0z',
  eye: 'M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
  close: 'M6 6l12 12 M18 6L6 18',
  download: 'M12 4v11 M7 11l5 5 5-5 M5 20h14',
  upload: 'M12 16V5 M7 9l5-5 5 5 M5 20h14',
  paste: 'M9 4h6v3H9z M9 5H5v15h14V5h-4',
  trash: 'M5 7h14 M9 7V4h6v3 M7 7l1 13h8l1-13',
  shuffle: 'M4 7h3l10 10h3 M4 17h3l3-3 M14 10l3-3h3 M18 4l3 3-3 3 M18 14l3 3-3 3',
  send: 'M4 12l16-8-6 16-3-6z',
  chevron: 'M6 9l6 6 6-6',
  warning: 'M12 4l9 16H3z M12 10v4 M12 17v.5',
  undo: 'M9 7l-5 5 5 5 M4 12h10a5 5 0 0 1 0 10h-2',
  plus: 'M12 5v14 M5 12h14',
  bot: 'M6 9h12v9H6z M12 9V5 M9.5 13v1 M14.5 13v1 M3 13v3 M21 13v3',
  save: 'M6 4h12v16l-6-4-6 4z',
  bolt: 'M13 3L5 14h6l-1 7 8-11h-6z',
  users: 'M9 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z M2.5 20c1-3.5 3.5-5 6.5-5s5.5 1.5 6.5 5 M16 4.5a3.5 3.5 0 0 1 0 6.5 M18 15.5c1.8.7 3 2.2 3.5 4.5',
};

/** Shapes that read better filled than outlined. */
const FILLED = { crown: 'M3 8l4.5 4L12 5l4.5 7L21 8l-2 11H5z' };

/**
 * A small inline icon (decorative: give the control around it a text label or aria-label).
 * @param {string} name  key of ICONS or FILLED
 * @param {number} [size]
 */
export function icon(name, size = 16) {
  const filled = Object.prototype.hasOwnProperty.call(FILLED, name);
  return svg(
    'svg',
    {
      class: `icon icon-${name}`,
      width: size,
      height: size,
      viewBox: '0 0 24 24',
      fill: filled ? 'currentColor' : 'none',
      stroke: filled ? 'none' : 'currentColor',
      'stroke-width': 2,
      'stroke-linecap': 'round',
      'stroke-linejoin': 'round',
      'aria-hidden': 'true',
      focusable: 'false',
    },
    svg('path', { d: filled ? FILLED[name] : ICONS[name] ?? '' }),
  );
}

let toastHost = null;

/**
 * A short notice in the corner of the page.
 * @param {string} message
 * @param {{kind?: 'info'|'ok'|'warn', timeout?: number, action?: {label: string, run: () => void}}} [opts]
 */
export function toast(message, opts = {}) {
  if (!toastHost) toastHost = h('div', { class: 'toasts', role: 'status', 'aria-live': 'polite' });
  // A child of <body> itself - a sibling of the page, never inside it - so that a toast and its
  // action button keep working while a modal has made the page inert.
  if (toastHost.parentNode !== document.body) document.body.appendChild(toastHost);
  const item = h('div', { class: `toast toast-${opts.kind ?? 'info'}` }, h('span', { class: 'toast-text', text: message }));
  const dismiss = () => {
    clearTimeout(timer);
    item.classList.add('is-leaving');
    setTimeout(() => item.remove(), 200);
  };
  if (opts.action) {
    item.appendChild(
      h('button', {
        class: 'toast-action',
        type: 'button',
        text: opts.action.label,
        onClick: () => {
          opts.action.run();
          dismiss();
        },
      }),
    );
  }
  toastHost.appendChild(item);
  while (toastHost.children.length > 4) toastHost.firstElementChild.remove();
  const timer = setTimeout(dismiss, opts.timeout ?? (opts.action ? 6000 : 2600));
  return dismiss;
}

const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex="0"]';

/**
 * A panel that drops out of a trigger button: positioned under it (above when there is no room),
 * closed by Escape, by a click elsewhere, or by focus moving on. Focus returns to the trigger
 * when it is closed from the keyboard.
 * @param {HTMLElement} anchor   the trigger button; gets aria-expanded
 * @param {(panel: HTMLElement, close: () => void) => void} build  fills the panel each time it opens
 * @param {{label: string, align?: 'start'|'end', className?: string, onClose?: () => void}} opts
 */
export function createPopover(anchor, build, opts) {
  let panel = null;

  function position() {
    if (!panel) return;
    const a = anchor.getBoundingClientRect();
    const vw = document.documentElement.clientWidth;
    const vh = document.documentElement.clientHeight;
    const w = panel.offsetWidth;
    const ht = panel.offsetHeight;
    let left = opts.align === 'end' ? a.right - w : a.left;
    left = Math.max(8, Math.min(left, vw - w - 8));
    let top = a.bottom + 8;
    if (top + ht > vh - 8 && a.top - 8 - ht >= 8) top = a.top - 8 - ht;
    top = Math.max(8, Math.min(top, vh - ht - 8));
    panel.style.left = `${Math.round(left)}px`;
    panel.style.top = `${Math.round(top)}px`;
  }

  function onPointerDown(e) {
    if (panel && !panel.contains(e.target) && !anchor.contains(e.target)) close(false);
  }

  function onKeyDown(e) {
    if (e.key === 'Escape' && panel) {
      e.stopPropagation();
      e.preventDefault();
      close(true);
    }
  }

  function onFocusOut(e) {
    const to = e.relatedTarget;
    if (to instanceof Node && !panel?.contains(to) && !anchor.contains(to)) close(false);
  }

  function open() {
    if (panel) return;
    panel = h('div', {
      class: `popover ${opts.className ?? ''}`,
      role: 'dialog',
      'aria-label': opts.label,
      tabindex: '-1',
    });
    build(panel, () => close(true));
    document.body.appendChild(panel);
    position();
    anchor.setAttribute('aria-expanded', 'true');
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown, true);
    panel.addEventListener('focusout', onFocusOut);
    window.addEventListener('resize', position);
    // The panel is fixed to the viewport, its trigger is not: follow it when the page scrolls.
    window.addEventListener('scroll', position, true);
    (panel.querySelector('[data-autofocus]') ?? panel.querySelector(FOCUSABLE) ?? panel).focus({ preventScroll: true });
  }

  function close(returnFocus) {
    if (!panel) return;
    const old = panel;
    panel = null;
    document.removeEventListener('pointerdown', onPointerDown, true);
    document.removeEventListener('keydown', onKeyDown, true);
    window.removeEventListener('resize', position);
    window.removeEventListener('scroll', position, true);
    old.removeEventListener('focusout', onFocusOut);
    const hadFocus = old.contains(document.activeElement);
    old.remove();
    anchor.setAttribute('aria-expanded', 'false');
    if (returnFocus || hadFocus) anchor.focus({ preventScroll: true });
    opts.onClose?.();
  }

  anchor.setAttribute('aria-haspopup', 'dialog');
  anchor.setAttribute('aria-expanded', 'false');
  anchor.addEventListener('click', () => (panel ? close(true) : open()));

  return {
    open,
    close: () => close(false),
    reposition: position,
    get isOpen() {
      return panel !== null;
    },
    /** The open panel, or null. */
    get panel() {
      return panel;
    },
  };
}

/**
 * A modal layer: a dimmed backdrop with a centred panel. While it is open the page behind it is
 * inert, Tab stays inside the panel, and Escape or a click on the backdrop asks to close.
 *
 * Deliberately not <dialog>.showModal(): that makes everything else in <body> inert, including
 * the off-screen textarea copyText() needs on plain-http pages (where navigator.clipboard does
 * not exist), so "Copy" inside the dialog would silently stop working on the office intranet.
 * @param {{className?: string, labelledBy: string, background: ?HTMLElement, onRequestClose: () => void}} opts
 *        `background`: the page root to switch off while the modal is open
 */
export function createModal({ className = '', labelledBy, background, onRequestClose }) {
  const panel = h('div', {
    class: `modal-panel ${className}`.trim(),
    role: 'dialog',
    'aria-modal': 'true',
    'aria-labelledby': labelledBy,
    tabindex: '-1',
  });
  const overlay = h('div', { class: 'modal' }, panel);
  let returnTo = null;
  let pressedBackdrop = false;

  overlay.addEventListener('pointerdown', (e) => {
    pressedBackdrop = e.target === overlay;
  });
  overlay.addEventListener('click', (e) => {
    // Press AND release on the backdrop: a text selection dragged out of the panel must not close it.
    if (e.target === overlay && pressedBackdrop) onRequestClose();
    pressedBackdrop = false;
  });
  // A button that disables itself while it works (Apply) drops the focus onto <body>, where the
  // overlay never hears a key: while open, keys from outside the overlay are handled here too.
  // Toasts live outside the overlay and keep their own keyboard behaviour.
  const onStrayKey = (e) => {
    const target = e.target;
    if (!(target instanceof Node) || overlay.contains(target) || target.closest?.('.toasts')) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      onRequestClose();
    } else if (e.key === 'Tab') {
      e.preventDefault();
      (panel.querySelector(FOCUSABLE) ?? panel).focus({ preventScroll: true });
    }
  };

  overlay.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      onRequestClose();
      return;
    }
    if (e.key !== 'Tab') return;
    const stops = [...panel.querySelectorAll(FOCUSABLE)].filter(isShown);
    if (stops.length === 0) {
      e.preventDefault();
      panel.focus({ preventScroll: true });
      return;
    }
    const first = stops[0];
    const last = stops[stops.length - 1];
    const active = document.activeElement;
    if (e.shiftKey && (active === first || active === panel)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
  });

  return {
    /** The dialog box: put the content in here. */
    panel,
    get isOpen() {
      return overlay.isConnected;
    },
    open() {
      if (overlay.isConnected) return;
      returnTo = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      document.body.appendChild(overlay);
      document.addEventListener('keydown', onStrayKey);
      if (background) {
        background.inert = true;
        background.setAttribute('aria-hidden', 'true');
      }
      (panel.querySelector('[data-autofocus]') ?? panel).focus({ preventScroll: true });
    },
    close() {
      if (!overlay.isConnected) return;
      document.removeEventListener('keydown', onStrayKey);
      if (background) {
        background.inert = false;
        background.removeAttribute('aria-hidden');
      }
      overlay.remove();
      if (returnTo && returnTo.isConnected) returnTo.focus({ preventScroll: true });
      returnTo = null;
    },
  };
}

/** Runs `fn` at most once per `ms`, always with the latest call (trailing edge). */
export function throttle(fn, ms) {
  let timer = 0;
  let pending = null;
  const run = () => {
    timer = 0;
    const args = pending;
    pending = null;
    if (args) fn(...args);
  };
  const wrapped = (...args) => {
    pending = args;
    if (!timer) timer = setTimeout(run, ms);
  };
  /** Runs a waiting call right now. */
  wrapped.flush = () => {
    if (timer) {
      clearTimeout(timer);
      run();
    }
  };
  wrapped.cancel = () => {
    clearTimeout(timer);
    timer = 0;
    pending = null;
  };
  return wrapped;
}

/** Runs `fn` once the calls have stopped for `ms`. */
export function debounce(fn, ms) {
  let timer = 0;
  let pending = null;
  const run = () => {
    timer = 0;
    const args = pending;
    pending = null;
    if (args) fn(...args);
  };
  const wrapped = (...args) => {
    pending = args;
    clearTimeout(timer);
    timer = setTimeout(run, ms);
  };
  wrapped.flush = () => {
    if (timer) {
      clearTimeout(timer);
      run();
    }
  };
  wrapped.cancel = () => {
    clearTimeout(timer);
    timer = 0;
    pending = null;
  };
  return wrapped;
}
