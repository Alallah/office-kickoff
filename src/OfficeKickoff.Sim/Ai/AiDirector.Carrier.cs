namespace OfficeKickoff.Sim.Ai;

// The AI footballer on the ball: shoot, pass, dribble, dodge, clear - and every strike that is
// wound up over several ticks (shots, clearances, first-time volleys).
public sealed partial class AiDirector
{
    /// <summary>Where across the goal mouth (fraction of the post-to-centre distance) the AI may aim.</summary>
    private static readonly float[] ShotLanes = [-0.9f, -0.65f, -0.3f, 0.3f, 0.65f, 0.9f];

    private void ThinkCarrier(int i, bool plan, ref PlayerInput input)
    {
        ref readonly var p = ref _s.Players[i];
        ref readonly var b = ref _s.Ball;

        if (!_hadBall[i])
        {
            // A first touch to settle, then a decision a little sooner than the usual rhythm.
            _hadBall[i] = true;
            _dodgeSeen[i] = -1;
            double soon = _now + Reaction(i) * 0.5f;
            if (_nextPlan[i] > soon) _nextPlan[i] = soon;
            plan = false;
            _sprintPlan[i] = Chance() < _t.Ai.SprintUse.Get(OutfieldLevel(p.Team));
        }

        if (_hold[i] > 0 || p.Charging)
        {
            ContinueStrike(i, ref input);
            return;
        }

        if (TryDodge(i, ref input)) return;

        if (_clearing)
        {
            StartStrike(i, ClearTarget(i), 0.6f, _t.Ai.AimError.Get(OutfieldLevel(p.Team)));
            ContinueStrike(i, ref input);
            return;
        }

        // Kickoff (the taker's first touch of the restart): find a human team-mate if there is one.
        bool kickoff = b.PrevTouch < 0 && b.LastTouch == i && HasHumanTeammate(i);
        if (plan || (kickoff && b.OwnerTime > 0.25f))
        {
            if (TryShoot(i, ref input)) return;
            if (TryPass(i, kickoff, ref input)) return;
            if (plan) _sprintPlan[i] = Chance() < _t.Ai.SprintUse.Get(OutfieldLevel(p.Team));
        }

        Dribble(i, ref input);
    }

    private bool HasHumanTeammate(int i)
    {
        int team = _s.Players[i].Team;
        for (int j = team * _size + 1; j < (team + 1) * _size; j++)
        {
            if (j != i && IsHuman(j)) return true;
        }

        return false;
    }

    // ------------------------------------------------------------------------------------
    //  Strikes wound up over several ticks
    // ------------------------------------------------------------------------------------

    /// <summary>Plans a struck ball: hold the shoot button for the charge, then release.</summary>
    private void StartStrike(int i, Vec2 target, float charge, float aimError)
    {
        _kickAim[i] = target;
        _kickCharge[i] = MathUtil.Clamp01(charge);
        _kickErr[i] = Noise() * aimError;
        _hold[i] = TicksFor(_kickCharge[i]);
        _volley[i] = false;
    }

    /// <summary>The planned strike's aim point, error included, from where the footballer stands now.</summary>
    private Vec2 StrikeAim(int i)
    {
        ref readonly var p = ref _s.Players[i];
        Vec2 to = _kickAim[i] - p.Pos;
        if (to.LengthSq < 1f) to = Vec2.FromAngle(p.Aim) * 100f;
        return p.Pos + to.Rotated(_kickErr[i]);
    }

    private void ContinueStrike(int i, ref PlayerInput input)
    {
        ref readonly var p = ref _s.Players[i];
        if (_kickCharge[i] <= 0f)
        {
            // Charging with no plan behind it (should not happen, but control changes hands mid-tick
            // in odd ways): finish it towards goal rather than walking around wound up.
            _kickAim[i] = _pitch.OpponentGoal(p.Team);
            _kickErr[i] = 0f;
            _kickCharge[i] = MathUtil.Clamp01(p.Charge);
            _hold[i] = 0;
        }

        Vec2 aim = StrikeAim(i);
        input.AimPoint = aim;
        Vec2 dir = (aim - p.Pos).Normalized();
        input.Move = Steer(i, p.Pos + dir * 80f, false) * 0.8f;

        if (_hold[i] > 0)
        {
            _hold[i]--;
            input.Shoot = true;
            return;
        }

        // Let go: the shot leaves on this tick.
        input.Shoot = false;
        _kickCharge[i] = 0f;
        _volley[i] = false;
    }

