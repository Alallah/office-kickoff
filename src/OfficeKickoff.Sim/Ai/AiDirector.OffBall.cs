namespace OfficeKickoff.Sim.Ai;

// Outfield footballers without the ball: chase, receive, press, cover, mark, hold the shape,
// support the attack - and the walk back after a goal.
public sealed partial class AiDirector
{
    private void ThinkOutfield(int i, bool plan, ref PlayerInput input)
    {
        ref readonly var p = ref _s.Players[i];
        ref readonly var b = ref _s.Ball;
        input.AimPoint = b.Pos;

        // Committed or floored: nothing to steer. Any strike that was being wound up is gone.
        if (p.Action is PlayerAction.Slide or PlayerAction.Stunned or PlayerAction.Recover or PlayerAction.Dive)
        {
            _hold[i] = 0;
            _volley[i] = false;
            _kickCharge[i] = 0f;
            _hadBall[i] = false;
            return;
        }

        if (b.Owner == i)
        {
            ThinkCarrier(i, plan, ref input);
            return;
        }

        _hadBall[i] = false;
        if (_hold[i] > 0 && !_volley[i])
        {
            // The ball went before the shot did: let the button go (it may still meet the ball first-time).
            _hold[i] = 0;
        }

        Role want = _wantRole[i];
        if (plan || want == Role.Receive)
        {
            if (_role[i] != want || _roleArg[i] != _wantArg[i]) _tackleRolled[i] = false;
            if (plan)
            {
                var level = OutfieldLevel(p.Team);
                _sprintPlan[i] = Chance() < _t.Ai.SprintUse.Get(level);
                _jitter[i] = Noise();
                // For a presser this is "go in for the ball now" rather than "make a run".
                _runPlan[i] = Chance() < (want == Role.Press ? _t.Ai.PressCommit.Get(level) : 0.65f);
                if (want is Role.Chase or Role.Receive && !_volley[i]) ArmVolley(i, want);
            }

            _role[i] = want;
            _roleArg[i] = _wantArg[i];
        }

        switch (_role[i])
        {
            case Role.Chase:
            case Role.Receive:
                Chase(i, ref input);
                break;
            case Role.Press:
                Press(i, ref input);
                break;
            case Role.Cover:
                Cover(i, ref input);
                break;
            case Role.Mark:
                Mark(i, ref input);
                break;
            case Role.Support:
                Support(i, ref input);
                break;
            default:
                Zone(i, ref input);
                break;
        }

        // A strike that was let go is played as the ball arrives: keep aiming where it was meant to go.
        if (_now < _strikeUntil[i]) input.AimPoint = StrikeAim(i);
        if (!_volley[i] && _hold[i] == 0)
        {
            _kickCharge[i] = 0f;
            if (p.Charging) input.Shoot = false;
        }
    }

    // ------------------------------------------------------------------------------------
    //  Loose ball
    // ------------------------------------------------------------------------------------

    /// <summary>
    /// Decides, as a footballer sets off after a loose ball or a pass, whether to strike it first
    /// time: always when the ball has to be cleared, sometimes when it is arriving near goal.
    /// </summary>
    private void ArmVolley(int i, Role role)
    {
        ref readonly var p = ref _s.Players[i];
        var level = OutfieldLevel(p.Team);
        if (_clearing)
        {
            _volley[i] = true;
            _kickAim[i] = ClearTarget(i);
            _kickErr[i] = Noise() * _t.Ai.AimError.Get(level);
            _kickCharge[i] = 0.6f;
            return;
        }

        Vec2 meet = _etaPoint[i];
        float range = _t.Ai.ShootRange.Get(level) * 0.7f;
        if (Vec2.Distance(meet, _pitch.OpponentGoal(p.Team)) > range) return;
        float chance = _t.Ai.FinishChance.Get(level) * (role == Role.Receive ? 1.3f : 1f);
        if (Chance() >= chance) return;
        if (!BestShot(i, meet, 0.8f, out Vec2 target, out float margin) || margin < -40f) return;

        _volley[i] = true;
        _kickAim[i] = target;
        _kickErr[i] = Noise() * _t.Ai.AimError.Get(level);
        _kickCharge[i] = 0.8f;
    }

