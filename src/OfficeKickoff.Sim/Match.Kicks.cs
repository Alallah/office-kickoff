namespace OfficeKickoff.Sim;

// Shots and passes: who may kick, the remembered (buffered) kick that makes one-touch play
// possible, pass targeting and weighting.
public sealed partial class Match
{
    private const byte KickNone = 0;
    private const byte KickShot = 1;
    private const byte KickPass = 2;

    // A shot or pass pressed just before the ball arrives is remembered per footballer.
    private readonly byte[] _bufferKind;
    private readonly float[] _bufferTime;
    private readonly float[] _bufferCharge;
    private int _bufferCount;

    /// <summary>
    /// The team-mate a pass by <paramref name="playerIndex"/> aimed at <paramref name="aimPoint"/>
    /// would go to right now, or -1 for a pass into space. Read-only; this is the rule the browser
    /// repeats to highlight the receiver.
    /// </summary>
    public int PassTargetFor(int playerIndex, Vec2 aimPoint)
    {
        if ((uint)playerIndex >= (uint)_count) return -1;
        ref readonly var p = ref State.Players[playerIndex];
        var clean = new Vec2(Finite(aimPoint.X, AimLimit), Finite(aimPoint.Y, AimLimit));
        return FindPassTarget(playerIndex, DirectionTo(in p, clean));
    }

    /// <summary>Step 4 of the tick: released shots and pass edges, then remembered kicks, then the keeper's hold limit.</summary>
    private void PlayKicks(float dt)
    {
        // Alternate which team goes first so neither wins every same-tick race for a loose ball.
        int start = (State.Tick & 1) == 0 ? 0 : _teamSize;

        for (int k = 0; k < _count; k++)
        {
            int i = start + k;
            if (i >= _count) i -= _count;
            if (_released[i])
            {
                _released[i] = false;
                TryKick(i, KickShot, _releasedCharge[i]);
            }

            if (_inputs[i].Pass) TryKick(i, KickPass, 0f);
        }

        for (int k = 0; k < _count && _bufferCount > 0; k++)
        {
            int i = start + k;
            if (i >= _count) i -= _count;
            if (_bufferKind[i] == KickNone || TryPlayBuffered(i)) continue;
            _bufferTime[i] -= dt;
            if (_bufferTime[i] <= 0f) ClearBuffer(i);
        }

        ref readonly var b = ref State.Ball;
        // Half a tick of slack so float accumulation of OwnerTime cannot cost an extra tick.
        if (b.Held && b.Owner >= 0 && b.OwnerTime >= Tuning.Keeper.MaxHoldTime - 0.5f * dt) ForceKeeperRelease(b.Owner);
    }

    private void TryKick(int i, byte kind, float charge)
    {
        ref readonly var b = ref State.Ball;
        if (b.Owner == i)
        {
            ClearBuffer(i);
            Kick(i, kind, charge, firstTime: false);
        }
        else if (CanKickLooseBall(i))
        {
            ClearBuffer(i);
            Kick(i, kind, charge, firstTime: true);
        }
        else
        {
            if (_bufferKind[i] == KickNone) _bufferCount++;
            _bufferKind[i] = kind;
            _bufferCharge[i] = charge;
            _bufferTime[i] = Tuning.Kick.BufferTime;
        }
    }

    /// <summary>Plays a remembered kick if the ball is the footballer's or within reach. True when it was played.</summary>
    private bool TryPlayBuffered(int i)
    {
        byte kind = _bufferKind[i];
        if (kind == KickNone || State.Phase != MatchPhase.Playing) return false;
        if (State.Ball.Owner != i && !CanKickLooseBall(i)) return false;

        float charge = _bufferCharge[i];
        ClearBuffer(i);
        Kick(i, kind, charge, firstTime: true);
        return true;
    }

