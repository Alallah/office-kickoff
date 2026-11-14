// Keyboard and mouse capture.
//
//   WASD / arrow keys  move              mouse           aim
//   Shift              sprint            left button     hold to charge, release to shoot
//   Space              slide / dash      right button    pass
//   Q / E              switch to best / next footballer
//   F                  spectators: toggle the follow camera
//
// Enter, Escape, Tab, H, M and the digits belong to the HUD: they are never handled or swallowed
// here. Keys typed into an editable element, or while the HUD captures input, are ignored and
// never preventDefault-ed.
//
// createControls() is the pure part (which keys are down, which edges are waiting for the next
// input tick); bindInput() wires it to the DOM.

import { KEY } from '../shared/protocol.js';
import { isEditableTarget } from '../shared/util.js';

const HELD = Object.freeze({ up: 1, down: 2, left: 4, right: 8, sprint: 16 });

// Physical keys (KeyboardEvent.code), so WASD sits where it should on every layout ...
const BY_CODE = Object.freeze({
  KeyW: 'up', ArrowUp: 'up',
  KeyS: 'down', ArrowDown: 'down',
  KeyA: 'left', ArrowLeft: 'left',
  KeyD: 'right', ArrowRight: 'right',
  ShiftLeft: 'sprint', ShiftRight: 'sprint',
  Space: 'tackle',
  KeyQ: 'switchBest',
  KeyE: 'switchNext',
  KeyF: 'follow',
});

// ... and the produced character for the rare keyboard event without a code (remote desktops, some IMEs).
const BY_KEY = Object.freeze({
  w: 'up', arrowup: 'up',
  s: 'down', arrowdown: 'down',
  a: 'left', arrowleft: 'left',
  d: 'right', arrowright: 'right',
  shift: 'sprint',
  ' ': 'tackle', spacebar: 'tackle',
  q: 'switchBest',
  e: 'switchNext',
  f: 'follow',
});

const EDGE = Object.freeze({ tackle: KEY.TACKLE, switchBest: KEY.SWITCH_BEST, switchNext: KEY.SWITCH_NEXT });

/** Keys whose default action scrolls the page. */
const SCROLLS = Object.freeze({ Space: true, ArrowUp: true, ArrowDown: true, ArrowLeft: true, ArrowRight: true, ' ': true, spacebar: true, arrowup: true, arrowdown: true, arrowleft: true, arrowright: true });

/** Stable identifier of the key of a keyboard event, the same for its keydown and keyup. */
export function keyId(e) {
  if (e.code) return e.code;
  return typeof e.key === 'string' ? e.key.toLowerCase() : '';
}

/** Game action of a key id ('up', 'tackle', ...), or undefined when the key is not ours. */
export function actionOf(id) {
  return Object.prototype.hasOwnProperty.call(BY_CODE, id) ? BY_CODE[id]
    : Object.prototype.hasOwnProperty.call(BY_KEY, id) ? BY_KEY[id]
    : undefined;
}

const DIAGONAL = 0.707;

/**
 * Which controls are down, and which one-shot presses are waiting for the next input tick.
 * No DOM: fed by bindInput(), sampled by the engine.
 */
export function createControls() {
  /** key id -> held action, so W and ArrowUp can overlap without one release cancelling the other. */
  const held = new Map();
  let shootHeld = false;
  // A click shorter than one input tick must still charge for a tick and then release.
  let shootLatch = false;
  let edges = 0;
  let followEdge = false;

  function heldBits() {
    let bits = 0;
    for (const action of held.values()) bits |= HELD[action];
    return bits;
  }

  return {
    /**
     * @param id      keyId(event)
     * @param repeat  KeyboardEvent.repeat
     * @returns {boolean} true when the key is a game key
     */
    keyDown(id, repeat) {
      const action = actionOf(id);
      if (!action) return false;
      if (HELD[action]) held.set(id, action);
      else if (!repeat) {
        if (action === 'follow') followEdge = true;
        else edges |= EDGE[action];
      }
      return true;
    },

    keyUp(id) {
      held.delete(id);
    },

    shootDown() {
      shootHeld = true;
      shootLatch = true;
    },

    shootUp() {
      shootHeld = false;
    },

    passDown() {
      edges |= KEY.PASS;
    },

    /** Lets go of everything and forgets waiting presses (focus lost, HUD has the keyboard). */
    clear() {
      held.clear();
      shootHeld = false;
      shootLatch = false;
      edges = 0;
      followEdge = false;
    },

    /**
     * The controls for one input tick. One-shot presses are reported by exactly one call.
     * @param out receives { mx, my, k }: move direction (diagonals normalised) and KEY bits
     */
    sample(out) {
      const bits = heldBits();
      let mx = (bits & HELD.right ? 1 : 0) - (bits & HELD.left ? 1 : 0);
      let my = (bits & HELD.down ? 1 : 0) - (bits & HELD.up ? 1 : 0);
      if (mx !== 0 && my !== 0) {
        mx *= DIAGONAL;
        my *= DIAGONAL;
      }
      out.mx = mx;
      out.my = my;
      out.k = (bits & HELD.sprint ? KEY.SPRINT : 0) | (shootHeld || shootLatch ? KEY.SHOOT : 0) | edges;
      shootLatch = false;
      edges = 0;
      return out;
    },

    /** Direction keys as -1..1 per axis without consuming anything (spectator camera). */
    axis(out) {
      const bits = heldBits();
      out.x = (bits & HELD.right ? 1 : 0) - (bits & HELD.left ? 1 : 0);
      out.y = (bits & HELD.down ? 1 : 0) - (bits & HELD.up ? 1 : 0);
      return out;
    },

    /** True once per press of the follow key. */
    takeFollowToggle() {
      const was = followEdge;
      followEdge = false;
      return was;
    },
  };
}

