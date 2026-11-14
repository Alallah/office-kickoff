using static OfficeKickoff.Sim.Tests.TestKit;

namespace OfficeKickoff.Sim.Tests.Core;

public class ControlTests
{
    // ------------------------------------------------------------------------------------
    //  Joining and leaving
    // ------------------------------------------------------------------------------------

    [Fact]
    public void AddHuman_enforces_its_limits_without_throwing()
    {
        var m = NewMatch(3);
        Assert.Equal(-1, m.AddHuman(4, 0, true));
        Assert.Equal(-1, m.AddHuman(-1, 0, true));
        Assert.Equal(-1, m.AddHuman(0, 2, true));
        Assert.Equal(-1, m.AddHuman(0, -1, true));
        Assert.True(m.AddHuman(0, 0, true) >= 0);
        Assert.True(m.AddHuman(1, 0, true) >= 0);
        Assert.Equal(-1, m.AddHuman(2, 0, true));
        Assert.False(m.State.Humans[2].Present);
        Assert.True(m.AddHuman(2, 1, true) >= 0);
        Assert.Equal(-1, m.AddHuman(0, 1, true));
        Assert.Equal(0, m.State.Humans[0].Team);
        AssertSane(m);
    }

    [Fact]
    public void A_human_never_controls_a_keeper_or_a_footballer_taken_by_the_other_human()
    {
        var m = NewMatch(3);
        int a = m.AddHuman(0, 1, true);
        int b = m.AddHuman(3, 1, false);
        Assert.NotEqual(a, b);
        Assert.False(P(m, a).IsKeeper);
        Assert.False(P(m, b).IsKeeper);
        Assert.Equal(0, P(m, a).Controller);
        Assert.Equal(3, P(m, b).Controller);
    }

    [Fact]
    public void Mid_match_a_new_human_takes_the_free_footballer_nearest_the_ball()
    {
        var m = Arena();
        Place(m, 3, new Vec2(-100f, 50f));
        var ev = new List<GameEvent>();
        Assert.Equal(3, m.AddHuman(1, 0, true));
        ev.AddRange(Collect(m));
        var sw = Single(ev, GameEventType.Switch);
        Assert.Equal(3, sw.A);
        Assert.Equal(-1, sw.B);
        Assert.Equal(1, sw.Flag);
        Assert.Equal(1f, P(m, 3).SpeedFactor);
    }

    [Fact]
    public void Away_hands_the_footballer_to_the_ai_and_back_reseats()
    {
        var m = Arena();
        Place(m, 2, new Vec2(-100f, 50f));
        Seat(m, 0, 2);
        m.SetHumanConnected(0, false);
        Assert.Equal(-1, P(m, 2).Controller);
        Assert.Equal(-1, m.State.Humans[0].PlayerIndex);
        Assert.Equal(AiSpeedFactor(m, 2), P(m, 2).SpeedFactor);

        // Inputs while away are ignored, and nothing stale survives the return.
        m.SetInput(0, Input(move: new Vec2(1f, 0f), aim: new Vec2(2000f, 50f)));
        m.SetHumanConnected(0, false);
        m.SetHumanConnected(0, true);
        Assert.Equal(2, m.State.Humans[0].PlayerIndex);
        var pos = P(m, 2).Pos;
        Step(m, 10);
        Assert.Equal(pos, P(m, 2).Pos);

        // Unknown slots and repeated values do nothing.
        m.SetHumanConnected(3, true);
        Assert.False(m.State.Humans[3].Present);
        m.SetHumanConnected(9, false);
        AssertSane(m);
    }

