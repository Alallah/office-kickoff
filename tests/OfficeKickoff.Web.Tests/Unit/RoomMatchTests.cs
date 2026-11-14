using OfficeKickoff.Sim;
using OfficeKickoff.Web.Protocol;
using OfficeKickoff.Web.Rooms;

namespace OfficeKickoff.Web.Tests.Unit;

/// <summary>Drives a <see cref="Room"/> directly, tick by tick, without a server or real time.</summary>
public class RoomMatchTests
{
    private static MatchSettingsDto Quick(int teamSize = 3, int minutes = 1) => new()
    {
        Preset = "custom", TeamSize = teamSize, Minutes = minutes, ScoreLimit = 0, GoldenGoal = false,
        AiTeammates = 1, AiKeeper = 1, BallSpeed = 1f, GameSpeed = 1f, Replays = true, Celebrations = true,
    };

    private static int Controlled(Room room, int human) =>
        room.WithMatch(m => m.State.Players.Count(p => p.Controller == human));

    private static void Ticks(Room room, int count)
    {
        for (int i = 0; i < count; i++) room.Tick();
    }

    [Fact]
    public void A_full_match_ends_with_consistent_results_and_a_rematch_gets_the_next_id()
    {
        var (room, sent, _) = Kit.NewRoom();
        Assert.True(room.Join("ca", Kit.Request("player-ann-1", "Ann", page: "match")).Ok);
        Assert.True(room.Join("cb", Kit.Request("player-ben-1", "Ben", page: "match")).Ok);
        Assert.True(room.Join("cc", Kit.Request("player-cy-01", "Cy", page: "match")).Ok);
        room.SetSettings("ca", Quick());
        room.StartMatch("ca");
        Assert.Equal(Room.Playing, room.Phase);
        int firstMatch = room.MatchId;

        var init = sent.Payloads<MatchInitDto>("MatchInit", "ca").Single();
        Assert.Equal(3, init.Humans.Length);
        Assert.Equal(6, init.Players.Length);
        var cy = init.Humans.Single(h => h.Name == "Cy");

        int seq = 0;
        for (int tick = 0; tick < 600; tick++)
        {
            room.Input("ca", new InputDto { Seq = ++seq, MoveX = 1f, AimX = 2000f, Keys = tick % 50 < 30 ? InputDto.Shoot : 0 });
            room.Tick();
        }

        // Cy walks out mid-match; the results must still show the minutes they played.
        room.Leave("cc");

        int guard = 0;
        while (room.Phase == Room.Playing && guard++ < 60 * 60 * 6)
        {
            room.Input("ca", new InputDto { Seq = ++seq, MoveX = guard % 240 < 120 ? 1f : -1f, AimX = 2000f, Keys = guard % 50 < 30 ? InputDto.Shoot : 0 });
            room.Tick();
        }

        Assert.Equal(Room.Finished, room.Phase);
        var result = room.LastResult!;
        Assert.Equal(firstMatch, result.MatchId);
        Assert.Equal(result.Score[0], result.Goals.Count(g => g.Team == 0));
        Assert.Equal(result.Score[1], result.Goals.Count(g => g.Team == 1));
        Assert.Equal(100, result.Teams[0].Possession + result.Teams[1].Possession);
        Assert.Contains(result.Humans, h => h.MemberId == cy.MemberId && h.Name == "Cy");
        Assert.Equal(3, result.Humans.Length);
        Assert.All(result.Goals, g => Assert.False(string.IsNullOrEmpty(g.Scorer)));
        Assert.Equal(result.Score[0] > result.Score[1] ? 0 : result.Score[1] > result.Score[0] ? 1 : -1, result.Winner);

        // Final snapshot, then MatchEnd, then the room state in the results phase.
        var log = sent.ToArray();
        int end = Array.FindIndex(log, s => s.Method == "MatchEnd");
        Assert.True(end > 0);
        Assert.Equal("Snap", log.Take(end).Last(s => s.Target == "ca").Method);
        Assert.Contains(log.Skip(end), s => s.Method == "RoomState" && ((RoomStateDto)s.Payload!).Phase == Room.Finished);

        room.Rematch("ca");
        Assert.Equal(Room.Playing, room.Phase);
        Assert.Equal(firstMatch + 1, room.MatchId);
        var rematch = sent.Payloads<MatchInitDto>("MatchInit", "ca").Last();
        Assert.Equal(firstMatch + 1, rematch.MatchId);
        Assert.Equal(2, rematch.Humans.Length);
    }

    [Fact]
    public void Presence_follows_input_flow()
    {
        var (room, sent, _) = Kit.NewRoom();
        room.Join("ca", Kit.Request("player-ann-1", "Ann", page: "match"));
        room.StartMatch("ca");

        Ticks(room, 30);
        Assert.Equal(0, Controlled(room, 0));

        room.Input("ca", new InputDto { Seq = 1, MoveX = 1f });
        room.Tick();
        Assert.Equal(1, Controlled(room, 0));

        Ticks(room, HumanSeat.SilenceTicks - 2);
        Assert.Equal(1, Controlled(room, 0));
        room.Tick();
        Assert.Equal(0, Controlled(room, 0));

        room.Input("ca", new InputDto { Seq = 2 });
        Assert.Equal(1, Controlled(room, 0));
        Ticks(room, 2);
        Assert.Equal(2, sent.Payloads<SnapDto>("Snap", "ca").Last().Acks[0]);
    }

