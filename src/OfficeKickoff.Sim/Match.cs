using OfficeKickoff.Sim.Ai;

namespace OfficeKickoff.Sim;

/// <summary>
/// One football match: the authoritative simulation. Not thread-safe - the owner (the room)
/// serialises all calls.
///
/// Typical use:
/// <code>
///   var match = new Match(config, tuning);
///   match.AddHuman(0, team: 0, autoSwitch: true);
///   every 1/60 s:  match.SetInput(0, input);  match.Step();  read match.State / match.Events
/// </code>
///
/// The implementation is split over partial files: this one holds the set-up, the phase machine
/// and the tick order; Match.Control.cs who controls which footballer; Match.Kicks.cs shots and
/// passes; Match.Ball.cs the ball; Match.Contest.cs everything footballers do to each other.
/// </summary>
public sealed partial class Match
{
    // Numbers the rules state literally. Everything tunable lives in Tuning.
    private const int MaxHumansPerTeam = 2;
    private const float BounceEventSpeed = 60f;
    private const float OnTargetMinSpeed = 50f;
    private const float ShotRangeFactor = 0.6f;
    private const float PassHeat = 0.15f;
    private const float SpinAtZeroCharge = 0.35f;
    private const float SpillSpread = 0.5f;
    private const float KickOffset = 1f;

    /// <summary>A parried ball leaves with at least this share of its speed pointing away from the goal line.</summary>
    private const float ParryMinOutward = 0.25f;

    private const float EdgeEpsilon = 0.01f;
    private const float AimLimit = 100000f;
    private const int MaxSubSteps = 64;

    private readonly List<GameEvent> _events = new(64);

    /// <summary>Events raised between steps (AddHuman, SetHumanConnected); delivered with the next step.</summary>
    private readonly List<GameEvent> _carried = new(8);

    private readonly IAiDirector _ai;
    private readonly Random _rng;
    private readonly AiContext _ctx;
    private readonly int _teamSize;
    private readonly int _count;

    /// <summary>Controls of every footballer for the current tick.</summary>
    private readonly PlayerInput[] _inputs;

    /// <summary>Latest controls of every human, as set by <see cref="SetInput"/>.</summary>
    private readonly PlayerInput[] _humanInputs = new PlayerInput[4];

    /// <summary>Outfield footballers of each team in kickoff priority order.</summary>
    private readonly int[][] _priority = new int[2][];

    private readonly bool[] _released;
    private readonly float[] _releasedCharge;

    // The phase machine counts whole ticks so that phases last exactly as long on every machine.
    private int _phaseTicks;
    private int _goalTicks;
    private int _clockTicks;
    private int _elapsedTicks;
    private readonly int[] _possessionTicks = new int[2];
    private int _conceded;
    private bool _inStep;

    /// <param name="config">Settings must already be normalized.</param>
    /// <param name="tuning">Gameplay numbers.</param>
    /// <param name="ai">AI for uncontrolled footballers; defaults to <see cref="AiDirector"/>.</param>
    /// <param name="seed">Seed for the match's random source (0 = time-based).</param>
    public Match(MatchConfig config, Tuning tuning, IAiDirector? ai = null, int seed = 0)
    {
        ArgumentNullException.ThrowIfNull(config);
        ArgumentNullException.ThrowIfNull(tuning);

        Config = config;
        Tuning = tuning;
        _ai = ai ?? new AiDirector();
        _rng = seed == 0 ? new Random() : new Random(seed);

        int size = Math.Clamp(config.Settings.TeamSize, MatchSettings.MinTeamSize, MatchSettings.MaxTeamSize);
        _teamSize = size;
        _count = 2 * size;
        Pitch = new PitchGeometry(size, tuning, config.Settings.Keepers);
        State = new MatchState
        {
            TeamSize = size,
            KickoffTeam = config.KickoffTeam == 1 ? 1 : 0,
            Players = new PlayerState[_count],
        };
        Stats = new MatchStats();

        _inputs = new PlayerInput[_count];
        _released = new bool[_count];
        _releasedCharge = new float[_count];
        _bufferKind = new byte[_count];
        _bufferTime = new float[_count];
        _bufferCharge = new float[_count];
        _tackleTarget = new int[_count];
        _tackleClean = new bool[_count];
        _wasInOpponentBox = new bool[_count];

        for (int team = 0; team < 2; team++) SetUpTeam(team);

        _clockTicks = config.Practice ? 0 : config.Settings.Minutes * 60 * Tuning.TickRate;
        State.Clock = _clockTicks * Tuning.TickSeconds;

        _ctx = new AiContext { State = State, Pitch = Pitch, Tuning = tuning, Config = config, Rng = _rng };

        ApplyKickoffLayout();
        State.Phase = config.Practice ? MatchPhase.Kickoff : MatchPhase.Intro;
        _phaseTicks = PhaseTicks(config.Practice ? tuning.Rules.RestartCountdown : tuning.Rules.IntroTime);
        State.PhaseTime = _phaseTicks * Tuning.TickSeconds;
    }

