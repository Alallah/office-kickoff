namespace OfficeKickoff.Sim;

// =====================================================================================
//  TUNING - every gameplay number lives in this one file.
//
//  Units: distances are world units (a footballer is 40 units wide), speeds are units
//  per second, times are seconds, angles are radians unless the name says "Deg".
//
//  Any value can be overridden without recompiling from appsettings.json, e.g.
//      "Tuning": { "Player": { "RunSpeed": 310 }, "Keeper": { "DiveSpeed": { "Hard": 900 } } }
//  The whole object is also sent to the browser at match start so client-side prediction
//  uses exactly the same numbers as the server.
// =====================================================================================

/// <summary>A value that differs per AI difficulty level.</summary>
public sealed class PerLevel
{
    public float Easy { get; set; }
    public float Normal { get; set; }
    public float Hard { get; set; }

    public PerLevel() { }

    public PerLevel(float easy, float normal, float hard)
    {
        Easy = easy;
        Normal = normal;
        Hard = hard;
    }

    public float Get(AiLevel level) => level switch
    {
        AiLevel.Easy => Easy,
        AiLevel.Hard => Hard,
        _ => Normal,
    };
}

/// <summary>A value that differs per team size (3-a-side .. 7-a-side, keeper included).</summary>
public sealed class PerSize
{
    public float S3 { get; set; }
    public float S4 { get; set; }
    public float S5 { get; set; }
    public float S6 { get; set; }
    public float S7 { get; set; }

    public PerSize() { }

    public PerSize(float s3, float s4, float s5, float s6, float s7)
    {
        S3 = s3;
        S4 = s4;
        S5 = s5;
        S6 = s6;
        S7 = s7;
    }

    public float Get(int teamSize) => teamSize switch
    {
        <= 3 => S3,
        4 => S4,
        5 => S5,
        6 => S6,
        _ => S7,
    };
}

public sealed class Tuning
{
    /// <summary>Fixed simulation rate. Not tunable: client prediction assumes it.</summary>
    public const int TickRate = 60;

    /// <summary>Seconds of real time per simulation tick.</summary>
    public const float TickSeconds = 1f / TickRate;

    /// <summary>A snapshot is broadcast every N ticks (2 = 30 Hz).</summary>
    public int SnapshotEveryTicks { get; set; } = 2;

    public PitchTuning Pitch { get; set; } = new();
    public PlayerTuning Player { get; set; } = new();
    public BallTuning Ball { get; set; } = new();
    public KickTuning Kick { get; set; } = new();
    public TackleTuning Tackle { get; set; } = new();
    public KeeperTuning Keeper { get; set; } = new();
    public AiTuning Ai { get; set; } = new();
    public SwitchTuning Switch { get; set; } = new();
    public RulesTuning Rules { get; set; } = new();
    public MvpTuning Mvp { get; set; } = new();
}

public sealed class PitchTuning
{
    /// <summary>Playable width (goal line to goal line) per team size.</summary>
    public PerSize Width { get; set; } = new(1150, 1320, 1500, 1680, 1860);

    /// <summary>Playable height (touchline to touchline) per team size.</summary>
    public PerSize Height { get; set; } = new(720, 830, 940, 1040, 1130);

    /// <summary>Goal mouth opening per team size.</summary>
    public PerSize GoalWidth { get; set; } = new(180, 195, 210, 225, 240);

    /// <summary>Goal mouth width multiplier for matches played without goalkeepers (0..1].</summary>
    public float NoKeeperGoalScale { get; set; } = 0.6f;

    /// <summary>How far the net extends behind the goal line.</summary>
    public float GoalDepth { get; set; } = 64;

    public float PostRadius { get; set; } = 9;

    /// <summary>Radius of the rounded pitch corners (keeps the ball from sticking in corners).</summary>
    public float CornerRadius { get; set; } = 110;

    /// <summary>Keeper box: how far it extends from the goal line.</summary>
    public float BoxDepth { get; set; } = 190;

    /// <summary>Keeper box: extra width beyond each post.</summary>
    public float BoxExtraWidth { get; set; } = 140;

    public float CenterRadius { get; set; } = 125;

    /// <summary>Fraction of the ball's speed kept along the wall normal after a bounce.</summary>
    public float WallBounce { get; set; } = 0.80f;

    /// <summary>Fraction of the ball's speed kept along the wall tangent after a bounce.</summary>
    public float WallFriction { get; set; } = 0.97f;

    /// <summary>Bounce off the net (very soft so the ball settles in the goal).</summary>
    public float NetBounce { get; set; } = 0.20f;
}

public sealed class PlayerTuning
{
    public float Radius { get; set; } = 20;
    public float RunSpeed { get; set; } = 290;
    public float SprintSpeed { get; set; } = 395;

    /// <summary>Acceleration while a move input is held.</summary>
    public float Accel { get; set; } = 2600;

