using Xunit.Abstractions;
using static OfficeKickoff.Sim.Tests.TestKit;

namespace OfficeKickoff.Sim.Tests.Ai;

/// <summary>The real AI on both sides of matches played without goalkeepers.</summary>
public class AiNoKeeperTests(ITestOutputHelper output)
{
    [Theory]
    [InlineData(3)]
    [InlineData(5)]
    [InlineData(7)]
    public void A_match_without_keepers_runs_to_full_time_with_goals(int size)
    {
        var m = AiHarness.NewMatch(size, 4100 + size, settings: s => s.Keepers = false);
        Assert.All(m.State.Players, p => Assert.False(p.IsKeeper));

        int keeperEvents = 0, sweeperTouches = 0;
        var report = AiHarness.Play(m, beforeStep: mm =>
        {
            // The events of the step before (Play checks the invariants after every step, "held" included).
            foreach (var e in mm.Events)
            {
                if (e.Type is GameEventType.KeeperCatch or GameEventType.KeeperParry or GameEventType.Dive) keeperEvents++;
                if (e.Type is GameEventType.Trap or GameEventType.Pass or GameEventType.Kick or GameEventType.Steal &&
                    e.A >= 0 && mm.State.Players[e.A].Slot == 0)
                {
                    sweeperTouches++;
                }
            }
        });

        output.WriteLine($"{size}v{size}: {report.Goals[0]}-{report.Goals[1]}, shots {report.Shots[0]}-{report.Shots[1]}, " +
                         $"passes {report.PassesCompleted[0] + report.PassesCompleted[1]}/{report.PassesAttempted[0] + report.PassesAttempted[1]}, " +
                         $"longest stuck {report.LongestStuck:0.0} s, sweeper touches {sweeperTouches}");

        Assert.True(m.IsOver, $"{size}v{size} without keepers did not reach full time");
        Assert.True(report.Goals[0] + report.Goals[1] > 0, $"{size}v{size} without keepers: no goals");
        Assert.True(report.Shots[0] > 0 && report.Shots[1] > 0, $"{size}v{size} without keepers: a team never shot");
        Assert.Equal(0, keeperEvents);
        Assert.Equal(0, report.KeeperSaves[0] + report.KeeperSaves[1]);
        Assert.True(sweeperTouches > 0, "the sweepers never played the ball");
        Assert.True(report.LongestStuck <= 6f, $"the ball was stuck for {report.LongestStuck:0.0} s");
    }

    [Fact]
    public void The_ai_sweeper_stays_in_its_own_half_on_average_while_its_team_defends()
    {
        var m = AiHarness.NewMatch(5, 77, settings: s => s.Keepers = false);
        RunToPlaying(m);
        float deepest = float.MaxValue, sum = 0f;
        int samples = 0;
        for (int t = 0; t < 60 * 40 && !m.IsOver; t++)
        {
            m.Step();
            AssertSane(m);
            var s = m.State;
            if (s.Phase != MatchPhase.Playing || s.Ball.Owner < 0 || s.Players[s.Ball.Owner].Team != 1) continue;

            // Team 1 has the ball: how far up the pitch is team 0's sweeper?
            float fromLine = s.Players[0].Pos.X + m.Pitch.HalfW;
            deepest = MathF.Min(deepest, fromLine);
            sum += fromLine;
            samples++;
        }

        Assert.True(samples > 60, "team 1 hardly had the ball");
        float average = sum / samples;
        output.WriteLine($"sweeper: average {average:0} units from its goal line while defending, deepest {deepest:0}");
        Assert.True(average < m.Pitch.HalfW, $"the sweeper averaged {average:0} units from its goal line while defending");
    }

    /// <summary>
    /// Slot 0 is meant to be a deep sweeper: while the other team has the ball it holds the space in
    /// front of its own goal instead of following an opponent upfield like every other marker.
    /// </summary>
    [Theory]
    [InlineData(3)]
    [InlineData(5)]
    [InlineData(7)]
    public void The_ai_sweeper_plays_deep_in_front_of_its_goal_while_its_team_defends(int size)
    {
        var m = AiHarness.NewMatch(size, 900 + size, settings: s => s.Keepers = false);
        float sum = 0f;
        int samples = 0, goalSide = 0;
        var report = AiHarness.Play(m, beforeStep: mm =>
        {
            var s = mm.State;
            if (s.Phase != MatchPhase.Playing || s.Ball.Owner < 0) return;
            int defending = 1 - s.Players[s.Ball.Owner].Team;
            ref readonly var sweeper = ref s.Players[defending * size];
            if (sweeper.Controller != -1) return;

            float back = PitchGeometry.AttackSign(defending);
            float fromLine = (sweeper.Pos.X - mm.Pitch.GoalLineX(defending)) * back;
            float ballFromLine = (s.Ball.Pos.X - mm.Pitch.GoalLineX(defending)) * back;
            sum += fromLine;
            samples++;
            if (fromLine < ballFromLine) goalSide++;
        });

        Assert.True(samples > 600, $"{size}v{size}: hardly any defending to measure");
        float average = sum / samples;
        int goals = report.Goals[0] + report.Goals[1];
        output.WriteLine($"{size}v{size}: sweeper averaged {average:0} units from its goal line (half {m.Pitch.HalfW:0}), " +
                         $"goal side of the ball {100f * goalSide / samples:0}%, score {report.Goals[0]}-{report.Goals[1]}");

        // With nobody guarding the goal, AI-v-AI matches used to finish 14-13 in three minutes.
        Assert.True(goals <= 12, $"{size}v{size}: {goals} goals in {m.Config.Settings.Minutes} minutes");
        Assert.True(average < 0.4f * m.Pitch.HalfW,
            $"{size}v{size}: the sweeper averaged {average:0} units from its goal line while defending (half is {m.Pitch.HalfW:0})");
        Assert.True(goalSide > 0.85f * samples, $"{size}v{size}: the sweeper was goal side of the ball only {goalSide} of {samples} ticks");
    }
}
