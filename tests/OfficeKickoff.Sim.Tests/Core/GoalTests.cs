using static OfficeKickoff.Sim.Tests.TestKit;

namespace OfficeKickoff.Sim.Tests.Core;

public class GoalTests
{
    /// <summary>Home footballer (human 0) on the edge of the away box, shooting at the empty goal.</summary>
    private static List<GameEvent> ShootHomeGoal(Match m, int human = 0, int slot = 1)
    {
        int i = Index(m, 0, slot);
        Place(m, i, new Vec2(450f, 0f));
        Seat(m, human, i);
        GiveBall(m, i);
        Step(m);
        var ev = ChargeAndShoot(m, human, 40, new Vec2(900f, 0f));
        ev.AddRange(StepUntilEvent(m, GameEventType.Goal, 120));
        return ev;
    }

    [Fact]
    public void Shot_into_the_goal_scores_and_records_everything()
    {
        var m = Arena();
        int i = Index(m, 0, 1);
        var ev = ShootHomeGoal(m);

        Assert.Equal(1, m.State.Score[0]);
        Assert.Equal(0, m.State.Score[1]);
        var goal = Single(ev, GameEventType.Goal);
        Assert.Equal(i, goal.A);
        Assert.Equal(-1, goal.B);
        Assert.Equal(0, GoalFlags.Team(goal.Flag));
        Assert.False(GoalFlags.IsOwnGoal(goal.Flag));
        Assert.False(GoalFlags.IsDecider(goal.Flag));
        Assert.Equal(0, GoalFlags.ScorerHuman(goal.Flag));
        Assert.Equal(-1, GoalFlags.AssistHuman(goal.Flag));
        Assert.True(goal.Value > 0.3f);

        var rec = Assert.Single(m.Stats.Goals);
        Assert.Equal(0, rec.Team);
        Assert.Equal(i, rec.Scorer);
        Assert.Equal(0, rec.ScorerHuman);
        Assert.Equal(-1, rec.Assist);
        Assert.False(rec.OwnGoal);
        Assert.Equal(m.State.Elapsed, rec.Time);

        Assert.Equal(1, m.Stats.Teams[0].Goals);
        Assert.Equal(1, m.Stats.Humans[0].Goals);
        Assert.Equal(1, m.Stats.Teams[0].Shots);
        Assert.Equal(1, m.Stats.Teams[0].ShotsOnTarget);

        Assert.Equal(MatchPhase.GoalScored, m.State.Phase);
        Assert.True(m.State.SlowMo);
        Assert.True(m.State.Ball.Dead);
        Assert.Equal(-1, m.State.Ball.Owner);
        Assert.Equal(-1, m.State.Winner);
        AssertSane(m);
    }

    [Fact]
    public void Dead_ball_stays_in_the_net_and_hits_it_once()
    {
        var m = Arena();
        ShootHomeGoal(m);
        var ev = new List<GameEvent>();
        for (int t = 0; t < 150; t++)
        {
            ev.AddRange(Collect(m));
            Assert.True(m.State.Ball.Pos.X > m.Pitch.HalfW, "the dead ball left the net");
            Assert.True(BallInBounds(m));
            Assert.Equal(-1, m.State.Ball.Owner);
        }

        Assert.Equal(1, CountOf(ev, GameEventType.NetHit));
        Assert.Equal(1, m.State.Score[0]);
    }

    [Fact]
    public void Goal_credits_the_humans_at_the_touch_even_after_control_moved()
    {
        var m = Arena();
        int passer = Index(m, 0, 1), striker = Index(m, 0, 2);
        Place(m, passer, new Vec2(200f, 200f));
        Place(m, striker, new Vec2(450f, 0f));
        Place(m, Index(m, 0, 3), new Vec2(-300f, -300f));
        Place(m, Index(m, 0, 4), new Vec2(-300f, 300f));
        Seat(m, 0, passer);
        Seat(m, 1, Index(m, 0, 3));
        GiveBall(m, passer);
        Step(m);

        // Human 0 passes to the AI striker and follows the ball onto it, then scores.
        m.SetInput(0, Input(aim: P(m, striker).Pos, pass: true));
        Step(m);
        Assert.Equal(striker, m.State.Humans[0].PlayerIndex);
        m.SetInput(0, Input(aim: new Vec2(900f, 0f)));
        StepUntil(m, mm => mm.State.Ball.Owner == striker, 60);
        ChargeAndShoot(m, 0, 40, new Vec2(900f, 0f));

        // Control moves on before the ball crosses the line.
        m.SetInput(0, Input(aim: new Vec2(900f, 0f), switchNext: true));
        var ev = StepUntilEvent(m, GameEventType.Goal, 120);
        Assert.NotEqual(striker, m.State.Humans[0].PlayerIndex);

        var goal = Single(ev, GameEventType.Goal);
        Assert.Equal(striker, goal.A);
        Assert.Equal(passer, goal.B);
        Assert.Equal(0, GoalFlags.ScorerHuman(goal.Flag));
        Assert.Equal(0, GoalFlags.AssistHuman(goal.Flag));
        var rec = Assert.Single(m.Stats.Goals);
        Assert.Equal(passer, rec.Assist);
        Assert.Equal(0, rec.AssistHuman);
        Assert.Equal(1, m.Stats.Humans[0].Goals);
        Assert.Equal(1, m.Stats.Humans[0].Assists);
        Assert.Equal(0, m.Stats.Humans[1].Goals);
        Assert.Equal(1, m.Stats.Teams[0].Assists);
    }

