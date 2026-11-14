namespace OfficeKickoff.Web.Protocol;

/// <summary>Messages the server pushes to browsers (SignalR client methods, same names in JS).</summary>
public interface IGameClient
{
    /// <summary>The full room state. Sent to everyone in the room whenever anything in it changes.</summary>
    Task RoomState(RoomStateDto state);

    /// <summary>World snapshot, ~30 Hz while a match is running. Sent only to match-page connections.</summary>
    Task Snap(SnapDto snap);

    /// <summary>A new match started in this room (first start or rematch) while the client is connected.</summary>
    Task MatchInit(MatchInitDto init);

    /// <summary>The match reached full time; the room is now in the "results" phase.</summary>
    Task MatchEnd(MatchResultDto result);

    Task Emote(EmoteDto emote);
    Task Chat(ChatDto chat);

    /// <summary>
    /// This connection is no longer part of the room: "closed" (the room was deleted) or "replaced"
    /// (the same player joined from another tab or connection). The page should go home.
    /// </summary>
    Task Closed(string reason);
}

/// <summary>
/// Methods browsers invoke on the hub (/hub/game). Every method except <see cref="Join"/> requires a
/// prior successful Join on the same connection and is silently ignored otherwise, as is any call
/// from a connection that is no longer the member's current one. All input is untrusted: validate,
/// clamp and sanitise everything; never throw on bad input.
/// </summary>
public interface IGameServer
{
    /// <summary>
    /// Enters a room, or re-enters it after a reconnect or page change (matched by PlayerId, then by
    /// nickname among disconnected members).
    ///
    /// A member has exactly one live connection: a Join from a new connection replaces the old one
    /// (which is told Closed("replaced") and dropped from the room's group), and a disconnect only
    /// counts when it comes from the member's CURRENT connection.
    ///
    /// A brand-new member takes the nickname, colour and celebration from the request and is placed
    /// on the team with fewer humans (spectator when both are full); the first member becomes host.
    /// A re-entering member keeps everything the room already has for them - the profile fields of
    /// the request are ignored - and is not announced.
    ///
    /// While a match is running, a member with a seat in it gets their footballer back as soon as
    /// their inputs start arriving; anyone else spectates.
    /// </summary>
    Task<JoinResult> Join(JoinRequest request);

    /// <summary>Leaves the room for good (as opposed to a disconnect, which keeps the seat for a while).</summary>
    Task Leave();

    /// <summary>Lobby only. 0 = home, 1 = away, -1 = spectator. Ignored when the team already has two humans.</summary>
    Task SetTeam(int team);

    /// <summary>Lobby only.</summary>
    Task SetReady(bool ready);

    /// <summary>Any time. AutoSwitch takes effect immediately, even mid-match.</summary>
    Task SetProfile(ProfileDto profile);

    /// <summary>Lobby only. Allowed for the host and for members of that team.</summary>
    Task SetTeamConfig(int team, TeamConfigDto config);

    /// <summary>Lobby only, host only.</summary>
    Task SetSettings(MatchSettingsDto settings);

    /// <summary>Lobby only, host only. Never blocked by readiness or missing setup.</summary>
    Task StartMatch();

    /// <summary>Results phase, host only: start a new match with the same teams and settings.</summary>
    Task Rematch();

    /// <summary>Match or results phase, host only: abandon the match (if any) and return everyone to the lobby.</summary>
    Task BackToLobby();

    /// <summary>
    /// Match phase, seated players only, from their match-page connection. Sent ~60 Hz while the
    /// player's window is focused; the server applies one input per tick. Receiving inputs is what
    /// marks a player as present; silence marks them away.
    /// </summary>
    Task Input(InputDto input);

    /// <summary>Index into the emote list. Rate limited.</summary>
    Task Emote(int emote);

    /// <summary>Free text or a quick-chat line. Trimmed to 80 characters, rate limited.</summary>
    Task Chat(string text);

    /// <summary>Returns the server's Unix time in ms; the client measures the round trip.</summary>
    Task<long> Ping();

    /// <summary>The client reports its measured round-trip time so others can see it.</summary>
    Task ReportPing(int milliseconds);
}
