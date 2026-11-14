using Xunit.Abstractions;
using static OfficeKickoff.Sim.Tests.TestKit;

namespace OfficeKickoff.Sim.Tests.Ai;

/// <summary>Full matches with humans in them: passive, away, and a simple scripted player.</summary>
public class AiHumanTests(ITestOutputHelper output)
{
    /// <summary>Neutral controls for every present human: stand still, keep facing the same way.</summary>
    private static void Passive(Match m)
    {
        foreach (var h in m.State.Humans)
        {
            if (h.Present && h.Connected && h.PlayerIndex >= 0) m.SetInput(h.Id, Input(aim: AimAhead(m, h.PlayerIndex)));
        }
    }

    [Theory]
    [InlineData(5, 1)]
    [InlineData(5, 2)]
    [InlineData(3, 3)]
    [InlineData(7, 4)]
    public void Passive_humans_get_the_ball_from_their_keeper_and_ai_team_mates_keep_their_shape(int size, int seed)
    {
        var m = AiHarness.NewMatch(size, seed);
        Assert.True(m.AddHuman(0, 0, true) >= 0);
        Assert.True(m.AddHuman(2, 1, true) >= 0);
        var s = m.State;

        int keeperPasses = 0, openHuman = 0, keeperToHuman = 0;
        int supportSamples = 0, supportSpread = 0, supportAhead = 0;
        int defendSamples = 0, goalSide = 0;
        int playing = 0, handed = 0;
        AiHarness.Play(m, beforeStep: x =>
        {
            Passive(x);

            // Was the keeper's human team-mate open when the keeper let the ball go?
            foreach (var e in x.Events)
            {
                if (e.Type != GameEventType.Pass || e.A < 0 || !s.Players[e.A].IsKeeper) continue;
                keeperPasses++;
                int side = s.Players[e.A].Team;
                int human = s.Humans[side == 0 ? 0 : 2].PlayerIndex;
                if (human < 0) continue;
                Vec2 from = s.Players[e.A].Pos, to = s.Players[human].Pos;
                bool open = AiScene.LaneOpen(x, from, to, 1 - side, 45f, 0.3f) && Vec2.Distance(from, to) < x.Pitch.Width * 0.6f;
                for (int j = (1 - side) * size; j < (2 - side) * size && open; j++)
                {
                    if (Vec2.Distance(s.Players[j].Pos, to) < 70f) open = false;
                }

                if (!open) continue;
                openHuman++;
                if (e.B == human) keeperToHuman++;
            }

            if (s.Phase != MatchPhase.Playing) return;

            // Every ball an AI wins goes to a human who stands still, so nobody ever reaches a
            // keeper on their own: hand the keepers the ball now and then (as if they had caught it).
            // The passive human drifts back into space on the wing, as a real one would.
            if (++playing % 360 == 0 && !s.Ball.Held)
            {
                int keeperTeam = handed++ & 1;
                int keeper = Keeper(x, keeperTeam);
                Place(x, keeper, s.Players[keeper].HomePos);
                GiveBall(x, keeper, ownerTime: 0f);
                s.Ball.Held = true;

                int human = s.Humans[keeperTeam == 0 ? 0 : 2].PlayerIndex;
                float back = -PitchGeometry.AttackSign(keeperTeam);
                Vec2 wing = new(back * x.Pitch.HalfW * 0.3f, (handed & 2) == 0 ? x.Pitch.HalfH * 0.6f : -x.Pitch.HalfH * 0.6f);
                if (human >= 0) Place(x, human, wing);
            }

            if (s.Ball.Owner < 0 || s.Tick % 15 != 0) return;
            int owner = s.Ball.Owner;
            int team = s.Players[owner].Team;
            Vec2 carrier = s.Players[owner].Pos;
            float sign = PitchGeometry.AttackSign(team);

            // Our ball: AI team-mates spread out and someone offers an option ahead or level.
            supportSamples++;
            bool spread = true, ahead = false;
            for (int i = team * size + 1; i < (team + 1) * size; i++)
            {
                if (i == owner || s.Players[i].Controller >= 0) continue;
                if (Vec2.Distance(s.Players[i].Pos, carrier) < 60f) spread = false;
                if ((s.Players[i].Pos.X - carrier.X) * sign > -40f) ahead = true;
            }

            if (spread) supportSpread++;
            if (ahead || size == 3) supportAhead++;

            // Their ball: AI defenders goal side of the opponents they are nearest to.
            int defending = 1 - team;
            Vec2 goal = x.Pitch.OwnGoal(defending);
            for (int i = defending * size + 1; i < (defending + 1) * size; i++)
            {
                if (s.Players[i].Controller >= 0) continue;
                int nearest = -1;
                float best = float.MaxValue;
                for (int j = team * size + 1; j < (team + 1) * size; j++)
                {
                    float d = Vec2.Distance(s.Players[i].Pos, s.Players[j].Pos);
                    if (d < best)
                    {
                        best = d;
                        nearest = j;
                    }
                }

                defendSamples++;
                if (Vec2.Distance(s.Players[i].Pos, goal) <= Vec2.Distance(s.Players[nearest].Pos, goal) + 20f) goalSide++;
            }
        });

        output.WriteLine($"{size}v{size} seed {seed}: keeper passes {keeperPasses}, human open at {openHuman}, found {keeperToHuman}; " +
                         $"spread {supportSpread}/{supportSamples}, ahead {supportAhead}/{supportSamples}, goal side {goalSide}/{defendSamples}");
        Assert.True(keeperPasses >= handed / 2, $"the keepers distributed {keeperPasses} of {handed} balls by passing");
        Assert.True(openHuman > 0, "the human was never open when the keeper passed");
        Assert.True(keeperToHuman * 10 >= openHuman * 7, $"the keeper found the open human only {keeperToHuman} of {openHuman} times");
        Assert.True(supportSpread >= supportSamples * 0.85f, $"AI team-mates crowded the carrier ({supportSpread}/{supportSamples})");
        Assert.True(supportAhead >= supportSamples * 0.8f, $"nobody offered an option ahead ({supportAhead}/{supportSamples})");
        Assert.True(goalSide >= defendSamples * 0.6f, $"defenders goal side only {goalSide}/{defendSamples}");
    }

