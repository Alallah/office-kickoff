using OfficeKickoff.Sim;

namespace OfficeKickoff.Sim.Tests;

/// <summary>An AI that does nothing at all: every footballer it owns stands still. Counts its calls.</summary>
public sealed class IdleAi : IAiDirector
{
    public int Resets { get; private set; }
    public int Thinks { get; private set; }

    public void Reset(AiContext ctx) => Resets++;

    public void Think(AiContext ctx, PlayerInput[] inputs, float dt) => Thinks++;
}

/// <summary>
/// An AI driven by the test: hold an input on a footballer, press an edge for one tick, or hook
/// <see cref="OnThink"/> for anything else. Footballers without a script stand still and keep
/// facing where they face. Only footballers the AI actually controls are written, as the contract asks.
/// </summary>
public sealed class ScriptedAi : IAiDirector
{
    private readonly Dictionary<int, PlayerInput> _held = [];
    private readonly Dictionary<int, PlayerInput> _once = [];

    public int Resets { get; private set; }
    public int Thinks { get; private set; }

    /// <summary>Called at the end of every Think, after the scripted inputs were written.</summary>
    public Action<AiContext, PlayerInput[], float>? OnThink { get; set; }

    /// <summary>Uses this input for the footballer on every tick until replaced or released.</summary>
    public void Hold(int player, PlayerInput input) => _held[player] = input;

    public void Release(int player) => _held.Remove(player);

    public void ReleaseAll() => _held.Clear();

    /// <summary>Uses this input for the footballer on the next tick only, then falls back to the held one.</summary>
    public void Once(int player, PlayerInput input) => _once[player] = input;

    public void Reset(AiContext ctx) => Resets++;

    public void Think(AiContext ctx, PlayerInput[] inputs, float dt)
    {
        Thinks++;
        var players = ctx.State.Players;
        for (int i = 0; i < players.Length; i++)
        {
            if (players[i].Controller != -1) continue;
            if (_once.Remove(i, out var once)) inputs[i] = once;
            else if (_held.TryGetValue(i, out var held)) inputs[i] = held;
            else inputs[i] = new PlayerInput { AimPoint = players[i].Pos + Vec2.FromAngle(players[i].Aim) * 100f };
        }

        OnThink?.Invoke(ctx, inputs, dt);
    }
}

/// <summary>
/// An AI that mashes the controls at random (see <see cref="TestKit.Mash"/>): it chases the ball,
/// shoots, passes, slides, dives and now and then feeds garbage numbers. For soak and determinism
/// tests. Reproducible: the same seed gives the same button presses.
/// </summary>
public sealed class ChaosAi : IAiDirector
{
    private readonly Random _rng;
    private PlayerInput[] _held = [];

    public ChaosAi(int seed) => _rng = new Random(seed);

    public int Resets { get; private set; }

    public void Reset(AiContext ctx) => Resets++;

    public void Think(AiContext ctx, PlayerInput[] inputs, float dt)
    {
        var players = ctx.State.Players;
        if (_held.Length != players.Length) _held = new PlayerInput[players.Length];
        for (int i = 0; i < players.Length; i++)
        {
            if (players[i].Controller != -1) continue;
            TestKit.Mash(_rng, ctx.State, ctx.Pitch, i, ref _held[i]);
            inputs[i] = _held[i];
        }
    }
}

/// <summary>Shared helpers for simulation tests: match builders, scene set-up, stepping and assertions.</summary>
public static class TestKit
{
    public const float Dt = Tuning.TickSeconds;

    /// <summary>Whole ticks in a number of real seconds.</summary>
    public static int Ticks(float seconds) => (int)MathF.Round(seconds * Tuning.TickRate);

    // ------------------------------------------------------------------------------------
    //  Builders
    // ------------------------------------------------------------------------------------

    /// <summary>A match in its initial phase (Intro, or Kickoff for practice). The AI defaults to <see cref="IdleAi"/>.</summary>
    public static Match NewMatch(
        int teamSize = 5,
        IAiDirector? ai = null,
        int seed = 1234,
        Action<MatchSettings>? settings = null,
        Action<MatchConfig>? config = null,
        Tuning? tuning = null)
    {
        var s = new MatchSettings { TeamSize = teamSize, Preset = "custom" };
        settings?.Invoke(s);
        var c = new MatchConfig { Settings = s.Normalized() };
        config?.Invoke(c);
        return new Match(c, tuning ?? new Tuning(), ai ?? new IdleAi(), seed);
    }

