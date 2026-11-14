namespace OfficeKickoff.Sim.Ai;

/// <summary>
/// The AI for every footballer no human controls: both goalkeepers and any outfield footballer
/// whose <see cref="PlayerState.Controller"/> is -1.
///
/// It plays exclusively through <see cref="PlayerInput"/>, reads <see cref="MatchState"/> without
/// ever writing to it and draws randomness only from the match's seeded source, so matches stay
/// reproducible. Control can move between a human and the AI on any tick, so nothing here relies
/// on a plan surviving: every footballer is re-read from the state each tick, and the memory kept
/// per footballer is only ever a hint (a role, a sprint decision, a shot being wound up) that is
/// thrown away whenever control changes hands.
///
/// One instance drives one match. The work is split over partial files: this one holds the tick
/// loop, ball prediction and role assignment; AiDirector.Carrier.cs the footballer on the ball;
/// AiDirector.OffBall.cs everyone else in the outfield; AiDirector.Keeper.cs the goalkeepers.
/// </summary>
public sealed partial class AiDirector : IAiDirector
{
    /// <summary>Ball prediction horizon: Samples * SampleDt seconds of simulation time.</summary>
    private const int Samples = 84;

    private const float SampleDt = 1f / 30f;

    private enum Role : byte
    {
        /// <summary>Hold the team's shape (formation position shifted with the ball).</summary>
        Zone,

        /// <summary>Our ball: get into space and offer a pass.</summary>
        Support,

        /// <summary>Loose ball: go and win it.</summary>
        Chase,

        /// <summary>A team-mate's pass is meant for us: get onto its path.</summary>
        Receive,

        /// <summary>Close down the opposing carrier.</summary>
        Press,

        /// <summary>A human team-mate is pressing: sit goal-side of the carrier behind them.</summary>
        Cover,

        /// <summary>Goal side of one opponent (the role argument).</summary>
        Mark,

        /// <summary>
        /// A match without goalkeepers: slot 0 holds the space between the ball and its own goal
        /// instead of marking, and only steps out for a ball or a carrier that comes close.
        /// </summary>
        Sweep,
    }

    // ---- the current Think call -------------------------------------------------------------
    private MatchState _s = null!;
    private PitchGeometry _pitch = null!;
    private Tuning _t = null!;
    private MatchConfig _cfg = null!;
    private Random _rng = null!;
    private double _now;
    private float _dt;
    private int _n;
    private int _size;

    // ---- ball prediction (shared by everyone this tick) -------------------------------------
    private readonly Vec2[] _path = new Vec2[Samples];
    private readonly Vec2[] _straight = new Vec2[Samples];

    // ---- per footballer -------------------------------------------------------------------
    /// <summary>Seconds this footballer needs to reach the ball on its predicted path.</summary>
    private float[] _eta = [];
    private Vec2[] _etaPoint = [];

    private Role[] _role = [];
    private int[] _roleArg = [];
    private Role[] _wantRole = [];
    private int[] _wantArg = [];
    private double[] _nextPlan = [];

    /// <summary>Controller seen last tick (-2 = not seen yet): a change wipes the footballer's memory.</summary>
    private int[] _controller = [];

    private bool[] _sprintPlan = [];
    private float[] _jitter = [];
    private bool[] _runPlan = [];

    /// <summary>Ticks left holding the shoot button for a planned shot or clearance (0 = none).</summary>
    private int[] _hold = [];

    /// <summary>True while a first-time strike (volley, clearance of a loose ball) is armed.</summary>
    private bool[] _volley = [];

    private Vec2[] _kickAim = [];
    private float[] _kickErr = [];
    private float[] _kickCharge = [];

    /// <summary>Until this time, keep aiming at the last strike's target (a released kick may still be pending).</summary>
    private double[] _strikeUntil = [];

    private bool[] _tackleRolled = [];
    private int[] _dodgeSeen = [];
    private float[] _side = [];
    private bool[] _hadBall = [];

    // ---- per team ---------------------------------------------------------------------------
    private readonly int[] _presser = [-1, -1];
    private readonly int[] _chaser = [-1, -1];
    private readonly bool[] _keeperClaims = new bool[2];
    private readonly bool[] _threat = new bool[2];
    private readonly double[] _threatSince = new double[2];
    private readonly double[] _threatKey = new double[2];
    private readonly float[] _noise = new float[4];
    private readonly float[] _keeperDelay = new float[2];

