namespace OfficeKickoff.Sim;

// What footballers do to each other: slide tackles, body collisions, touch-steals and the
// keeper's sanctuary.
public sealed partial class Match
{
    // Slide hits are decided for every slider first and applied afterwards, so two footballers
    // sliding into each other both go down instead of the lower index always winning.
    private readonly int[] _tackleTarget;
    private readonly bool[] _tackleClean;

    /// <summary>Whether each footballer stood inside the opponents' box before this tick's movement.</summary>
    private readonly bool[] _wasInOpponentBox;

    private bool IsKeeperInOwnBox(in PlayerState p) => p.IsKeeper && Pitch.InBox(p.Pos, p.Team);

    private void ResolveSlideTackles()
    {
        var s = State;
        var players = s.Players;
        ref var b = ref s.Ball;
        float bodies = 2f * Tuning.Player.Radius;
        float ballReach = Tuning.Player.Radius + Tuning.Ball.Radius + Tuning.Tackle.SlideReach;
        bool any = false;

        for (int i = 0; i < players.Length; i++)
        {
            _tackleTarget[i] = -1;
            _tackleClean[i] = false;
            ref readonly var slider = ref players[i];
            if (slider.Action != PlayerAction.Slide || slider.SlideHit) continue;

            int owner = b.Owner;
            if (owner >= 0 && !b.Held && players[owner].Team != slider.Team && players[owner].Immune <= 0f &&
                Vec2.DistanceSq(slider.Pos, b.Pos) < ballReach * ballReach)
            {
                _tackleTarget[i] = owner;
                _tackleClean[i] = true;
                any = true;
                continue;
            }

            int first = (1 - slider.Team) * _teamSize;
            float nearest = bodies * bodies;
            for (int j = first; j < first + _teamSize; j++)
            {
                ref readonly var o = ref players[j];
                if (o.Immune > 0f || o.Action == PlayerAction.Stunned || IsKeeperInOwnBox(in o)) continue;
                float d2 = Vec2.DistanceSq(slider.Pos, o.Pos);
                if (d2 < nearest)
                {
                    nearest = d2;
                    _tackleTarget[i] = j;
                    any = true;
                }
            }
        }

        if (!any) return;
        for (int i = 0; i < players.Length; i++)
        {
            int target = _tackleTarget[i];
            if (target < 0) continue;
            if (_tackleClean[i]) CleanTackle(i, target);
            else BodyHit(i, target);
        }
    }

    private void CleanTackle(int i, int carrier)
    {
        var s = State;
        ref var b = ref s.Ball;

        // A team-mate sliding in on the same tick may already have won it.
        if (b.Owner != carrier || b.Held) return;

        ref var slider = ref s.Players[i];
        s.Players[carrier].StealLockout = Tuning.Ball.StealLockout;
        slider.SlideHit = true;
        Count(Stat.Tackles, slider.Team, slider.Controller);
        GainBall(i, TouchKind.Control);
        Emit(GameEventType.TackleHit, i, carrier, b.Pos, flag: 1);
        TryPlayBuffered(i);
    }

    private void BodyHit(int i, int victim)
    {
        var s = State;
        var tk = Tuning.Tackle;
        ref var b = ref s.Ball;
        ref var slider = ref s.Players[i];
        ref var o = ref s.Players[victim];

        slider.SlideHit = true;

        // Two sliders reached the same opponent on the same tick: the first one floored them.
        if (o.Action == PlayerAction.Stunned) return;

        bool carried = b.Owner == victim;
        o.Action = PlayerAction.Stunned;
        o.ActionTime = carried ? tk.VictimStun : tk.BumpStun;
        o.Vel = slider.ActionDir * tk.Knockback;
        o.Charging = false;
        o.Charge = 0f;
        ClearBuffer(victim);
        Emit(GameEventType.TackleHit, i, victim, o.Pos, flag: 0);

        if (!carried) return;
        float angle = ((float)_rng.NextDouble() * 2f - 1f) * SpillSpread;
        b.Owner = -1;
        b.Held = false;
        b.Vel = slider.ActionDir.Rotated(angle) * tk.LooseBallSpeed;
        o.KickCooldown = Tuning.Kick.KickCooldown;
        Count(Stat.Tackles, slider.Team, slider.Controller);
        Touch(i, TouchKind.Deflect);
    }

    /// <summary>A footballer committed to a slide, dash or dive ploughs on; whoever is in the way gives ground.</summary>
    private static bool HoldsGround(in PlayerState p) =>
        p.Action is PlayerAction.Slide or PlayerAction.Dash or PlayerAction.Dive;