    public MatchConfig Config { get; }
    public Tuning Tuning { get; }
    public PitchGeometry Pitch { get; }

    /// <summary>Live state. Read-only for callers.</summary>
    public MatchState State { get; }

    public MatchStats Stats { get; }

    /// <summary>
    /// Events emitted by the most recent <see cref="Step"/>, in order. Cleared at the start of each
    /// step. Control changes made between two steps (<see cref="AddHuman"/>,
    /// <see cref="SetHumanConnected"/>) are reported at the head of the following step's events.
    /// </summary>
    public IReadOnlyList<GameEvent> Events => _events;

    /// <summary>True once the match reached <see cref="MatchPhase.Ended"/>.</summary>
    public bool IsOver => State.Phase == MatchPhase.Ended;

    private bool Frozen => State.Phase is MatchPhase.Intro or MatchPhase.Kickoff;

    /// <summary>Advances the match by exactly one tick (1/60 s of real time).</summary>
    public void Step()
    {
        _events.Clear();
        if (State.Phase == MatchPhase.Ended)
        {
            _carried.Clear();
            return;
        }

        if (_carried.Count > 0)
        {
            _events.AddRange(_carried);
            _carried.Clear();
        }

        _inStep = true;
        try
        {
            Advance();
        }
        finally
        {
            _inStep = false;
            ConsumeEdges();
        }
    }

    private void Advance()
    {
        var s = State;
        s.Tick++;
        RunPhaseTimer();
        if (s.Phase is MatchPhase.Replay or MatchPhase.Ended) return;

        float dt = Tuning.TickSeconds * Config.Settings.GameSpeed * (s.SlowMo ? Tuning.Rules.GoalSlowMoScale : 1f);
        if (!float.IsFinite(dt) || dt < 1e-5f) dt = 1e-5f;
        s.Time += dt;

        bool frozen = Frozen;
        SeatStragglers();
        if (s.Phase == MatchPhase.Playing) ApplyManualSwitches();
        GatherInputs(dt);
        MovePlayers(dt, frozen);

        // Countdowns: footballers may only aim, and the ball does not move.
        if (frozen) return;

        TickSwitchCooldowns(dt);
        if (s.Phase == MatchPhase.Playing) PlayKicks(dt);

        SyncCarriedBall();
        ResolveSlideTackles();
        ResolveCollisions();
        StepBall(dt);

        if (s.Phase == MatchPhase.Playing) ResolveTouchSteal();
        ApplySanctuary(dt);
        if (s.Phase == MatchPhase.Playing)
        {
            HandOverCarrier();
            RunAutoSwitch(dt);
        }

        if (s.Phase == MatchPhase.Playing) TickClock();
    }

    // ------------------------------------------------------------------------------------
    //  Set-up
    // ------------------------------------------------------------------------------------

