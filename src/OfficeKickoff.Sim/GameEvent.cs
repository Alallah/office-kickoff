namespace OfficeKickoff.Sim;

/// <summary>
/// Things that happened during a tick. Events drive client effects and sounds, so emit them at
/// the moment and place they happen. Numeric values are part of the wire protocol (see
/// protocol.js). Do not renumber.
///
/// Field usage per type ("-" = unused, leave at default; X,Y is always where it happened):
///
///  Type         | A              | B                 | Value                         | Flag
///  -------------|----------------|-------------------|-------------------------------|-----------------------------
///  Kick         | kicker         | -1                | charge 0..1                   | 1 = first-time (ball was loose)
///  Pass         | passer         | target or -1      | speed / PassMaxSpeed          | 1 = first-time
///  Trap         | new owner      | -1                | relative speed / ControlSpeed | -
///  Steal        | new owner      | robbed player     | -                             | -
///  SlideStart   | slider         | -1                | -                             | -
///  TackleHit    | slider         | victim or -1      | -                             | 1 = slider won the ball
///  SlideMiss    | slider         | -1                | -                             | -
///  Dash         | player         | -1                | -                             | -
///  Deflect      | player hit     | -1                | ball speed / ShotMaxSpeed     | -
///  WallBounce   | -1             | -1                | ball speed / ShotMaxSpeed     | -
///  PostHit      | -1             | -1                | ball speed / ShotMaxSpeed     | -
///  KeeperCatch  | keeper         | -1                | ball speed / ShotMaxSpeed     | -
///  KeeperParry  | keeper         | -1                | ball speed / ShotMaxSpeed     | -
///  Block        | blocker        | -1                | ball speed / ShotMaxSpeed     | - (outfield block of an on-target shot)
///  Dive         | keeper         | -1                | -                             | -
///  Goal         | scorer or -1   | assister or -1    | ball speed / ShotMaxSpeed     | see <see cref="GoalFlags"/>
///  PhaseChange  | -1             | -1                | previous phase                | new phase
///  Switch       | new footballer | old footballer/-1 | -                             | human id
///  NetHit       | -1             | -1                | ball speed / ShotMaxSpeed     | - (dead ball hits the net)
///  Overtime     | -1             | -1                | -                             | - (golden goal begins)
/// </summary>
public enum GameEventType : byte
{
    None = 0,
    Kick = 1,
    Pass = 2,
    Trap = 3,
    Steal = 4,
    SlideStart = 5,
    TackleHit = 6,
    SlideMiss = 7,
    Dash = 8,
    Deflect = 9,
    WallBounce = 10,
    PostHit = 11,
    KeeperCatch = 12,
    KeeperParry = 13,
    Block = 14,
    Dive = 15,
    Goal = 16,
    PhaseChange = 17,
    Switch = 18,
    NetHit = 19,
    Overtime = 20,
}

/// <summary>
/// Layout of <see cref="GameEvent.Flag"/> for a Goal event. The humans are the ones who controlled
/// the scorer / assister AT THE TOUCH (control often moves before the ball crosses the line), so
/// clients must take names and celebrations from here, never from the footballer's current controller.
///
///   bit 0      scoring team (0 or 1)
///   bit 1      own goal
///   bit 2      this goal decides the match (golden goal or score limit)
///   bits 4-6   scorer's human id + 1   (0 = an AI footballer scored)
///   bits 8-10  assister's human id + 1 (0 = AI assister or no assist)
/// </summary>
public static class GoalFlags
{
    public const int OwnGoal = 2;
    public const int Decides = 4;

    public static int Pack(int scoringTeam, bool ownGoal, bool decides, int scorerHuman, int assistHuman) =>
        (scoringTeam & 1) | (ownGoal ? OwnGoal : 0) | (decides ? Decides : 0) |
        (((scorerHuman + 1) & 7) << 4) | (((assistHuman + 1) & 7) << 8);

    public static int Team(int flag) => flag & 1;
    public static bool IsOwnGoal(int flag) => (flag & OwnGoal) != 0;
    public static bool IsDecider(int flag) => (flag & Decides) != 0;

    /// <summary>Human id of the scorer, or -1 for an AI footballer.</summary>
    public static int ScorerHuman(int flag) => ((flag >> 4) & 7) - 1;

    /// <summary>Human id of the assister, or -1.</summary>
    public static int AssistHuman(int flag) => ((flag >> 8) & 7) - 1;
}

public struct GameEvent
{
    public GameEventType Type;
    public int A;
    public int B;
    public float X;
    public float Y;
    public float Value;
    public int Flag;

    public GameEvent(GameEventType type, int a = -1, int b = -1, Vec2 pos = default, float value = 0f, int flag = 0)
    {
        Type = type;
        A = a;
        B = b;
        X = pos.X;
        Y = pos.Y;
        Value = value;
        Flag = flag;
    }
}
