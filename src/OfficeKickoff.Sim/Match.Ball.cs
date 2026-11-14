namespace OfficeKickoff.Sim;

// The ball: touches, the carried ball, free-ball physics, contact with footballers and goals.
public sealed partial class Match
{
    // Whether the strike behind the last / previous touch was already counted in the shot stats.
    private bool _lastCountedShot;
    private bool _lastCountedOnTarget;
    private bool _prevCountedShot;
    private bool _prevCountedOnTarget;

    /// <summary>Human who controlled the passer when the pass in flight was played (-1 = AI).</summary>
    private int _passHuman = -1;

    private bool _netHit;

    /// <summary>Keeper whose parry the ball is still leaving: it is not touched again until it is out of reach.</summary>
    private int _parriedBy = -1;

    // ------------------------------------------------------------------------------------
    //  Touches
    // ------------------------------------------------------------------------------------

    private void Touch(int i, TouchKind kind)
    {
        var s = State;
        ref var b = ref s.Ball;
        ref readonly var p = ref s.Players[i];

        if (b.PassFrom >= 0 && b.PassFrom != i && s.Players[b.PassFrom].Team == p.Team)
        {
            Count(Stat.PassesCompleted, p.Team, _passHuman);
        }

        b.PassTarget = -1;
        b.PassFrom = -1;
        b.OnTargetGoal = -1;
        _passHuman = -1;
        _parriedBy = -1;

        if (b.LastTouch != i)
        {
            b.PrevTouch = b.LastTouch;
            b.PrevTouchHuman = b.LastTouchHuman;
            b.PrevTouchTime = b.LastTouchTime;
            _prevCountedShot = _lastCountedShot;
            _prevCountedOnTarget = _lastCountedOnTarget;
        }

        b.LastTouch = i;
        b.LastTouchHuman = p.Controller;
        b.LastTouchTime = s.Time;
        b.LastTouchKind = kind;
        _lastCountedShot = false;
        _lastCountedOnTarget = false;
    }

    private void GainBall(int i, TouchKind kind)
    {
        var s = State;
        ref var b = ref s.Ball;
        ref readonly var p = ref s.Players[i];

        // A team-mate's pass or shot is a back-pass: the keeper may not pick it up.
        bool backPass = b.LastTouch >= 0 && b.LastTouch != i && b.LastTouchKind == TouchKind.Strike &&
            s.Players[b.LastTouch].Team == p.Team;

        Touch(i, kind);
        Vec2 toBall = b.Pos - p.Pos;
        b.Owner = i;
        b.OwnerTime = 0f;
        b.DribbleAngle = toBall.LengthSq > 1e-6f ? toBall.Angle : p.Aim;
        b.Spin = 0f;
        b.Heat = 0f;
        b.Held = p.IsKeeper && !backPass && Pitch.InBox(p.Pos, p.Team);
        PlaceCarriedBall();

        _autoNow[1 - p.Team] = true;
        _pendingCarrier = s.Phase == MatchPhase.Playing && !p.IsKeeper && p.Controller == -1 ? i : -1;
    }

    // ------------------------------------------------------------------------------------
    //  Carried ball
    // ------------------------------------------------------------------------------------

    /// <summary>Puts a carried ball back at its owner's feet after the footballers have moved.</summary>
    private void SyncCarriedBall()
    {
        if (State.Ball.Owner >= 0) PlaceCarriedBall();
    }

    private void PlaceCarriedBall()
    {
        ref var b = ref State.Ball;
        ref readonly var o = ref State.Players[b.Owner];
        var bt = Tuning.Ball;
        float r = bt.Radius;
        float reach = Tuning.Player.Radius + r + bt.DribbleGap + (o.Sprinting ? bt.SprintDribbleGap : 0f);
        Vec2 wanted = o.Pos + Vec2.FromAngle(b.DribbleAngle) * reach;

        // The ball stays on the pitch except in front of the goal its carrier attacks, where it may
        // be walked over the line. A dash cannot carry it over, and nobody carries it into their own goal.
        bool mayCross = o.Action != PlayerAction.Dash &&
            MathF.Abs(wanted.Y) < Pitch.GoalHalf - r &&
            wanted.X * PitchGeometry.AttackSign(o.Team) > Pitch.HalfW - r;
        Vec2 pos = mayCross ? wanted : Pitch.ClampCircle(wanted, r);

        float clear = Pitch.PostRadius + r;
        var posts = Pitch.Posts;
        for (int k = 0; k < posts.Length; k++)
        {
            Vec2 d = pos - posts[k];
            float d2 = d.LengthSq;
            if (d2 >= clear * clear) continue;
            Vec2 n = d2 > 1e-6f ? d / MathF.Sqrt(d2) : new Vec2(-MathF.Sign(posts[k].X), 0f);
            pos = posts[k] + n * clear;
        }

        b.Pos = pos;
        b.Vel = o.Vel;
    }