    /// <summary>A match already in open play (the kickoff taker has the ball on the centre spot).</summary>
    public static Match Playing(
        int teamSize = 5,
        IAiDirector? ai = null,
        int seed = 1234,
        Action<MatchSettings>? settings = null,
        Action<MatchConfig>? config = null,
        Tuning? tuning = null)
    {
        var match = NewMatch(teamSize, ai, seed, settings, config, tuning);
        RunToPlaying(match);
        return match;
    }

    /// <summary>
    /// A match in open play with the stage cleared: every footballer parked on the top touchline of
    /// their own half (see <see cref="Park"/>) and the ball at rest on the centre spot, touched by
    /// nobody. It is driven by a <see cref="ScriptedAi"/>, so footballers stand still and keep
    /// facing where they face until the test says otherwise.
    /// </summary>
    public static Match Arena(
        out ScriptedAi ai,
        int teamSize = 5,
        int seed = 1234,
        Action<MatchSettings>? settings = null,
        Action<MatchConfig>? config = null,
        Tuning? tuning = null)
    {
        ai = new ScriptedAi();
        var match = Playing(teamSize, ai, seed, settings, config, tuning);
        Park(match);
        FreeBall(match, Vec2.Zero, Vec2.Zero);
        return match;
    }

    public static Match Arena(
        int teamSize = 5,
        int seed = 1234,
        Action<MatchSettings>? settings = null,
        Action<MatchConfig>? config = null,
        Tuning? tuning = null) => Arena(out _, teamSize, seed, settings, config, tuning);

    public static void RunToPlaying(Match match)
    {
        for (int i = 0; i < 2000 && match.State.Phase != MatchPhase.Playing; i++) match.Step();
        Assert.Equal(MatchPhase.Playing, match.State.Phase);
    }

    // ------------------------------------------------------------------------------------
    //  Stepping
    // ------------------------------------------------------------------------------------

    public static void Step(Match match, int ticks = 1)
    {
        for (int i = 0; i < ticks; i++) match.Step();
    }

    /// <summary>Steps and returns every event emitted on the way.</summary>
    public static List<GameEvent> Collect(Match match, int ticks = 1)
    {
        var all = new List<GameEvent>();
        for (int i = 0; i < ticks; i++)
        {
            match.Step();
            all.AddRange(match.Events);
        }

        return all;
    }

    /// <summary>Steps until the condition holds (checked after each step). Returns every event; fails after maxTicks.</summary>
    public static List<GameEvent> StepUntil(Match match, Func<Match, bool> condition, int maxTicks = 600)
    {
        var all = new List<GameEvent>();
        for (int i = 0; i < maxTicks; i++)
        {
            match.Step();
            all.AddRange(match.Events);
            if (condition(match)) return all;
        }

        Assert.Fail($"condition not reached within {maxTicks} ticks (phase {match.State.Phase}, tick {match.State.Tick})");
        return all;
    }

    public static List<GameEvent> StepUntilPhase(Match match, MatchPhase phase, int maxTicks = 2000) =>
        StepUntil(match, m => m.State.Phase == phase, maxTicks);

    /// <summary>Steps until an event of this type has been emitted. Returns every event up to and including that tick.</summary>
    public static List<GameEvent> StepUntilEvent(Match match, GameEventType type, int maxTicks = 600) =>
        StepUntil(match, m => Has(m.Events, type), maxTicks);

    public static int CountOf(IEnumerable<GameEvent> events, GameEventType type) => events.Count(e => e.Type == type);

    public static GameEvent Single(IEnumerable<GameEvent> events, GameEventType type) => Assert.Single(events, e => e.Type == type);

    public static bool Has(IEnumerable<GameEvent> events, GameEventType type) => events.Any(e => e.Type == type);

    // ------------------------------------------------------------------------------------
    //  Inputs
    // ------------------------------------------------------------------------------------

