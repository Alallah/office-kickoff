using OfficeKickoff.Sim;
using OfficeKickoff.Web.Protocol;
using OfficeKickoff.Web.Rooms;

namespace OfficeKickoff.Web.Tests.Integration;

public class MatchHubTests(KickoffFactory factory) : IClassFixture<KickoffFactory>
{
    private static int Controller(SnapDto snap, int player) => (int)snap.Players[player * SnapDto.PlayerStride + 10];

    private static int ControlledBy(SnapDto? snap, int human)
    {
        if (snap is null) return -1;
        int n = snap.Players.Length / SnapDto.PlayerStride;
        for (int i = 0; i < n; i++)
        {
            if (Controller(snap, i) == human) return i;
        }

        return -1;
    }

    /// <summary>Runs the room through the intro and kickoff countdown without waiting for them.</summary>
    private static void SkipToOpenPlay(Room room)
    {
        for (int i = 0; i < 2000 && room.WithMatch(m => m.State.Phase) != MatchPhase.Playing; i++) room.Tick();
    }

    [Fact]
    public async Task A_started_match_streams_snapshots_and_hands_footballers_over_by_input_flow()
    {
        var room = factory.Rooms.Create(practice: false)!;
        await using var host = await factory.Connect();
        await using var guest = await factory.Connect();
        Assert.True((await host.Join(room.Code, "Host", page: "match")).Ok);
        Assert.True((await guest.Join(room.Code, "Guest", page: "match")).Ok);

        await host.Invoke("StartMatch");
        await Wait.True(() => !host.Inits.IsEmpty && !guest.Inits.IsEmpty, "both match pages get MatchInit");
        var init = host.Inits.Single();
        Assert.Equal(2, init.Humans.Length);
        Assert.Equal(room.MatchId, init.MatchId);
        int humanId = init.Humans.Single(h => h.MemberId == host.MemberId).HumanId;
        Assert.Equal(0, humanId);
        await Wait.True(() => host.Latest?.Phase == Room.Playing, "room state says match");

        // About 30 snapshots a second, 13 numbers per footballer.
        await Wait.True(() => host.SnapCount > 0, "snapshots start");
        int before = host.SnapCount;
        await Task.Delay(1000);
        int perSecond = host.SnapCount - before;
        Assert.InRange(perSecond, 20, 40);
        Assert.All(host.Snaps, s => Assert.Equal(init.Players.Length * SnapDto.PlayerStride, s.Players.Length));

        // Nobody is at the controls before their first input.
        Assert.All(host.Snaps, s => Assert.Equal(-1, ControlledBy(s, humanId)));

        SkipToOpenPlay(room);
        var stream = host.Stream(TimeSpan.FromSeconds(1.2), 1f, 0f);
        await Wait.True(() => ControlledBy(host.LastSnap, humanId) >= 0, "input seats the sender");
        int footballer = ControlledBy(host.LastSnap, humanId);
        float startX = host.LastSnap!.Players[footballer * SnapDto.PlayerStride];
        await stream;
        await Wait.True(() => host.LastSnap!.Acks[humanId] >= host.LastSeq - 4, "ack catches up with the inputs");
        var moved = host.LastSnap!;
        int now = ControlledBy(moved, humanId);
        Assert.True(now >= 0);
        if (now == footballer) Assert.True(moved.Players[footballer * SnapDto.PlayerStride] > startX + 50f, "footballer ran right");
        Assert.True(moved.Acks[humanId] > 0);

        // Silence hands the footballer to the AI ...
        await Wait.True(() => ControlledBy(host.LastSnap, humanId) < 0, "AI takes over after two silent seconds", 4000);

        // ... and the next inputs bring the player back.
        var resume = host.Stream(TimeSpan.FromSeconds(0.6), 0f, 1f);
        await Wait.True(() => ControlledBy(host.LastSnap, humanId) >= 0, "resuming inputs returns the footballer");
        await resume;

        // A new connection for the same player starts acking from zero.
        await using var reload = await factory.Connect(host.PlayerId);
        var rejoin = await reload.Join(room.Code, "Host", page: "match");
        Assert.True(rejoin.Ok);
        Assert.NotNull(rejoin.Match);
        Assert.Equal(init.MatchId, rejoin.Match!.MatchId);
        await Wait.True(() => reload.SnapCount > 2, "reloaded page gets snapshots");
        Assert.Equal(0, reload.LastSnap!.Acks[humanId]);
        await Wait.True(() => host.Closed.Contains("replaced"), "old page is told it was replaced");

        await reload.Invoke("BackToLobby");
        await Wait.True(() => guest.Latest?.Phase == Room.Lobby, "everyone is back in the lobby");
        Assert.All(guest.Latest!.Members, m => Assert.Equal(-1, m.HumanId));
    }

    [Fact]
    public async Task A_practice_room_starts_inside_the_join()
    {
        var room = factory.Rooms.Create(practice: true)!;
        await using var solo = await factory.Connect();
        var result = await solo.Join(room.Code, "Solo", page: "match");

        Assert.True(result.Ok);
        Assert.Equal(Room.Playing, result.Room!.Phase);
        Assert.True(result.Room.Practice);
        Assert.NotNull(result.Match);
        Assert.True(result.Match!.Practice);
        Assert.Single(result.Match.Humans);

        await Wait.True(() => solo.SnapCount > 5, "snapshots flow");
        Assert.Empty(solo.Inits);
    }

    [Fact]
    public async Task Replacing_a_connection_keeps_the_member_and_their_footballer()
    {
        var room = factory.Rooms.Create(practice: false)!;
        await using var watcher = await factory.Connect();
        await using var first = await factory.Connect();
        var joined = await first.Join(room.Code, "Ann", page: "match", color: "#123456");
        await watcher.Join(room.Code, "Watcher");
        await first.Invoke("StartMatch");
        await Wait.True(() => !first.Inits.IsEmpty, "match starts");
        SkipToOpenPlay(room);

        await first.Stream(TimeSpan.FromSeconds(0.3), 1f, 0f);
        await Wait.True(() => ControlledBy(first.LastSnap, 0) >= 0, "first connection controls a footballer");
        int systemBefore = watcher.Chats.Count(c => c.System);

        // Same player, second connection (a reload): profile fields of the request are ignored.
        var second = await factory.Connect(first.PlayerId);
        await using var _ = second;
        var rejoin = await second.Join(room.Code, "Someone Else", page: "match", color: "#ffffff");
        Assert.True(rejoin.Ok);
        Assert.Equal(joined.MemberId, rejoin.MemberId);
        var me = rejoin.Room!.Members.Single(m => m.Id == rejoin.MemberId);
        Assert.Equal("Ann", me.Name);
        Assert.Equal("#123456", me.Color);
        Assert.Equal(2, rejoin.Room.Members.Length);
        await Wait.True(() => first.Closed.Contains("replaced"), "first connection told replaced");

        // The old connection closing late does not count as a disconnect.
        await first.DisposeAsync();
        var stream = second.Stream(TimeSpan.FromSeconds(1), 0f, 1f);
        await Task.Delay(500);
        Assert.True(factory.Rooms.Find(room.Code)!.State().Members.Single(m => m.Id == joined.MemberId).Connected);
        await stream;
        Assert.True(ControlledBy(second.LastSnap, 0) >= 0, "still at the controls on the new connection");

        await Task.Delay(200);
        Assert.Equal(systemBefore, watcher.Chats.Count(c => c.System));
    }
}
