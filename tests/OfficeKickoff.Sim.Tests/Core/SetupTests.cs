using static OfficeKickoff.Sim.Tests.TestKit;

namespace OfficeKickoff.Sim.Tests.Core;

public class SetupTests
{
    public static TheoryData<int, string> AllFormations()
    {
        var data = new TheoryData<int, string>();
        for (int size = MatchSettings.MinTeamSize; size <= MatchSettings.MaxTeamSize; size++)
        {
            foreach (var f in Formations.ValidFor(size)) data.Add(size, f);
        }

        return data;
    }

    [Theory]
    [MemberData(nameof(AllFormations))]
    public void Every_formation_sets_up_a_legal_line_up(int size, string formation)
    {
        var m = NewMatch(size, config: c => c.Formations = [formation, formation]);
        var s = m.State;
        float r = m.Tuning.Player.Radius;
        var spots = Formations.Spots(formation, size);

        Assert.Equal(2 * size, s.Players.Length);
        Assert.Equal(size, s.TeamSize);
        for (int i = 0; i < s.Players.Length; i++)
        {
            var p = s.Players[i];
            int team = i / size;
            Assert.Equal(i, p.Index);
            Assert.Equal(team, p.Team);
            Assert.Equal(i % size, p.Slot);
            Assert.Equal(p.Slot == 0, p.IsKeeper);
            Assert.Equal(-1, p.Controller);
            Assert.Equal(1f, p.Stamina);
            Assert.Equal(team == 0 ? 0f : MathF.PI, p.Aim);
            Assert.True(InsideWalls(m.Pitch, p.HomePos, r), $"home of {i} outside the walls");
            Assert.True(p.HomePos.X * PitchGeometry.AttackSign(team) < 0f, $"home of {i} not in its own half");
            if (!p.IsKeeper) Assert.Equal(spots[p.Slot - 1], p.Spot);
            if (p.IsKeeper)
            {
                Assert.True(m.Pitch.InBox(p.HomePos, team));
                Assert.True(p.DiveSpeed > 0f && p.DiveCooldown > 0f);
            }
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

    [Fact]
    public void Invalid_formation_falls_back_to_the_default()
    {
        var m = NewMatch(5, config: c => c.Formations = ["9-9", "nonsense"]);
        var spots = Formations.Spots(Formations.Default(5), 5);
        for (int slot = 1; slot < 5; slot++) Assert.Equal(spots[slot - 1], m.State.Players[slot].Spot);
    }

    [Fact]
    public void Per_team_ai_levels_come_from_config()
    {
        var m = NewMatch(5, config: c => c.TeamAi = [AiLevel.Hard, AiLevel.Easy]);
        var t = m.Tuning;
        foreach (var p in m.State.Players)
        {
            var level = p.Team == 0 ? AiLevel.Hard : AiLevel.Easy;
            if (p.IsKeeper)
            {
                Assert.Equal(t.Keeper.SpeedFactor.Get(level), p.SpeedFactor);
                Assert.Equal(t.Keeper.DiveSpeed.Get(level), p.DiveSpeed);
                Assert.Equal(t.Keeper.DiveCooldown.Get(level), p.DiveCooldown);
            }
            else
            {
                Assert.Equal(t.Ai.SpeedFactor.Get(level), p.SpeedFactor);
            }
        }
    }

    [Fact]
    public void Settings_levels_apply_when_no_team_override()
    {
        var m = NewMatch(4, settings: s => { s.AiTeammates = AiLevel.Easy; s.AiKeeper = AiLevel.Hard; });
        var t = m.Tuning;
        Assert.Equal(t.Keeper.SpeedFactor.Hard, m.State.Players[0].SpeedFactor);
        Assert.Equal(t.Keeper.DiveSpeed.Hard, m.State.Players[4].DiveSpeed);
        Assert.Equal(t.Ai.SpeedFactor.Easy, m.State.Players[1].SpeedFactor);
        Assert.Equal(t.Ai.SpeedFactor.Easy, m.State.Players[5].SpeedFactor);
    }

    [Fact]
    public void Clock_starts_at_the_match_length()
    {
        var m = NewMatch(settings: s => s.Minutes = 4);
        Assert.Equal(240f, m.State.Clock, 3);
        Assert.Equal(MatchPhase.Intro, m.State.Phase);
        AssertNear(m.Tuning.Rules.IntroTime, m.State.PhaseTime, 0.02f);
        Assert.Equal(0, m.State.KickoffTeam);
    }

    [Fact]
    public void Practice_starts_in_kickoff_with_the_restart_countdown()
    {
        var m = NewMatch(config: c => c.Practice = true);
        Assert.Equal(MatchPhase.Kickoff, m.State.Phase);
        AssertNear(m.Tuning.Rules.RestartCountdown, m.State.PhaseTime, 0.02f);
        Assert.Equal(0f, m.State.Clock);
    }

    // ------------------------------------------------------------------------------------
    //  Phases
    // ------------------------------------------------------------------------------------

    [Fact]
    public void Intro_then_kickoff_then_playing_in_exact_ticks()
    {
        var ai = new IdleAi();
        var m = NewMatch(ai: ai);
        int intro = Ticks(m.Tuning.Rules.IntroTime);
        int kickoff = Ticks(m.Tuning.Rules.KickoffCountdown);

        Step(m, intro - 1);
        Assert.Equal(MatchPhase.Intro, m.State.Phase);
        var ev = Collect(m);
        Assert.Equal(MatchPhase.Kickoff, m.State.Phase);
        var change = Single(ev, GameEventType.PhaseChange);
        Assert.Equal((float)MatchPhase.Intro, change.Value);
        Assert.Equal((int)MatchPhase.Kickoff, change.Flag);
        AssertNear(m.Tuning.Rules.KickoffCountdown, m.State.PhaseTime, 0.02f);

        Step(m, kickoff - 1);
        Assert.Equal(MatchPhase.Kickoff, m.State.Phase);
        Assert.Equal(0, ai.Thinks);
        ev = Collect(m);
        Assert.Equal(MatchPhase.Playing, m.State.Phase);
        change = Single(ev, GameEventType.PhaseChange);
        Assert.Equal((float)MatchPhase.Kickoff, change.Value);
        Assert.Equal((int)MatchPhase.Playing, change.Flag);
        Assert.Equal(1, ai.Thinks);
        Step(m, 10);
        Assert.Equal(11, ai.Thinks);
    }

    [Fact]
    public void Footballers_are_frozen_during_countdowns_but_can_aim()
    {
        var m = NewMatch();
        int me = m.AddHuman(0, 0, true);
        Assert.True(me >= 0);
        var start = P(m, me).Pos;
        var ball = m.State.Ball.Pos;
        m.SetInput(0, Input(move: new Vec2(1f, 0f), aim: start + new Vec2(0f, 500f), sprint: true));
        Step(m, 60);
        Assert.Equal(start, P(m, me).Pos);
        Assert.Equal(Vec2.Zero, P(m, me).Vel);
        AssertNear(MathF.PI / 2f, P(m, me).Aim, 0.01f, "aim");
        Assert.Equal(ball, m.State.Ball.Pos);
        Assert.Equal(1f, P(m, me).Stamina);
    }

    [Fact]
    public void Pass_and_shot_pressed_during_the_countdown_do_nothing_and_are_not_remembered()
    {
        var m = NewMatch();
        int taker = m.AddHuman(0, 0, true);
        Assert.Equal(m.State.Ball.Owner, taker);
        StepUntilPhase(m, MatchPhase.Kickoff);

        // Mash pass and hold shoot all through the countdown, then let go before the whistle.
        var events = new List<GameEvent>();
        while (m.State.PhaseTime > 3f * Dt)
        {
            m.SetInput(0, Input(aim: new Vec2(600f, 0f), shoot: true, pass: true));
            events.AddRange(Collect(m));
        }

        m.SetInput(0, Input(aim: new Vec2(600f, 0f)));
        events.AddRange(Collect(m));
        Assert.Equal(MatchPhase.Kickoff, m.State.Phase);
        events.AddRange(StepUntilPhase(m, MatchPhase.Playing));
        events.AddRange(Collect(m, 30));

        Assert.False(Has(events, GameEventType.Pass));
        Assert.False(Has(events, GameEventType.Kick));
        Assert.Equal(taker, m.State.Ball.Owner);
    }

    // ------------------------------------------------------------------------------------
    //  Kickoff layout
    // ------------------------------------------------------------------------------------

    [Theory]
    [InlineData(3, 0)]
    [InlineData(5, 1)]
    [InlineData(7, 0)]
    [InlineData(7, 1)]
    public void Kickoff_taker_owns_the_ball_and_opponents_wait_outside_the_circle(int size, int kickoffTeam)
    {
        var ai = new IdleAi();
        var m = NewMatch(size, ai: ai, config: c => c.KickoffTeam = kickoffTeam);
        var s = m.State;
        int taker = KickoffOrder(m, kickoffTeam)[0];
        float reach = DribbleReach(m);

        Assert.Equal(1, ai.Resets);
        Assert.Equal(kickoffTeam, s.KickoffTeam);
        Assert.Equal(taker, s.Ball.Owner);
        Assert.Equal(Vec2.Zero, s.Ball.Pos);
        Assert.Equal(Vec2.Zero, s.Ball.Vel);
        Assert.False(s.Ball.Held || s.Ball.Dead);
        Assert.Equal(taker, s.Ball.LastTouch);
        Assert.Equal(TouchKind.Control, s.Ball.LastTouchKind);
        Assert.Equal(-1, s.Ball.PrevTouch);
        Assert.Equal(-1, s.Ball.PassTarget);
        Assert.Equal(-1, s.Ball.OnTargetGoal);
        AssertNear(new Vec2(-PitchGeometry.AttackSign(kickoffTeam) * reach, 0f), P(m, taker).Pos, 0.01f, "taker");
        AssertNear(kickoffTeam == 0 ? 0f : MathF.PI, P(m, taker).Aim, 1e-4f, "taker aim");
        AssertNear(P(m, taker).Aim, MathUtil.WrapAngle(s.Ball.DribbleAngle), 1e-4f, "dribble angle");

        float keepOut = m.Pitch.CenterRadius + m.Tuning.Player.Radius;
        foreach (var p in s.Players)
        {
            if (p.Team == kickoffTeam) continue;
            Assert.True(p.Pos.Length >= keepOut - 0.01f, $"opponent {p.Index} inside the centre circle");
            Assert.True(p.Pos.X * PitchGeometry.AttackSign(p.Team) <= 0f, $"opponent {p.Index} left its own half");
        }
    }

    [Fact]
    public void Humans_are_seated_by_kickoff_priority_in_id_order()
    {
        var m = NewMatch(5);
        Assert.True(m.AddHuman(3, 0, true) >= 0);
        Assert.True(m.AddHuman(1, 0, false) >= 0);
        Assert.True(m.AddHuman(2, 1, true) >= 0);
        var home = KickoffOrder(m, 0);
        var away = KickoffOrder(m, 1);

        Assert.Equal(home[0], m.State.Humans[1].PlayerIndex);
        Assert.Equal(home[1], m.State.Humans[3].PlayerIndex);
        Assert.Equal(away[0], m.State.Humans[2].PlayerIndex);
        Assert.Equal(1, m.State.Ball.LastTouchHuman);
        Assert.Equal(1f, P(m, home[0]).SpeedFactor);
        Assert.Equal(AiSpeedFactor(m, home[2]), P(m, home[2]).SpeedFactor);

        // The events of these seatings are delivered with the next step.
        var ev = Collect(m);
        Assert.True(CountOf(ev, GameEventType.Switch) >= 3);
        AssertSane(m);
    }

    [Fact]
    public void Away_humans_are_skipped_when_seating_for_kickoff()
    {
        var m = NewMatch(5);
        m.AddHuman(0, 0, true);
        m.AddHuman(1, 0, true);
        var home = KickoffOrder(m, 0);
        m.SetHumanConnected(0, false);
        Assert.Equal(home[0], m.State.Humans[1].PlayerIndex);
        Assert.Equal(-1, m.State.Humans[0].PlayerIndex);
        m.SetHumanConnected(0, true);
        Assert.Equal(home[0], m.State.Humans[0].PlayerIndex);
        Assert.Equal(home[1], m.State.Humans[1].PlayerIndex);
        AssertSane(m);
    }
}
