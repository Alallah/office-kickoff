using System.Text.Json;
using OfficeKickoff.Sim;
using OfficeKickoff.Web.Protocol;
using OfficeKickoff.Web.Rooms;

namespace OfficeKickoff.Web.Services;

/// <summary>
/// The team presets (Data/teams.json) and the rest of the static lobby reference data, loaded
/// once at start-up. Everything handed out is either immutable or a fresh copy.
/// </summary>
public sealed class TeamCatalog
{
    public const string FileName = "teams.json";

    private readonly TeamConfigDto[] _presets;
    private readonly HashSet<string> _ids;

    public TeamCatalog(IEnumerable<TeamConfigDto> presets)
    {
        var list = new List<TeamConfigDto>();
        var ids = new HashSet<string>(StringComparer.Ordinal);
        var emergency = Emergency();
        foreach (var raw in presets)
        {
            if (raw?.PresetId is not { Length: > 0 } id || !ids.Add(id)) continue;
            var team = TeamRules.Normalize(raw, emergency, _ => false);
            team.PresetId = id;
            list.Add(team);
        }

        if (list.Count < 2) throw new InvalidOperationException("The team catalogue needs at least two presets with distinct ids.");

        _presets = list.ToArray();
        _ids = ids;
        Dto = new CatalogDto
        {
            TeamPresets = _presets,
            Formations = Enumerable.Range(MatchSettings.MinTeamSize, MatchSettings.MaxTeamSize - MatchSettings.MinTeamSize + 1)
                .ToDictionary(size => size.ToString(System.Globalization.CultureInfo.InvariantCulture),
                    size => Formations.ValidFor(size).ToArray()),
            SettingsPresets = MatchSettings.Presets.Select(p => new SettingsPresetDto
            {
                Id = p.Id,
                Label = p.Label,
                Description = p.Description,
                Settings = TeamRules.ToDto(p.Settings.Normalized()),
            }).ToArray(),
        };
    }

    /// <summary>Shared reference data for <see cref="JoinResult.Catalog"/>. Never modify it.</summary>
    public CatalogDto Dto { get; }

    public int Count => _presets.Length;

    public bool IsPresetId(string? id) => id is not null && _ids.Contains(id);

    /// <summary>A private copy of preset <paramref name="index"/>.</summary>
    public TeamConfigDto Preset(int index) => TeamRules.Clone(_presets[index]);

    /// <summary>Loads Data/teams.json from the content root, or from next to the binaries.</summary>
    public static TeamCatalog Load(string contentRoot, ILogger logger)
    {
        string[] candidates =
        [
            Path.Combine(contentRoot, "Data", FileName),
            Path.Combine(AppContext.BaseDirectory, "Data", FileName),
        ];

        string? path = candidates.FirstOrDefault(File.Exists)
            ?? throw new FileNotFoundException($"Team presets not found; looked for {string.Join(" and ", candidates)}.");

        var options = new JsonSerializerOptions(JsonSerializerDefaults.Web)
        {
            ReadCommentHandling = JsonCommentHandling.Skip,
            AllowTrailingCommas = true,
        };
        var presets = JsonSerializer.Deserialize<List<TeamConfigDto>>(File.ReadAllText(path), options)
            ?? throw new InvalidDataException($"{path} does not contain a list of teams.");

        var catalog = new TeamCatalog(presets);
        logger.LogInformation("Loaded {Count} team presets from {Path}", catalog.Count, path);
        return catalog;
    }

    /// <summary>Last-resort values for fields a preset file gets wrong.</summary>
    private static TeamConfigDto Emergency() => new()
    {
        Name = "Office XI",
        Code = "OXI",
        Primary = "#3b82f6",
        Secondary = "#ffffff",
        Keeper = "#ffd166",
        Crest = Vocabulary.Crests[0],
        Formation = Formations.Default(5),
        Roster = Enumerable.Range(1, Vocabulary.RosterSize)
            .Select(n => new RosterEntryDto { Name = $"Player {n}", Number = n }).ToList(),
    };
}