    // ---- stalemate watch --------------------------------------------------------------------
    private Vec2 _stuckAt;

    /// <summary>Seconds of open play the ball has spent near <see cref="_stuckAt"/>.</summary>
    private float _stuck;

    private bool _clearing;

    // ---- scratch ----------------------------------------------------------------------------
    private int[] _order = [];
    private bool[] _taken = [];

    public void Reset(AiContext ctx)
    {
        Bind(ctx, 0f);
        _now = ctx.State.Time;
        for (int i = 0; i < _n; i++)
        {
            Forget(i);
            _controller[i] = ctx.State.Players[i].Controller;

            // Staggered: footballers re-plan at different ticks, never all at once.
            _nextPlan[i] = _now + Reaction(i) * (float)_rng.NextDouble();
        }

        for (int team = 0; team < 2; team++)
        {
            _presser[team] = -1;
            _chaser[team] = -1;
            _keeperClaims[team] = false;
            _threat[team] = false;
            _threatSince[team] = 0d;
            _threatKey[team] = double.NaN;
            _keeperDelay[team] = 0f;
        }

        for (int k = 0; k < _noise.Length; k++) _noise[k] = (float)(_rng.NextDouble() * Math.Tau);
        _stuckAt = ctx.State.Ball.Pos;
        _stuck = 0f;
        _clearing = false;
    }

    public void Think(AiContext ctx, PlayerInput[] inputs, float dt)
    {
        Bind(ctx, dt);
        var players = _s.Players;
        _now = _s.Time;

        if (_s.Phase != MatchPhase.Playing || _s.Ball.Dead)
        {
            for (int i = 0; i < _n; i++)
            {
                if (players[i].Controller != -1)
                {
                    _controller[i] = players[i].Controller;
                    continue;
                }

                _controller[i] = -1;
                var after = default(PlayerInput);
                AfterGoal(i, ref after);
                inputs[i] = Clean(in after, players[i].Pos);
            }

            return;
        }

        PredictBall();
        ComputeEtas();
        WatchStalemate();
        for (int team = 0; team < 2; team++) AssignRoles(team);

        for (int i = 0; i < _n; i++)
        {
            ref readonly var p = ref players[i];
            if (p.Controller != -1)
            {
                _controller[i] = p.Controller;
                continue;
            }

            bool plan = _now >= _nextPlan[i];
            if (_controller[i] != -1)
            {
                // Just handed (back) to the AI: whatever it was doing belongs to someone else.
                Forget(i);
                _controller[i] = -1;
                plan = true;
            }

            if (plan) _nextPlan[i] = _now + Reaction(i) * (0.8f + 0.4f * (float)_rng.NextDouble());

            var input = new PlayerInput { AimPoint = _s.Ball.Pos };
            if (p.IsKeeper) ThinkKeeper(i, ref input);
            else ThinkOutfield(i, plan, ref input);
            inputs[i] = Clean(in input, p.Pos);
        }
    }

    private void Bind(AiContext ctx, float dt)
    {
        _s = ctx.State;
        _pitch = ctx.Pitch;
        _t = ctx.Tuning;
        _cfg = ctx.Config;
        _rng = ctx.Rng;
        _dt = float.IsFinite(dt) && dt > 0f ? dt : Tuning.TickSeconds;
        _size = Math.Max(1, _s.TeamSize);
        int n = _s.Players.Length;
        if (n == _n && _eta.Length == n) return;

        _n = n;
        _eta = new float[n];
        _etaPoint = new Vec2[n];
        _role = new Role[n];
        _roleArg = new int[n];
        _wantRole = new Role[n];
        _wantArg = new int[n];
        _nextPlan = new double[n];
        _controller = new int[n];
        _sprintPlan = new bool[n];
        _jitter = new float[n];
        _runPlan = new bool[n];
        _hold = new int[n];
        _volley = new bool[n];
        _kickAim = new Vec2[n];
        _kickErr = new float[n];
        _kickCharge = new float[n];
        _strikeUntil = new double[n];
        _tackleRolled = new bool[n];
        _dodgeSeen = new int[n];
        _side = new float[n];
        _hadBall = new bool[n];
        _order = new int[n];
        _taken = new bool[n];
        for (int i = 0; i < n; i++) _controller[i] = -2;
    }

