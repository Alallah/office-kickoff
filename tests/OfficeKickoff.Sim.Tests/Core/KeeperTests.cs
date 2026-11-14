using static OfficeKickoff.Sim.Tests.TestKit;

namespace OfficeKickoff.Sim.Tests.Core;

public class KeeperTests
{
    private static readonly Vec2 KeeperSpot = new(-700f, 0f);

    /// <summary>Home keeper set on its line; an away striker's shot heading at it.</summary>
    private static Match ShotAtKeeper(float speed, bool onTarget, Action<MatchSettings>? settings = null)
    {
        var m = Arena(settings: settings);
        Place(m, 0, KeeperSpot);
        FreeBall(m, new Vec2(-450f, 0f), new Vec2(-speed, 0f), Index(m, 1, 1), TouchKind.Strike);
        m.State.Ball.OnTargetGoal = onTarget ? 0 : -1;
        return m;
    }

    [Fact]
    public void Keeper_catches_a_slow_shot_and_holds_it()
    {
        var m = ShotAtKeeper(800f, onTarget: true);
        var ev = Collect(m, 30);
        Assert.Equal(0, m.State.Ball.Owner);
        Assert.True(m.State.Ball.Held);
        Assert.Equal(0, Single(ev, GameEventType.KeeperCatch).A);
        Assert.Equal(TouchKind.Catch, m.State.Ball.LastTouchKind);
        Assert.Equal(1, m.Stats.Teams[0].Saves);
        Assert.False(Has(ev, GameEventType.Trap));
    }

    [Fact]
    public void Saves_count_only_for_shots_on_target()
    {
        var m = ShotAtKeeper(800f, onTarget: false);
        Collect(m, 30);
        Assert.Equal(0, m.State.Ball.Owner);
        Assert.Equal(0, m.Stats.Teams[0].Saves);
    }

    [Theory]
    [InlineData(1300f, 0f)]
    [InlineData(1300f, 80f)]
    [InlineData(2000f, -60f)]
    public void Keeper_parries_a_fast_shot_away_from_goal(float speed, float offset)
    {
        var m = ShotAtKeeper(speed, onTarget: true);
        FreeBall(m, new Vec2(-450f, offset * 0.5f), new Vec2(-speed, -offset), Index(m, 1, 1), TouchKind.Strike);
        m.State.Ball.OnTargetGoal = 0;
        var ev = StepUntilEvent(m, GameEventType.KeeperParry, 30);
        Assert.Equal(0, Single(ev, GameEventType.KeeperParry).A);
        Assert.Equal(-1, m.State.Ball.Owner);
        Assert.True(m.State.Ball.Vel.X > 0f, "the parry goes away from the goal line");
        Assert.Equal(TouchKind.Deflect, m.State.Ball.LastTouchKind);
        Assert.Equal(1, m.Stats.Teams[0].Saves);
        Step(m, 30);
        Assert.Equal(0, m.State.Score[1]);
    }

    [Fact]
    public void Catch_speed_scales_with_fast_ball_settings()
    {
        var m = ShotAtKeeper(1200f, onTarget: true, settings: s => s.BallSpeed = 1.5f);
        Collect(m, 30);
        Assert.True(m.State.Ball.Held);
    }

    [Fact]
    public void Keeper_outside_the_box_plays_like_an_outfielder()
    {
        var m = Arena();
        Place(m, 0, new Vec2(-300f, 0f));
        FreeBall(m, new Vec2(-200f, 0f), new Vec2(-500f, 0f), Index(m, 1, 1), TouchKind.Strike);
        var ev = Collect(m, 20);
        Assert.Equal(0, m.State.Ball.Owner);
        Assert.False(m.State.Ball.Held);
        Assert.True(Has(ev, GameEventType.Trap));
    }

    [Fact]
    public void Held_ball_cannot_be_stolen_or_tackled()
    {
        var m = Arena();
        Place(m, 0, KeeperSpot);
        GiveBall(m, 0, 0.5f);
        m.State.Ball.Held = true;
        int thief = Index(m, 1, 1);
        Place(m, thief, KeeperSpot + new Vec2(60f, 0f), aim: MathF.PI);
        var ev = Collect(m, 20);
        Assert.Equal(0, m.State.Ball.Owner);
        Assert.False(Has(ev, GameEventType.Steal));
        Assert.False(m.Pitch.InBox(P(m, thief).Pos, 0));
    }

