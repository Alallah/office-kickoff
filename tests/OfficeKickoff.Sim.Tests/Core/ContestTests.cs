using static OfficeKickoff.Sim.Tests.TestKit;

namespace OfficeKickoff.Sim.Tests.Core;

public class ContestTests
{
    // ------------------------------------------------------------------------------------
    //  Touch-steal
    // ------------------------------------------------------------------------------------

    /// <summary>Away carrier on the centre spot facing its attack (-X), home thief just beyond the ball.</summary>
    private static (Match m, int thief, int carrier) StealScene(float ownerTime)
    {
        var m = Arena();
        int thief = Index(m, 0, 1), carrier = Index(m, 1, 1);
        Place(m, carrier, Vec2.Zero);
        Place(m, thief, new Vec2(-60f, 0f));
        GiveBall(m, carrier, ownerTime);
        return (m, thief, carrier);
    }

    [Fact]
    public void Touch_steal_takes_the_ball_and_counts()
    {
        var (m, thief, carrier) = StealScene(1f);
        var ev = Collect(m);
        Assert.Equal(thief, m.State.Ball.Owner);
        var steal = Single(ev, GameEventType.Steal);
        Assert.Equal(thief, steal.A);
        Assert.Equal(carrier, steal.B);
        AssertNear(m.Tuning.Ball.StealLockout, P(m, carrier).StealLockout, 0.001f);
        Assert.Equal(TouchKind.Control, m.State.Ball.LastTouchKind);
        Assert.Equal(carrier, m.State.Ball.PrevTouch);
        Assert.Equal(1, m.Stats.Teams[0].Steals);
        Assert.Equal(0, m.Stats.Teams[1].Steals);
    }

    [Fact]
    public void Carrier_is_protected_right_after_gaining_the_ball()
    {
        var (m, thief, carrier) = StealScene(0f);
        int protect = (int)MathF.Ceiling(m.Tuning.Ball.OwnerProtectTime * Tuning.TickRate);
        Step(m, protect - 2);
        Assert.Equal(carrier, m.State.Ball.Owner);
        StepUntil(m, mm => mm.State.Ball.Owner == thief, 4);
    }

    [Fact]
    public void Robbed_carrier_cannot_steal_straight_back()
    {
        var (m, thief, carrier) = StealScene(1f);
        Step(m);
        Assert.Equal(thief, m.State.Ball.Owner);
        Step(m, Ticks(m.Tuning.Ball.StealLockout) - 4);
        Assert.Equal(thief, m.State.Ball.Owner);
        StepUntil(m, mm => mm.State.Ball.Owner == carrier, 10);
    }

    [Fact]
    public void Dash_immunity_protects_against_outfield_steals()
    {
        var (m, thief, carrier) = StealScene(1f);
        P(m, carrier).Immune = 0.25f;
        Step(m, 12);
        Assert.Equal(carrier, m.State.Ball.Owner);
        StepUntil(m, mm => mm.State.Ball.Owner == thief, 8);
    }

    [Fact]
    public void Stunned_or_sliding_footballers_cannot_steal_by_touch()
    {
        var (m, thief, carrier) = StealScene(1f);
        P(m, thief).Action = PlayerAction.Stunned;
        P(m, thief).ActionTime = 0.3f;
        Step(m, 10);
        Assert.Equal(carrier, m.State.Ball.Owner);
    }

    // ------------------------------------------------------------------------------------
    //  Slide tackles
    // ------------------------------------------------------------------------------------

    /// <summary>Home slider (human 0) at (-130, 0) about to slide towards +X.</summary>
    private static (Match m, int slider) SlideScene()
    {
        var m = Arena();
        int slider = Index(m, 0, 1);
        Place(m, slider, new Vec2(-130f, 0f));
        Seat(m, 0, slider);
        return (m, slider);
    }

    private static void Slide(Match m, Vec2 dir) => m.SetInput(0, Input(move: dir, aim: dir * 2000f, tackle: true));

