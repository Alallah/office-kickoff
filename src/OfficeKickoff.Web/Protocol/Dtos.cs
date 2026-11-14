using System.Text.Json.Serialization;
using OfficeKickoff.Sim;

namespace OfficeKickoff.Web.Protocol;

// =====================================================================================
//  WIRE PROTOCOL - every message exchanged over the SignalR hub at /hub/game.
//
//  SignalR's JSON protocol serialises property names in camelCase, so `MemberId` here is
//  `memberId` in the browser. The JavaScript mirror of this file is
//  wwwroot/js/shared/protocol.js - keep the two in sync.
// =====================================================================================

/// <summary>Fixed vocabulary shared by server and client.</summary>
public static class Vocabulary
{
    public const int MaxNickname = 16;
    public const int MaxTeamName = 24;
    public const int TeamCodeLength = 3;
    public const int MaxRosterName = 20;
    public const int MaxChat = 80;
    public const int RoomCodeLength = 4;
    public const int HumansPerTeam = 2;

    /// <summary>Roster entries stored per team (the largest team size), slot 0 = goalkeeper.</summary>
    public const int RosterSize = 7;

    public static readonly string[] Crests = ["shield", "circle", "diamond", "hexagon", "star", "bolt", "chevron", "crown"];
    public static readonly string[] Celebrations = ["spin", "dab", "confetti", "backflip", "shockwave", "hearts"];
    public static readonly string[] Emotes = ["😂", "👏", "😭", "🔥", "😎", "😡", "🫡", "💤"];
    public static readonly string[] QuickChat =
        ["Nice shot!", "Great pass!", "My bad", "Pass!", "Defend!", "Unlucky", "Wow!", "GG"];

    /// <summary>Default footballer accent colours handed out to new members in turn.</summary>
    public static readonly string[] PlayerColors =
        ["#ffd166", "#2ee6ff", "#ff6b9d", "#b6ff3c", "#c792ff", "#ff9f43", "#ffffff", "#5eead4"];
}

// ------------------------------------------------------------------------------------
//  Joining
// ------------------------------------------------------------------------------------

public sealed class JoinRequest
{
    /// <summary>Room code (case-insensitive).</summary>
    public string Code { get; set; } = "";

    /// <summary>
    /// Secret, client-generated id that identifies this browser tab across reconnects and page
    /// changes. Must be 8-64 characters; anything else is rejected as "invalid".
    /// </summary>
    public string PlayerId { get; set; } = "";

    public string Nickname { get; set; } = "";

    /// <summary>Preferred accent colour "#rrggbb" ("" = let the server pick).</summary>
    public string Color { get; set; } = "";

    /// <summary>Preferred celebration id ("" = default).</summary>
    public string Celebration { get; set; } = "";

    public bool AutoSwitch { get; set; } = true;

    /// <summary>Which page is joining: "lobby" or "match".</summary>
    public string Page { get; set; } = "lobby";
}

public sealed class JoinResult
{
    public bool Ok { get; set; }

    /// <summary>When not Ok: "not_found" (no such room), "invalid" (malformed request) or "full" (the room has its maximum number of members).</summary>
    public string? Error { get; set; }

    /// <summary>The caller's public member id in this room.</summary>
    public int MemberId { get; set; }

    public RoomStateDto? Room { get; set; }

    /// <summary>Static reference data for the lobby UI.</summary>
    public CatalogDto? Catalog { get; set; }

    /// <summary>Present when the room is in the "match" or "results" phase.</summary>
    public MatchInitDto? Match { get; set; }

    /// <summary>Present when the room is in the "results" phase.</summary>
    public MatchResultDto? Result { get; set; }
}

public sealed class CatalogDto
{
    public TeamConfigDto[] TeamPresets { get; set; } = [];

    /// <summary>Valid formation names keyed by team size ("3".."7"); the first entry is the default.</summary>
    public Dictionary<string, string[]> Formations { get; set; } = [];

    public SettingsPresetDto[] SettingsPresets { get; set; } = [];
    public string[] Crests { get; set; } = Vocabulary.Crests;
    public string[] Celebrations { get; set; } = Vocabulary.Celebrations;
    public string[] Emotes { get; set; } = Vocabulary.Emotes;
    public string[] QuickChat { get; set; } = Vocabulary.QuickChat;
    public string[] PlayerColors { get; set; } = Vocabulary.PlayerColors;
}

public sealed class SettingsPresetDto
{
    public string Id { get; set; } = "";
    public string Label { get; set; } = "";
    public string Description { get; set; } = "";
    public MatchSettingsDto Settings { get; set; } = new();
}

// ------------------------------------------------------------------------------------
//  Room / lobby state
// ------------------------------------------------------------------------------------

public sealed class RoomStateDto
{
    public string Code { get; set; } = "";