    [Fact]
    public void Box_is_closed_to_opponents_while_the_keeper_holds_the_ball()
    {
        var m = Arena();
        var pitch = m.Pitch;
        Place(m, 0, KeeperSpot);
        GiveBall(m, 0, 0f);
        m.State.Ball.Held = true;
        int runner = Index(m, 1, 1), inside = Index(m, 1, 2);
        Place(m, runner, new Vec2(-450f, 0f));
        Place(m, inside, new Vec2(-650f, 150f));
        Seat(m, 2, runner);
        m.SetInput(2, Input(move: new Vec2(-1f, 0f), aim: new Vec2(-2000f, 0f), sprint: true));

        Step(m);
        float pushed = P(m, inside).Pos.X - -650f;
        AssertNear(m.Tuning.Keeper.SanctuaryPush * Dt, pushed, 0.5f, "pushed out gradually");
        for (int t = 0; t < 90; t++)
        {
            m.Step();
            Assert.False(pitch.InBox(P(m, runner).Pos, 0), $"runner entered the box at tick {t}");
            Assert.Equal(0, m.State.Ball.Owner);
        }

        Assert.False(pitch.InBox(P(m, inside).Pos, 0));
        AssertNear(-pitch.HalfW + pitch.BoxDepth, P(m, runner).Pos.X, 1f, "runner waits at the edge");
    }

    [Fact]
    public void Keeper_is_forced_to_release_at_max_hold_time()
    {
        var m = Arena();
        Place(m, 0, KeeperSpot);
        Place(m, 1, new Vec2(-400f, 300f));
        Place(m, 2, new Vec2(-450f, -100f));
        GiveBall(m, 0, 0f);
        m.State.Ball.Held = true;
        var ev = StepUntilEvent(m, GameEventType.Pass, Ticks(m.Tuning.Keeper.MaxHoldTime) + 3);
        var pass = Single(ev, GameEventType.Pass);
        Assert.Equal(0, pass.A);
        Assert.Equal(2, pass.B);
        Assert.False(m.State.Ball.Held);
        Assert.Equal(-1, m.State.Ball.Owner);
    }

    [Fact]
    public void Forced_release_happens_after_exactly_max_hold_time()
    {
        var m = Arena();
        Place(m, 0, KeeperSpot);
        Place(m, 2, new Vec2(-450f, -100f));
        GiveBall(m, 0, 0f);
        m.State.Ball.Held = true;
        int ticks = 0;
        while (m.State.Ball.Owner == 0 && ticks < 400)
        {
            m.Step();
            ticks++;
        }

        Assert.InRange(ticks, Ticks(m.Tuning.Keeper.MaxHoldTime) - 1, Ticks(m.Tuning.Keeper.MaxHoldTime) + 1);
    }

    [Fact]
    public void Back_pass_is_taken_at_the_feet_and_can_be_stolen()
    {
        var m = Arena();
        Place(m, 0, KeeperSpot);
        FreeBall(m, new Vec2(-600f, 0f), new Vec2(-300f, 0f), Index(m, 0, 1), TouchKind.Strike);
        var ev = StepUntil(m, mm => mm.State.Ball.Owner == 0, 40);
        Assert.False(m.State.Ball.Held);
        Assert.True(Has(ev, GameEventType.Trap));
        Assert.False(Has(ev, GameEventType.KeeperCatch));

        int thief = Index(m, 1, 1);
        Step(m, 10);
        var ball = m.State.Ball.Pos;
        var away = (ball - P(m, 0).Pos).Normalized();
        Place(m, thief, ball + away * 26f, aim: MathF.PI);
        ev = StepUntilEvent(m, GameEventType.Steal, 30);
        Assert.Equal(thief, m.State.Ball.Owner);
        Assert.Equal(0, Single(ev, GameEventType.Steal).B);
    }

    [Fact]
    public void Fast_back_pass_deflects_off_the_keeper()
    {
        var m = Arena();
        Place(m, 0, KeeperSpot);
        FreeBall(m, new Vec2(-600f, 0f), new Vec2(-1400f, 0f), Index(m, 0, 1), TouchKind.Strike);
        var ev = Collect(m, 10);
        Assert.True(Has(ev, GameEventType.Deflect));
        Assert.False(Has(ev, GameEventType.KeeperCatch));
        Assert.Equal(-1, m.State.Ball.Owner);
    }

