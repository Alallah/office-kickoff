using OfficeKickoff.Web.Protocol;

namespace OfficeKickoff.Web.Rooms;

/// <summary>A person in a room. Every field is guarded by the room's lock.</summary>
public sealed class Member
{
    /// <summary>Secret id from the browser; never sent to anyone.</summary>
    public required string PlayerId { get; set; }

    /// <summary>Public id inside the room (1, 2, ...).</summary>
    public required int Id { get; init; }

    /// <summary>Order of arrival; the longest-present member has the lowest value.</summary>
    public required long Arrival { get; init; }

    public string Name { get; set; } = "";

    /// <summary>Nickname as the browser asked for it, before de-duplication (used to recognise a re-entry).</summary>
    public string RequestedName { get; set; } = "";

    public string Color { get; set; } = "";
    public string Celebration { get; set; } = "";
    public bool AutoSwitch { get; set; } = true;

    /// <summary>0 = home, 1 = away, -1 = spectator.</summary>
    public int Team { get; set; } = -1;

    public bool Ready { get; set; }
    public bool Connected { get; set; }
    public int Ping { get; set; } = -1;

    /// <summary>The one live connection, or null while disconnected.</summary>
    public string? ConnectionId { get; set; }

    /// <summary>"lobby" or "match".</summary>
    public string Page { get; set; } = "lobby";

    /// <summary>Human id in the current match, -1 when not playing.</summary>
    public int HumanId { get; set; } = -1;

    /// <summary>Snapshot channel of the current connection.</summary>
    public SnapLink? Link { get; set; }

    public DateTimeOffset DisconnectedAt { get; set; }

    /// <summary>The 5-second disconnect announcement was made (so the return gets one too).</summary>
    public bool DisconnectAnnounced { get; set; }

    public readonly Queue<DateTimeOffset> ChatTimes = new();
    public readonly Queue<DateTimeOffset> EmoteTimes = new();

    public bool IsMatchPage => Page == "match";

    public MemberDto ToDto(int hostId) => new()
    {
        Id = Id,
        Name = Name,
        Color = Color,
        Team = Team,
        Ready = Ready,
        Connected = Connected,
        IsHost = Id == hostId,
        Ping = Ping,
        Celebration = Celebration,
        HumanId = HumanId,
    };
}

/// <summary>One of the four human slots of the current match.</summary>
public sealed class HumanSeat(int humanId, Member member, HumanInfoDto info)
{
    /// <summary>Two seconds without an input and the AI takes the footballer.</summary>
    public const int SilenceTicks = 120;

    public int HumanId { get; } = humanId;

    /// <summary>The member in the seat; null once they left the room (the seat stays empty).</summary>
    public Member? Member { get; set; } = member;

    /// <summary>Captured when the match started; unchanged for its whole length.</summary>
    public HumanInfoDto Info { get; } = info;

    public InputQueue Queue { get; } = new();

    /// <summary>Sequence number of the last input applied (0 = none yet).</summary>
    public int Ack { get; set; }

    /// <summary>At the controls: inputs are arriving. Mirrors Match.SetHumanConnected.</summary>
    public bool AtControls { get; set; }

    /// <summary>Match ticks since the last input arrived.</summary>
    public int Silence { get; set; }
}
