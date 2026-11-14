using static OfficeKickoff.Sim.Tests.TestKit;

namespace OfficeKickoff.Sim.Tests.Ai;

/// <summary>Goalkeeper decisions on hand-built scenes (5-a-side: team 1's keeper is footballer 5, defending x = +HalfW).</summary>
public class AiKeeperTests
{
    private const int HomeKeeper = 0;
    private const int AwayKeeper = 5;

    [Theory]
    [InlineData(200f, 0f)]
    [InlineData(450f, 300f)]
    [InlineData(600f, -380f)]
    [InlineData(-200f, 150f)]
    public void Keeper_stands_between_ball_and_goal_inside_the_box(float bx, float by)
    {
        var m = AiScene.Build(out var ai, level: AiLevel.Hard);
        ai.PinAllBut(m, AwayKeeper);
        Place(m, AwayKeeper, new Vec2(m.Pitch.HalfW - 40f, 0f));
        FreeBall(m, new Vec2(bx, by), Vec2.Zero);
        Step(m, Ticks(2f));

        var k = P(m, AwayKeeper);
        var goal = m.Pitch.OwnGoal(1);
        var ball = m.State.Ball.Pos;
        Assert.True(m.Pitch.InBox(k.Pos, 1), $"keeper at {k.Pos} left the box");
        Assert.True(MathF.Abs(k.Pos.Y) <= m.Pitch.GoalHalf + 5f, $"keeper at {k.Pos} is outside the posts");

        // On the line from goal centre to ball, give or take the Hard keeper's small positional error.
        Vec2 u = (ball - goal).Normalized();
        float off = MathF.Abs(Vec2.Cross(u, k.Pos - goal));
        float slack = m.Tuning.Keeper.PositionError.Hard + 12f;
        bool clampedToPost = MathF.Abs(k.Pos.Y) >= m.Pitch.GoalHalf - 10f;
        Assert.True(off <= slack || clampedToPost, $"keeper {off:0} units off the ball-goal line");

        float depth = m.Pitch.HalfW - k.Pos.X;
        Assert.True(depth >= m.Tuning.Player.Radius - 1f && depth <= m.Tuning.Keeper.MaxAdvance + slack + 5f, $"keeper {depth:0} off the line");
    }

    [Fact]
    public void Keeper_comes_further_out_as_the_ball_comes_closer_and_central()
    {
        float Depth(float bx)
        {
            var m = AiScene.Build(out var ai, level: AiLevel.Hard);
            ai.PinAllBut(m, AwayKeeper);
            FreeBall(m, new Vec2(bx, 0f), Vec2.Zero);
            Step(m, Ticks(2f));
            return m.Pitch.HalfW - P(m, AwayKeeper).Pos.X;
        }

        float far = Depth(-500f), near = Depth(450f);
        Assert.True(near > far + 30f, $"far ball: {far:0} off the line, near ball: {near:0}");
    }

    [Theory]
    [InlineData(1)]
    [InlineData(2)]
    [InlineData(3)]
    public void Hard_keeper_saves_a_shot_within_reach(int seed)
    {
        var m = AiScene.Build(out var ai, level: AiLevel.Hard, seed: seed);
        ai.PinAllBut(m, AwayKeeper);
        Place(m, 3, new Vec2(330f, 60f));
        FreeBall(m, new Vec2(340f, 60f), Vec2.Zero);
        Step(m, Ticks(1.5f));

        // A firm shot towards the near corner.
        Vec2 from = new(380f, 60f), to = new(m.Pitch.HalfW, -60f);
        FreeBall(m, from, (to - from).Normalized() * 950f, lastTouch: 3, kind: TouchKind.Strike);
        var events = StepUntil(m, x => x.State.Phase != MatchPhase.Playing || x.State.Ball.Owner == AwayKeeper ||
                                       x.State.Ball.Vel.X < 0f, Ticks(2f));

        Assert.False(Has(events, GameEventType.Goal), "the shot went in");
        Assert.True(Has(events, GameEventType.KeeperCatch) || Has(events, GameEventType.KeeperParry), "the keeper never touched it");
    }

    [Fact]
    public void Keeper_dives_for_a_shot_running_cannot_reach()
    {
        int dives = 0;
        for (int seed = 1; seed <= 4; seed++)
        {
            var m = AiScene.Build(out var ai, level: AiLevel.Normal, seed: seed);
            ai.PinAllBut(m);

            // The keeper is caught at the near post; the shot flies into the far corner.
            Place(m, AwayKeeper, new Vec2(m.Pitch.HalfW - 40f, -m.Pitch.GoalHalf + 25f));
            Vec2 from = new(300f, 0f), to = new(m.Pitch.HalfW, m.Pitch.GoalHalf - 18f);
            FreeBall(m, from, (to - from).Normalized() * 1500f, lastTouch: 3, kind: TouchKind.Strike);
            ai.Pinned.Remove(AwayKeeper);
            var events = Collect(m, Ticks(0.6f));
            if (Has(events, GameEventType.Dive)) dives++;
        }

        Assert.True(dives >= 3, $"the keeper dived {dives} times out of 4");
    }