    /// <summary>"lobby" | "match" | "results".</summary>
    public string Phase { get; set; } = "lobby";

    public bool Practice { get; set; }

    /// <summary>Member id of the host.</summary>
    public int HostId { get; set; }

    /// <summary>Increments every time a match starts in this room.</summary>
    public int MatchId { get; set; }

    public MemberDto[] Members { get; set; } = [];

    /// <summary>Index 0 = home (defends left), 1 = away.</summary>
    public TeamDto[] Teams { get; set; } = [];

    public MatchSettingsDto Settings { get; set; } = new();
}

public sealed class MemberDto
{
    public int Id { get; set; }
    public string Name { get; set; } = "";

    /// <summary>Accent colour "#rrggbb" (indicator ring, name tag).</summary>
    public string Color { get; set; } = "";

    /// <summary>0 = home, 1 = away, -1 = spectator.</summary>
    public int Team { get; set; } = -1;

    public bool Ready { get; set; }
    public bool Connected { get; set; }
    public bool IsHost { get; set; }

    /// <summary>Last reported round-trip time in ms (-1 = unknown).</summary>
    public int Ping { get; set; } = -1;

    public string Celebration { get; set; } = "";

    /// <summary>Human id (0..3) in the current match, or -1 (spectator / not playing).</summary>
    public int HumanId { get; set; } = -1;
}

/// <summary>Everything editable about a team. Purely cosmetic except <see cref="Formation"/>.</summary>
public sealed class TeamConfigDto
{
    /// <summary>Id of the preset this team came from, or null for a custom team. Any value that is not a catalogue id becomes null.</summary>
    public string? PresetId { get; set; }

    public string Name { get; set; } = "";

    /// <summary>Three-letter scoreboard code, upper case.</summary>
    public string Code { get; set; } = "";

    /// <summary>"#rrggbb" outfield shirt colour.</summary>
    public string Primary { get; set; } = "";

    /// <summary>"#rrggbb" trim colour, also the fallback shirt colour on a clash.</summary>
    public string Secondary { get; set; } = "";

    /// <summary>"#rrggbb" goalkeeper shirt colour.</summary>
    public string Keeper { get; set; } = "";

    /// <summary>One of <see cref="Vocabulary.Crests"/>.</summary>
    public string Crest { get; set; } = "";

    /// <summary>Preferred formation. If it is not valid for the current team size the default is used.</summary>
    public string Formation { get; set; } = "";

    /// <summary>Exactly <see cref="Vocabulary.RosterSize"/> entries; index 0 is the goalkeeper.</summary>
    public List<RosterEntryDto> Roster { get; set; } = [];
}

public sealed class RosterEntryDto
{
    public string Name { get; set; } = "";

    /// <summary>Shirt number 1..99.</summary>
    public int Number { get; set; }
}

/// <summary>A team as it will actually appear: the editable config plus what the server resolved.</summary>
public sealed class TeamDto
{
    public TeamConfigDto Config { get; set; } = new();

    /// <summary>Colours to draw with, after clash resolution between the two teams.</summary>
    public KitDto Kit { get; set; } = new();

    /// <summary>Formation in effect for the current team size.</summary>
    public string Formation { get; set; } = "";
}

public sealed class KitDto
{
    /// <summary>Outfield shirt colour.</summary>
    public string Primary { get; set; } = "";

    /// <summary>Trim / outline colour.</summary>
    public string Secondary { get; set; } = "";

    /// <summary>Goalkeeper shirt colour (guaranteed to differ from both outfield kits).</summary>
    public string Keeper { get; set; } = "";

    /// <summary>"#ffffff" or "#111111", whichever reads better on <see cref="Primary"/>.</summary>
    public string Text { get; set; } = "";

    /// <summary>True when the kit was changed to avoid a colour clash with the other team.</summary>
    public bool Swapped { get; set; }
}

/// <summary>Mirror of <see cref="MatchSettings"/>. Always normalised by the server.</summary>
public sealed class MatchSettingsDto
{
    public string Preset { get; set; } = "coffee";
    public int TeamSize { get; set; } = 5;

    /// <summary>False: no goalkeepers (slot 0 plays outfield) and narrower goals.</summary>
    public bool Keepers { get; set; } = true;

    public int Minutes { get; set; } = 3;
    public int ScoreLimit { get; set; }
    public bool GoldenGoal { get; set; } = true;

    /// <summary>0 = easy, 1 = normal, 2 = hard.</summary>
    public int AiTeammates { get; set; } = 1;

    /// <summary>0 = easy, 1 = normal, 2 = hard. Unused while <see cref="Keepers"/> is false.</summary>
    public int AiKeeper { get; set; } = 1;

    public float BallSpeed { get; set; } = 1f;
    public float GameSpeed { get; set; } = 1f;
    public bool Replays { get; set; } = true;
    public bool Celebrations { get; set; } = true;
}