    private void StepCarried(float dt)
    {
        var s = State;
        ref var b = ref s.Ball;
        ref readonly var o = ref s.Players[b.Owner];
        b.OwnerTime += dt;

        if (o.Action == PlayerAction.Stunned)
        {
            b.Owner = -1;
            b.Held = false;
            b.Vel = o.Vel;
            return;
        }

        if (b.Held && !(o.IsKeeper && Pitch.InBox(o.Pos, o.Team))) b.Held = false;
        b.DribbleAngle = MathUtil.MoveAngleTowards(b.DribbleAngle, o.Aim, Tuning.Ball.DribbleTurnRate * dt);
        PlaceCarriedBall();

        if (s.Phase != MatchPhase.Playing) return;
        float beyond = Pitch.HalfW + Tuning.Ball.Radius * 0.5f;
        if (b.Pos.X * PitchGeometry.AttackSign(o.Team) > beyond && MathF.Abs(b.Pos.Y) < Pitch.GoalHalf)
        {
            ScoreGoal(1 - o.Team);
        }
    }

    // ------------------------------------------------------------------------------------
    //  Free ball
    // ------------------------------------------------------------------------------------

    private void StepBall(float dt)
    {
        ref var b = ref State.Ball;
        if (b.Owner >= 0)
        {
            StepCarried(dt);
            if (b.Owner >= 0) return;
        }

        // Equal sub-steps, sized so the ball never moves more than its radius at a time. The count is
        // re-derived after every sub-step because a kick or a deflection can speed the ball up.
        float radius = MathF.Max(1f, Tuning.Ball.Radius);
        float remaining = dt;
        for (int guard = 0; guard < MaxSubSteps && remaining > 1e-7f; guard++)
        {
            float travel = b.Vel.Length * remaining;
            int n = travel > radius ? (int)MathF.Ceiling(travel / radius) : 1;
            float h = remaining / n;
            remaining -= h;

            if (b.Dead)
            {
                StepDeadBall(h);
            }
            else
            {
                StepFreeBall(h);
                if (b.Owner >= 0) break;
            }
        }

        if (!b.Pos.IsFinite || !b.Vel.IsFinite)
        {
            b.Pos = Pitch.ClampCircle(b.Pos.IsFinite ? b.Pos : Vec2.Zero, Tuning.Ball.Radius);
            b.Vel = Vec2.Zero;
            b.Spin = 0f;
        }
    }

    private void DecayBallVelocity(float h)
    {
        ref var b = ref State.Ball;
        var bt = Tuning.Ball;
        float speed = b.Vel.Length;
        if (speed > 0f)
        {
            if (b.Spin != 0f)
            {
                b.Vel = b.Vel.Rotated(b.Spin * bt.CurveRate * h);
                b.Spin *= MathF.Exp(-bt.SpinDecay * h);
                if (MathF.Abs(b.Spin) < 1e-4f) b.Spin = 0f;
            }

            float next = speed * MathF.Exp(-bt.Drag * h) - bt.RollFriction * h;
            if (next < bt.StopSpeed)
            {
                b.Vel = Vec2.Zero;
                b.Spin = 0f;
            }
            else
            {
                b.Vel *= MathF.Min(next, bt.MaxSpeed) / speed;
            }
        }

        b.Heat = MathF.Max(0f, b.Heat - bt.HeatDecay * h);
    }

    private void StepFreeBall(float h)
    {
        var s = State;
        ref var b = ref s.Ball;
        DecayBallVelocity(h);
        b.Pos += b.Vel * h;
        CollideBallWithPitch();

        // Goal before contact: nobody "saves" a ball that is already over the line.
        if (s.Phase == MatchPhase.Playing &&
            MathF.Abs(b.Pos.X) > Pitch.HalfW + Tuning.Ball.Radius * 0.5f && MathF.Abs(b.Pos.Y) < Pitch.GoalHalf)
        {
            ScoreGoal(b.Pos.X < 0f ? 0 : 1);
            return;
        }

        if (ContactFootballers()) CollideBallWithPitch();
    }

