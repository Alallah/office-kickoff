using static OfficeKickoff.Sim.Tests.TestKit;

namespace OfficeKickoff.Sim.Tests.Core;

public class KickTests
{
    /// <summary>Team 0 laid out for passing: keeper deep, passer on the centre spot, three team-mates.</summary>
    private static void Lineup(Match m, Vec2 two, Vec2 three, Vec2 four)
    {
        Place(m, 0, new Vec2(-700f, 0f));
        Place(m, 1, Vec2.Zero);
        Place(m, 2, two);
        Place(m, 3, three);
        Place(m, 4, four);
    }

    // ------------------------------------------------------------------------------------
    //  Shots
    // ------------------------------------------------------------------------------------

    [Theory]
    [InlineData(0.75f, 24)]
    [InlineData(1f, 24)]
    [InlineData(1f, 6)]
    [InlineData(1f, 60)]
    [InlineData(1.5f, 24)]
    [InlineData(1.5f, 60)]
    public void Shot_speed_follows_charge_and_ball_speed(float ballSpeed, int chargeTicks)
    {
        var m = Arena(settings: s => s.BallSpeed = ballSpeed);
        var kick = m.Tuning.Kick;
        int i = Index(m, 0, 1);
        Place(m, i, new Vec2(-200f, 0f));
        Seat(m, 0, i);
        GiveBall(m, i);
        var ev = ChargeAndShoot(m, 0, chargeTicks, new Vec2(700f, 0f));

        var k = Single(ev, GameEventType.Kick);
        float charge = MathF.Min(1f, chargeTicks * Dt / kick.ChargeTime);
        Assert.Equal(i, k.A);
        Assert.Equal(0, k.Flag);
        AssertNear(charge, k.Value, 0.01f, "charge");
        float expected = MathUtil.Lerp(kick.ShotMinSpeed, kick.ShotMaxSpeed, charge) * ballSpeed;
        var b = m.State.Ball;
        AssertNear(expected, b.Vel.Length, expected * 0.02f, "speed");
        AssertNear(0f, b.Vel.Y, 1f);
        Assert.Equal(-1, b.Owner);
        Assert.Equal(i, b.LastTouch);
        Assert.Equal(TouchKind.Strike, b.LastTouchKind);
        Assert.Equal(1, b.OnTargetGoal);
        AssertNear(charge, b.Heat, 0.02f, "heat");
        Assert.Equal(kick.KickCooldown, P(m, i).KickCooldown, 3);
        Assert.Equal(1, m.Stats.Teams[0].Shots);
        Assert.Equal(1, m.Stats.Teams[0].ShotsOnTarget);
        Assert.Equal(1, m.Stats.Humans[0].Shots);
        Assert.Equal(1, m.Stats.Humans[0].ShotsOnTarget);
    }

    [Theory]
    [InlineData(1f)]
    [InlineData(-1f)]
    public void Shot_bends_towards_the_side_the_shooter_moves(float side)
    {
        var m = Arena();
        int i = Index(m, 0, 1);
        Place(m, i, new Vec2(-200f, 0f));
        Seat(m, 0, i);
        GiveBall(m, i);
        var move = new Vec2(0f, side);
        var aim = new Vec2(700f, 0f);
        m.SetInput(0, Input(move: move, aim: aim, shoot: true));
        Step(m, 30);
        m.SetInput(0, Input(move: move, aim: aim));
        Step(m);
        float spin = m.State.Ball.Spin;
        Assert.True(spin * side > 0.1f, $"spin {spin}");
        float a0 = m.State.Ball.Vel.Angle;
        Step(m, 10);
        float a1 = m.State.Ball.Vel.Angle;
        Assert.True(MathUtil.AngleDiff(a0, a1) * side > 0.05f, "the ball curves");
    }

    [Fact]
    public void Standing_shot_does_not_spin()
    {
        var m = Arena();
        int i = Index(m, 0, 1);
        Place(m, i, new Vec2(-200f, 0f));
        Seat(m, 0, i);
        GiveBall(m, i);
        ChargeAndShoot(m, 0, 30, new Vec2(700f, 0f));
        Assert.Equal(0f, m.State.Ball.Spin);
    }

    [Fact]
    public void Loose_ball_in_reach_is_kicked_first_time()
    {
        var m = Arena();
        int i = Index(m, 0, 1);
        Place(m, i, new Vec2(-200f, 0f));
        Seat(m, 0, i);
        FreeBall(m, new Vec2(-200f + 42f, 0f), Vec2.Zero);
        var ev = ChargeAndShoot(m, 0, 12, new Vec2(700f, 0f));
        var k = Single(ev, GameEventType.Kick);
        Assert.Equal(1, k.Flag);
        Assert.True(m.State.Ball.Vel.X > 500f);
    }

