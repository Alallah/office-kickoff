namespace OfficeKickoff.Sim;

/// <summary>
/// Static geometry of the pitch for one match.
///
/// The playing area is the rectangle [-HalfW, HalfW] x [-HalfH, HalfH] with rounded corners
/// of radius <see cref="CornerRadius"/>. It is fully walled: the ball bounces off every edge.
/// Team 0 (home) defends the LEFT goal and attacks towards +X; team 1 (away) defends the
/// RIGHT goal and attacks towards -X. Each goal is an opening in the end wall for
/// |y| &lt; GoalHalf, with a net that extends <see cref="GoalDepth"/> beyond the goal line and
/// a round post of radius <see cref="PostRadius"/> at each end of the opening.
/// Footballers can never leave the playing area (they cannot walk into the nets).
/// </summary>
public sealed class PitchGeometry
{
    public float Width { get; }
    public float Height { get; }
    public float HalfW { get; }
    public float HalfH { get; }
    public float GoalWidth { get; }
    public float GoalHalf { get; }
    public float GoalDepth { get; }
    public float PostRadius { get; }
    public float CornerRadius { get; }
    public float BoxDepth { get; }
    public float BoxHalfWidth { get; }
    public float CenterRadius { get; }

    /// <summary>Centres of the four goal posts: left-top, left-bottom, right-top, right-bottom.</summary>
    public Vec2[] Posts { get; }

    public PitchGeometry(int teamSize, Tuning tuning)
    {
        var p = tuning.Pitch;
        Width = p.Width.Get(teamSize);
        Height = p.Height.Get(teamSize);
        HalfW = Width / 2f;
        HalfH = Height / 2f;
        GoalWidth = p.GoalWidth.Get(teamSize);
        GoalHalf = GoalWidth / 2f;
        GoalDepth = p.GoalDepth;
        PostRadius = p.PostRadius;
        CornerRadius = MathF.Min(p.CornerRadius, MathF.Min(HalfW, HalfH - GoalHalf) - 1f);
        BoxDepth = p.BoxDepth;
        BoxHalfWidth = MathF.Min(GoalHalf + p.BoxExtraWidth, HalfH - 10f);
        CenterRadius = p.CenterRadius;
        Posts =
        [
            new Vec2(-HalfW, -GoalHalf), new Vec2(-HalfW, GoalHalf),
            new Vec2(HalfW, -GoalHalf), new Vec2(HalfW, GoalHalf),
        ];
    }

    /// <summary>+1 for the team attacking towards +X (team 0), -1 for team 1.</summary>
    public static float AttackSign(int team) => team == 0 ? 1f : -1f;

    /// <summary>X coordinate of the goal line a team defends.</summary>
    public float GoalLineX(int defendingTeam) => defendingTeam == 0 ? -HalfW : HalfW;

    /// <summary>Centre of the goal mouth a team defends.</summary>
    public Vec2 OwnGoal(int team) => new(GoalLineX(team), 0f);

    /// <summary>Centre of the goal mouth a team attacks.</summary>
    public Vec2 OpponentGoal(int team) => new(GoalLineX(1 - team), 0f);

    /// <summary>True when <paramref name="pos"/> lies inside the keeper box of <paramref name="defendingTeam"/>.</summary>
    public bool InBox(Vec2 pos, int defendingTeam)
    {
        if (MathF.Abs(pos.Y) > BoxHalfWidth) return false;
        float fromLine = defendingTeam == 0 ? pos.X + HalfW : HalfW - pos.X;
        return fromLine >= 0f && fromLine <= BoxDepth;
    }

    /// <summary>
    /// Returns the closest position at which a circle of the given radius lies fully inside the
    /// walls (rounded corners included, goal mouths treated as closed).
    /// </summary>
    public Vec2 ClampCircle(Vec2 pos, float radius)
    {
        float maxX = HalfW - radius, maxY = HalfH - radius;
        float x = Math.Clamp(pos.X, -maxX, maxX);
        float y = Math.Clamp(pos.Y, -maxY, maxY);

        // Rounded corners: inside a corner square the circle must stay within (CornerRadius - radius)
        // of the corner's arc centre.
        float cx = HalfW - CornerRadius, cy = HalfH - CornerRadius;
        float ax = MathF.Abs(x), ay = MathF.Abs(y);
        if (ax > cx && ay > cy)
        {
            float dx = ax - cx, dy = ay - cy;
            float limit = MathF.Max(0f, CornerRadius - radius);
            float d2 = dx * dx + dy * dy;
            if (d2 > limit * limit)
            {
                float d = MathF.Sqrt(d2);
                dx = dx / d * limit;
                dy = dy / d * limit;
                x = MathF.CopySign(cx + dx, x);
                y = MathF.CopySign(cy + dy, y);
            }
        }

        return new Vec2(x, y);
    }
}