    private void SetUpTeam(int team)
    {
        var players = State.Players;
        int size = _teamSize;
        string? wanted = Config.Formations is { } names && team < names.Length ? names[team] : null;
        string formation = Formations.Resolve(wanted, size);
        bool keepers = Config.Settings.Keepers;
        var spots = Formations.Spots(formation, size);
        var homes = Formations.HomePositions(formation, size, team, Pitch, Tuning, keepers);
        var keeperLevel = Config.KeeperLevel(team);

        for (int slot = 0; slot < size; slot++)
        {
            int index = team * size + slot;
            ref var p = ref players[index];
            p.Index = index;
            p.Team = team;
            p.Slot = slot;

            // Without goalkeepers slot 0 is an ordinary outfield footballer: the sweeper.
            p.IsKeeper = keepers && slot == 0;
            p.Spot = slot == 0
                ? keepers ? default : Formations.SweeperSpot(formation, size)
                : slot - 1 < spots.Length ? spots[slot - 1] : default;
            p.HomePos = homes[slot];
            p.Pos = p.HomePos;
            p.Aim = FacingOf(team);
            p.Stamina = 1f;
            p.Controller = -1;
            p.SpeedFactor = AiSpeedFactor(index);
            if (p.IsKeeper)
            {
                p.DiveSpeed = Tuning.Keeper.DiveSpeed.Get(keeperLevel);
                p.DiveCooldown = Tuning.Keeper.DiveCooldown.Get(keeperLevel);
            }
        }

        // Kickoff priority over the outfield footballers: most advanced first, then most central,
        // then lowest slot. A sweeper (slot 0 without goalkeepers) always comes last.
        var order = new List<int>(size);
        for (int slot = 0; slot < size; slot++)
        {
            int index = team * size + slot;
            if (players[index].IsKeeper) continue;
            int at = order.Count;
            order.Add(index);
            while (at > 0 && KicksOffBefore(index, order[at - 1]))
            {
                order[at] = order[at - 1];
                at--;
            }

            order[at] = index;
        }

        _priority[team] = order.ToArray();
    }

    private bool KicksOffBefore(int a, int b)
    {
        ref readonly var pa = ref State.Players[a];
        ref readonly var pb = ref State.Players[b];
        if ((pa.Slot == 0) != (pb.Slot == 0)) return pb.Slot == 0;
        if (pa.Spot.Depth != pb.Spot.Depth) return pa.Spot.Depth > pb.Spot.Depth;
        float la = MathF.Abs(pa.Spot.Lateral), lb = MathF.Abs(pb.Spot.Lateral);
        if (la != lb) return la < lb;
        return pa.Slot < pb.Slot;
    }

    private static float FacingOf(int team) => team == 0 ? 0f : MathF.PI;

    /// <summary>Speed factor of a footballer while the AI controls it.</summary>
    private float AiSpeedFactor(int index)
    {
        ref readonly var p = ref State.Players[index];
        return p.IsKeeper
            ? Tuning.Keeper.SpeedFactor.Get(Config.KeeperLevel(p.Team))
            : Tuning.Ai.SpeedFactor.Get(Config.OutfieldLevel(p.Team));
    }

