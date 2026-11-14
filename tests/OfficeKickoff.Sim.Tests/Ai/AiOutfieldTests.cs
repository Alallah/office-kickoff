using OfficeKickoff.Sim.Ai;
using static OfficeKickoff.Sim.Tests.TestKit;

namespace OfficeKickoff.Sim.Tests.Ai;

/// <summary>Outfield decisions on hand-built 5-a-side scenes (team 0 attacks +X).</summary>
public class AiOutfieldTests
{
    [Fact]
    public void Carrier_with_a_sight_of_goal_shoots()
    {
        var m = AiScene.Build(out var ai);
        int striker = Index(m, 0, 4);
        ai.PinAllBut(m, striker);
        Place(m, striker, new Vec2(m.Pitch.HalfW - 330f, 40f));
        GiveBall(m, striker);

        var events = StepUntilEvent(m, GameEventType.Kick, Ticks(1.5f));
        Assert.Equal(striker, Single(events, GameEventType.Kick).A);
        Assert.Equal(1, m.Stats.Teams[0].ShotsOnTarget);
    }

    [Fact]
    public void Carrier_out_of_range_does_not_shoot()
    {
        var m = AiScene.Build(out var ai);
        int carrier = Index(m, 0, 1);
        ai.PinAllBut(m, carrier);
        Place(m, carrier, new Vec2(-m.Pitch.HalfW + 200f, 0f));
        GiveBall(m, carrier);

        var events = Collect(m, Ticks(1f));
        Assert.False(Has(events, GameEventType.Kick));
        Assert.Equal(carrier, m.State.Ball.Owner);
        Assert.True(P(m, carrier).Pos.X > -m.Pitch.HalfW + 230f, "the carrier did not dribble forward");
    }

    [Fact]
    public void Carrier_passes_to_an_open_human_team_mate()
    {
        var m = AiScene.Build(out var ai);
        int carrier = Index(m, 0, 1);
        int human = Index(m, 0, 4);
        Seat(m, 0, human);
        ai.PinAllBut(m, carrier);
        Place(m, carrier, new Vec2(-250f, 0f));
        Place(m, human, new Vec2(80f, 180f));
        GiveBall(m, carrier);

        var events = StepUntilEvent(m, GameEventType.Pass, Ticks(1.5f));
        var pass = Single(events, GameEventType.Pass);
        Assert.Equal(carrier, pass.A);
        Assert.Equal(human, pass.B);
    }

    [Fact]
    public void Kickoff_taker_finds_the_human()
    {
        // A team whose only human is away takes the kickoff with the AI; the human comes back
        // during the countdown, but on a different footballer than the taker.
        var m = NewMatch(5, new AiDirector(), 77);
        Assert.True(m.AddHuman(0, 0, true) >= 0);
        StepUntilPhase(m, MatchPhase.Kickoff);
        int taker = m.State.Ball.Owner;
        int human = m.State.Humans[0].PlayerIndex;
        Assert.Equal(taker, human);

        // Move the human off the taker (tests may edit state): the AI now owns the kickoff.
        int other = Index(m, 0, 1);
        Seat(m, 0, other);
        StepUntilPhase(m, MatchPhase.Playing);
        Face(m, 0);

        var events = StepUntilEvent(m, GameEventType.Pass, Ticks(2f));
        var pass = Single(events, GameEventType.Pass);
        Assert.Equal(taker, pass.A);
        Assert.Equal(other, pass.B);
    }

    [Fact]
    public void Exactly_one_ai_presses_the_carrier()
    {
        var m = AiScene.Build(out var ai, level: AiLevel.Normal);
        int carrier = Index(m, 0, 3);
        ai.PinAllBut(m, Index(m, 1, 1), Index(m, 1, 2), Index(m, 1, 3), Index(m, 1, 4));
        Place(m, carrier, new Vec2(100f, 0f));
        GiveBall(m, carrier);

        int most = 0;
        bool closed = false;
        for (int t = 0; t < Ticks(2f) && m.State.Ball.Owner == carrier; t++)
        {
            m.Step();
            int near = 0;
            for (int j = Index(m, 1, 1); j <= Index(m, 1, 4); j++)
            {
                if (Vec2.Distance(P(m, j).Pos, P(m, carrier).Pos) < 120f) near++;
            }

            most = Math.Max(most, near);
            closed |= near > 0;
        }

        Assert.True(closed, "nobody closed the carrier down");
        Assert.Equal(1, most);
    }