    private void Chase(int i, ref PlayerInput input)
    {
        ref readonly var p = ref _s.Players[i];
        ref readonly var b = ref _s.Ball;
        Vec2 target = _etaPoint[i];
        float dBall = Vec2.Distance(p.Pos, b.Pos);
        if (dBall < 90f) target = b.Pos + b.Vel * 0.05f;
        if (b.Owner >= 0) target = b.Pos;

        // Contested: run flat out. Otherwise sprint as the footballer's habits say.
        int opp = 1 - p.Team;
        float theirs = float.MaxValue;
        for (int j = opp * _size; j < (opp + 1) * _size; j++) theirs = MathF.Min(theirs, _eta[j]);
        bool contest = theirs < _eta[i] + 0.35f;

        input.Move = Steer(i, OnPitch(target), false, 12f);
        input.Sprint = (_sprintPlan[i] || contest) && dBall > 45f;
        input.AimPoint = b.Pos;

        if (_volley[i]) Volley(i, ref input);
    }

    /// <summary>Holding the shoot button as the ball arrives and letting go as it comes into reach.</summary>
    private void Volley(int i, ref PlayerInput input)
    {
        ref readonly var p = ref _s.Players[i];
        ref readonly var b = ref _s.Ball;
        if (b.Owner >= 0 && b.Owner != i)
        {
            _volley[i] = false;
            _kickCharge[i] = 0f;
            return;
        }

        float reach = _t.Player.Radius + _t.Ball.Radius + _t.Kick.KickReach;
        float d = Vec2.Distance(p.Pos, b.Pos);
        input.AimPoint = StrikeAim(i);

        if (!p.Charging)
        {
            if (_eta[i] <= 0.4f) input.Shoot = true;
            return;
        }

        bool inReach = d <= reach - 2f;
        bool enough = p.Charge >= _kickCharge[i];
        if (inReach || (enough && d <= reach + 40f) || p.Charge >= 0.98f)
        {
            // Let go. If the ball is not quite there the kick is remembered for a moment and
            // played as it arrives, so keep aiming at the target until then.
            input.Shoot = false;
            _volley[i] = false;
            _kickCharge[i] = 0f;
            _strikeUntil[i] = _now + _t.Kick.BufferTime + 0.05f;
            return;
        }

        input.Shoot = true;
    }

    // ------------------------------------------------------------------------------------
    //  Defending
    // ------------------------------------------------------------------------------------