    /// <summary>Match start, after every goal, start of golden goal.</summary>
    private void ApplyKickoffLayout()
    {
        var s = State;
        var players = s.Players;
        float radius = Tuning.Player.Radius;

        for (int i = 0; i < players.Length; i++)
        {
            ref var p = ref players[i];
            p.Pos = p.HomePos;
            p.Vel = Vec2.Zero;
            p.Aim = FacingOf(p.Team);
            p.Action = PlayerAction.None;
            p.ActionTime = 0f;
            p.ActionDir = Vec2.Zero;
            p.SlideHit = false;
            p.Stamina = 1f;
            p.Exhausted = false;
            p.RegenDelay = 0f;
            p.Sprinting = false;
            p.Charging = false;
            p.Charge = 0f;
            p.TackleCooldown = 0f;
            p.KickCooldown = 0f;
            p.StealLockout = 0f;
            p.Immune = 0f;
            _released[i] = false;
            _wasInOpponentBox[i] = false;
        }

        ClearAllBuffers();

        int kickoffTeam = s.KickoffTeam;
        int taker = _priority[kickoffTeam][0];
        float attack = PitchGeometry.AttackSign(kickoffTeam);
        float reach = radius + Tuning.Ball.Radius + Tuning.Ball.DribbleGap;
        players[taker].Pos = new Vec2(-attack * reach, 0f);

        // The other team waits outside the centre circle.
        int other = 1 - kickoffTeam;
        float keepOut = Pitch.CenterRadius + radius;
        float ownSide = -PitchGeometry.AttackSign(other);
        for (int i = other * _teamSize; i < (other + 1) * _teamSize; i++)
        {
            ref var p = ref players[i];
            if (p.Pos.LengthSq >= keepOut * keepOut) continue;
            float x = MathF.Sqrt(MathF.Max(0f, keepOut * keepOut - p.Pos.Y * p.Pos.Y)) + 0.5f;
            p.Pos = Pitch.ClampCircle(new Vec2(ownSide * x, p.Pos.Y), radius);
        }

        ref var b = ref s.Ball;
        b.Pos = Vec2.Zero;
        b.Vel = Vec2.Zero;
        b.Spin = 0f;
        b.Owner = taker;
        b.OwnerTime = 0f;
        b.DribbleAngle = players[taker].Aim;
        b.Held = false;
        b.Heat = 0f;
        b.Dead = false;
        b.LastTouch = taker;
        b.LastTouchKind = TouchKind.Control;
        b.LastTouchTime = s.Time;
        b.PrevTouch = -1;
        b.PrevTouchHuman = -1;
        b.PrevTouchTime = 0d;
        b.PassTarget = -1;
        b.PassFrom = -1;
        b.OnTargetGoal = -1;

        _lastCountedShot = _lastCountedOnTarget = false;
        _prevCountedShot = _prevCountedOnTarget = false;
        _passHuman = -1;
        _netHit = false;
        _parriedBy = -1;
        _pendingCarrier = -1;
        for (int team = 0; team < 2; team++)
        {
            _autoNow[team] = false;
            _autoTimer[team] = Tuning.Switch.AutoInterval;
        }

        foreach (var h in s.Humans) h.SwitchCooldown = 0f;
        ReseatTeam(0);
        ReseatTeam(1);
        b.LastTouchHuman = players[taker].Controller;

        _ai.Reset(_ctx);
    }

    // ------------------------------------------------------------------------------------
    //  Phases
    // ------------------------------------------------------------------------------------

    private static int PhaseTicks(float seconds) =>
        seconds > 0f && float.IsFinite(seconds) ? Math.Max(1, (int)MathF.Round(seconds * Tuning.TickRate)) : 0;

    private void EnterPhase(MatchPhase next, float seconds)
    {
        var s = State;
        var previous = s.Phase;
        s.Phase = next;
        _phaseTicks = PhaseTicks(seconds);
        s.PhaseTime = _phaseTicks * Tuning.TickSeconds;
        if (next != MatchPhase.GoalScored) s.SlowMo = false;
        Emit(GameEventType.PhaseChange, value: (float)previous, flag: (int)next);
    }

    /// <summary>Counts the current phase down; true when it has run out.</summary>
    private bool PhaseExpired()
    {
        // The tick counter is only a drift-free way of counting: a phase time set from outside
        // (tests, tuning runs) is honoured rather than silently overwritten.
        int shown = PhaseTicks(State.PhaseTime);
        if (shown != Math.Max(0, _phaseTicks)) _phaseTicks = shown;

        _phaseTicks--;
        State.PhaseTime = Math.Max(0, _phaseTicks) * Tuning.TickSeconds;
        return _phaseTicks <= 0;
    }

    private void RunPhaseTimer()
    {
        var s = State;
        var rules = Tuning.Rules;
        switch (s.Phase)
        {
            case MatchPhase.Intro:
                if (PhaseExpired()) EnterPhase(MatchPhase.Kickoff, rules.KickoffCountdown);
                break;

            case MatchPhase.Kickoff:
                if (PhaseExpired()) EnterPhase(MatchPhase.Playing, 0f);
                break;

            case MatchPhase.GoalScored:
                _goalTicks++;
                if (PhaseExpired())
                {
                    s.SlowMo = false;
                    if (Config.Settings.Replays) EnterPhase(MatchPhase.Replay, rules.ReplayTime);
                    else AfterGoal();
                }
                else
                {
                    s.SlowMo = _goalTicks <= PhaseTicks(rules.GoalSlowMoTime);
                }

                break;

            case MatchPhase.Replay:
                if (PhaseExpired()) AfterGoal();
                break;

            case MatchPhase.FullTime:
                if (PhaseExpired()) EnterPhase(MatchPhase.Ended, 0f);
                break;
        }
    }

