using System.Collections.Concurrent;
using System.Text;
using OfficeKickoff.Sim.Ai;
using Xunit.Abstractions;
using static OfficeKickoff.Sim.Tests.TestKit;

namespace OfficeKickoff.Sim.Tests.Ai;

/// <summary>Complete headless matches: the real AI on both sides, no humans, the full match length.</summary>
public class AiMatchTests(ITestOutputHelper output)
{
    private static readonly int[] Seeds = [1, 2, 3];

    private static readonly (string Name, AiLevel Home, AiLevel Away)[] Pairings =
    [
        ("Easy v Easy", AiLevel.Easy, AiLevel.Easy),
        ("Normal v Normal", AiLevel.Normal, AiLevel.Normal),
        ("Hard v Hard", AiLevel.Hard, AiLevel.Hard),
        ("Hard v Easy", AiLevel.Hard, AiLevel.Easy),
    ];

    /// <summary>
    /// Every team size, every pairing, three seeds, three minutes each - with the simulation's
    /// invariants checked after every tick. Prints the tuning table and asserts the targets.
    /// </summary>
    [Fact]
    public void Tuning_table_meets_the_targets()
    {
        var jobs = new List<(int Size, int Pairing, int Seed)>();
        for (int size = MatchSettings.MinTeamSize; size <= MatchSettings.MaxTeamSize; size++)
        {
            for (int k = 0; k < Pairings.Length; k++)
            {
                foreach (int seed in Seeds) jobs.Add((size, k, seed));
            }
        }

        var reports = new ConcurrentDictionary<(int, int, int), MatchReport>();
        Parallel.ForEach(jobs, job =>
        {
            var (name, home, away) = Pairings[job.Pairing];
            var m = AiHarness.NewMatch(job.Size, job.Seed * 7919 + job.Size, home, away);
            var report = AiHarness.Play(m);
            Assert.True(m.IsOver || m.State.Overtime, $"{job.Size}v{job.Size} {name} seed {job.Seed} stopped before full time");
            reports[(job.Size, job.Pairing, job.Seed)] = report;
        });

        var text = new StringBuilder();
        text.AppendLine(AiHarness.Row.Header);
        var rows = new Dictionary<(int, int), AiHarness.Row>();
        for (int size = MatchSettings.MinTeamSize; size <= MatchSettings.MaxTeamSize; size++)
        {
            for (int k = 0; k < Pairings.Length; k++)
            {
                var row = new AiHarness.Row { Name = Pairings[k].Name, Size = size };
                foreach (int seed in Seeds) row.Add(reports[(size, k, seed)]);
                rows[(size, k)] = row;
                text.AppendLine(row.ToString());
            }
        }

        output.WriteLine(text.ToString());

        foreach (var row in rows.Values)
        {
            string what = $"{row.Size}v{row.Size} {row.Name}";
            Assert.True(row.LongestStuck <= 6f, $"{what}: the ball was stuck for {row.LongestStuck:0.0} s");
            Assert.True(row.Shots[0] > 0 && row.Shots[1] > 0, $"{what}: a team never shot");
            Assert.True(row.Goals[0] + row.Goals[1] > 0, $"{what}: no goals in {row.Matches} matches");
            Assert.True(row.Completed > 0, $"{what}: no pass was ever completed");
        }

        // Hard must clearly beat Easy, over all sizes and seeds together and in goals.
        int hardGoals = 0, easyGoals = 0, hardWins = 0, easyWins = 0;
        for (int size = MatchSettings.MinTeamSize; size <= MatchSettings.MaxTeamSize; size++)
        {
            var row = rows[(size, 3)];
            hardGoals += row.Goals[0];
            easyGoals += row.Goals[1];
            hardWins += row.HomeWins;
            easyWins += row.AwayWins;
        }

        Assert.True(hardGoals > easyGoals * 2, $"Hard {hardGoals} goals v Easy {easyGoals}");
        Assert.True(hardWins >= 3 * Math.Max(1, easyWins), $"Hard won {hardWins}, Easy won {easyWins}");
    }

    /// <summary>
    /// The headline targets, over eight seeds of Normal v Normal 5-a-side: 1 to 4 goals per team per
    /// three minutes, the ball never stuck for more than 6 seconds, keepers stopping roughly half
    /// to three quarters of the on-target shots that reach them.
    /// </summary>
    [Fact]
    public void Normal_five_a_side_meets_the_targets()
    {
        var reports = new MatchReport[8];
        Parallel.For(0, reports.Length, k =>
        {
            var m = AiHarness.NewMatch(5, 1000 + k * 37);
            reports[k] = AiHarness.Play(m);
        });

        var row = new AiHarness.Row { Name = "Normal v Normal", Size = 5 };
        foreach (var r in reports) row.Add(r);
        output.WriteLine(AiHarness.Row.Header);
        output.WriteLine(row.ToString());

        float perTeam = (row.GoalsPer3(0) + row.GoalsPer3(1)) / 2f;
        Assert.True(perTeam is >= 1f and <= 4f, $"{perTeam:0.00} goals per team per 3 minutes");
        Assert.True(row.LongestStuck <= 6f, $"the ball was stuck for {row.LongestStuck:0.0} s");

        // The rest of the on-target shots were blocked by defenders or hit the post.
        int kept = row.Saves[0] + row.Saves[1];
        float saves = (float)kept / Math.Max(1, kept + row.Goals[0] + row.Goals[1]);
        output.WriteLine($"keepers stopped {saves:P0} of the on-target shots that reached them, " +
                         $"{(float)kept / Math.Max(1, row.OnTarget[0] + row.OnTarget[1]):P0} of all shots on target");
        Assert.True(saves is >= 0.5f and <= 0.8f, $"keepers saved {saves:P0} of the shots that reached them");
    }

    [Fact]
    public void Same_seed_gives_the_same_match()
    {
        var a = AiHarness.NewMatch(6, 42);
        var b = AiHarness.NewMatch(6, 42);
        for (int t = 0; t < 4000; t++)
        {
            a.Step();
            b.Step();
            Assert.Equal(a.Events.Count, b.Events.Count);
        }

        AssertSameState(a, b);
        Assert.True(a.State.Elapsed > 30f);
    }

    [Fact]
    public void Think_does_not_allocate_in_steady_state()
    {
        var m = AiHarness.NewMatch(7, 9, level: AiLevel.Hard);
        RunToPlaying(m);
        for (int t = 0; t < 600; t++) m.Step();

        long before = GC.GetAllocatedBytesForCurrentThread();
        for (int t = 0; t < 1200; t++) m.Step();
        long allocated = GC.GetAllocatedBytesForCurrentThread() - before;
        Assert.True(allocated < 1024, $"1200 steps with the AI allocated {allocated} bytes");
    }

    [Theory]
    [InlineData(3, 0.75f, 1.5f)]
    [InlineData(5, 1.5f, 0.75f)]
    [InlineData(7, 1.35f, 1.1f)]
    public void Extreme_speed_settings_stay_sane(int size, float ballSpeed, float gameSpeed)
    {
        var m = AiHarness.NewMatch(size, 77, minutes: 1, level: AiLevel.Hard, settings: s =>
        {
            s.BallSpeed = ballSpeed;
            s.GameSpeed = gameSpeed;
            s.GoldenGoal = false;
        });
        var r = AiHarness.Play(m);
        Assert.True(m.IsOver);
        Assert.True(r.Shots[0] + r.Shots[1] > 0);
    }
}