    private void ClearBuffer(int i)
    {
        if (_bufferKind[i] == KickNone) return;
        _bufferKind[i] = KickNone;
        _bufferTime[i] = 0f;
        _bufferCharge[i] = 0f;
        _bufferCount--;
    }

    private void ClearAllBuffers()
    {
        Array.Clear(_bufferKind);
        Array.Clear(_bufferTime);
        Array.Clear(_bufferCharge);
        _bufferCount = 0;
    }

    /// <summary>A footballer who is down, or who has only just kicked this very ball, cannot play it first-time.</summary>
    private bool CanPlayFirstTime(int i)
    {
        ref readonly var p = ref State.Players[i];
        if (p.Action is PlayerAction.Stunned or PlayerAction.Recover) return false;
        return !(p.KickCooldown > 0f && State.Ball.LastTouch == i);
    }

    private bool CanKickLooseBall(int i)
    {
        ref readonly var b = ref State.Ball;
        if (b.Owner >= 0 || b.Dead || !CanPlayFirstTime(i)) return false;
        float reach = Tuning.Player.Radius + Tuning.Ball.Radius + Tuning.Kick.KickReach;
        return Vec2.DistanceSq(State.Players[i].Pos, b.Pos) <= reach * reach;
    }

    private void Kick(int i, byte kind, float charge, bool firstTime)
    {
        if (kind == KickShot) Shoot(i, charge, firstTime);
        else Pass(i, firstTime, forcedTarget: -1);
    }

    private static Vec2 DirectionTo(in PlayerState p, Vec2 aimPoint)
    {
        Vec2 to = aimPoint - p.Pos;
        return to.LengthSq > 1f ? to.Normalized() : Vec2.FromAngle(p.Aim);
    }

    /// <summary>Takes the ball off its owner (if any) and puts it just in front of the kicker.</summary>
    private void PlaceKickedBall(int i, Vec2 dir)
    {
        ref var b = ref State.Ball;
        ref readonly var p = ref State.Players[i];
        float offset = Tuning.Player.Radius + Tuning.Ball.Radius + KickOffset;
        b.Owner = -1;
        b.Held = false;
        b.Pos = Pitch.ClampCircle(p.Pos + dir * offset, Tuning.Ball.Radius);
    }

    private void Shoot(int i, float charge, bool firstTime)
    {
        var kick = Tuning.Kick;
        ref var p = ref State.Players[i];
        ref var b = ref State.Ball;

        charge = MathUtil.Clamp01(charge);
        Vec2 dir = DirectionTo(in p, _inputs[i].AimPoint);
        float speed = MathUtil.Lerp(kick.ShotMinSpeed, kick.ShotMaxSpeed, charge) * Config.Settings.BallSpeed;

        Touch(i, TouchKind.Strike);
        PlaceKickedBall(i, dir);
        b.Vel = (dir * speed + p.Vel * kick.InheritVelocity).ClampLength(Tuning.Ball.MaxSpeed);

        // The shot bends towards the side the shooter is moving.
        float sideways = Ratio(Vec2.Dot(p.Vel, dir.Perp), Tuning.Player.RunSpeed) * kick.CurveFromMove;
        b.Spin = Math.Clamp(sideways, -1f, 1f) * (SpinAtZeroCharge + (1f - SpinAtZeroCharge) * charge);
        b.Heat = charge;
        p.KickCooldown = kick.KickCooldown;
        b.OnTargetGoal = GoalOnLineOfFlight();

        int opponents = 1 - p.Team;
        bool onTarget = b.OnTargetGoal == opponents;
        bool towardsGoal = b.Vel.X * PitchGeometry.AttackSign(p.Team) > 0f;
        bool isShot = towardsGoal &&
            (onTarget || Vec2.Distance(b.Pos, Pitch.OpponentGoal(p.Team)) <= ShotRangeFactor * Pitch.Width);
        if (isShot) Count(Stat.Shots, p.Team, p.Controller);
        if (onTarget) Count(Stat.ShotsOnTarget, p.Team, p.Controller);
        _lastCountedShot = isShot;
        _lastCountedOnTarget = onTarget;

        Emit(GameEventType.Kick, i, pos: b.Pos, value: charge, flag: firstTime ? 1 : 0);
    }

