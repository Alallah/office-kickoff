namespace OfficeKickoff.Sim;

/// <summary>Numeric values are part of the wire protocol (see protocol.js). Do not renumber.</summary>
public enum MatchPhase : byte
{
    /// <summary>"Team A vs Team B" splash before the first kickoff. Footballers are frozen.</summary>
    Intro = 0,

    /// <summary>Kickoff countdown. Footballers are frozen at their kickoff positions (they can still aim).</summary>
    Kickoff = 1,

    /// <summary>Open play. The clock runs.</summary>
    Playing = 2,

    /// <summary>A goal was just scored: slow motion, then celebration. Footballers move freely, the ball is dead.</summary>
    GoalScored = 3,

    /// <summary>The simulation is paused while clients show the goal replay.</summary>
    Replay = 4,

    /// <summary>Final whistle hold before the results screen. Inputs are ignored.</summary>
    FullTime = 5,

    /// <summary>The match is over; <see cref="Match.Step"/> does nothing.</summary>
    Ended = 6,
}

/// <summary>Numeric values are part of the wire protocol (see protocol.js). Do not renumber.</summary>
public enum PlayerAction : byte
{
    None = 0,

    /// <summary>Slide tackle in progress (committed, cannot steer).</summary>
    Slide = 1,

    /// <summary>Burst of speed while carrying the ball (tackle-immune).</summary>
    Dash = 2,

    /// <summary>Goalkeeper dive.</summary>
    Dive = 3,

    /// <summary>Knocked down or dizzy: no control at all.</summary>
    Stunned = 4,

    /// <summary>Getting back up after a successful slide or a dive: no control, short.</summary>
    Recover = 5,
}

/// <summary>How the ball was last touched (see <see cref="BallState.LastTouchKind"/>).</summary>
public enum TouchKind : byte
{
    None = 0,

    /// <summary>Brought under control: trap, steal, tackle win, kickoff.</summary>
    Control = 1,

    /// <summary>Struck on purpose: shot or pass.</summary>
    Strike = 2,

    /// <summary>Uncontrolled contact: a deflection off a footballer, or a keeper's parry.</summary>
    Deflect = 3,

    /// <summary>Caught by a goalkeeper.</summary>
    Catch = 4,
}

/// <summary>
/// One footballer. Team 0 occupies indices [0, TeamSize) of <see cref="MatchState.Players"/> and
/// team 1 occupies [TeamSize, 2*TeamSize). Within a team, slot 0 is the goalkeeper and slots
/// 1.. are outfield footballers in formation order (defence to attack). In a match without
/// goalkeepers (MatchSettings.Keepers off) nobody is a keeper: slot 0 is an outfield sweeper.
/// Always test <see cref="IsKeeper"/>, never the slot.
/// </summary>
public struct PlayerState
{
    // ---- identity: constant for the whole match -------------------------------------------
    public int Index;
    public int Team;
    public int Slot;
    public bool IsKeeper;

    /// <summary>Formation spot of an outfield footballer, the sweeper included (default for the keeper).</summary>
    public FormationSpot Spot;

    /// <summary>Formation position in the team's own half; also the kickoff position.</summary>
    public Vec2 HomePos;

    /// <summary>Keeper only: dive speed and dive cooldown for the configured keeper difficulty.</summary>
    public float DiveSpeed;
    public float DiveCooldown;

    // ---- kinematics -----------------------------------------------------------------------
    public Vec2 Pos;
    public Vec2 Vel;

    /// <summary>Facing direction (radians). Humans face the mouse cursor.</summary>
    public float Aim;

    // ---- action state ---------------------------------------------------------------------
    public PlayerAction Action;

    /// <summary>Seconds remaining of <see cref="Action"/>.</summary>
    public float ActionTime;

    /// <summary>Unit direction of the current slide, dash or dive.</summary>
    public Vec2 ActionDir;

    /// <summary>Set by the match when the current slide has touched the ball or an opponent.</summary>
    public bool SlideHit;

    // ---- stamina --------------------------------------------------------------------------
    /// <summary>0..1.</summary>
    public float Stamina;

    /// <summary>True after stamina hit zero until it recovers past PlayerTuning.ExhaustedRecover.</summary>
    public bool Exhausted;

    /// <summary>Seconds until stamina starts regenerating.</summary>
    public float RegenDelay;

    /// <summary>True while actually sprinting this tick (for visuals).</summary>
    public bool Sprinting;

    // ---- shooting -------------------------------------------------------------------------
    public bool Charging;

    /// <summary>0..1 shot charge while <see cref="Charging"/>.</summary>
    public float Charge;

    // ---- timers (seconds remaining) -------------------------------------------------------
    /// <summary>Shared slide / dash / dive cooldown.</summary>
    public float TackleCooldown;

    /// <summary>The player cannot trap the ball (set after kicking it).</summary>
    public float KickCooldown;

