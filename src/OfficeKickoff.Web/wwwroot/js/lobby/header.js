// The bar across the top of the lobby: the room code and the invite link, whether this is a
// practice room, the connection and the local ping, the profile button and the way out.

import { copyText } from '../shared/util.js';
import { h, icon, setAttr, setHidden, setText, svg, toast } from './dom.js';
import { connectionLabel, formatPing, inviteUrl, pingTone } from './logic.js';

/** How long a button keeps saying "Copied" after a successful copy. */
const FLASH_MS = 1600;

/** The ball of the wordmark (same drawing as the favicon and the Home page). */
function brandBall(size) {
  return svg(
    'svg',
    { class: 'brand-ball', width: size, height: size, viewBox: '11 11 42 42', 'aria-hidden': 'true', focusable: 'false' },
    svg('circle', { cx: 32, cy: 32, r: 19, fill: '#f4f7ff' }),
    svg('path', { d: 'M32 21l9.5 6.9-3.6 11.2H26.1l-3.6-11.2z', fill: '#0d1426' }),
    svg('path', {
      d: 'M32 13v8M50 27l-8.5.9M43.5 47.5l-5.6-8.4M20.5 47.5l5.6-8.4M14 27l8.5.9',
      stroke: '#0d1426',
      'stroke-width': 2.6,
      'stroke-linecap': 'round',
      fill: 'none',
    }),
    svg('circle', { cx: 32, cy: 32, r: 19, fill: 'none', stroke: '#b6ff3c', 'stroke-width': 3 }),
  );
}

/**
 * @param {{code: string, origin: string, profileButton: HTMLElement, actions: {leave: () => void}}} opts
 *        `origin` is the page origin ("http://server"), used to build the absolute invite link
 */