    private void Press(int i, ref PlayerInput input)
    {
        var players = _s.Players;
        ref readonly var p = ref players[i];
        ref readonly var b = ref _s.Ball;
        int owner = b.Owner;
        if (owner < 0)
        {
            Chase(i, ref input);
            return;
        }

        if (players[owner].Team == p.Team)
        {
            Support(i, ref input);
            return;
        }

        ref readonly var c = ref players[owner];
        var level = OutfieldLevel(p.Team);
        Vec2 ownGoal = _pitch.OwnGoal(p.Team);
        float dCarrier = Vec2.Distance(p.Pos, c.Pos);
        float range = _t.Ai.PressRange.Get(level);
        input.AimPoint = b.Pos;

        if (b.Held)
        {
            Zone(i, ref input);
            return;
        }

        if (dCarrier > range && Vec2.Distance(c.Pos, ownGoal) > range + 260f)
        {
            // Out of range: shadow goal side and let the carrier come.
            Vec2 shadow = c.Pos + (ownGoal - c.Pos).Normalized() * 130f;
            input.Move = Steer(i, OnPitch(shadow), true);
            _tackleRolled[i] = false;
            return;
        }

        // Close down, coming at the ball rather than through the carrier's back. Until the presser
        // commits it stands off goal side and blocks the way, which gives a good dribbler a chance.
        Vec2 ballDir = (b.Pos - c.Pos).Normalized();
        Vec2 rel = p.Pos - c.Pos;
        Vec2 target;
        bool commit = _runPlan[i] || c.Vel.Length < 80f || Vec2.Distance(c.Pos, ownGoal) < 320f;
        if (!commit)
        {
            // Stand off a little way: close enough to block, far enough that a carrier can go round.
            Vec2 goalSide = c.Pos + (ownGoal - c.Pos).Normalized() * 100f;
            input.Move = Steer(i, OnPitch(goalSide), false, 20f);
            input.Sprint = _sprintPlan[i] && Vec2.Distance(p.Pos, goalSide) > 120f;
            TrySlide(i, owner, ref input);
            return;
        }

        if (Vec2.Dot(rel, ballDir) < 0f && rel.Length < 110f)
        {
            float side = Vec2.Cross(ballDir, rel) >= 0f ? 1f : -1f;
            target = c.Pos + ballDir * 40f + ballDir.Perp * (side * 46f);
        }
        else
        {
            target = b.Pos + c.Vel * 0.1f + ballDir * 6f;
        }

        input.Move = Steer(i, OnPitch(target), false, 10f);
        input.Sprint = _sprintPlan[i] || Vec2.Distance(c.Pos, ownGoal) < range + 120f;
        TrySlide(i, owner, ref input);
    }

    /// <summary>
    /// A slide when the carrier is within slide range and roughly in front: rolled once per
    /// opportunity against Ai.TackleChance. Never at a keeper in their box, a dashing carrier or a held ball.
    /// </summary>
    private void TrySlide(int i, int carrier, ref PlayerInput input)
    {
        var players = _s.Players;
        ref readonly var p = ref players[i];
        ref readonly var c = ref players[carrier];
        ref readonly var b = ref _s.Ball;
        var tk = _t.Tackle;
        float trigger = tk.SlideSpeed * tk.SlideTime * 0.42f;
        float d = Vec2.Distance(p.Pos, b.Pos);
        if (d > trigger + 50f)
        {
            _tackleRolled[i] = false;
            return;
        }

        if (_tackleRolled[i] || d > trigger || p.Action != PlayerAction.None || p.TackleCooldown > 0f) return;
        if (b.Held || c.Immune > 0f || (c.IsKeeper && _pitch.InBox(c.Pos, c.Team))) return;

        Vec2 lead = b.Pos + c.Vel * (d / MathF.Max(1f, tk.SlideSpeed));
        Vec2 dir = (lead - p.Pos).Normalized();
        Vec2 facing = p.Vel.LengthSq > 400f ? p.Vel.Normalized() : Vec2.FromAngle(p.Aim);
        if (Vec2.Dot(dir, facing) < 0.85f) return;

        _tackleRolled[i] = true;
        if (Chance() >= _t.Ai.TackleChance.Get(OutfieldLevel(p.Team))) return;
        input.Tackle = true;
        input.Move = dir;
        input.Sprint = false;
    }

    private void Cover(int i, ref PlayerInput input)
    {
        ref readonly var p = ref _s.Players[i];
        ref readonly var b = ref _s.Ball;
        int owner = b.Owner;
        if (owner < 0 || _s.Players[owner].Team == p.Team)
        {
            Zone(i, ref input);
            return;
        }

        ref readonly var c = ref _s.Players[owner];
        Vec2 ownGoal = _pitch.OwnGoal(p.Team);
        Vec2 spot = c.Pos + (ownGoal - c.Pos).Normalized() * 150f;
        if (b.Held) spot = OutOfBox(spot, c.Team);
        input.Move = Steer(i, OnPitch(spot), true);
        input.AimPoint = b.Pos;
    }