    [Fact]
    public void Goal_flags_carry_different_humans_for_scorer_and_assist()
    {
        var m = Arena();
        int a = Index(m, 0, 1), s = Index(m, 0, 2);
        Seat(m, 1, a);
        Seat(m, 3, s);
        Step(m);
        FreeBall(m, new Vec2(700f, 0f), new Vec2(900f, 0f), s, TouchKind.Strike);
        ref var b = ref m.State.Ball;
        b.PrevTouch = a;
        b.PrevTouchHuman = 1;
        b.PrevTouchTime = m.State.Time - 2.0;
        var goal = Single(StepUntilEvent(m, GameEventType.Goal, 20), GameEventType.Goal);
        Assert.Equal(3, GoalFlags.ScorerHuman(goal.Flag));
        Assert.Equal(1, GoalFlags.AssistHuman(goal.Flag));
        Assert.Equal(1, m.Stats.Humans[1].Assists);
        Assert.Equal(1, m.Stats.Humans[3].Goals);
    }

    [Fact]
    public void No_assist_beyond_the_assist_window()
    {
        var m = Arena();
        int a = Index(m, 0, 1), s = Index(m, 0, 2);
        FreeBall(m, new Vec2(700f, 0f), new Vec2(900f, 0f), s, TouchKind.Strike);
        ref var b = ref m.State.Ball;
        b.PrevTouch = a;
        b.PrevTouchTime = m.State.Time - m.Tuning.Rules.AssistWindow - 0.5;
        var goal = Single(StepUntilEvent(m, GameEventType.Goal, 20), GameEventType.Goal);
        Assert.Equal(s, goal.A);
        Assert.Equal(-1, goal.B);
    }

    [Theory]
    [InlineData(TouchKind.Deflect, 0.5, false)]
    [InlineData(TouchKind.Catch, 0.5, false)]
    [InlineData(TouchKind.Deflect, 3.0, true)]
    [InlineData(TouchKind.Strike, 0.5, true)]
    public void Shot_in_off_a_defender_is_the_strikers_goal(TouchKind kind, double ago, bool ownGoal)
    {
        var m = Arena();
        int striker = Index(m, 0, 2), defender = Index(m, 1, 1);
        Seat(m, 0, striker);
        Step(m);
        FreeBall(m, new Vec2(720f, 0f), new Vec2(600f, 0f), defender, kind);
        ref var b = ref m.State.Ball;
        b.PrevTouch = striker;
        b.PrevTouchHuman = 0;
        b.PrevTouchTime = m.State.Time - ago;
        var goal = Single(StepUntilEvent(m, GameEventType.Goal, 20), GameEventType.Goal);

        Assert.Equal(1, m.State.Score[0]);
        Assert.Equal(0, GoalFlags.Team(goal.Flag));
        Assert.Equal(ownGoal, GoalFlags.IsOwnGoal(goal.Flag));
        Assert.Equal(-1, goal.B);
        if (ownGoal)
        {
            Assert.Equal(defender, goal.A);
            Assert.Equal(1, m.Stats.Teams[1].OwnGoals);
            Assert.Equal(0, m.Stats.Teams[0].Goals);
            Assert.Equal(-1, GoalFlags.ScorerHuman(goal.Flag));
        }
        else
        {
            Assert.Equal(striker, goal.A);
            Assert.Equal(1, m.Stats.Teams[0].Goals);
            Assert.Equal(1, m.Stats.Humans[0].Goals);
            Assert.Equal(0, m.Stats.Teams[1].OwnGoals);
            Assert.Equal(0, GoalFlags.ScorerHuman(goal.Flag));
        }
    }