    // ------------------------------------------------------------------------------------
    //  Shooting
    // ------------------------------------------------------------------------------------

    private bool TryShoot(int i, ref PlayerInput input)
    {
        ref readonly var p = ref _s.Players[i];
        var level = OutfieldLevel(p.Team);
        Vec2 goal = _pitch.OpponentGoal(p.Team);
        float range = _t.Ai.ShootRange.Get(level);
        float dGoal = Vec2.Distance(p.Pos, goal);
        if (dGoal > range) return false;

        float near = _t.Ai.ShotCharge.Get(level);
        float charge = MathUtil.Lerp(near, 1f, MathUtil.Clamp01((dGoal - 140f) / MathF.Max(1f, range - 140f)));

        // Wind up only as long as the nearest opponent leaves time for: a snapshot beats being robbed.
        float close = NearestOf(1 - p.Team, p.Pos, false, out _);
        bool pressed = close < _t.Ai.PressureDistance;
        float time = MathF.Max(0f, close - 2f * _t.Player.Radius) / MathF.Max(1f, _t.Player.SprintSpeed);
        float snap = near * 0.7f;
        charge = Math.Clamp(MathF.Min(charge, time * 0.8f / MathF.Max(0.05f, _t.Kick.ChargeTime)), snap, 1f);
        Vec2 target;
        if (!BestShot(i, p.Pos, charge, out target, out float margin))
        {
            // Every lane is blocked: from close in, have a go anyway (it may deflect in).
            if (dGoal > range * 0.4f) return false;
            target = new Vec2(goal.X, (Chance() - 0.5f) * _pitch.GoalHalf);
            margin = 0f;
        }

        // A sight of goal, close enough that a shot beats anything else, or no time to look up.
        bool good = margin > -45f || dGoal < range * 0.6f || pressed || _s.Ball.OwnerTime > 1.4f;
        if (!good) return false;

        StartStrike(i, target, charge, _t.Ai.AimError.Get(level));
        ContinueStrike(i, ref input);
        return true;
    }

    /// <summary>
    /// The best spot in the goal mouth to aim at from <paramref name="from"/>: a lane no outfield
    /// opponent can block, as far out of the keeper's reach as possible. False when every lane is blocked.
    /// <paramref name="margin"/> is by how much the keeper is expected to miss it (negative: within reach).
    /// </summary>
    private bool BestShot(int i, Vec2 from, float charge, out Vec2 target, out float margin)
    {
        ref readonly var p = ref _s.Players[i];
        int opp = 1 - p.Team;
        float lineX = _pitch.GoalLineX(opp);
        float speed = ShotSpeed(charge);
        float inset = _pitch.GoalHalf - _pitch.PostRadius - _t.Ball.Radius;
        target = new Vec2(lineX, 0f);
        margin = float.MinValue;
        bool found = false;

        for (int k = 0; k < ShotLanes.Length; k++)
        {
            Vec2 t = new(lineX, ShotLanes[k] * inset);
            float lane = OutfieldLane(from, t, opp, speed);
            if (lane < -4f) continue;
            float keeper = KeeperMargin(opp, from, t, speed);
            float score = keeper + MathF.Min(lane, 40f) * 0.25f;
            if (!found || score > margin)
            {
                found = true;
                margin = score;
                target = t;
            }
        }

        return found;
    }

    /// <summary>Like <see cref="LaneMargin"/> but ignoring the goalkeeper (whose reach is judged separately).</summary>
    private float OutfieldLane(Vec2 from, Vec2 to, int team, float speed)
    {
        var players = _s.Players;
        Vec2 d = to - from;
        float len = d.Length;
        if (len < 1f) return 999f;
        Vec2 u = d / len;
        float body = _t.Player.Radius + _t.Ball.Radius;
        float best = 999f;
        for (int j = team * _size + 1; j < (team + 1) * _size; j++)
        {
            ref readonly var q = ref players[j];
            Vec2 rel = q.Pos - from;
            float along = Vec2.Dot(rel, u);
            if (along < 0f || along > len) continue;
            float perp = MathF.Abs(Vec2.Cross(u, rel));
            float t = along / MathF.Max(50f, speed);
            float reach = RunSpeed(in q, false) * MathF.Max(0f, t - Busy(in q) - 0.15f) * 0.5f;
            best = MathF.Min(best, perp - body - reach);
        }

        return best;
    }