    /// <summary>Drops every plan a footballer had.</summary>
    private void Forget(int i)
    {
        _role[i] = Role.Zone;
        _roleArg[i] = -1;
        _hold[i] = 0;
        _volley[i] = false;
        _kickErr[i] = 0f;
        _kickCharge[i] = 0f;
        _strikeUntil[i] = double.NegativeInfinity;
        _tackleRolled[i] = false;
        _dodgeSeen[i] = -1;
        _side[i] = (i & 1) == 0 ? 1f : -1f;
        _hadBall[i] = false;
        _sprintPlan[i] = false;
        _runPlan[i] = false;
        _jitter[i] = 0f;
    }

    // ------------------------------------------------------------------------------------
    //  Levels
    // ------------------------------------------------------------------------------------

    private AiLevel OutfieldLevel(int team) => _cfg.OutfieldLevel(team);

    private AiLevel KeeperLevel(int team) => _cfg.KeeperLevel(team);

    private float Reaction(int i)
    {
        ref readonly var p = ref _s.Players[i];
        float r = p.IsKeeper
            ? _t.Keeper.Reaction.Get(KeeperLevel(p.Team))
            : _t.Ai.Reaction.Get(OutfieldLevel(p.Team));
        return float.IsFinite(r) && r > 0.02f ? r : 0.02f;
    }

    private float Chance() => (float)_rng.NextDouble();

    /// <summary>Triangular noise in [-1, 1], most often near 0.</summary>
    private float Noise() => (float)(_rng.NextDouble() + _rng.NextDouble() - 1d);

    // ------------------------------------------------------------------------------------
    //  Ball prediction
    // ------------------------------------------------------------------------------------

    private void PredictBall()
    {
        ref readonly var b = ref _s.Ball;
        if (b.Owner >= 0)
        {
            // A carried ball goes where its carrier is running, for a little while.
            Vec2 v = _s.Players[b.Owner].Vel;
            for (int k = 0; k < Samples; k++)
            {
                float t = MathF.Min(k * SampleDt, 0.45f);
                _path[k] = _pitch.ClampCircle(b.Pos + v * t, _t.Ball.Radius);
                _straight[k] = _path[k];
            }

            return;
        }

        Simulate(_path, b.Pos, b.Vel, b.Spin);
        if (b.Spin == 0f) Array.Copy(_path, _straight, Samples);
        else Simulate(_straight, b.Pos, b.Vel, 0f);
    }

    /// <summary>
    /// The free ball's future, sampled every SampleDt: spin, drag, rolling friction and bounces off
    /// the side and end walls, following Match's ball physics. Samples after the ball stops or
    /// enters a goal repeat its last position.
    /// </summary>
    private void Simulate(Vec2[] into, Vec2 pos, Vec2 vel, float spin)
    {
        var bt = _t.Ball;
        var pt = _t.Pitch;
        float r = bt.Radius;
        float halfW = _pitch.HalfW, halfH = _pitch.HalfH;
        bool moving = vel.LengthSq > 1e-6f;
        into[0] = pos;
        for (int k = 1; k < Samples; k++)
        {
            if (moving)
            {
                float h = SampleDt;
                float speed = vel.Length;
                if (spin != 0f)
                {
                    vel = vel.Rotated(spin * bt.CurveRate * h);
                    spin *= MathF.Exp(-bt.SpinDecay * h);
                }

                float next = speed * MathF.Exp(-bt.Drag * h) - bt.RollFriction * h;
                if (next < bt.StopSpeed || speed <= 1e-6f)
                {
                    vel = Vec2.Zero;
                    moving = false;
                }
                else
                {
                    vel *= MathF.Min(next, bt.MaxSpeed) / speed;
                }

                pos += vel * h;
                if (MathF.Abs(pos.Y) > halfH - r)
                {
                    float sy = pos.Y < 0f ? -1f : 1f;
                    pos = new Vec2(pos.X, sy * (halfH - r));
                    vel = new Vec2(vel.X * pt.WallFriction, -vel.Y * pt.WallBounce);
                }

                if (MathF.Abs(pos.X) > halfW - r)
                {
                    float sx = pos.X < 0f ? -1f : 1f;
                    if (MathF.Abs(pos.Y) < _pitch.GoalHalf)
                    {
                        if (MathF.Abs(pos.X) > halfW + r * 0.5f) moving = false;
                    }
                    else
                    {
                        pos = new Vec2(sx * (halfW - r), pos.Y);
                        vel = new Vec2(-vel.X * pt.WallBounce, vel.Y * pt.WallFriction);
                    }
                }
            }

            into[k] = pos;
        }
    }