    /// <summary>The player cannot steal by touch (set after being robbed).</summary>
    public float StealLockout;

    /// <summary>The player cannot be hit by slide tackles (set by a dash).</summary>
    public float Immune;

    // ---- control --------------------------------------------------------------------------
    /// <summary>-1 = AI, otherwise the id (0..3) of the human controlling this footballer.</summary>
    public int Controller;

    /// <summary>Movement speed multiplier: 1 for humans, the AI/keeper difficulty factor otherwise.</summary>
    public float SpeedFactor;
}

public struct BallState
{
    public Vec2 Pos;
    public Vec2 Vel;

    /// <summary>-1..1. A spinning free ball's heading rotates by Spin * BallTuning.CurveRate rad/s.</summary>
    public float Spin;

    /// <summary>Index of the footballer carrying the ball, or -1 when it is free.</summary>
    public int Owner;

    /// <summary>Seconds the current owner has had the ball.</summary>
    public float OwnerTime;

    /// <summary>Angle of the dribbled ball around its owner; eases towards the owner's aim.</summary>
    public float DribbleAngle;

    /// <summary>
    /// True while a goalkeeper holds the ball in the hands inside their own box: it cannot be stolen
    /// or tackled away, and opponents are kept out of the box.
    /// </summary>
    public bool Held;

    /// <summary>0..1 power of the last strike; decays over time. Visual signal (trail, fire).</summary>
    public float Heat;

    /// <summary>True from a goal until the next kickoff: the ball rests in the net and cannot be played.</summary>
    public bool Dead;

    /// <summary>Last footballer to touch the ball (-1 = nobody since kickoff) and who controlled them then (-1 = AI).</summary>
    public int LastTouch;
    public int LastTouchHuman;

    /// <summary>What kind of touch <see cref="LastTouch"/> was.</summary>
    public TouchKind LastTouchKind;

    /// <summary><see cref="MatchState.Time"/> of the last touch.</summary>
    public double LastTouchTime;

    /// <summary>The previous toucher that was a different footballer (for assists).</summary>
    public int PrevTouch;
    public int PrevTouchHuman;
    public double PrevTouchTime;

    /// <summary>Footballer a pass in flight is intended for (-1 = none). Cleared when anyone touches the ball.</summary>
    public int PassTarget;

    /// <summary>Footballer who played the pass in flight (-1 = none).</summary>
    public int PassFrom;

    /// <summary>
    /// When a strike is heading into a goal mouth: the team DEFENDING that goal, otherwise -1.
    /// Cleared on the next touch or wall bounce. Used for the saves / shots-on-target stats.
    /// </summary>
    public int OnTargetGoal;
}

/// <summary>One of the (up to four) humans in a match.</summary>
public sealed class HumanSlot
{
    public HumanSlot(int id) => Id = id;

    /// <summary>0..3, stable for the whole match.</summary>
    public int Id { get; }

    /// <summary>A human occupies this slot in this match.</summary>
    public bool Present;

    /// <summary>
    /// False while the human is away (disconnected, tab in the background, not sending inputs);
    /// their footballer is AI-controlled meanwhile.
    /// </summary>
    public bool Connected;

    public int Team;

    /// <summary>Defensive auto-switching preference.</summary>
    public bool AutoSwitch = true;

    /// <summary>Footballer currently controlled, or -1 (not present / disconnected).</summary>
    public int PlayerIndex = -1;

    /// <summary>Seconds until the next automatic switch is allowed for this human.</summary>
    public float SwitchCooldown;
}

/// <summary>The complete mutable state of a match. Callers outside the simulation treat it as read-only.</summary>
public sealed class MatchState
{
    /// <summary>Number of <see cref="Match.Step"/> calls so far.</summary>
    public int Tick;

    /// <summary>Accumulated simulation seconds (scaled by game speed and slow motion).</summary>
    public double Time;

    public MatchPhase Phase;

    /// <summary>Real seconds remaining in the current phase (0 while Playing).</summary>
    public float PhaseTime;

    /// <summary>
    /// Timed match: real seconds of regulation remaining (0 once regulation is over).
    /// Practice mode: real seconds played so far.
    /// </summary>
    public float Clock;

    /// <summary>Real seconds of open play so far (goal timestamps).</summary>
    public float Elapsed;

    /// <summary>True once regulation ended level and golden goal is being played.</summary>
    public bool Overtime;

    /// <summary>True while the post-goal slow motion is active.</summary>
    public bool SlowMo;

    public int[] Score = new int[2];

    /// <summary>Team that takes the current / next kickoff.</summary>
    public int KickoffTeam;

    /// <summary>0 or 1 once decided; -1 while undecided or for a draw.</summary>
    public int Winner = -1;

    public int TeamSize;
    public PlayerState[] Players = [];
    public BallState Ball;
    public HumanSlot[] Humans = [new(0), new(1), new(2), new(3)];
}