    /// <summary>From a goal until the next kickoff the ball only rattles around inside that goal's net.</summary>
    private void StepDeadBall(float h)
    {
        ref var b = ref State.Ball;
        var pt = Tuning.Pitch;
        DecayBallVelocity(h);
        b.Pos += b.Vel * h;

        float r = Tuning.Ball.Radius;
        float side = _conceded == 0 ? -1f : 1f;
        float front = Pitch.HalfW + r * 0.5f;
        float back = MathF.Max(front, Pitch.HalfW + Pitch.GoalDepth - r);
        float wide = MathF.Max(0f, Pitch.GoalHalf - r);
        float depth = b.Pos.X * side;
        float y = b.Pos.Y;
        float speed = b.Vel.Length;
        bool net = false;

        if (depth > back)
        {
            depth = back;
            net = true;
            BounceBall(new Vec2(side, 0f), pt.NetBounce, pt.WallFriction, out _);
        }
        else if (depth < front)
        {
            depth = front;
            BounceBall(new Vec2(-side, 0f), pt.NetBounce, pt.WallFriction, out _);
        }

        if (MathF.Abs(y) > wide)
        {
            float edge = y > 0f ? 1f : -1f;
            y = edge * wide;
            net = true;
            BounceBall(new Vec2(0f, edge), pt.NetBounce, pt.WallFriction, out _);
        }

        b.Pos = new Vec2(depth * side, y);
        if (net && !_netHit)
        {
            _netHit = true;
            Emit(GameEventType.NetHit, pos: b.Pos, value: Ratio(speed, Tuning.Kick.ShotMaxSpeed));
        }
    }

    /// <summary>
    /// Reflects the ball off a surface whose outward normal is given. True when the ball was moving
    /// into it; <paramref name="impact"/> is the speed along the normal.
    /// </summary>
    private bool BounceBall(Vec2 outward, float normalKeep, float tangentKeep, out float impact)
    {
        ref var b = ref State.Ball;
        impact = Vec2.Dot(b.Vel, outward);
        if (impact <= 0f) return false;
        Vec2 tangent = b.Vel - outward * impact;
        b.Vel = tangent * tangentKeep - outward * (impact * normalKeep);
        return true;
    }

    private void WallBounce(Vec2 outward)
    {
        ref var b = ref State.Ball;
        float speed = b.Vel.Length;
        if (!BounceBall(outward, Tuning.Pitch.WallBounce, Tuning.Pitch.WallFriction, out float impact)) return;
        b.OnTargetGoal = -1;
        if (impact > BounceEventSpeed)
        {
            Emit(GameEventType.WallBounce, pos: b.Pos, value: Ratio(speed, Tuning.Kick.ShotMaxSpeed));
        }
    }

