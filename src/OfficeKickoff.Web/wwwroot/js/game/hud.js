// The match page's interface layer: everything that is DOM rather than canvas (see types.js for
// the Hud and HudActions contracts).
//
// This file is the conductor. Each piece of the interface lives in its own module under hud/ and
// knows nothing about the others; here they are laid out on the screen, fed the frame, the game
// events, the room and the chat, and given the keyboard:
//
//     top-left      feed.js        goals, saves, tackles, chat, announcements, emotes
//     top-centre    scoreboard.js  + the replay tag (stage.js) + the connection notice (status.js)
//     top-right     status.js      ping, muted tag, menu key
//     bottom-left   chat.js        chat box, emote bar
//     bottom-centre ability.js     stamina, shot charge, cooldown, switch keys
//     bottom-right  nothing: the renderer's minimap lives there
//     centre        stage.js       versus card, countdown, GOAL, golden goal, full time
//                   roster.js      who is playing (while Tab is held)
//     full screen   results.js, menu.js, controls.js
//
// The pure logic (formatting, key routing, timelines) is in hud/format.js and hud/logic.js.

import { EVT, PHASE } from '../shared/protocol.js';
import { isEditableTarget, prefersReducedMotion } from '../shared/util.js';
import { el, add, clear, focusables, nowSeconds, releaseFocus } from './hud/dom.js';
import {
  clamp01, controllingHumans, feedForChat, feedForEmote, feedForEvent, hostName, humanByMember, isHost, nextShot, num,
  resultsModel, roomCodeOf, rosterModel, teamInfo,
} from './hud/format.js';
import { guardActions, hudKey, isSpectator, nextFocusIndex, offersControls, routeKey } from './hud/logic.js';
import { createScoreboard } from './hud/scoreboard.js';
import { createStage } from './hud/stage.js';
import { createAbilityBar } from './hud/ability.js';
import { createFeed } from './hud/feed.js';
import { createStatus } from './hud/status.js';
import { createChat } from './hud/chat.js';
import { createRoster } from './hud/roster.js';
import { createResults } from './hud/results.js';
import { createMenu } from './hud/menu.js';
import { createControls } from './hud/controls.js';

const SIDES = ['home', 'away'];

/** A frame clock further than this from the wall clock is not the wall clock the contract promises. */
const CLOCK_SLACK = 2;

function hostNode(given) {
  if (given && typeof given.appendChild === 'function') return given;
  const node = el('div');
  node.id = 'hud';
  document.body.appendChild(node);
  return node;
}

/**
 * @param {HTMLElement} rootNode  the #hud element of the match page
 * @param {object} rawActions     HudActions (see types.js)
 * @returns {object} Hud
 */