    /// <summary>Builds an input. Mind the default aim: the centre spot. A footballer steered with it turns to face (0, 0).</summary>
    public static PlayerInput Input(
        Vec2? move = null,
        Vec2? aim = null,
        bool sprint = false,
        bool shoot = false,
        bool pass = false,
        bool tackle = false,
        bool switchBest = false,
        bool switchNext = false) => new()
    {
        Move = move ?? Vec2.Zero,
        AimPoint = aim ?? Vec2.Zero,
        Sprint = sprint,
        Shoot = shoot,
        Pass = pass,
        Tackle = tackle,
        SwitchBest = switchBest,
        SwitchNext = switchNext,
    };

    /// <summary>A point straight ahead of a footballer: aiming at it keeps them facing the way they face.</summary>
    public static Vec2 AimAhead(Match match, int index, float distance = 300f)
    {
        ref readonly var p = ref match.State.Players[index];
        return p.Pos + Vec2.FromAngle(p.Aim) * distance;
    }

    /// <summary>Gives a human neutral controls that keep their footballer standing and facing the way it faces.</summary>
    public static void Face(Match match, int human)
    {
        int index = match.State.Humans[human].PlayerIndex;
        Assert.True(index >= 0, $"human {human} controls nobody");
        match.SetInput(human, Input(aim: AimAhead(match, index)));
    }

    /// <summary>
    /// Has a human hold the shoot button for <paramref name="chargeTicks"/> ticks and release it.
    /// Returns the events of the release tick. The charge is chargeTicks * Dt / ChargeTime.
    /// </summary>
    public static List<GameEvent> ChargeAndShoot(Match match, int human, int chargeTicks, Vec2 aim, Vec2? move = null)
    {
        match.SetInput(human, Input(move: move, aim: aim, shoot: true));
        Step(match, chargeTicks);
        match.SetInput(human, Input(move: move, aim: aim));
        return Collect(match);
    }

    /// <summary>
    /// Random button mashing for one footballer: updates a held input in place. Mostly chases the
    /// ball and aims at the goal, sometimes wanders, sprints, charges, passes, tackles, and now and
    /// then produces garbage numbers (NaN, infinity, huge vectors) to exercise input sanitising.
    /// </summary>
    public static void Mash(Random rng, MatchState state, PitchGeometry pitch, int index, ref PlayerInput input)
    {
        ref readonly var p = ref state.Players[index];
        Vec2 ball = state.Ball.Pos;

        if (rng.Next(10) == 0)
        {
            int roll = rng.Next(10);
            if (roll < 6) input.Move = (ball - p.Pos).Normalized();
            else if (roll < 9) input.Move = Vec2.FromAngle((float)(rng.NextDouble() * Math.Tau), (float)rng.NextDouble() * 1.5f);
            else input.Move = Vec2.Zero;
        }

        if (rng.Next(8) == 0)
        {
            int roll = rng.Next(10);
            if (roll < 4)
            {
                input.AimPoint = pitch.OpponentGoal(p.Team) + new Vec2(0f, ((float)rng.NextDouble() - 0.5f) * pitch.GoalWidth * 1.5f);
            }
            else if (roll < 7)
            {
                input.AimPoint = ball;
            }
            else
            {
                input.AimPoint = new Vec2(
                    ((float)rng.NextDouble() - 0.5f) * pitch.Width * 1.3f,
                    ((float)rng.NextDouble() - 0.5f) * pitch.Height * 1.3f);
            }
        }

        if (rng.Next(600) == 0) input.Move = new Vec2(float.NaN, float.PositiveInfinity);
        if (rng.Next(600) == 0) input.AimPoint = new Vec2(float.NegativeInfinity, float.NaN);
        if (rng.Next(600) == 0) input.Move = new Vec2(1e30f, -1e30f);

        if (rng.Next(25) == 0) input.Sprint = !input.Sprint;
        if (rng.Next(14) == 0) input.Shoot = !input.Shoot;
        input.Pass = rng.Next(40) == 0;
        input.Tackle = rng.Next(35) == 0;
        input.SwitchBest = false;
        input.SwitchNext = false;
    }

    // ------------------------------------------------------------------------------------
    //  Scene set-up (tests edit the public state directly)
    // ------------------------------------------------------------------------------------

