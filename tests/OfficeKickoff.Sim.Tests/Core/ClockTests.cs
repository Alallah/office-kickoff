using static OfficeKickoff.Sim.Tests.TestKit;

namespace OfficeKickoff.Sim.Tests.Core;

public class ClockTests
{
    private static Match OneMinute(Action<MatchSettings>? settings = null, Action<MatchConfig>? config = null) =>
        Playing(5, new IdleAi(), settings: s => { s.Minutes = 1; settings?.Invoke(s); }, config: config);

    /// <summary>Plays out regulation; returns the events of the last regulation tick.</summary>
    private static List<GameEvent> RunOutTheClock(Match m)
    {
        // The tick that ends the kickoff countdown is already a tick of open play.
        Assert.Equal(m.Config.Settings.Minutes * 60f - m.State.Elapsed, m.State.Clock, 3);
        Step(m, Ticks(m.State.Clock) - 1);
        Assert.Equal(MatchPhase.Playing, m.State.Phase);
        AssertNear(Dt, m.State.Clock, 1e-3f, "one tick left");
        return Collect(m);
    }

    /// <summary>Puts the ball over a goal line with a home footballer as the scorer.</summary>
    private static void HomeGoal(Match m)
    {
        int i = Index(m, 0, 1);
        FreeBall(m, new Vec2(m.Pitch.HalfW - 10f, 0f), new Vec2(600f, 0f), i, TouchKind.Strike);
        StepUntilEvent(m, GameEventType.Goal, 20);
    }

    [Fact]
    public void Clock_runs_in_real_time_whatever_the_game_speed()
    {
        var m = OneMinute(s => s.GameSpeed = 1.5f);
        float clock = m.State.Clock, elapsed = m.State.Elapsed;
        double time = m.State.Time;
        Step(m, 600);
        AssertNear(clock - 10f, m.State.Clock, 1e-3f, "clock");
        AssertNear(elapsed + 10f, m.State.Elapsed, 1e-3f, "elapsed");
        AssertNear(15f, (float)(m.State.Time - time), 1e-3f, "simulation time");
    }

    [Fact]
    public void Full_time_with_a_winner_then_ended()
    {
        var m = OneMinute();
        m.State.Score[1] = 2;
        var ev = RunOutTheClock(m);
        Assert.Equal(MatchPhase.FullTime, m.State.Phase);
        Assert.Equal(0f, m.State.Clock);
        Assert.Equal(1, m.State.Winner);
        AssertNear(60f, m.State.Elapsed, 1e-3f, "elapsed");
        var change = Single(ev, GameEventType.PhaseChange);
        Assert.Equal((int)MatchPhase.FullTime, change.Flag);

        Step(m, Ticks(m.Tuning.Rules.FullTimeHold) - 1);
        Assert.Equal(MatchPhase.FullTime, m.State.Phase);
        Step(m);
        Assert.Equal(MatchPhase.Ended, m.State.Phase);
        Assert.True(m.IsOver);

        int tick = m.State.Tick;
        var pos = m.State.Ball.Pos;
        Step(m, 10);
        Assert.Equal(tick, m.State.Tick);
        Assert.Equal(pos, m.State.Ball.Pos);
        Assert.Empty(m.Events);
    }

    [Fact]
    public void Draw_without_golden_goal()
    {
        var m = OneMinute(s => s.GoldenGoal = false);
        m.State.Score[0] = 1;
        m.State.Score[1] = 1;
        RunOutTheClock(m);
        Assert.Equal(MatchPhase.FullTime, m.State.Phase);
        Assert.Equal(-1, m.State.Winner);
        Assert.False(m.State.Overtime);
    }