    private void Mark(int i, ref PlayerInput input)
    {
        var players = _s.Players;
        ref readonly var p = ref players[i];
        ref readonly var b = ref _s.Ball;
        int j = _roleArg[i];
        if (j < 0 || j >= _n || players[j].Team == p.Team)
        {
            Zone(i, ref input);
            return;
        }

        ref readonly var o = ref players[j];
        Vec2 goal = _pitch.OwnGoal(p.Team);
        Vec2 op = o.Pos + o.Vel * 0.15f;

        // Tighter and more goal side the closer the ball gets to our goal.
        float danger = 1f - MathUtil.Clamp01((Vec2.Distance(b.Pos, goal) - 200f) / (_pitch.Width * 0.6f));
        float md = _t.Ai.MarkDistance * (1f - 0.25f * danger);
        Vec2 goalSide = op + (goal - op).Normalized() * md;
        Vec2 ballSide = op + (b.Pos - op).Normalized() * md;
        Vec2 spot = Vec2.Lerp(goalSide, ballSide, 0.25f * (1f - danger));
        if (b.Held && b.Owner >= 0 && players[b.Owner].Team != p.Team) spot = OutOfBox(spot, players[b.Owner].Team);

        input.Move = Steer(i, OnPitch(spot), true);
        input.Sprint = _sprintPlan[i] && Vec2.Distance(p.Pos, spot) > 140f;
        input.AimPoint = b.Pos;
    }

    /// <summary>Defensive shape: the formation position, pulled towards the ball and kept goal side of it.</summary>
    private void Zone(int i, ref PlayerInput input)
    {
        var players = _s.Players;
        ref readonly var p = ref players[i];
        ref readonly var b = ref _s.Ball;
        float sign = PitchGeometry.AttackSign(p.Team);
        float homeAx = p.HomePos.X * sign;
        float ballAx = b.Pos.X * sign;
        bool front = p.Spot.Row == p.Spot.RowCount - 1 && p.Spot.RowCount > 1;

        float ax = MathUtil.Lerp(homeAx, ballAx - 150f, 0.4f);
        if (front) ax = MathF.Max(ax, -_pitch.HalfW * 0.25f);
        else ax = MathF.Min(ax, ballAx - 70f);
        ax = Math.Clamp(ax, -_pitch.HalfW + 90f, _pitch.HalfW - 90f);
        float y = p.Spot.Lateral * _pitch.HalfH * 0.6f + b.Pos.Y * 0.35f;

        Vec2 spot = new(ax * sign, y);
        if (b.Held && b.Owner >= 0 && players[b.Owner].Team != p.Team) spot = OutOfBox(spot, players[b.Owner].Team);
        input.Move = Steer(i, OnPitch(spot), true);
        input.Sprint = _sprintPlan[i] && Vec2.Distance(p.Pos, spot) > 220f;
        input.AimPoint = b.Pos;
    }

    // ------------------------------------------------------------------------------------
    //  Attacking support
    // ------------------------------------------------------------------------------------