    public static ref PlayerState P(Match match, int index) => ref match.State.Players[index];

    public static int Index(Match match, int team, int slot) => team * match.State.TeamSize + slot;

    public static int Keeper(Match match, int team) => Index(match, team, 0);

    /// <summary>
    /// A team's outfield footballers in kickoff priority order, worked out from the formation spots
    /// alone: most advanced first, then most central, then lowest slot.
    /// </summary>
    public static int[] KickoffOrder(Match match, int team) =>
        match.State.Players
            .Where(p => p.Team == team && !p.IsKeeper)
            .OrderByDescending(p => p.Spot.Depth)
            .ThenBy(p => MathF.Abs(p.Spot.Lateral))
            .ThenBy(p => p.Slot)
            .Select(p => p.Index)
            .ToArray();

    /// <summary>Speed factor a footballer has while the AI controls it.</summary>
    public static float AiSpeedFactor(Match match, int index)
    {
        ref readonly var p = ref match.State.Players[index];
        return p.IsKeeper
            ? match.Tuning.Keeper.SpeedFactor.Get(match.Config.KeeperLevel(p.Team))
            : match.Tuning.Ai.SpeedFactor.Get(match.Config.OutfieldLevel(p.Team));
    }

    /// <summary>
    /// Puts a footballer somewhere, at rest and free to act. Aim defaults to the goal they attack.
    /// A human-controlled footballer also gets neutral controls that keep that facing.
    /// </summary>
    public static void Place(Match match, int index, Vec2 pos, float? aim = null)
    {
        ref var p = ref P(match, index);
        p.Pos = pos;
        p.Vel = Vec2.Zero;
        p.Aim = aim ?? (p.Team == 0 ? 0f : MathF.PI);
        p.Action = PlayerAction.None;
        p.ActionTime = 0f;
        p.SlideHit = false;
        p.Charging = false;
        p.Charge = 0f;
        p.TackleCooldown = 0f;
        p.KickCooldown = 0f;
        p.StealLockout = 0f;
        p.Immune = 0f;
        p.Stamina = 1f;
        p.Exhausted = false;
        p.RegenDelay = 0f;
        p.Sprinting = false;
        if (p.Controller >= 0) match.SetInput(p.Controller, Input(aim: AimAhead(match, index)));
    }

    /// <summary>
    /// Moves every footballer except the listed ones out of the way: lined up along the top
    /// touchline of their own half (keepers included), where nothing in a test normally happens.
    /// </summary>
    public static void Park(Match match, params int[] keep)
    {
        var pitch = match.Pitch;
        for (int i = 0; i < match.State.Players.Length; i++)
        {
            if (Array.IndexOf(keep, i) >= 0) continue;
            ref var p = ref P(match, i);
            float x = pitch.HalfW - pitch.CornerRadius - 30f - p.Slot * 45f;
            Place(match, i, new Vec2(p.Team == 0 ? -x : x, -pitch.HalfH + 22f));
        }
    }

    /// <summary>
    /// Puts a human in control of a specific footballer by editing the control state directly,
    /// registering them with AddHuman first if needed, and gives them neutral controls. Use it for
    /// scene set-up only. Note that a first registration mid-match queues a Switch event which the
    /// next Step delivers: step once before counting Switch events.
    /// </summary>
    public static void Seat(Match match, int human, int index, bool autoSwitch = true)
    {
        var s = match.State;
        var h = s.Humans[human];
        ref var p = ref s.Players[index];
        Assert.False(p.IsKeeper, "a human never controls a goalkeeper");
        if (!h.Present) Assert.True(match.AddHuman(human, p.Team, autoSwitch) >= 0, $"AddHuman({human}) failed");
        Assert.True(h.Connected, $"human {human} is away");
        Assert.Equal(p.Team, h.Team);

        if (h.PlayerIndex != index)
        {
            Assert.Equal(-1, p.Controller);
            if (h.PlayerIndex >= 0)
            {
                ref var old = ref s.Players[h.PlayerIndex];
                old.Controller = -1;
                old.SpeedFactor = AiSpeedFactor(match, old.Index);
                old.Charging = false;
                old.Charge = 0f;
            }

            h.PlayerIndex = index;
            p.Controller = human;
            p.SpeedFactor = 1f;
            if (s.Ball.Owner == index && s.Ball.LastTouch == index) s.Ball.LastTouchHuman = human;
        }

        h.AutoSwitch = autoSwitch;
        h.SwitchCooldown = 0f;
        Face(match, human);
    }