    /// <summary>Deceleration when the stick is released.</summary>
    public float Decel { get; set; } = 2200;

    /// <summary>Top-speed multiplier while carrying the ball.</summary>
    public float DribbleSpeedFactor { get; set; } = 0.94f;

    /// <summary>Top-speed multiplier while charging a shot.</summary>
    public float ChargeMoveFactor { get; set; } = 0.65f;

    /// <summary>Stamina (0..1) drained per second of sprinting.</summary>
    public float SprintDrain { get; set; } = 0.28f;

    /// <summary>Stamina regained per second once regeneration has started.</summary>
    public float StaminaRegen { get; set; } = 0.22f;

    /// <summary>Delay after the last sprint/dash before stamina regenerates.</summary>
    public float RegenDelay { get; set; } = 0.6f;

    /// <summary>After hitting zero, sprint is locked until stamina climbs back to this.</summary>
    public float ExhaustedRecover { get; set; } = 0.3f;

    /// <summary>Exponential velocity decay (per second) while stunned or recovering.</summary>
    public float StunFriction { get; set; } = 5.0f;
}

public sealed class BallTuning
{
    public float Radius { get; set; } = 11;

    /// <summary>Exponential drag per second on a free ball.</summary>
    public float Drag { get; set; } = 0.60f;

    /// <summary>Constant rolling deceleration.</summary>
    public float RollFriction { get; set; } = 28;

    /// <summary>Below this speed a free ball stops dead.</summary>
    public float StopSpeed { get; set; } = 5;

    /// <summary>Hard cap on ball speed (must stay above ShotMaxSpeed * the largest ball-speed setting).</summary>
    public float MaxSpeed { get; set; } = 2400;

    /// <summary>Radians per second the ball's heading rotates at spin = 1.</summary>
    public float CurveRate { get; set; } = 1.1f;

    /// <summary>Exponential spin decay per second.</summary>
    public float SpinDecay { get; set; } = 0.85f;

    /// <summary>Restitution when a fast ball deflects off a footballer.</summary>
    public float PlayerBounce { get; set; } = 0.45f;

    /// <summary>A free ball is trapped on contact when it is slower than this relative to the player; faster balls deflect.</summary>
    public float ControlSpeed { get; set; } = 820;

    /// <summary>Gap between the carrier's body and the dribbled ball.</summary>
    public float DribbleGap { get; set; } = 3;

    /// <summary>Extra gap while sprinting (looser control, easier to steal).</summary>
    public float SprintDribbleGap { get; set; } = 9;

    /// <summary>Radians per second the dribbled ball orbits the carrier towards the aim direction.</summary>
    public float DribbleTurnRate { get; set; } = 12;

    /// <summary>After gaining the ball, the carrier cannot be robbed by touch for this long.</summary>
    public float OwnerProtectTime { get; set; } = 0.22f;

    /// <summary>After losing the ball to a touch-steal, the previous carrier cannot steal back for this long.</summary>
    public float StealLockout { get; set; } = 0.55f;

    /// <summary>Extra reach (beyond the two radii) for touch-steals and traps.</summary>
    public float StealMargin { get; set; } = 3;

    /// <summary>Ball heat (0..1, set by shot power) lost per second. Purely a visual signal.</summary>
    public float HeatDecay { get; set; } = 0.5f;
}

public sealed class KickTuning
{
    /// <summary>Seconds of holding the button to reach full power.</summary>
    public float ChargeTime { get; set; } = 0.8f;

    public float ShotMinSpeed { get; set; } = 660;
    public float ShotMaxSpeed { get; set; } = 1500;

    public float PassMinSpeed { get; set; } = 440;
    public float PassMaxSpeed { get; set; } = 1050;

    /// <summary>Passes are weighted so the ball reaches the receiver at about this speed.</summary>
    public float PassArriveSpeed { get; set; } = 380;

    /// <summary>Half-angle of the cone (around the aim direction) searched for a pass target.</summary>
    public float PassConeDeg { get; set; } = 50;

    /// <summary>Team-mates whose angle is within this of the best-aligned one count as tied; the nearest of them gets the pass.</summary>
    public float PassTieDeg { get; set; } = 6;

    /// <summary>How much of the receiver's movement a pass leads (0 = to feet, 1 = full lead).</summary>
    public float PassLead { get; set; } = 0.7f;

    /// <summary>Extra reach (beyond the two radii) for first-time shots and passes on a loose ball.</summary>
    public float KickReach { get; set; } = 18;

    /// <summary>After kicking, the kicker cannot re-trap the ball for this long.</summary>
    public float KickCooldown { get; set; } = 0.3f;

    /// <summary>Spin gained per unit of sideways movement (relative to run speed) at release.</summary>
    public float CurveFromMove { get; set; } = 1.0f;

