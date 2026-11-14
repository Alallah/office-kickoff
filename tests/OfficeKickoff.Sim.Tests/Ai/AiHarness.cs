using OfficeKickoff.Sim.Ai;

namespace OfficeKickoff.Sim.Tests.Ai;

/// <summary>What one headless match produced.</summary>
public sealed class MatchReport
{
    public int Size;
    public int Seed;
    public float Minutes;
    public int[] Goals = new int[2];
    public int[] Shots = new int[2];
    public int[] OnTarget = new int[2];
    public int[] Saves = new int[2];
    public int[] PassesAttempted = new int[2];
    public int[] PassesCompleted = new int[2];
    public int[] Tackles = new int[2];

    /// <summary>Longest stretch of open play (real seconds) without anybody shooting.</summary>
    public float LongestNoShot;

    /// <summary>Longest stretch of open play (real seconds) the ball spent inside one 100-unit patch.</summary>
    public float LongestStuck;

    /// <summary>Goalkeeper catches and parries of on-target shots, per keeper team.</summary>
    public int[] KeeperSaves = new int[2];

    public int Ticks;
}

/// <summary>Runs complete headless matches with the real AI and measures them.</summary>
public static class AiHarness
{
    public const float StuckRadius = 100f;

    public static Match NewMatch(int size, int seed, AiLevel? home = null, AiLevel? away = null, int minutes = 3,
        AiLevel level = AiLevel.Normal, Action<MatchSettings>? settings = null, IAiDirector? ai = null)
    {
        var s = new MatchSettings
        {
            Preset = "custom",
            TeamSize = size,
            Minutes = minutes,
            AiTeammates = level,
            AiKeeper = level,
            Replays = false,
            Celebrations = false,
        };
        settings?.Invoke(s);
        var config = new MatchConfig
        {
            Settings = s.Normalized(),
            KickoffTeam = seed & 1,
            TeamAi = [home, away],
        };
        return new Match(config, new Tuning(), ai ?? new AiDirector(), seed);
    }

    /// <summary>
    /// Plays a match to the end (or to <paramref name="maxTicks"/>), calling <paramref name="beforeStep"/>
    /// before every step and checking the simulation's invariants after it when <paramref name="sane"/> is set.
    /// </summary>
    public static MatchReport Play(Match m, int maxTicks = 0, Action<Match>? beforeStep = null, bool sane = true)
    {
        // The whole match plus up to two minutes of golden goal (and the pauses around goals).
        if (maxTicks <= 0) maxTicks = (m.Config.Settings.Minutes * 60 + 120) * Tuning.TickRate * 3 / 2;
        var r = new MatchReport { Size = m.State.TeamSize };
        var s = m.State;
        int shotsSeen = 0;
        float lastShot = 0f;
        Vec2 anchor = s.Ball.Pos;
        float anchorAt = 0f;

        for (int t = 0; t < maxTicks && !m.IsOver; t++)
        {
            beforeStep?.Invoke(m);
            int saves0 = m.Stats.Teams[0].Saves, saves1 = m.Stats.Teams[1].Saves;
            m.Step();
            r.Ticks++;
            if (sane) TestKit.AssertSane(m);

            // A save credited on a tick where that team's keeper caught or parried is a keeper save.
            foreach (var e in m.Events)
            {
                if (e.Type is not (GameEventType.KeeperCatch or GameEventType.KeeperParry) || e.A < 0) continue;
                int team = s.Players[e.A].Team;
                int before = team == 0 ? saves0 : saves1;
                if (m.Stats.Teams[team].Saves > before) r.KeeperSaves[team]++;
            }

            if (s.Phase != MatchPhase.Playing)
            {
                anchor = s.Ball.Pos;
                anchorAt = s.Elapsed;
                lastShot = s.Elapsed;
                continue;
            }

            int shots = m.Stats.Teams[0].Shots + m.Stats.Teams[1].Shots;
            if (shots != shotsSeen)
            {
                shotsSeen = shots;
                lastShot = s.Elapsed;
            }

            r.LongestNoShot = MathF.Max(r.LongestNoShot, s.Elapsed - lastShot);

            if (Vec2.Distance(s.Ball.Pos, anchor) > StuckRadius)
            {
                anchor = s.Ball.Pos;
                anchorAt = s.Elapsed;
            }

            r.LongestStuck = MathF.Max(r.LongestStuck, s.Elapsed - anchorAt);
        }

        for (int team = 0; team < 2; team++)
        {
            var line = m.Stats.Teams[team];
            r.Goals[team] = s.Score[team];
            r.Shots[team] = line.Shots;
            r.OnTarget[team] = line.ShotsOnTarget;
            r.Saves[team] = line.Saves;
            r.PassesAttempted[team] = line.PassesAttempted;
            r.PassesCompleted[team] = line.PassesCompleted;
            r.Tackles[team] = line.Tackles;
        }

        r.Minutes = s.Elapsed / 60f;
        return r;
    }