    [Fact]
    public void Keeper_steals_inside_its_box_whatever_the_carriers_immunity_and_holds()
    {
        var m = Arena();
        Place(m, 0, KeeperSpot);
        int carrier = Index(m, 1, 1);
        Place(m, carrier, new Vec2(-640f, 0f));
        GiveBall(m, carrier);
        P(m, carrier).Immune = 0.25f;
        var ev = Collect(m);
        Assert.Equal(0, Single(ev, GameEventType.Steal).A);
        Assert.True(m.State.Ball.Held);
    }

    [Fact]
    public void Keeper_in_its_box_cannot_be_slid_into_or_shoved()
    {
        var m = Arena();
        Place(m, 0, KeeperSpot);
        int slider = Index(m, 1, 1);
        Place(m, slider, new Vec2(-600f, 0f));
        Seat(m, 2, slider);
        m.SetInput(2, Input(move: new Vec2(-1f, 0f), aim: new Vec2(-2000f, 0f), tackle: true));
        var ev = Collect(m, 30);
        Assert.True(Has(ev, GameEventType.SlideStart));
        Assert.False(Has(ev, GameEventType.TackleHit));
        Assert.Equal(PlayerAction.None, P(m, 0).Action);
        AssertNear(KeeperSpot, P(m, 0).Pos, 0.01f, "keeper");
        Assert.True(Vec2.Distance(P(m, slider).Pos, KeeperSpot) >= 2f * m.Tuning.Player.Radius - 0.01f);
    }

    [Fact]
    public void Dashing_at_a_set_keeper_from_180_units_does_not_score()
    {
        var m = Arena();
        var keeperHome = P(m, 0).HomePos;
        Place(m, 0, keeperHome);
        int striker = Index(m, 1, 1);
        Place(m, striker, keeperHome + new Vec2(180f, 0f));
        Seat(m, 2, striker);
        GiveBall(m, striker);
        m.SetInput(2, Input(move: new Vec2(-1f, 0f), aim: new Vec2(-2000f, 0f), sprint: true, tackle: true));
        var ev = Collect(m);
        Assert.True(Has(ev, GameEventType.Dash));
        m.SetInput(2, Input(move: new Vec2(-1f, 0f), aim: new Vec2(-2000f, 0f), sprint: true));
        ev.AddRange(Collect(m, 120));
        Assert.False(Has(ev, GameEventType.Goal));
        Assert.Equal(0, m.State.Score[1]);
        Assert.Equal(0, m.State.Ball.Owner);
        AssertNear(keeperHome, P(m, 0).Pos, 0.01f, "the keeper was not shoved");
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public void Outfield_block_of_an_on_target_shot_is_a_save(bool onTarget)
    {
        var m = Arena();
        int d = Index(m, 1, 1);
        Place(m, d, new Vec2(500f, 0f));
        Seat(m, 2, d);
        Step(m);
        FreeBall(m, new Vec2(400f, 0f), new Vec2(1200f, 0f), Index(m, 0, 1), TouchKind.Strike);
        m.State.Ball.OnTargetGoal = onTarget ? 1 : -1;
        var ev = StepUntilEvent(m, GameEventType.Deflect, 10);
        Assert.Equal(onTarget, Has(ev, GameEventType.Block));
        Assert.Equal(onTarget ? 1 : 0, m.Stats.Teams[1].Saves);
        Assert.Equal(onTarget ? 1 : 0, m.Stats.Humans[2].Saves);
        Assert.Equal(-1, m.State.Ball.OnTargetGoal);
    }

    [Fact]
    public void Diving_keeper_reaches_further()
    {
        var m = Arena();
        var reach = m.Tuning.Keeper.Reach.Normal;
        Place(m, 0, KeeperSpot);
        P(m, 0).Action = PlayerAction.Dive;
        P(m, 0).ActionTime = 0.3f;
        P(m, 0).ActionDir = new Vec2(0f, 1f);
        P(m, 0).Vel = Vec2.Zero;
        // The dive carries the keeper about 10 units this tick; only the extra reach closes the rest.
        FreeBall(m, P(m, 0).Pos + new Vec2(0f, ContactReach(m) + reach + 8f), Vec2.Zero, Index(m, 1, 1), TouchKind.Strike);
        Step(m);
        Assert.Equal(0, m.State.Ball.Owner);
        Assert.True(Vec2.Distance(P(m, 0).Pos, m.State.Ball.Pos) > ContactReach(m) || m.State.Ball.Held);
    }
}