    [Fact]
    public void Flipping_away_and_back_many_times_keeps_control_consistent()
    {
        var m = Playing(5, new ChaosAi(3));
        for (int id = 0; id < 4; id++) Assert.True(m.AddHuman(id, id / 2, id % 2 == 0) >= 0);
        var rng = new Random(11);
        var inputs = new PlayerInput[4];
        for (int t = 0; t < 1500; t++)
        {
            int id = rng.Next(4);
            if (rng.Next(6) == 0) m.SetHumanConnected(id, !m.State.Humans[id].Connected);
            for (int h = 0; h < 4; h++)
            {
                var hs = m.State.Humans[h];
                if (hs.PlayerIndex < 0) continue;
                Mash(rng, m.State, m.Pitch, hs.PlayerIndex, ref inputs[h]);
                inputs[h].SwitchBest = rng.Next(50) == 0;
                inputs[h].SwitchNext = rng.Next(50) == 0;
                m.SetInput(h, inputs[h]);
            }

            m.Step();
            AssertSane(m);
            foreach (var h in m.State.Humans)
            {
                Assert.Equal(h.Connected, h.PlayerIndex >= 0);
            }
        }
    }

    [Fact]
    public void Server_start_pattern_all_away_then_first_inputs_seat_by_priority()
    {
        var m = NewMatch(5);
        for (int id = 0; id < 4; id++) m.AddHuman(id, id < 2 ? 0 : 1, true);
        for (int id = 0; id < 4; id++) m.SetHumanConnected(id, false);
        foreach (var p in m.State.Players) Assert.Equal(-1, p.Controller);

        m.SetHumanConnected(1, true);
        Assert.Equal(KickoffOrder(m, 0)[0], m.State.Humans[1].PlayerIndex);
        m.SetHumanConnected(0, true);
        Assert.Equal(KickoffOrder(m, 0)[0], m.State.Humans[0].PlayerIndex);
        Assert.Equal(KickoffOrder(m, 0)[1], m.State.Humans[1].PlayerIndex);
        Assert.Equal(0, m.State.Ball.LastTouchHuman);
        AssertSane(m);
    }

    [Fact]
    public void A_match_with_every_human_away_plays_on_with_the_ai()
    {
        var m = Playing(5, new ChaosAi(8));
        for (int id = 0; id < 4; id++) m.AddHuman(id, id / 2, true);
        for (int id = 0; id < 4; id++) m.SetHumanConnected(id, false);
        var start = m.State.Ball.Pos;
        bool moved = false;
        for (int t = 0; t < 900; t++)
        {
            m.Step();
            AssertSane(m);
            foreach (var p in m.State.Players) Assert.Equal(-1, p.Controller);
            if (m.State.Ball.Pos != start) moved = true;
        }

        Assert.True(moved);
    }

    // ------------------------------------------------------------------------------------
    //  Manual switching
    // ------------------------------------------------------------------------------------

    private static Match SwitchScene()
    {
        var m = Arena();
        Place(m, 1, new Vec2(-600f, 300f));
        Place(m, 2, new Vec2(-100f, 0f));
        Place(m, 3, new Vec2(-300f, 0f));
        Place(m, 4, new Vec2(200f, -200f));
        Seat(m, 0, 1);
        Step(m);
        return m;
    }

    [Fact]
    public void Switch_best_takes_the_team_mate_nearest_the_ball()
    {
        var m = SwitchScene();
        m.SetInput(0, Input(aim: Vec2.Zero, switchBest: true));
        var ev = Collect(m);
        Assert.Equal(2, m.State.Humans[0].PlayerIndex);
        var sw = Single(ev, GameEventType.Switch);
        Assert.Equal(2, sw.A);
        Assert.Equal(1, sw.B);
        Assert.Equal(0, sw.Flag);
        AssertNear(m.Tuning.Switch.ManualHold, m.State.Humans[0].SwitchCooldown, 0.05f);
        Assert.Equal(-1, P(m, 1).Controller);
    }

    [Fact]
    public void Switch_best_prefers_the_team_mate_on_the_ball()
    {
        var m = SwitchScene();
        Place(m, 4, new Vec2(400f, 300f));
        GiveBall(m, 4);
        Place(m, 2, new Vec2(300f, 300f));
        m.SetInput(0, Input(aim: Vec2.Zero, switchBest: true));
        Step(m);
        Assert.Equal(4, m.State.Humans[0].PlayerIndex);
    }