    private void AfterGoal()
    {
        var s = State;
        if (s.Winner >= 0)
        {
            EnterPhase(MatchPhase.FullTime, Tuning.Rules.FullTimeHold);
            return;
        }

        s.KickoffTeam = _conceded;
        ApplyKickoffLayout();
        EnterPhase(MatchPhase.Kickoff, Tuning.Rules.RestartCountdown);
    }

    /// <summary>Possession, the clock and the end of regulation. Runs on Playing ticks only.</summary>
    private void TickClock()
    {
        var s = State;
        ref readonly var b = ref s.Ball;
        int holder = b.Owner >= 0 ? b.Owner : b.LastTouch;
        if (holder >= 0)
        {
            int team = s.Players[holder].Team;
            _possessionTicks[team]++;
            Stats.Teams[team].PossessionTime = _possessionTicks[team] * Tuning.TickSeconds;
        }

        _elapsedTicks++;
        s.Elapsed = _elapsedTicks * Tuning.TickSeconds;

        if (Config.Practice)
        {
            s.Clock = s.Elapsed;
            return;
        }

        if (s.Overtime) return;

        // As for phase times: a clock set from outside is taken over, not overwritten.
        int shown = PhaseTicks(s.Clock);
        if (shown != Math.Max(0, _clockTicks)) _clockTicks = shown;

        _clockTicks--;
        if (_clockTicks > 0)
        {
            s.Clock = _clockTicks * Tuning.TickSeconds;
            return;
        }

        s.Clock = 0f;
        if (s.Score[0] != s.Score[1])
        {
            s.Winner = s.Score[0] > s.Score[1] ? 0 : 1;
            EnterPhase(MatchPhase.FullTime, Tuning.Rules.FullTimeHold);
        }
        else if (Config.Settings.GoldenGoal)
        {
            s.Overtime = true;
            Emit(GameEventType.Overtime);
            s.KickoffTeam = Config.KickoffTeam == 1 ? 0 : 1;
            ApplyKickoffLayout();
            EnterPhase(MatchPhase.Kickoff, Tuning.Rules.KickoffCountdown);
        }
        else
        {
            s.Winner = -1;
            EnterPhase(MatchPhase.FullTime, Tuning.Rules.FullTimeHold);
        }
    }

    // ------------------------------------------------------------------------------------
    //  Inputs and movement
    // ------------------------------------------------------------------------------------

    private void GatherInputs(float dt)
    {
        var s = State;
        var players = s.Players;
        switch (s.Phase)
        {
            case MatchPhase.Playing:
            case MatchPhase.GoalScored:
                _ai.Think(_ctx, _inputs, dt);
                for (int i = 0; i < players.Length; i++)
                {
                    int controller = players[i].Controller;
                    if (controller >= 0) _inputs[i] = _humanInputs[controller];
                    else Sanitize(ref _inputs[i]);
                }

                break;

            case MatchPhase.Intro:
            case MatchPhase.Kickoff:
                for (int i = 0; i < players.Length; i++)
                {
                    int controller = players[i].Controller;
                    _inputs[i] = controller >= 0 ? _humanInputs[controller] : new PlayerInput { AimPoint = s.Ball.Pos };
                }

                break;

            default:
                // Full time: nobody is at the controls any more; everyone coasts to a stop.
                for (int i = 0; i < players.Length; i++) _inputs[i] = new PlayerInput { AimPoint = players[i].Pos };
                break;
        }
    }

