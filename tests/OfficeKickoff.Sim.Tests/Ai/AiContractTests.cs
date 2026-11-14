using OfficeKickoff.Sim.Ai;
using static OfficeKickoff.Sim.Tests.TestKit;

namespace OfficeKickoff.Sim.Tests.Ai;

/// <summary>The AI's side of the IAiDirector contract: read-only, only its own footballers, always finite.</summary>
public class AiContractTests
{
    [Fact]
    public void The_default_director_is_the_real_ai()
    {
        var c = new MatchConfig { Settings = new MatchSettings().Normalized() };
        var m = new Match(c, new Tuning(), seed: 3);
        RunToPlaying(m);
        Vec2 start = P(m, Index(m, 1, 1)).Pos;
        Step(m, Ticks(3f));
        Assert.True(m.Stats.Teams[0].PassesAttempted + m.Stats.Teams[1].PassesAttempted + m.Stats.Teams[0].Steals +
                    m.Stats.Teams[1].Steals > 0 || Vec2.Distance(start, P(m, Index(m, 1, 1)).Pos) > 50f);
    }

    [Fact]
    public void Think_writes_only_ai_footballers_and_never_touches_the_state()
    {
        var m = AiHarness.NewMatch(6, 21);
        Assert.True(m.AddHuman(0, 0, true) >= 0);
        Assert.True(m.AddHuman(3, 1, true) >= 0);
        var ai = new AiDirector();
        var ctx = AiScene.Context(m);
        ai.Reset(ctx);

        var sentinel = new PlayerInput { Move = new Vec2(0.123f, 0.456f), AimPoint = new Vec2(-777f, 555f), Pass = true, Sprint = true };
        var rng = new Random(4);
        var held = new PlayerInput[4];
        for (int t = 0; t < 2500; t++)
        {
            foreach (var h in m.State.Humans)
            {
                if (!h.Present || h.PlayerIndex < 0) continue;
                Mash(rng, m.State, m.Pitch, h.PlayerIndex, ref held[h.Id]);
                m.SetInput(h.Id, held[h.Id]);
            }

            m.Step();
            if (m.State.Phase is not (MatchPhase.Playing or MatchPhase.GoalScored)) continue;

            var players = m.State.Players.ToArray();
            var ball = m.State.Ball;
            var inputs = new PlayerInput[players.Length];
            Array.Fill(inputs, sentinel);
            ai.Think(ctx, inputs, Dt);

            Assert.Equal(players, m.State.Players);
            Assert.Equal(ball, m.State.Ball);
            for (int i = 0; i < players.Length; i++)
            {
                if (players[i].Controller >= 0)
                {
                    Assert.Equal(sentinel, inputs[i]);
                    continue;
                }

                Assert.True(inputs[i].Move.IsFinite && inputs[i].AimPoint.IsFinite, $"footballer {i} got non-finite controls");
                Assert.True(inputs[i].Move.Length <= 1.0001f);
                Assert.False(inputs[i].SwitchBest || inputs[i].SwitchNext);
            }
        }
    }

    [Fact]
    public void Degenerate_scenes_give_finite_controls()
    {
        var m = AiScene.Build(out var ai, size: 4);
        ai.Pinned.Clear();
        var pitch = m.Pitch;

        // Everyone stacked on one spot with the ball, in a corner.
        Vec2 corner = pitch.ClampCircle(new Vec2(pitch.HalfW, pitch.HalfH), m.Tuning.Player.Radius);
        for (int i = 0; i < m.State.Players.Length; i++) Place(m, i, corner);
        FreeBall(m, pitch.ClampCircle(corner, m.Tuning.Ball.Radius), Vec2.Zero);
        for (int t = 0; t < 600; t++)
        {
            m.Step();
            AssertSane(m);
        }

        // Ball sitting exactly on a footballer, both at the centre, everyone else on the goal line.
        for (int i = 0; i < m.State.Players.Length; i++) Place(m, i, new Vec2(0f, (i - 4) * 0.001f));
        FreeBall(m, Vec2.Zero, Vec2.Zero);
        var inputs = new PlayerInput[m.State.Players.Length];
        var direct = new AiDirector();
        var ctx = AiScene.Context(m);
        direct.Reset(ctx);
        direct.Think(ctx, inputs, Dt);
        Assert.All(inputs, x => Assert.True(x.Move.IsFinite && x.AimPoint.IsFinite));
        for (int t = 0; t < 600; t++)
        {
            m.Step();
            AssertSane(m);
        }
    }

    [Fact]
    public void Control_flipping_every_few_ticks_is_handled()
    {
        var m = AiHarness.NewMatch(5, 31, minutes: 1, settings: s => s.GoldenGoal = false);
        Assert.True(m.AddHuman(1, 0, true) >= 0);
        Assert.True(m.AddHuman(2, 1, false) >= 0);
        int tick = 0;
        var r = AiHarness.Play(m, beforeStep: x =>
        {
            tick++;
            if (tick % 7 == 0) x.SetHumanConnected(1, !x.State.Humans[1].Connected);
            if (tick % 11 == 0) x.SetHumanConnected(2, !x.State.Humans[2].Connected);
            foreach (var h in x.State.Humans)
            {
                if (!h.Present || h.PlayerIndex < 0) continue;
                bool charge = tick % 40 < 20;
                x.SetInput(h.Id, Input(move: (x.State.Ball.Pos - x.State.Players[h.PlayerIndex].Pos).Normalized(),
                    aim: x.Pitch.OpponentGoal(h.Team), shoot: charge, switchNext: tick % 97 == 0));
            }
        });

        Assert.True(m.IsOver);
        Assert.True(r.Shots[0] + r.Shots[1] > 0);
    }
}
