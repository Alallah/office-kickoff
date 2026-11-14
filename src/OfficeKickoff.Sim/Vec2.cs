namespace OfficeKickoff.Sim;

/// <summary>
/// Immutable 2D vector. World space: origin at the pitch centre, +X to the right, +Y down
/// (screen convention). Angles are radians, measured from +X towards +Y.
/// </summary>
public readonly struct Vec2 : IEquatable<Vec2>
{
    public readonly float X;
    public readonly float Y;

    public Vec2(float x, float y)
    {
        X = x;
        Y = y;
    }

    public static readonly Vec2 Zero = new(0f, 0f);

    public float Length => MathF.Sqrt(X * X + Y * Y);
    public float LengthSq => X * X + Y * Y;
    public float Angle => MathF.Atan2(Y, X);
    public bool IsFinite => float.IsFinite(X) && float.IsFinite(Y);

    /// <summary>The vector rotated by +90 degrees.</summary>
    public Vec2 Perp => new(-Y, X);

    public Vec2 Normalized()
    {
        float l = Length;
        return l > 1e-6f ? new Vec2(X / l, Y / l) : Zero;
    }

    public Vec2 ClampLength(float max)
    {
        float l2 = LengthSq;
        if (l2 <= max * max) return this;
        float l = MathF.Sqrt(l2);
        return new Vec2(X / l * max, Y / l * max);
    }

    public Vec2 Rotated(float radians)
    {
        float c = MathF.Cos(radians), s = MathF.Sin(radians);
        return new Vec2(X * c - Y * s, X * s + Y * c);
    }

    public static Vec2 FromAngle(float radians, float length = 1f) =>
        new(MathF.Cos(radians) * length, MathF.Sin(radians) * length);

    public static float Dot(Vec2 a, Vec2 b) => a.X * b.X + a.Y * b.Y;
    public static float Cross(Vec2 a, Vec2 b) => a.X * b.Y - a.Y * b.X;
    public static float Distance(Vec2 a, Vec2 b) => (a - b).Length;
    public static float DistanceSq(Vec2 a, Vec2 b) => (a - b).LengthSq;
    public static Vec2 Lerp(Vec2 a, Vec2 b, float t) => new(a.X + (b.X - a.X) * t, a.Y + (b.Y - a.Y) * t);

    public static Vec2 operator +(Vec2 a, Vec2 b) => new(a.X + b.X, a.Y + b.Y);
    public static Vec2 operator -(Vec2 a, Vec2 b) => new(a.X - b.X, a.Y - b.Y);
    public static Vec2 operator -(Vec2 a) => new(-a.X, -a.Y);
    public static Vec2 operator *(Vec2 a, float s) => new(a.X * s, a.Y * s);
    public static Vec2 operator *(float s, Vec2 a) => new(a.X * s, a.Y * s);
    public static Vec2 operator /(Vec2 a, float s) => new(a.X / s, a.Y / s);
    public static bool operator ==(Vec2 a, Vec2 b) => a.X == b.X && a.Y == b.Y;
    public static bool operator !=(Vec2 a, Vec2 b) => !(a == b);

    public bool Equals(Vec2 other) => this == other;
    public override bool Equals(object? obj) => obj is Vec2 v && this == v;
    public override int GetHashCode() => HashCode.Combine(X, Y);
    public override string ToString() => $"({X:0.##}, {Y:0.##})";
}

/// <summary>Small numeric helpers shared by the simulation.</summary>
public static class MathUtil
{
    public static float Clamp01(float v) => v < 0f ? 0f : v > 1f ? 1f : v;
    public static float Lerp(float a, float b, float t) => a + (b - a) * t;

    /// <summary>Wraps an angle to (-PI, PI].</summary>
    public static float WrapAngle(float a)
    {
        while (a > MathF.PI) a -= MathF.Tau;
        while (a <= -MathF.PI) a += MathF.Tau;
        return a;
    }

    /// <summary>Signed shortest rotation from <paramref name="from"/> to <paramref name="to"/>.</summary>
    public static float AngleDiff(float from, float to) => WrapAngle(to - from);

    /// <summary>Rotates <paramref name="current"/> towards <paramref name="target"/> by at most <paramref name="maxDelta"/>.</summary>
    public static float MoveAngleTowards(float current, float target, float maxDelta)
    {
        float d = AngleDiff(current, target);
        if (MathF.Abs(d) <= maxDelta) return WrapAngle(target);
        return WrapAngle(current + MathF.Sign(d) * maxDelta);
    }
}
