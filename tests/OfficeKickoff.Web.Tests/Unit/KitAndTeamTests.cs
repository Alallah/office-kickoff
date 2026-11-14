using OfficeKickoff.Sim;
using OfficeKickoff.Web.Protocol;
using OfficeKickoff.Web.Rooms;

namespace OfficeKickoff.Web.Tests.Unit;

public class KitResolverTests
{
    private static TeamConfigDto Team(string primary, string secondary, string keeper)
    {
        var t = Kit.ValidTeam();
        t.Primary = primary;
        t.Secondary = secondary;
        t.Keeper = keeper;
        return t;
    }

    [Fact]
    public void Distinct_kits_are_kept()
    {
        var kits = KitResolver.Resolve(Team("#d7263d", "#ffffff", "#22b8a6"), Team("#1e2a5a", "#ff2e88", "#b6ff3c"));
        Assert.Equal("#d7263d", kits[0].Primary);
        Assert.Equal("#ffffff", kits[0].Secondary);
        Assert.False(kits[0].Swapped);
        Assert.Equal("#1e2a5a", kits[1].Primary);
        Assert.False(kits[1].Swapped);
        Assert.Equal("#22b8a6", kits[0].Keeper);
        Assert.Equal("#b6ff3c", kits[1].Keeper);
    }

    [Fact]
    public void Clashing_away_team_wears_its_secondary_with_its_primary_as_trim()
    {
        var kits = KitResolver.Resolve(Team("#d7263d", "#ffffff", "#22b8a6"), Team("#c8203a", "#ffcd1f", "#2ec4e6"));
        Assert.Equal("#d7263d", kits[0].Primary);
        Assert.Equal("#ffcd1f", kits[1].Primary);
        Assert.Equal("#c8203a", kits[1].Secondary);
        Assert.True(kits[1].Swapped);
    }

    [Fact]
    public void When_both_away_colours_clash_a_fallback_shirt_is_used()
    {
        var kits = KitResolver.Resolve(Team("#d7263d", "#ffffff", "#22b8a6"), Team("#d02a40", "#da2440", "#2ec4e6"));
        Assert.True(kits[1].Swapped);
        Assert.Contains(kits[1].Primary, KitResolver.OutfieldFallbacks);
        Assert.True(KitResolver.Distance(kits[0].Primary, kits[1].Primary) >= KitResolver.ShirtClash);
    }

    [Fact]
    public void A_shirt_that_disappears_into_the_grass_is_replaced()
    {
        var kits = KitResolver.Resolve(Team("#186239", "#ffffff", "#ffd60a"), Team("#1e2a5a", "#ff2e88", "#b6ff3c"));
        Assert.Equal("#ffffff", kits[0].Primary);
        Assert.True(KitResolver.Distance(kits[0].Primary, KitResolver.PitchColor) >= KitResolver.PitchClash);
    }

    [Fact]
    public void Keeper_shirt_never_looks_like_either_outfield_kit_or_the_pitch()
    {
        var kits = KitResolver.Resolve(Team("#d7263d", "#ffffff", "#1e2a5a"), Team("#1e2a5a", "#ff2e88", "#d7263d"));
        foreach (var kit in kits)
        {
            Assert.True(KitResolver.Distance(kit.Keeper, kits[0].Primary) >= KitResolver.KeeperClash);
            Assert.True(KitResolver.Distance(kit.Keeper, kits[1].Primary) >= KitResolver.KeeperClash);
            Assert.True(KitResolver.Distance(kit.Keeper, KitResolver.PitchColor) >= KitResolver.KeeperClash);
        }
    }

    [Theory]
    [InlineData("#ffffff", "#111111")]
    [InlineData("#ffcd1f", "#111111")]
    [InlineData("#1e2a5a", "#ffffff")]
    [InlineData("#d7263d", "#ffffff")]
    public void Text_colour_contrasts_with_the_shirt(string shirt, string text) =>
        Assert.Equal(text, KitResolver.TextOn(shirt));