    [Fact]
    public void Clean_tackle_wins_the_ball()
    {
        var (m, slider) = SlideScene();
        int carrier = Index(m, 1, 1);
        Place(m, carrier, Vec2.Zero);
        GiveBall(m, carrier, 0f);
        Slide(m, new Vec2(1f, 0f));
        var ev = StepUntilEvent(m, GameEventType.TackleHit, 20);

        Assert.Equal(1, CountOf(ev, GameEventType.SlideStart));
        var hit = Single(ev, GameEventType.TackleHit);
        Assert.Equal(slider, hit.A);
        Assert.Equal(carrier, hit.B);
        Assert.Equal(1, hit.Flag);
        Assert.Equal(slider, m.State.Ball.Owner);
        Assert.True(P(m, slider).SlideHit);
        Assert.True(P(m, carrier).StealLockout > 0f);
        Assert.NotEqual(PlayerAction.Stunned, P(m, carrier).Action);
        Assert.Equal(1, m.Stats.Teams[0].Tackles);
        Assert.Equal(1, m.Stats.Humans[0].Tackles);

        StepUntil(m, mm => P(mm, slider).Action == PlayerAction.None, 60);
        Assert.False(Has(Collect(m, 5), GameEventType.SlideMiss));
    }

    [Fact]
    public void Body_hit_on_the_carrier_stuns_knocks_back_and_spills_the_ball()
    {
        var (m, slider) = SlideScene();
        var tk = m.Tuning.Tackle;
        int carrier = Index(m, 1, 1);
        Place(m, carrier, Vec2.Zero, aim: 0f);
        GiveBall(m, carrier);
        Slide(m, new Vec2(1f, 0f));
        var ev = StepUntilEvent(m, GameEventType.TackleHit, 20);

        var hit = Single(ev, GameEventType.TackleHit);
        Assert.Equal(slider, hit.A);
        Assert.Equal(carrier, hit.B);
        Assert.Equal(0, hit.Flag);
        ref var o = ref P(m, carrier);
        Assert.Equal(PlayerAction.Stunned, o.Action);
        AssertNear(tk.VictimStun, o.ActionTime, 0.001f, "stun");
        AssertNear(tk.Knockback, o.Vel.X, 0.01f, "knockback");
        Assert.Equal(m.Tuning.Kick.KickCooldown, o.KickCooldown, 3);
        Assert.False(o.Charging);

        var b = m.State.Ball;
        Assert.Equal(-1, b.Owner);
        Assert.Equal(slider, b.LastTouch);
        Assert.Equal(TouchKind.Deflect, b.LastTouchKind);
        AssertNear(tk.LooseBallSpeed, b.Vel.Length, 8f, "spill speed");
        Assert.True(MathF.Abs(b.Vel.Angle) <= 0.5f + 0.01f);
        Assert.Equal(1, m.Stats.Teams[0].Tackles);
        Assert.Equal(1, m.Stats.Humans[0].Tackles);
    }

    [Fact]
    public void Body_hit_without_the_ball_is_a_short_bump_and_not_a_tackle()
    {
        var (m, slider) = SlideScene();
        int victim = Index(m, 1, 2);
        Place(m, victim, Vec2.Zero);
        FreeBall(m, new Vec2(0f, 300f), Vec2.Zero);
        Slide(m, new Vec2(1f, 0f));
        var ev = StepUntilEvent(m, GameEventType.TackleHit, 20);
        Assert.Equal(victim, Single(ev, GameEventType.TackleHit).B);
        AssertNear(m.Tuning.Tackle.BumpStun, P(m, victim).ActionTime, 0.001f);
        Assert.Equal(0, m.Stats.Teams[0].Tackles);

        // One body hit per slide.
        int other = Index(m, 1, 3);
        Place(m, other, P(m, slider).Pos + new Vec2(45f, 0f));
        var more = Collect(m, 10);
        Assert.False(Has(more, GameEventType.TackleHit));
        Assert.Equal(PlayerAction.None, P(m, other).Action);
    }

    [Fact]
    public void Missed_slide_stuns_the_slider_and_the_cooldown_blocks_another()
    {
        var (m, slider) = SlideScene();
        var tk = m.Tuning.Tackle;
        FreeBall(m, new Vec2(0f, 300f), Vec2.Zero);
        Slide(m, new Vec2(0f, -1f));
        var ev = StepUntilEvent(m, GameEventType.SlideMiss, 40);
        Assert.Equal(slider, Single(ev, GameEventType.SlideMiss).A);
        Assert.Equal(PlayerAction.Stunned, P(m, slider).Action);
        AssertNear(tk.MissStun, P(m, slider).ActionTime, 0.02f);

        StepUntil(m, mm => P(mm, slider).Action == PlayerAction.None, 60);
        Assert.True(P(m, slider).TackleCooldown > 0f);
        Slide(m, new Vec2(1f, 0f));
        Assert.False(Has(Collect(m), GameEventType.SlideStart));

        StepUntil(m, mm => P(mm, slider).TackleCooldown <= 0f, 120);
        Slide(m, new Vec2(1f, 0f));
        Assert.True(Has(Collect(m), GameEventType.SlideStart));
    }