    /// <summary>A pass or shot pressed just before receiving the ball is remembered this long and played first-time.</summary>
    public float BufferTime { get; set; } = 0.18f;

    /// <summary>Fraction of the kicker's velocity added to the ball.</summary>
    public float InheritVelocity { get; set; } = 0.2f;

    /// <summary>Shots charged at or above this are "on fire" (visual and audio flourish).</summary>
    public float FireThreshold { get; set; } = 0.85f;
}

public sealed class TackleTuning
{
    public float SlideSpeed { get; set; } = 640;
    public float SlideEndSpeed { get; set; } = 250;
    public float SlideTime { get; set; } = 0.36f;

    /// <summary>Shared cooldown for slide tackle and dash, counted from the start of the move.</summary>
    public float Cooldown { get; set; } = 1.6f;

    /// <summary>Stun suffered by a slider who touched neither ball nor opponent.</summary>
    public float MissStun { get; set; } = 0.55f;

    /// <summary>Short recovery after a successful slide.</summary>
    public float HitRecover { get; set; } = 0.12f;

    /// <summary>Stun for a ball carrier who is slid into.</summary>
    public float VictimStun { get; set; } = 0.7f;

    /// <summary>Stun for a player without the ball who is slid into.</summary>
    public float BumpStun { get; set; } = 0.4f;

    /// <summary>Speed given to a player who is slid into.</summary>
    public float Knockback { get; set; } = 380;

    /// <summary>Extra ball reach while sliding.</summary>
    public float SlideReach { get; set; } = 6;

    /// <summary>Speed at which the ball spills when its carrier is slid into bodily.</summary>
    public float LooseBallSpeed { get; set; } = 320;

    public float DashSpeed { get; set; } = 610;
    public float DashTime { get; set; } = 0.2f;

    /// <summary>Seconds of tackle immunity granted by a dash.</summary>
    public float DashImmune { get; set; } = 0.26f;

    public float DashStaminaCost { get; set; } = 0.2f;
}

public sealed class KeeperTuning
{
    /// <summary>Delay between a shot being struck and the keeper reacting.</summary>
    public PerLevel Reaction { get; set; } = new(0.34f, 0.24f, 0.15f);

    public PerLevel DiveSpeed { get; set; } = new(540, 680, 820);
    public float DiveTime { get; set; } = 0.36f;
    public float DiveRecover { get; set; } = 0.4f;
    public PerLevel DiveCooldown { get; set; } = new(1.4f, 1.0f, 0.75f);

    /// <summary>Extra ball reach while diving.</summary>
    public PerLevel Reach { get; set; } = new(6, 12, 15);

    /// <summary>The keeper catches balls slower than this and parries faster ones.</summary>
    public PerLevel CatchSpeed { get; set; } = new(720, 920, 1150);

    /// <summary>Keeper movement speed relative to an outfield human.</summary>
    public PerLevel SpeedFactor { get; set; } = new(0.80f, 0.90f, 1.0f);

    /// <summary>Random positional error, in units.</summary>
    public PerLevel PositionError { get; set; } = new(30, 14, 7);

    /// <summary>How long the keeper holds a caught ball before distributing it.</summary>
    public float HoldTime { get; set; } = 1.2f;

    /// <summary>Hard cap on holding; the simulation forces a release after this.</summary>
    public float MaxHoldTime { get; set; } = 3.0f;

    public float ParryBounce { get; set; } = 0.5f;

    /// <summary>Resting distance in front of the goal line.</summary>
    public float LineOffset { get; set; } = 34;

    /// <summary>How far off the line the keeper advances to narrow the angle.</summary>
    public float MaxAdvance { get; set; } = 120;

    /// <summary>The keeper comes out for loose balls closer than this to the goal centre.</summary>
    public float ClaimRange { get; set; } = 170;

    /// <summary>Speed at which opponents are moved out of the box while the keeper holds the ball.</summary>
    public float SanctuaryPush { get; set; } = 800;
}

public sealed class AiTuning
{
    /// <summary>AI outfield movement speed relative to a human.</summary>
    public PerLevel SpeedFactor { get; set; } = new(0.85f, 0.93f, 1.0f);

    /// <summary>Seconds between AI decisions.</summary>
    public PerLevel Reaction { get; set; } = new(0.45f, 0.27f, 0.14f);

    /// <summary>Random error (radians) on AI shots and passes.</summary>
    public PerLevel AimError { get; set; } = new(0.22f, 0.11f, 0.045f);

    /// <summary>Chance of attempting a slide tackle when the opportunity arises.</summary>
    public PerLevel TackleChance { get; set; } = new(0.0f, 0.3f, 0.7f);

    /// <summary>Distance from goal inside which an AI carrier will shoot.</summary>
    public PerLevel ShootRange { get; set; } = new(360, 430, 500);