    /// <param name="forcedTarget">Receiver chosen by the simulation (the keeper's forced release), or -1 to pick by aim.</param>
    private void Pass(int i, bool firstTime, int forcedTarget)
    {
        var kick = Tuning.Kick;
        var players = State.Players;
        ref var p = ref players[i];
        ref var b = ref State.Ball;

        Vec2 aim = DirectionTo(in p, _inputs[i].AimPoint);
        int target = forcedTarget >= 0 ? forcedTarget : FindPassTarget(i, aim);

        float ballSpeed = Config.Settings.BallSpeed;
        float min = kick.PassMinSpeed * ballSpeed;
        float max = kick.PassMaxSpeed * MathF.Max(1f, ballSpeed);
        float arrive = kick.PassArriveSpeed * ballSpeed;
        float drag = Tuning.Ball.Drag;
        float offset = Tuning.Player.Radius + Tuning.Ball.Radius + KickOffset;
        float ballRadius = Tuning.Ball.Radius;

        Vec2 dir;
        float v0;
        if (target >= 0)
        {
            ref readonly var t = ref players[target];
            Vec2 toTarget = t.Pos - p.Pos;
            Vec2 straight = toTarget.LengthSq > 1e-6f ? toTarget.Normalized() : aim;

            // Weight to the receiver's feet first, lead them by the flight time, then weight again.
            float d0 = Vec2.Distance(Pitch.ClampCircle(p.Pos + straight * offset, ballRadius), t.Pos);
            float first = Clamp(arrive + drag * d0, min, max);
            // (The browser repeats this arithmetic for its ghost ball: the lead is kept on the pitch as a ball.)
            Vec2 lead = t.Pos + t.Vel * (d0 / MathF.Max(first, 1f) * kick.PassLead);
            lead = Pitch.ClampCircle(lead, ballRadius);

            Vec2 toLead = lead - p.Pos;
            dir = toLead.LengthSq > 1f ? toLead.Normalized() : straight;
            float d = Vec2.Distance(Pitch.ClampCircle(p.Pos + dir * offset, ballRadius), lead);
            v0 = Clamp(arrive + drag * d, min, max);
        }
        else
        {
            dir = aim;
            float d = Vec2.Distance(Pitch.ClampCircle(p.Pos + dir * offset, ballRadius), _inputs[i].AimPoint);
            v0 = Clamp(arrive + drag * d, min, max);
        }

        int human = p.Controller;
        Touch(i, TouchKind.Strike);
        PlaceKickedBall(i, dir);
        b.Vel = (dir * v0).ClampLength(Tuning.Ball.MaxSpeed);
        b.Spin = 0f;
        b.Heat = PassHeat;
        p.KickCooldown = kick.KickCooldown;
        b.PassTarget = target;
        b.PassFrom = i;
        _passHuman = human;
        b.OnTargetGoal = GoalOnLineOfFlight();
        Count(Stat.PassesAttempted, p.Team, human);

        Emit(GameEventType.Pass, i, target, b.Pos, Ratio(v0, kick.PassMaxSpeed), firstTime ? 1 : 0);

        // Pass hand-over: the passer's human follows the ball to an AI receiver at once.
        if (human >= 0 && target >= 0 && !players[target].IsKeeper && players[target].Controller == -1)
        {
            var h = State.Humans[human];
            SetControl(h, target);
            h.SwitchCooldown = Tuning.Switch.MinGap;
        }
    }