    [Fact]
    public void Keeper_waits_for_its_reaction_time_before_going_for_a_shot()
    {
        var m = AiScene.Build(out var ai, level: AiLevel.Easy);
        ai.PinAllBut(m, AwayKeeper);
        FreeBall(m, new Vec2(300f, 0f), Vec2.Zero);
        Step(m, Ticks(1.5f));
        Place(m, AwayKeeper, P(m, AwayKeeper).Pos);

        Vec2 from = new(260f, 0f), to = new(m.Pitch.HalfW, -m.Pitch.GoalHalf + 15f);
        FreeBall(m, from, (to - from).Normalized() * 1100f, lastTouch: 3, kind: TouchKind.Strike);
        int reaction = Ticks(m.Tuning.Keeper.Reaction.Easy) - 2;
        var early = Collect(m, reaction);
        Assert.False(Has(early, GameEventType.Dive), "the keeper dived before its reaction time");

        // Once it has reacted, it goes for the ball.
        var later = StepUntil(m, x => x.State.Phase != MatchPhase.Playing || x.State.Ball.Vel.X <= 0f || x.State.Ball.Owner >= 0, Ticks(1.5f));
        bool tried = Has(later, GameEventType.Dive) || Has(later, GameEventType.KeeperCatch) || Has(later, GameEventType.KeeperParry);
        Assert.True(tried || Has(later, GameEventType.Goal), "nothing happened");
    }

    [Fact]
    public void Keeper_holds_a_caught_ball_then_distributes_to_the_open_human()
    {
        var m = AiScene.Build(out var ai, level: AiLevel.Normal);
        int human = Index(m, 1, 2);
        Seat(m, 2, human);
        int mate = Index(m, 1, 3);
        ai.PinAllBut(m, AwayKeeper);

        // The keeper has just caught it; the human and an AI team-mate are both free.
        Place(m, AwayKeeper, new Vec2(m.Pitch.HalfW - 60f, 0f));
        Place(m, human, new Vec2(250f, 250f));
        Place(m, mate, new Vec2(300f, -200f));
        GiveBall(m, AwayKeeper, ownerTime: 0f);
        m.State.Ball.Held = true;

        var events = StepUntilEvent(m, GameEventType.Pass, Ticks(4f));
        var pass = Single(events, GameEventType.Pass);
        Assert.Equal(AwayKeeper, pass.A);
        Assert.Equal(human, pass.B);
        Assert.NotEqual(mate, pass.B);
    }

    [Fact]
    public void Keeper_does_not_release_a_held_ball_before_hold_time()
    {
        var m = AiScene.Build(out var ai, level: AiLevel.Hard);
        ai.PinAllBut(m, AwayKeeper);
        Place(m, AwayKeeper, new Vec2(m.Pitch.HalfW - 60f, 0f));
        Place(m, Index(m, 1, 3), new Vec2(300f, -200f));
        GiveBall(m, AwayKeeper, ownerTime: 0f);
        m.State.Ball.Held = true;

        var early = Collect(m, Ticks(m.Tuning.Keeper.HoldTime) - 3);
        Assert.False(Has(early, GameEventType.Pass) || Has(early, GameEventType.Kick), "the keeper let go too early");
        Assert.Equal(AwayKeeper, m.State.Ball.Owner);

        var later = StepUntil(m, x => x.State.Ball.Owner != AwayKeeper, Ticks(m.Tuning.Keeper.MaxHoldTime));
        Assert.True(Has(later, GameEventType.Pass) || Has(later, GameEventType.Kick));
    }

    [Fact]
    public void Keeper_moves_a_back_pass_on_at_once()
    {
        var m = AiScene.Build(out var ai, level: AiLevel.Normal);
        ai.PinAllBut(m, AwayKeeper);
        Place(m, AwayKeeper, new Vec2(m.Pitch.HalfW - 60f, 0f));
        Place(m, Index(m, 1, 3), new Vec2(250f, -200f));
        Place(m, Index(m, 0, 4), new Vec2(m.Pitch.HalfW - 150f, 40f));
        GiveBall(m, AwayKeeper, ownerTime: 0f);
        Assert.False(m.State.Ball.Held);

        var events = StepUntil(m, x => x.State.Ball.Owner != AwayKeeper, Ticks(0.9f));
        Assert.True(Has(events, GameEventType.Pass) || Has(events, GameEventType.Kick), "the keeper dawdled on a back-pass");
    }

    [Fact]
    public void Keeper_claims_a_loose_ball_in_its_box()
    {
        var m = AiScene.Build(out var ai, level: AiLevel.Normal);
        ai.PinAllBut(m, AwayKeeper);
        Place(m, AwayKeeper, new Vec2(m.Pitch.HalfW - 40f, 0f));
        FreeBall(m, new Vec2(m.Pitch.HalfW - 140f, 70f), Vec2.Zero, lastTouch: 3, kind: TouchKind.Strike);

        StepUntil(m, x => x.State.Ball.Owner == AwayKeeper, Ticks(2f));
        Assert.True(m.State.Ball.Held, "a claimed ball is held");
    }

    [Fact]
    public void Keeper_comes_out_to_meet_a_forward_through_on_goal()
    {
        var m = AiScene.Build(out var ai, level: AiLevel.Hard);
        int striker = Index(m, 0, 4);
        ai.PinAllBut(m, AwayKeeper, striker);
        Place(m, AwayKeeper, new Vec2(m.Pitch.HalfW - 40f, 0f));
        Place(m, striker, new Vec2(250f, 30f));
        GiveBall(m, striker);

        float furthest = 0f;
        for (int t = 0; t < Ticks(2.5f) && m.State.Phase == MatchPhase.Playing; t++)
        {
            m.Step();
            furthest = MathF.Max(furthest, m.Pitch.HalfW - P(m, AwayKeeper).Pos.X);
            if (m.State.Ball.Owner == AwayKeeper) return;
        }

        Assert.True(furthest > m.Tuning.Keeper.LineOffset + 30f, "the keeper stayed on the line against a one-on-one");
    }
}