    [Fact]
    public void Golden_goal_then_the_deciding_goal_ends_the_match()
    {
        var ai = new IdleAi();
        var m = Playing(5, ai, settings: s => s.Minutes = 1, config: c => c.KickoffTeam = 0);
        int resets = ai.Resets;
        var ev = RunOutTheClock(m);
        Assert.True(Has(ev, GameEventType.Overtime));
        Assert.True(m.State.Overtime);
        Assert.Equal(MatchPhase.Kickoff, m.State.Phase);
        AssertNear(m.Tuning.Rules.KickoffCountdown, m.State.PhaseTime, 0.02f);
        Assert.Equal(1, m.State.KickoffTeam);
        Assert.Equal(KickoffOrder(m, 1)[0], m.State.Ball.Owner);
        Assert.Equal(resets + 1, ai.Resets);
        Assert.Equal(-1, m.State.Winner);

        StepUntilPhase(m, MatchPhase.Playing);
        Step(m, 600);
        Assert.Equal(MatchPhase.Playing, m.State.Phase);
        Assert.Equal(0f, m.State.Clock);

        int i = Index(m, 0, 1);
        FreeBall(m, new Vec2(m.Pitch.HalfW - 10f, 0f), new Vec2(600f, 0f), i, TouchKind.Strike);
        var goal = Single(StepUntilEvent(m, GameEventType.Goal, 20), GameEventType.Goal);
        Assert.True(GoalFlags.IsDecider(goal.Flag));
        Assert.Equal(0, m.State.Winner);
        StepUntilPhase(m, MatchPhase.Replay, 1000);
        StepUntilPhase(m, MatchPhase.FullTime, 1000);
        StepUntilPhase(m, MatchPhase.Ended, 1000);
        Assert.Equal(0, m.State.Winner);
    }

    [Fact]
    public void Score_limit_decides_the_match()
    {
        var m = Playing(5, new IdleAi(), settings: s => { s.ScoreLimit = 2; s.Replays = false; });
        m.State.Score[0] = 1;
        HomeGoal(m);
        Assert.Equal(0, m.State.Winner);
        Assert.True(GoalFlags.IsDecider(m.Events.First(e => e.Type == GameEventType.Goal).Flag));
        var ev = StepUntilPhase(m, MatchPhase.FullTime, 1000);
        Assert.False(Has(ev.Where(e => e.Type == GameEventType.PhaseChange && e.Flag == (int)MatchPhase.Kickoff), GameEventType.PhaseChange));
    }

    [Fact]
    public void Below_the_score_limit_play_restarts()
    {
        var m = Playing(5, new IdleAi(), settings: s => { s.ScoreLimit = 3; s.Replays = false; });
        HomeGoal(m);
        Assert.Equal(-1, m.State.Winner);
        StepUntilPhase(m, MatchPhase.Kickoff, 1000);
    }

    [Fact]
    public void Full_time_freezes_goals_and_lets_everyone_coast()
    {
        var m = OneMinute();
        m.State.Score[0] = 1;
        int i = Index(m, 0, 1);
        int sweeper = Index(m, 1, 1);
        Step(m, Ticks(60f) - 2);
        Seat(m, 0, i);
        m.SetInput(0, Input(move: new Vec2(0f, 1f), aim: new Vec2(0f, 2000f)));
        Step(m);
        FreeBall(m, new Vec2(m.Pitch.HalfW - 60f, 0f), new Vec2(800f, 0f), sweeper, TouchKind.Strike);
        Step(m);
        Assert.Equal(MatchPhase.FullTime, m.State.Phase);
        var ev = Collect(m, Ticks(m.Tuning.Rules.FullTimeHold) - 2);
        Assert.False(Has(ev, GameEventType.Goal));
        Assert.Equal(1, m.State.Score[0]);
        Assert.Equal(0, m.State.Score[1]);
        Assert.Equal(Vec2.Zero, P(m, i).Vel);
        Assert.True(BallInBounds(m));
        Assert.Equal(MatchPhase.FullTime, m.State.Phase);
    }

    [Fact]
    public void Practice_never_ends_and_counts_up()
    {
        var m = NewMatch(3, new ChaosAi(5), config: c => c.Practice = true, settings: s => { s.ScoreLimit = 1; s.Minutes = 1; });
        Assert.Equal(MatchPhase.Kickoff, m.State.Phase);
        for (int t = 0; t < 6000; t++)
        {
            m.Step();
            Assert.NotEqual(MatchPhase.FullTime, m.State.Phase);
            Assert.Equal(-1, m.State.Winner);
        }

        Assert.True(m.State.Clock > 30f);
        AssertNear(m.State.Elapsed, m.State.Clock, 1e-3f, "practice clock");

        if (m.State.Phase == MatchPhase.Playing)
        {
            HomeGoal(m);
            Assert.Equal(-1, m.State.Winner);
            Assert.False(GoalFlags.IsDecider(m.Events.First(e => e.Type == GameEventType.Goal).Flag));
        }
    }
}
