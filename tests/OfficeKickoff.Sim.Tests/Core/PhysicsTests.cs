using static OfficeKickoff.Sim.Tests.TestKit;

namespace OfficeKickoff.Sim.Tests.Core;

public class PhysicsTests
{
    // ------------------------------------------------------------------------------------
    //  Movement
    // ------------------------------------------------------------------------------------

    [Fact]
    public void Input_moves_the_footballer_at_run_speed()
    {
        var m = Arena();
        int i = Index(m, 0, 1);
        Place(m, i, new Vec2(-300f, 200f));
        Seat(m, 0, i);
        m.SetInput(0, Input(move: new Vec2(1f, 0f), aim: new Vec2(2000f, 200f)));
        Step(m, 60);
        AssertNear(m.Tuning.Player.RunSpeed, P(m, i).Vel.Length, 1f, "speed");
        Assert.InRange(P(m, i).Pos.X, -300f + 0.85f * 290f, -300f + 290f);
        AssertNear(200f, P(m, i).Pos.Y, 0.01f);
    }

    [Fact]
    public void Ai_footballer_moves_at_its_speed_factor()
    {
        var m = Arena(out var ai);
        int i = Index(m, 1, 2);
        Place(m, i, new Vec2(300f, 0f));
        ai.Hold(i, Input(move: new Vec2(-1f, 0f), aim: new Vec2(-2000f, 0f)));
        Step(m, 60);
        AssertNear(m.Tuning.Player.RunSpeed * AiSpeedFactor(m, i), P(m, i).Vel.Length, 1f, "speed");
    }

    [Fact]
    public void Non_finite_and_oversized_input_is_sanitised()
    {
        var m = Arena();
        int i = Index(m, 0, 1);
        Place(m, i, new Vec2(-300f, 0f));
        Seat(m, 0, i);
        m.SetInput(0, Input(move: new Vec2(float.NaN, float.PositiveInfinity), aim: new Vec2(float.NegativeInfinity, float.NaN)));
        Step(m, 10);
        Assert.Equal(new Vec2(-300f, 0f), P(m, i).Pos);
        m.SetInput(0, Input(move: new Vec2(1e30f, 0f), aim: new Vec2(1e30f, 0f)));
        Step(m, 60);
        Assert.True(P(m, i).Vel.Length <= m.Tuning.Player.RunSpeed + 0.5f);
        AssertSane(m);
    }

    [Fact]
    public void Sprint_drains_stamina_and_locks_when_exhausted()
    {
        var m = Arena();
        var pt = m.Tuning.Player;
        int i = Index(m, 0, 1);
        Place(m, i, new Vec2(-300f, 300f));
        Seat(m, 0, i);
        m.SetInput(0, Input(move: new Vec2(1f, 0f), aim: new Vec2(2000f, 300f), sprint: true));
        Step(m, 60);
        AssertNear(1f - pt.SprintDrain, P(m, i).Stamina, 0.01f, "stamina");
        Assert.True(P(m, i).Sprinting);
        AssertNear(pt.SprintSpeed, P(m, i).Vel.Length, 1f);

        StepUntil(m, mm => P(mm, i).Exhausted, 400);
        Assert.Equal(0f, P(m, i).Stamina);
        Step(m, 30);
        Assert.False(P(m, i).Sprinting);
        Assert.True(P(m, i).Exhausted);

        m.SetInput(0, Input(move: new Vec2(-1f, 0f), aim: new Vec2(-2000f, 300f)));
        StepUntil(m, mm => !P(mm, i).Exhausted, 600);
        Assert.True(P(m, i).Stamina >= pt.ExhaustedRecover - 0.01f);
    }

    [Fact]
    public void Walls_and_rounded_corners_keep_footballers_in()
    {
        var m = Arena();
        var pitch = m.Pitch;
        float r = m.Tuning.Player.Radius;
        int i = Index(m, 0, 1);
        Place(m, i, new Vec2(400f, 200f));
        Seat(m, 0, i);
        m.SetInput(0, Input(move: new Vec2(1f, 1f), aim: new Vec2(2000f, 2000f), sprint: true));
        for (int t = 0; t < 240; t++)
        {
            m.Step();
            Assert.True(InsideWalls(pitch, P(m, i).Pos, r));
        }

        var centre = new Vec2(pitch.HalfW - pitch.CornerRadius, pitch.HalfH - pitch.CornerRadius);
        AssertNear(pitch.CornerRadius - r, Vec2.Distance(P(m, i).Pos, centre), 0.5f, "distance from the corner arc centre");
        Assert.True(P(m, i).Vel.Length < 5f);

        m.SetInput(0, Input(move: new Vec2(1f, 0f), aim: new Vec2(2000f, 0f)));
        Place(m, i, new Vec2(600f, 0f));
        m.SetInput(0, Input(move: new Vec2(1f, 0f), aim: new Vec2(2000f, 0f)));
        Step(m, 60);
        AssertNear(pitch.HalfW - r, P(m, i).Pos.X, 0.01f, "nobody walks into the net");
    }