    /// <summary>Walls, rounded corners, the nets behind the goal lines and the four posts.</summary>
    private void CollideBallWithPitch()
    {
        ref var b = ref State.Ball;
        var pitch = Pitch;
        float r = Tuning.Ball.Radius;
        float x = b.Pos.X, y = b.Pos.Y;
        float ax = MathF.Abs(x), ay = MathF.Abs(y);
        float sx = x < 0f ? -1f : 1f, sy = y < 0f ? -1f : 1f;

        if (ax > pitch.HalfW)
        {
            // Behind a goal line (only reachable through the mouth): the net keeps the ball in.
            float back = MathF.Max(pitch.HalfW, pitch.HalfW + pitch.GoalDepth - r);
            float wide = MathF.Max(0f, pitch.GoalHalf - r);
            if (ay > wide)
            {
                b.Pos = new Vec2(b.Pos.X, sy * wide);
                BounceBall(new Vec2(0f, sy), Tuning.Pitch.NetBounce, Tuning.Pitch.WallFriction, out _);
            }

            if (ax > back)
            {
                b.Pos = new Vec2(sx * back, b.Pos.Y);
                BounceBall(new Vec2(sx, 0f), Tuning.Pitch.NetBounce, Tuning.Pitch.WallFriction, out _);
            }
        }
        else
        {
            float cx = pitch.HalfW - pitch.CornerRadius, cy = pitch.HalfH - pitch.CornerRadius;
            if (ax > cx && ay > cy)
            {
                // Rounded corner: bounce off the arc, along its normal.
                float dx = ax - cx, dy = ay - cy;
                float limit = MathF.Max(0f, pitch.CornerRadius - r);
                float d2 = dx * dx + dy * dy;
                if (d2 > limit * limit)
                {
                    float d = MathF.Sqrt(d2);
                    float nx = dx / d, ny = dy / d;
                    b.Pos = new Vec2(sx * (cx + nx * limit), sy * (cy + ny * limit));
                    WallBounce(new Vec2(sx * nx, sy * ny));
                }
            }
            else
            {
                if (ay > pitch.HalfH - r)
                {
                    b.Pos = new Vec2(b.Pos.X, sy * (pitch.HalfH - r));
                    WallBounce(new Vec2(0f, sy));
                }

                // The end walls stop at the goal mouth.
                if (ax > pitch.HalfW - r && ay >= pitch.GoalHalf)
                {
                    b.Pos = new Vec2(sx * (pitch.HalfW - r), b.Pos.Y);
                    WallBounce(new Vec2(sx, 0f));
                }
            }
        }

        float clear = pitch.PostRadius + r;
        var posts = pitch.Posts;
        for (int k = 0; k < posts.Length; k++)
        {
            Vec2 d = b.Pos - posts[k];
            float d2 = d.LengthSq;
            if (d2 >= clear * clear) continue;

            Vec2 n = d2 > 1e-6f ? d / MathF.Sqrt(d2) : new Vec2(-MathF.Sign(posts[k].X), 0f);
            b.Pos = posts[k] + n * clear;
            float speed = b.Vel.Length;
            float into = -Vec2.Dot(b.Vel, n);
            if (into <= 0f) continue;

            b.Vel += n * ((1f + Tuning.Pitch.WallBounce) * into);
            b.OnTargetGoal = -1;
            if (into > BounceEventSpeed)
            {
                Emit(GameEventType.PostHit, pos: b.Pos, value: Ratio(speed, Tuning.Kick.ShotMaxSpeed));
            }
        }
    }

    // ------------------------------------------------------------------------------------
    //  Contact with footballers
    // ------------------------------------------------------------------------------------

    private float ContactReach(in PlayerState p)
    {
        float reach = Tuning.Player.Radius + Tuning.Ball.Radius;
        if (p.Action == PlayerAction.Slide) reach += Tuning.Tackle.SlideReach;
        else if (p.Action == PlayerAction.Dive && p.IsKeeper) reach += Tuning.Keeper.Reach.Get(Config.KeeperLevel(p.Team));
        return reach;
    }

    /// <summary>One sub-step of free ball against footballers. True when somebody played or touched it.</summary>
    private bool ContactFootballers()
    {
        var s = State;
        var players = s.Players;
        ref var b = ref s.Ball;
        bool playing = s.Phase == MatchPhase.Playing;

        // A remembered kick is played the moment the ball comes within kicking reach.
        if (playing && _bufferCount > 0)
        {
            int kicker = -1;
            float kickerD2 = float.MaxValue;
            for (int i = 0; i < players.Length; i++)
            {
                if (_bufferKind[i] == KickNone || !CanKickLooseBall(i)) continue;
                float d2 = Vec2.DistanceSq(players[i].Pos, b.Pos);
                if (d2 < kickerD2)
                {
                    kickerD2 = d2;
                    kicker = i;
                }
            }

            if (kicker >= 0 && TryPlayBuffered(kicker)) return true;
        }

        if (_parriedBy >= 0)
        {
            float reach = ContactReach(in players[_parriedBy]);
            if (Vec2.DistanceSq(players[_parriedBy].Pos, b.Pos) >= reach * reach) _parriedBy = -1;
        }

        // The footballer the ball is deepest into gets the touch.
        int hit = -1;
        float deepest = 0f;
        for (int i = 0; i < players.Length; i++)
        {
            ref readonly var p = ref players[i];
            if (i == _parriedBy) continue;

            // Their own kick: they cannot touch it again until the cooldown ends or someone else does.
            if (p.KickCooldown > 0f && b.LastTouch == i) continue;

            float reach = ContactReach(in p);
            float d2 = Vec2.DistanceSq(p.Pos, b.Pos);
            if (d2 >= reach * reach) continue;
            float depth = reach - MathF.Sqrt(d2);
            if (depth > deepest)
            {
                deepest = depth;
                hit = i;
            }
        }

        return hit >= 0 && HandleContact(hit);
    }