/// <summary>Null fields are left unchanged.</summary>
public sealed class ProfileDto
{
    public string? Nickname { get; set; }
    public string? Color { get; set; }
    public string? Celebration { get; set; }
    public bool? AutoSwitch { get; set; }
}

// ------------------------------------------------------------------------------------
//  Match
// ------------------------------------------------------------------------------------

/// <summary>Everything a client needs to render and predict a match. Sent once per match.</summary>
public sealed class MatchInitDto
{
    public int MatchId { get; set; }
    public bool Practice { get; set; }
    public PitchDto Pitch { get; set; } = new();

    /// <summary>The server's full gameplay tuning, so client prediction uses identical numbers.</summary>
    public Tuning Tuning { get; set; } = new();

    public MatchSettingsDto Settings { get; set; } = new();
    public TeamDto[] Teams { get; set; } = [];

    /// <summary>All footballers, indexed like the snapshot's player array.</summary>
    public PlayerInfoDto[] Players { get; set; } = [];

    /// <summary>
    /// Every human seated for this match (0..4 entries), captured when it started and unchanged for
    /// its whole length, whether or not they are currently at the controls. A client finds itself
    /// by member id.
    /// </summary>
    public HumanInfoDto[] Humans { get; set; } = [];

    /// <summary>Server tick when this message was built.</summary>
    public int Tick { get; set; }
}

public sealed class PitchDto
{
    public float Width { get; set; }
    public float Height { get; set; }
    public float GoalWidth { get; set; }
    public float GoalDepth { get; set; }
    public float PostRadius { get; set; }
    public float CornerRadius { get; set; }
    public float BoxDepth { get; set; }
    public float BoxHalfWidth { get; set; }
    public float CenterRadius { get; set; }
}

public sealed class PlayerInfoDto
{
    public int Index { get; set; }
    public int Team { get; set; }
    public int Slot { get; set; }

    /// <summary>True for the goalkeeper; always false in a match without goalkeepers (slot 0 then plays outfield).</summary>
    public bool Keeper { get; set; }

    /// <summary>Roster name of this footballer.</summary>
    public string Name { get; set; } = "";

    public int Number { get; set; }
}

public sealed class HumanInfoDto
{
    public int HumanId { get; set; }
    public int MemberId { get; set; }
    public string Name { get; set; } = "";
    public int Team { get; set; }
    public string Color { get; set; } = "";
    public string Celebration { get; set; } = "";
}

/// <summary>
/// World snapshot, broadcast ~30 times a second. Compact on purpose: short property names and
/// flat number arrays. Layouts (also in protocol.js):
///
///  b (ball)   : [x, y, vx, vy, spin, owner, heat, flags]            flags: 1 = held by keeper, 2 = dead (in the net)
///  p (players): 13 numbers per footballer, in index order:
///               [x, y, vx, vy, aim, action, actionTime, actionDir, stamina, charge, controller, tackleCooldown, flags]
///               actionDir = angle (radians) of PlayerState.ActionDir, the direction of the current slide / dash / dive
///               flags: 1 = charging, 2 = exhausted, 4 = sprinting, 8 = slide has hit, 16 = tackle-immune
///  a (acks)   : sequence number of the last input applied for human id 0..3 (0 = none yet)
///  e (events) : one [type, a, b, x, y, value, flag] array per GameEvent since the previous snapshot
///               SENT TO THIS CONNECTION (events from snapshots a slow connection skipped are carried over)
///  f (flags)  : 1 = overtime (golden goal), 2 = slow motion, 4 = away team has the kickoff
///
/// Rounding: positions and velocities to 1 decimal; angles, 0..1 values and every time value
/// (actionTime, tackleCooldown, phase time, clock) to 3 decimals. Non-finite numbers are sent as 0.
/// </summary>
public sealed class SnapDto
{
    [JsonPropertyName("t")] public int Tick { get; set; }
    [JsonPropertyName("ph")] public int Phase { get; set; }
    [JsonPropertyName("pt")] public float PhaseTime { get; set; }
    [JsonPropertyName("ck")] public float Clock { get; set; }
    [JsonPropertyName("sc")] public int[] Score { get; set; } = [0, 0];
    [JsonPropertyName("f")] public int Flags { get; set; }
    [JsonPropertyName("b")] public float[] Ball { get; set; } = [];
    [JsonPropertyName("p")] public float[] Players { get; set; } = [];
    [JsonPropertyName("a")] public int[] Acks { get; set; } = [0, 0, 0, 0];