    [Theory]
    [InlineData(4, 1)]
    [InlineData(5, 2)]
    [InlineData(6, 3)]
    public void Away_humans_leave_teams_that_attack_and_shoot_on_their_own(int size, int seed)
    {
        var m = AiHarness.NewMatch(size, seed);
        for (int id = 0; id < 4; id++)
        {
            Assert.True(m.AddHuman(id, id / 2, true) >= 0);
            m.SetHumanConnected(id, false);
        }

        var r = AiHarness.Play(m);
        Assert.All(m.State.Players, p => Assert.Equal(-1, p.Controller));
        for (int team = 0; team < 2; team++)
        {
            Assert.True(r.Shots[team] >= 5, $"team {team} took only {r.Shots[team]} shots");
            Assert.True(r.PassesCompleted[team] >= 20, $"team {team} completed only {r.PassesCompleted[team]} passes");
        }

        Assert.True(r.Goals[0] + r.Goals[1] > 0);
    }

    [Fact]
    public void Humans_coming_and_going_all_match_long_break_nothing()
    {
        var m = AiHarness.NewMatch(5, 9, minutes: 2, settings: s => s.GoldenGoal = false);
        for (int id = 0; id < 4; id++) Assert.True(m.AddHuman(id, id / 2, id % 2 == 0) >= 0);
        var rng = new Random(5);
        var held = new PlayerInput[4];
        var r = AiHarness.Play(m, beforeStep: x =>
        {
            for (int id = 0; id < 4; id++)
            {
                if (rng.Next(90) == 0) x.SetHumanConnected(id, !x.State.Humans[id].Connected);
                int index = x.State.Humans[id].PlayerIndex;
                if (index < 0) continue;
                Mash(rng, x.State, x.Pitch, index, ref held[id]);
                held[id].SwitchBest = rng.Next(60) == 0;
                x.SetInput(id, held[id]);
            }
        });

        Assert.True(m.IsOver);
        Assert.True(r.Shots[0] + r.Shots[1] > 0);
    }

    /// <summary>
    /// A human who plays simply: runs at goal with the ball and shoots when close, passes to the
    /// most advanced open team-mate on a timer, and otherwise chases the ball.
    /// </summary>
    internal sealed class SimpleHuman(Match m, int id)
    {
        private int _charge;
        private float _held;

        public int CarryingTicks;
        public int OpenOptionTicks;
        public int Passes;