export function createHud(rootNode, rawActions) {
  const root = hostNode(rootNode);
  clear(root);
  root.classList.add('hud');

  // One broken part must not take the others down with it, sixty times a second: every part is
  // called through run(), which reports the first failure of each and carries on.
  const failed = {};
  function report(part, err) {
    if (failed[part]) return;
    failed[part] = true;
    console.error(`[hud] ${part} failed`, err);
  }
  // Fixed arguments rather than a rest parameter: this runs for every part of every frame.
  function run(part, fn, a, b, c, d) {
    try {
      return fn(a, b, c, d);
    } catch (err) {
      report(part, err);
      return undefined;
    }
  }

  const actions = guardActions(rawActions, (name, err) => report(`actions.${name}`, err));

  // ---- state ------------------------------------------------------------------------------
  let init = null;
  let room = null;
  let memberId = 0;
  let teams = [teamInfo(null, null, 0), teamInfo(null, null, 1)];
  const prefs = actions.getPrefs();
  let reduced = prefersReducedMotion();
  /** The shot in flight, for telling saves from routine catches (see nextShot). */
  let shot = null;
  let resultsUp = false;
  let resultsKey = '';
  /** Who is at the controls (mask of human ids), or null while that means nothing. */
  let control = null;
  let rosterDirty = true;
  let lastMe = null;
  let lastScore = null;
  let lastPlayers = null;
  /** The controls card offers itself once per page, however many practice matches follow. */
  let controlsOffered = false;
  /** The code in the page itself, for the moments before the first room state. */
  const pageCode = typeof root.closest === 'function'
    ? root.closest('[data-room]')?.getAttribute('data-room') ?? ''
    : '';

  // ---- parts ------------------------------------------------------------------------------
  const scoreboard = createScoreboard();
  const stage = createStage(actions);
  const ability = createAbilityBar();
  const feed = createFeed();
  const status = createStatus(actions);
  const chat = createChat(actions);
  const roster = createRoster();
  const results = createResults(actions, {
    rematch: () => actions.rematch(),
    backToLobby: () => actions.backToLobby(),
    leave: () => actions.leave(),
  });
  const menu = createMenu(actions, {
    close: closeMenu,
    toggleMute,
    setVolume,
    setAutoSwitch,
    backToLobby() {
      closeMenu();
      actions.backToLobby();
    },
    leave() {
      closeMenu();
      actions.leave();
    },
  });
  const controls = createControls(actions, closeControls);

  add(
    root,
    add(el('div', 'hud-tl'), feed.el),
    add(el('div', 'hud-tc'), scoreboard.el, stage.replayEl, status.noticeEl),
    add(el('div', 'hud-tr'), status.el),
    add(el('div', 'hud-bl'), chat.el),
    add(el('div', 'hud-bc'), ability.el),
    stage.el,
    add(el('div', 'hud-mid'), roster.el),
    results.el,
    menu.el,
    controls.el,
  );

  status.setMuted(prefs.muted, false);
  menu.sync(prefs);
  applyKits();
  applyRoom();

  // ---- look -------------------------------------------------------------------------------

  /** Hands the kit colours to the stylesheet; every [data-team] element picks its side's set. */
  function applyKits() {
    for (let i = 0; i < 2; i++) {
      const team = teams[i];
      const name = `--kit-${SIDES[i]}`;
      // teamInfo only lets "#rrggbb" through, so the values are safe as styles.
      root.style.setProperty(name, team.primary);
      root.style.setProperty(`${name}-2`, team.secondary);
      root.style.setProperty(`${name}-ink`, team.ink);
      root.style.setProperty(`${name}-tint`, team.tint);
    }
  }

  /** Everything that depends on the room: the code, and who is host RIGHT NOW. */
  function applyRoom() {
    const code = roomCodeOf(room, pageCode);
    const host = isHost(room, memberId);
    menu.setRoom(code, host);
    roster.setRoom(code);
    results.setRoom(host, hostName(room));
    rosterDirty = true;
  }

  function spectating() {
    if (lastMe) return isSpectator(lastMe);
    // No frame yet: a seat in the match is what makes a player.
    return !humanByMember(init, memberId);
  }

  // ---- sound and play preferences ---------------------------------------------------------

  function setMuted(muted, announce) {
    prefs.muted = !!muted;
    actions.setMuted(prefs.muted);
    status.setMuted(prefs.muted, announce);
    menu.sync(prefs);
  }

  function toggleMute() {
    setMuted(!prefs.muted, true);
    // Audible proof that the sound is back.
    if (!prefs.muted) actions.uiSound('click');
  }

  function setVolume(volume) {
    prefs.volume = clamp01(volume);
    actions.setVolume(prefs.volume);
    // Reaching for the slider while muted means "I want to hear it".
    if (prefs.muted && prefs.volume > 0) setMuted(false, false);
    else menu.sync(prefs);
  }

  function setAutoSwitch(on) {
    prefs.autoSwitch = !!on;
    actions.setAutoSwitch(prefs.autoSwitch);
    menu.sync(prefs);
  }

  // ---- overlays ---------------------------------------------------------------------------

  function openMenu() {
    if (menu.isOpen) return;
    hideRoster();
    chat.cancel();
    menu.sync(prefs);
    menu.open();
    actions.uiSound('open');
  }

  function closeMenu() {
    if (!menu.isOpen) return;
    menu.close();
    releaseFocus(root);
    actions.uiSound('close');
  }

  /** @param {boolean} [byItself]  opened by the HUD (start of a practice match), not by the player */
  function openControls(byItself = false) {
    if (controls.isOpen) return;
    hideRoster();
    chat.cancel();
    controls.open({ practice: !!init?.practice, spectator: spectating() });
    if (!byItself) actions.uiSound('open');
  }

  function closeControls() {
    if (!controls.isOpen) return;
    controls.close();
    releaseFocus(root);
    actions.uiSound('close');
  }

  function refreshRoster() {
    if (!rosterDirty) return;
    rosterDirty = false;
    roster.render(rosterModel(init, room, memberId, control));
  }

  function showRoster() {
    if (roster.isOpen) return;
    rosterDirty = true;
    refreshRoster();
    roster.setScore(lastScore);
    roster.show();
  }

  function hideRoster() {
    if (roster.isOpen) roster.hide();
  }

  /** Tab inside a menu or the results: focus walks the controls of the topmost layer and stays there. */
  function moveFocus(step) {
    const layer = controls.isOpen ? controls.el : menu.isOpen ? menu.el : results.isOpen ? results.el : null;
    const list = focusables(layer);
    if (list.length === 0) return;
    const next = list[nextFocusIndex(list.indexOf(document.activeElement), list.length, step)];
    if (next) next.focus({ preventScroll: true });
  }

  // ---- keyboard ---------------------------------------------------------------------------

  function perform(action, arg) {
    switch (action) {
      case 'chat-open':
        hideRoster();
        chat.open();
        break;
      case 'chat-send':
        chat.send();
        break;
      case 'chat-cancel':
        chat.cancel();
        break;
      case 'quick':
        chat.quick(arg);
        break;
      case 'emote':
        chat.emote(arg);
        break;
      case 'menu-open':
        openMenu();
        break;
      case 'menu-close':
        closeMenu();
        break;
      case 'controls-open':
        openControls();
        break;
      case 'controls-close':
        closeControls();
        break;
      case 'mute':
        toggleMute();
        break;
      case 'roster':
        showRoster();
        break;
      case 'focus':
        moveFocus(arg);
        break;
      default:
        break;
    }
  }

  function onKeyDown(e) {
    const typing = e.target === chat.input;
    const id = hudKey(e.key, e.code, typing);
    if (!id) return;
    const active = document.activeElement;
    const route = routeKey(id, {
      typing,
      // 229 is what a key press reports while an input method is composing.
      composing: e.isComposing === true || e.keyCode === 229,
      chatEmpty: chat.isEmpty,
      foreign: !typing && isEditableTarget(e.target) && !root.contains(e.target),
      focused: !typing && !!active && active !== document.body && root.contains(active),
      repeat: e.repeat === true,
      shift: e.shiftKey === true,
      modifier: e.ctrlKey === true || e.altKey === true || e.metaKey === true,
      menu: menu.isOpen,
      controls: controls.isOpen,
      results: resultsUp,
    });
    if (route.prevent) e.preventDefault();
    if (route.action) run(`key ${route.action}`, perform, route.action, route.arg);
  }

  function onKeyUp(e) {
    if (hudKey(e.key, e.code) === 'tab') hideRoster();
  }

  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  // The release of a held Tab never arrives in a window that has lost the focus.
  window.addEventListener('blur', hideRoster);

  // ---- the Hud ----------------------------------------------------------------------------

  /** The frame's clock, or the wall clock when the frame does not carry a usable one. */
  function clock(view) {
    const wall = nowSeconds();
    const t = view ? view.now : undefined;
    return typeof t === 'number' && Math.abs(t - wall) < CLOCK_SLACK ? t : wall;
  }

  function setMatch(nextInit, nextRoom, nextMemberId) {
    init = nextInit ?? null;
    if (nextRoom) room = nextRoom;
    if (typeof nextMemberId === 'number') memberId = nextMemberId;
    teams = [teamInfo(init, room, 0), teamInfo(init, room, 1)];
    reduced = prefersReducedMotion();
    shot = null;
    control = null;
    lastMe = null;
    lastScore = null;
    lastPlayers = null;

    hideResults();
    hideRoster();
    applyKits();
    root.classList.toggle('is-practice', init?.practice === true);
    run('scoreboard', scoreboard.setMatch, teams, init);
    run('stage', stage.setMatch, teams, init, memberId, reduced);
    run('ability', ability.setMatch, init);
    run('roster', roster.setMatch, teams, init);
    applyRoom();

    // A fresh practice match opens on the controls card: that is what practice is for.
    if (!controlsOffered && offersControls(init)) {
      controlsOffered = true;
      openControls(true);
    }
  }

  function onRoomState(nextRoom) {
    if (!nextRoom) return;
    room = nextRoom;
    // Without a match the room is all there is to know about the teams.
    if (!init) {
      teams = [teamInfo(null, room, 0), teamInfo(null, room, 1)];
      applyKits();
    }
    applyRoom();
  }

  /** Remembers who is at the controls; only a live frame can tell. */
  function trackControl(view) {
    const phase = view.phase;
    if (view.replay || phase === PHASE.REPLAY) return;
    const live = phase === PHASE.INTRO || phase === PHASE.KICKOFF || phase === PHASE.PLAYING || phase === PHASE.GOAL;
    const next = live && Array.isArray(view.players) ? controllingHumans(view.players) : null;
    if (next !== control) {
      control = next;
      rosterDirty = true;
    }
  }

  function update(view) {
    if (!view) return;
    const now = clock(view);
    lastMe = view.me ?? null;
    lastScore = view.score ?? null;
    lastPlayers = view.players ?? null;

    run('scoreboard', scoreboard.update, view);
    run('stage', stage.update, view, now, resultsUp);
    run('ability', ability.update, view, now, resultsUp);
    run('status', status.update, view);
    run('feed', feed.update, now);

    trackControl(view);
    if (roster.isOpen) {
      run('roster', refreshRoster);
      roster.setScore(lastScore);
    }

    // The chat box is open exactly as long as its input has the focus; if the focus went
    // somewhere without telling (a browser quirk away from the blur event), let go of the keys.
    if (chat.isOpen && document.activeElement !== chat.input) chat.cancel();
  }

  function onEvent(evt, view) {
    // Replayed events are not for the HUD; one that arrives anyway must not announce a goal twice.
    if (!evt || evt.replay === true) return;
    const now = clock(view);
    const ctx = { init, players: view?.players ?? lastPlayers, shot, time: num(view?.time, 0) };
    const entry = run('feed', feedForEvent, evt, ctx);
    shot = run('feed', nextShot, shot, evt, ctx) ?? null;
    if (entry) run('feed', feed.push, entry, now);
    if (resultsUp) return;
    if (evt.type === EVT.GOAL) run('stage', stage.goal, evt, view, now);
    else if (evt.type === EVT.OVERTIME) run('stage', stage.overtime, now);
  }

  function onChat(chatDto) {
    const entry = run('feed', feedForChat, chatDto, room);
    if (!entry) return;
    run('feed', feed.push, entry, nowSeconds());
    if (entry.kind === 'chat') actions.uiSound('chat');
  }

  function onEmote(emote) {
    const entry = run('feed', feedForEmote, emote, room, init);
    if (entry) run('feed', feed.push, entry, nowSeconds());
  }

  function showResults(result) {
    if (!result) return;
    // The same result twice (the match end, then a rejoin that carries it again) is shown once:
    // the screen stays as it is rather than playing its entrance a second time.
    let key = '';
    try {
      key = JSON.stringify(result);
    } catch {
      key = '';
    }
    if (resultsUp && key !== '' && key === resultsKey) return;
    resultsKey = key;

    const model = run('results', resultsModel, result, init, room, memberId);
    if (!model) return;
    run('results', results.show, model);
    if (!results.isOpen) return;
    resultsUp = true;
    root.classList.add('is-results');
    hideRoster();
    run('stage', stage.reset);
    applyRoom();
  }

  function hideResults() {
    if (!resultsUp && !results.isOpen) return;
    // Focus left on a results button would vanish with it; hand it back to the page first.
    if (results.el.contains(document.activeElement)) releaseFocus(root);
    results.hide();
    resultsUp = false;
    resultsKey = '';
    root.classList.remove('is-results');
  }

  function capturesInput() {
    return menu.isOpen || controls.isOpen || chat.isOpen || resultsUp;
  }

  return { setMatch, onRoomState, update, onEvent, onChat, onEmote, showResults, hideResults, capturesInput };
}