    /// <summary>Top running speed of a footballer as it is controlled right now.</summary>
    private float RunSpeed(in PlayerState p, bool sprint)
    {
        var pt = _t.Player;
        bool canSprint = sprint && !p.Exhausted && p.Stamina > 0.15f;
        return (canSprint ? pt.SprintSpeed : pt.RunSpeed) * MathF.Max(0.1f, p.SpeedFactor);
    }

    /// <summary>Seconds a footballer is out of the game before it can start running.</summary>
    private float Busy(in PlayerState p)
    {
        return p.Action switch
        {
            PlayerAction.Stunned or PlayerAction.Recover => MathF.Max(0f, p.ActionTime),
            PlayerAction.Slide => MathF.Max(0f, p.ActionTime) + _t.Tackle.HitRecover,
            PlayerAction.Dive => MathF.Max(0f, p.ActionTime) + _t.Keeper.DiveRecover,
            _ => 0f,
        };
    }

    /// <summary>For every footballer: how soon they can get to the ball on its predicted path, and where.</summary>
    private void ComputeEtas()
    {
        var players = _s.Players;
        float reach = _t.Player.Radius + _t.Ball.Radius + 4f;
        for (int i = 0; i < _n; i++)
        {
            ref readonly var p = ref players[i];
            float speed = RunSpeed(in p, true);
            float delay = Busy(in p) + 0.06f;
            float eta = -1f;
            Vec2 at = _path[Samples - 1];
            for (int k = 0; k < Samples; k++)
            {
                float t = k * SampleDt;
                float d = Vec2.Distance(_path[k], p.Pos) - reach;
                if (d <= speed * MathF.Max(0f, t - delay))
                {
                    eta = t;
                    at = _path[k];
                    break;
                }
            }

            if (eta < 0f)
            {
                float d = MathF.Max(0f, Vec2.Distance(at, p.Pos) - reach);
                eta = Samples * SampleDt + delay + d / speed;
            }

            _eta[i] = eta;
            _etaPoint[i] = at;
        }
    }

    // ------------------------------------------------------------------------------------
    //  Stalemate
    // ------------------------------------------------------------------------------------

    /// <summary>
    /// Footballers scrapping over a ball that goes nowhere: once it has stayed in one small patch
    /// for Ai.StalemateTime, the next AI footballer to get a foot to it clears it upfield.
    /// </summary>
    private void WatchStalemate()
    {
        ref readonly var b = ref _s.Ball;
        float radius = _t.Ai.StalemateRadius;
        if (b.Held || Vec2.DistanceSq(b.Pos, _stuckAt) > radius * radius)
        {
            _stuckAt = b.Pos;
            _stuck = 0f;
            _clearing = false;
            return;
        }

        // Only open play counts (Think runs only then), not the countdown before a kickoff.
        _stuck += _dt;
        if (!_clearing && _stuck >= _t.Ai.StalemateTime) _clearing = true;
    }

    // ------------------------------------------------------------------------------------
    //  Roles
    // ------------------------------------------------------------------------------------

    private bool IsAiOutfield(int i) => !_s.Players[i].IsKeeper && _s.Players[i].Controller == -1;

    private bool IsHuman(int i) => _s.Players[i].Controller >= 0;

    /// <summary>A team's goalkeeper, or -1 in a match played without goalkeepers.</summary>
    private int KeeperOf(int team)
    {
        var players = _s.Players;
        for (int j = team * _size; j < (team + 1) * _size; j++)
        {
            if (players[j].IsKeeper) return j;
        }

        return -1;
    }

    /// <summary>
    /// A team's AI sweeper: slot 0 in a match without goalkeepers, while the AI controls it. -1 when
    /// the team has a goalkeeper or a human is playing slot 0.
    /// </summary>
    private int SweeperOf(int team)
    {
        if (KeeperOf(team) >= 0) return -1;
        int i = team * _size;
        return i < _n && IsAiOutfield(i) ? i : -1;
    }

