using OfficeKickoff.Web.Protocol;
using OfficeKickoff.Web.Rooms;

namespace OfficeKickoff.Web.Tests.Integration;

/// <summary>Moves the server clock by hand, so it has a server (class fixture) of its own.</summary>
public class HostHandoverTests(KickoffFactory factory) : IClassFixture<KickoffFactory>
{
    [Fact]
    public async Task A_host_who_vanishes_on_the_results_screen_is_replaced_and_the_new_host_can_rematch()
    {
        var room = factory.Rooms.Create(practice: false)!;
        var host = await factory.Connect();
        await using var guest = await factory.Connect();
        await host.Join(room.Code, "Host", page: "match");
        await guest.Join(room.Code, "Guest", page: "match");

        await host.Invoke("SetSettings", new MatchSettingsDto
        {
            Preset = "custom", TeamSize = 3, Minutes = 1, GoldenGoal = false, AiTeammates = 1, AiKeeper = 1,
            BallSpeed = 1f, GameSpeed = 1f, Replays = false, Celebrations = false,
        });
        await host.Invoke("StartMatch");
        await Wait.True(() => !guest.Inits.IsEmpty, "match starts");
        int firstMatch = guest.Inits.Single().MatchId;

        // Play the whole match at full speed from the test thread.
        for (int i = 0; i < 60 * 60 * 5 && room.Phase == Room.Playing; i++) room.Tick();
        Assert.Equal(Room.Finished, room.Phase);
        await Wait.True(() => !guest.Ends.IsEmpty && guest.Latest?.Phase == Room.Finished, "guest sees the results");
        Assert.Equal(firstMatch, guest.Ends.Single().MatchId);

        // The host closes the laptop.
        await host.DisposeAsync();
        await Wait.True(() => guest.Latest?.Members.Single(m => m.Id == host.MemberId).Connected == false, "host shown as disconnected");
        factory.Rooms.Housekeep();
        Assert.Equal(host.MemberId, room.State().HostId);

        factory.Clock.Advance(Room.HostGrace + TimeSpan.FromSeconds(1));
        factory.Rooms.Housekeep();
        await Wait.True(() => guest.Latest?.HostId == guest.MemberId, "guest became host");
        Assert.Contains(guest.Latest!.Members, m => m.Id == host.MemberId);
        await Wait.True(() => guest.Chats.Any(c => c.System && c.Text.Contains("now the host")), "hand-over announced");
        Assert.Contains(guest.Chats, c => c.System && c.Text.Contains("lost connection"));

        await guest.Invoke("Rematch");
        await Wait.True(() => guest.Inits.Count == 2, "rematch starts");
        Assert.Equal(firstMatch + 1, guest.Inits.Last().MatchId);
        Assert.Equal(Room.Playing, room.Phase);

        // The old host keeps their seat in the rematch, waiting for their inputs.
        Assert.Contains(guest.Inits.Last().Humans, h => h.MemberId == host.MemberId);
    }

    [Fact]
    public async Task Disconnected_lobby_members_are_removed_and_empty_rooms_deleted()
    {
        var room = factory.Rooms.Create(practice: false)!;
        var leaver = await factory.Connect();
        await using var stayer = await factory.Connect();
        await stayer.Join(room.Code, "Stayer");
        await leaver.Join(room.Code, "Leaver");

        await leaver.DisposeAsync();
        await Wait.True(() => room.State().Members.Any(m => m is { Name: "Leaver", Connected: false }), "leaver disconnected");

        factory.Clock.Advance(Room.LobbyGrace + TimeSpan.FromSeconds(1));
        factory.Rooms.Housekeep();
        await Wait.True(() => stayer.Latest?.Members.Length == 1, "leaver removed after the lobby grace");

        await stayer.Invoke("Leave");
        Assert.Empty(room.State().Members);
        factory.Clock.Advance(Room.EmptyLifetime + TimeSpan.FromSeconds(1));
        factory.Rooms.Housekeep();
        factory.Rooms.Housekeep();
        Assert.Null(factory.Rooms.Find(room.Code));
        Assert.True(room.IsClosed);
    }
}
