using OfficeKickoff.Sim;
using OfficeKickoff.Web.Protocol;

namespace OfficeKickoff.Web.Rooms;

/// <summary>Turns a finished match into the results screen.</summary>
public static class Results
{
    /// <param name="humans">The humans captured when the match started (not the live member list).</param>
    /// <param name="players">Footballer names, indexed like the match's players.</param>
    public static MatchResultDto Build(int matchId, Match match, IReadOnlyList<HumanInfoDto> humans, IReadOnlyList<PlayerInfoDto> players, Tuning tuning)
    {
        var s = match.State;
        var stats = match.Stats;

        string HumanName(int id) => humans.FirstOrDefault(h => h.HumanId == id)?.Name ?? "";
        string PlayerName(int index) => index >= 0 && index < players.Count ? players[index].Name : "";

        var goals = stats.Goals.Select(g => new GoalDto
        {
            Time = Finite(g.Time),
            Team = g.Team,
            Scorer = g.ScorerHuman >= 0 ? HumanName(g.ScorerHuman) : PlayerName(g.Scorer),
            ScorerHuman = g.ScorerHuman,
            Assist = g.AssistHuman >= 0 ? HumanName(g.AssistHuman) : g.Assist >= 0 ? PlayerName(g.Assist) : null,
            AssistHuman = g.AssistHuman,
            OwnGoal = g.OwnGoal,
        }).ToArray();

        var humanLines = humans.OrderBy(h => h.HumanId).Select(h =>
        {
            var line = stats.Humans[h.HumanId];
            var dto = new HumanStatsDto
            {
                HumanId = h.HumanId,
                MemberId = h.MemberId,
                Name = h.Name,
                Team = h.Team,
                Color = h.Color,
                Rating = Finite(MatchStats.MvpScore(line, tuning.Mvp)),
            };
            Copy(line, dto);
            return dto;
        }).ToArray();

        float p0 = Math.Max(0f, Finite(stats.Teams[0].PossessionTime));
        float p1 = Math.Max(0f, Finite(stats.Teams[1].PossessionTime));
        int homeShare = p0 + p1 > 0f ? (int)Math.Round(100.0 * p0 / (p0 + p1), MidpointRounding.AwayFromZero) : 50;
        homeShare = Math.Clamp(homeShare, 0, 100);

        var teams = new TeamStatsDto[2];
        for (int t = 0; t < 2; t++)
        {
            teams[t] = new TeamStatsDto { Possession = t == 0 ? homeShare : 100 - homeShare };
            Copy(stats.Teams[t], teams[t]);
        }

        int mvp = humans.Count > 0 ? stats.ComputeMvp(s, tuning.Mvp) : -1;

        return new MatchResultDto
        {
            MatchId = matchId,
            Score = [s.Score[0], s.Score[1]],
            Winner = s.Winner is 0 or 1 ? s.Winner : -1,
            Overtime = s.Overtime && s.Winner >= 0,
            Duration = Finite(s.Elapsed),
            Goals = goals,
            Humans = humanLines,
            Teams = teams,
            Mvp = mvp,
        };
    }

    private static void Copy(StatLine from, StatsDto to)
    {
        to.Goals = from.Goals;
        to.OwnGoals = from.OwnGoals;
        to.Assists = from.Assists;
        to.Shots = from.Shots;
        to.ShotsOnTarget = from.ShotsOnTarget;
        to.Saves = from.Saves;
        to.Tackles = from.Tackles;
        to.Steals = from.Steals;
        to.PassesAttempted = from.PassesAttempted;
        to.PassesCompleted = from.PassesCompleted;
    }

    private static float Finite(float v) => float.IsFinite(v) ? MathF.Round(v * 1000f) / 1000f : 0f;
}