    [Fact]
    public void Shooting_into_your_own_goal_is_an_own_goal()
    {
        var m = Arena();
        int i = Index(m, 1, 1);
        Place(m, i, new Vec2(550f, 0f));
        Seat(m, 2, i);
        GiveBall(m, i);
        Step(m);
        ChargeAndShoot(m, 2, 40, new Vec2(900f, 0f));
        var goal = Single(StepUntilEvent(m, GameEventType.Goal, 120), GameEventType.Goal);

        Assert.Equal(1, m.State.Score[0]);
        Assert.True(GoalFlags.IsOwnGoal(goal.Flag));
        Assert.Equal(0, GoalFlags.Team(goal.Flag));
        Assert.Equal(2, GoalFlags.ScorerHuman(goal.Flag));
        Assert.Equal(i, goal.A);
        Assert.Equal(1, m.Stats.Teams[1].OwnGoals);
        Assert.Equal(1, m.Stats.Humans[2].OwnGoals);
        Assert.Equal(0, m.Stats.Teams[0].Goals);
        Assert.Equal(0, m.Stats.Teams[1].Goals);
        Assert.Equal(0, m.Stats.Teams[0].Shots + m.Stats.Teams[1].Shots);
        Assert.True(Assert.Single(m.Stats.Goals).OwnGoal);
    }

    [Fact]
    public void Dribbling_into_the_opponents_goal_counts()
    {
        var m = Arena();
        int i = Index(m, 0, 1);
        Place(m, i, new Vec2(660f, 0f));
        Seat(m, 0, i);
        GiveBall(m, i);
        m.SetInput(0, Input(move: new Vec2(1f, 0f), aim: new Vec2(2000f, 0f)));
        var goal = Single(StepUntilEvent(m, GameEventType.Goal, 60), GameEventType.Goal);
        Assert.Equal(i, goal.A);
        Assert.Equal(0, GoalFlags.ScorerHuman(goal.Flag));
        Assert.Equal(1, m.State.Score[0]);
        Assert.Equal(1, m.Stats.Teams[0].Shots);
        Assert.Equal(1, m.Stats.Teams[0].ShotsOnTarget);
        Assert.True(InsideWalls(m.Pitch, P(m, i).Pos, m.Tuning.Player.Radius));
    }

    [Fact]
    public void A_carried_ball_never_crosses_the_carriers_own_line()
    {
        var m = Arena();
        int i = Index(m, 0, 1);
        Place(m, i, new Vec2(-660f, 0f), aim: MathF.PI);
        Seat(m, 0, i);
        GiveBall(m, i);
        m.SetInput(0, Input(move: new Vec2(-1f, 0f), aim: new Vec2(-2000f, 0f)));
        for (int t = 0; t < 90; t++)
        {
            Assert.False(Has(Collect(m), GameEventType.Goal));
            Assert.True(m.State.Ball.Pos.X >= -m.Pitch.HalfW + m.Tuning.Ball.Radius - 0.01f);
        }

        Assert.Equal(i, m.State.Ball.Owner);
        Assert.Equal(0, m.State.Score[1]);
    }

    [Fact]
    public void A_dash_cannot_carry_the_ball_over_the_line()
    {
        var m = Arena();
        int i = Index(m, 0, 1);
        Place(m, i, new Vec2(640f, 0f));
        Seat(m, 0, i);
        GiveBall(m, i);
        m.SetInput(0, Input(move: new Vec2(1f, 0f), aim: new Vec2(2000f, 0f), tackle: true));
        var ev = Collect(m);
        Assert.True(Has(ev, GameEventType.Dash));
        m.SetInput(0, Input(move: new Vec2(1f, 0f), aim: new Vec2(2000f, 0f)));
        int dashTicks = 0;
        while (true)
        {
            var tick = Collect(m);
            if (P(m, i).Action != PlayerAction.Dash) break;
            dashTicks++;
            Assert.False(Has(tick, GameEventType.Goal));
            Assert.True(m.State.Ball.Pos.X <= m.Pitch.HalfW - m.Tuning.Ball.Radius + 0.01f);
        }

        Assert.True(dashTicks >= Ticks(m.Tuning.Tackle.DashTime) - 2);
        Assert.True(P(m, i).Pos.X >= m.Pitch.HalfW - m.Tuning.Player.Radius - 0.01f, "the dash reached the line");

        // Walking it in once the dash is over is fine.
        Assert.True(m.State.Score[0] == 1 || Has(StepUntilEvent(m, GameEventType.Goal, 30), GameEventType.Goal));
    }

