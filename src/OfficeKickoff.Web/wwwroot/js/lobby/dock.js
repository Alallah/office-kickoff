// The strip under the two teams: who is watching from the stands, and the way into the match -
// Ready for seated players, Start for the host, "Waiting for <host>" for everyone else.

import { safeColor } from '../shared/crests.js';
import { h, icon, setAttr, setClass, setHidden, setText } from './dom.js';
import { createPendingValue, seatModel, startModel } from './logic.js';

/** How long the Start button says "Starting" before it offers itself again. */
const START_FEEDBACK_MS = 2500;

/**
 * @param {{actions: {setTeam: (team: number) => boolean, setReady: (ready: boolean) => boolean,
 *          startMatch: () => boolean}}} opts  each action returns false when it could not be sent
 */
export function createDock({ actions }) {
  let last = null;
  let shownSpectators = '';
  let ready = false;
  let startTimer = 0;
  const pendingReady = createPendingValue();

  // ---- spectators -------------------------------------------------------------------------
  const specLabel = h('span', { class: 'label', text: 'Spectators' });
  const specList = h('ul', { class: 'spec-list', 'aria-label': 'Spectators' });
  const specEmpty = h('span', { class: 'spec-empty', text: 'Nobody in the stands' });
  const watchBtn = h(
    'button',
    { class: 'btn btn-sm btn-ghost', type: 'button', title: 'Leave your seat and watch the match', onClick: () => actions.setTeam(-1) },
    icon('eye', 15),
    h('span', { text: 'Watch' }),
  );
  const spectators = h('div', { class: 'spectators' }, specLabel, specList, specEmpty, watchBtn);

  function paintSpectators(ctx) {
    const list = ctx.view.spectators;
    const signature = JSON.stringify(list.map((m) => [m.id, m.name, m.color, m.connected, m.id === ctx.room.hostId, m.id === ctx.memberId]));
    if (signature === shownSpectators) return;
    shownSpectators = signature;
    specList.replaceChildren(
      ...list.map((member) => {
        const m = seatModel(member, ctx.memberId, ctx.room.hostId);
        const dot = h('i', { class: 'spec-dot', 'aria-hidden': 'true' });
        dot.style.setProperty('--c', safeColor(member.color, '#a9b6d6'));
        return h(
          'li',
          { class: `spec${m.isMe ? ' is-me' : ''}${m.connected ? '' : ' is-away'}`, title: m.connected ? m.name : `${m.name} (disconnected)` },
          dot,
          h('span', { class: 'spec-name', text: m.name }),
          m.isHost ? h('span', { class: 'seat-crown', title: 'Host' }, icon('crown', 13), h('span', { class: 'sr-only', text: 'Host' })) : null,
          m.isMe ? h('span', { class: 'tag tag-you', text: 'You' }) : null,
        );
      }),
    );
    // The row can be too narrow to show everyone; the count never is.
    setText(specLabel, list.length > 1 ? `Spectators (${list.length})` : 'Spectators');
    setHidden(specList, list.length === 0);
    setHidden(specEmpty, list.length > 0);
  }

  // ---- ready / start ----------------------------------------------------------------------
  const headline = h('p', { class: 'start-headline' });
  const detail = h('p', { class: 'start-detail' });
  const readyLabel = h('span', { text: 'Ready' });
  const readyBtn = h(
    'button',
    {
      class: 'btn btn-ready',
      type: 'button',
      'aria-pressed': 'false',
      hidden: true,
      onClick: () => {
        const next = !ready;
        if (!actions.setReady(next)) return;
        pendingReady.request(next, performance.now());
        if (last) paintStart(last);
      },
    },
    h('span', { class: 'ready-box', 'aria-hidden': 'true' }, icon('check', 16)),
    readyLabel,
  );
  const startLabel = h('span', { text: 'Start match' });
  const startBtn = h(
    'button',
    {
      class: 'btn btn-start display',
      type: 'button',
      hidden: true,
      onClick: () => {
        if (!actions.startMatch()) return;
        // Never disabled: a second press is harmless, and a start the server lost can be repeated.
        startBtn.classList.add('is-busy');
        setText(startLabel, 'Starting');
        clearTimeout(startTimer);
        startTimer = setTimeout(() => {
          startBtn.classList.remove('is-busy');
          setText(startLabel, 'Start match');
        }, START_FEEDBACK_MS);
      },
    },
    startLabel,
    icon('bolt', 20),
  );

  function paintStart(ctx) {
    const seated = ctx.view.myTeam >= 0;
    const model = startModel(ctx.room, ctx.view, seated ? pendingReady.resolve(ctx.view.me?.ready === true, performance.now()) : null);
    ready = model.ready;
    setHidden(readyBtn, !model.showReady);
    setAttr(readyBtn, 'aria-pressed', ready ? 'true' : 'false');
    setAttr(readyBtn, 'title', ready ? 'You are ready - press to take it back' : 'Tell everyone you are set');
    setText(readyLabel, ready ? 'Ready!' : 'Ready');
    // Next to the host's Start button, Ready is the smaller of the two.
    setClass(readyBtn, 'is-compact', model.showStart);
    setHidden(startBtn, !model.showStart);
    setClass(startBtn, 'is-go', model.showStart && model.allReady);
    setText(headline, model.headline);
    setHidden(headline, model.headline === '');
    setText(detail, model.detail);
    // The note is clamped to two lines; the whole of it stays reachable.
    setAttr(detail, 'title', model.detail);
  }

  const el = h(
    'section',
    { class: 'dock panel', 'aria-label': 'Spectators and kick-off' },
    h('div', { class: 'dock-info' }, spectators, h('div', { class: 'start-text', role: 'status' }, headline, detail)),
    h('div', { class: 'dock-actions' }, readyBtn, startBtn),
  );

  return {
    el,
    /** @param {object} ctx  the lobby's render context (see lobby.js) */
    update(ctx) {
      last = ctx;
      if (ctx.view.myTeam < 0) pendingReady.clear();
      paintSpectators(ctx);
      setHidden(watchBtn, ctx.view.myTeam < 0);
      paintStart(ctx);
    },
    /** The control a keyboard user most likely wants next: Start for the host, else Ready. */
    focusPrimary() {
      const target = !startBtn.hidden ? startBtn : !readyBtn.hidden ? readyBtn : null;
      if (target) target.focus({ preventScroll: true });
      return target !== null;
    },
  };
}
