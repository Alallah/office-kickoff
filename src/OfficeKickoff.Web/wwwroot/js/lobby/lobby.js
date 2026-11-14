// The lobby page. Joins the room, builds the page once, then keeps it in step with every
// RoomState by PATCHING it (see dom.js): nothing is re-created, so focus, scroll positions and
// half-typed text survive the steady stream of room updates.
//
// Every component gets the same render context on each update:
//   room      latest RoomStateDto
//   view      deriveLobby(room, memberId): me, host, isHost, myTeam, seats, spectators, canEdit, ...
//   memberId  the local member's id
//   status    'connected' | 'reconnecting' | 'disconnected'
//   ping      the local round trip in ms (-1 = not measured yet)
//   bounced   Set of "team:seat" keys that were just taken (they get the little bounce)
//   myTeams   teams saved on this computer, cleaned: [{ id, team }]
//   lastTeam  the team this player applied last (TeamConfigDto) or null
//   kits      the shirt colour each side will actually wear, [home, away]

import { getMyTeams, getPrefs, savePrefs, suggestNickname } from '../shared/identity.js';
import { connectRoom } from '../shared/net.js';
import { ROUTES } from '../shared/protocol.js';
import { createChat } from './chat.js';
import { createDock } from './dock.js';
import { h, setAttr, setClass, setHidden, setText, toast } from './dom.js';
import { createHeader } from './header.js';
import { cleanNickname, closedErrorFor, deriveLobby, exitUrl, homeErrorFor, listNames, newlySeated } from './logic.js';
import { createProfile } from './profile.js';
import { createSettingsPanel } from './settings-panel.js';
import { createTeamCard } from './team-card.js';
import { createTeamEditor } from './team-editor.js';
import { cleanSavedTeams, createApplyTracker, kitOf, resolveFormation, sanitizeTeam, teamForSend, teamsEqual } from './team-model.js';

/** How long Leave waits for the server's goodbye before going home anyway. */
const LEAVE_WAIT_MS = 1500;

/** At most one "not connected" notice in this many milliseconds, however often a button is pressed. */
const OFFLINE_NOTICE_MS = 2500;

/**
 * Runs the lobby inside `app` (<main id="app" data-room="CODE">).
 * @param {HTMLElement} app
 */
