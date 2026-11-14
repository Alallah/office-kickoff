using static OfficeKickoff.Sim.Tests.TestKit;

namespace OfficeKickoff.Sim.Tests.Core;

public class SoakTests
{
    /// <summary>Four humans mashing their controls, now and then switching or going away and coming back.</summary>
    private sealed class Humans(Match match, int seed, bool flipAway)
    {
        private readonly Random _rng = new(seed);
        private readonly PlayerInput[] _inputs = new PlayerInput[4];

        public void Join()
        {
            for (int id = 0; id < 4; id++) Assert.True(match.AddHuman(id, id / 2, id % 2 == 0) >= 0);
        }

        public void Feed()
        {
            var s = match.State;
            for (int id = 0; id < 4; id++)
            {
                if (flipAway && _rng.Next(400) == 0) match.SetHumanConnected(id, !s.Humans[id].Connected);
                int index = s.Humans[id].PlayerIndex;
                if (index < 0) continue;
                Mash(_rng, s, match.Pitch, index, ref _inputs[id]);
                _inputs[id].SwitchBest = _rng.Next(90) == 0;
                _inputs[id].SwitchNext = _rng.Next(120) == 0;
                match.SetInput(id, _inputs[id]);
            }
        }
    }

    private static Match Chaos(int size, int seed, int minutes = 10)
    {
        var m = NewMatch(size, new ChaosAi(seed * 31 + size), seed, settings: s =>
        {
            s.Minutes = minutes;
            s.BallSpeed = 0.75f + 0.25f * (seed % 4);
            s.GameSpeed = 0.75f + 0.25f * ((seed + size) % 4);
            s.Replays = seed % 2 == 0;
        });
        return m;
    }

    public static TheoryData<int, int> SoakCases()
    {
        var data = new TheoryData<int, int>();
        for (int size = MatchSettings.MinTeamSize; size <= MatchSettings.MaxTeamSize; size++)
        {
            foreach (int seed in new[] { 1, 2, 3 }) data.Add(size, seed);
        }

        return data;
    }

    [Theory]
    [MemberData(nameof(SoakCases))]
    public void Soak_stays_sane(int size, int seed)
    {
        // Seed 1 plays short matches so the end of the match (and golden goal) is soaked too.
        var m = Chaos(size, seed, seed == 1 ? 1 : 10);
        var humans = new Humans(m, seed * 7 + size, flipAway: true);
        humans.Join();
        int s0 = 0, s1 = 0;
        for (int t = 0; t < 20000; t++)
        {
            humans.Feed();
            m.Step();
            AssertSane(m);
            Assert.True(m.State.Score[0] >= s0 && m.State.Score[1] >= s1, "the score went down");
            s0 = m.State.Score[0];
            s1 = m.State.Score[1];
            foreach (var e in m.Events) Assert.True(float.IsFinite(e.X) && float.IsFinite(e.Y) && float.IsFinite(e.Value));
            if (m.IsOver) break;
        }

        Assert.Equal(s0 + s1, m.Stats.Goals.Count);
        if (seed == 1) Assert.True(m.IsOver, "a one-minute match ends within 20000 ticks");
    }

    [Fact]
    public void Same_seed_and_inputs_give_identical_matches()
    {
        Match Run(out Match other)
        {
            var a = Chaos(5, 4);
            var b = Chaos(5, 4);
            var ha = new Humans(a, 77, flipAway: true);
            var hb = new Humans(b, 77, flipAway: true);
            ha.Join();
            hb.Join();
            for (int t = 0; t < 3000; t++)
            {
                ha.Feed();
                hb.Feed();
                a.Step();
                b.Step();
                Assert.Equal(a.Events.Count, b.Events.Count);
            }

            other = b;
            return a;
        }

        var first = Run(out var second);
        AssertSameState(first, second);
        Assert.True(first.State.Elapsed > 0f);
    }

    [Fact]
    public void Team_lines_include_the_human_lines_and_possession_adds_up()
    {
        var m = Chaos(5, 6);
        var humans = new Humans(m, 21, flipAway: false);
        humans.Join();
        for (int t = 0; t < 8000; t++)
        {
            humans.Feed();
            m.Step();
        }

        var st = m.Stats;
        for (int team = 0; team < 2; team++)
        {
            var line = st.Teams[team];
            var a = st.Humans[team * 2];
            var b = st.Humans[team * 2 + 1];
            Assert.True(line.Goals >= a.Goals + b.Goals);
            Assert.True(line.OwnGoals >= a.OwnGoals + b.OwnGoals);
            Assert.True(line.Assists >= a.Assists + b.Assists);
            Assert.True(line.Shots >= a.Shots + b.Shots);
            Assert.True(line.ShotsOnTarget >= a.ShotsOnTarget + b.ShotsOnTarget);
            Assert.True(line.Saves >= a.Saves + b.Saves);
            Assert.True(line.Tackles >= a.Tackles + b.Tackles);
            Assert.True(line.Steals >= a.Steals + b.Steals);
            Assert.True(line.PassesAttempted >= a.PassesAttempted + b.PassesAttempted);
            Assert.True(line.PassesCompleted >= a.PassesCompleted + b.PassesCompleted);
            Assert.True(line.PassesCompleted <= line.PassesAttempted);
            Assert.True(line.ShotsOnTarget <= line.Shots);
        }

        int humanActions = 0;
        foreach (var h in st.Humans) humanActions += h.PassesAttempted + h.Shots + h.Steals + h.Tackles;
        Assert.True(humanActions > 0, "the humans did something");
        Assert.Equal(m.State.Score[0], st.Teams[0].Goals + st.Teams[1].OwnGoals);
        Assert.Equal(m.State.Score[1], st.Teams[1].Goals + st.Teams[0].OwnGoals);
        AssertNear(m.State.Elapsed, st.Teams[0].PossessionTime + st.Teams[1].PossessionTime, 1e-3f, "possession");
        Assert.True(st.Teams[0].PossessionTime > 0f && st.Teams[1].PossessionTime > 0f);
    }

    [Fact]
    public void Step_does_not_allocate_in_steady_state()
    {
        var m = Chaos(7, 9);
        var humans = new Humans(m, 5, flipAway: false);
        humans.Join();
        RunToPlaying(m);
        for (int t = 0; t < 600; t++) m.Step();

        // The scripted AI and the input feed are test code; measure Step alone.
        long before = GC.GetAllocatedBytesForCurrentThread();
        for (int t = 0; t < 600; t++) m.Step();
        long allocated = GC.GetAllocatedBytesForCurrentThread() - before;
        Assert.True(allocated < 1024, $"Step allocated {allocated} bytes");
    }
}