    /// <summary>By how far the defending keeper would miss a ball struck from one point to another.</summary>
    private float KeeperMargin(int defending, Vec2 from, Vec2 to, float speed)
    {
        ref readonly var k = ref _s.Players[defending * _size];
        Vec2 d = to - from;
        float len = d.Length;
        if (len < 1f) return 0f;
        Vec2 u = d / len;
        Vec2 rel = k.Pos - from;
        float along = MathF.Max(0f, Vec2.Dot(rel, u));
        float perp = MathF.Abs(Vec2.Cross(u, rel));
        var level = KeeperLevel(defending);
        float t = MathF.Min(along, len) / MathF.Max(50f, speed);
        float move = MathF.Max(0f, t - _t.Keeper.Reaction.Get(level) - Busy(in k));
        float run = RunSpeed(in k, true) * move;
        float dive = DiveDistance(k.DiveSpeed, move) + _t.Keeper.Reach.Get(level);
        float reach = _t.Player.Radius + _t.Ball.Radius + MathF.Max(run, k.TackleCooldown > move ? 0f : dive);
        return perp - reach;
    }

    /// <summary>How far a dive carries a keeper in the given time (PlayerMotion's dive speed profile).</summary>
    private float DiveDistance(float diveSpeed, float time)
    {
        float total = _t.Keeper.DiveTime;
        if (total <= 0f) return 0f;
        float tau = MathF.Min(MathF.Max(0f, time), total);
        return diveSpeed * (tau - 0.325f * tau * tau / total);
    }

    // ------------------------------------------------------------------------------------
    //  Passing
    // ------------------------------------------------------------------------------------

    private bool TryPass(int i, bool kickoff, ref PlayerInput input)
    {
        ref readonly var p = ref _s.Players[i];
        ref readonly var b = ref _s.Ball;
        int receiver = -1;
        float score = 0f;
        if (kickoff) receiver = BestPass(i, keeper: false, out score, humansOnly: true);
        if (receiver < 0) receiver = BestPass(i, keeper: false, out score);
        if (receiver < 0) return false;

        int opp = 1 - p.Team;
        float pressure = NearestOf(opp, p.Pos, true, out _);
        bool pressed = pressure < _t.Ai.PressureDistance;
        bool held = b.OwnerTime >= _t.Ai.HoldBeforePass;
        float carry = Value(p.Pos, p.Team, pressure) + MathF.Min(SpaceAhead(i), 220f) * 0.3f;
        bool human = IsHuman(receiver);

        bool go = (human && (kickoff || held || pressed || score > carry - 120f)) ||
                  (pressed && score > carry - 40f) ||
                  (held && score > carry + 40f) ||
                  score > carry + 130f;
        if (!go) return false;

        PassTo(i, receiver, ref input);
        return true;
    }

    private void PassTo(int i, int receiver, ref PlayerInput input)
    {
        ref readonly var p = ref _s.Players[i];
        ref readonly var r = ref _s.Players[receiver];
        float error = p.IsKeeper ? 0f : Noise() * _t.Ai.AimError.Get(OutfieldLevel(p.Team));
        Vec2 to = r.Pos - p.Pos;
        Vec2 aim = p.Pos + to.Rotated(error);

        // The aim error may swing the pass to somebody else; the planned receiver is what was weighed up.
        if (PassRuleTarget(i, (aim - p.Pos).Normalized()) != receiver) aim = r.Pos;
        input.AimPoint = aim;
        input.Pass = true;
        input.Shoot = false;
        input.Move = Vec2.Zero;
        _hold[i] = 0;
        _kickCharge[i] = 0f;
    }