    /// <summary>
    /// Pass target rule. Team-mates whose direction from the passer is within the pass cone of the
    /// aim direction are candidates - outfield team-mates first, the own goalkeeper (in a match with
    /// goalkeepers) only when no outfield team-mate is in the cone. Candidates within PassTieDeg of the best-aligned one are
    /// tied; the nearest tied candidate gets the pass.
    /// </summary>
    private int FindPassTarget(int i, Vec2 aimDir)
    {
        var players = State.Players;
        ref readonly var p = ref players[i];
        float cone = Tuning.Kick.PassConeDeg * (MathF.PI / 180f);
        float tie = Tuning.Kick.PassTieDeg * (MathF.PI / 180f);
        float aimAngle = aimDir.Angle;
        int first = p.Team * _teamSize;
        int end = first + _teamSize;

        int keeper = -1;
        float smallest = float.MaxValue;
        for (int j = first; j < end; j++)
        {
            if (j == i) continue;
            if (players[j].IsKeeper)
            {
                keeper = j;
                continue;
            }

            float angle = PassAngle(in p, in players[j], aimAngle);
            if (angle <= cone && angle < smallest) smallest = angle;
        }

        if (smallest == float.MaxValue)
        {
            // Nobody outfield: the keeper (if the team has one) is the last resort.
            return keeper >= 0 && PassAngle(in p, in players[keeper], aimAngle) <= cone ? keeper : -1;
        }

        int best = -1;
        float bestD2 = float.MaxValue;
        for (int j = first; j < end; j++)
        {
            if (j == i || players[j].IsKeeper) continue;
            float angle = PassAngle(in p, in players[j], aimAngle);
            if (angle > cone || angle > smallest + tie) continue;
            float d2 = Vec2.DistanceSq(p.Pos, players[j].Pos);
            if (d2 < bestD2)
            {
                bestD2 = d2;
                best = j;
            }
        }

        return best;
    }

    /// <summary>Angle between the aim direction and the direction to a team-mate; huge when undefined.</summary>
    private static float PassAngle(in PlayerState from, in PlayerState to, float aimAngle)
    {
        Vec2 d = to.Pos - from.Pos;
        if (d.LengthSq < 1e-6f) return float.MaxValue;
        return MathF.Abs(MathUtil.AngleDiff(aimAngle, d.Angle));
    }

    /// <summary>
    /// The team defending the goal mouth the ball's straight line of flight reaches while still
    /// moving, or -1. The pitch is convex, so a line that reaches a mouth never leaves it on the way.
    /// </summary>
    private int GoalOnLineOfFlight()
    {
        ref readonly var b = ref State.Ball;
        float speed = b.Vel.Length;
        if (speed < 1e-3f || MathF.Abs(b.Vel.X) < 1e-6f) return -1;

        float lineX = b.Vel.X > 0f ? Pitch.HalfW : -Pitch.HalfW;
        float t = (lineX - b.Pos.X) / b.Vel.X;
        if (t < 0f) return -1;
        float y = b.Pos.Y + b.Vel.Y * t;
        if (MathF.Abs(y) >= Pitch.GoalHalf) return -1;

        // Under exponential drag the ball loses Drag units of speed per unit travelled.
        if (speed - Tuning.Ball.Drag * speed * t <= OnTargetMinSpeed) return -1;
        return b.Vel.X > 0f ? 1 : 0;
    }

    /// <summary>A keeper who has held the ball too long is made to pass to the nearest outfield team-mate.</summary>
    private void ForceKeeperRelease(int keeper)
    {
        var players = State.Players;
        ref readonly var k = ref players[keeper];
        int first = k.Team * _teamSize;
        int target = -1;
        float bestD2 = float.MaxValue;
        for (int j = first; j < first + _teamSize; j++)
        {
            if (j == keeper || players[j].IsKeeper) continue;
            float d2 = Vec2.DistanceSq(k.Pos, players[j].Pos);
            if (d2 < bestD2)
            {
                bestD2 = d2;
                target = j;
            }
        }

        ClearBuffer(keeper);
        Pass(keeper, firstTime: false, forcedTarget: target);
    }
}