    private void ResolveCollisions()
    {
        var players = State.Players;
        float radius = Tuning.Player.Radius;
        float minDist = 2f * radius;
        bool moved = false;

        for (int pass = 0; pass < 2; pass++)
        {
            bool overlap = false;
            for (int i = 0; i < players.Length; i++)
            {
                for (int j = i + 1; j < players.Length; j++)
                {
                    ref var a = ref players[i];
                    ref var c = ref players[j];
                    Vec2 d = c.Pos - a.Pos;
                    float d2 = d.LengthSq;
                    if (d2 >= minDist * minDist) continue;

                    bool aHolds = HoldsGround(in a), cHolds = HoldsGround(in c);
                    if (a.Team != c.Team)
                    {
                        // The keeper owns its box: no opponent shoves it, whatever they are doing.
                        if (IsKeeperInOwnBox(in a))
                        {
                            aHolds = true;
                            cHolds = false;
                        }
                        else if (IsKeeperInOwnBox(in c))
                        {
                            cHolds = true;
                            aHolds = false;
                        }
                    }

                    if (aHolds && cHolds) continue;

                    float dist = MathF.Sqrt(d2);
                    Vec2 n = dist > 1e-4f ? d / dist : new Vec2(1f, 0f);
                    float push = minDist - dist;
                    if (aHolds) c.Pos += n * push;
                    else if (cHolds) a.Pos -= n * push;
                    else
                    {
                        a.Pos -= n * (push * 0.5f);
                        c.Pos += n * (push * 0.5f);
                    }

                    overlap = true;
                }
            }

            if (!overlap) break;
            moved = true;
        }

        if (!moved) return;
        for (int i = 0; i < players.Length; i++)
        {
            players[i].Pos = Pitch.ClampCircle(players[i].Pos, radius);
        }
    }

    private void ResolveTouchSteal()
    {
        var s = State;
        var players = s.Players;
        ref var b = ref s.Ball;
        int carrier = b.Owner;
        if (carrier < 0 || b.Held || b.OwnerTime < Tuning.Ball.OwnerProtectTime) return;

        ref var robbed = ref players[carrier];
        float reach = Tuning.Player.Radius + Tuning.Ball.Radius + Tuning.Ball.StealMargin;
        int thief = -1;
        float nearest = reach * reach;
        int first = (1 - robbed.Team) * _teamSize;
        for (int j = first; j < first + _teamSize; j++)
        {
            ref readonly var q = ref players[j];
            if (q.Action is not (PlayerAction.None or PlayerAction.Dash or PlayerAction.Dive)) continue;
            if (q.StealLockout > 0f) continue;

            // A dash gets you past outfield footballers, not past a keeper in its own box.
            if (robbed.Immune > 0f && !IsKeeperInOwnBox(in q)) continue;

            float d2 = Vec2.DistanceSq(q.Pos, b.Pos);
            if (d2 < nearest)
            {
                nearest = d2;
                thief = j;
            }
        }

        if (thief < 0) return;
        robbed.StealLockout = Tuning.Ball.StealLockout;
        Count(Stat.Steals, players[thief].Team, players[thief].Controller);
        GainBall(thief, TouchKind.Control);
        Emit(GameEventType.Steal, thief, carrier, b.Pos);
        TryPlayBuffered(thief);
    }

    /// <summary>While a keeper holds the ball in the hands their box is closed to opponents.</summary>
    private void ApplySanctuary(float dt)
    {
        var s = State;
        var players = s.Players;
        ref readonly var b = ref s.Ball;
        if (!b.Held || b.Owner < 0) return;

        int team = players[b.Owner].Team;
        float radius = Tuning.Player.Radius;
        float lineX = Pitch.GoalLineX(team);
        float outwards = PitchGeometry.AttackSign(team);
        float push = Tuning.Keeper.SanctuaryPush * dt;

        // The side edges only count as exits when there is pitch beyond them to stand on.
        bool sidesOpen = Pitch.BoxHalfWidth + EdgeEpsilon <= Pitch.HalfH - radius;

        int first = (1 - team) * _teamSize;
        for (int i = first; i < first + _teamSize; i++)
        {
            ref var p = ref players[i];
            if (!Pitch.InBox(p.Pos, team)) continue;

            // Whoever was already inside is ushered out; whoever tries to enter stops at the edge.
            float limit = _wasInOpponentBox[i] ? push : float.MaxValue;
            float toFront = Pitch.BoxDepth - (p.Pos.X - lineX) * outwards;
            float toSide = Pitch.BoxHalfWidth - MathF.Abs(p.Pos.Y);
            if (!sidesOpen || toFront <= toSide)
            {
                float step = MathF.Min(toFront + EdgeEpsilon, limit);
                p.Pos = new Vec2(p.Pos.X + outwards * step, p.Pos.Y);
                if (p.Vel.X * outwards < 0f) p.Vel = new Vec2(0f, p.Vel.Y);
            }
            else
            {
                float edge = p.Pos.Y < 0f ? -1f : 1f;
                float step = MathF.Min(toSide + EdgeEpsilon, limit);
                p.Pos = new Vec2(p.Pos.X, p.Pos.Y + edge * step);
                if (p.Vel.Y * edge < 0f) p.Vel = new Vec2(p.Vel.X, 0f);
            }

            p.Pos = Pitch.ClampCircle(p.Pos, radius);
        }
    }
}