    // ------------------------------------------------------------------------------------
    //  Free ball
    // ------------------------------------------------------------------------------------

    [Fact]
    public void Free_ball_slows_with_drag_and_friction_then_stops()
    {
        var m = Arena();
        FreeBall(m, new Vec2(-300f, 200f), new Vec2(600f, 0f));
        float prev = 600f;
        int ticks = 0;
        while (m.State.Ball.Vel != Vec2.Zero && ticks < 600)
        {
            m.Step();
            ticks++;
            float speed = m.State.Ball.Vel.Length;
            Assert.True(speed < prev || speed == 0f);
            prev = speed;
        }

        // Analytic solution of dv/dt = -Drag v - RollFriction down to StopSpeed: about 4.2 s and 795 units.
        Assert.InRange(ticks, 240, 262);
        AssertNear(-300f + 795f, m.State.Ball.Pos.X, 20f, "rolled distance");
        Assert.Equal(-1, m.State.Ball.Owner);
        Step(m, 30);
        AssertNear(-300f + 795f, m.State.Ball.Pos.X, 20f, "it stays put");
    }

    [Fact]
    public void Wall_bounce_keeps_restitution_and_friction()
    {
        var m = Arena();
        var pt = m.Tuning.Pitch;
        FreeBall(m, new Vec2(0f, 300f), new Vec2(200f, 800f));
        Vec2 before = m.State.Ball.Vel;
        for (int t = 0; t < 60; t++)
        {
            before = m.State.Ball.Vel;
            m.Step();
            if (Has(m.Events, GameEventType.WallBounce)) break;
        }

        var after = m.State.Ball.Vel;
        Assert.True(after.Y < 0f, "the ball comes back off the wall");
        Assert.InRange(-after.Y, before.Y * pt.WallBounce * 0.93f, before.Y * pt.WallBounce * 1.001f);
        Assert.InRange(after.X, before.X * pt.WallFriction * 0.93f, before.X * pt.WallFriction * 1.001f);
        Assert.True(InsideWalls(m.Pitch, m.State.Ball.Pos, m.Tuning.Ball.Radius));
    }

    [Fact]
    public void A_soft_touch_against_the_wall_raises_no_bounce_event()
    {
        var m = Arena();
        FreeBall(m, new Vec2(0f, m.Pitch.HalfH - m.Tuning.Ball.Radius - 2f), new Vec2(0f, 50f));
        var ev = Collect(m, 30);
        Assert.False(Has(ev, GameEventType.WallBounce));
    }

    [Fact]
    public void Ball_fired_into_the_corners_from_many_angles_never_leaves_the_pitch()
    {
        var m = Arena();
        var pitch = m.Pitch;
        int bounces = 0;
        foreach (float sx in new[] { -1f, 1f })
        {
            foreach (float sy in new[] { -1f, 1f })
            {
                for (int k = 0; k < 13; k++)
                {
                    if (m.State.Phase != MatchPhase.Playing) m = Arena();

                    // Clear the corners: everyone stands on the halfway line.
                    for (int i = 0; i < m.State.Players.Length; i++) Place(m, i, new Vec2(0f, -225f + i * 45f));
                    var start = new Vec2(sx * (pitch.HalfW - 260f), sy * (pitch.HalfH - 160f));
                    var corner = new Vec2(sx * pitch.HalfW, sy * pitch.HalfH);
                    float angle = (corner - start).Angle + (k - 6) * 0.1f;
                    FreeBall(m, start, Vec2.FromAngle(angle, 2300f));
                    for (int t = 0; t < 90; t++)
                    {
                        m.Step();
                        if (Has(m.Events, GameEventType.WallBounce)) bounces++;
                        Assert.True(BallInBounds(m), $"ball out at ({m.State.Ball.Pos.X}, {m.State.Ball.Pos.Y}), corner ({sx}, {sy}) k {k}");
                        if (m.State.Phase != MatchPhase.Playing) break;
                    }
                }
            }
        }

        Assert.True(bounces >= 52);
    }

    [Theory]
    [InlineData(1500f)]
    [InlineData(2400f)]
    public void Ball_bounces_off_a_post(float speed)
    {
        var m = Arena();
        var ev = new List<GameEvent>();
        FreeBall(m, new Vec2(560f, m.Pitch.GoalHalf - 5f), new Vec2(speed, 0f));
        for (int t = 0; t < 20 && !Has(ev, GameEventType.PostHit); t++) ev.AddRange(Collect(m));
        Assert.True(Has(ev, GameEventType.PostHit));
        Assert.True(m.State.Ball.Vel.X < 0f, "the post sends it back");
        Assert.Equal(0, m.State.Score[0]);
        Assert.True(InsideWalls(m.Pitch, m.State.Ball.Pos, m.Tuning.Ball.Radius, 1f));
    }