    [Fact]
    public void Switch_next_cycles_by_slot_skipping_the_other_human()
    {
        var m = SwitchScene();
        Seat(m, 1, 3);
        Step(m);
        int[] expected = [2, 4, 1, 2];
        foreach (int want in expected)
        {
            m.SetInput(0, Input(aim: Vec2.Zero, switchNext: true));
            Step(m);
            Assert.Equal(want, m.State.Humans[0].PlayerIndex);
            Assert.Equal(3, m.State.Humans[1].PlayerIndex);
        }
    }

    [Fact]
    public void Switching_is_ignored_while_your_footballer_has_the_ball()
    {
        var m = SwitchScene();
        GiveBall(m, 1);
        m.SetInput(0, Input(aim: Vec2.Zero, switchBest: true));
        Step(m);
        m.SetInput(0, Input(aim: Vec2.Zero, switchNext: true));
        var ev = Collect(m);
        Assert.Equal(1, m.State.Humans[0].PlayerIndex);
        Assert.False(Has(ev, GameEventType.Switch));
    }

    // ------------------------------------------------------------------------------------
    //  Carrier hand-over
    // ------------------------------------------------------------------------------------

    [Fact]
    public void You_always_control_the_ball_carrier()
    {
        var m = Arena();
        Place(m, 1, new Vec2(-300f, 200f));
        Place(m, 2, new Vec2(300f, 200f));
        Place(m, 3, new Vec2(100f, 0f));
        Seat(m, 0, 1);
        Seat(m, 1, 2, autoSwitch: false);
        Step(m);
        m.State.Humans[1].SwitchCooldown = 1.5f;
        FreeBall(m, Vec2.Zero, new Vec2(300f, 0f), Index(m, 1, 1), TouchKind.Strike);
        var ev = StepUntil(m, mm => mm.State.Ball.Owner == 3, 30);
        var sw = Single(ev, GameEventType.Switch);
        Assert.Equal(3, sw.A);
        Assert.Equal(2, sw.B);
        Assert.Equal(1, sw.Flag);
        Assert.Equal(3, m.State.Humans[1].PlayerIndex);
        Assert.Equal(1, m.State.Humans[0].PlayerIndex);
        AssertNear(m.Tuning.Switch.MinGap, m.State.Humans[1].SwitchCooldown, 0.02f);
        Assert.Equal(1, m.State.Ball.LastTouchHuman);
    }

    [Fact]
    public void Keeper_gaining_the_ball_is_not_handed_to_a_human()
    {
        var m = Arena();
        Seat(m, 0, 1);
        Step(m);
        Place(m, 0, new Vec2(-700f, 0f));
        FreeBall(m, new Vec2(-500f, 0f), new Vec2(-500f, 0f), Index(m, 1, 1), TouchKind.Strike);
        var ev = StepUntil(m, mm => mm.State.Ball.Owner == 0, 60);
        Assert.False(Has(ev, GameEventType.Switch));
        Assert.Equal(1, m.State.Humans[0].PlayerIndex);
    }

    // ------------------------------------------------------------------------------------
    //  Defensive auto-switch
    // ------------------------------------------------------------------------------------

    /// <summary>Away carrier on the centre spot; home AI defender T at (-200, 0); human 0 placed by the test.</summary>
    private static Match DefendScene(Vec2 human, bool autoSwitch = true, Vec2? defender = null)
    {
        var m = Arena();
        int carrier = Index(m, 1, 1);
        Place(m, carrier, Vec2.Zero);
        GiveBall(m, carrier);
        Place(m, 2, defender ?? new Vec2(-200f, 0f));
        Place(m, 1, human);
        Seat(m, 0, 1, autoSwitch);
        Step(m);
        return m;
    }

    private static List<GameEvent> Watch(Match m, int ticks) => Collect(m, ticks);