    /// <summary>Furthest the sweeper's post ever gets from its own goal.</summary>
    private float SweepDepth => _pitch.HalfW * 0.32f;

    /// <summary>A loose ball coming to rest this close to the goal is the sweeper's to go for.</summary>
    private float SweepReach => _pitch.HalfW * 0.5f;

    /// <summary>
    /// A carrier this close to the goal may be pressed by the sweeper. Further out it holds its post:
    /// a sweeper that marks upfield leaves an empty goal behind it.
    /// </summary>
    private float SweepPress => _pitch.HalfW * 0.4f;

    private void TakeSweep(int sweeper)
    {
        _wantRole[sweeper] = Role.Sweep;
        _wantArg[sweeper] = -1;
        _taken[sweeper] = true;
    }

    /// <summary>Works out, for one team, the role every AI outfield footballer should take at its next re-plan.</summary>
    private void AssignRoles(int team)
    {
        var players = _s.Players;
        ref readonly var b = ref _s.Ball;
        int first = team * _size, end = first + _size;

        for (int i = first; i < end; i++)
        {
            _wantRole[i] = Role.Zone;
            _wantArg[i] = -1;
            _taken[i] = !IsAiOutfield(i);
        }

        _keeperClaims[team] = KeeperClaims(team);
        int sweeper = SweeperOf(team);
        Vec2 ownGoal = _pitch.OwnGoal(team);
        int owner = b.Owner;
        if (owner >= 0)
        {
            _chaser[team] = -1;
            if (players[owner].Team == team)
            {
                _presser[team] = -1;

                // The sweeper stays behind the attack: someone has to be there when the ball is lost.
                if (sweeper >= 0 && sweeper != owner) TakeSweep(sweeper);
                for (int i = first; i < end; i++)
                {
                    if (!_taken[i] && i != owner) _wantRole[i] = Role.Support;
                }
            }
            else
            {
                Defend(team, owner, sweeper);
            }

            return;
        }

        _presser[team] = -1;

        // Our pass in flight: its receiver goes to meet it, everyone else offers the next option.
        int target = b.PassTarget;
        if (target >= 0 && b.PassFrom >= 0 && players[b.PassFrom].Team == team && players[target].Team == team)
        {
            _chaser[team] = -1;
            if (IsAiOutfield(target))
            {
                _wantRole[target] = Role.Receive;
                _taken[target] = true;
            }

            if (sweeper >= 0 && !_taken[sweeper]) TakeSweep(sweeper);
            for (int i = first; i < end; i++)
            {
                if (!_taken[i]) _wantRole[i] = Role.Support;
            }

            return;
        }

        // Loose ball: the AI footballer who gets there first goes, unless one of our humans clearly will.
        // A sweeper only leaves its post for a ball that is coming into its own area.
        bool sweeperGoes = sweeper >= 0 && Vec2.Distance(_etaPoint[sweeper], ownGoal) < SweepReach;
        float bestAi = float.MaxValue, bestHuman = float.MaxValue, bestOpp = float.MaxValue;
        int chaser = -1;
        for (int i = 0; i < _n; i++)
        {
            ref readonly var p = ref players[i];
            if (p.Team != team)
            {
                bestOpp = MathF.Min(bestOpp, _eta[i]);
                continue;
            }

            if (p.IsKeeper) continue;
            if (p.Controller >= 0)
            {
                bestHuman = MathF.Min(bestHuman, _eta[i]);
            }
            else if (_eta[i] < bestAi && (i != sweeper || sweeperGoes))
            {
                bestAi = _eta[i];
                chaser = i;
            }
        }

        int previous = _chaser[team];
        if (chaser >= 0 && previous >= 0 && previous != chaser && IsAiOutfield(previous) &&
            players[previous].Team == team && _eta[previous] <= bestAi + 0.2f && (previous != sweeper || sweeperGoes))
        {
            chaser = previous;
            bestAi = _eta[previous];
        }

        bool humanClearlyFirst = bestHuman + 0.25f < bestAi || bestHuman < bestAi * 0.7f;
        if (_keeperClaims[team] || humanClearlyFirst) chaser = -1;
        _chaser[team] = chaser;
        if (chaser >= 0)
        {
            _wantRole[chaser] = Role.Chase;
            _taken[chaser] = true;
        }

        if (sweeper >= 0 && !_taken[sweeper]) TakeSweep(sweeper);
        bool ours = MathF.Min(bestAi, bestHuman) < bestOpp - 0.05f || _keeperClaims[team];
        if (ours)
        {
            for (int i = first; i < end; i++)
            {
                if (!_taken[i]) _wantRole[i] = Role.Support;
            }
        }
        else
        {
            AssignMarkers(team, -1);
        }
    }