    /// <summary>
    /// The team-mate best worth passing to, or -1. Weighs where the receiver is (further up, near
    /// goal, in space), whether an opponent can cut the ball out on the way, and - strongly - whether
    /// a human is waiting for it. Only team-mates the simulation's pass rule would actually pick
    /// for that aim are considered.
    /// </summary>
    private int BestPass(int i, bool keeper, out float bestScore, bool humansOnly = false)
    {
        var players = _s.Players;
        ref readonly var p = ref players[i];
        int team = p.Team, opp = 1 - team;
        float maxLen = _pitch.Width * (keeper ? 0.7f : 0.55f);
        float arrive = _t.Kick.PassArriveSpeed * _cfg.Settings.BallSpeed;
        float humanBonus = keeper ? 420f : 260f;
        int best = -1;
        bestScore = float.MinValue;

        for (int j = team * _size + 1; j < (team + 1) * _size; j++)
        {
            if (j == i) continue;
            ref readonly var q = ref players[j];
            if (humansOnly && q.Controller < 0) continue;
            if (q.Action is PlayerAction.Stunned or PlayerAction.Slide or PlayerAction.Recover) continue;

            Vec2 spot = _pitch.ClampCircle(q.Pos + q.Vel * 0.3f, _t.Player.Radius);
            float len = Vec2.Distance(spot, p.Pos);
            if (len < 70f || len > maxLen) continue;

            Vec2 dir = q.Pos - p.Pos;
            if (dir.LengthSq < 1f || PassRuleTarget(i, dir.Normalized()) != j) continue;

            float speed = 0.5f * (PassSpeed(len) + arrive);
            float lane = LaneMargin(p.Pos, spot, opp, speed, 0.7f);
            if (lane < (keeper ? 14f : 6f)) continue;

            float open = NearestOf(opp, spot, true, out _);
            float score = Value(spot, team, open) + MathF.Min(lane, 80f) * 0.4f - MathF.Max(0f, len - 450f) * 0.35f;
            if (q.Controller >= 0) score += humanBonus;
            if (score > bestScore)
            {
                bestScore = score;
                best = j;
            }
        }

        return best;
    }

    /// <summary>How promising a spot is for a team on the ball: progress, a sight of goal and space.</summary>
    private float Value(Vec2 pos, int team, float open)
    {
        float ax = pos.X * PitchGeometry.AttackSign(team);
        float v = (ax + _pitch.HalfW) * 0.55f;
        float range = _t.Ai.ShootRange.Get(OutfieldLevel(team));
        float dGoal = Vec2.Distance(pos, _pitch.OpponentGoal(team));
        if (dGoal < range) v += 60f + 160f * (1f - dGoal / range);
        return v + MathF.Min(open, 180f) * 0.45f;
    }

    /// <summary>Distance to the nearest opponent in front of a carrier (roughly towards goal).</summary>
    private float SpaceAhead(int i)
    {
        var players = _s.Players;
        ref readonly var p = ref players[i];
        int opp = 1 - p.Team;
        Vec2 fwd = (_pitch.OpponentGoal(p.Team) - p.Pos).Normalized();
        float best = 999f;
        for (int j = opp * _size; j < (opp + 1) * _size; j++)
        {
            Vec2 rel = players[j].Pos - p.Pos;
            float d = rel.Length;
            if (d < 1f) return 0f;
            if (Vec2.Dot(rel, fwd) / d < 0.25f) continue;
            best = MathF.Min(best, d);
        }

        return best;
    }

    // ------------------------------------------------------------------------------------
    //  Dribbling
    // ------------------------------------------------------------------------------------

