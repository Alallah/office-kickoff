namespace OfficeKickoff.Sim;

// Who controls which footballer: humans joining and leaving, manual switching, the
// "you always control the ball carrier" hand-over and the defensive auto-switch.
public sealed partial class Match
{
    /// <summary>AI outfield footballer that gained the ball this tick and is waiting for a human to take it over.</summary>
    private int _pendingCarrier = -1;

    private readonly bool[] _autoNow = new bool[2];
    private readonly float[] _autoTimer = new float[2];

    /// <summary>
    /// Registers a human (id 0..3, at most two per team) and gives them a footballer. May be called
    /// before the first step or mid-match. Returns the index of the footballer they now control, or
    /// -1 (never throws) for a bad id or team, a full team, or when no footballer is free. Calling it
    /// again for a registered human on the same team only updates the auto-switch preference and
    /// brings them back to the controls; a different team is refused.
    /// </summary>
    public int AddHuman(int humanId, int team, bool autoSwitch)
    {
        if ((uint)humanId >= (uint)State.Humans.Length || (uint)team > 1u) return -1;
        var h = State.Humans[humanId];
        if (h.Present)
        {
            if (h.Team != team) return -1;
            h.AutoSwitch = autoSwitch;
            SetHumanConnected(humanId, true);
            return h.PlayerIndex;
        }

        int onTeam = 0;
        foreach (var other in State.Humans)
        {
            if (other.Present && other.Team == team) onTeam++;
        }

        if (onTeam >= MaxHumansPerTeam || !HasFreeFootballer(team)) return -1;

        h.Present = true;
        h.Connected = true;
        h.Team = team;
        h.AutoSwitch = autoSwitch;
        h.PlayerIndex = -1;
        h.SwitchCooldown = 0f;
        _humanInputs[humanId] = default;
        Seat(h);
        return h.PlayerIndex;
    }

    /// <summary>
    /// Marks a human as present at the controls or away. Going away hands their footballer to the
    /// AI; coming back gives them a footballer again. The server calls this from input flow (a
    /// human who stops sending inputs is away), so it can happen many times per match. Does nothing
    /// for a slot that was never added with <see cref="AddHuman"/>, or when the value does not change.
    /// </summary>
    public void SetHumanConnected(int humanId, bool connected)
    {
        if ((uint)humanId >= (uint)State.Humans.Length) return;
        var h = State.Humans[humanId];
        if (!h.Present || h.Connected == connected) return;

        h.Connected = connected;
        h.SwitchCooldown = 0f;
        _humanInputs[humanId] = default;
        if (connected)
        {
            Seat(h);
        }
        else
        {
            Detach(h);

            // During a countdown the kickoff belongs to the lowest-id human still at the controls.
            if (Frozen) ReseatTeam(h.Team);
        }
    }

    public void SetHumanAutoSwitch(int humanId, bool autoSwitch)
    {
        if ((uint)humanId >= (uint)State.Humans.Length) return;
        State.Humans[humanId].AutoSwitch = autoSwitch;
    }

    /// <summary>
    /// Sets the controls a human's footballer uses on the next <see cref="Step"/>. The value is
    /// consumed by that step: held fields (Move, AimPoint, Sprint, Shoot) persist until replaced,
    /// edge fields (Pass, Tackle, SwitchBest, SwitchNext) apply to one step only. Non-finite numbers
    /// count as zero. Ignored for a human who is not present and at the controls.
    /// </summary>
    public void SetInput(int humanId, in PlayerInput input)
    {
        if ((uint)humanId >= (uint)State.Humans.Length) return;
        var h = State.Humans[humanId];
        if (!h.Present || !h.Connected) return;

        var clean = input;
        Sanitize(ref clean);
        _humanInputs[humanId] = clean;
    }

    // ------------------------------------------------------------------------------------
    //  Seating
    // ------------------------------------------------------------------------------------

    private bool HasFreeFootballer(int team)
    {
        var players = State.Players;
        for (int i = team * _teamSize; i < (team + 1) * _teamSize; i++)
        {
            if (!players[i].IsKeeper && players[i].Controller == -1) return true;
        }

        return false;
    }

    private void Seat(HumanSlot h)
    {
        if (Frozen) ReseatTeam(h.Team);
        else SeatNearestBall(h);
    }

    /// <summary>Mid-match: the free AI outfield footballer nearest the ball.</summary>
    private void SeatNearestBall(HumanSlot h)
    {
        var players = State.Players;
        Vec2 ball = State.Ball.Pos;
        int best = -1;
        float bestD2 = float.MaxValue;
        for (int i = h.Team * _teamSize; i < (h.Team + 1) * _teamSize; i++)
        {
            if (players[i].IsKeeper || players[i].Controller != -1) continue;
            float d2 = Vec2.DistanceSq(players[i].Pos, ball);
            if (d2 < bestD2)
            {
                bestD2 = d2;
                best = i;
            }
        }

        if (best >= 0) SetControl(h, best);
    }

