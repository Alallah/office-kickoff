namespace OfficeKickoff.Sim.Ai;

// Goalkeepers: positioning on the arc, shot stopping (with a reaction delay and dives), coming
// out one on one, claiming loose balls, and distribution.
public sealed partial class AiDirector
{
    /// <summary>Sample index at which the threatening ball reaches the goal line, per defending team.</summary>
    private readonly int[] _threatIndex = new int[2];

    private void ThinkKeeper(int k, ref PlayerInput input)
    {
        ref readonly var p = ref _s.Players[k];
        ref readonly var b = ref _s.Ball;
        int team = p.Team;
        input.AimPoint = b.Pos;

        if (p.Action is PlayerAction.Dive or PlayerAction.Recover or PlayerAction.Stunned or PlayerAction.Slide)
        {
            _hold[k] = 0;
            _kickCharge[k] = 0f;
            _hadBall[k] = false;
            return;
        }

        if (b.Owner == k)
        {
            KeeperOnBall(k, ref input);
            return;
        }

        _hadBall[k] = false;
        _hold[k] = 0;
        _kickCharge[k] = 0f;
        if (p.Charging) input.Shoot = false;

        if (KeeperSave(k, ref input)) return;

        if (b.Owner < 0 && (_keeperClaims[team] || b.PassTarget == k))
        {
            input.Move = Steer(k, InBox(_etaPoint[k], team), false, 10f);
            input.Sprint = true;
            return;
        }

        if (OneOnOne(k, ref input)) return;
        KeeperPosition(k, ref input);
    }

    /// <summary>A point kept inside a team's own keeper box, where its keeper keeps the use of its hands.</summary>
    private Vec2 InBox(Vec2 point, int team)
    {
        float sign = PitchGeometry.AttackSign(team);
        float lineX = _pitch.GoalLineX(team);
        float r = _t.Player.Radius;
        float depth = Math.Clamp((point.X - lineX) * sign, r + 2f, MathF.Max(r + 2f, _pitch.BoxDepth - 6f));
        float y = Math.Clamp(point.Y, -_pitch.BoxHalfWidth + 6f, _pitch.BoxHalfWidth - 6f);
        return _pitch.ClampCircle(new Vec2(lineX + sign * depth, y), r);
    }

    // ------------------------------------------------------------------------------------
    //  Reading the danger
    // ------------------------------------------------------------------------------------

    /// <summary>
    /// Is a free ball on its way into this team's goal? Easy and Normal keepers read the straight
    /// line; Hard keepers also read the curve. Remembers when the threat first appeared, which is
    /// what the keeper's reaction time counts from.
    /// </summary>
    private void UpdateThreat(int team)
    {
        ref readonly var b = ref _s.Ball;
        bool was = _threat[team];
        _threat[team] = false;
        if (b.Owner >= 0 || b.Dead) return;

        float sign = PitchGeometry.AttackSign(team);
        if (b.Vel.X * -sign <= 30f) return;

        var path = KeeperLevel(team) == AiLevel.Hard ? _path : _straight;
        float lineX = _pitch.GoalLineX(team);
        float r = _t.Ball.Radius;
        int cross = -1;
        for (int s = 1; s < Samples; s++)
        {
            if ((path[s].X - lineX) * sign < -r * 0.5f)
            {
                cross = s;
                break;
            }

            if (path[s] == path[s - 1]) break;
        }

        if (cross < 0) return;

        // Where it crosses the line, between the last sample in front and the first one behind.
        Vec2 a = path[cross - 1], c = path[cross];
        float da = (a.X - lineX) * sign, dc = (c.X - lineX) * sign;
        float f = da - dc > 1e-4f ? da / (da - dc) : 1f;
        float y = a.Y + (c.Y - a.Y) * f;
        if (MathF.Abs(y) > _pitch.GoalHalf + r) return;

        _threat[team] = true;
        _threatIndex[team] = cross;
        double key = b.LastTouchTime;
        if (!was || key != _threatKey[team])
        {
            _threatSince[team] = _now;
            _threatKey[team] = key;
        }
    }

    /// <summary>Whether the keeper should come for the loose ball (decided before the outfield roles).</summary>
    private bool KeeperClaims(int team)
    {
        UpdateThreat(team);
        ref readonly var b = ref _s.Ball;
        int k = team * _size;
        ref readonly var p = ref _s.Players[k];
        if (b.Owner >= 0 || b.Dead || p.Controller != -1) return false;
        if (p.Action is not (PlayerAction.None or PlayerAction.Dash)) return false;
        if (_threat[team] && b.Vel.Length > _t.Keeper.CatchSpeed.Get(KeeperLevel(team)) * 0.6f) return false;

        Vec2 at = _etaPoint[k];
        if (Vec2.Distance(at, _pitch.OwnGoal(team)) > _t.Keeper.ClaimRange || !_pitch.InBox(at, team)) return false;

        float theirs = float.MaxValue;
        int opp = 1 - team;
        for (int j = opp * _size; j < (opp + 1) * _size; j++) theirs = MathF.Min(theirs, _eta[j]);
        return _eta[k] + 0.1f < theirs;
    }