    private bool HandleContact(int i)
    {
        var s = State;
        ref var b = ref s.Ball;
        ref var p = ref s.Players[i];

        if (TryPlayBuffered(i)) return true;

        Vec2 offset = b.Pos - p.Pos;
        float dist = offset.Length;
        Vec2 n = dist > 1e-4f ? offset / dist
            : b.Vel.LengthSq > 1e-6f ? -b.Vel.Normalized()
            : Vec2.FromAngle(p.Aim);
        Vec2 relative = b.Vel - p.Vel;
        float rel = relative.Length;
        float closing = -Vec2.Dot(relative, n);

        float scale = MathF.Max(1f, Config.Settings.BallSpeed);
        float control = Tuning.Ball.ControlSpeed * scale;

        if (p.IsKeeper && p.Action != PlayerAction.Stunned && Pitch.InBox(p.Pos, p.Team))
        {
            bool backPass = b.LastTouch >= 0 && b.LastTouch != i && b.LastTouchKind == TouchKind.Strike &&
                s.Players[b.LastTouch].Team == p.Team;
            if (backPass)
            {
                if (rel <= control)
                {
                    Trap(i, rel);
                    return true;
                }

                return Deflect(i, n, relative, closing, dist);
            }

            float speed = b.Vel.Length;
            if (speed <= Tuning.Keeper.CatchSpeed.Get(Config.KeeperLevel(p.Team)) * scale)
            {
                bool save = b.OnTargetGoal == p.Team;
                GainBall(i, TouchKind.Catch);
                if (save) Count(Stat.Saves, p.Team, p.Controller);
                Emit(GameEventType.KeeperCatch, i, pos: b.Pos, value: Ratio(speed, Tuning.Kick.ShotMaxSpeed));
                return true;
            }

            Parry(i, n, relative, closing, dist, speed);
            return true;
        }

        if (p.Action == PlayerAction.Stunned) return Deflect(i, n, relative, closing, dist);

        if (p.Action == PlayerAction.Slide || rel <= control)
        {
            Trap(i, rel);
            return true;
        }

        return Deflect(i, n, relative, closing, dist);
    }

    private void Trap(int i, float rel)
    {
        ref var p = ref State.Players[i];
        GainBall(i, TouchKind.Control);
        if (p.Action == PlayerAction.Slide)
        {
            p.SlideHit = true;
            Emit(GameEventType.TackleHit, i, pos: State.Ball.Pos, flag: 1);
        }
        else
        {
            Emit(GameEventType.Trap, i, pos: State.Ball.Pos, value: Ratio(rel, Tuning.Ball.ControlSpeed));
        }
    }

    /// <summary>Bounces the ball off a footballer. A ball that is already moving away is only pushed clear, not touched.</summary>
    private bool Deflect(int i, Vec2 n, Vec2 relative, float closing, float dist)
    {
        ref var b = ref State.Ball;
        ref readonly var p = ref State.Players[i];
        float body = Tuning.Player.Radius + Tuning.Ball.Radius;
        bool moved = dist < body;
        if (moved) b.Pos = p.Pos + n * body;
        if (closing <= 0f) return moved;

        float speed = b.Vel.Length;
        bool save = b.OnTargetGoal == p.Team;
        Vec2 bounced = relative + n * ((1f + Tuning.Ball.PlayerBounce) * closing);
        b.Vel = (p.Vel + bounced).ClampLength(Tuning.Ball.MaxSpeed);

        Touch(i, TouchKind.Deflect);
        float value = Ratio(speed, Tuning.Kick.ShotMaxSpeed);
        Emit(GameEventType.Deflect, i, pos: b.Pos, value: value);
        if (save)
        {
            Count(Stat.Saves, p.Team, p.Controller);
            if (!p.IsKeeper) Emit(GameEventType.Block, i, pos: b.Pos, value: value);
        }

        return true;
    }