    [Fact]
    public void Every_pair_of_presets_plays_in_its_own_colours_and_no_preset_is_pitch_green()
    {
        var presets = Kit.Catalog.Dto.TeamPresets;
        foreach (var a in presets)
        {
            Assert.True(KitResolver.Distance(a.Primary, KitResolver.PitchColor) >= KitResolver.PitchClash, a.Name);
            Assert.True(KitResolver.Distance(a.Primary, a.Secondary) >= KitResolver.ShirtClash, a.Name + " secondary");
            Assert.True(KitResolver.Distance(a.Keeper, a.Primary) >= KitResolver.KeeperClash, a.Name + " keeper");
            Assert.True(KitResolver.Distance(a.Keeper, a.Secondary) >= KitResolver.KeeperClash * 0.5, a.Name + " keeper/secondary");
            foreach (var b in presets)
            {
                if (a == b) continue;
                Assert.True(KitResolver.Distance(a.Primary, b.Primary) >= KitResolver.ShirtClash, $"{a.Name} vs {b.Name}");
                var kits = KitResolver.Resolve(a, b);
                Assert.False(kits[0].Swapped);
                Assert.False(kits[1].Swapped);
            }
        }
    }
}

public class TeamRulesTests
{
    private static TeamConfigDto Fallback => Kit.ValidTeam();

    [Fact]
    public void Invalid_fields_fall_back_and_the_code_is_derived_from_the_name()
    {
        var input = new TeamConfigDto
        {
            PresetId = "not-a-preset",
            Name = "  The ‮mighty\u0007   Staplers  ",
            Code = "toolong",
            Primary = "red",
            Secondary = "#12345",
            Keeper = "#ABCDEF",
            Crest = "skull",
            Formation = "9-9-9",
            Roster = [],
        };

        var team = TeamRules.Normalize(input, Fallback, Kit.Catalog.IsPresetId);

        Assert.Null(team.PresetId);
        Assert.Equal("The mighty Staplers", team.Name);
        Assert.Equal("TMS", team.Code);
        Assert.Equal(Fallback.Primary, team.Primary);
        Assert.Equal(Fallback.Secondary, team.Secondary);
        Assert.Equal("#abcdef", team.Keeper);
        Assert.Equal(Fallback.Crest, team.Crest);
        Assert.Equal(Fallback.Formation, team.Formation);
        Assert.Equal(Vocabulary.RosterSize, team.Roster.Count);
        Assert.Equal(Fallback.Roster.Select(r => r.Name), team.Roster.Select(r => r.Name));
    }

    [Fact]
    public void Valid_values_are_kept_including_a_formation_for_another_team_size()
    {
        var input = Kit.ValidTeam();
        input.Name = "Night Shift";
        input.Code = "nsx";
        input.Formation = "2-3-1"; // 7-a-side only
        input.Crest = "crown";

        var team = TeamRules.Normalize(input, Fallback, Kit.Catalog.IsPresetId);

        Assert.Equal(input.PresetId, team.PresetId);
        Assert.Equal("NSX", team.Code);
        Assert.Equal("2-3-1", team.Formation);
        Assert.Equal("crown", team.Crest);
        Assert.Equal(Formations.Default(5), Formations.Resolve(team.Formation, 5));
    }

    [Fact]
    public void Roster_is_exactly_seven_with_short_names_and_distinct_numbers()
    {
        var input = Kit.ValidTeam();
        input.Roster =
        [
            new RosterEntryDto { Name = "A very very long footballer name indeed", Number = 7 },
            new RosterEntryDto { Name = "Twin", Number = 7 },
            new RosterEntryDto { Name = "", Number = 0 },
            new RosterEntryDto { Name = "Big", Number = 150 },
            null!,
            new RosterEntryDto { Name = "Six", Number = 6 },
            new RosterEntryDto { Name = "Seven", Number = 9 },
            new RosterEntryDto { Name = "Extra", Number = 99 },
        ];

        var team = TeamRules.Normalize(input, Fallback, Kit.Catalog.IsPresetId);

        Assert.Equal(Vocabulary.RosterSize, team.Roster.Count);
        Assert.All(team.Roster, r => Assert.InRange(r.Name.Length, 1, Vocabulary.MaxRosterName));
        Assert.All(team.Roster, r => Assert.InRange(r.Number, 1, 99));
        Assert.Equal(team.Roster.Count, team.Roster.Select(r => r.Number).Distinct().Count());
        Assert.Equal(7, team.Roster[0].Number);
        Assert.Equal("Twin", team.Roster[1].Name);
        Assert.Equal(Fallback.Roster[2].Name, team.Roster[2].Name);
    }

