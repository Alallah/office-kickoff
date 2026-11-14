// Connection to the game hub. Used by both the lobby page and the match page.
//
// Requires the SignalR browser client to be loaded first as a classic script (global `signalR`):
//   <script src="/lib/signalr/dist/browser/signalr.min.js"></script>
//
// Usage:
//   const room = await connectRoom({ code, page: 'lobby', handlers: { onRoomState(state) {...} } });
//   if (!room.ok) -> room.error is 'not_found' | 'invalid' | 'full' | 'unreachable'
//   room.join            the JoinResult (memberId, room, catalog, match, result)
//   room.invoke(name, ...args)   call a hub method and await its result
//   room.send(name, ...args)     fire-and-forget (use for the 60 Hz input stream)
//
// The connection reconnects by itself. After every reconnect it re-joins the room with the same
// playerId, so the server hands the seat back, and `handlers.onRejoined(joinResult)` fires.

import { ROUTES } from './protocol.js';
import { getPlayerId, getPrefs } from './identity.js';

/**
 * @typedef {Object} RoomHandlers
 * @property {(state: object) => void} [onRoomState]   RoomStateDto, on every change
 * @property {(snap: object) => void} [onSnap]         raw wire snapshot (decode with decodeSnap)
 * @property {(init: object) => void} [onMatchInit]    MatchInitDto, when a match (re)starts
 * @property {(result: object) => void} [onMatchEnd]   MatchResultDto
 * @property {(emote: object) => void} [onEmote]       EmoteDto
 * @property {(chat: object) => void} [onChat]         ChatDto
 * @property {(reason: string) => void} [onClosed]     this connection is out of the room: 'closed' (room deleted),
 *                                                     'replaced' (same player joined from another tab), or a Join error
 *                                                     after a reconnect ('not_found' | 'invalid' | 'full'). Go home.
 * @property {(join: object) => void} [onRejoined]     JoinResult after an automatic reconnect
 * @property {(status: 'connected'|'reconnecting'|'disconnected') => void} [onStatus]
 * @property {(ms: number) => void} [onPing]           round-trip time, measured every 2 s
 */

/**
 * Connects to the hub and joins a room.
 * @param {{code: string, page: 'lobby'|'match', handlers?: RoomHandlers}} options
 */
export async function connectRoom({ code, page, handlers = {} }) {
  // Keep-alive must match the server (KeepAliveInterval 4 s, ClientTimeoutInterval 15 s): the
  // client pings at least every 4 s and gives up on a silent server after 15 s. The defaults
  // (15 s / 30 s) would let the server time a quiet browser tab out.
  const connection = new signalR.HubConnectionBuilder()
    .withUrl(ROUTES.hub)
    .withKeepAliveInterval(4000)
    .withServerTimeout(15000)
    .withAutomaticReconnect({ nextRetryDelayInMilliseconds: (ctx) => Math.min(5000, 250 * 2 ** ctx.previousRetryCount) })
    .configureLogging(signalR.LogLevel.Warning)
    .build();

  const on = (name, key) => connection.on(name, (payload) => handlers[key]?.(payload));
  on('RoomState', 'onRoomState');
  on('Snap', 'onSnap');
  on('MatchInit', 'onMatchInit');
  on('MatchEnd', 'onMatchEnd');
  on('Emote', 'onEmote');
  on('Chat', 'onChat');
  // The server has dropped this connection from the room. Stop for good first: an automatic
  // reconnect would re-join and, for 'replaced', steal the seat back from the other tab.
  connection.on('Closed', (reason) => {
    stopped = true;
    clearInterval(pingTimer);
    connection.stop().catch(() => {});
    handlers.onClosed?.(reason);
  });

  const joinRequest = () => {
    const prefs = getPrefs();
    return {
      code: String(code || '').toUpperCase(),
      playerId: getPlayerId(),
      nickname: prefs.nickname || '',
      color: prefs.color || '',
      celebration: prefs.celebration || '',
      autoSwitch: prefs.autoSwitch !== false,
      page,
    };
  };

  const room = {
    ok: false,
    /** @type {?string} */ error: null,
    /** @type {?object} */ join: null,
    memberId: 0,
    /** Latest round-trip time in ms (-1 until measured). */
    ping: -1,
    connection,
    get connected() {
      return connection.state === signalR.HubConnectionState.Connected;
    },
    invoke(method, ...args) {
      return connection.invoke(method, ...args);
    },
    /** Fire-and-forget; silently dropped while disconnected. */
    send(method, ...args) {
      if (connection.state !== signalR.HubConnectionState.Connected) return;
      connection.send(method, ...args).catch(() => {});
    },
    async stop() {
      stopped = true;
      clearInterval(pingTimer);
      try {
        await connection.stop();
      } catch {
        /* already closed */
      }
    },
  };

  let stopped = false;
  let pingTimer = 0;

  connection.onreconnecting(() => handlers.onStatus?.('reconnecting'));
  connection.onreconnected(async () => {
    handlers.onStatus?.('connected');
    try {
      const join = await connection.invoke('Join', joinRequest());
      if (join?.ok) {
        room.join = join;
        room.memberId = join.memberId;
        handlers.onRejoined?.(join);
      } else {
        handlers.onClosed?.(join?.error || 'closed');
      }
    } catch {
      /* the next reconnect will retry */
    }
  });
  connection.onclose(() => {
    if (!stopped) handlers.onStatus?.('disconnected');
  });

  try {
    await connection.start();
  } catch {
    room.error = 'unreachable';
    return room;
  }

  let join;
  try {
    join = await connection.invoke('Join', joinRequest());
  } catch {
    join = { ok: false, error: 'unreachable' };
  }
  if (!join?.ok) {
    room.error = join?.error || 'invalid';
    await room.stop();
    return room;
  }

  room.ok = true;
  room.join = join;
  room.memberId = join.memberId;
  handlers.onStatus?.('connected');

  // Round-trip time: measured every 2 s, reported to the server so everyone sees it.
  const measure = async () => {
    if (connection.state !== signalR.HubConnectionState.Connected) return;
    const t0 = performance.now();
    try {
      await connection.invoke('Ping');
      const ms = Math.round(performance.now() - t0);
      room.ping = room.ping < 0 ? ms : Math.round(room.ping * 0.6 + ms * 0.4);
      handlers.onPing?.(room.ping);
      room.send('ReportPing', room.ping);
    } catch {
      /* ignore */
    }
  };
  measure();
  pingTimer = setInterval(measure, 2000);

  return room;
}