    /// <summary>One line of the tuning table: several seeds of the same pairing, summed.</summary>
    public sealed class Row
    {
        public string Name = "";
        public int Size;
        public int Matches;
        public float Minutes;
        public int[] Goals = new int[2];
        public int[] Shots = new int[2];
        public int[] OnTarget = new int[2];
        public int[] Saves = new int[2];
        public int Passes;
        public int Completed;
        public float LongestNoShot;
        public float LongestStuck;
        public int HomeWins;
        public int AwayWins;

        public void Add(MatchReport r)
        {
            Matches++;
            Minutes += r.Minutes;
            for (int t = 0; t < 2; t++)
            {
                Goals[t] += r.Goals[t];
                Shots[t] += r.Shots[t];
                OnTarget[t] += r.OnTarget[t];
                Saves[t] += r.KeeperSaves[t];
                Passes += r.PassesAttempted[t];
                Completed += r.PassesCompleted[t];
            }

            if (r.Goals[0] > r.Goals[1]) HomeWins++;
            else if (r.Goals[1] > r.Goals[0]) AwayWins++;
            LongestNoShot = MathF.Max(LongestNoShot, r.LongestNoShot);
            LongestStuck = MathF.Max(LongestStuck, r.LongestStuck);
        }

        /// <summary>Goals per team per three minutes of open play.</summary>
        public float GoalsPer3(int team) => Minutes > 0f ? Goals[team] / Minutes * 3f : 0f;

        public float ShotsPer3(int team) => Minutes > 0f ? Shots[team] / Minutes * 3f : 0f;

        /// <summary>Share of the other team's on-target shots this team's goalkeeper stopped.</summary>
        public float SaveRate(int team)
        {
            int faced = OnTarget[1 - team];
            return faced > 0 ? (float)Saves[team] / faced : 0f;
        }

        /// <summary>Share of the shots that got past the outfield and the posts that this team's keeper stopped: saves / (saves + goals against).</summary>
        public float KeeperRate(int team)
        {
            int faced = Saves[team] + Goals[1 - team];
            return faced > 0 ? (float)Saves[team] / faced : 0f;
        }

        public float Completion => Passes > 0 ? (float)Completed / Passes : 0f;

        public static string Header =>
            "size | pairing         | n | goals/3min H-A | shots/3min H-A | on target H-A | sv/onT% H-A | sv/(sv+g)% H-A | pass%  | wins H-A | max no-shot s | max stuck s";

        public override string ToString() =>
            $"{Size}v{Size}  | {Name,-15} | {Matches} | {GoalsPer3(0),5:0.0} - {GoalsPer3(1),-5:0.0}  | {ShotsPer3(0),5:0.0} - {ShotsPer3(1),-5:0.0}  | " +
            $"{OnTarget[0],4} - {OnTarget[1],-4}   | {SaveRate(0) * 100f,4:0} - {SaveRate(1) * 100f,-4:0} | {KeeperRate(0) * 100f,6:0} - {KeeperRate(1) * 100f,-6:0} | " +
            $"{Completion * 100f,5:0.0}% | {HomeWins,3} - {AwayWins,-3} | {LongestNoShot,8:0.0}      | {LongestStuck,6:0.0}";
    }
}
