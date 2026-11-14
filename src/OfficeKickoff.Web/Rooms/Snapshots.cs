using OfficeKickoff.Sim;
using OfficeKickoff.Web.Protocol;

namespace OfficeKickoff.Web.Rooms;

/// <summary>
/// Builds the compact wire snapshot (layout documented on <see cref="SnapDto"/>). Every number is
/// rounded and any non-finite value becomes 0: a single NaN would make the JSON serialiser fail
/// and SignalR drop every connection in the room.
/// </summary>
public static class Snapshots
{
    public const int EventLength = 7;

    /// <summary>Snapshot of the match without events. <paramref name="nonFinite"/> is set when a value had to be replaced.</summary>
    public static SnapDto Build(Match match, int[] acks, ref bool nonFinite)
    {
        var s = match.State;
        var players = s.Players;
        var p = new float[players.Length * SnapDto.PlayerStride];
        for (int i = 0, o = 0; i < players.Length; i++, o += SnapDto.PlayerStride)
        {
            ref readonly var f = ref players[i];
            p[o] = R1(f.Pos.X, ref nonFinite);
            p[o + 1] = R1(f.Pos.Y, ref nonFinite);
            p[o + 2] = R1(f.Vel.X, ref nonFinite);
            p[o + 3] = R1(f.Vel.Y, ref nonFinite);
            p[o + 4] = R3(f.Aim, ref nonFinite);
            p[o + 5] = (float)f.Action;
            p[o + 6] = R3(f.ActionTime, ref nonFinite);
            p[o + 7] = R3(Angle(f.ActionDir), ref nonFinite);
            p[o + 8] = R3(f.Stamina, ref nonFinite);
            p[o + 9] = R3(f.Charge, ref nonFinite);
            p[o + 10] = f.Controller;
            p[o + 11] = R3(f.TackleCooldown, ref nonFinite);
            p[o + 12] = (f.Charging ? 1 : 0) | (f.Exhausted ? 2 : 0) | (f.Sprinting ? 4 : 0) |
                        (f.SlideHit ? 8 : 0) | (f.Immune > 0f ? 16 : 0);
        }

        ref readonly var b = ref s.Ball;
        float[] ball =
        [
            R1(b.Pos.X, ref nonFinite),
            R1(b.Pos.Y, ref nonFinite),
            R1(b.Vel.X, ref nonFinite),
            R1(b.Vel.Y, ref nonFinite),
            R3(b.Spin, ref nonFinite),
            b.Owner,
            R3(b.Heat, ref nonFinite),
            (b.Held ? 1 : 0) | (b.Dead ? 2 : 0),
        ];

        return new SnapDto
        {
            Tick = s.Tick,
            Phase = (int)s.Phase,
            PhaseTime = R3(s.PhaseTime, ref nonFinite),
            Clock = R3(s.Clock, ref nonFinite),
            Score = [s.Score[0], s.Score[1]],
            Flags = (s.Overtime ? 1 : 0) | (s.SlowMo ? 2 : 0) | (s.KickoffTeam == 1 ? 4 : 0),
            Ball = ball,
            Players = p,
            Acks = [acks[0], acks[1], acks[2], acks[3]],
        };
    }

    /// <summary>The same snapshot carrying a different event list (the arrays are shared, never modified).</summary>
    public static SnapDto WithEvents(SnapDto snap, float[][]? events) => new()
    {
        Tick = snap.Tick,
        Phase = snap.Phase,
        PhaseTime = snap.PhaseTime,
        Clock = snap.Clock,
        Score = snap.Score,
        Flags = snap.Flags,
        Ball = snap.Ball,
        Players = snap.Players,
        Acks = snap.Acks,
        Events = events,
    };

    /// <summary>[type, a, b, x, y, value, flag].</summary>
    public static float[] Event(in GameEvent e, ref bool nonFinite) =>
    [
        (float)e.Type,
        e.A,
        e.B,
        R1(e.X, ref nonFinite),
        R1(e.Y, ref nonFinite),
        R3(e.Value, ref nonFinite),
        e.Flag,
    ];

    private static float Angle(Vec2 v) =>
        v.X == 0f && v.Y == 0f ? 0f : MathF.Atan2(v.Y, v.X);

    public static float R1(float v, ref bool nonFinite) => Round(v, 10d, ref nonFinite);

    public static float R3(float v, ref bool nonFinite) => Round(v, 1000d, ref nonFinite);

    private static float Round(float v, double scale, ref bool nonFinite)
    {
        if (!float.IsFinite(v))
        {
            nonFinite = true;
            return 0f;
        }

        return (float)(Math.Round(v * scale, MidpointRounding.AwayFromZero) / scale);
    }
}