    /// <summary>Hands the ball to a footballer as if they had brought it under control a while ago.</summary>
    public static void GiveBall(Match match, int index, float ownerTime = 1f)
    {
        ref var b = ref match.State.Ball;
        ref var p = ref P(match, index);
        var t = match.Tuning;
        b.Owner = index;
        b.OwnerTime = ownerTime;
        b.DribbleAngle = p.Aim;
        b.Pos = p.Pos + Vec2.FromAngle(p.Aim) * (t.Player.Radius + t.Ball.Radius + t.Ball.DribbleGap);
        b.Vel = p.Vel;
        b.Spin = 0f;
        b.Heat = 0f;
        b.Held = false;
        b.Dead = false;
        b.LastTouch = index;
        b.LastTouchHuman = p.Controller;
        b.LastTouchKind = TouchKind.Control;
        b.LastTouchTime = match.State.Time;
        b.PrevTouch = -1;
        b.PrevTouchHuman = -1;
        b.PrevTouchTime = 0d;
        b.PassTarget = -1;
        b.PassFrom = -1;
        b.OnTargetGoal = -1;
    }

    /// <summary>Sets the ball loose with a position and velocity. By default nobody has touched it.</summary>
    public static void FreeBall(Match match, Vec2 pos, Vec2 vel, int lastTouch = -1, TouchKind kind = TouchKind.None, float spin = 0f)
    {
        ref var b = ref match.State.Ball;
        b.Owner = -1;
        b.OwnerTime = 0f;
        b.Pos = pos;
        b.Vel = vel;
        b.Spin = spin;
        b.Heat = 0f;
        b.Held = false;
        b.Dead = false;
        b.LastTouch = lastTouch;
        b.LastTouchHuman = lastTouch >= 0 ? P(match, lastTouch).Controller : -1;
        b.LastTouchKind = lastTouch >= 0 ? kind : TouchKind.None;
        b.LastTouchTime = match.State.Time;
        b.PrevTouch = -1;
        b.PrevTouchHuman = -1;
        b.PrevTouchTime = 0d;
        b.PassTarget = -1;
        b.PassFrom = -1;
        b.OnTargetGoal = -1;
    }

    /// <summary>Distance a carried ball sits from its carrier's centre (not sprinting).</summary>
    public static float DribbleReach(Match match)
    {
        var t = match.Tuning;
        return t.Player.Radius + t.Ball.Radius + t.Ball.DribbleGap;
    }

    /// <summary>Distance at which a free ball touches a standing footballer.</summary>
    public static float ContactReach(Match match) => match.Tuning.Player.Radius + match.Tuning.Ball.Radius;

    // ------------------------------------------------------------------------------------
    //  Assertions
    // ------------------------------------------------------------------------------------

    public static void AssertNear(float expected, float actual, float tolerance, string? what = null)
    {
        if (!(MathF.Abs(expected - actual) <= tolerance))
        {
            Assert.Fail($"{what ?? "value"}: expected {expected} +- {tolerance}, got {actual}");
        }
    }

    public static void AssertNear(Vec2 expected, Vec2 actual, float tolerance, string? what = null)
    {
        if (!(Vec2.Distance(expected, actual) <= tolerance))
        {
            Assert.Fail($"{what ?? "point"}: expected ({expected.X}, {expected.Y}) +- {tolerance}, got ({actual.X}, {actual.Y})");
        }
    }

    /// <summary>True when a circle of this radius at this position lies inside the walls (within a tolerance).</summary>
    public static bool InsideWalls(PitchGeometry pitch, Vec2 pos, float radius, float tolerance = 0.05f) =>
        pos.IsFinite && Vec2.Distance(pitch.ClampCircle(pos, radius), pos) <= tolerance;

