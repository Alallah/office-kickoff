using Microsoft.AspNetCore.SignalR.Client;
using OfficeKickoff.Web.Protocol;
using OfficeKickoff.Web.Rooms;

namespace OfficeKickoff.Web.Tests.Integration;

public class LobbyHubTests(KickoffFactory factory) : IClassFixture<KickoffFactory>
{
    private string NewRoom() => factory.Rooms.Create(practice: false)!.Code;

    [Fact]
    public async Task Joining_an_unknown_room_is_not_found()
    {
        await using var c = await factory.Connect();
        var result = await c.Join("QQQQ", "Ann");
        Assert.False(result.Ok);
        Assert.Equal("not_found", result.Error);
    }

    [Theory]
    [InlineData("short")]
    [InlineData("")]
    [InlineData("0123456789012345678901234567890123456789012345678901234567890123456789")]
    public async Task A_bad_player_id_is_invalid(string playerId)
    {
        string code = NewRoom();
        await using var c = await factory.Connect(playerId);
        var result = await c.Join(code, "Ann");
        Assert.False(result.Ok);
        Assert.Equal("invalid", result.Error);
    }

    [Fact]
    public async Task Join_creates_a_member_and_returns_room_and_catalog()
    {
        string code = NewRoom();
        await using var c = await factory.Connect();
        var result = await c.Join(code.ToLowerInvariant(), "  Ann  ", color: "#ABCDEF", celebration: "dab");

        Assert.True(result.Ok);
        Assert.Null(result.Match);
        var room = result.Room!;
        Assert.Equal(code, room.Code);
        Assert.Equal(Room.Lobby, room.Phase);
        var me = Assert.Single(room.Members);
        Assert.Equal(result.MemberId, me.Id);
        Assert.Equal("Ann", me.Name);
        Assert.Equal("#abcdef", me.Color);
        Assert.Equal("dab", me.Celebration);
        Assert.Equal(0, me.Team);
        Assert.True(me.IsHost);
        Assert.Equal(me.Id, room.HostId);
        Assert.Equal(2, room.Teams.Length);
        Assert.NotEqual(room.Teams[0].Config.PresetId, room.Teams[1].Config.PresetId);

        var catalog = result.Catalog!;
        Assert.Equal(8, catalog.TeamPresets.Length);
        Assert.Equal(Vocabulary.Crests.Order(), catalog.TeamPresets.Select(t => t.Crest).Order());
        Assert.Equal(new[] { "3", "4", "5", "6", "7" }, catalog.Formations.Keys.Order());
        Assert.All(catalog.TeamPresets, t => Assert.Equal(Vocabulary.RosterSize, t.Roster.Count));
        Assert.Equal(56, catalog.TeamPresets.SelectMany(t => t.Roster).Select(r => r.Name).Distinct().Count());
        Assert.NotEmpty(catalog.SettingsPresets);
    }

    [Fact]
    public async Task Members_fill_the_teams_alternately_and_the_fifth_spectates()
    {
        string code = NewRoom();
        var clients = new List<TestClient>();
        try
        {
            var teams = new List<int>();
            for (int i = 0; i < 5; i++)
            {
                var c = await factory.Connect();
                clients.Add(c);
                var result = await c.Join(code, "P" + i);
                teams.Add(result.Room!.Members.Single(m => m.Id == result.MemberId).Team);
            }

            Assert.Equal(new[] { 0, 1, 0, 1, -1 }, teams);
            Assert.Equal("P0", clients[0].Me?.Name);
        }
        finally
        {
            foreach (var c in clients) await c.DisposeAsync();
        }
    }

    [Fact]
    public async Task Nicknames_are_made_unique_and_empty_ones_get_a_default()
    {
        string code = NewRoom();
        await using var a = await factory.Connect();
        await using var b = await factory.Connect();
        await using var c = await factory.Connect();
        var ra = await a.Join(code, "Alex");
        var rb = await b.Join(code, "alex");
        var rc = await c.Join(code, "\u0007 ");

        Assert.Equal("Alex", ra.Room!.Members.Single(m => m.Id == ra.MemberId).Name);
        Assert.Equal("alex2", rb.Room!.Members.Single(m => m.Id == rb.MemberId).Name);
        Assert.Equal($"Player {rc.MemberId}", rc.Room!.Members.Single(m => m.Id == rc.MemberId).Name);
    }

