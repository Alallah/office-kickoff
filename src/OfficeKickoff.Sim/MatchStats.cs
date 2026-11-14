namespace OfficeKickoff.Sim;

/// <summary>Counters for one human or one team.</summary>
public sealed class StatLine
{
    public int Goals;
    public int OwnGoals;
    public int Assists;
    public int Shots;
    public int ShotsOnTarget;

    /// <summary>On-target shots stopped: keeper catches and parries, and outfield blocks.</summary>
    public int Saves;

    /// <summary>Slide tackles that won the ball or dispossessed the carrier.</summary>
    public int Tackles;

    /// <summary>Balls taken off an opponent by touch.</summary>
    public int Steals;

    public int PassesAttempted;
    public int PassesCompleted;

    /// <summary>Real seconds in possession (teams only).</summary>
    public float PossessionTime;
}

public sealed class GoalRecord
{
    /// <summary>Real seconds of open play when the goal was scored.</summary>
    public float Time;

    /// <summary>Team credited with the goal.</summary>
    public int Team;

    /// <summary>Footballer index of the scorer (the last toucher), or -1.</summary>
    public int Scorer = -1;

    /// <summary>Human id controlling the scorer at the time of the touch, or -1 for AI.</summary>
    public int ScorerHuman = -1;

    public int Assist = -1;
    public int AssistHuman = -1;
    public bool OwnGoal;
}

/// <summary>
/// Match statistics. Every action is counted on the acting team's line, and additionally on the
/// human's line when the footballer was human-controlled at that moment.
/// </summary>
public sealed class MatchStats
{
    /// <summary>Indexed by human id (0..3).</summary>
    public StatLine[] Humans { get; } = [new(), new(), new(), new()];

    /// <summary>Indexed by team; includes actions by AI footballers.</summary>
    public StatLine[] Teams { get; } = [new(), new()];

    public List<GoalRecord> Goals { get; } = [];

    public static float MvpScore(StatLine s, MvpTuning w) =>
        s.Goals * w.Goal + s.Assists * w.Assist + s.Saves * w.Save + s.Tackles * w.Tackle +
        s.Steals * w.Steal + s.PassesCompleted * w.PassCompleted + s.ShotsOnTarget * w.ShotOnTarget +
        s.OwnGoals * w.OwnGoal;

    /// <summary>
    /// Human id of the most valuable player among the present humans, or -1 when there are none.
    /// Ties go to the winning team, then to the lower id.
    /// </summary>
    public int ComputeMvp(MatchState state, MvpTuning weights)
    {
        int best = -1;
        float bestScore = float.NegativeInfinity;
        foreach (var h in state.Humans)
        {
            if (!h.Present) continue;
            float score = MvpScore(Humans[h.Id], weights) + (h.Team == state.Winner ? 0.5f : 0f);
            if (score > bestScore)
            {
                bestScore = score;
                best = h.Id;
            }
        }

        return best;
    }
}
