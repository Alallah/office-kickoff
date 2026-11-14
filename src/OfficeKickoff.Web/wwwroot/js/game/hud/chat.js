// Bottom-left corner: the emote bar, and the chat box that Enter opens above it.
//
// The chat is one line. Enter sends, Escape cancels, and on an empty line the digits 1-8 send a
// quick-chat line at once. The box is open exactly as long as its input has focus, which is also
// how long the HUD captures the keyboard; the key routing itself lives in hud.js / logic.js.

import { EMOTES, LIMITS, QUICK_CHAT } from '../../shared/protocol.js';
import { el, add, button, keycap, restart } from './dom.js';
import { cleanText } from './format.js';

/** The remaining-characters counter appears once the line is this close to the limit. */
const COUNTER_FROM = LIMITS.chat - 20;

export function createChat(actions) {
  const root = el('div', 'talk');
  let open = false;

  // ---- chat box -----------------------------------------------------------------------------
  const box = el('div', 'chat-box');
  box.hidden = true;

  const quick = el('div', 'chat-quick');
  quick.setAttribute('role', 'group');
  quick.setAttribute('aria-label', 'Quick chat');
  for (let i = 0; i < QUICK_CHAT.length; i++) {
    const chip = button('chat-chip', () => sendQuick(i));
    add(chip, keycap(String(i + 1)), el('span', 'chat-chip-text', QUICK_CHAT[i]));
    quick.appendChild(chip);
  }

  const input = el('input', 'chat-input');
  input.type = 'text';
  input.maxLength = LIMITS.chat;
  input.placeholder = 'Say something';
  input.autocomplete = 'off';
  input.spellcheck = false;
  input.setAttribute('aria-label', 'Chat message');
  input.setAttribute('enterkeyhint', 'send');

  const counter = el('span', 'chat-count tnum');
  counter.hidden = true;
  const keys = add(
    el('span', 'chat-keys'),
    keycap('Enter'), el('span', 'chat-key-label', 'send'),
    keycap('Esc'), el('span', 'chat-key-label', 'cancel'),
  );
  add(box, quick, add(el('div', 'chat-row'), input, counter, keys));

  // A press anywhere else in the box must not take the focus from the line being typed.
  box.addEventListener('mousedown', (e) => {
    if (e.target !== input) e.preventDefault();
  });

  input.addEventListener('input', () => {
    const used = input.value.length;
    counter.hidden = used < COUNTER_FROM;
    if (!counter.hidden) counter.textContent = String(LIMITS.chat - used);
  });

  // Focus gone (a click on the pitch, another window): the line is dropped, play has the keys back.
  input.addEventListener('blur', () => close(true));

  // ---- hint and emotes ----------------------------------------------------------------------
  const hint = add(el('div', 'chat-hint'), keycap('Enter'), el('span', 'display', 'Chat'));

  const bar = el('div', 'emotes');
  bar.setAttribute('role', 'group');
  bar.setAttribute('aria-label', 'Emotes');
  const emoteButtons = [];
  for (let i = 0; i < EMOTES.length; i++) {
    const node = button('emote', () => emote(i));
    node.setAttribute('aria-label', `Emote ${EMOTES[i]}, key ${i + 1}`);
    add(node, el('span', 'emote-glyph', EMOTES[i]), el('span', 'emote-key', String(i + 1)));
    emoteButtons.push(node);
    bar.appendChild(node);
  }

  add(root, box, hint, bar);

  function openBox() {
    if (open) return;
    open = true;
    input.value = '';
    counter.hidden = true;
    box.hidden = false;
    hint.hidden = true;
    input.focus({ preventScroll: true });
    actions.uiSound('open');
  }

  /** @param {boolean} cancelled  the line was dropped rather than sent */
  function close(cancelled) {
    if (!open) return;
    open = false;
    input.value = '';
    box.hidden = true;
    hint.hidden = false;
    if (document.activeElement === input) input.blur();
    if (cancelled) actions.uiSound('close');
  }

  function send() {
    const text = cleanText(input.value, LIMITS.chat);
    close(text === '');
    if (text) actions.chat(text);
  }

  function sendQuick(index) {
    const line = QUICK_CHAT[index];
    if (typeof line !== 'string') return;
    close(false);
    actions.chat(line);
  }

  function emote(index) {
    if (!(index >= 0 && index < emoteButtons.length)) return;
    actions.emote(index);
    actions.uiSound('emote');
    restart(emoteButtons[index], 'is-sent');
  }

  return {
    el: root,
    input,
    get isOpen() {
      return open;
    },
    get isEmpty() {
      return input.value.length === 0;
    },
    open: openBox,
    /** Drops the line being typed. */
    cancel() {
      close(true);
    },
    send,
    quick: sendQuick,
    emote,
  };
}