    private void Parry(int i, Vec2 n, Vec2 relative, float closing, float dist, float speed)
    {
        ref var b = ref State.Ball;
        ref readonly var p = ref State.Players[i];
        float body = Tuning.Player.Radius + Tuning.Ball.Radius;
        if (dist < body) b.Pos = p.Pos + n * body;

        bool save = b.OnTargetGoal == p.Team;
        Vec2 bounced = closing > 0f ? relative + n * ((1f + Tuning.Keeper.ParryBounce) * closing) : relative;
        Vec2 v = (p.Vel + bounced).ClampLength(Tuning.Ball.MaxSpeed);

        // Whatever the geometry, a parried ball comes back out: it never trickles on towards the line.
        float away = PitchGeometry.AttackSign(p.Team);
        float pace = v.Length;
        float outward = MathF.Max(MathF.Abs(v.X), pace * ParryMinOutward);
        float across = MathF.Sqrt(MathF.Max(0f, pace * pace - outward * outward));
        b.Vel = new Vec2(away * outward, v.Y < 0f ? -across : across);

        Touch(i, TouchKind.Deflect);
        _parriedBy = i;
        if (save) Count(Stat.Saves, p.Team, p.Controller);
        Emit(GameEventType.KeeperParry, i, pos: b.Pos, value: Ratio(speed, Tuning.Kick.ShotMaxSpeed));
    }

    // ------------------------------------------------------------------------------------
    //  Goals
    // ------------------------------------------------------------------------------------

    private void ScoreGoal(int defending)
    {
        var s = State;
        var players = s.Players;
        var rules = Tuning.Rules;
        ref var b = ref s.Ball;
        int scoring = 1 - defending;

        int scorer = b.LastTouch;
        int scorerHuman = b.LastTouchHuman;
        bool countedShot = _lastCountedShot, countedOnTarget = _lastCountedOnTarget;
        bool viaDefender = false;

        // In off a defender or the keeper's fingertips: still the striker's goal.
        if (scorer >= 0 && players[scorer].Team == defending &&
            (b.LastTouchKind is TouchKind.Deflect or TouchKind.Catch) &&
            b.PrevTouch >= 0 && players[b.PrevTouch].Team == scoring &&
            s.Time - b.PrevTouchTime <= rules.DeflectionWindow)
        {
            scorer = b.PrevTouch;
            scorerHuman = b.PrevTouchHuman;
            countedShot = _prevCountedShot;
            countedOnTarget = _prevCountedOnTarget;
            viaDefender = true;
        }

        bool ownGoal = scorer >= 0 && players[scorer].Team == defending;
        int assist = -1, assistHuman = -1;
        if (scorer < 0)
        {
            scorerHuman = -1;
        }
        else if (ownGoal)
        {
            Count(Stat.OwnGoals, defending, scorerHuman);
        }
        else
        {
            Count(Stat.Goals, scoring, scorerHuman);
            if (!viaDefender && b.PrevTouch >= 0 && b.PrevTouch != scorer && players[b.PrevTouch].Team == scoring &&
                s.Time - b.PrevTouchTime <= rules.AssistWindow)
            {
                assist = b.PrevTouch;
                assistHuman = b.PrevTouchHuman;
                Count(Stat.Assists, scoring, assistHuman);
            }

            // A goal is always a shot on target, however the ball got there.
            if (!countedOnTarget)
            {
                if (!countedShot) Count(Stat.Shots, scoring, scorerHuman);
                Count(Stat.ShotsOnTarget, scoring, scorerHuman);
            }
        }

        s.Score[scoring]++;
        Stats.Goals.Add(new GoalRecord
        {
            Time = s.Elapsed,
            Team = scoring,
            Scorer = scorer,
            ScorerHuman = scorerHuman,
            Assist = assist,
            AssistHuman = assistHuman,
            OwnGoal = ownGoal,
        });

        bool decides = s.Overtime ||
            (!Config.Practice && Config.Settings.ScoreLimit > 0 && s.Score[scoring] >= Config.Settings.ScoreLimit);
        if (decides) s.Winner = scoring;

        b.Owner = -1;
        b.Held = false;
        b.Dead = true;
        b.PassTarget = -1;
        b.PassFrom = -1;
        b.OnTargetGoal = -1;
        _passHuman = -1;
        _parriedBy = -1;
        _pendingCarrier = -1;
        _conceded = defending;
        _netHit = false;
        _goalTicks = 0;
        ClearAllBuffers();

        Emit(GameEventType.Goal, scorer, assist, b.Pos, Ratio(b.Vel.Length, Tuning.Kick.ShotMaxSpeed),
            GoalFlags.Pack(scoring, ownGoal, decides, scorerHuman, assistHuman));

        EnterPhase(MatchPhase.GoalScored,
            Config.Settings.Celebrations ? rules.GoalCelebrationTime : rules.GoalShortTime);
        s.SlowMo = true;
    }
}
