// Top-right corner: the ping readout, a "muted" tag and a reminder of the menu key. Also owns the
// connection notice, which the HUD hangs under the scoreboard so it cannot be missed.

import { el, add, Shown, button, icon, keycap, restart } from './dom.js';
import { pingLevel, pingText, pingValue } from './format.js';

const NOTICES = {
  reconnecting: { title: 'Reconnecting', detail: 'Your seat is being kept' },
  disconnected: { title: 'Connection lost', detail: 'Reload the page to get back in' },
};

export function createStatus(actions) {
  const root = el('div', 'net');

  const mute = el('div', 'net-chip net-mute');
  mute.hidden = true;
  add(mute, icon('muted'), el('span', 'display', 'Muted'));

  const ping = el('div', 'net-chip net-ping');
  ping.title = 'Round trip to the server';
  ping.setAttribute('data-level', 'unknown');
  const bars = add(el('span', 'net-bars'), el('i'), el('i'), el('i'));
  bars.setAttribute('aria-hidden', 'true');
  const value = el('span', 'net-ms tnum', pingText(-1));
  add(ping, bars, value);

  const hint = add(el('div', 'net-chip net-hint'), keycap('Esc'), el('span', 'display', 'Menu'));
  add(root, mute, hint, ping);

  const notice = el('div', 'conn');
  notice.hidden = true;
  notice.setAttribute('role', 'status');
  const dot = el('span', 'conn-dot');
  const words = el('div', 'conn-words');
  const title = el('span', 'conn-title display');
  const detail = el('span', 'conn-detail');
  add(words, title, detail);
  const reload = button('btn btn-small conn-reload', () => {
    actions.uiSound('click');
    window.location.reload();
  });
  reload.textContent = 'Reload';
  reload.hidden = true;
  add(notice, dot, words, reload);

  const shownPing = new Shown(ping);
  const shownValue = new Shown(value);
  const shownNotice = new Shown(notice);
  const shownTitle = new Shown(title);
  const shownDetail = new Shown(detail);
  const shownReload = new Shown(reload);
  // What the readout shows, so an unchanged ping costs one comparison a frame.
  let shownMs = -1;

  function update(view) {
    const ms = pingValue(view.ping);
    if (ms !== shownMs) {
      shownMs = ms;
      shownPing.attr('data-level', pingLevel(ms));
      shownValue.text(pingText(ms));
    }

    const info = NOTICES[view.connection] ?? null;
    shownNotice.hidden(!info);
    if (info) {
      shownNotice.flag('is-lost', view.connection === 'disconnected');
      shownTitle.text(info.title);
      shownDetail.text(info.detail);
      shownReload.hidden(view.connection !== 'disconnected');
    }
  }

  function setMuted(muted, announce) {
    mute.hidden = !muted;
    if (muted && announce) restart(mute, 'is-new');
  }

  return { el: root, noticeEl: notice, update, setMuted };
}
