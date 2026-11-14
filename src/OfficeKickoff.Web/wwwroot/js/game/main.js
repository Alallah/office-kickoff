// Entry point of the match page (Views/Room/Match.cshtml): connects to the room, creates the
// renderer, the audio engine and the HUD, wires keyboard and mouse, and runs the frame loop.
// Everything between the network and those three modules lives in engine.js; this file is the
// DOM and network glue around it. See types.js for the module contracts.

import { EMOTES, ROUTES } from '../shared/protocol.js';
import { connectRoom } from '../shared/net.js';
import { getPrefs, savePrefs } from '../shared/identity.js';
import { createRenderer } from './render/renderer.js';
import { createAudio } from './audio.js';
import { createHud } from './hud.js';
import { createEngine } from './engine.js';
import { bindInput, createControls } from './input.js';

// ---- fault isolation -------------------------------------------------------------------------
// A bug in the renderer, the audio engine or the HUD must never stop the loop or the netcode:
// every call into them is guarded, and each distinct error is logged once.

const logged = new Set();

function report(where, err) {
  const key = `${where}|${err && err.message ? err.message : String(err)}`;
  if (logged.has(key)) return;
  logged.add(key);
  if (logged.size > 200) logged.clear();
  console.error(`[kickoff] ${where} failed:`, err);
}

/** Calls mod[method](...args) and swallows (logs once) whatever it throws. */
function safe(mod, name, method, ...args) {
  if (!mod || typeof mod[method] !== 'function') return undefined;
  try {
    return mod[method](...args);
  } catch (err) {
    report(`${name}.${method}`, err);
    return undefined;
  }
}

function nowSeconds() {
  return performance.now() / 1000;
}

function goHome(error) {
  location.replace(ROUTES.home(error));
}