    [JsonPropertyName("e")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public float[][]? Events { get; set; }

    public const int PlayerStride = 13;
    public const int BallLength = 8;
}

/// <summary>
/// One tick of a human's controls, sent ~60 times a second while the player's window is focused.
/// Input flow is also presence: a player who stops sending is treated as away and the AI takes
/// their footballer until inputs resume.
/// k (keys) bit mask: 1 = sprint (held), 2 = shoot (held), 4 = pass (edge), 8 = tackle/dash (edge),
/// 16 = switch to best (edge), 32 = switch to next (edge).
/// </summary>
public sealed class InputDto
{
    /// <summary>
    /// Client input counter. The server only echoes it back in the snapshot acks: it never rejects,
    /// reorders or filters on it. The client starts at 1 on every page load and counts up. The
    /// server clears a human's queue and resets their ack to 0 when a match starts (first start or
    /// rematch) and whenever the member joins on a new connection.
    /// </summary>
    [JsonPropertyName("s")] public int Seq { get; set; }

    /// <summary>Move direction, each -1..1.</summary>
    [JsonPropertyName("mx")] public float MoveX { get; set; }
    [JsonPropertyName("my")] public float MoveY { get; set; }

    /// <summary>Mouse cursor in world coordinates.</summary>
    [JsonPropertyName("ax")] public float AimX { get; set; }
    [JsonPropertyName("ay")] public float AimY { get; set; }

    [JsonPropertyName("k")] public int Keys { get; set; }

    public const int Sprint = 1, Shoot = 2, Pass = 4, Tackle = 8, SwitchBest = 16, SwitchNext = 32;
}

public sealed class EmoteDto
{
    public int MemberId { get; set; }

    /// <summary>Human id of the sender in the current match, or -1.</summary>
    public int HumanId { get; set; } = -1;

    /// <summary>Index into <see cref="Vocabulary.Emotes"/>.</summary>
    public int Emote { get; set; }
}

public sealed class ChatDto
{
    /// <summary>0 for system messages.</summary>
    public int MemberId { get; set; }

    public string Name { get; set; } = "";

    /// <summary>Sender's team (-1 = spectator / system).</summary>
    public int Team { get; set; } = -1;

    public string Text { get; set; } = "";

    /// <summary>
    /// True for server announcements. The server announces: a brand-new member, a member leaving or
    /// being removed, a disconnect that has lasted 5 seconds, the return from such a disconnect,
    /// and a change of host. Page changes and quick reconnects are never announced.
    /// </summary>
    public bool System { get; set; }
}

// ------------------------------------------------------------------------------------
//  Results
// ------------------------------------------------------------------------------------

public sealed class MatchResultDto
{
    public int MatchId { get; set; }
    public int[] Score { get; set; } = [0, 0];

    /// <summary>0 or 1, or -1 for a draw.</summary>
    public int Winner { get; set; } = -1;

    /// <summary>True when the match was decided by a golden goal.</summary>
    public bool Overtime { get; set; }

    /// <summary>Real seconds of open play.</summary>
    public float Duration { get; set; }

    public GoalDto[] Goals { get; set; } = [];

    /// <summary>One line per human who played.</summary>
    public HumanStatsDto[] Humans { get; set; } = [];

    /// <summary>Index 0 = home, 1 = away. Includes AI actions.</summary>
    public TeamStatsDto[] Teams { get; set; } = [];

    /// <summary>Human id of the most valuable player, or -1 when no human played.</summary>
    public int Mvp { get; set; } = -1;
}

public sealed class GoalDto
{
    /// <summary>Real seconds of open play when it was scored.</summary>
    public float Time { get; set; }

    public int Team { get; set; }

    /// <summary>Display name: the human's nickname, or the footballer's roster name for an AI goal.</summary>
    public string Scorer { get; set; } = "";

    /// <summary>Human id of the scorer, or -1 for an AI footballer.</summary>
    public int ScorerHuman { get; set; } = -1;

    public string? Assist { get; set; }
    public int AssistHuman { get; set; } = -1;
    public bool OwnGoal { get; set; }
}

public class StatsDto
{
    public int Goals { get; set; }
    public int OwnGoals { get; set; }
    public int Assists { get; set; }
    public int Shots { get; set; }
    public int ShotsOnTarget { get; set; }
    public int Saves { get; set; }
    public int Tackles { get; set; }
    public int Steals { get; set; }
    public int PassesAttempted { get; set; }
    public int PassesCompleted { get; set; }
}

public sealed class HumanStatsDto : StatsDto
{
    public int HumanId { get; set; }
    public int MemberId { get; set; }
    public string Name { get; set; } = "";
    public int Team { get; set; }
    public string Color { get; set; } = "";

    /// <summary>MVP rating (higher is better).</summary>
    public float Rating { get; set; }
}

public sealed class TeamStatsDto : StatsDto
{
    /// <summary>Share of possession, 0..100 (the two teams sum to 100).</summary>
    public int Possession { get; set; }
}
