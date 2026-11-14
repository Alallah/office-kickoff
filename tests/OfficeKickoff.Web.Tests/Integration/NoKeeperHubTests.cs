using OfficeKickoff.Web.Protocol;

namespace OfficeKickoff.Web.Tests.Integration;

public class NoKeeperHubTests(KickoffFactory factory) : IClassFixture<KickoffFactory>
{
    [Fact]
    public async Task Goalkeepers_off_travels_over_the_hub_to_every_page()
    {
        var room = factory.Rooms.Create(practice: false)!;
        await using var host = await factory.Connect();
        await using var guest = await factory.Connect();
        Assert.True((await host.Join(room.Code, "Host", page: "match")).Ok);
        Assert.True((await guest.Join(room.Code, "Guest", page: "match")).Ok);
        Assert.True(guest.Latest!.Settings.Keepers);

        await host.Invoke("SetSettings", new MatchSettingsDto { Preset = "custom", TeamSize = 6, Keepers = false, Minutes = 3, BallSpeed = 1f, GameSpeed = 1f });
        await Wait.True(() => guest.Latest?.Settings.Keepers == false, "guest sees goalkeepers switched off");
        Assert.Equal(6, guest.Latest!.Settings.TeamSize);

        await host.Invoke("StartMatch");
        await Wait.True(() => !guest.Inits.IsEmpty, "guest gets MatchInit");
        var init = guest.Inits.Single();
        Assert.False(init.Settings.Keepers);
        Assert.Equal(12, init.Players.Length);
        Assert.All(init.Players, p => Assert.False(p.Keeper));
        Assert.True(init.Pitch.GoalWidth < init.Tuning.Pitch.GoalWidth.Get(6));
    }
}
