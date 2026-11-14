using OfficeKickoff.Sim;
using OfficeKickoff.Web.Protocol;

namespace OfficeKickoff.Web.Rooms;

/// <summary>One sanitised tick of a human's controls.</summary>
public readonly record struct QueuedInput(int Seq, float MoveX, float MoveY, float AimX, float AimY, int Keys)
{
    public const int HeldBits = InputDto.Sprint | InputDto.Shoot;
    public const int EdgeBits = InputDto.Pass | InputDto.Tackle | InputDto.SwitchBest | InputDto.SwitchNext;
    public const int AllBits = HeldBits | EdgeBits;
    public const float AimLimit = 5000f;

    public bool Shooting => (Keys & InputDto.Shoot) != 0;

    /// <summary>Finite numbers only, move in [-1, 1], aim within +-5000, unknown key bits dropped.</summary>
    public static QueuedInput From(InputDto dto) => new(
        dto.Seq,
        Clamp(dto.MoveX, 1f),
        Clamp(dto.MoveY, 1f),
        Clamp(dto.AimX, AimLimit),
        Clamp(dto.AimY, AimLimit),
        dto.Keys & AllBits);

    private static float Clamp(float value, float limit) =>
        float.IsFinite(value) ? Math.Clamp(value, -limit, limit) : 0f;

    public PlayerInput ToPlayerInput() => new()
    {
        Move = new Vec2(MoveX, MoveY),
        AimPoint = new Vec2(AimX, AimY),
        Sprint = (Keys & InputDto.Sprint) != 0,
        Shoot = (Keys & InputDto.Shoot) != 0,
        Pass = (Keys & InputDto.Pass) != 0,
        Tackle = (Keys & InputDto.Tackle) != 0,
        SwitchBest = (Keys & InputDto.SwitchBest) != 0,
        SwitchNext = (Keys & InputDto.SwitchNext) != 0,
    };
}

/// <summary>
/// Inputs of one human waiting to be applied, one per simulation tick. Never rejects or reorders
/// on the sequence number: the browser's counter is only echoed back as the ack.
/// </summary>
public sealed class InputQueue
{
    /// <summary>Hard cap: beyond this the oldest entry is dropped on arrival.</summary>
    public const int Capacity = 8;

    /// <summary>A queue longer than this is caught up ...</summary>
    public const int CatchUpAbove = 3;

    /// <summary>... down to this many entries.</summary>
    public const int CatchUpTo = 2;

    /// <summary>Empty ticks during which the previous input keeps being applied (0.25 s); after that, neutral.</summary>
    public const int HoldTicks = 15;

    private readonly Queue<QueuedInput> _queue = new(Capacity + 1);
    private QueuedInput _last;
    private int _carriedEdges;
    private int _emptyTicks;

    public int Count => _queue.Count;

    /// <summary>Forgets everything: queue, previous input and pending edges.</summary>
    public void Clear()
    {
        _queue.Clear();
        _last = default;
        _carriedEdges = 0;
        _emptyTicks = 0;
    }

    public void Enqueue(QueuedInput input)
    {
        _queue.Enqueue(input);
        while (_queue.Count > Capacity)
        {
            // Over the hard cap the oldest goes regardless, but a pass or tackle press survives.
            _carriedEdges |= _queue.Dequeue().Keys & QueuedInput.EdgeBits;
        }
    }

    /// <summary>
    /// The input to apply on this tick. <paramref name="fresh"/> is true when it came from the
    /// queue (its Seq is then the new ack); false when the previous input is being held or the
    /// neutral input is applied.
    /// </summary>
    public QueuedInput Next(out bool fresh)
    {
        if (_queue.Count == 0)
        {
            fresh = false;
            _emptyTicks++;
            _last = _emptyTicks <= HoldTicks
                ? _last with { Keys = _last.Keys & QueuedInput.HeldBits }
                : _last with { MoveX = 0f, MoveY = 0f, Keys = 0 };
            return _last;
        }

        if (_queue.Count > CatchUpAbove)
        {
            while (_queue.Count > CatchUpTo)
            {
                var oldest = _queue.Peek();
                QueuedInput successor = default;
                int index = 0;
                foreach (var entry in _queue)
                {
                    if (index++ == 1)
                    {
                        successor = entry;
                        break;
                    }
                }

                // A shoot press or release must reach the simulation, or a quick tap would vanish.
                if (oldest.Shooting != successor.Shooting) break;

                _carriedEdges |= _queue.Dequeue().Keys & QueuedInput.EdgeBits;
            }
        }

        var next = _queue.Dequeue();
        if (_carriedEdges != 0)
        {
            next = next with { Keys = next.Keys | _carriedEdges };
            _carriedEdges = 0;
        }

        _emptyTicks = 0;
        _last = next;
        fresh = true;
        return next;
    }
}