    [Fact]
    public void Wall_and_post_bounces_clear_the_on_target_flag()
    {
        var m = Arena();
        FreeBall(m, new Vec2(560f, m.Pitch.GoalHalf - 5f), new Vec2(1500f, 0f), Index(m, 0, 1), TouchKind.Strike);
        m.State.Ball.OnTargetGoal = 1;
        StepUntilEvent(m, GameEventType.PostHit, 30);
        Assert.Equal(-1, m.State.Ball.OnTargetGoal);
    }

    [Fact]
    public void Ball_at_max_speed_does_not_tunnel_through_a_footballer()
    {
        var m = Arena();
        int i = Index(m, 1, 2);
        Place(m, i, Vec2.Zero);
        FreeBall(m, new Vec2(-200f, 0f), new Vec2(m.Tuning.Ball.MaxSpeed, 0f));
        var ev = new List<GameEvent>();
        for (int t = 0; t < 12; t++)
        {
            ev.AddRange(Collect(m));
            Assert.True(m.State.Ball.Pos.X < 0f, "the ball went through the footballer");
        }

        Assert.True(Has(ev, GameEventType.Deflect));
        Assert.True(m.State.Ball.Vel.X < 0f);
    }

    // ------------------------------------------------------------------------------------
    //  Trap or deflect
    // ------------------------------------------------------------------------------------

    [Theory]
    [InlineData(1f, 760f, true)]
    [InlineData(1f, 900f, false)]
    [InlineData(1.5f, 1150f, true)]
    [InlineData(1.5f, 1350f, false)]
    [InlineData(0.75f, 760f, true)]
    [InlineData(0.75f, 900f, false)]
    public void Trap_or_deflect_depends_on_relative_speed_scaled_by_ball_speed(float ballSpeed, float speed, bool traps)
    {
        var m = Arena(settings: s => s.BallSpeed = ballSpeed);
        int i = Index(m, 1, 2);
        Place(m, i, Vec2.Zero);
        FreeBall(m, new Vec2(-60f, 0f), new Vec2(speed, 0f), Index(m, 0, 1), TouchKind.Strike);
        var ev = Collect(m, 3);
        if (traps)
        {
            Assert.Equal(i, m.State.Ball.Owner);
            var trap = Single(ev, GameEventType.Trap);
            Assert.Equal(i, trap.A);
            Assert.Equal(i, m.State.Ball.LastTouch);
            Assert.Equal(TouchKind.Control, m.State.Ball.LastTouchKind);
            Assert.Equal(Index(m, 0, 1), m.State.Ball.PrevTouch);
        }
        else
        {
            Assert.Equal(-1, m.State.Ball.Owner);
            Assert.Equal(i, Single(ev, GameEventType.Deflect).A);
            Assert.True(m.State.Ball.Vel.X < 0f);
            Assert.Equal(TouchKind.Deflect, m.State.Ball.LastTouchKind);
        }
    }

    [Fact]
    public void Kicker_cannot_retrap_their_own_kick_during_the_cooldown()
    {
        var m = Arena();
        int i = Index(m, 0, 1);
        Place(m, i, Vec2.Zero);
        FreeBall(m, new Vec2(25f, 0f), Vec2.Zero, i, TouchKind.Strike);
        P(m, i).KickCooldown = 0.2f;
        int ticks = 0;
        while (m.State.Ball.Owner != i && ticks < 30)
        {
            m.Step();
            ticks++;
        }

        Assert.Equal(i, m.State.Ball.Owner);
        Assert.InRange(ticks, Ticks(0.2f), Ticks(0.2f) + 1);
    }

    [Fact]
    public void Kick_cooldown_does_not_make_a_footballer_intangible_to_another_ball()
    {
        var m = Arena();
        int i = Index(m, 0, 1);
        Place(m, i, Vec2.Zero);
        FreeBall(m, new Vec2(25f, 0f), Vec2.Zero, Index(m, 1, 1), TouchKind.Strike);
        P(m, i).KickCooldown = 0.2f;
        Step(m);
        Assert.Equal(i, m.State.Ball.Owner);
    }

    [Fact]
    public void Carried_ball_follows_its_owner_and_turns_towards_the_aim()
    {
        var m = Arena();
        int i = Index(m, 0, 1);
        Place(m, i, Vec2.Zero);
        Seat(m, 0, i);
        GiveBall(m, i);
        m.SetInput(0, Input(move: new Vec2(0f, 1f), aim: new Vec2(0f, 1000f)));
        Step(m, 30);
        var p = P(m, i);
        AssertNear(MathF.PI / 2f, m.State.Ball.DribbleAngle, 0.01f, "dribble angle");
        AssertNear(p.Pos + new Vec2(0f, DribbleReach(m)), m.State.Ball.Pos, 0.01f, "ball at the feet");
        Assert.Equal(p.Vel, m.State.Ball.Vel);
        Assert.True(m.State.Ball.OwnerTime > 0.45f);
    }
}