/**
 * Wires a controls object to the page.
 * @param o.target    object to listen on (window)
 * @param o.canvas    the game canvas; mouse coordinates are relative to it
 * @param o.surfaces  elements a click on which counts as a click on the pitch (the canvas itself,
 *                    and containers that may lie over it); clicks on anything else - HUD buttons,
 *                    the chat box - are not game input
 * @param o.controls  createControls()
 * @param o.captured  () => boolean: the HUD has the keyboard (chat focused, menu open)
 * @returns {{mouse:{x:number,y:number,known:boolean}, takeDrag:(out:{x:number,y:number})=>object, takeWheel:()=>number, refresh:()=>void, release:()=>void, destroy:()=>void}}
 */
export function bindInput({ target, canvas, surfaces, controls, captured }) {
  /** Cursor in CSS pixels relative to the canvas; `known` turns true with the first mouse event. */
  const mouse = { x: 0, y: 0, known: false };
  let left = 0;
  let top = 0;
  let dragging = false;
  let dragX = 0;
  let dragY = 0;
  let lastX = 0;
  let lastY = 0;
  let wheel = 0;

  function refresh() {
    try {
      const rect = canvas.getBoundingClientRect();
      left = rect.left;
      top = rect.top;
    } catch {
      left = 0;
      top = 0;
    }
  }

  function onSurface(el) {
    return el === canvas || surfaces.indexOf(el) >= 0;
  }

  function track(e) {
    if (mouse.known && dragging) {
      dragX += e.clientX - lastX;
      dragY += e.clientY - lastY;
    }
    lastX = e.clientX;
    lastY = e.clientY;
    mouse.x = e.clientX - left;
    mouse.y = e.clientY - top;
    mouse.known = true;
  }

  function onKeyDown(e) {
    const id = keyId(e);
    if (!actionOf(id)) return;
    // Browser shortcuts (Ctrl+W, Alt+Left, ...) stay browser shortcuts.
    if (e.ctrlKey || e.altKey || e.metaKey) return;
    if (isEditableTarget(e.target) || captured()) return;
    if (SCROLLS[id]) e.preventDefault();
    controls.keyDown(id, e.repeat === true);
  }

  function onKeyUp(e) {
    // Always: a key released while the chat had the keyboard must not stay down.
    controls.keyUp(keyId(e));
  }

  function onMouseDown(e) {
    track(e);
    if (!onSurface(e.target) || captured()) return;
    if (e.button === 0) {
      controls.shootDown();
      dragging = true;
    } else if (e.button === 2) {
      controls.passDown();
    }
  }

  function onMouseUp(e) {
    track(e);
    if (e.button === 0) {
      controls.shootUp();
      dragging = false;
    }
  }

  function onContextMenu(e) {
    if (onSurface(e.target)) e.preventDefault();
  }

  function onWheel(e) {
    if (!onSurface(e.target)) return;
    // deltaMode: 0 = pixels, 1 = lines, 2 = pages.
    wheel += e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1);
  }

  function release() {
    controls.clear();
    dragging = false;
    dragX = 0;
    dragY = 0;
    wheel = 0;
  }

  const listeners = [
    ['keydown', onKeyDown, undefined],
    ['keyup', onKeyUp, undefined],
    ['mousemove', track, { passive: true }],
    ['mousedown', onMouseDown, undefined],
    ['mouseup', onMouseUp, undefined],
    ['contextmenu', onContextMenu, undefined],
    ['wheel', onWheel, { passive: true }],
    // Key and button releases are not delivered to a window without focus.
    ['blur', release, undefined],
  ];
  for (const [type, fn, opts] of listeners) target.addEventListener(type, fn, opts);
  refresh();

  return {
    mouse,
    /** Pixels dragged with the left button since the last call. */
    takeDrag(out) {
      out.x = dragX;
      out.y = dragY;
      dragX = 0;
      dragY = 0;
      return out;
    },
    /** Wheel movement in pixels since the last call (positive = towards the user = zoom out). */
    takeWheel() {
      const w = wheel;
      wheel = 0;
      return w;
    },
    /** Re-measures where the canvas is (call on resize). */
    refresh,
    /** Lets go of everything (tab hidden, HUD took the keyboard). */
    release,
    destroy() {
      for (const [type, fn, opts] of listeners) target.removeEventListener(type, fn, opts);
    },
  };
}
