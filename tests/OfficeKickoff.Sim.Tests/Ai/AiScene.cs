using OfficeKickoff.Sim.Ai;

namespace OfficeKickoff.Sim.Tests.Ai;

/// <summary>
/// The real AI, except that footballers listed in <see cref="Pinned"/> get neutral controls (they
/// stand still and keep their facing). Lets a test build a scene and watch only the footballers
/// it is about. Also counts the AI's calls.
/// </summary>
public sealed class PinnedAi : IAiDirector
{
    public AiDirector Inner { get; } = new();

    public HashSet<int> Pinned { get; } = [];

    public int Thinks { get; private set; }

    public void Reset(AiContext ctx) => Inner.Reset(ctx);

    public void Think(AiContext ctx, PlayerInput[] inputs, float dt)
    {
        Thinks++;
        Inner.Think(ctx, inputs, dt);
        var players = ctx.State.Players;
        foreach (int i in Pinned)
        {
            if (players[i].Controller != -1) continue;
            inputs[i] = new PlayerInput { AimPoint = players[i].Pos + Vec2.FromAngle(players[i].Aim) * 100f };
        }
    }

    /// <summary>Pins every footballer except the listed ones.</summary>
    public void PinAllBut(Match m, params int[] free)
    {
        Pinned.Clear();
        for (int i = 0; i < m.State.Players.Length; i++)
        {
            if (Array.IndexOf(free, i) < 0) Pinned.Add(i);
        }
    }
}

public static class AiScene
{
    /// <summary>
    /// A match in open play driven by the real AI (behind <see cref="PinnedAi"/>), with every
    /// footballer parked on the top touchline of their own half and the ball at rest on the centre spot.
    /// </summary>
    public static Match Build(out PinnedAi ai, int size = 5, AiLevel level = AiLevel.Normal, int seed = 1234,
        Action<MatchSettings>? settings = null)
    {
        ai = new PinnedAi();
        var m = TestKit.Playing(size, ai, seed, settings: s =>
        {
            s.AiTeammates = level;
            s.AiKeeper = level;
            settings?.Invoke(s);
        });
        TestKit.Park(m);
        TestKit.FreeBall(m, Vec2.Zero, Vec2.Zero);
        return m;
    }

    /// <summary>A read-only context over a match for calling the AI directly.</summary>
    public static AiContext Context(Match m, int seed = 1) => new()
    {
        State = m.State,
        Pitch = m.Pitch,
        Tuning = m.Tuning,
        Config = m.Config,
        Rng = new Random(seed),
    };

    /// <summary>
    /// True when nobody on the opposing team stands within <paramref name="clearance"/> (plus
    /// <paramref name="growth"/> per unit along the lane, for the time they have to get across) of
    /// the line between two points.
    /// </summary>
    public static bool LaneOpen(Match m, Vec2 from, Vec2 to, int opponents, float clearance, float growth = 0f)
    {
        Vec2 d = to - from;
        float len = d.Length;
        if (len < 1f) return true;
        Vec2 u = d / len;
        int size = m.State.TeamSize;
        for (int j = opponents * size; j < (opponents + 1) * size; j++)
        {
            Vec2 rel = m.State.Players[j].Pos - from;
            float along = Vec2.Dot(rel, u);
            if (along < 0f || along > len) continue;
            if (MathF.Abs(Vec2.Cross(u, rel)) < clearance + growth * along) return false;
        }

        return true;
    }
}