    [Fact]
    public void Shot_out_of_reach_is_remembered_and_volleys_a_ball_too_fast_to_trap()
    {
        var m = Arena();
        int i = Index(m, 0, 1);
        Place(m, i, Vec2.Zero);
        Seat(m, 0, i);
        FreeBall(m, new Vec2(300f, 300f), Vec2.Zero);
        var aim = new Vec2(0f, -400f);
        m.SetInput(0, Input(aim: aim, shoot: true));
        Step(m, 30);
        FreeBall(m, new Vec2(-160f, 0f), new Vec2(1500f, 0f), Index(m, 1, 1), TouchKind.Strike);
        m.SetInput(0, Input(aim: aim));
        var ev = Collect(m, 15);

        var k = Single(ev, GameEventType.Kick);
        Assert.Equal(i, k.A);
        Assert.Equal(1, k.Flag);
        Assert.False(Has(ev, GameEventType.Deflect));
        Assert.False(Has(ev, GameEventType.Trap));
        Assert.True(m.State.Ball.Vel.Y < -800f);
        Assert.True(MathF.Abs(m.State.Ball.Vel.X) < 60f);

        // Without the remembered shot the same ball just bounces off.
        var n = Arena();
        Place(n, i, Vec2.Zero);
        FreeBall(n, new Vec2(-160f, 0f), new Vec2(1500f, 0f), Index(n, 1, 1), TouchKind.Strike);
        Assert.True(Has(Collect(n, 15), GameEventType.Deflect));
    }

    [Fact]
    public void Remembered_shot_expires_after_the_buffer_time()
    {
        var m = Arena();
        int i = Index(m, 0, 1);
        Place(m, i, Vec2.Zero);
        Seat(m, 0, i);
        FreeBall(m, new Vec2(300f, 300f), Vec2.Zero);
        m.SetInput(0, Input(aim: new Vec2(600f, 0f), shoot: true));
        Step(m, 20);
        m.SetInput(0, Input(aim: new Vec2(600f, 0f)));
        Step(m, Ticks(m.Tuning.Kick.BufferTime) + 3);
        FreeBall(m, new Vec2(-60f, 0f), new Vec2(300f, 0f));
        var ev = Collect(m, 10);
        Assert.False(Has(ev, GameEventType.Kick));
        Assert.Equal(i, m.State.Ball.Owner);
    }

    [Fact]
    public void Remembered_pass_is_played_the_moment_the_ball_is_trapped()
    {
        var m = Arena();
        Lineup(m, new Vec2(0f, 300f), new Vec2(-300f, -300f), new Vec2(-300f, 300f));
        Seat(m, 0, 1);
        FreeBall(m, new Vec2(-110f, 0f), new Vec2(500f, 0f));
        m.SetInput(0, Input(aim: new Vec2(0f, 300f), pass: true));
        var ev = Collect(m, 30);
        var pass = Single(ev, GameEventType.Pass);
        Assert.Equal(1, pass.A);
        Assert.Equal(2, pass.B);
        Assert.Equal(1, pass.Flag);
        Assert.False(Has(ev, GameEventType.Trap));
    }

    // ------------------------------------------------------------------------------------
    //  Pass targeting
    // ------------------------------------------------------------------------------------

    [Fact]
    public void Pass_target_is_the_best_aligned_team_mate_in_the_cone()
    {
        var m = Arena();
        Lineup(m, new Vec2(300f, 0f), new Vec2(200f, 100f), new Vec2(0f, 300f));
        Assert.Equal(2, m.PassTargetFor(1, new Vec2(1000f, 0f)));
        Assert.Equal(3, m.PassTargetFor(1, new Vec2(1000f, 500f)));
        Assert.Equal(4, m.PassTargetFor(1, new Vec2(0f, 1000f)));
        Assert.Equal(-1, m.PassTargetFor(1, new Vec2(0f, -1000f)));
        Assert.Equal(-1, m.PassTargetFor(99, new Vec2(0f, -1000f)));
        Assert.InRange(m.PassTargetFor(1, new Vec2(float.NaN, float.PositiveInfinity)), -1, 4);
    }