    /// <summary>
    /// Countdowns: the team's humans at the controls, in ascending id order, take its footballers in
    /// kickoff priority order.
    /// </summary>
    private void ReseatTeam(int team)
    {
        var humans = State.Humans;
        var order = _priority[team];
        Span<int> ids = stackalloc int[humans.Length];
        Span<int> previous = stackalloc int[humans.Length];
        int n = 0;
        for (int id = 0; id < humans.Length && n < order.Length; id++)
        {
            var h = humans[id];
            if (h.Present && h.Connected && h.Team == team) ids[n++] = id;
        }

        // Everyone who moves lets go first, so two humans can swap seats cleanly.
        for (int k = 0; k < n; k++)
        {
            var h = humans[ids[k]];
            previous[k] = h.PlayerIndex;
            if (previous[k] != order[k]) Detach(h);
        }

        for (int k = 0; k < n; k++)
        {
            if (previous[k] != order[k]) Attach(humans[ids[k]], order[k], previous[k]);
        }
    }

    /// <summary>
    /// Invariant: a human at the controls always has a footballer. Whatever path left one without
    /// (a seat taken at the moment they arrived, a hand-over that found nobody free), they are
    /// seated again on the next tick instead of watching for the rest of the match.
    /// </summary>
    private void SeatStragglers()
    {
        foreach (var h in State.Humans)
        {
            if (h.Present && h.Connected && h.PlayerIndex < 0) Seat(h);
        }
    }

    /// <summary>Gives a human control of a footballer, releasing the one they had.</summary>
    private void SetControl(HumanSlot h, int index)
    {
        int old = h.PlayerIndex;
        if (old == index) return;
        Detach(h);
        Attach(h, index, old);
    }

    private void Detach(HumanSlot h)
    {
        int index = h.PlayerIndex;
        if (index < 0) return;
        h.PlayerIndex = -1;

        ref var p = ref State.Players[index];
        p.Controller = -1;
        p.SpeedFactor = AiSpeedFactor(index);
        p.Charging = false;
        p.Charge = 0f;
        ClearBuffer(index);

        // The human's last controls must not keep steering a footballer that is now the AI's.
        _inputs[index] = new PlayerInput { AimPoint = p.Pos + Vec2.FromAngle(p.Aim) * 100f };
        SyncCarrierHuman(index);
    }

    private void Attach(HumanSlot h, int index, int old)
    {
        ref var p = ref State.Players[index];
        h.PlayerIndex = index;
        p.Controller = h.Id;
        p.SpeedFactor = 1f;

        // Whatever the AI was winding up, had queued or pressed earlier this tick is not this
        // human's decision: it must not come out of the footballer once they are at the controls.
        p.Charging = false;
        p.Charge = 0f;
        ClearBuffer(index);
        _released[index] = false;
        _inputs[index].Pass = false;
        SyncCarrierHuman(index);
        Emit(GameEventType.Switch, index, old, p.Pos, flag: h.Id);
    }

    /// <summary>
    /// A carried ball is a touch in progress: whoever is at the carrier's controls owns that touch,
    /// so a goal walked over the line is credited to them.
    /// </summary>
    private void SyncCarrierHuman(int index)
    {
        ref var b = ref State.Ball;
        if (b.Owner == index && b.LastTouch == index) b.LastTouchHuman = State.Players[index].Controller;
    }

    // ------------------------------------------------------------------------------------
    //  Switching
    // ------------------------------------------------------------------------------------

    private void TickSwitchCooldowns(float dt)
    {
        foreach (var h in State.Humans)
        {
            if (h.SwitchCooldown > 0f) h.SwitchCooldown = MathF.Max(0f, h.SwitchCooldown - dt);
        }
    }

    /// <summary>
    /// Manual switch requests. Handled before the tick's inputs are handed out so the footballer
    /// just taken over is steered by the human at once and the one let go by the AI.
    /// </summary>
    private void ApplyManualSwitches()
    {
        var humans = State.Humans;
        for (int id = 0; id < humans.Length; id++)
        {
            var h = humans[id];
            if (!h.Present || !h.Connected || h.PlayerIndex < 0) continue;
            ref readonly var input = ref _humanInputs[id];
            if (!input.SwitchBest && !input.SwitchNext) continue;
            if (State.Ball.Owner == h.PlayerIndex) continue;

            int target = input.SwitchBest ? BestSwitchTarget(h) : NextSwitchTarget(h);
            if (target < 0) continue;
            SetControl(h, target);
            h.SwitchCooldown = Tuning.Switch.ManualHold;
        }
    }

