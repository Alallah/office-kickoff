using static OfficeKickoff.Sim.Tests.TestKit;

namespace OfficeKickoff.Sim.Tests.Core;

/// <summary>Matches played with MatchSettings.Keepers off: slot 0 is an ordinary outfield sweeper and the goals are narrower.</summary>
public class NoKeeperTests
{
    private static readonly Action<MatchSettings> NoKeepers = s => s.Keepers = false;

    public static TheoryData<int> AllSizes()
    {
        var data = new TheoryData<int>();
        for (int size = MatchSettings.MinTeamSize; size <= MatchSettings.MaxTeamSize; size++) data.Add(size);
        return data;
    }

    // ------------------------------------------------------------------------------------
    //  Settings
    // ------------------------------------------------------------------------------------

    [Fact]
    public void Keepers_are_on_by_default_and_survive_normalising_and_cloning()
    {
        Assert.True(new MatchSettings().Keepers);
        Assert.All(MatchSettings.Presets, p => Assert.True(p.Settings.Keepers, p.Id));
        Assert.All(MatchSettings.Presets, p => Assert.True(MatchSettings.FromPreset(p.Id).Keepers, p.Id));

        var off = new MatchSettings { Keepers = false, TeamSize = 99 };
        Assert.False(off.Normalized().Keepers);
        Assert.False(off.Clone().Keepers);
        Assert.Equal(5, off.Normalized().TeamSize);
    }

    // ------------------------------------------------------------------------------------
    //  Set-up
    // ------------------------------------------------------------------------------------

    [Theory]
    [MemberData(nameof(AllSizes))]
    public void Without_keepers_slot_0_is_a_deep_central_sweeper_and_the_goals_are_narrower(int size)
    {
        foreach (var formation in Formations.ValidFor(size))
        {
            var m = NewMatch(size, settings: NoKeepers, config: c => c.Formations = [formation, formation]);
            var s = m.State;
            var t = m.Tuning;
            float r = t.Player.Radius;

            Assert.Equal(2 * size, s.Players.Length);
            Assert.Equal(t.Pitch.GoalWidth.Get(size) * t.Pitch.NoKeeperGoalScale, m.Pitch.GoalWidth, 3);
            Assert.True(m.Pitch.GoalWidth < new PitchGeometry(size, t).GoalWidth);
            Assert.Equal(m.Pitch.GoalWidth / 2f, m.Pitch.GoalHalf, 3);
            Assert.Equal(m.Pitch.GoalHalf, MathF.Abs(m.Pitch.Posts[0].Y), 3);

            foreach (var p in s.Players)
            {
                Assert.False(p.IsKeeper, $"{size}-a-side {formation}: footballer {p.Index} is a keeper");
                Assert.Equal(-1, p.Controller);
                Assert.Equal(t.Ai.SpeedFactor.Get(m.Config.OutfieldLevel(p.Team)), p.SpeedFactor);
                Assert.True(InsideWalls(m.Pitch, p.HomePos, r), $"home of {p.Index} outside the walls");
                Assert.True(p.HomePos.X * PitchGeometry.AttackSign(p.Team) < 0f, $"home of {p.Index} not in its own half");
            }

            for (int team = 0; team < 2; team++)
            {
                ref readonly var sweeper = ref P(m, Index(m, team, 0));
                float back = PitchGeometry.AttackSign(team);
                Assert.Equal(Formations.SweeperSpot(formation, size), sweeper.Spot);
                Assert.Equal(0f, sweeper.HomePos.Y);
                Assert.Equal(0f, sweeper.DiveSpeed);

                // Close to its own goal, yet out in front of it, and behind every team-mate.
                float fromLine = (sweeper.HomePos.X - m.Pitch.GoalLineX(team)) * back;
                Assert.InRange(fromLine, 2f * r, m.Pitch.HalfW * 0.25f);
                for (int slot = 1; slot < size; slot++)
                {
                    float mate = (P(m, Index(m, team, slot)).HomePos.X - m.Pitch.GoalLineX(team)) * back;
                    Assert.True(mate > fromLine + r, $"{size}-a-side {formation}: slot {slot} is not ahead of the sweeper");
                }

                // Last in kickoff priority, and every slot of the team is in it.
                var order = KickoffOrder(m, team);
                Assert.Equal(size, order.Length);
                Assert.Equal(Index(m, team, 0), order[^1]);
            }

            for (int i = 0; i < s.Players.Length; i++)
            {
                for (int j = i + 1; j < s.Players.Length; j++)
                {
                    Assert.True(Vec2.Distance(s.Players[i].Pos, s.Players[j].Pos) >= 2f * r - 0.01f, $"{i} overlaps {j}");
                }
            }

            AssertSane(m);
        }
    }