    /// <summary>
    /// The opponents have the ball: one presser (or a cover behind our human), the rest mark. A
    /// sweeper (<paramref name="sweeper"/>, -1 for none) only presses a carrier close to its goal and
    /// otherwise holds its post.
    /// </summary>
    private void Defend(int team, int carrier, int sweeper)
    {
        var players = _s.Players;
        ref readonly var b = ref _s.Ball;
        ref readonly var c = ref players[carrier];
        int first = team * _size, end = first + _size;

        // The keeper's hands close the box: nobody runs at them.
        bool pressable = !b.Held;
        bool sweeperPresses = sweeper >= 0 && Vec2.Distance(c.Pos, _pitch.OwnGoal(team)) < SweepPress;

        int best = -1;
        float bestEta = float.MaxValue;
        float humanDist = float.MaxValue;
        for (int i = first; i < end; i++)
        {
            ref readonly var p = ref players[i];
            if (p.IsKeeper) continue;
            if (p.Controller >= 0)
            {
                if (p.Action != PlayerAction.Stunned) humanDist = MathF.Min(humanDist, Vec2.Distance(p.Pos, b.Pos));
                continue;
            }

            if (i == sweeper && !sweeperPresses) continue;
            if (_eta[i] < bestEta)
            {
                bestEta = _eta[i];
                best = i;
            }
        }

        int previous = _presser[team];
        if (best >= 0 && previous >= 0 && previous != best && IsAiOutfield(previous) &&
            players[previous].Team == team && _eta[previous] <= bestEta + 0.25f && (previous != sweeper || sweeperPresses))
        {
            best = previous;
        }

        _presser[team] = -1;
        if (best >= 0 && pressable)
        {
            if (humanDist < Vec2.Distance(players[best].Pos, b.Pos))
            {
                _wantRole[best] = Role.Cover;
            }
            else
            {
                _wantRole[best] = Role.Press;
                _presser[team] = best;
            }

            _taken[best] = true;
        }

        if (sweeper >= 0 && !_taken[sweeper]) TakeSweep(sweeper);
        AssignMarkers(team, carrier);
    }

    /// <summary>
    /// Goal side of the most dangerous unmarked opponents, nearest free defender first; whoever is
    /// left over holds the zone. Opponents a human team-mate is already standing on count as marked.
    /// </summary>
    private void AssignMarkers(int team, int carrier)
    {
        var players = _s.Players;
        int opp = 1 - team;
        Vec2 goal = _pitch.OwnGoal(team);
        int count = 0;
        for (int j = opp * _size; j < (opp + 1) * _size; j++)
        {
            if (j == carrier || players[j].IsKeeper) continue;
            float d = Vec2.DistanceSq(players[j].Pos, goal);
            int at = count++;
            while (at > 0 && Vec2.DistanceSq(players[_order[at - 1]].Pos, goal) > d)
            {
                _order[at] = _order[at - 1];
                at--;
            }

            _order[at] = j;
        }

        int first = team * _size, end = first + _size;
        float humanCover = _t.Ai.MarkDistance * 1.6f;
        for (int k = 0; k < count; k++)
        {
            int j = _order[k];
            ref readonly var o = ref players[j];
            bool covered = false;
            for (int h = first; h < end; h++)
            {
                if (IsHuman(h) && Vec2.DistanceSq(players[h].Pos, o.Pos) < humanCover * humanCover)
                {
                    covered = true;
                    break;
                }
            }

            if (covered) continue;

            int pick = -1;
            float pickD2 = float.MaxValue;
            for (int i = first; i < end; i++)
            {
                // A keeper is never free: AssignRoles marks every footballer that is not AI outfield as taken.
                if (_taken[i]) continue;
                float d2 = Vec2.DistanceSq(players[i].Pos, o.Pos);
                if (d2 < pickD2)
                {
                    pickD2 = d2;
                    pick = i;
                }
            }

            if (pick < 0) break;
            _wantRole[pick] = Role.Mark;
            _wantArg[pick] = j;
            _taken[pick] = true;
        }
    }