    // ------------------------------------------------------------------------------------
    //  Shot stopping
    // ------------------------------------------------------------------------------------

    private bool KeeperSave(int k, ref PlayerInput input)
    {
        ref readonly var p = ref _s.Players[k];
        int team = p.Team;
        if (!_threat[team]) return false;
        var level = KeeperLevel(team);
        if (_now - _threatSince[team] < _t.Keeper.Reaction.Get(level)) return false;

        var path = level == AiLevel.Hard ? _path : _straight;
        int cross = Math.Min(_threatIndex[team], Samples - 1);
        float sign = PitchGeometry.AttackSign(team);
        float contact = _t.Player.Radius + _t.Ball.Radius;
        float run = RunSpeed(in p, true);

        // The point on the ball's path the keeper can get to soonest relative to the ball (in the box if possible).
        int best = cross;
        float deficit = float.MaxValue;
        for (int s = 1; s <= cross; s++)
        {
            float t = s * SampleDt;
            float d = Vec2.Distance(path[s], p.Pos) - contact - run * MathF.Max(0f, t - 0.05f);
            if (!_pitch.InBox(path[s], team)) d += 30f;
            if (d < deficit)
            {
                deficit = d;
                best = s;
            }
        }

        Vec2 meet = InBox(path[best], team);
        input.Move = Steer(k, meet, false, 6f);
        input.Sprint = true;
        input.AimPoint = path[best];
        if (deficit <= 0f || p.TackleCooldown > 0f || p.Action != PlayerAction.None) return true;

        // Running will not get there: dive, timed for the moment the ball passes the keeper.
        int pass = cross;
        for (int s = 1; s <= cross; s++)
        {
            if ((path[s].X - p.Pos.X) * sign <= 0f)
            {
                pass = s;
                break;
            }
        }

        // A keeper always tries: even a dive that will not quite get there is worth it for a ball going in.
        float tPass = pass * SampleDt;
        float window = _t.Keeper.DiveTime * 0.85f + SampleDt;
        if (tPass > window) return true;

        Vec2 spot = path[pass];
        input.Tackle = true;
        input.AimPoint = spot;
        input.Move = Vec2.Zero;
        return true;
    }

    /// <summary>A carrier through on goal with nobody in between: come out and narrow the angle, then go for the ball.</summary>
    private bool OneOnOne(int k, ref PlayerInput input)
    {
        var players = _s.Players;
        ref readonly var p = ref players[k];
        ref readonly var b = ref _s.Ball;
        int owner = b.Owner;
        if (owner < 0 || players[owner].Team == p.Team) return false;

        ref readonly var c = ref players[owner];
        int team = p.Team;
        Vec2 goal = _pitch.OwnGoal(team);
        float dC = Vec2.Distance(c.Pos, goal);
        if (dC > _t.Ai.ShootRange.Get(OutfieldLevel(c.Team)) + 40f) return false;

        Vec2 u = (goal - c.Pos) / MathF.Max(1f, dC);
        for (int j = team * _size + 1; j < (team + 1) * _size; j++)
        {
            Vec2 rel = players[j].Pos - c.Pos;
            float along = Vec2.Dot(rel, u);
            if (along > 0f && along < dC && MathF.Abs(Vec2.Cross(u, rel)) < 60f) return false;
        }

        var kt = _t.Keeper;
        float advance = Math.Clamp(dC * 0.45f, kt.LineOffset, MathF.Min(_pitch.BoxDepth - 25f, kt.MaxAdvance * 1.5f));
        Vec2 spot = goal - u * advance;
        spot = new Vec2(spot.X, Math.Clamp(spot.Y, -_pitch.GoalHalf - 20f, _pitch.GoalHalf + 20f));
        if (Vec2.Distance(p.Pos, b.Pos) < 95f && _pitch.InBox(b.Pos, team)) spot = b.Pos;

        input.Move = Steer(k, InBox(spot, team), false, 10f);
        input.Sprint = true;
        input.AimPoint = b.Pos;
        return true;
    }