export function createHeader({ code, origin, profileButton, actions }) {
  const link = inviteUrl(origin, code);
  let codeTimer = 0;
  let inviteTimer = 0;

  // ---- room code --------------------------------------------------------------------------
  const codeIcon = h('span', { class: 'room-code-icon', 'aria-hidden': 'true' }, icon('copy', 16));
  const codeBtn = h(
    'button',
    {
      class: 'room-code',
      type: 'button',
      title: 'Copy the room code',
      'aria-label': `Room code ${code.split('').join(' ')}. Copy it`,
      onClick: async () => {
        if (!(await copyText(code))) {
          toast(`Copying is blocked here. The room code is ${code}.`, { kind: 'warn' });
          return;
        }
        codeIcon.replaceChildren(icon('check', 16));
        codeBtn.classList.add('is-copied');
        toast('Room code copied', { kind: 'ok' });
        clearTimeout(codeTimer);
        codeTimer = setTimeout(() => {
          codeIcon.replaceChildren(icon('copy', 16));
          codeBtn.classList.remove('is-copied');
        }, FLASH_MS);
      },
    },
    h('span', { class: 'room-code-text display', text: code }),
    codeIcon,
  );

  // ---- invite link ------------------------------------------------------------------------
  const inviteLabel = h('span', { text: 'Copy invite link' });
  const inviteBtn = h('button', { class: 'btn btn-sm invite-btn', type: 'button', title: link }, icon('link', 15), inviteLabel);

  // Shown only when the browser refuses to copy: the link, selected, ready for Ctrl+C.
  const manualInput = h('input', {
    class: 'input invite-url',
    type: 'text',
    readOnly: true,
    value: link,
    'aria-label': 'Invite link',
    spellcheck: 'false',
  });
  const manual = h(
    'div',
    { class: 'invite-manual', role: 'group', 'aria-label': 'Invite link to copy by hand', hidden: true },
    h('p', { class: 'hint', text: 'Copying is blocked here. The link is selected: press Ctrl+C.' }),
    manualInput,
  );

  function hideManual(returnFocus) {
    if (manual.hidden) return;
    const hadFocus = manual.contains(document.activeElement);
    manual.hidden = true;
    inviteBtn.setAttribute('aria-expanded', 'false');
    if (returnFocus || hadFocus) inviteBtn.focus({ preventScroll: true });
  }

  function showManual() {
    manual.hidden = false;
    inviteBtn.setAttribute('aria-expanded', 'true');
    manualInput.focus({ preventScroll: true });
    manualInput.select();
  }

  manualInput.addEventListener('focus', () => manualInput.select());
  manual.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      hideManual(true);
    }
  });
  manual.addEventListener('focusout', (e) => {
    const to = e.relatedTarget;
    if (to instanceof Node && !manual.contains(to) && to !== inviteBtn) hideManual(false);
  });

  inviteBtn.addEventListener('click', async () => {
    if (!manual.hidden) {
      hideManual(true);
      return;
    }
    if (!(await copyText(link))) {
      showManual();
      return;
    }
    setText(inviteLabel, 'Link copied');
    inviteBtn.classList.add('is-copied');
    toast('Invite link copied. Send it to a colleague.', { kind: 'ok' });
    clearTimeout(inviteTimer);
    inviteTimer = setTimeout(() => {
      setText(inviteLabel, 'Copy invite link');
      inviteBtn.classList.remove('is-copied');
    }, FLASH_MS);
  });

  // ---- connection -------------------------------------------------------------------------
  // Only the label is a live region: the ping changes every two seconds and must not be read out.
  const connLabel = h('span', { class: 'conn-label', role: 'status' });
  const connPing = h('span', { class: 'conn-ping tnum' });
  const conn = h('div', { class: 'conn' }, h('i', { class: 'conn-dot', 'aria-hidden': 'true' }), connLabel, connPing);

  const practice = h('span', { class: 'tag tag-practice', text: 'Practice', title: 'Practice room: no clock, no score limit', hidden: true });

  const leaveLabel = h('span', { text: 'Leave' });
  const leaveBtn = h(
    'button',
    {
      class: 'btn btn-sm btn-ghost btn-leave',
      type: 'button',
      title: 'Leave the room and go back to the start page',
      onClick: () => {
        setText(leaveLabel, 'Leaving');
        leaveBtn.classList.add('is-busy');
        actions.leave();
      },
    },
    icon('exit', 15),
    leaveLabel,
  );

  const el = h(
    'header',
    { class: 'topbar' },
    h('div', { class: 'brand' }, brandBall(26), h('span', { class: 'brand-name display', text: 'Office Kickoff' })),
    h('div', { class: 'room-id' }, h('span', { class: 'label', text: 'Room' }), codeBtn),
    h('div', { class: 'invite' }, inviteBtn, manual),
    practice,
    h('div', { class: 'topbar-space' }),
    conn,
    profileButton,
    leaveBtn,
  );

  /**
   * @param {'connected'|'reconnecting'|'disconnected'} status
   * @param {number} ping  round-trip time in ms, -1 = not measured yet
   */
  function setConnection(status, ping) {
    const online = status === 'connected';
    const className = `conn is-${online ? 'connected' : status === 'reconnecting' ? 'reconnecting' : 'disconnected'}`;
    if (conn.className !== className) conn.className = className;
    setText(connLabel, connectionLabel(status));
    setText(connPing, online ? formatPing(ping) : '');
    const pingClass = `conn-ping tnum ping-${online ? pingTone(ping) : 'none'}`;
    if (connPing.className !== pingClass) connPing.className = pingClass;
    setAttr(conn, 'title', online ? 'Your connection to the room, and your round trip to the server' : 'The page is trying to get back to the room');
  }

  return {
    el,
    setConnection,
    /** @param {object} ctx  the lobby's render context (see lobby.js) */
    update(ctx) {
      setHidden(practice, ctx.room.practice !== true);
      setConnection(ctx.status, ctx.ping);
    },
  };
}
