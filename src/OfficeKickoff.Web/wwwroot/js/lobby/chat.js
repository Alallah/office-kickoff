// The lobby chat: the room's ChatDto stream, a text box and the quick lines.
// System announcements (joins, leaves, disconnects, host changes) are shown exactly as the server
// words them; nothing here is derived from the room state.

import { LIMITS, QUICK_CHAT } from '../shared/protocol.js';
import { h, icon, setHidden, setText } from './dom.js';
import { cleanChat, createRateLimiter, formatWait, isNearBottom } from './logic.js';
import { inkOnDark } from './team-model.js';

/** Lines kept in the log; older ones are dropped. */
const MAX_LINES = 200;

// The hub rate-limits chat and drops what is over the limit without telling the sender
// (HubContracts: "rate limited"). This page limits itself a little sooner - at most RATE_MAX lines
// in RATE_WINDOW_MS - so that a line is refused here, with an explanation, instead of vanishing.
const RATE_MAX = 5;
const RATE_WINDOW_MS = 10000;

/**
 * @param {{catalog: object, actions: {chat: (text: string) => boolean}}} opts
 *        `actions.chat` returns false when the line could not be sent (not connected)
 */
export function createChat({ catalog, actions }) {
  const lines = Array.isArray(catalog.quickChat) && catalog.quickChat.length > 0 ? catalog.quickChat : QUICK_CHAT;
  const limiter = createRateLimiter(RATE_MAX, RATE_WINDOW_MS);
  let members = new Map();
  let memberId = 0;
  let kits = ['', ''];
  let hintTimer = 0;

  const empty = h('p', { class: 'chat-empty', text: 'Nothing said yet. Break the ice!' });
  const log = h('div', { class: 'chat-log', role: 'log', 'aria-label': 'Room chat', tabindex: '0' }, empty);
  const more = h(
    'button',
    {
      class: 'chat-more',
      type: 'button',
      hidden: true,
      onClick: () => {
        log.scrollTop = log.scrollHeight;
        setHidden(more, true);
      },
    },
    h('span', { text: 'New messages' }),
    icon('chevron', 14),
  );
  log.addEventListener('scroll', () => {
    if (!more.hidden && isNearBottom(log.scrollTop, log.clientHeight, log.scrollHeight)) setHidden(more, true);
  });

  const hint = h('p', { class: 'chat-hint', role: 'status', hidden: true });
  function say(text) {
    setText(hint, text);
    setHidden(hint, false);
    clearTimeout(hintTimer);
    hintTimer = setTimeout(() => setHidden(hint, true), 3200);
  }

  /** @returns {boolean} true when the line went out */
  function send(text) {
    const line = cleanChat(text);
    if (line === '') return false;
    const now = performance.now();
    if (!limiter.tryTake(now)) {
      say(`Easy now - you can chat again in ${formatWait(limiter.waitMs(now))}.`);
      return false;
    }
    if (!actions.chat(line)) {
      limiter.refund();
      say('Not connected right now - your message was not sent.');
      return false;
    }
    return true;
  }

  const input = h('input', {
    class: 'input chat-input',
    type: 'text',
    maxlength: LIMITS.chat,
    placeholder: 'Say something to the room',
    'aria-label': 'Chat message',
    autocomplete: 'off',
    enterkeyhint: 'send',
  });
  const form = h(
    'form',
    {
      class: 'chat-form',
      onSubmit: (e) => {
        e.preventDefault();
        if (send(input.value)) input.value = '';
      },
    },
    input,
    h('button', { class: 'btn btn-icon', type: 'submit', 'aria-label': 'Send message', title: 'Send' }, icon('send', 16)),
  );

  const quick = h(
    'div',
    { class: 'chat-quick', role: 'group', 'aria-label': 'Quick lines' },
    lines.map((line) => h('button', { class: 'chip chip-quick', type: 'button', text: line, onClick: () => send(line) })),
  );
  // The strip is one line high and scrolls sideways; let an ordinary mouse wheel do that.
  quick.addEventListener(
    'wheel',
    (e) => {
      if (e.deltaY === 0 || quick.scrollWidth <= quick.clientWidth) return;
      quick.scrollLeft += e.deltaY;
      e.preventDefault();
    },
    { passive: false },
  );

  const el = h(
    'section',
    { class: 'chat panel', 'aria-labelledby': 'chat-title' },
    h('header', { class: 'panel-head' }, h('h2', { class: 'panel-title display', id: 'chat-title', text: 'Chat' })),
    h('div', { class: 'chat-body' }, log, more),
    hint,
    quick,
    form,
  );

  // A name is written in its owner's accent colour; someone who has already left is written in
  // the colour of the team they spoke for.
  function colorOf(chat) {
    const member = members.get(chat.memberId);
    if (member) return inkOnDark(member.color);
    return chat.team === 0 || chat.team === 1 ? inkOnDark(kits[chat.team]) : '';
  }

  return {
    el,
    /** @param {object} chat  ChatDto */
    add(chat) {
      if (!chat || typeof chat.text !== 'string' || chat.text === '') return;
      const pinned = isNearBottom(log.scrollTop, log.clientHeight, log.scrollHeight);
      if (empty.isConnected) empty.remove();

      let line;
      if (chat.system) {
        line = h('p', { class: 'chat-line chat-system' }, h('span', { class: 'chat-text', text: chat.text }));
      } else {
        const who = h('span', { class: 'chat-name', text: chat.name || 'Player' });
        const color = colorOf(chat);
        if (color) who.style.color = color;
        line = h(
          'p',
          { class: `chat-line${chat.memberId === memberId ? ' is-me' : ''}` },
          who,
          h('span', { class: 'chat-text', text: chat.text }),
        );
      }
      log.appendChild(line);
      while (log.children.length > MAX_LINES) log.firstElementChild.remove();

      if (pinned) log.scrollTop = log.scrollHeight;
      else setHidden(more, false);
    },
    /** @param {object} ctx  the lobby's render context (see lobby.js) */
    update(ctx) {
      members = ctx.view.byId;
      memberId = ctx.memberId;
      kits = ctx.kits;
    },
    focus() {
      input.focus({ preventScroll: true });
    },
    /** Jumps to the newest line (the log was hidden, or the page was laid out anew). */
    scrollToEnd() {
      log.scrollTop = log.scrollHeight;
      setHidden(more, true);
    },
  };
}