    [Fact]
    public void With_keepers_the_pitch_and_slot_0_are_unchanged()
    {
        var m = NewMatch(5);
        Assert.True(P(m, 0).IsKeeper);
        Assert.True(P(m, 5).IsKeeper);
        Assert.Equal(m.Tuning.Pitch.GoalWidth.Get(5), m.Pitch.GoalWidth);
        Assert.Equal(4, KickoffOrder(m, 0).Length);
    }

    // ------------------------------------------------------------------------------------
    //  Control
    // ------------------------------------------------------------------------------------

    [Fact]
    public void Humans_fill_the_kickoff_order_and_the_sweeper_can_be_seated_on()
    {
        // 3-a-side, two humans: they get the two forwards; the sweeper stays with the AI.
        var m = NewMatch(3, settings: NoKeepers);
        Assert.True(m.AddHuman(0, 0, true) >= 0);
        Assert.True(m.AddHuman(1, 0, true) >= 0);
        var order = KickoffOrder(m, 0);
        Assert.Equal(order[0], m.State.Humans[0].PlayerIndex);
        Assert.Equal(order[1], m.State.Humans[1].PlayerIndex);
        Assert.Equal(-1, P(m, 0).Controller);
        AssertSane(m);

        var arena = Arena(3, settings: NoKeepers);
        Seat(arena, 0, 0);
        Assert.Equal(0, P(arena, 0).Controller);
        Assert.Equal(1f, P(arena, 0).SpeedFactor);
        Step(arena, 5);
        AssertSane(arena);
    }

    [Fact]
    public void Switching_reaches_the_sweeper()
    {
        var m = Arena(4, settings: NoKeepers);
        Seat(m, 0, Index(m, 0, 2));
        Place(m, 0, new Vec2(-200f, 0f));
        FreeBall(m, new Vec2(-150f, 0f), Vec2.Zero);

        // The sweeper is nearest the ball: "best" switches to it.
        m.SetInput(0, Input(aim: AimAhead(m, Index(m, 0, 2)), switchBest: true));
        Step(m);
        Assert.Equal(0, m.State.Humans[0].PlayerIndex);
        Assert.Equal(0, P(m, 0).Controller);
        AssertSane(m);

        // "Next" cycles through every slot, the sweeper included.
        var seen = new HashSet<int>();
        for (int k = 0; k < 4; k++)
        {
            m.SetInput(0, Input(aim: AimAhead(m, m.State.Humans[0].PlayerIndex), switchNext: true));
            Step(m);
            seen.Add(m.State.Humans[0].PlayerIndex);
        }

        Assert.Equal(new[] { 0, 1, 2, 3 }, seen.Order());
        AssertSane(m);
    }

    [Fact]
    public void A_pass_to_the_sweeper_is_an_ordinary_pass_and_the_passer_follows_it()
    {
        // The sweeper and an outfield team-mate stand on the same line; the sweeper is nearer.
        var m = Arena(5, settings: NoKeepers);
        int passer = Index(m, 0, 3), mate = Index(m, 0, 1);
        Seat(m, 0, passer);
        Place(m, passer, new Vec2(0f, 0f), aim: MathF.PI);
        Place(m, 0, new Vec2(-200f, 0f));
        Place(m, mate, new Vec2(-420f, 0f));
        GiveBall(m, passer);

        Assert.Equal(0, m.PassTargetFor(passer, new Vec2(-600f, 0f)));
        m.SetInput(0, Input(aim: new Vec2(-600f, 0f), pass: true));
        var ev = Collect(m);
        Assert.Equal(0, Single(ev, GameEventType.Pass).B);
        Assert.Equal(0, m.State.Humans[0].PlayerIndex);

        // With keepers the same aim goes to the outfield team-mate: the keeper is only a last resort.
        var k = Arena(5);
        Place(k, 0, new Vec2(-200f, 0f));
        Place(k, mate, new Vec2(-420f, 0f));
        Place(k, passer, new Vec2(0f, 0f), aim: MathF.PI);
        Assert.Equal(mate, k.PassTargetFor(passer, new Vec2(-600f, 0f)));
    }

    // ------------------------------------------------------------------------------------
    //  No keeper rules
    // ------------------------------------------------------------------------------------