    /// <summary>Distance at which the nearest AI defender closes down the ball carrier.</summary>
    public PerLevel PressRange { get; set; } = new(200, 300, 420);

    /// <summary>How readily the AI sprints (0 = never, 1 = whenever useful).</summary>
    public PerLevel SprintUse { get; set; } = new(0.25f, 0.6f, 1.0f);

    /// <summary>Seconds an AI carrier keeps the ball before looking for a pass (humans decide games).</summary>
    public float HoldBeforePass { get; set; } = 0.6f;

    /// <summary>Chance, at each AI decision, that the presser goes in for the ball rather than standing off goal side.</summary>
    public PerLevel PressCommit { get; set; } = new(0.2f, 0.35f, 0.55f);

    /// <summary>Chance that an AI carrier dashes out of the way of an incoming slide tackle.</summary>
    public PerLevel DodgeChance { get; set; } = new(0f, 0f, 0.5f);

    /// <summary>Chance that an AI footballer arriving on a loose ball near goal strikes it first time.</summary>
    public PerLevel FinishChance { get; set; } = new(0.15f, 0.35f, 0.6f);

    /// <summary>Shot power (0..1 charge) an AI uses close to goal; it rises to full power at ShootRange.</summary>
    public PerLevel ShotCharge { get; set; } = new(0.4f, 0.55f, 0.65f);

    /// <summary>How far goal side of an opponent an AI marker stands.</summary>
    public float MarkDistance { get; set; } = 85f;

    /// <summary>An opponent this close to an AI carrier counts as pressure (look to pass).</summary>
    public float PressureDistance { get; set; } = 85f;

    /// <summary>Ball stuck in one patch (StalemateRadius) this long: the AI clears it upfield.</summary>
    public float StalemateTime { get; set; } = 2.0f;

    public float StalemateRadius { get; set; } = 100f;
}

public sealed class SwitchTuning
{
    /// <summary>Seconds between defensive auto-switch evaluations.</summary>
    public float AutoInterval { get; set; } = 0.75f;

    /// <summary>An AI team-mate must be this much closer to the ball (ratio) to take over control.</summary>
    public float AutoRatio { get; set; } = 0.62f;

    /// <summary>...and within this distance of the ball.</summary>
    public float AutoRange { get; set; } = 420;

    /// <summary>Minimum seconds between two auto-switches for the same human.</summary>
    public float MinGap { get; set; } = 0.5f;

    /// <summary>After a manual switch, auto-switch leaves that human alone for this long.</summary>
    public float ManualHold { get; set; } = 2.0f;
}

public sealed class RulesTuning
{
    /// <summary>"Team A vs Team B" splash before the first kickoff.</summary>
    public float IntroTime { get; set; } = 3.5f;

    /// <summary>Countdown before the first kickoff and before golden goal.</summary>
    public float KickoffCountdown { get; set; } = 3.0f;

    /// <summary>Countdown before kickoffs that follow a goal.</summary>
    public float RestartCountdown { get; set; } = 2.0f;

    /// <summary>Length of the goal celebration when celebrations are enabled.</summary>
    public float GoalCelebrationTime { get; set; } = 3.2f;

    /// <summary>Length of the goal pause when celebrations are disabled.</summary>
    public float GoalShortTime { get; set; } = 1.6f;

    /// <summary>Real seconds of slow motion right after a goal.</summary>
    public float GoalSlowMoTime { get; set; } = 0.9f;

    public float GoalSlowMoScale { get; set; } = 0.3f;

    /// <summary>Real seconds the simulation pauses while clients show the replay.</summary>
    public float ReplayTime { get; set; } = 4.6f;

    /// <summary>Seconds of play before the goal shown in the replay.</summary>
    public float ReplayFootage { get; set; } = 3.3f;

    /// <summary>Seconds of play after the goal shown in the replay.</summary>
    public float ReplayTail { get; set; } = 0.45f;

    /// <summary>"Full time" hold before the results screen.</summary>
    public float FullTimeHold { get; set; } = 3.5f;

    /// <summary>A pass counts as an assist if the goal comes within this many seconds.</summary>
    public float AssistWindow { get; set; } = 7.0f;

    /// <summary>
    /// A shot that goes in off a defender (deflection, parry, fumbled catch) within this many seconds
    /// of the strike is still the striker's goal, not an own goal.
    /// </summary>
    public float DeflectionWindow { get; set; } = 2.0f;
}

public sealed class MvpTuning
{
    public float Goal { get; set; } = 100;
    public float Assist { get; set; } = 60;
    public float Save { get; set; } = 35;
    public float Tackle { get; set; } = 15;
    public float Steal { get; set; } = 8;
    public float PassCompleted { get; set; } = 4;
    public float ShotOnTarget { get; set; } = 10;
    public float OwnGoal { get; set; } = -60;
}