    /// <summary>True when the ball is on the pitch, in a goal mouth or inside one of the nets.</summary>
    public static bool BallInBounds(Match match, float tolerance = 0.05f)
    {
        var pitch = match.Pitch;
        Vec2 pos = match.State.Ball.Pos;
        float r = match.Tuning.Ball.Radius;
        if (!pos.IsFinite) return false;
        if (InsideWalls(pitch, pos, r, tolerance)) return true;
        return MathF.Abs(pos.Y) <= pitch.GoalHalf + tolerance &&
               MathF.Abs(pos.X) <= pitch.HalfW + pitch.GoalDepth - r + tolerance;
    }

    private static void Insane(Match match, string what) =>
        Assert.Fail($"{what} (tick {match.State.Tick}, phase {match.State.Phase})");

    /// <summary>The invariants that must hold after every tick of any match. Cheap enough to call every tick.</summary>
    public static void AssertSane(Match match)
    {
        var s = match.State;
        var t = match.Tuning;
        var players = s.Players;
        ref readonly var b = ref s.Ball;

        if (!double.IsFinite(s.Time) || !float.IsFinite(s.Clock) || !float.IsFinite(s.PhaseTime) || !float.IsFinite(s.Elapsed) ||
            s.Clock < 0f || s.PhaseTime < 0f || s.Elapsed < 0f)
        {
            Insane(match, "a clock is negative or not finite");
        }

        if (!Enum.IsDefined(s.Phase)) Insane(match, "unknown phase");
        if (s.Score[0] < 0 || s.Score[1] < 0) Insane(match, "negative score");
        if (s.Winner is < -1 or > 1) Insane(match, $"winner {s.Winner}");
        if (s.KickoffTeam is < 0 or > 1) Insane(match, $"kickoff team {s.KickoffTeam}");

        if (!(b.Pos.IsFinite && b.Vel.IsFinite && float.IsFinite(b.Spin) && float.IsFinite(b.Heat) &&
              float.IsFinite(b.OwnerTime) && float.IsFinite(b.DribbleAngle) && double.IsFinite(b.LastTouchTime) &&
              double.IsFinite(b.PrevTouchTime)))
        {
            Insane(match, "the ball is not finite");
        }

        if (!BallInBounds(match)) Insane(match, $"the ball is out of bounds at ({b.Pos.X}, {b.Pos.Y}), owner {b.Owner}, dead {b.Dead}");
        if (b.Vel.Length > t.Ball.MaxSpeed + 1f) Insane(match, $"ball speed {b.Vel.Length}");
        if (b.Spin is < -1f or > 1f) Insane(match, $"ball spin {b.Spin}");
        if (b.Heat is < 0f or > 1f) Insane(match, $"ball heat {b.Heat}");
        if (b.OwnerTime < 0f) Insane(match, "negative owner time");

        int n = players.Length;
        if (b.Owner < -1 || b.Owner >= n) Insane(match, $"ball owner {b.Owner}");
        if (b.LastTouch < -1 || b.LastTouch >= n) Insane(match, $"last touch {b.LastTouch}");
        if (b.PrevTouch < -1 || b.PrevTouch >= n) Insane(match, $"previous touch {b.PrevTouch}");
        if (b.PassTarget < -1 || b.PassTarget >= n) Insane(match, $"pass target {b.PassTarget}");
        if (b.PassFrom < -1 || b.PassFrom >= n) Insane(match, $"pass from {b.PassFrom}");
        if (b.LastTouchHuman is < -1 or > 3 || b.PrevTouchHuman is < -1 or > 3) Insane(match, "touch human out of range");
        if (b.OnTargetGoal is < -1 or > 1) Insane(match, $"on-target goal {b.OnTargetGoal}");
        if (b.PassTarget >= 0 && b.PassFrom < 0) Insane(match, "a pass target without a passer");

        if (b.Held)
        {
            if (b.Owner < 0 || !players[b.Owner].IsKeeper) Insane(match, "only a keeper can hold the ball");
            else if (!match.Pitch.InBox(players[b.Owner].Pos, players[b.Owner].Team)) Insane(match, "the ball is held outside the keeper's box");
        }

        if (b.Dead)
        {
            if (b.Owner != -1) Insane(match, "a dead ball has an owner");
            if (s.Phase is MatchPhase.Intro or MatchPhase.Kickoff or MatchPhase.Playing) Insane(match, "the ball is dead outside a goal pause");
        }

        for (int i = 0; i < n; i++)
        {
            ref readonly var p = ref players[i];
            if (!(p.Pos.IsFinite && p.Vel.IsFinite && float.IsFinite(p.Aim) && float.IsFinite(p.Stamina) &&
                  float.IsFinite(p.Charge) && float.IsFinite(p.ActionTime) && p.ActionDir.IsFinite &&
                  float.IsFinite(p.TackleCooldown) && float.IsFinite(p.KickCooldown) && float.IsFinite(p.StealLockout) &&
                  float.IsFinite(p.Immune) && float.IsFinite(p.RegenDelay) && float.IsFinite(p.SpeedFactor)))
            {
                Insane(match, $"footballer {i} is not finite");
            }

            if (!InsideWalls(match.Pitch, p.Pos, t.Player.Radius)) Insane(match, $"footballer {i} is outside the walls at ({p.Pos.X}, {p.Pos.Y})");
            if (p.Stamina is < 0f or > 1f) Insane(match, $"footballer {i} stamina {p.Stamina}");
            if (p.Charge is < 0f or > 1f) Insane(match, $"footballer {i} charge {p.Charge}");
            if (p.TackleCooldown < 0f || p.KickCooldown < 0f || p.StealLockout < 0f || p.Immune < 0f) Insane(match, $"footballer {i} has a negative timer");
            if (!Enum.IsDefined(p.Action)) Insane(match, $"footballer {i} unknown action");
            if (p.Controller is < -1 or > 3) Insane(match, $"footballer {i} controller {p.Controller}");
            if (p.IsKeeper && p.Controller != -1) Insane(match, $"keeper {i} is human-controlled");
            if (p.Index != i || p.Team != i / s.TeamSize || p.Slot != i % s.TeamSize) Insane(match, $"footballer {i} lost its identity");

            // Control is a bijection between humans at the controls and the footballers they drive.
            if (p.Controller >= 0)
            {
                if (s.Humans[p.Controller].PlayerIndex != i) Insane(match, $"footballer {i} claims human {p.Controller}, who controls {s.Humans[p.Controller].PlayerIndex}");
                if (p.SpeedFactor != 1f) Insane(match, $"human-controlled footballer {i} has speed factor {p.SpeedFactor}");
            }
            else if (p.SpeedFactor != AiSpeedFactor(match, i))
            {
                Insane(match, $"AI footballer {i} has speed factor {p.SpeedFactor}");
            }
        }

        int home = 0, away = 0;
        foreach (var h in s.Humans)
        {
            if (h.Present)
            {
                if (h.Team == 0) home++;
                else away++;
            }

            if (!h.Present && (h.Connected || h.PlayerIndex != -1)) Insane(match, $"human {h.Id} is not present but active");
            if (h.Present && h.Connected && h.PlayerIndex < 0) Insane(match, $"human {h.Id} is at the controls without a footballer");
            if (h.PlayerIndex < 0) continue;
            if (!(h.Present && h.Connected)) Insane(match, $"human {h.Id} controls a footballer while away");
            if (players[h.PlayerIndex].Controller != h.Id) Insane(match, $"human {h.Id} controls footballer {h.PlayerIndex}, who obeys {players[h.PlayerIndex].Controller}");
            if (players[h.PlayerIndex].Team != h.Team) Insane(match, $"human {h.Id} controls an opponent");
            if (!float.IsFinite(h.SwitchCooldown) || h.SwitchCooldown < 0f) Insane(match, $"human {h.Id} switch cooldown {h.SwitchCooldown}");
        }

        if (home > 2 || away > 2) Insane(match, "more than two humans on a team");
    }