    private void Dribble(int i, ref PlayerInput input)
    {
        var players = _s.Players;
        ref readonly var p = ref players[i];
        int team = p.Team, opp = 1 - team;
        float sign = PitchGeometry.AttackSign(team);
        Vec2 goal = _pitch.OpponentGoal(team);
        Vec2 aimAt = new(goal.X, Math.Clamp(p.Pos.Y * 0.5f, -_pitch.GoalHalf * 0.5f, _pitch.GoalHalf * 0.5f));
        Vec2 dir = (aimAt - p.Pos).Normalized();
        if (dir.LengthSq < 0.5f) dir = new Vec2(sign, 0f);

        // Go round the nearest opponent in the way, keeping to one side once chosen.
        int blocker = -1;
        float blockD = 200f;
        for (int j = opp * _size; j < (opp + 1) * _size; j++)
        {
            Vec2 rel = players[j].Pos - p.Pos;
            float d = rel.Length;
            if (d >= blockD || d < 1f) continue;
            if (Vec2.Dot(rel, dir) / d < 0.2f) continue;
            blockD = d;
            blocker = j;
        }

        bool space = blocker < 0 || blockD > 150f;
        if (blocker >= 0)
        {
            Vec2 rel = players[blocker].Pos - p.Pos;
            float cross = Vec2.Cross(dir, rel) / MathF.Max(1f, blockD);
            float wanted = cross > 0f ? -1f : 1f;
            if (MathF.Abs(cross) > 0.25f) _side[i] = wanted;

            // Never turn into the touchline: pick the side with room.
            Vec2 trial = dir.Rotated(_side[i] * 1.0f);
            if (MathF.Abs(p.Pos.Y) > _pitch.HalfH - 110f && trial.Y * p.Pos.Y > 0f) _side[i] = -_side[i];

            float angle = MathUtil.Lerp(1.2f, 0.35f, MathUtil.Clamp01((blockD - 50f) / 150f));
            dir = dir.Rotated(_side[i] * angle);
        }

        // Ease off the touchlines and, beside the goal, turn in towards the mouth.
        float edge = _pitch.HalfH - 70f;
        if (MathF.Abs(p.Pos.Y) > edge && dir.Y * p.Pos.Y > 0f) dir = new Vec2(dir.X, dir.Y * 0.15f).Normalized();
        float ax = p.Pos.X * sign;
        if (ax > _pitch.HalfW - 110f && MathF.Abs(p.Pos.Y) > _pitch.GoalHalf) dir = (goal - p.Pos).Normalized();
        if (dir.LengthSq < 0.5f) dir = new Vec2(sign, 0f);

        // Shield: with an opponent at close quarters, keep the ball on the far side of the body.
        Vec2 ballDir = dir;
        float close = NearestOf(opp, p.Pos, true, out int marker);
        if (marker >= 0 && close < 95f)
        {
            Vec2 away = (p.Pos - players[marker].Pos).Normalized();
            float weight = 1.4f * (1f - MathUtil.Clamp01((close - 45f) / 50f));
            Vec2 shielded = (dir + away * weight).Normalized();
            if (shielded.LengthSq > 0.5f) ballDir = shielded;
        }

        input.Move = dir;
        input.AimPoint = p.Pos + ballDir * 120f;
        input.Sprint = _sprintPlan[i] && space && !p.Exhausted && p.Stamina > 0.3f;
    }

    /// <summary>Hard AI: a quick dash out of the way of a slide tackle coming in.</summary>
    private bool TryDodge(int i, ref PlayerInput input)
    {
        var players = _s.Players;
        ref readonly var p = ref players[i];
        float chance = _t.Ai.DodgeChance.Get(OutfieldLevel(p.Team));
        if (chance <= 0f || p.Action != PlayerAction.None || p.TackleCooldown > 0f ||
            p.Stamina < _t.Tackle.DashStaminaCost)
        {
            return false;
        }

        int opp = 1 - p.Team;
        for (int j = opp * _size; j < (opp + 1) * _size; j++)
        {
            ref readonly var q = ref players[j];
            if (q.Action != PlayerAction.Slide || q.SlideHit || _dodgeSeen[i] == j) continue;
            Vec2 rel = p.Pos - q.Pos;
            float d = rel.Length;
            if (d > 140f || d < 1f || Vec2.Dot(q.ActionDir, rel / d) < 0.6f) continue;

            _dodgeSeen[i] = j;
            if (Chance() >= chance) return false;

            // Sideways off the slide's line, towards the goal we attack where possible.
            Vec2 side = q.ActionDir.Perp;
            if (Vec2.Dot(side, rel) < 0f) side = -side;
            Vec2 fwd = new(PitchGeometry.AttackSign(p.Team), 0f);
            Vec2 dash = (side + fwd * 0.5f).Normalized();
            if (MathF.Abs(p.Pos.Y) > _pitch.HalfH - 90f && dash.Y * p.Pos.Y > 0f) dash = (-side + fwd * 0.5f).Normalized();
            input.Move = dash;
            input.AimPoint = p.Pos + dash * 120f;
            input.Tackle = true;
            return true;
        }

        return false;
    }

    /// <summary>Somewhere upfield with room to land: used to break a stalemate or clear the lines.</summary>
    private Vec2 ClearTarget(int i)
    {
        ref readonly var p = ref _s.Players[i];
        float sign = PitchGeometry.AttackSign(p.Team);
        int opp = 1 - p.Team;
        float x = Math.Clamp(p.Pos.X + sign * 520f, -_pitch.HalfW * 0.7f, _pitch.HalfW * 0.7f);
        float y = _pitch.HalfH * 0.5f;
        float up = NearestOf(opp, new Vec2(x, -y), false, out _);
        float down = NearestOf(opp, new Vec2(x, y), false, out _);
        return new Vec2(x, up > down ? -y : y);
    }
}