    [Fact]
    public void Markers_stand_goal_side_of_their_opponents()
    {
        var m = AiScene.Build(out var ai, level: AiLevel.Normal);
        int carrier = Index(m, 0, 1);
        int[] forwards = [Index(m, 0, 2), Index(m, 0, 3), Index(m, 0, 4)];
        ai.PinAllBut(m, Index(m, 1, 1), Index(m, 1, 2), Index(m, 1, 3), Index(m, 1, 4));
        Place(m, carrier, new Vec2(-250f, 0f));
        Place(m, forwards[0], new Vec2(250f, -250f));
        Place(m, forwards[1], new Vec2(300f, 0f));
        Place(m, forwards[2], new Vec2(250f, 250f));
        GiveBall(m, carrier);
        Step(m, Ticks(2.5f));
        Assert.Equal(carrier, m.State.Ball.Owner);

        Vec2 goal = m.Pitch.OwnGoal(1);
        foreach (int f in forwards)
        {
            int nearest = -1;
            float best = float.MaxValue;
            for (int j = Index(m, 1, 1); j <= Index(m, 1, 4); j++)
            {
                float d = Vec2.Distance(P(m, j).Pos, P(m, f).Pos);
                if (d < best)
                {
                    best = d;
                    nearest = j;
                }
            }

            Assert.True(best < 150f, $"forward {f} is unmarked (nearest defender {best:0} away)");
            Assert.True(Vec2.Distance(P(m, nearest).Pos, goal) < Vec2.Distance(P(m, f).Pos, goal),
                $"defender {nearest} is not goal side of forward {f}");
        }
    }

    [Fact]
    public void Easy_never_slides_and_hard_does()
    {
        int Slides(AiLevel level)
        {
            var m = AiHarness.NewMatch(5, 3, level, level, minutes: 1);
            int count = 0;
            AiHarness.Play(m, beforeStep: x =>
            {
                foreach (var e in x.Events)
                {
                    if (e.Type == GameEventType.SlideStart) count++;
                }
            });
            return count;
        }

        Assert.Equal(0, Slides(AiLevel.Easy));
        Assert.True(Slides(AiLevel.Hard) > 3, "Hard AI hardly ever slides");
    }

    [Fact]
    public void Nobody_slides_at_a_keeper_in_its_box()
    {
        var m = AiScene.Build(out var ai, level: AiLevel.Hard);
        int keeper = Keeper(m, 1);
        ai.PinAllBut(m, Index(m, 0, 3), Index(m, 0, 4));
        ai.Pinned.Add(keeper);
        Place(m, keeper, new Vec2(m.Pitch.HalfW - 80f, 0f));
        Place(m, Index(m, 0, 3), new Vec2(m.Pitch.HalfW - 330f, 60f));
        Place(m, Index(m, 0, 4), new Vec2(m.Pitch.HalfW - 330f, -60f));
        GiveBall(m, keeper);
        Assert.False(m.State.Ball.Held);

        var events = Collect(m, Ticks(2f));
        Assert.DoesNotContain(events, e => e.Type == GameEventType.SlideStart);
    }

    [Fact]
    public void Nobody_runs_into_the_box_while_its_keeper_holds_the_ball()
    {
        var m = AiScene.Build(out var ai, level: AiLevel.Hard);
        int keeper = Keeper(m, 1);
        ai.PinAllBut(m, Index(m, 0, 1), Index(m, 0, 2), Index(m, 0, 3), Index(m, 0, 4));
        ai.Pinned.Add(keeper);
        Place(m, keeper, new Vec2(m.Pitch.HalfW - 60f, 0f));
        for (int s = 1; s <= 4; s++) Place(m, Index(m, 0, s), new Vec2(m.Pitch.HalfW - 400f, -300f + 150f * s));
        GiveBall(m, keeper, ownerTime: 0f);
        m.State.Ball.Held = true;

        Step(m, Ticks(m.Tuning.Keeper.HoldTime + 0.4f));
        Assert.True(m.State.Ball.Held);
        for (int s = 1; s <= 4; s++)
        {
            var p = P(m, Index(m, 0, s));
            float depth = m.Pitch.HalfW - p.Pos.X;
            float outside = MathF.Max(depth - m.Pitch.BoxDepth, MathF.Abs(p.Pos.Y) - m.Pitch.BoxHalfWidth);
            Assert.True(outside > m.Tuning.Player.Radius * 0.5f, $"footballer {p.Index} waits on the box edge at {p.Pos}");
        }
    }

    [Fact]
    public void Pass_receiver_moves_onto_the_ball_path()
    {
        var m = AiScene.Build(out var ai);
        int passer = Index(m, 0, 1), receiver = Index(m, 0, 3);
        ai.PinAllBut(m, receiver);
        Place(m, passer, new Vec2(-330f, 0f));
        Place(m, receiver, new Vec2(100f, 140f));
        FreeBall(m, new Vec2(-300f, 0f), new Vec2(520f, 0f), lastTouch: passer, kind: TouchKind.Strike);
        m.State.Ball.PassTarget = receiver;
        m.State.Ball.PassFrom = passer;

        StepUntil(m, x => x.State.Ball.Owner == receiver || MathF.Abs(P(x, receiver).Pos.Y) < 30f, Ticks(1.5f));
    }