    private int BestSwitchTarget(HumanSlot h)
    {
        var players = State.Players;
        ref readonly var b = ref State.Ball;
        int best = -1;
        float bestD2 = float.MaxValue;
        for (int i = h.Team * _teamSize; i < (h.Team + 1) * _teamSize; i++)
        {
            if (players[i].IsKeeper || players[i].Controller != -1) continue;
            if (b.Owner == i) return i;
            float d2 = Vec2.DistanceSq(players[i].Pos, b.Pos);
            if (d2 < bestD2)
            {
                bestD2 = d2;
                best = i;
            }
        }

        return best;
    }

    private int NextSwitchTarget(HumanSlot h)
    {
        var players = State.Players;
        int first = h.Team * _teamSize;
        int slot = players[h.PlayerIndex].Slot;
        for (int step = 1; step < _teamSize; step++)
        {
            // The following slots, wrapping around past the last one; a goalkeeper is skipped.
            int next = first + (slot + step) % _teamSize;
            if (!players[next].IsKeeper && players[next].Controller == -1) return next;
        }

        return -1;
    }

    /// <summary>You always control the ball carrier: an AI outfield footballer that gains the ball is handed to the nearest human.</summary>
    private void HandOverCarrier()
    {
        int carrier = _pendingCarrier;
        _pendingCarrier = -1;
        if (carrier < 0 || State.Ball.Owner != carrier) return;

        var players = State.Players;
        ref readonly var p = ref players[carrier];
        if (p.IsKeeper || p.Controller != -1) return;

        HumanSlot? best = null;
        float bestD2 = float.MaxValue;
        foreach (var h in State.Humans)
        {
            if (!h.Present || !h.Connected || h.Team != p.Team || h.PlayerIndex < 0) continue;
            float d2 = Vec2.DistanceSq(players[h.PlayerIndex].Pos, p.Pos);
            if (d2 < bestD2)
            {
                bestD2 = d2;
                best = h;
            }
        }

        if (best is null) return;
        SetControl(best, carrier);
        best.SwitchCooldown = Tuning.Switch.MinGap;
    }

    private void RunAutoSwitch(float dt)
    {
        for (int team = 0; team < 2; team++)
        {
            _autoTimer[team] -= dt;
            bool due = _autoNow[team] || _autoTimer[team] <= 0f;
            _autoNow[team] = false;
            if (!due) continue;
            _autoTimer[team] = Tuning.Switch.AutoInterval;
            EvaluateAutoSwitch(team);
        }
    }

    /// <summary>Defensive auto-switch: hands the best-placed AI defender to a human who is out of the play.</summary>
    private void EvaluateAutoSwitch(int team)
    {
        var s = State;
        var players = s.Players;
        ref readonly var b = ref s.Ball;
        if (s.Phase != MatchPhase.Playing || b.Dead) return;

        // Only while defending. Never during the team's own pass or shot.
        int holder = b.Owner >= 0 ? b.Owner : b.LastTouch;
        if (holder < 0 || players[holder].Team == team) return;

        int candidate = -1;
        float candidateD2 = float.MaxValue;
        for (int i = team * _teamSize; i < (team + 1) * _teamSize; i++)
        {
            ref readonly var p = ref players[i];
            if (p.IsKeeper || p.Controller != -1 || p.Action != PlayerAction.None) continue;
            float d2 = Vec2.DistanceSq(p.Pos, b.Pos);
            if (d2 < candidateD2)
            {
                candidateD2 = d2;
                candidate = i;
            }
        }

        if (candidate < 0) return;
        float range = Tuning.Switch.AutoRange;
        if (candidateD2 > range * range) return;

        foreach (var h in s.Humans)
        {
            if (!h.Present || !h.Connected || h.Team != team || h.PlayerIndex < 0) continue;
            ref readonly var own = ref players[h.PlayerIndex];
            if (own.Action != PlayerAction.Stunned && Vec2.DistanceSq(own.Pos, b.Pos) <= candidateD2) return;
        }

        float ratio = Tuning.Switch.AutoRatio;
        float farD2 = ratio > 0f ? candidateD2 / (ratio * ratio) : float.MaxValue;
        HumanSlot? best = null;
        float bestD2 = float.MaxValue;
        foreach (var h in s.Humans)
        {
            if (!h.Present || !h.Connected || h.Team != team || h.PlayerIndex < 0) continue;
            if (!h.AutoSwitch || h.SwitchCooldown > 0f) continue;
            ref readonly var own = ref players[h.PlayerIndex];
            if (own.Action != PlayerAction.Stunned && Vec2.DistanceSq(own.Pos, b.Pos) <= farD2) continue;
            float d2 = Vec2.DistanceSq(own.Pos, players[candidate].Pos);
            if (d2 < bestD2)
            {
                bestD2 = d2;
                best = h;
            }
        }

        if (best is null) return;
        SetControl(best, candidate);
        best.SwitchCooldown = Tuning.Switch.MinGap;
    }
}
