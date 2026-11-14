using OfficeKickoff.Sim;
using OfficeKickoff.Web.Protocol;

namespace OfficeKickoff.Web.Rooms;

/// <summary>Where room messages go. Implemented over the SignalR hub context; tests record instead.</summary>
public interface IClientGateway
{
    /// <summary>Every connection in a SignalR group.</summary>
    IGameClient Group(string group);

    IGameClient Client(string connectionId);

    Task AddToGroupAsync(string connectionId, string group);

    Task RemoveFromGroupAsync(string connectionId, string group);
}

/// <summary>Per-connection snapshot channel: drops frames for a slow client without losing events.</summary>
public sealed class SnapLink(string connectionId)
{
    /// <summary>Events from at most this many snapshots' worth of skipped frames are kept.</summary>
    public const int MaxCarried = 64;

    public string ConnectionId { get; } = connectionId;

    /// <summary>The last snapshot send to this connection; a new one is skipped while it is still running.</summary>
    public volatile Task? Pending;

    /// <summary>Events of snapshots this connection skipped, oldest first. Guarded by the room lock.</summary>
    public readonly List<float[]> Carried = [];

    public bool Busy => Pending is { IsCompleted: false };

    public void Carry(IReadOnlyList<float[]> events)
    {
        Carried.AddRange(events);
        while (Carried.Count > MaxCarried)
        {
            // Shed the oldest cosmetic event first; goals and phase changes drive the scoreboard.
            int drop = Carried.FindIndex(e => !Important(e));
            Carried.RemoveAt(drop >= 0 ? drop : 0);
        }
    }

    private static bool Important(float[] e) =>
        e.Length > 0 && (GameEventType)(int)e[0] is GameEventType.Goal or GameEventType.PhaseChange or GameEventType.Overtime;
}

internal enum OutKind : byte
{
    AddToGroup,
    RemoveFromGroup,
    RoomState,
    MatchInit,
    MatchEnd,
    Snap,
    Chat,
    Emote,
    Closed,
}

/// <param name="Connection">Target connection; null = the room's group.</param>
internal readonly record struct OutItem(OutKind Kind, string? Connection, object? Payload, long Version = 0, SnapLink? Link = null);

/// <summary>
/// Messages produced while a room's lock was held, sent after it is released (see Room.Dispatch).
/// </summary>
internal sealed class Outbox
{
    public readonly List<OutItem> Items = [];

    public bool IsEmpty => Items.Count == 0;

    public void AddToGroup(string connection) => Items.Add(new(OutKind.AddToGroup, connection, null));

    public void RemoveFromGroup(string connection) => Items.Add(new(OutKind.RemoveFromGroup, connection, null));

    public void RoomState(RoomStateDto state, long version) => Items.Add(new(OutKind.RoomState, null, state, version));

    public void MatchInit(string connection, MatchInitDto init) => Items.Add(new(OutKind.MatchInit, connection, init));

    public void MatchEnd(MatchResultDto result) => Items.Add(new(OutKind.MatchEnd, null, result));

    public void Snap(SnapLink link, SnapDto snap) => Items.Add(new(OutKind.Snap, link.ConnectionId, snap, Link: link));

    public void Chat(ChatDto chat) => Items.Add(new(OutKind.Chat, null, chat));

    public void Emote(EmoteDto emote) => Items.Add(new(OutKind.Emote, null, emote));

    public void Closed(string connection, string reason) => Items.Add(new(OutKind.Closed, connection, reason));
}