    private void MovePlayers(float dt, bool frozen)
    {
        var s = State;
        var players = s.Players;
        bool playing = s.Phase == MatchPhase.Playing;
        int owner = s.Ball.Owner;

        for (int i = 0; i < players.Length; i++)
        {
            ref var p = ref players[i];
            _wasInOpponentBox[i] = Pitch.InBox(p.Pos, 1 - p.Team);
            _released[i] = false;

            var result = PlayerMotion.Step(ref p, in _inputs[i], owner == i, frozen, dt, Tuning, Pitch);
            if (result.Events == MotionEvents.None) continue;

            if ((result.Events & MotionEvents.SlideStarted) != 0) Emit(GameEventType.SlideStart, i, pos: p.Pos);
            if ((result.Events & MotionEvents.DashStarted) != 0) Emit(GameEventType.Dash, i, pos: p.Pos);
            if ((result.Events & MotionEvents.DiveStarted) != 0) Emit(GameEventType.Dive, i, pos: p.Pos);
            if ((result.Events & MotionEvents.SlideMissed) != 0) Emit(GameEventType.SlideMiss, i, pos: p.Pos);

            // Outside open play a released shot is simply dropped: players mash buttons in countdowns.
            if (playing && (result.Events & MotionEvents.ShotReleased) != 0)
            {
                _released[i] = true;
                _releasedCharge[i] = result.ReleasedCharge;
            }
        }
    }

    /// <summary>Edge fields live for exactly one step, whoever set them.</summary>
    private void ConsumeEdges()
    {
        for (int h = 0; h < _humanInputs.Length; h++)
        {
            ref var input = ref _humanInputs[h];
            input.Pass = false;
            input.Tackle = false;
            input.SwitchBest = false;
            input.SwitchNext = false;
        }

        for (int i = 0; i < _inputs.Length; i++)
        {
            ref var input = ref _inputs[i];
            input.Pass = false;
            input.Tackle = false;
            input.SwitchBest = false;
            input.SwitchNext = false;
        }
    }

    // ------------------------------------------------------------------------------------
    //  Small shared helpers
    // ------------------------------------------------------------------------------------

    private void Emit(GameEventType type, int a = -1, int b = -1, Vec2 pos = default, float value = 0f, int flag = 0)
    {
        var e = new GameEvent(type, a, b, pos.IsFinite ? pos : Vec2.Zero, float.IsFinite(value) ? value : 0f, flag);
        if (_inStep) _events.Add(e);
        else _carried.Add(e);
    }

    private static float Ratio(float value, float scale) => scale > 0f ? value / scale : 0f;

    /// <summary>Clamp that tolerates an inverted range (tuning overrides are not validated).</summary>
    private static float Clamp(float value, float min, float max) => MathF.Min(MathF.Max(value, min), MathF.Max(min, max));

    private static float Finite(float value, float limit) => float.IsFinite(value) ? Math.Clamp(value, -limit, limit) : 0f;

    private static void Sanitize(ref PlayerInput input)
    {
        input.Move = new Vec2(Finite(input.Move.X, 1000f), Finite(input.Move.Y, 1000f)).ClampLength(1f);
        input.AimPoint = new Vec2(Finite(input.AimPoint.X, AimLimit), Finite(input.AimPoint.Y, AimLimit));
    }

    private enum Stat
    {
        Goals,
        OwnGoals,
        Assists,
        Shots,
        ShotsOnTarget,
        Saves,
        Tackles,
        Steals,
        PassesAttempted,
        PassesCompleted,
    }

    /// <summary>Counts an action for the acting team and, when a human was at the controls, for that human.</summary>
    private void Count(Stat stat, int team, int human)
    {
        // The final whistle freezes the statistics: only open play counts.
        if (State.Phase != MatchPhase.Playing) return;
        Bump(Stats.Teams[team], stat);
        if ((uint)human < (uint)Stats.Humans.Length) Bump(Stats.Humans[human], stat);
    }

    private static void Bump(StatLine line, Stat stat)
    {
        switch (stat)
        {
            case Stat.Goals: line.Goals++; break;
            case Stat.OwnGoals: line.OwnGoals++; break;
            case Stat.Assists: line.Assists++; break;
            case Stat.Shots: line.Shots++; break;
            case Stat.ShotsOnTarget: line.ShotsOnTarget++; break;
            case Stat.Saves: line.Saves++; break;
            case Stat.Tackles: line.Tackles++; break;
            case Stat.Steals: line.Steals++; break;
            case Stat.PassesAttempted: line.PassesAttempted++; break;
            case Stat.PassesCompleted: line.PassesCompleted++; break;
        }
    }
}