    [Fact]
    public async Task Team_and_settings_edits_are_validated_and_broadcast()
    {
        string code = NewRoom();
        await using var host = await factory.Connect();
        await using var guest = await factory.Connect();
        await host.Join(code, "Host");
        await guest.Join(code, "Guest");

        var team = TeamRules.Clone(host.Latest!.Teams[0].Config);
        team.Name = "Late Lunch";
        team.Code = "??";
        team.Primary = "not a colour";
        team.Roster[1].Number = team.Roster[2].Number;
        await host.Invoke("SetTeamConfig", 0, team);

        await Wait.True(() => guest.Latest?.Teams[0].Config.Name == "Late Lunch", "guest sees the new team name");
        var seen = guest.Latest!.Teams[0].Config;
        Assert.Equal("LAT", seen.Code);
        Assert.Matches("^#[0-9a-f]{6}$", seen.Primary);
        Assert.Equal(seen.Roster.Count, seen.Roster.Select(r => r.Number).Distinct().Count());

        await host.Invoke("SetSettings", new MatchSettingsDto { Preset = "custom", TeamSize = 42, Minutes = 4, BallSpeed = 9f, GameSpeed = 1f });
        await Wait.True(() => guest.Latest?.Settings.Minutes == 4, "guest sees the new settings");
        Assert.Equal(5, guest.Latest!.Settings.TeamSize);
        Assert.Equal(1f, guest.Latest.Settings.BallSpeed);

        // The guest is on the away team: they may edit it, but not the home team or the settings.
        var away = TeamRules.Clone(guest.Latest.Teams[1].Config);
        away.Name = "Guest United";
        await guest.Invoke("SetTeamConfig", 1, away);
        await Wait.True(() => host.Latest?.Teams[1].Config.Name == "Guest United", "away team edited by its member");

        var home = TeamRules.Clone(guest.Latest.Teams[0].Config);
        home.Name = "Hijacked";
        await guest.Invoke("SetTeamConfig", 0, home);
        await guest.Invoke("SetSettings", new MatchSettingsDto { Preset = "custom", TeamSize = 3, Minutes = 9 });
        await guest.Invoke("StartMatch");
        await Task.Delay(200);

        var state = factory.Rooms.Find(code)!.State();
        Assert.Equal("Late Lunch", state.Teams[0].Config.Name);
        Assert.Equal(4, state.Settings.Minutes);
        Assert.Equal(Room.Lobby, state.Phase);
    }

    [Fact]
    public async Task Team_changes_respect_the_two_human_limit()
    {
        string code = NewRoom();
        await using var a = await factory.Connect();
        await using var b = await factory.Connect();
        await using var c = await factory.Connect();
        await a.Join(code, "A");
        await b.Join(code, "B");
        await c.Join(code, "C");

        int TeamOf(string name) => factory.Rooms.Find(code)!.State().Members.Single(m => m.Name == name).Team;

        // Home already has A and C.
        await b.Invoke("SetTeam", 0);
        await Task.Delay(150);
        Assert.Equal(1, TeamOf("B"));

        await c.Invoke("SetTeam", -1);
        await Wait.True(() => a.Latest?.Members.Single(m => m.Name == "C").Team == -1, "C spectates");
        await b.Invoke("SetTeam", 0);
        await Wait.True(() => a.Latest?.Members.Single(m => m.Name == "B").Team == 0, "B moved home");

        await c.Invoke("SetTeam", 7);
        await Task.Delay(150);
        Assert.Equal(-1, TeamOf("C"));
    }

    [Fact]
    public async Task Chat_is_sanitised_and_rate_limited()
    {
        string code = NewRoom();
        await using var a = await factory.Connect();
        await a.Join(code, "A");
        for (int i = 0; i < 8; i++) await a.Invoke("Chat", $"  hello\u0000 {i}  ");
        await a.Invoke("Chat", "   ");
        await Task.Delay(200);

        var mine = a.Chats.Where(c => !c.System).ToList();
        Assert.Equal(5, mine.Count);
        Assert.Equal("hello 0", mine[0].Text);
        Assert.Equal(a.MemberId, mine[0].MemberId);
    }

    [Fact]
    public async Task Calls_before_joining_are_ignored()
    {
        string code = NewRoom();
        await using var stranger = await factory.Connect();
        await stranger.Invoke("StartMatch");
        await stranger.Invoke("SetSettings", new MatchSettingsDto { Minutes = 9 });
        await stranger.Invoke("Chat", "hi");
        Assert.True(await stranger.Connection.InvokeAsync<long>("Ping") > 0);
        Assert.Equal(Room.Lobby, factory.Rooms.Find(code)!.Phase);
    }
}