    [Fact]
    public void Slides_never_affect_team_mates()
    {
        var (m, slider) = SlideScene();
        int mate = Index(m, 0, 2);
        Place(m, mate, Vec2.Zero, aim: 0f);
        GiveBall(m, mate);
        Slide(m, new Vec2(1f, 0f));
        var ev = Collect(m, 25);
        Assert.False(Has(ev, GameEventType.TackleHit));
        Assert.Equal(PlayerAction.None, P(m, mate).Action);
        Assert.Equal(mate, m.State.Ball.Owner);
    }

    [Fact]
    public void Sliding_onto_a_loose_ball_traps_it_whatever_its_speed()
    {
        var (m, slider) = SlideScene();
        FreeBall(m, new Vec2(-30f, 0f), new Vec2(-1400f, 0f), Index(m, 1, 1), TouchKind.Strike);
        P(m, slider).Action = PlayerAction.Slide;
        P(m, slider).ActionTime = 0.3f;
        P(m, slider).ActionDir = new Vec2(1f, 0f);
        P(m, slider).SlideHit = false;
        m.SetInput(0, Input(move: new Vec2(1f, 0f), aim: new Vec2(2000f, 0f)));
        var ev = Collect(m, 3);
        Assert.Equal(slider, m.State.Ball.Owner);
        var hit = Single(ev, GameEventType.TackleHit);
        Assert.Equal(-1, hit.B);
        Assert.Equal(1, hit.Flag);
        Assert.False(Has(ev, GameEventType.Trap));
        Assert.Equal(0, m.Stats.Teams[0].Tackles);
    }

    [Fact]
    public void Dashing_carrier_cannot_be_tackled()
    {
        var (m, slider) = SlideScene();
        int carrier = Index(m, 1, 1);
        Place(m, carrier, Vec2.Zero);
        GiveBall(m, carrier);
        P(m, carrier).Immune = 1f;
        Slide(m, new Vec2(1f, 0f));
        var ev = Collect(m, 20);
        Assert.False(Has(ev, GameEventType.TackleHit));
        Assert.Equal(carrier, m.State.Ball.Owner);
    }

    // ------------------------------------------------------------------------------------
    //  Collisions
    // ------------------------------------------------------------------------------------

    [Fact]
    public void Overlapping_footballers_are_pushed_apart_evenly()
    {
        var m = Arena();
        int a = Index(m, 0, 1), c = Index(m, 1, 1);
        Place(m, a, new Vec2(-10f, 200f));
        Place(m, c, new Vec2(10f, 200f));
        Step(m);
        AssertNear(2f * m.Tuning.Player.Radius, Vec2.Distance(P(m, a).Pos, P(m, c).Pos), 0.01f);
        AssertNear(0f, (P(m, a).Pos.X + P(m, c).Pos.X) / 2f, 0.01f, "midpoint");
        Assert.Equal(Vec2.Zero, P(m, a).Vel);
    }

    [Fact]
    public void A_dashing_footballer_holds_ground()
    {
        var m = Arena();
        int a = Index(m, 0, 1), c = Index(m, 1, 1);
        Place(m, a, new Vec2(-10f, 200f));
        Place(m, c, new Vec2(10f, 200f));
        P(m, a).Action = PlayerAction.Dash;
        P(m, a).ActionTime = 0.2f;
        P(m, a).ActionDir = new Vec2(0f, 1f);
        Step(m);
        Vec2 dashed = new Vec2(-10f, 200f) + new Vec2(0f, m.Tuning.Tackle.DashSpeed * Dt);
        AssertNear(dashed, P(m, a).Pos, 0.01f, "dasher");
        AssertNear(2f * m.Tuning.Player.Radius, Vec2.Distance(P(m, a).Pos, P(m, c).Pos), 0.01f);
    }
}