    // ------------------------------------------------------------------------------------
    //  Steering and output
    // ------------------------------------------------------------------------------------

    /// <summary>
    /// Move towards a point: full speed when far, easing off on arrival. With
    /// <paramref name="separate"/> (everyone not going for the ball), also edge away from
    /// team-mates so two footballers never stand on top of each other, and step round a loose
    /// ball rather than through it - touching it would steal it from whoever is going for it.
    /// </summary>
    private Vec2 Steer(int i, Vec2 target, bool separate, float slowRadius = 40f)
    {
        var players = _s.Players;
        ref readonly var p = ref players[i];
        Vec2 to = target - p.Pos;
        float dist = to.Length;
        Vec2 move = dist > 4f ? to / dist * MathF.Min(1f, dist / slowRadius) : Vec2.Zero;
        if (!separate) return move;

        ref readonly var b = ref _s.Ball;
        if (b.Owner < 0)
        {
            float clear = _t.Player.Radius + _t.Ball.Radius + 45f;
            Vec2 off = p.Pos - b.Pos;
            float d = off.Length;
            if (d < clear)
            {
                Vec2 dir = d > 1e-3f ? off / d : Vec2.FromAngle(i * 2.39996f);
                move += dir * ((clear - d) / clear * 2f);
            }
            else if (move.LengthSq > 1e-4f)
            {
                // Heading past the ball: aim to the side of it instead.
                Vec2 u = move.Normalized();
                float along = Vec2.Dot(-off, u);
                float side = Vec2.Cross(u, -off);
                if (along > 0f && along < dist && MathF.Abs(side) < clear)
                {
                    Vec2 dodge = u.Perp * (side > 0f ? -1f : 1f);
                    move = (u + dodge * 1.2f).Normalized() * move.Length;
                }
            }
        }

        float space = _t.Player.Radius * 2.6f;
        int first = p.Team * _size;
        for (int j = first; j < first + _size; j++)
        {
            if (j == i) continue;
            Vec2 away = p.Pos - players[j].Pos;
            float d = away.Length;
            if (d >= space) continue;
            Vec2 dir = d > 1e-3f ? away / d : Vec2.FromAngle(i * 2.39996f);
            move += dir * ((space - d) / space * 0.9f);
        }

        return move.ClampLength(1f);
    }

    /// <summary>Keeps a target point where a footballer can stand.</summary>
    private Vec2 OnPitch(Vec2 point) => _pitch.ClampCircle(point, _t.Player.Radius + 2f);

    /// <summary>Moves a point out of a keeper box (plus a footballer's width).</summary>
    private Vec2 OutOfBox(Vec2 point, int defendingTeam)
    {
        float margin = _t.Player.Radius + 8f;
        float lineX = _pitch.GoalLineX(defendingTeam);
        float outwards = PitchGeometry.AttackSign(defendingTeam);
        float depth = (point.X - lineX) * outwards;
        if (MathF.Abs(point.Y) > _pitch.BoxHalfWidth + margin || depth > _pitch.BoxDepth + margin) return point;

        float toFront = _pitch.BoxDepth + margin - depth;
        float toSide = _pitch.BoxHalfWidth + margin - MathF.Abs(point.Y);
        bool sideExit = _pitch.BoxHalfWidth + margin < _pitch.HalfH - _t.Player.Radius;
        if (!sideExit || toFront <= toSide) return new Vec2(lineX + outwards * (_pitch.BoxDepth + margin), point.Y);
        return new Vec2(point.X, (point.Y < 0f ? -1f : 1f) * (_pitch.BoxHalfWidth + margin));
    }

    /// <summary>Last line of defence against NaN: whatever happened above, the match gets finite controls.</summary>
    private static PlayerInput Clean(in PlayerInput input, Vec2 pos)
    {
        var clean = input;
        if (!clean.Move.IsFinite) clean.Move = Vec2.Zero;
        clean.Move = clean.Move.ClampLength(1f);
        if (!clean.AimPoint.IsFinite) clean.AimPoint = pos;
        clean.SwitchBest = false;
        clean.SwitchNext = false;
        return clean;
    }

