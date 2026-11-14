// The pause menu (Escape): sound, auto-switch, the control reference, the room code, and the ways
// out. Opening it does not pause anything - the match runs on behind it.
//
// The menu holds no state of its own: hud.js owns the preferences and the room, and pushes them
// in through sync() and setRoom().

import { ROUTES } from '../../shared/protocol.js';
import { copyText } from '../../shared/util.js';
import { el, add, button, confirming, icon, keycap, later, menuButton, setButtonLabel } from './dom.js';
import { controlList } from './controls.js';
import { sliderToVolume, volumeToSlider } from './logic.js';

/** How long a "copied" label stays up. */
const COPIED_MS = 1500;

/** The address a colleague opens to join this room: the lobby sends them on to the match. */
function inviteLink(code) {
  const path = ROUTES.lobby(code);
  try {
    return new URL(path, window.location.href).href;
  } catch {
    return path;
  }
}

function section(title, ...children) {
  return add(el('section', 'menu-sec'), el('h3', 'sec-title display', title), ...children);
}

/**
 * @param {object} actions  guarded HudActions
 * @param {{close: () => void, toggleMute: () => void, setVolume: (v: number) => void,
 *          setAutoSwitch: (on: boolean) => void, backToLobby: () => void, leave: () => void}} hooks
 */
export function createMenu(actions, hooks) {
  const root = el('div', 'modal menu');
  root.hidden = true;

  const panel = el('div', 'panel menu-panel');
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-modal', 'true');
  panel.setAttribute('aria-label', 'Game menu');

  const closer = menuButton(actions, 'icon-btn', 'Close', 'close', hooks.close);
  const head = add(
    el('header', 'panel-head'),
    el('h2', 'panel-title display', 'Menu'),
    el('span', 'panel-note', 'The match keeps running'),
    closer,
  );

  // ---- sound --------------------------------------------------------------------------------
  const mute = button('btn btn-small mute-btn', hooks.toggleMute);
  mute.setAttribute('aria-pressed', 'false');
  add(mute, icon('sound', 'when-on'), icon('muted', 'when-off'), el('span', 'btn-label', 'Mute'), keycap('M'));

  const slider = el('input', 'slider');
  slider.type = 'range';
  slider.min = '0';
  slider.max = '100';
  slider.step = '1';
  slider.setAttribute('aria-label', 'Volume');
  const sliderValue = el('span', 'slider-value tnum');

  // A slider keeps the focus it gets from a mouse press; give it back once the drag is over, or
  // the arrow keys would go on changing the volume.
  let byPointer = false;
  slider.addEventListener('pointerdown', () => {
    byPointer = true;
  });
  slider.addEventListener('input', () => hooks.setVolume(sliderToVolume(slider.value)));
  slider.addEventListener('change', () => {
    actions.uiSound('click');
    if (byPointer) {
      byPointer = false;
      slider.blur();
    }
  });

  const sound = section('Sound', add(el('div', 'menu-row'), mute, slider, sliderValue));

  // ---- play ---------------------------------------------------------------------------------
  let autoSwitch = true;
  const auto = button('switch', () => {
    actions.uiSound('click');
    hooks.setAutoSwitch(!autoSwitch);
  });
  auto.setAttribute('role', 'switch');
  add(
    auto,
    add(el('span', 'switch-track'), el('i', 'switch-thumb')),
    add(
      el('span', 'switch-words'),
      el('b', 'switch-title', 'Auto-switch'),
      el('span', 'switch-detail', 'When defending, hand me the team-mate nearest the ball'),
    ),
  );
  const play = section('Play', auto);

  // ---- room ---------------------------------------------------------------------------------
  let code = '';
  const codeText = el('span', 'room-code display');

  function copier(label, iconName, text) {
    let timer = 0;
    const node = menuButton(actions, 'btn btn-small', label, iconName, () => {
      if (!code) return;
      copyText(text()).then((ok) => {
        clearTimeout(timer);
        if (!ok) actions.uiSound('error');
        setButtonLabel(node, ok ? 'Copied' : 'Could not copy');
        node.classList.toggle('is-done', ok);
        timer = later(() => {
          setButtonLabel(node, label);
          node.classList.remove('is-done');
        }, COPIED_MS);
      });
    });
    return node;
  }

  const copyCode = copier('Copy code', 'copy', () => code);
  const copyLink = copier('Copy invite link', 'link', () => inviteLink(code));
  const roomRow = add(el('div', 'menu-row'), codeText, copyCode, copyLink);
  const roomSec = section('Room', roomRow);

  // ---- ways out -----------------------------------------------------------------------------
  const resume = menuButton(actions, 'btn btn-primary', 'Resume', 'play', hooks.close);
  resume.appendChild(keycap('Esc'));
  const lobby = confirming(actions, 'btn', 'Back to lobby', 'End it for everyone?', 'lobby', hooks.backToLobby);
  lobby.node.hidden = true;
  const leave = confirming(actions, 'btn btn-danger', 'Leave match', 'Leave - sure?', 'exit', hooks.leave);
  const ways = add(el('div', 'menu-actions'), resume, lobby.node, leave.node);

  const side = add(el('aside', 'menu-side'), el('h3', 'sec-title display', 'Controls'), controlList());

  add(panel, head, add(el('div', 'menu-grid'), add(el('div', 'menu-main'), sound, play, roomSec, ways), side));
  root.appendChild(panel);

  // A click on the dimmed pitch around the panel closes the menu.
  root.addEventListener('click', (e) => {
    if (e.target === root) hooks.close();
  });

  function disarm() {
    lobby.disarm();
    leave.disarm();
  }

  return {
    el: root,
    get isOpen() {
      return !root.hidden;
    },
    open() {
      root.hidden = false;
    },
    close() {
      disarm();
      root.hidden = true;
    },

    /** @param {{volume: number, muted: boolean, autoSwitch: boolean}} prefs */
    sync(prefs) {
      const position = String(volumeToSlider(prefs.volume));
      if (slider.value !== position) slider.value = position;
      sliderValue.textContent = `${position}%`;
      mute.setAttribute('aria-pressed', prefs.muted ? 'true' : 'false');
      setButtonLabel(mute, prefs.muted ? 'Unmute' : 'Mute');
      panel.classList.toggle('is-muted', prefs.muted);
      autoSwitch = prefs.autoSwitch;
      auto.setAttribute('aria-checked', autoSwitch ? 'true' : 'false');
    },

    /**
     * @param {string} roomCode  "" when it is not known (the row is hidden)
     * @param {boolean} isHost   the local member is the host right now
     */
    setRoom(roomCode, isHost) {
      code = roomCode;
      codeText.textContent = roomCode;
      roomSec.hidden = roomCode === '';
      if (lobby.node.hidden === isHost) {
        lobby.disarm();
        lobby.node.hidden = !isHost;
      }
    },
  };
}