    [Fact]
    public void Pass_tie_rule_prefers_the_nearest_of_the_nearly_aligned()
    {
        var m = Arena();
        float tie = m.Tuning.Kick.PassTieDeg;

        // Inside the tie window and nearer: it gets the pass.
        float inside = (tie - 2f) * MathF.PI / 180f;
        Lineup(m, new Vec2(400f, 0f), Vec2.FromAngle(inside, 150f), new Vec2(0f, 300f));
        Assert.Equal(3, m.PassTargetFor(1, new Vec2(1000f, 0f)));

        // Just outside the tie window: the best-aligned one wins although it is farther.
        float outside = (tie + 2f) * MathF.PI / 180f;
        Place(m, 3, Vec2.FromAngle(outside, 150f));
        Assert.Equal(2, m.PassTargetFor(1, new Vec2(1000f, 0f)));

        // Tied and farther: the nearer best-aligned one keeps it.
        Place(m, 3, Vec2.FromAngle(inside, 600f));
        Assert.Equal(2, m.PassTargetFor(1, new Vec2(1000f, 0f)));
    }

    [Fact]
    public void Keeper_is_the_pass_target_only_as_a_last_resort()
    {
        var m = Arena();
        Lineup(m, new Vec2(300f, 0f), new Vec2(200f, 100f), new Vec2(0f, 300f));
        Assert.Equal(0, m.PassTargetFor(1, new Vec2(-1000f, 0f)));
        Place(m, 4, new Vec2(-300f, 200f));
        Assert.Equal(4, m.PassTargetFor(1, new Vec2(-1000f, 0f)));
    }

    // ------------------------------------------------------------------------------------
    //  Passing
    // ------------------------------------------------------------------------------------

    [Fact]
    public void Pass_hands_control_to_the_ai_receiver_and_completes()
    {
        var m = Arena();
        Lineup(m, new Vec2(300f, 0f), new Vec2(-300f, -300f), new Vec2(-300f, 300f));
        Seat(m, 0, 1);
        GiveBall(m, 1);
        Step(m);
        m.SetInput(0, Input(aim: new Vec2(300f, 0f), pass: true));
        var ev = Collect(m);

        var pass = Single(ev, GameEventType.Pass);
        Assert.Equal(1, pass.A);
        Assert.Equal(2, pass.B);
        Assert.Equal(0, pass.Flag);
        var sw = Single(ev, GameEventType.Switch);
        Assert.Equal(2, sw.A);
        Assert.Equal(1, sw.B);
        Assert.Equal(0, sw.Flag);
        Assert.Equal(2, m.State.Humans[0].PlayerIndex);
        Assert.Equal(-1, P(m, 1).Controller);
        Assert.Equal(AiSpeedFactor(m, 1), P(m, 1).SpeedFactor);
        AssertNear(m.Tuning.Switch.MinGap, m.State.Humans[0].SwitchCooldown, 0.02f);
        Assert.Equal(2, m.State.Ball.PassTarget);
        Assert.Equal(1, m.State.Ball.PassFrom);
        Assert.Equal(1, m.Stats.Teams[0].PassesAttempted);
        Assert.Equal(1, m.Stats.Humans[0].PassesAttempted);

        m.SetInput(0, Input(aim: new Vec2(800f, 0f)));
        var rest = StepUntil(m, mm => mm.State.Ball.Owner == 2, 120);
        Assert.Equal(0, CountOf(rest, GameEventType.Switch));
        Assert.Equal(2, Single(rest, GameEventType.Trap).A);
        Assert.Equal(1, m.Stats.Teams[0].PassesCompleted);
        Assert.Equal(1, m.Stats.Humans[0].PassesCompleted);
        Assert.Equal(-1, m.State.Ball.PassTarget);
        Assert.Equal(-1, m.State.Ball.PassFrom);
        AssertSane(m);
    }

    [Fact]
    public void Intercepted_pass_is_not_completed()
    {
        var m = Arena();
        Lineup(m, new Vec2(300f, 0f), new Vec2(-300f, -300f), new Vec2(-300f, 300f));
        int thief = Index(m, 1, 1);
        Place(m, thief, new Vec2(150f, 0f));
        Seat(m, 0, 1);
        GiveBall(m, 1);
        m.SetInput(0, Input(aim: new Vec2(300f, 0f), pass: true));
        StepUntil(m, mm => mm.State.Ball.Owner == thief, 60);
        Assert.Equal(1, m.Stats.Teams[0].PassesAttempted);
        Assert.Equal(0, m.Stats.Teams[0].PassesCompleted);
        Assert.Equal(0, m.Stats.Teams[1].PassesCompleted);
        Assert.Equal(0, m.Stats.Humans[0].PassesCompleted);
    }

    [Fact]
    public void Pass_into_space_goes_along_the_aim()
    {
        var m = Arena();
        Lineup(m, new Vec2(300f, 0f), new Vec2(-300f, 300f), new Vec2(300f, 300f));
        Seat(m, 0, 1);
        GiveBall(m, 1);
        Step(m);
        m.SetInput(0, Input(aim: new Vec2(0f, -300f), pass: true));
        var ev = Collect(m);
        var pass = Single(ev, GameEventType.Pass);
        Assert.Equal(-1, pass.B);
        Assert.False(Has(ev, GameEventType.Switch));
        Assert.True(m.State.Ball.Vel.Y < -300f);
        AssertNear(0f, m.State.Ball.Vel.X, 1f);
        Assert.Equal(1, m.State.Humans[0].PlayerIndex);
    }