    // ------------------------------------------------------------------------------------
    //  Shared geometry
    // ------------------------------------------------------------------------------------

    /// <summary>
    /// How safely a ball can travel from one point to another past the given team: the smallest
    /// margin (units) by which any of them misses getting a foot to it, allowing for how far they
    /// can run while it travels. Negative means somebody can cut it out.
    /// </summary>
    private float LaneMargin(Vec2 from, Vec2 to, int team, float ballSpeed, float cutFactor)
    {
        var players = _s.Players;
        Vec2 d = to - from;
        float len = d.Length;
        if (len < 1f) return 999f;
        Vec2 u = d / len;
        float body = _t.Player.Radius + _t.Ball.Radius;
        float best = 999f;
        for (int j = team * _size; j < (team + 1) * _size; j++)
        {
            ref readonly var q = ref players[j];
            Vec2 rel = q.Pos - from;
            float along = Vec2.Dot(rel, u);
            if (along < 0f || along > len + body) continue;
            float perp = MathF.Abs(Vec2.Cross(u, rel));
            float t = along / MathF.Max(50f, ballSpeed);
            float reach = RunSpeed(in q, false) * MathF.Max(0f, t - Busy(in q) - 0.1f) * cutFactor;
            best = MathF.Min(best, perp - body - reach);
        }

        return best;
    }

    /// <summary>Distance from a point to the nearest footballer of a team (keepers optional).</summary>
    private float NearestOf(int team, Vec2 point, bool keepers, out int who)
    {
        var players = _s.Players;
        float best = float.MaxValue;
        who = -1;
        for (int j = team * _size; j < (team + 1) * _size; j++)
        {
            if (!keepers && players[j].IsKeeper) continue;
            float d2 = Vec2.DistanceSq(players[j].Pos, point);
            if (d2 < best)
            {
                best = d2;
                who = j;
            }
        }

        return who >= 0 ? MathF.Sqrt(best) : float.MaxValue;
    }

    /// <summary>
    /// The pass-target rule of the simulation, repeated literally (see Match.FindPassTarget): the
    /// team-mate a pass from <paramref name="i"/> along <paramref name="aimDir"/> would go to.
    /// </summary>
    private int PassRuleTarget(int i, Vec2 aimDir)
    {
        var players = _s.Players;
        ref readonly var p = ref players[i];
        float cone = _t.Kick.PassConeDeg * (MathF.PI / 180f);
        float tie = _t.Kick.PassTieDeg * (MathF.PI / 180f);
        float aimAngle = aimDir.Angle;
        int first = p.Team * _size;
        int end = first + _size;

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

    private static float PassAngle(in PlayerState from, in PlayerState to, float aimAngle)
    {
        Vec2 d = to.Pos - from.Pos;
        if (d.LengthSq < 1e-6f) return float.MaxValue;
        return MathF.Abs(MathUtil.AngleDiff(aimAngle, d.Angle));
    }

    /// <summary>Speed a pass over this distance leaves the foot at (Match's weighting, without the lead).</summary>
    private float PassSpeed(float distance)
    {
        var kick = _t.Kick;
        float bs = _cfg.Settings.BallSpeed;
        float min = kick.PassMinSpeed * bs;
        float max = kick.PassMaxSpeed * MathF.Max(1f, bs);
        float v = kick.PassArriveSpeed * bs + _t.Ball.Drag * distance;
        return MathF.Min(MathF.Max(v, min), MathF.Max(min, max));
    }

    private float ShotSpeed(float charge) =>
        MathUtil.Lerp(_t.Kick.ShotMinSpeed, _t.Kick.ShotMaxSpeed, MathUtil.Clamp01(charge)) * _cfg.Settings.BallSpeed;

    /// <summary>Holding the shoot button this many ticks gives (at least) this charge.</summary>
    private int TicksFor(float charge)
    {
        float simTime = MathUtil.Clamp01(charge) * _t.Kick.ChargeTime;
        return Math.Max(1, (int)MathF.Ceiling(simTime / MathF.Max(1e-4f, _dt)));
    }
}
