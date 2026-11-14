// Top-left event feed: goals, saves, tackles worth a mention, chat lines, system announcements
// and emotes. At most FEED_MAX entries; each fades by itself after a few seconds.

import { el, add, clear, later, restart } from './dom.js';
import { FEED_MAX, FeedQueue, feedTtl, mergeEmote } from './format.js';

/** Keep in step with the .feed-item transition in match.css. */
const LEAVE_MS = 240;

/** @returns {{node: HTMLElement, text: HTMLElement}} the row and the element holding its text */
function renderEntry(entry) {
  const node = el('li', `feed-item kind-${entry.kind}`);
  node.setAttribute('data-team', String(entry.team === 0 || entry.team === 1 ? entry.team : -1));
  let text;
  if (entry.kind === 'chat' || entry.kind === 'emote') {
    const name = el('span', 'feed-name', entry.name);
    // format.js only lets "#rrggbb" through, so the value is safe as a style.
    if (entry.color) name.style.color = entry.color;
    text = el('span', entry.kind === 'emote' ? 'feed-glyph' : 'feed-text', entry.text);
    add(node, name, text);
  } else {
    if (entry.tag) node.appendChild(el('span', 'feed-tag display', entry.tag));
    text = el('span', 'feed-text', entry.text);
    node.appendChild(text);
  }
  return { node, text };
}

export function createFeed() {
  const root = el('ol', 'feed');
  root.setAttribute('aria-label', 'Match events and chat');
  const queue = new FeedQueue(FEED_MAX);
  /** @type {Map<number, {node: HTMLElement, text: HTMLElement}>} queue item id -> its row */
  const rows = new Map();

  function leave(item) {
    const row = rows.get(item.id);
    if (!row) return;
    rows.delete(item.id);
    const node = row.node;
    // The row folds away so the ones below slide up instead of jumping: pin its height first,
    // a transition needs a number to start from.
    node.style.height = `${node.offsetHeight}px`;
    void node.offsetWidth;
    node.classList.add('is-leaving');
    later(() => node.remove(), LEAVE_MS);
  }

  function update(now) {
    const expired = queue.expire(now);
    for (let i = 0; i < expired.length; i++) leave(expired[i]);
  }

  /** @param {object} entry  result of feedForEvent / feedForChat / feedForEmote */
  function push(entry, now) {
    if (!entry) return;
    // Also here, not only per frame: lines keep arriving while nothing is being drawn (hidden tab).
    update(now);

    // Another emote from whoever sent the newest line joins that line.
    const last = queue.last;
    const merged = last ? mergeEmote(last.entry, entry) : null;
    const lastRow = merged ? rows.get(last.id) : null;
    if (merged && lastRow) {
      queue.renew(last, merged, now, feedTtl(merged));
      lastRow.text.textContent = merged.text;
      restart(lastRow.text, 'is-bump');
      return;
    }

    const { item, dropped } = queue.push(entry, now, feedTtl(entry));
    for (const old of dropped) leave(old);
    const row = renderEntry(entry);
    rows.set(item.id, row);
    root.appendChild(row.node);
  }

  function reset() {
    queue.clear();
    rows.clear();
    clear(root);
  }

  return { el: root, push, update, reset };
}
