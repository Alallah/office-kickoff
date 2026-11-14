using System.Text.Json;
using OfficeKickoff.Sim;
using OfficeKickoff.Web.Protocol;
using OfficeKickoff.Web.Rooms;

namespace OfficeKickoff.Web.Tests.Unit;

/// <summary>The "Goalkeepers" match setting from the lobby to the match.</summary>
public class NoKeeperRoomTests
{
    private static MatchSettingsDto Rules(bool keepers, int teamSize = 5) => new()
    {
        Preset = "custom", TeamSize = teamSize, Keepers = keepers, Minutes = 2, ScoreLimit = 0, GoldenGoal = true,
        AiTeammates = 1, AiKeeper = 2, BallSpeed = 1f, GameSpeed = 1f, Replays = true, Celebrations = true,
    };

    [Fact]
    public void The_setting_maps_both_ways_and_defaults_to_on()
    {
        Assert.True(new MatchSettingsDto().Keepers);
        Assert.True(TeamRules.FromDto(null).Keepers);
        Assert.False(TeamRules.FromDto(Rules(keepers: false)).Keepers);
        Assert.False(TeamRules.ToDto(TeamRules.FromDto(Rules(keepers: false))).Keepers);
        Assert.True(TeamRules.ToDto(TeamRules.FromDto(Rules(keepers: true))).Keepers);

        // A client that does not know the field yet keeps goalkeepers.
        var old = JsonSerializer.Deserialize<MatchSettingsDto>("""{"preset":"custom","teamSize":4,"minutes":2}""", JsonSerializerOptions.Web)!;
        Assert.True(old.Keepers);
        Assert.Contains("\"keepers\":false", JsonSerializer.Serialize(Rules(keepers: false), JsonSerializerOptions.Web));
    }

    [Fact]
    public void Switching_goalkeepers_off_makes_a_preset_custom()
    {
        var classic = TeamRules.ToDto(MatchSettings.FromPreset("classic"));
        Assert.True(classic.Keepers);
        Assert.Equal("classic", TeamRules.FromDto(classic).Preset);

        classic.Keepers = false;
        var edited = TeamRules.FromDto(classic);
        Assert.Equal("custom", edited.Preset);
        Assert.False(edited.Keepers);
    }

    [Fact]
    public void Set_settings_carries_the_setting_into_the_lobby_state_and_the_match()
    {
        var (room, sent, _) = Kit.NewRoom();
        Assert.True(room.Join("ca", Kit.Request("player-ann-1", "Ann", page: "match")).Ok);
        Assert.True(room.Join("cb", Kit.Request("player-ben-1", "Ben", page: "match")).Ok);

        room.SetSettings("ca", Rules(keepers: false, teamSize: 4));
        Assert.False(room.State().Settings.Keepers);
        Assert.False(sent.Payloads<RoomStateDto>("RoomState").Last().Settings.Keepers);

        // Only the host decides.
        room.SetSettings("cb", Rules(keepers: true, teamSize: 4));
        Assert.False(room.State().Settings.Keepers);

        room.StartMatch("ca");
        Assert.Equal(Room.Playing, room.Phase);
        var init = sent.Payloads<MatchInitDto>("MatchInit", "ca").Single();
        var tuning = new Tuning();
        Assert.False(init.Settings.Keepers);
        Assert.Equal(8, init.Players.Length);
        Assert.All(init.Players, p => Assert.False(p.Keeper, $"footballer {p.Index} is sent as a keeper"));
        Assert.Contains(init.Players, p => p.Slot == 0 && p.Team == 0);
        Assert.Equal(tuning.Pitch.GoalWidth.Get(4) * tuning.Pitch.NoKeeperGoalScale, init.Pitch.GoalWidth, 3);
        Assert.True(room.WithMatch(m => !m.Config.Settings.Keepers && m.State.Players.All(p => !p.IsKeeper)));

        // A late joiner's page gets the same description of the match.
        var late = room.Join("cc", Kit.Request("player-cy-01", "Cy", page: "match"));
        Assert.True(late.Ok);
        Assert.NotNull(late.Match);
        Assert.False(late.Match!.Settings.Keepers);
        Assert.All(late.Match.Players, p => Assert.False(p.Keeper));

        // Back in the lobby, goalkeepers on again: slot 0 of each team is the keeper once more.
        room.BackToLobby("ca");
        Assert.Equal(Room.Lobby, room.Phase);
        Assert.False(room.State().Settings.Keepers);
        room.SetSettings("ca", Rules(keepers: true, teamSize: 4));
        room.StartMatch("ca");
        var again = sent.Payloads<MatchInitDto>("MatchInit", "ca").Last();
        Assert.True(again.Settings.Keepers);
        Assert.Equal(new[] { 0, 4 }, again.Players.Where(p => p.Keeper).Select(p => p.Index));
        Assert.Equal(tuning.Pitch.GoalWidth.Get(4), again.Pitch.GoalWidth, 3);
    }

    [Fact]
    public void A_match_without_keepers_plays_to_the_end_in_a_room()
    {
        var (room, sent, _) = Kit.NewRoom();
        room.Join("ca", Kit.Request("player-ann-1", "Ann", page: "match"));
        var rules = Rules(keepers: false, teamSize: 3);
        rules.Minutes = 1;
        rules.GoldenGoal = false;
        room.SetSettings("ca", rules);
        room.StartMatch("ca");

        int seq = 0, guard = 0;
        while (room.Phase == Room.Playing && guard++ < 60 * 60 * 4)
        {
            room.Input("ca", new InputDto { Seq = ++seq, MoveX = guard % 240 < 120 ? 1f : -1f, AimX = 2000f, Keys = guard % 50 < 30 ? InputDto.Shoot : 0 });
            room.Tick();
        }

        Assert.Equal(Room.Finished, room.Phase);
        var events = sent.Payloads<SnapDto>("Snap", "ca").Where(s => s.Events is not null).SelectMany(s => s.Events!).ToList();
        Assert.DoesNotContain(events, e => (int)e[0] is (int)GameEventType.KeeperCatch or (int)GameEventType.KeeperParry or (int)GameEventType.Dive);
        Assert.All(sent.Payloads<SnapDto>("Snap", "ca"), s => Assert.Equal(0, (int)s.Ball[7] & 1));
    }
}