    [Fact]
    public void Pass_leads_a_running_receiver()
    {
        var m = Arena(out var ai);
        Lineup(m, new Vec2(150f, 0f), new Vec2(-300f, -300f), new Vec2(-300f, 300f));
        Place(m, 1, new Vec2(-250f, 0f));
        GiveBall(m, 1);
        ai.Hold(2, Input(move: new Vec2(0f, 1f), aim: new Vec2(150f, 1000f)));
        Step(m, 10);
        ai.Once(1, Input(aim: P(m, 2).Pos, pass: true));
        var ev = Collect(m);
        Assert.Equal(2, Single(ev, GameEventType.Pass).B);
        float direct = (P(m, 2).Pos - P(m, 1).Pos).Angle * 180f / MathF.PI;
        float actual = m.State.Ball.Vel.Angle * 180f / MathF.PI;
        Assert.InRange(actual - direct, 8f, 25f);
    }

    [Theory]
    [InlineData(0.75f)]
    [InlineData(1f)]
    [InlineData(1.5f)]
    public void Pass_weight_arrives_trappable_at_every_ball_speed(float ballSpeed)
    {
        var m = Arena(out var ai, settings: s => s.BallSpeed = ballSpeed);
        Lineup(m, new Vec2(200f, 0f), new Vec2(-300f, -300f), new Vec2(-300f, 300f));
        Place(m, 1, new Vec2(-250f, 0f));
        GiveBall(m, 1);
        ai.Hold(2, Input(move: new Vec2(-1f, 0f), aim: new Vec2(-1000f, 0f)));
        Step(m, 10);
        ai.Once(1, Input(aim: P(m, 2).Pos, pass: true));

        var events = new List<GameEvent>();
        float arrival = 0f;
        for (int t = 0; t < 120 && m.State.Ball.Owner != 2; t++)
        {
            if (m.State.Ball.Owner < 0) arrival = m.State.Ball.Vel.Length;
            events.AddRange(Collect(m));
        }

        Assert.Equal(2, Single(events, GameEventType.Pass).B);
        Assert.Equal(2, m.State.Ball.Owner);
        Assert.False(Has(events, GameEventType.Deflect));
        float arrive = m.Tuning.Kick.PassArriveSpeed * ballSpeed;
        Assert.InRange(arrival, 0.7f * arrive, 1.4f * arrive);
    }

    [Fact]
    public void Pass_speed_is_clamped_between_min_and_max()
    {
        var kick = new Tuning().Kick;

        var m = Arena();
        Lineup(m, new Vec2(600f, -300f), new Vec2(-300f, -300f), new Vec2(-300f, 300f));
        Place(m, 1, new Vec2(-600f, 300f));
        AssertNear(kick.PassMaxSpeed, PassSpeed(m, P(m, 2).Pos), kick.PassMaxSpeed * 0.02f, "long pass");

        var n = Arena();
        Lineup(n, new Vec2(80f, 0f), new Vec2(-300f, -300f), new Vec2(-300f, 300f));
        AssertNear(kick.PassMinSpeed, PassSpeed(n, P(n, 2).Pos), kick.PassMinSpeed * 0.02f, "short pass");

        static float PassSpeed(Match match, Vec2 aim)
        {
            Seat(match, 0, 1);
            GiveBall(match, 1);
            match.SetInput(0, Input(aim: aim, pass: true));
            Step(match);
            Assert.Equal(2, match.State.Ball.PassTarget);
            return match.State.Ball.Vel.Length;
        }
    }

    [Fact]
    public void A_pass_can_score_and_counts_as_on_target()
    {
        var m = Arena();
        int i = Index(m, 0, 1);
        Place(m, i, new Vec2(500f, 0f));
        Seat(m, 0, i);
        GiveBall(m, i);
        m.SetInput(0, Input(aim: new Vec2(900f, 0f), pass: true));
        Step(m);
        Assert.Equal(1, m.State.Ball.OnTargetGoal);
        Assert.Equal(-1, m.State.Ball.PassTarget);
        StepUntilEvent(m, GameEventType.Goal, 120);
        Assert.Equal(1, m.State.Score[0]);
        Assert.Equal(1, m.Stats.Teams[0].Shots);
        Assert.Equal(1, m.Stats.Teams[0].ShotsOnTarget);
        Assert.Equal(1, m.Stats.Humans[0].Goals);
    }
}