    [Theory]
    [InlineData("Inbox Zero FC", "IZF")]
    [InlineData("Wi-Fi Rangers", "WFR")]
    [InlineData("Ace", "ACE")]
    [InlineData("Jo", "JOX")]
    [InlineData("Équipe", "EQU")]
    [InlineData("!!!", "XXX")]
    public void Codes_are_derived_from_names(string name, string code) => Assert.Equal(code, TeamRules.DeriveCode(name));

    [Fact]
    public void Settings_fall_back_to_defaults_and_lose_a_preset_label_they_no_longer_match()
    {
        var settings = TeamRules.FromDto(new MatchSettingsDto
        {
            Preset = "coffee", TeamSize = 99, Minutes = 7, ScoreLimit = -3, AiTeammates = 9, AiKeeper = 2,
            BallSpeed = float.NaN, GameSpeed = 1.25f,
        });

        Assert.Equal(5, settings.TeamSize);
        Assert.Equal(7, settings.Minutes);
        Assert.Equal(0, settings.ScoreLimit);
        Assert.Equal(AiLevel.Normal, settings.AiTeammates);
        Assert.Equal(AiLevel.Hard, settings.AiKeeper);
        Assert.Equal(1f, settings.BallSpeed);
        Assert.Equal(1.25f, settings.GameSpeed);
        Assert.Equal("custom", settings.Preset);

        var chaos = TeamRules.FromDto(TeamRules.ToDto(MatchSettings.FromPreset("chaos")));
        Assert.Equal("chaos", chaos.Preset);
    }
}

public class TextAndCodeTests
{
    [Theory]
    [InlineData("  Alex  ", 16, "Alex")]
    [InlineData("A\u0000l\u0001e‮x", 16, "Alex")]
    [InlineData("Ann   Marie", 16, "Ann Marie")]
    [InlineData("abcdefghijklmnopqrstuvwxyz", 16, "abcdefghijklmnop")]
    [InlineData(null, 16, "")]
    [InlineData("\t\n\r", 16, "")]
    public void Clean_strips_control_characters_collapses_spaces_and_cuts(string? input, int max, string expected) =>
        Assert.Equal(expected, TextRules.Clean(input, max));

    [Fact]
    public void Clean_never_splits_an_emoji() =>
        Assert.Equal("abc", TextRules.Clean("abc\U0001F525", 4));

    [Fact]
    public void Unique_appends_a_number_and_stays_within_the_limit()
    {
        Assert.Equal("Alex2", TextRules.Unique("Alex", ["alex"], 16));
        Assert.Equal("Alex3", TextRules.Unique("Alex", ["Alex", "Alex2"], 16));
        Assert.Equal("abcdefghijklmno2", TextRules.Unique("abcdefghijklmnop", ["abcdefghijklmnop"], 16));
    }

    [Fact]
    public void Room_codes_use_the_safe_alphabet_and_are_never_rude()
    {
        for (int i = 0; i < 2000; i++)
        {
            string code = RoomCodes.Random();
            Assert.Equal(4, code.Length);
            Assert.All(code, c => Assert.Contains(c, RoomCodes.Alphabet));
            Assert.DoesNotContain('I', code);
            Assert.DoesNotContain('O', code);
        }

        Assert.False(RoomCodes.IsAcceptable("FUCK"));
        Assert.False(RoomCodes.IsAcceptable("ASSE"));
        Assert.True(RoomCodes.IsAcceptable("KCKF"));
        Assert.Equal("ABCD", RoomCodes.Normalize(" abcd "));
        Assert.Null(RoomCodes.Normalize("AB1D"));
    }
}