    /// <summary>On the arc between ball and goal centre, further out as the ball comes closer and more central.</summary>
    private void KeeperPosition(int k, ref PlayerInput input)
    {
        ref readonly var p = ref _s.Players[k];
        ref readonly var b = ref _s.Ball;
        int team = p.Team;
        float sign = PitchGeometry.AttackSign(team);
        var kt = _t.Keeper;
        Vec2 goal = _pitch.OwnGoal(team);
        Vec2 ball = b.Owner < 0 ? b.Pos + b.Vel * 0.15f : b.Pos;

        Vec2 to = ball - goal;
        float d = to.Length;
        Vec2 dir = d > 1f ? to / d : new Vec2(sign, 0f);
        float central = MathF.Max(0f, dir.X * sign);
        float closeness = MathUtil.Clamp01(1f - (d - 150f) / (_pitch.Width * 0.5f));
        float advance = MathUtil.Lerp(kt.LineOffset, kt.MaxAdvance, closeness * central);
        Vec2 spot = goal + dir * advance;

        // Slowly wandering error: a keeper is never quite where the geometry says.
        float err = kt.PositionError.Get(KeeperLevel(team));
        float time = (float)(_now % 1000d);
        spot += new Vec2(sign * err * 0.4f * MathF.Sin(time * 0.61f + _noise[team * 2 + 1]),
            err * MathF.Sin(time * 0.83f + _noise[team * 2]));

        float span = _pitch.GoalHalf - 4f;
        spot = new Vec2(spot.X, Math.Clamp(spot.Y, -span, span));
        input.Move = Steer(k, InBox(spot, team), false, 30f);
        input.Sprint = Vec2.Distance(p.Pos, spot) > 90f;
        input.AimPoint = b.Pos;
    }

    // ------------------------------------------------------------------------------------
    //  Distribution
    // ------------------------------------------------------------------------------------

    private void KeeperOnBall(int k, ref PlayerInput input)
    {
        ref readonly var p = ref _s.Players[k];
        ref readonly var b = ref _s.Ball;
        int team = p.Team;
        float sign = PitchGeometry.AttackSign(team);
        input.Move = Vec2.Zero;
        input.AimPoint = p.Pos + new Vec2(sign * 200f, 0f);

        if (!_hadBall[k])
        {
            _hadBall[k] = true;
            _keeperDelay[team] = 0.2f * (float)_rng.NextDouble();
        }

        if (_hold[k] > 0 || p.Charging)
        {
            ContinueStrike(k, ref input);
            input.Move = Vec2.Zero;
            return;
        }

        var kt = _t.Keeper;
        if (b.Held)
        {
            if (b.OwnerTime < kt.HoldTime + _keeperDelay[team])
            {
                // Step back into the box while holding: nobody may follow, so the kick-out has room.
                Vec2 goal = _pitch.OwnGoal(team);
                Vec2 spot = InBox(new Vec2(goal.X + sign * (kt.LineOffset + 50f), p.Pos.Y * 0.5f), team);
                input.Move = Steer(k, spot, false, 30f) * 0.7f;
                return;
            }

            int receiver = BestPass(k, keeper: true, out _);
            if (receiver >= 0)
            {
                PassTo(k, receiver, ref input);
                return;
            }

            // Nobody free: kick it long rather than stand there.
            StartStrike(k, KeeperClearTarget(k), 0.5f, 0.05f);
            ContinueStrike(k, ref input);
            input.Move = Vec2.Zero;
            return;
        }

        // At the feet (a back-pass): it can be taken off the keeper, so move it on at once.
        if (b.OwnerTime < 0.08f) return;
        int target = BestPass(k, keeper: true, out _);
        if (target >= 0)
        {
            PassTo(k, target, ref input);
            return;
        }

        StartStrike(k, KeeperClearTarget(k), 0.45f, 0.08f);
        ContinueStrike(k, ref input);
        input.Move = Vec2.Zero;
    }

    private static readonly float[] ClearAngles = [0f, -0.45f, 0.45f, -0.85f, 0.85f];

    /// <summary>The upfield direction with the clearest path: a clearance must not go straight into somebody.</summary>
    private Vec2 KeeperClearTarget(int k)
    {
        ref readonly var p = ref _s.Players[k];
        int opp = 1 - p.Team;
        Vec2 fwd = new(PitchGeometry.AttackSign(p.Team), 0f);
        float speed = ShotSpeed(0.5f);
        Vec2 best = ClearTarget(k);
        float bestMargin = float.MinValue;
        for (int a = 0; a < ClearAngles.Length; a++)
        {
            Vec2 to = _pitch.ClampCircle(p.Pos + fwd.Rotated(ClearAngles[a]) * 520f, _t.Ball.Radius);
            float margin = LaneMargin(p.Pos, to, opp, speed, 0.4f) - a * 4f;
            if (margin > bestMargin)
            {
                bestMargin = margin;
                best = to;
            }
        }

        return best;
    }
}