    // ------------------------------------------------------------------------------------
    //  After the goal
    // ------------------------------------------------------------------------------------

    [Fact]
    public void Goal_pause_then_replay_then_the_conceding_team_kicks_off()
    {
        var m = Arena();
        var rules = m.Tuning.Rules;
        m.AddHuman(2, 1, true);
        ShootHomeGoal(m);
        Assert.Equal(MatchPhase.GoalScored, m.State.Phase);

        int slow = 0;
        int goalTicks = 0;
        while (m.State.Phase == MatchPhase.GoalScored)
        {
            double before = m.State.Time;
            m.Step();
            goalTicks++;
            if (m.State.Phase == MatchPhase.GoalScored && m.State.SlowMo)
            {
                slow++;
                AssertNear(Dt * rules.GoalSlowMoScale, (float)(m.State.Time - before), 1e-5f, "slow-motion time step");
            }
        }

        Assert.Equal(Ticks(rules.GoalCelebrationTime), goalTicks);
        Assert.InRange(slow, Ticks(rules.GoalSlowMoTime) - 1, Ticks(rules.GoalSlowMoTime));
        Assert.Equal(MatchPhase.Replay, m.State.Phase);
        Assert.False(m.State.SlowMo);

        // Nothing moves during the replay.
        var ball = m.State.Ball.Pos;
        var players = (PlayerState[])m.State.Players.Clone();
        double time = m.State.Time;
        float elapsed = m.State.Elapsed;
        Step(m, 30);
        Assert.Equal(ball, m.State.Ball.Pos);
        Assert.Equal(time, m.State.Time);
        Assert.Equal(elapsed, m.State.Elapsed);
        for (int i = 0; i < players.Length; i++) Assert.Equal(players[i].Pos, m.State.Players[i].Pos);

        StepUntilPhase(m, MatchPhase.Kickoff, 1000);
        AssertNear(rules.RestartCountdown, m.State.PhaseTime, 0.02f);
        Assert.Equal(1, m.State.KickoffTeam);
        int taker = KickoffOrder(m, 1)[0];
        Assert.Equal(taker, m.State.Ball.Owner);
        Assert.False(m.State.Ball.Dead);
        Assert.Equal(taker, m.State.Humans[2].PlayerIndex);
        Assert.Equal(KickoffOrder(m, 0)[0], m.State.Humans[0].PlayerIndex);
        Assert.Equal(2, m.State.Ball.LastTouchHuman);
        AssertSane(m);
    }

    [Fact]
    public void Replay_lasts_its_time()
    {
        var m = Arena();
        ShootHomeGoal(m);
        StepUntilPhase(m, MatchPhase.Replay, 1000);
        int ticks = 0;
        while (m.State.Phase == MatchPhase.Replay)
        {
            m.Step();
            ticks++;
        }

        Assert.Equal(Ticks(m.Tuning.Rules.ReplayTime), ticks);
        Assert.Equal(MatchPhase.Kickoff, m.State.Phase);
    }

    [Fact]
    public void Without_replays_and_celebrations_the_restart_is_quick()
    {
        var m = Arena(settings: s => { s.Replays = false; s.Celebrations = false; });
        ShootHomeGoal(m);
        int ticks = 0;
        var ev = new List<GameEvent>();
        while (m.State.Phase == MatchPhase.GoalScored)
        {
            ev.AddRange(Collect(m));
            ticks++;
        }

        Assert.Equal(Ticks(m.Tuning.Rules.GoalShortTime), ticks);
        Assert.Equal(MatchPhase.Kickoff, m.State.Phase);
        var change = Single(ev, GameEventType.PhaseChange);
        Assert.Equal((float)MatchPhase.GoalScored, change.Value);
        Assert.Equal((int)MatchPhase.Kickoff, change.Flag);
    }

    [Fact]
    public void Kickoff_layout_resets_everyone_after_a_goal()
    {
        var m = Arena();
        ShootHomeGoal(m);
        P(m, 3).Stamina = 0.2f;
        P(m, 3).Exhausted = true;
        StepUntilPhase(m, MatchPhase.Kickoff, 1000);
        float keepOut = m.Pitch.CenterRadius + m.Tuning.Player.Radius;
        foreach (var p in m.State.Players)
        {
            Assert.Equal(1f, p.Stamina);
            Assert.False(p.Exhausted);
            Assert.Equal(PlayerAction.None, p.Action);
            Assert.Equal(Vec2.Zero, p.Vel);
            if (p.Team == 0) Assert.True(p.Pos.Length >= keepOut - 0.01f);
        }
    }
}
