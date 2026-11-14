namespace OfficeKickoff.Sim;

public enum AiLevel
{
    Easy = 0,
    Normal = 1,
    Hard = 2,
}

/// <summary>
/// Host-configurable match rules. Every field has a sensible default so a room can start
/// with zero configuration. Always pass user-supplied settings through <see cref="Normalized"/>:
/// any invalid value silently falls back to its default.
/// </summary>
public sealed class MatchSettings
{
    public const int MinTeamSize = 3;
    public const int MaxTeamSize = 7;
    public const int MinMinutes = 1;
    public const int MaxMinutes = 10;
    public const int MaxScoreLimit = 20;
    public const float MinSpeed = 0.75f;
    public const float MaxSpeed = 1.5f;

    /// <summary>Id of the preset these settings came from, or "custom" once edited.</summary>
    public string Preset { get; set; } = "coffee";

    /// <summary>Footballers per team including the AI keeper (3..7).</summary>
    public int TeamSize { get; set; } = 5;

    /// <summary>Match length in minutes (1..10).</summary>
    public int Minutes { get; set; } = 3;

    /// <summary>First team to this many goals wins; 0 = no limit.</summary>
    public int ScoreLimit { get; set; } = 0;

    /// <summary>Tied at full time: true = sudden-death overtime, false = the match ends as a draw.</summary>
    public bool GoldenGoal { get; set; } = true;

    /// <summary>Difficulty of every AI outfield footballer (both teams).</summary>
    public AiLevel AiTeammates { get; set; } = AiLevel.Normal;

    /// <summary>Difficulty of both AI goalkeepers.</summary>
    public AiLevel AiKeeper { get; set; } = AiLevel.Normal;

    /// <summary>Multiplier on kick speeds (0.75..1.5).</summary>
    public float BallSpeed { get; set; } = 1f;

    /// <summary>Multiplier on simulation speed (0.75..1.5). The match clock always runs in real time.</summary>
    public float GameSpeed { get; set; } = 1f;

    public bool Replays { get; set; } = true;
    public bool Celebrations { get; set; } = true;

    public MatchSettings Clone() => (MatchSettings)MemberwiseClone();

    /// <summary>Returns a copy with every field validated; invalid values become the default.</summary>
    public MatchSettings Normalized()
    {
        var d = new MatchSettings();
        return new MatchSettings
        {
            Preset = Presets.Any(p => p.Id == Preset) || Preset == "custom" ? Preset : "custom",
            TeamSize = TeamSize is >= MinTeamSize and <= MaxTeamSize ? TeamSize : d.TeamSize,
            Minutes = Minutes is >= MinMinutes and <= MaxMinutes ? Minutes : d.Minutes,
            ScoreLimit = ScoreLimit is >= 0 and <= MaxScoreLimit ? ScoreLimit : d.ScoreLimit,
            GoldenGoal = GoldenGoal,
            AiTeammates = Enum.IsDefined(AiTeammates) ? AiTeammates : d.AiTeammates,
            AiKeeper = Enum.IsDefined(AiKeeper) ? AiKeeper : d.AiKeeper,
            BallSpeed = float.IsFinite(BallSpeed) && BallSpeed is >= MinSpeed and <= MaxSpeed ? BallSpeed : d.BallSpeed,
            GameSpeed = float.IsFinite(GameSpeed) && GameSpeed is >= MinSpeed and <= MaxSpeed ? GameSpeed : d.GameSpeed,
            Replays = Replays,
            Celebrations = Celebrations,
        };
    }

    /// <summary>One-click rule bundles. The first entry is the default for new rooms.</summary>
    public static IReadOnlyList<SettingsPreset> Presets { get; } =
    [
        new("coffee", "Coffee Break", "3 minutes, 5-a-side. Fits between two meetings.",
            new MatchSettings { Preset = "coffee", Minutes = 3, TeamSize = 5 }),
        new("classic", "Classic", "5 minutes, 5-a-side. The standard office fixture.",
            new MatchSettings { Preset = "classic", Minutes = 5, TeamSize = 5 }),
        new("big", "Big Match", "8 minutes, 7-a-side on the big pitch.",
            new MatchSettings { Preset = "big", Minutes = 8, TeamSize = 7 }),
        new("chaos", "Chaos", "2 minutes, 3-a-side, fast ball. Pure mayhem.",
            new MatchSettings { Preset = "chaos", Minutes = 2, TeamSize = 3, BallSpeed = 1.35f, GameSpeed = 1.1f }),
    ];

    public static MatchSettings FromPreset(string? id)
    {
        var preset = Presets.FirstOrDefault(p => p.Id == id) ?? Presets[0];
        return preset.Settings.Clone();
    }
}

public sealed record SettingsPreset(string Id, string Label, string Description, MatchSettings Settings);

/// <summary>Everything the simulation needs to run one match.</summary>
public sealed class MatchConfig
{
    /// <summary>Already-normalized settings.</summary>
    public MatchSettings Settings { get; set; } = new();

    /// <summary>Formation name per team (index 0 = home, 1 = away). Resolved with <see cref="Formations.Resolve"/>.</summary>
    public string[] Formations { get; set; } = ["", ""];

    /// <summary>Practice mode: no clock, no score limit, the match never ends on its own.</summary>
    public bool Practice { get; set; }

    /// <summary>Team that takes the first kickoff.</summary>
    public int KickoffTeam { get; set; }

    /// <summary>
    /// Optional per-team override of the AI difficulty (outfield and keeper alike); null = use the
    /// match settings. The game itself never sets this - it exists for tests and tuning runs
    /// (for example Hard versus Easy).
    /// </summary>
    public AiLevel?[] TeamAi { get; set; } = [null, null];

    /// <summary>Difficulty of a team's AI outfield footballers. Always read the level through this.</summary>
    public AiLevel OutfieldLevel(int team) => TeamAi[team] ?? Settings.AiTeammates;

    /// <summary>Difficulty of a team's goalkeeper. Always read the level through this.</summary>
    public AiLevel KeeperLevel(int team) => TeamAi[team] ?? Settings.AiKeeper;
}