async function boot() {
  const app = document.getElementById('app');
  const canvas = document.getElementById('game');
  const hudRoot = document.getElementById('hud');
  const code = String(app?.dataset?.room || '').trim().toUpperCase();
  if (!app || !canvas || !hudRoot || !code) {
    goHome('notfound');
    return;
  }

  /** @type {?Awaited<ReturnType<typeof connectRoom>>} */
  let room = null;
  let renderer = null;
  let audio = null;
  let hud = null;
  let ready = false;
  let leaving = false;

  let memberId = 0;
  let roomState = null;
  let matchId = null;
  let emoteList = EMOTES;

  // Hub messages that arrive before the page is assembled are replayed, in order, once it is.
  const early = [];
  function whenReady(fn) {
    if (ready) fn();
    else early.push(fn);
  }

  const controls = createControls();
  const engine = createEngine({
    input(dto) {
      if (room) room.send('Input', dto);
    },
    event(evt, view, toHud) {
      safe(renderer, 'renderer', 'onEvent', evt, view);
      safe(audio, 'audio', 'onEvent', evt, view);
      if (toHud) safe(hud, 'hud', 'onEvent', evt, view);
    },
    reset() {
      safe(renderer, 'renderer', 'reset');
    },
    controls,
  });

  function hubCall(method, ...args) {
    if (!room) return Promise.resolve(undefined);
    try {
      return room.invoke(method, ...args).catch((err) => {
        report(`hub ${method}`, err);
        return undefined;
      });
    } catch (err) {
      report(`hub ${method}`, err);
      return Promise.resolve(undefined);
    }
  }

  // ---- match lifecycle -------------------------------------------------------------------------

  function startMatch(init) {
    matchId = init.matchId;
    engine.setMatch(init, memberId, nowSeconds());
    engine.setRoom(roomState);
    engine.setResults(false);
    safe(renderer, 'renderer', 'setMatch', init);
    safe(audio, 'audio', 'setMatch', init);
    safe(hud, 'hud', 'setMatch', init, roomState, memberId);
    safe(hud, 'hud', 'hideResults');
    safe(renderer, 'renderer', 'reset');
  }

  function showResults(result) {
    if (!result) return;
    engine.setResults(true);
    safe(hud, 'hud', 'showResults', result);
  }

  function applyRoomState(state) {
    if (!state) return;
    roomState = state;
    engine.setRoom(state);
    safe(hud, 'hud', 'onRoomState', state);
    if (state.phase === 'lobby' && !leaving) {
      leaving = true;
      location.assign(ROUTES.lobby(code));
    }
  }

  const handlers = {
    onRoomState(state) {
      whenReady(() => applyRoomState(state));
    },
    onSnap(wire) {
      const at = nowSeconds();
      whenReady(() => engine.onSnap(wire, at));
    },
    onMatchInit(init) {
      // One that raced the Join reply may describe the very match the reply already started.
      const raced = !ready;
      whenReady(() => {
        if (!init || (raced && init.matchId === matchId)) return;
        startMatch(init);
      });
    },
    onMatchEnd(result) {
      whenReady(() => showResults(result));
    },
    onEmote(e) {
      whenReady(() => {
        safe(hud, 'hud', 'onEmote', e);
        const who = engine.footballerOf(e?.humanId ?? -1);
        const emoji = emoteList[e?.emote | 0];
        if (who >= 0 && emoji) safe(renderer, 'renderer', 'showEmote', who, emoji);
      });
    },
    onChat(chat) {
      whenReady(() => safe(hud, 'hud', 'onChat', chat));
    },
    onClosed(reason) {
      leaving = true;
      goHome(reason === 'replaced' ? 'replaced' : 'closed');
    },
    onRejoined(join) {
      whenReady(() => {
        if (!join) return;
        if (Number.isFinite(join.memberId)) memberId = join.memberId;
        applyRoomState(join.room);
        if (leaving) return;
        if (join.match && join.match.matchId !== matchId) {
          startMatch(join.match);
        } else {
          // Same match: the server dropped my queued inputs, and what happened meanwhile is not replayed.
          engine.rejoin();
        }
        if (join.result) showResults(join.result);
      });
    },
    onStatus(status) {
      engine.setStatus(status);
    },
    onPing(ms) {
      engine.setPing(ms);
    },
  };

  let joined;
  try {
    joined = await connectRoom({ code, page: 'match', handlers });
  } catch (err) {
    // No SignalR client script, or something equally fatal: nothing to connect with.
    report('connectRoom', err);
    goHome('notfound');
    return;
  }
  if (!joined.ok) {
    goHome(joined.error === 'full' ? 'full' : 'notfound');
    return;
  }
  if (leaving) return;
  room = joined;
  const join = room.join || {};
  memberId = room.memberId;
  roomState = join.room || null;
  if (Array.isArray(join.catalog?.emotes) && join.catalog.emotes.length) emoteList = join.catalog.emotes;

  if (!join.match || !roomState || roomState.phase === 'lobby') {
    // No match to show (it ended and the room went back to the lobby meanwhile).
    leaving = true;
    location.replace(ROUTES.lobby(code));
    return;
  }

  // ---- the three presentation modules ----------------------------------------------------------
  const prefs = getPrefs();
  let autoSwitch = prefs.autoSwitch !== false;

  const actions = {
    chat(text) {
      hubCall('Chat', String(text ?? ''));
    },
    emote(index) {
      hubCall('Emote', index | 0);
    },
    setVolume(volume) {
      const v = Number.isFinite(volume) ? Math.min(1, Math.max(0, volume)) : 0.7;
      safe(audio, 'audio', 'setVolume', v);
      savePrefs({ volume: v });
    },
    setMuted(muted) {
      safe(audio, 'audio', 'setMuted', !!muted);
      savePrefs({ muted: !!muted });
    },
    setAutoSwitch(on) {
      autoSwitch = !!on;
      engine.setAutoSwitch(autoSwitch);
      hubCall('SetProfile', { autoSwitch });
      savePrefs({ autoSwitch });
    },
    rematch() {
      hubCall('Rematch');
    },
    backToLobby() {
      hubCall('BackToLobby');
    },
    async leave() {
      if (leaving) return;
      leaving = true;
      await hubCall('Leave');
      try {
        await room.stop();
      } catch {
        /* already closed */
      }
      location.assign(ROUTES.home());
    },
    uiSound(name, value) {
      safe(audio, 'audio', 'ui', name, value);
    },
    getPrefs() {
      const p = getPrefs();
      return { volume: Number.isFinite(p.volume) ? p.volume : 0.7, muted: !!p.muted, autoSwitch: p.autoSwitch !== false };
    },
  };

  try {
    renderer = createRenderer(canvas);
  } catch (err) {
    report('createRenderer', err);
  }
  try {
    audio = createAudio();
  } catch (err) {
    report('createAudio', err);
  }
  try {
    hud = createHud(hudRoot, actions);
  } catch (err) {
    report('createHud', err);
  }

  safe(audio, 'audio', 'setVolume', Number.isFinite(prefs.volume) ? prefs.volume : 0.7);
  safe(audio, 'audio', 'setMuted', !!prefs.muted);
  // After a same-site navigation from the lobby the browser usually allows sound right away.
  safe(audio, 'audio', 'unlock');
  engine.setAutoSwitch(autoSwitch);
  engine.setPing(room.ping);

  // ---- input -----------------------------------------------------------------------------------
  const captured = () => safe(hud, 'hud', 'capturesInput') === true;
  const input = bindInput({ target: window, canvas, surfaces: [canvas, hudRoot, app], controls, captured });

  const unlock = () => safe(audio, 'audio', 'unlock');
  window.addEventListener('pointerdown', unlock, { capture: true, passive: true });
  window.addEventListener('keydown', unlock, { capture: true, passive: true });

  // Losing focus or visibility: one neutral input now, then silence until focus returns (the
  // server hands my footballer to the AI meanwhile and gives me one back on my next input).
  function backgrounded() {
    input.release();
    engine.focusLost();
  }
  window.addEventListener('blur', backgrounded);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') backgrounded();
  });

  // ---- size --------------------------------------------------------------------------------------
  const viewport = { w: 1, h: 1 };
  let sizedW = -1;
  let sizedH = -1;
  let sizedDpr = -1;
  function measure() {
    const w = Math.max(1, canvas.clientWidth || 0);
    const h = Math.max(1, canvas.clientHeight || 0);
    const dpr = window.devicePixelRatio > 0 ? window.devicePixelRatio : 1;
    viewport.w = w;
    viewport.h = h;
    if (w === sizedW && h === sizedH && dpr === sizedDpr) return;
    sizedW = w;
    sizedH = h;
    sizedDpr = dpr;
    input.refresh();
    safe(renderer, 'renderer', 'resize', w, h, dpr);
  }
  window.addEventListener('resize', measure);
  measure();

  // ---- the match ---------------------------------------------------------------------------------
  ready = true;
  startMatch(join.match);
  if (join.result || roomState.phase === 'results') showResults(join.result);
  for (let i = 0; i < early.length; i++) early[i]();
  early.length = 0;

  // ---- frame loop ----------------------------------------------------------------------------------
  const drag = { x: 0, y: 0 };
  const frameInput = { viewport, mouse: input.mouse, captured: false, focused: false, dragX: 0, dragY: 0, wheel: 0 };

  function frame() {
    requestAnimationFrame(frame);
    if (leaving) return;
    try {
      // Zoom, a docked devtools pane or a moved window change the size without always firing resize.
      measure();
      input.takeDrag(drag);
      frameInput.captured = captured();
      frameInput.focused = document.visibilityState === 'visible' && document.hasFocus();
      frameInput.dragX = drag.x;
      frameInput.dragY = drag.y;
      frameInput.wheel = input.takeWheel();
      const view = engine.frame(nowSeconds(), frameInput);
      if (view) {
        safe(renderer, 'renderer', 'render', view);
        safe(audio, 'audio', 'update', view);
        safe(hud, 'hud', 'update', view);
      }
    } catch (err) {
      report('frame', err);
    }
  }
  requestAnimationFrame(frame);
}

boot().catch((err) => report('boot', err));