    /// <summary>
    /// Our ball: the formation position pushed up with the play, the front row running at the box,
    /// nobody crowding the carrier, and a step out of any marker's shadow so the pass is on.
    /// </summary>
    private void Support(int i, ref PlayerInput input)
    {
        var players = _s.Players;
        ref readonly var p = ref players[i];
        ref readonly var b = ref _s.Ball;
        int team = p.Team, opp = 1 - team;
        float sign = PitchGeometry.AttackSign(team);
        Vec2 hub = b.Owner >= 0 ? players[b.Owner].Pos : b.Pos;
        float hubAx = hub.X * sign;
        float homeAx = p.HomePos.X * sign;
        bool front = p.Spot.Row == p.Spot.RowCount - 1;

        float ax = homeAx + _pitch.HalfW * 0.5f + hubAx * 0.35f;
        if (front && _runPlan[i]) ax = MathF.Max(ax, _pitch.HalfW - _pitch.BoxDepth - 30f + 50f * _jitter[i]);
        ax = Math.Clamp(ax, hubAx - 380f, hubAx + 430f);
        ax = Math.Clamp(ax, -_pitch.HalfW + 110f, _pitch.HalfW - 60f);
        float y = p.Spot.Lateral * _pitch.HalfH * 0.75f + hub.Y * 0.25f + _jitter[i] * 45f;
        y = Math.Clamp(y, -_pitch.HalfH + 50f, _pitch.HalfH - 50f);
        Vec2 spot = new(ax * sign, y);

        // Do not crowd the carrier.
        float room = 170f;
        Vec2 off = spot - hub;
        float offLen = off.Length;
        if (offLen < room)
        {
            Vec2 dir = offLen > 1f ? off / offLen : new Vec2(0f, p.Pos.Y >= hub.Y ? 1f : -1f);
            spot = hub + dir * room;
        }

        // Step out of the shadow of whoever stands in the passing lane.
        Vec2 lane = spot - hub;
        float len = lane.Length;
        if (len > 1f)
        {
            Vec2 u = lane / len;
            float worst = 60f;
            float shift = 0f;
            for (int j = opp * _size; j < (opp + 1) * _size; j++)
            {
                Vec2 rel = players[j].Pos - hub;
                float along = Vec2.Dot(rel, u);
                if (along < 30f || along > len + 10f) continue;
                float cross = Vec2.Cross(u, rel);
                float perp = MathF.Abs(cross);
                if (perp >= worst) continue;
                worst = perp;
                shift = (cross > 0f ? -1f : 1f) * (60f - perp + 30f);
            }

            if (shift != 0f) spot += u.Perp * shift;
        }

        if (b.Held && b.Owner >= 0 && players[b.Owner].Team != team) spot = OutOfBox(spot, players[b.Owner].Team);
        spot = OnPitch(spot);
        input.Move = Steer(i, spot, true);
        input.Sprint = _sprintPlan[i] && Vec2.Distance(p.Pos, spot) > 180f;
        input.AimPoint = b.Pos;
    }

    // ------------------------------------------------------------------------------------
    //  After a goal
    // ------------------------------------------------------------------------------------

    /// <summary>The scorers jog over to celebrate with the goalscorer; everyone else walks back.</summary>
    private void AfterGoal(int i, ref PlayerInput input)
    {
        var players = _s.Players;
        ref readonly var p = ref players[i];
        ref readonly var b = ref _s.Ball;
        int conceded = b.Pos.X < 0f ? 0 : 1;
        int scoring = 1 - conceded;
        input.AimPoint = b.Pos;
        _hold[i] = 0;
        _volley[i] = false;
        _kickCharge[i] = 0f;

        if (p.Team != scoring || p.IsKeeper)
        {
            input.Move = Steer(i, p.HomePos, true, 60f) * 0.45f;
            return;
        }

        int scorer = -1;
        if (b.LastTouch >= 0 && players[b.LastTouch].Team == scoring) scorer = b.LastTouch;
        else if (b.PrevTouch >= 0 && players[b.PrevTouch].Team == scoring) scorer = b.PrevTouch;

        if (scorer < 0)
        {
            input.Move = Steer(i, p.HomePos, true, 60f) * 0.45f;
            return;
        }

        if (scorer == i)
        {
            // Off towards the corner flag.
            float sign = PitchGeometry.AttackSign(p.Team);
            float sy = p.Pos.Y < 0f ? -1f : 1f;
            Vec2 corner = new(sign * (_pitch.HalfW - 160f), sy * (_pitch.HalfH - 140f));
            input.Move = Steer(i, corner, true, 80f) * 0.8f;
            input.AimPoint = corner;
            return;
        }

        Vec2 hero = players[scorer].Pos;
        Vec2 toward = p.Pos - hero;
        Vec2 spot = hero + (toward.LengthSq > 1f ? toward.Normalized() : Vec2.FromAngle(i)) * 60f;
        input.Move = Steer(i, OnPitch(spot), true, 50f) * 0.7f;
        input.AimPoint = hero;
    }
}