    [Fact]
    public void Auto_switch_hands_the_nearest_ai_defender_to_a_human_out_of_the_play()
    {
        var m = DefendScene(new Vec2(-600f, -300f));
        var ev = Watch(m, Ticks(m.Tuning.Switch.AutoInterval) + 2);
        var sw = Single(ev, GameEventType.Switch);
        Assert.Equal(2, sw.A);
        Assert.Equal(1, sw.B);
        Assert.Equal(2, m.State.Humans[0].PlayerIndex);
    }

    [Fact]
    public void Auto_switch_runs_at_once_when_the_opponents_win_the_ball()
    {
        var m = Arena();
        Place(m, 2, new Vec2(-200f, 0f));
        Place(m, 1, new Vec2(-600f, -300f));
        Seat(m, 0, 1);
        int carrier = Index(m, 1, 1);
        Place(m, carrier, new Vec2(80f, 0f), aim: MathF.PI);
        Step(m);

        // Run the periodic timer to a fresh interval with the ball loose and untouched.
        Step(m, Ticks(m.Tuning.Switch.AutoInterval) + 1);
        Assert.Equal(1, m.State.Humans[0].PlayerIndex);
        FreeBall(m, new Vec2(20f, 0f), new Vec2(200f, 0f));
        var ev = StepUntil(m, mm => mm.State.Ball.Owner == carrier, 10);
        Assert.Equal(2, m.State.Humans[0].PlayerIndex);
        Assert.Single(ev, e => e.Type == GameEventType.Switch);
    }

    [Fact]
    public void Auto_switch_respects_the_preference()
    {
        var m = DefendScene(new Vec2(-600f, -300f), autoSwitch: false);
        Assert.False(Has(Watch(m, 120), GameEventType.Switch));
        Assert.Equal(1, m.State.Humans[0].PlayerIndex);
    }

    [Fact]
    public void Auto_switch_respects_the_ratio()
    {
        // T is about 166 from the ball; the human must be farther than 166 / AutoRatio (~268).
        var near = DefendScene(new Vec2(-34f, 240f));
        Assert.False(Has(Watch(near, 120), GameEventType.Switch));

        var far = DefendScene(new Vec2(-34f, 300f));
        Assert.True(Has(Watch(far, 60), GameEventType.Switch));
    }

    [Fact]
    public void Auto_switch_respects_the_range()
    {
        var m = DefendScene(new Vec2(-700f, -380f), defender: new Vec2(-500f, 0f));
        Assert.False(Has(Watch(m, 120), GameEventType.Switch));
    }

    [Fact]
    public void A_stunned_human_is_switched_even_when_close()
    {
        var m = DefendScene(new Vec2(-34f, 200f));
        P(m, 1).Action = PlayerAction.Stunned;
        P(m, 1).ActionTime = 3f;
        var ev = Watch(m, 60);
        Assert.Equal(2, Single(ev, GameEventType.Switch).A);
    }

    [Fact]
    public void Auto_switch_waits_for_the_cooldown()
    {
        var m = DefendScene(new Vec2(-600f, -300f));
        m.State.Humans[0].SwitchCooldown = 1.2f;
        Assert.False(Has(Watch(m, Ticks(1.1f)), GameEventType.Switch));
        Assert.True(Has(Watch(m, Ticks(1f)), GameEventType.Switch));
    }

    [Fact]
    public void Auto_switch_never_fires_while_the_own_team_has_the_ball_or_its_strike_is_in_flight()
    {
        var m = Arena();
        Place(m, 1, new Vec2(-600f, -300f));
        Place(m, 2, new Vec2(-200f, 0f));
        Seat(m, 0, 1);
        Step(m);
        FreeBall(m, new Vec2(-34f, 0f), new Vec2(-50f, 300f), Index(m, 0, 4), TouchKind.Strike);
        Assert.False(Has(Watch(m, 120), GameEventType.Switch));
    }
}