    [Fact]
    public void A_shot_at_the_unguarded_goal_scores()
    {
        var m = Arena(5, settings: NoKeepers);
        int shooter = Index(m, 0, 4);
        Seat(m, 0, shooter);
        Place(m, shooter, new Vec2(m.Pitch.HalfW - 300f, 0f));
        GiveBall(m, shooter);

        var goal = m.Pitch.OpponentGoal(0);
        ChargeAndShoot(m, 0, Ticks(0.3f), goal);
        var ev = StepUntilEvent(m, GameEventType.Goal, 120);
        Assert.Equal(1, m.State.Score[0]);
        Assert.Equal(shooter, Single(ev, GameEventType.Goal).A);
        Assert.False(Has(ev, GameEventType.KeeperCatch) || Has(ev, GameEventType.KeeperParry));
    }

    [Fact]
    public void Slot_0_in_its_own_box_traps_instead_of_catching_and_is_never_held()
    {
        var m = Arena(5, settings: NoKeepers);
        int defender = Index(m, 1, 0);
        float x = m.Pitch.HalfW - 80f;
        Place(m, defender, new Vec2(x, 0f));
        Assert.True(m.Pitch.InBox(P(m, defender).Pos, 1));

        // A slow ball at it, struck by an opponent: a keeper would catch this.
        int striker = Index(m, 0, 4);
        FreeBall(m, new Vec2(x - 200f, 0f), new Vec2(500f, 0f), lastTouch: striker, kind: TouchKind.Strike);
        var ev = StepUntil(m, mm => mm.State.Ball.Owner >= 0, 120);
        Assert.Equal(defender, m.State.Ball.Owner);
        Assert.False(m.State.Ball.Held);
        Assert.Equal(TouchKind.Control, m.State.Ball.LastTouchKind);
        Assert.False(Has(ev, GameEventType.KeeperCatch));
        Assert.True(Has(ev, GameEventType.Trap));

        // Holding it for ages forces nothing: there is no keeper release.
        var held = Collect(m, Ticks(m.Tuning.Keeper.MaxHoldTime + 0.5f));
        Assert.Equal(defender, m.State.Ball.Owner);
        Assert.False(Has(held, GameEventType.Pass));
        AssertSane(m);
    }

    [Fact]
    public void Slot_0_can_be_tackled_and_robbed_inside_its_own_box()
    {
        var m = Arena(5, settings: NoKeepers);
        int carrier = Index(m, 0, 0), thief = Index(m, 1, 4);
        Vec2 spot = new(-m.Pitch.HalfW + 90f, 0f);
        Place(m, carrier, spot);
        GiveBall(m, carrier);
        Assert.True(m.Pitch.InBox(spot, 0));

        // A slide from in front takes it cleanly.
        Seat(m, 2, thief);
        Place(m, thief, spot + new Vec2(110f, 0f), aim: MathF.PI);
        m.SetInput(2, Input(move: new Vec2(-1f, 0f), aim: spot, tackle: true));
        var ev = StepUntil(m, mm => mm.State.Ball.Owner != carrier, 60);
        Assert.Equal(thief, m.State.Ball.Owner);
        Assert.Contains(ev, e => e.Type == GameEventType.TackleHit && e.A == thief);

        // Touch-steal inside its own box.
        var n = Arena(5, settings: NoKeepers);
        Place(n, carrier, spot);
        GiveBall(n, carrier);
        Place(n, thief, spot + new Vec2(DribbleReach(n) + 18f, 0f), aim: MathF.PI);
        var steal = StepUntil(n, mm => mm.State.Ball.Owner != carrier, 30);
        Assert.Equal(thief, n.State.Ball.Owner);
        Assert.True(Has(steal, GameEventType.Steal));
        AssertSane(n);

        // A slide into its body floors it there: a keeper in its own box could not be slid into.
        var o = Arena(out var ai, 5, settings: NoKeepers);
        Place(o, carrier, spot);
        Place(o, thief, spot + new Vec2(110f, 0f), aim: MathF.PI);
        FreeBall(o, new Vec2(300f, 200f), Vec2.Zero);
        ai.Once(thief, Input(move: new Vec2(-1f, 0f), aim: spot, tackle: true));
        var hit = StepUntil(o, mm => mm.State.Players[carrier].Action == PlayerAction.Stunned, 40);
        Assert.Contains(hit, e => e.Type == GameEventType.TackleHit && e.A == thief && e.B == carrier);
        AssertSane(o);
    }

    [Fact]
    public void A_tackle_input_on_slot_0_slides_rather_than_dives()
    {
        var m = Arena(5, settings: NoKeepers);
        Seat(m, 0, 0);
        Place(m, 0, new Vec2(-300f, 0f));
        m.SetInput(0, Input(move: new Vec2(1f, 0f), aim: new Vec2(0f, 0f), tackle: true));
        var ev = Collect(m);
        Assert.True(Has(ev, GameEventType.SlideStart));
        Assert.False(Has(ev, GameEventType.Dive));
        Assert.Equal(PlayerAction.Slide, P(m, 0).Action);
    }
}