    [Fact]
    public void Acks_echo_the_applied_sequence_and_reset_on_a_new_connection()
    {
        var (room, sent, _) = Kit.NewRoom();
        room.Join("ca", Kit.Request("player-ann-1", "Ann", page: "match"));
        room.StartMatch("ca");
        for (int seq = 1; seq <= 10; seq++)
        {
            room.Input("ca", new InputDto { Seq = seq });
            room.Tick();
        }

        Assert.Equal(10, sent.Payloads<SnapDto>("Snap", "ca").Last().Acks[0]);

        room.Join("ca2", Kit.Request("player-ann-1", "Ann", page: "match"));
        Assert.Contains(sent.Sent, s => s.Target == "ca" && s.Method == "Closed" && (string)s.Payload! == "replaced");
        Ticks(room, 2);
        Assert.Equal(0, sent.Payloads<SnapDto>("Snap", "ca2").Last().Acks[0]);

        // The old connection is ignored from now on.
        room.Input("ca", new InputDto { Seq = 50 });
        room.Input("ca2", new InputDto { Seq = 1 });
        Ticks(room, 2);
        Assert.Equal(1, sent.Payloads<SnapDto>("Snap", "ca2").Last().Acks[0]);
        Assert.Equal(1, Controlled(room, 0));
    }

    [Fact]
    public void Snapshots_have_thirteen_numbers_per_footballer_and_come_every_other_tick()
    {
        var (room, sent, _) = Kit.NewRoom();
        room.Join("ca", Kit.Request("player-ann-1", "Ann", page: "match"));
        room.SetSettings("ca", Quick(teamSize: 7));
        room.StartMatch("ca");
        int before = sent.Payloads<SnapDto>("Snap", "ca").Count();
        Ticks(room, 60);
        var snaps = sent.Payloads<SnapDto>("Snap", "ca").Skip(before).ToList();
        Assert.Equal(30, snaps.Count);
        Assert.All(snaps, s =>
        {
            Assert.Equal(14 * SnapDto.PlayerStride, s.Players.Length);
            Assert.Equal(SnapDto.BallLength, s.Ball.Length);
            Assert.All(s.Players, v => Assert.True(float.IsFinite(v)));
        });

        // Every event is delivered exactly once over the stream (the opening phase change at least).
        var events = snaps.Where(s => s.Events is not null).SelectMany(s => s.Events!).ToList();
        Assert.All(events, e => Assert.Equal(Snapshots.EventLength, e.Length));
    }

    [Fact]
    public void A_slow_connection_skips_frames_but_keeps_their_events()
    {
        var stall = new TaskCompletionSource();
        var (room, sent, _) = Kit.NewRoom();
        sent.SnapResult = target => target == "ca" ? stall.Task : null;
        room.Join("ca", Kit.Request("player-ann-1", "Ann", page: "match"));
        room.Join("cb", Kit.Request("player-ben-1", "Ben", page: "match"));
        room.StartMatch("ca");

        Ticks(room, 2);
        Assert.Single(sent.Payloads<SnapDto>("Snap", "ca"));

        // The intro ends (a PhaseChange event) while the first send to "ca" is still stuck.
        int introTicks = (int)(new Tuning().Rules.IntroTime * Tuning.TickRate) + 4;
        Ticks(room, introTicks);
        Assert.Single(sent.Payloads<SnapDto>("Snap", "ca"));
        Assert.True(sent.Payloads<SnapDto>("Snap", "cb").Count() > 10);

        stall.SetResult();
        Ticks(room, 2);
        var toSlow = sent.Payloads<SnapDto>("Snap", "ca").ToList();
        Assert.Equal(2, toSlow.Count);
        var phaseChanges = toSlow.Where(s => s.Events is not null).SelectMany(s => s.Events!)
            .Count(e => (int)e[0] == (int)GameEventType.PhaseChange);
        var phaseChangesFast = sent.Payloads<SnapDto>("Snap", "cb").Where(s => s.Events is not null).SelectMany(s => s.Events!)
            .Count(e => (int)e[0] == (int)GameEventType.PhaseChange);
        Assert.Equal(1, phaseChanges);
        Assert.Equal(phaseChangesFast, phaseChanges);
    }

    [Fact]
    public void Practice_room_starts_inside_the_join_of_its_first_member()
    {
        var (room, sent, _) = Kit.NewRoom(practice: true);
        var join = room.Join("ca", Kit.Request("player-ann-1", "Ann", page: "match"));

        Assert.True(join.Ok);
        Assert.Equal(Room.Playing, join.Room!.Phase);
        Assert.True(join.Room.Practice);
        Assert.NotNull(join.Match);
        Assert.True(join.Match!.Practice);
        Assert.Equal(0, join.Room.Members.Single().Team);
        Assert.Empty(sent.Payloads<MatchInitDto>("MatchInit"));
        Assert.Single(sent.Payloads<SnapDto>("Snap", "ca"));
    }
}
