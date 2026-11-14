namespace OfficeKickoff.Sim;

/// <summary>
/// One outfield position in a formation.
/// <paramref name="Row"/> counts from defence (0) to attack; <paramref name="Depth"/> is 0 at the
/// team's own goal line and 1 at the halfway line; <paramref name="Lateral"/> is -1..1 across the pitch.
/// </summary>
public readonly record struct FormationSpot(int Row, int RowCount, float Depth, float Lateral);

/// <summary>
/// Formation catalogue. A formation is written defence-to-attack, e.g. "1-2-1", and only counts
/// outfield footballers: every team also has one goalkeeper in slot 0.
/// </summary>
public static class Formations
{
    private static readonly Dictionary<int, string[]> Catalog = new()
    {
        [3] = ["1-1", "2-0", "0-2"],
        [4] = ["1-2", "2-1", "1-1-1"],
        [5] = ["2-2", "1-2-1", "3-1", "1-3"],
        [6] = ["2-2-1", "2-1-2", "3-2", "1-3-1"],
        [7] = ["2-3-1", "3-2-1", "2-2-2", "3-1-2"],
    };

    /// <summary>Formations valid for a team size (3..7). The first entry is the default.</summary>
    public static IReadOnlyList<string> ValidFor(int teamSize) =>
        Catalog.TryGetValue(teamSize, out var list) ? list : Catalog[5];

    public static string Default(int teamSize) => ValidFor(teamSize)[0];

    public static bool IsValid(string? name, int teamSize) =>
        name is not null && ValidFor(teamSize).Contains(name);

    /// <summary>Returns <paramref name="name"/> if it is valid for the team size, otherwise the default.</summary>
    public static string Resolve(string? name, int teamSize) =>
        IsValid(name, teamSize) ? name! : Default(teamSize);

    /// <summary>
    /// Outfield spots for slots 1..teamSize-1, ordered defence to attack and, within a row,
    /// from -1 (top of the screen for the home team) to +1.
    /// </summary>
    public static FormationSpot[] Spots(string? name, int teamSize)
    {
        string formation = Resolve(name, teamSize);
        int[] rows = formation.Split('-').Select(int.Parse).ToArray();
        var spots = new List<FormationSpot>(teamSize - 1);
        for (int r = 0; r < rows.Length; r++)
        {
            int n = rows[r];
            float depth = rows.Length == 1 ? 0.55f : MathUtil.Lerp(0.26f, 0.84f, r / (float)(rows.Length - 1));
            float spread = MathF.Min(0.88f, 0.42f + 0.14f * n);
            for (int i = 0; i < n; i++)
            {
                float lateral = n == 1 ? 0f : ((i + 0.5f) / n - 0.5f) * 2f * spread;
                spots.Add(new FormationSpot(r, rows.Length, depth, lateral));
            }
        }

        return spots.ToArray();
    }

    /// <summary>
    /// Home (kickoff) positions for a whole team, indexed by slot (0 = keeper). All positions are
    /// in the team's own half. The away team is the home layout rotated 180 degrees.
    /// </summary>
    public static Vec2[] HomePositions(string? name, int teamSize, int team, PitchGeometry pitch, Tuning tuning)
    {
        var spots = Spots(name, teamSize);
        var result = new Vec2[teamSize];
        float sign = PitchGeometry.AttackSign(team);
        result[0] = new Vec2(-sign * (pitch.HalfW - tuning.Keeper.LineOffset), 0f);
        for (int i = 0; i < spots.Length && i + 1 < teamSize; i++)
        {
            float x = -pitch.HalfW + spots[i].Depth * pitch.HalfW * 0.94f;
            float y = spots[i].Lateral * pitch.HalfH;
            result[i + 1] = new Vec2(sign * x, sign * y);
        }

        return result;
    }
}