export async function startLobby(app) {
  const code = String(app.dataset.room ?? '').toUpperCase();
  let leaving = false;

  function go(url, replace) {
    if (leaving) return;
    leaving = true;
    if (replace) location.replace(url);
    else location.assign(url);
  }
  const toMatch = () => go(ROUTES.match(code), false);

  // Someone arriving through an invite link has never typed a name: give them a friendly one
  // rather than letting them join nameless (they are told, and can change it in one click).
  let freshName = false;
  if (cleanNickname(getPrefs().nickname) === '') {
    savePrefs({ nickname: suggestNickname() });
    freshName = true;
  }

  let page = null;
  /** What arrives between the Join answer and the page being built. */
  const early = { state: null, chats: [] };
  let status = 'connected';
  let ping = -1;

  const room = await connectRoom({
    code,
    page: 'lobby',
    handlers: {
      onRoomState(next) {
        if (page) page.accept(next);
        else early.state = next;
      },
      onChat(chat) {
        if (page) page.addChat(chat);
        else early.chats.push(chat);
      },
      // A match can only start from the lobby: wherever this came from, the pitch is the place to be.
      onMatchInit: toMatch,
      onClosed(reason) {
        go(exitUrl(closedErrorFor(reason), code), true);
      },
      onRejoined(join) {
        page?.rejoined(join);
      },
      onStatus(next) {
        status = next;
        page?.connection();
      },
      onPing(ms) {
        ping = ms;
        page?.connection();
      },
    },
  });

  if (!room.ok || !room.join?.room) {
    go(exitUrl(homeErrorFor(room.error), code), true);
    return;
  }

  const first = early.state ?? room.join.room;
  if (first.phase !== 'lobby') {
    toMatch();
    return;
  }

  page = buildLobby();
  page.accept(first);
  for (const chat of early.chats) page.addChat(chat);
  page.welcome();

  // -----------------------------------------------------------------------------------------

  function buildLobby() {
    const catalog = room.join.catalog !== null && typeof room.join.catalog === 'object' ? room.join.catalog : {};
    let memberId = room.join.memberId;
    let state = null;
    let view = null;
    let seatIds = null;
    let lastNotice = -Infinity;
    let myTeams = cleanSavedTeams(getMyTeams(), { crests: catalog.crests });
    let lastTeam = getPrefs().lastTeam;

    // ---- talking to the hub ---------------------------------------------------------------

    /** Fire-and-forget hub call. @returns {boolean} false when it could not be sent */
    function send(method, ...args) {
      if (leaving || !room.connected) return false;
      room.send(method, ...args);
      return true;
    }

    /** Like send, but says so when the page is offline. */
    function call(method, ...args) {
      if (send(method, ...args)) return true;
      const now = performance.now();
      if (!leaving && now - lastNotice > OFFLINE_NOTICE_MS) {
        lastNotice = now;
        toast('Not connected right now, so that did not go through.', { kind: 'warn' });
      }
      return false;
    }

    // ---- team changes -----------------------------------------------------------------------

    const tracker = createApplyTracker();
    let trackerTimer = 0;

    // The server may store a preferred formation as sent or as resolved for the team size.
    const sameFormation = (a, b) => {
      const size = state?.settings?.teamSize ?? 5;
      return resolveFormation(a, size, catalog.formations) === resolveFormation(b, size, catalog.formations);
    };

    function rememberTeam(config) {
      lastTeam = sanitizeTeam(config, { crests: catalog.crests });
      savePrefs({ lastTeam });
    }

    /**
     * Collects the team changes the room has answered, or ignored for too long. The caller
     * redraws and then hands each result to `announce`.
     */
    function settleTeams() {
      const now = performance.now();
      const done = tracker.settle(state?.teams, now, sameFormation);
      for (const result of done) {
        if (result.status !== 'refused' && result.accepted) rememberTeam(result.accepted);
      }
      clearTimeout(trackerTimer);
      const wait = tracker.untilTimeout(now);
      if (wait >= 0) trackerTimer = setTimeout(() => announce(settleTeams()), wait + 20);
      return done;
    }

    /** Redraws (the remembered team may have changed) and tells whoever asked how it went. */
    function announce(results) {
      if (results.length === 0) return;
      render();
      for (const result of results) result.tag?.(result);
    }

    /**
     * Sends a team for one side and reports what became of it.
     * @returns {Promise<{status: 'accepted'|'adjusted'|'refused'|'offline'|'superseded', changed: string[], accepted: ?object}>}
     */
    function applyTeam(team, config) {
      const offline = { status: 'offline', changed: [], accepted: null };
      if (!state) return Promise.resolve(offline);
      const teamSize = state.settings?.teamSize ?? 5;
      const sent = teamForSend(config, { crests: catalog.crests, formations: catalog.formations, teamSize });
      const before = state.teams?.[team]?.config ?? null;
      if (before && teamsEqual(sent, before) && (sent.presetId ?? null) === (before.presetId ?? null)) {
        rememberTeam(before);
        render();
        return Promise.resolve({ status: 'accepted', changed: [], accepted: before });
      }
      if (!call('SetTeamConfig', team, sent)) return Promise.resolve(offline);
      return new Promise((resolve) => {
        const replaced = tracker.begin(team, sent, before, performance.now(), resolve);
        if (replaced) replaced({ status: 'superseded', changed: [], accepted: null });
        // Starts the clock; a change that makes no visible difference is settled on the spot.
        announce(settleTeams());
      });
    }

    /** A team chosen from the quick picker, or "Use my last team". */
    async function pickTeam(team, config) {
      const outcome = await applyTeam(team, config);
      if (outcome.status === 'adjusted') {
        toast(`The server adjusted the ${listNames(outcome.changed, 3)} of that team.`, { kind: 'info' });
      } else if (outcome.status === 'refused') {
        toast("The team was not changed. Only the host and that team's players can change it.", { kind: 'warn' });
      }
    }

    // ---- components -------------------------------------------------------------------------

    const profile = createProfile({ catalog, actions: { setProfile: (patch) => call('SetProfile', patch) } });
    const header = createHeader({ code, origin: location.origin, profileButton: profile.button, actions: { leave } });
    const editor = createTeamEditor({ catalog, background: app, actions: { applyTeam, teamsChanged: reloadSaved } });
    const cards = [0, 1].map((team) =>
      createTeamCard({
        team,
        catalog,
        actions: {
          setTeam: (side) => call('SetTeam', side),
          editTeam: (side) => editor.open(side),
          pickTeam,
        },
      }),
    );
    const settings = createSettingsPanel({ catalog, actions: { setSettings: (next) => call('SetSettings', next) } });
    const dock = createDock({
      actions: {
        setTeam: (side) => call('SetTeam', side),
        setReady: (ready) => call('SetReady', ready),
        startMatch() {
          // A rule changed a moment ago is still waiting out its send delay: it must reach the server first.
          settings.flush();
          return call('StartMatch');
        },
      },
    });
    // The chat explains a failed send next to the box itself, so no toast on top of that.
    const chat = createChat({ catalog, actions: { chat: (text) => send('Chat', text) } });

    // ---- page -------------------------------------------------------------------------------

    const bannerText = h('span');
    const banner = h(
      'div',
      { class: 'net-banner', role: 'status', hidden: true },
      h('span', { class: 'spinner', 'aria-hidden': 'true' }),
      bannerText,
      h('button', { class: 'link-btn', type: 'button', text: 'Reload the page', onClick: () => location.reload() }),
    );

    // On narrow windows the settings and the chat share one column and these two buttons switch
    // between them; on wide ones both panels are visible and the buttons are hidden (site.css).
    const tabs = ['settings', 'chat'].map((name) => {
      const el = h(
        'button',
        { class: 'side-tab', type: 'button', 'aria-pressed': 'false', onClick: () => showTab(name) },
        h('span', { text: name === 'settings' ? 'Match settings' : 'Chat' }),
        name === 'chat' ? h('i', { class: 'side-unread', title: 'New messages' }) : null,
      );
      return { name, el };
    });
    const side = h(
      'div',
      { class: 'side', dataset: { tab: 'chat' } },
      h('div', { class: 'side-tabs', role: 'group', 'aria-label': 'Show' }, tabs.map((tab) => tab.el)),
      settings.el,
      chat.el,
    );

    function showTab(name) {
      side.dataset.tab = name;
      for (const tab of tabs) setAttr(tab.el, 'aria-pressed', tab.name === name ? 'true' : 'false');
      if (name === 'chat') {
        side.classList.remove('has-unread');
        chat.scrollToEnd();
      }
    }

    app.replaceChildren(
      header.el,
      banner,
      h(
        'div',
        { class: 'lobby-main' },
        h('div', { class: 'teams' }, cards[0].el, h('span', { class: 'versus display', 'aria-hidden': 'true', text: 'vs' }), cards[1].el),
        dock.el,
        side,
      ),
    );
    app.classList.add('is-live');

    function render() {
      if (!state || leaving) return;
      view = deriveLobby(state, memberId, seatIds);
      const bounced = newlySeated(seatIds, view.seatIds);
      seatIds = view.seatIds;
      const ctx = {
        room: state,
        view,
        memberId,
        status,
        ping,
        bounced,
        myTeams,
        lastTeam,
        kits: [kitOf(state.teams?.[0]).primary, kitOf(state.teams?.[1]).primary],
      };
      header.update(ctx);
      for (const card of cards) card.update(ctx);
      dock.update(ctx);
      settings.update(ctx);
      chat.update(ctx);
      profile.update(ctx);
      editor.update(ctx);
    }

    function connection() {
      header.setConnection(status, ping);
      setHidden(banner, status === 'connected');
      setClass(banner, 'is-lost', status === 'disconnected');
      setText(bannerText, status === 'disconnected' ? 'The connection to the room was lost.' : 'Connection lost. Getting back to the room');
    }

    function reloadSaved() {
      myTeams = cleanSavedTeams(getMyTeams(), { crests: catalog.crests });
      lastTeam = getPrefs().lastTeam;
      render();
    }

    async function leave() {
      if (leaving) return;
      leaving = true;
      try {
        if (room.connected) {
          await Promise.race([room.invoke('Leave'), new Promise((resolve) => setTimeout(resolve, LEAVE_WAIT_MS))]);
        }
      } catch {
        /* going home either way */
      }
      await room.stop();
      location.assign(ROUTES.home());
    }

    // Teams saved or preferences changed in another tab of this browser.
    window.addEventListener('storage', reloadSaved);
    // A page restored from the back/forward cache has a dead connection and a stale room.
    window.addEventListener('pageshow', (e) => {
      if (e.persisted) location.reload();
    });
    // Enter with nothing focused goes to the chat box, as it does during a match.
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' || e.defaultPrevented || e.ctrlKey || e.altKey || e.metaKey || e.repeat) return;
      if (editor.isOpen || (document.activeElement && document.activeElement !== document.body)) return;
      e.preventDefault();
      showTab('chat');
      chat.focus();
    });

    return {
      /** A RoomState arrived. */
      accept(next) {
        if (leaving || next === null || typeof next !== 'object') return;
        state = next;
        if (state.phase !== 'lobby') {
          toMatch();
          return;
        }
        const settled = settleTeams();
        render();
        for (const result of settled) result.tag?.(result);
      },
      addChat(chatLine) {
        chat.add(chatLine);
        if (side.dataset.tab !== 'chat') side.classList.add('has-unread');
      },
      /** The connection dropped and came back: the server handed the seat back. */
      rejoined(join) {
        if (Number.isInteger(join?.memberId)) memberId = join.memberId;
        if (join?.room) this.accept(join.room);
      },
      connection,
      /** First paint done: point the keyboard at the obvious next step and say hello. */
      welcome() {
        connection();
        showTab(view?.isHost ? 'settings' : 'chat');
        dock.focusPrimary();
        if (freshName && view?.me) {
          toast(`You are playing as ${view.me.name}.`, {
            timeout: 9000,
            action: { label: 'Change name', run: () => profile.open() },
          });
        }
      },
    };
  }
}

const root = typeof document !== 'undefined' ? document.getElementById('app') : null;
if (root) startLobby(root);