    /// <summary>Asserts that two matches are in exactly the same state, bit for bit.</summary>
    public static void AssertSameState(Match first, Match second)
    {
        var a = first.State;
        var b = second.State;
        string at = $" at tick {a.Tick}";

        Assert.True(a.Tick == b.Tick, "tick" + at);
        Assert.True(a.Time == b.Time, "time" + at);
        Assert.True(a.Phase == b.Phase, "phase" + at);
        Assert.True(a.PhaseTime == b.PhaseTime, "phase time" + at);
        Assert.True(a.Clock == b.Clock, "clock" + at);
        Assert.True(a.Elapsed == b.Elapsed, "elapsed" + at);
        Assert.True(a.Overtime == b.Overtime && a.SlowMo == b.SlowMo, "overtime / slow motion" + at);
        Assert.True(a.Score[0] == b.Score[0] && a.Score[1] == b.Score[1], "score" + at);
        Assert.True(a.KickoffTeam == b.KickoffTeam && a.Winner == b.Winner && a.TeamSize == b.TeamSize, "kickoff team / winner" + at);

        ref readonly var x = ref a.Ball;
        ref readonly var y = ref b.Ball;
        Assert.True(x.Pos == y.Pos && x.Vel == y.Vel && x.Spin == y.Spin && x.Heat == y.Heat, "ball motion" + at);
        Assert.True(x.Owner == y.Owner && x.OwnerTime == y.OwnerTime && x.DribbleAngle == y.DribbleAngle &&
                    x.Held == y.Held && x.Dead == y.Dead, "ball ownership" + at);
        Assert.True(x.LastTouch == y.LastTouch && x.LastTouchHuman == y.LastTouchHuman && x.LastTouchKind == y.LastTouchKind &&
                    x.LastTouchTime == y.LastTouchTime && x.PrevTouch == y.PrevTouch && x.PrevTouchHuman == y.PrevTouchHuman &&
                    x.PrevTouchTime == y.PrevTouchTime, "ball touches" + at);
        Assert.True(x.PassTarget == y.PassTarget && x.PassFrom == y.PassFrom && x.OnTargetGoal == y.OnTargetGoal, "ball pass state" + at);

        Assert.Equal(a.Players.Length, b.Players.Length);
        for (int i = 0; i < a.Players.Length; i++)
        {
            ref readonly var p = ref a.Players[i];
            ref readonly var q = ref b.Players[i];
            string who = $"footballer {i}{at}: ";
            Assert.True(p.Pos == q.Pos && p.Vel == q.Vel && p.Aim == q.Aim, who + "kinematics");
            Assert.True(p.Action == q.Action && p.ActionTime == q.ActionTime && p.ActionDir == q.ActionDir && p.SlideHit == q.SlideHit, who + "action");
            Assert.True(p.Stamina == q.Stamina && p.Exhausted == q.Exhausted && p.RegenDelay == q.RegenDelay && p.Sprinting == q.Sprinting, who + "stamina");
            Assert.True(p.Charging == q.Charging && p.Charge == q.Charge, who + "charge");
            Assert.True(p.TackleCooldown == q.TackleCooldown && p.KickCooldown == q.KickCooldown &&
                        p.StealLockout == q.StealLockout && p.Immune == q.Immune, who + "timers");
            Assert.True(p.Controller == q.Controller && p.SpeedFactor == q.SpeedFactor, who + "control");
        }

        for (int id = 0; id < a.Humans.Length; id++)
        {
            var h = a.Humans[id];
            var k = b.Humans[id];
            Assert.True(h.Present == k.Present && h.Connected == k.Connected && h.Team == k.Team && h.AutoSwitch == k.AutoSwitch &&
                        h.PlayerIndex == k.PlayerIndex && h.SwitchCooldown == k.SwitchCooldown, $"human {id}{at}");
        }

        for (int team = 0; team < 2; team++) AssertSameStats(first.Stats.Teams[team], second.Stats.Teams[team], $"team {team} stats{at}");
        for (int id = 0; id < 4; id++) AssertSameStats(first.Stats.Humans[id], second.Stats.Humans[id], $"human {id} stats{at}");
        Assert.True(first.Stats.Goals.Count == second.Stats.Goals.Count, "goal records" + at);
    }

    private static void AssertSameStats(StatLine a, StatLine b, string what) =>
        Assert.True(a.Goals == b.Goals && a.OwnGoals == b.OwnGoals && a.Assists == b.Assists && a.Shots == b.Shots &&
                    a.ShotsOnTarget == b.ShotsOnTarget && a.Saves == b.Saves && a.Tackles == b.Tackles && a.Steals == b.Steals &&
                    a.PassesAttempted == b.PassesAttempted && a.PassesCompleted == b.PassesCompleted &&
                    a.PossessionTime == b.PossessionTime, what);
}