    [Fact]
    public void Only_the_quickest_ai_goes_for_a_loose_ball()
    {
        var m = AiScene.Build(out var ai);
        int a = Index(m, 0, 1), b = Index(m, 0, 2), c = Index(m, 0, 3);
        ai.PinAllBut(m, a, b, c);
        Place(m, a, new Vec2(-100f, 0f));
        Place(m, b, new Vec2(-250f, 100f));
        Place(m, c, new Vec2(-300f, -150f));
        FreeBall(m, new Vec2(50f, 0f), Vec2.Zero);

        StepUntil(m, x => x.State.Ball.Owner >= 0, Ticks(1.5f));
        Assert.Equal(a, m.State.Ball.Owner);
        Assert.True(Vec2.Distance(P(m, b).Pos, m.State.Ball.Pos) > 100f, "a second footballer crowded the ball");
        Assert.True(Vec2.Distance(P(m, c).Pos, m.State.Ball.Pos) > 100f, "a third footballer crowded the ball");
    }

    [Fact]
    public void Ai_leaves_a_loose_ball_to_a_human_who_is_clearly_closer()
    {
        var m = AiScene.Build(out var ai);
        int human = Index(m, 0, 4), mate = Index(m, 0, 3);
        Seat(m, 0, human);
        ai.PinAllBut(m, mate);
        Place(m, human, new Vec2(0f, 45f));
        Place(m, mate, new Vec2(-260f, 0f));
        FreeBall(m, new Vec2(0f, 0f), Vec2.Zero);

        float closest = float.MaxValue;
        for (int t = 0; t < Ticks(1.2f); t++)
        {
            m.Step();
            closest = MathF.Min(closest, Vec2.Distance(P(m, mate).Pos, m.State.Ball.Pos));
        }

        Assert.True(closest > 70f, $"the AI went for its own human's ball (came within {closest:0})");
        Assert.Equal(-1, m.State.Ball.Owner);
    }

    [Fact]
    public void Ai_still_goes_when_the_human_is_far_away()
    {
        var m = AiScene.Build(out var ai);
        int human = Index(m, 0, 4), mate = Index(m, 0, 3);
        Seat(m, 0, human);
        ai.PinAllBut(m, mate);
        Place(m, human, new Vec2(-600f, 300f));
        Place(m, mate, new Vec2(-200f, 0f));
        FreeBall(m, new Vec2(0f, 0f), Vec2.Zero);

        // The AI wins the ball - and, since the team has a human, control passes to them at once.
        var events = StepUntilEvent(m, GameEventType.Trap, Ticks(1.5f));
        Assert.Equal(mate, Single(events, GameEventType.Trap).A);
    }

    [Fact]
    public void Hard_carrier_sometimes_dashes_out_of_a_slide()
    {
        int Dashes(AiLevel level)
        {
            int dashes = 0;
            for (int seed = 1; seed <= 10; seed++)
            {
                var m = AiScene.Build(out var ai, level: level, seed: seed);
                int carrier = Index(m, 0, 3), slider = Index(m, 1, 2);
                ai.PinAllBut(m, carrier);
                Place(m, carrier, new Vec2(0f, 0f));
                Place(m, slider, new Vec2(110f, 0f));
                GiveBall(m, carrier);
                ref var s = ref P(m, slider);
                s.Action = PlayerAction.Slide;
                s.ActionTime = m.Tuning.Tackle.SlideTime;
                s.ActionDir = new Vec2(-1f, 0f);
                s.SlideHit = false;
                if (Has(Collect(m, 3), GameEventType.Dash)) dashes++;
            }

            return dashes;
        }

        Assert.Equal(0, Dashes(AiLevel.Easy));
        int hard = Dashes(AiLevel.Hard);
        Assert.True(hard is >= 2 and <= 9, $"Hard dodged {hard} slides out of 10");
    }

    [Fact]
    public void Scorers_celebrate_together_and_the_others_walk_back()
    {
        var m = AiScene.Build(out var ai);
        int striker = Index(m, 0, 4);
        ai.Pinned.Clear();
        Place(m, striker, new Vec2(m.Pitch.HalfW - 60f, 0f));
        FreeBall(m, new Vec2(m.Pitch.HalfW - 20f, 0f), new Vec2(400f, 0f), lastTouch: striker, kind: TouchKind.Strike);
        StepUntilPhase(m, MatchPhase.GoalScored, Ticks(1f));

        float Spread()
        {
            float sum = 0f;
            for (int s = 1; s <= 3; s++) sum += Vec2.Distance(P(m, Index(m, 0, s)).Pos, P(m, striker).Pos);
            return sum;
        }

        float before = Spread();
        float awayBefore = Vec2.Distance(P(m, Index(m, 1, 2)).Pos, P(m, Index(m, 1, 2)).HomePos);
        Step(m, Ticks(1.5f));
        Assert.True(Spread() < before - 100f, "the scorer's team-mates did not come over");
        Assert.True(Vec2.Distance(P(m, Index(m, 1, 2)).Pos, P(m, Index(m, 1, 2)).HomePos) < awayBefore, "the other team did not walk back");
    }
}
