using System.Text;
using OfficeKickoff.Sim;
using OfficeKickoff.Web.Protocol;

namespace OfficeKickoff.Web.Rooms;

/// <summary>Validation of team configurations and match settings sent by browsers.</summary>
public static class TeamRules
{
    public const int MinNumber = 1;
    public const int MaxNumber = 99;

    /// <summary>
    /// Returns a fully valid copy of <paramref name="input"/>. Every invalid field falls back to the
    /// matching field of <paramref name="fallback"/> (which must itself be valid), except the code,
    /// which is derived from the name, and the preset id, which becomes null.
    /// </summary>
    public static TeamConfigDto Normalize(TeamConfigDto? input, TeamConfigDto fallback, Func<string?, bool> isPresetId)
    {
        if (input is null) return Clone(fallback);

        string name = TextRules.Clean(input.Name, Vocabulary.MaxTeamName);
        if (name.Length == 0) name = fallback.Name;

        string code = (input.Code ?? "").Trim().ToUpperInvariant();
        if (!IsTeamCode(code)) code = DeriveCode(name);

        string formation = IsKnownFormation(input.Formation) ? input.Formation : fallback.Formation;

        return new TeamConfigDto
        {
            PresetId = isPresetId(input.PresetId) ? input.PresetId : null,
            Name = name,
            Code = code,
            Primary = TextRules.Color(input.Primary, fallback.Primary),
            Secondary = TextRules.Color(input.Secondary, fallback.Secondary),
            Keeper = TextRules.Color(input.Keeper, fallback.Keeper),
            Crest = Vocabulary.Crests.Contains(input.Crest) ? input.Crest : fallback.Crest,
            Formation = formation,
            Roster = NormalizeRoster(input.Roster, fallback.Roster),
        };
    }

    public static TeamConfigDto Clone(TeamConfigDto team) => new()
    {
        PresetId = team.PresetId,
        Name = team.Name,
        Code = team.Code,
        Primary = team.Primary,
        Secondary = team.Secondary,
        Keeper = team.Keeper,
        Crest = team.Crest,
        Formation = team.Formation,
        Roster = team.Roster.Select(r => new RosterEntryDto { Name = r.Name, Number = r.Number }).ToList(),
    };

    public static bool IsTeamCode(string? code) =>
        code is { Length: Vocabulary.TeamCodeLength } && code.All(c => c is >= 'A' and <= 'Z' or >= '0' and <= '9');

    /// <summary>True when the formation is valid for at least one team size.</summary>
    public static bool IsKnownFormation(string? formation)
    {
        if (string.IsNullOrEmpty(formation)) return false;
        for (int size = MatchSettings.MinTeamSize; size <= MatchSettings.MaxTeamSize; size++)
        {
            if (Formations.IsValid(formation, size)) return true;
        }

        return false;
    }

    /// <summary>Three upper-case letters or digits from a team name: initials of three words, else its first three.</summary>
    public static string DeriveCode(string? name)
    {
        var words = new List<string>();
        var current = new StringBuilder();
        foreach (char raw in (name ?? "").Normalize(NormalizationForm.FormD))
        {
            char c = char.ToUpperInvariant(raw);
            if (c is >= 'A' and <= 'Z' or >= '0' and <= '9')
            {
                current.Append(c);
            }
            else if (char.GetUnicodeCategory(raw) != System.Globalization.UnicodeCategory.NonSpacingMark && current.Length > 0)
            {
                words.Add(current.ToString());
                current.Clear();
            }
        }

        if (current.Length > 0) words.Add(current.ToString());

        string code = words.Count >= 3
            ? string.Concat(words.Take(3).Select(w => w[0]))
            : string.Concat(words);
        if (code.Length > 3) code = code[..3];
        return code.PadRight(3, 'X');
    }

    private static List<RosterEntryDto> NormalizeRoster(List<RosterEntryDto>? roster, List<RosterEntryDto> fallback)
    {
        var result = new List<RosterEntryDto>(Vocabulary.RosterSize);
        var used = new HashSet<int>();
        var pending = new List<int>();

        for (int i = 0; i < Vocabulary.RosterSize; i++)
        {
            var entry = roster is not null && i < roster.Count ? roster[i] : null;
            var backup = i < fallback.Count ? fallback[i] : null;

            string name = TextRules.Clean(entry?.Name, Vocabulary.MaxRosterName);
            if (name.Length == 0) name = backup?.Name is { Length: > 0 } b ? b : $"Player {i + 1}";

            int number = entry?.Number ?? 0;
            if (number is < MinNumber or > MaxNumber || !used.Add(number))
            {
                number = 0;
                pending.Add(i);
            }

            result.Add(new RosterEntryDto { Name = name, Number = number });
        }

        // Repair missing or duplicate numbers: the fallback's number if still free, else the lowest free one.
        foreach (int i in pending)
        {
            int wanted = i < fallback.Count ? fallback[i].Number : 0;
            if (wanted is < MinNumber or > MaxNumber || used.Contains(wanted))
            {
                wanted = MinNumber;
                while (used.Contains(wanted)) wanted++;
            }

            used.Add(wanted);
            result[i].Number = wanted;
        }

        return result;
    }

    // ------------------------------------------------------------------------------------
    //  Settings
    // ------------------------------------------------------------------------------------

    public static MatchSettings FromDto(MatchSettingsDto? dto)
    {
        if (dto is null) return new MatchSettings().Normalized();

        var settings = new MatchSettings
        {
            Preset = dto.Preset ?? "custom",
            TeamSize = dto.TeamSize,
            Minutes = dto.Minutes,
            ScoreLimit = dto.ScoreLimit,
            GoldenGoal = dto.GoldenGoal,
            AiTeammates = (AiLevel)dto.AiTeammates,
            AiKeeper = (AiLevel)dto.AiKeeper,
            BallSpeed = dto.BallSpeed,
            GameSpeed = dto.GameSpeed,
            Replays = dto.Replays,
            Celebrations = dto.Celebrations,
        }.Normalized();

        // A preset label is only kept while the rules really are that preset's.
        var preset = MatchSettings.Presets.FirstOrDefault(p => p.Id == settings.Preset);
        if (preset is not null && !SameRules(settings, preset.Settings)) settings.Preset = "custom";
        return settings;
    }

    private static bool SameRules(MatchSettings a, MatchSettings b) =>
        a.TeamSize == b.TeamSize && a.Minutes == b.Minutes && a.ScoreLimit == b.ScoreLimit &&
        a.GoldenGoal == b.GoldenGoal && a.AiTeammates == b.AiTeammates && a.AiKeeper == b.AiKeeper &&
        Math.Abs(a.BallSpeed - b.BallSpeed) < 0.001f && Math.Abs(a.GameSpeed - b.GameSpeed) < 0.001f;

    public static MatchSettingsDto ToDto(MatchSettings s) => new()
    {
        Preset = s.Preset,
        TeamSize = s.TeamSize,
        Minutes = s.Minutes,
        ScoreLimit = s.ScoreLimit,
        GoldenGoal = s.GoldenGoal,
        AiTeammates = (int)s.AiTeammates,
        AiKeeper = (int)s.AiKeeper,
        BallSpeed = s.BallSpeed,
        GameSpeed = s.GameSpeed,
        Replays = s.Replays,
        Celebrations = s.Celebrations,
    };
}