        public void Feed()
        {
            var s = m.State;
            var h = s.Humans[id];
            if (!h.Present || !h.Connected || h.PlayerIndex < 0) return;
            int me = h.PlayerIndex;
            ref readonly var p = ref s.Players[me];
            Vec2 goal = m.Pitch.OpponentGoal(p.Team);

            if (_charge > 0)
            {
                _charge--;
                m.SetInput(id, Input(move: (goal - p.Pos).Normalized(), aim: goal + new Vec2(0f, m.Pitch.GoalHalf * 0.6f), shoot: _charge > 0));
                return;
            }

            if (s.Ball.Owner != me)
            {
                _held = 0f;
                Vec2 to = s.Ball.Pos - p.Pos;
                m.SetInput(id, Input(move: to.Normalized(), aim: s.Ball.Pos, sprint: to.Length > 150f));
                return;
            }

            CarryingTicks++;
            _held += Dt;
            int best = BestOption(me);
            if (best >= 0) OpenOptionTicks++;

            if (Vec2.Distance(p.Pos, goal) < 450f)
            {
                _charge = Nearest(p.Pos, 1 - p.Team, out _) > 150f ? 20 : 6;
                m.SetInput(id, Input(move: (goal - p.Pos).Normalized(), aim: goal, shoot: true));
                return;
            }

            // Pass on a timer, sooner when an opponent is close.
            float sign = PitchGeometry.AttackSign(p.Team);
            bool pressed = Nearest(p.Pos, 1 - p.Team, out _) < 80f;
            bool forward = best >= 0 && (s.Players[best].Pos.X - p.Pos.X) * sign > 60f;
            if (best >= 0 && ((_held > 0.5f && forward) || (_held > 0.25f && pressed) || _held > 1.5f))
            {
                _held = 0f;
                Passes++;
                m.SetInput(id, Input(aim: s.Players[best].Pos, pass: true));
                return;
            }

            // Run at goal, veering away from whoever is straight ahead, and dash past them when close.
            Vec2 dir = (goal - p.Pos).Normalized();
            float d = Nearest(p.Pos, 1 - p.Team, out int o);
            bool dash = false;
            if (o >= 0 && d < 130f && Vec2.Dot(s.Players[o].Pos - p.Pos, dir) > 0f)
            {
                float side = Vec2.Cross(dir, s.Players[o].Pos - p.Pos) > 0f ? -1f : 1f;
                dir = (dir + dir.Perp * side).Normalized();
                dash = d < 75f && p.TackleCooldown <= 0f && p.Stamina > 0.4f;
            }

            m.SetInput(id, Input(move: dir, aim: p.Pos + dir * 100f, sprint: d > 160f, tackle: dash));
        }

        private float Nearest(Vec2 pos, int team, out int who)
        {
            var s = m.State;
            who = -1;
            float best = float.MaxValue;
            for (int j = team * s.TeamSize; j < (team + 1) * s.TeamSize; j++)
            {
                float d = Vec2.Distance(s.Players[j].Pos, pos);
                if (d < best)
                {
                    best = d;
                    who = j;
                }
            }

            return best;
        }

        /// <summary>The most advanced AI team-mate with nobody in the lane, or -1.</summary>
        private int BestOption(int me)
        {
            var s = m.State;
            ref readonly var p = ref s.Players[me];
            float sign = PitchGeometry.AttackSign(p.Team);
            int best = -1;
            float bestAx = float.MinValue;
            for (int j = p.Team * s.TeamSize + 1; j < (p.Team + 1) * s.TeamSize; j++)
            {
                if (j == me) continue;
                Vec2 q = s.Players[j].Pos;
                if (Vec2.Distance(q, p.Pos) < 90f) continue;
                if (!AiScene.LaneOpen(m, p.Pos, q, 1 - p.Team, 45f)) continue;
                float ax = q.X * sign;
                if (ax > bestAx)
                {
                    bestAx = ax;
                    best = j;
                }
            }

            return best;
        }
    }

    [Theory]
    [InlineData(5, 1)]
    [InlineData(5, 2)]
    [InlineData(4, 3)]
    [InlineData(6, 4)]
    public void A_simple_human_gets_open_team_mates_and_shots(int size, int seed)
    {
        var m = AiHarness.NewMatch(size, seed);
        Assert.True(m.AddHuman(0, 0, true) >= 0);
        var human = new SimpleHuman(m, 0);
        var r = AiHarness.Play(m, beforeStep: _ => human.Feed());

        float open = (float)human.OpenOptionTicks / Math.Max(1, human.CarryingTicks);
        output.WriteLine($"{size}v{size} seed {seed}: {r.Minutes:0.0} min, carried {human.CarryingTicks / 60f:0} s, team shots {r.Shots[0]} (human {m.Stats.Humans[0].Shots}), " +
                         $"human passes {human.Passes} completed {m.Stats.Humans[0].PassesCompleted}, open option {open:P0}, score {r.Goals[0]}-{r.Goals[1]}");
        Assert.True(r.Shots[0] >= 4, $"the human's team took only {r.Shots[0]} shots");
        Assert.True(m.Stats.Humans[0].Shots >= 2, $"the human took only {m.Stats.Humans[0].Shots} shots");
        Assert.True(human.Passes > 0 && m.Stats.Humans[0].PassesCompleted > 0, "the human never found a team-mate");
        Assert.True(open >= 0.45f, $"an open team-mate was available only {open:P0} of the time");

        // This human chases the ball everywhere, right up to the edge of the keeper's box: the
        // keeper must still get the ball away rather than kicking it into them again and again.
        Assert.True(r.LongestStuck <= 6f, $"the ball was stuck for {r.LongestStuck:0.0} s");
    }
}
