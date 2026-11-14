using OfficeKickoff.Web.Protocol;
using OfficeKickoff.Web.Rooms;

namespace OfficeKickoff.Web.Tests.Unit;

public class InputQueueTests
{
    private static QueuedInput In(int seq, int keys = 0, float mx = 1f, float ax = 100f) => new(seq, mx, 0f, ax, 0f, keys);

    [Fact]
    public void Applies_one_input_per_tick_in_arrival_order_even_when_sequence_numbers_go_backwards()
    {
        var q = new InputQueue();
        q.Enqueue(In(5));
        q.Enqueue(In(2));

        Assert.Equal(5, q.Next(out bool fresh1).Seq);
        Assert.True(fresh1);
        Assert.Equal(2, q.Next(out bool fresh2).Seq);
        Assert.True(fresh2);
    }

    [Fact]
    public void Empty_queue_holds_the_previous_input_without_its_edges_then_goes_neutral_after_a_quarter_second()
    {
        var q = new InputQueue();
        q.Enqueue(In(1, InputDto.Sprint | InputDto.Shoot | InputDto.Pass, mx: 0.8f, ax: 321f));
        var first = q.Next(out _);
        Assert.Equal(InputDto.Sprint | InputDto.Shoot | InputDto.Pass, first.Keys);

        for (int tick = 1; tick <= InputQueue.HoldTicks; tick++)
        {
            var held = q.Next(out bool fresh);
            Assert.False(fresh);
            Assert.Equal(0.8f, held.MoveX);
            Assert.Equal(InputDto.Sprint | InputDto.Shoot, held.Keys);
        }

        var neutral = q.Next(out bool stale);
        Assert.False(stale);
        Assert.Equal(0f, neutral.MoveX);
        Assert.Equal(0f, neutral.MoveY);
        Assert.Equal(0, neutral.Keys);
        Assert.Equal(321f, neutral.AimX);

        // A new input ends the neutral spell at once.
        q.Enqueue(In(2));
        Assert.Equal(2, q.Next(out bool fresh2).Seq);
        Assert.True(fresh2);
    }

    [Fact]
    public void Catch_up_drops_to_two_entries_and_keeps_the_dropped_edges()
    {
        var q = new InputQueue();
        q.Enqueue(In(1, InputDto.Pass));
        q.Enqueue(In(2, InputDto.Tackle));
        q.Enqueue(In(3));
        q.Enqueue(In(4));
        q.Enqueue(In(5));

        var applied = q.Next(out _);
        Assert.Equal(4, applied.Seq);
        Assert.Equal(InputDto.Pass | InputDto.Tackle, applied.Keys & QueuedInput.EdgeBits);
        Assert.Equal(1, q.Count);
        Assert.Equal(5, q.Next(out _).Seq);
    }

    [Fact]
    public void A_quick_shoot_tap_survives_catch_up()
    {
        var q = new InputQueue();
        q.Enqueue(In(1));
        q.Enqueue(In(2, InputDto.Shoot));
        q.Enqueue(In(3));
        q.Enqueue(In(4));
        q.Enqueue(In(5));

        var shots = new List<bool>();
        while (q.Count > 0) shots.Add(q.Next(out _).Shooting);

        // The press and the release both reach the simulation.
        int press = shots.IndexOf(true);
        Assert.True(press >= 0, "the shoot tap was dropped");
        Assert.Contains(false, shots.Skip(press + 1));
    }

    [Fact]
    public void Queue_is_hard_capped_at_eight_dropping_the_oldest()
    {
        var q = new InputQueue();
        for (int i = 1; i <= 20; i++) q.Enqueue(In(i, i == 3 ? InputDto.Pass : 0));
        Assert.Equal(InputQueue.Capacity, q.Count);

        var applied = q.Next(out _);
        Assert.True(applied.Seq >= 13);

        // A pass pressed in a dropped entry is still delivered.
        Assert.Equal(InputDto.Pass, applied.Keys & InputDto.Pass);
    }

    [Fact]
    public void Clear_forgets_queue_and_previous_input()
    {
        var q = new InputQueue();
        q.Enqueue(In(1, InputDto.Sprint));
        q.Next(out _);
        q.Enqueue(In(2));
        q.Clear();

        Assert.Equal(0, q.Count);
        var held = q.Next(out bool fresh);
        Assert.False(fresh);
        Assert.Equal(0, held.Keys);
        Assert.Equal(0f, held.MoveX);
    }

    [Fact]
    public void Sanitising_clamps_moves_and_aim_drops_non_finite_numbers_and_masks_keys()
    {
        var q = QueuedInput.From(new InputDto
        {
            Seq = 9, MoveX = 7f, MoveY = float.NaN, AimX = -1e9f, AimY = float.PositiveInfinity, Keys = 0x7fff,
        });

        Assert.Equal(9, q.Seq);
        Assert.Equal(1f, q.MoveX);
        Assert.Equal(0f, q.MoveY);
        Assert.Equal(-QueuedInput.AimLimit, q.AimX);
        Assert.Equal(0f, q.AimY);
        Assert.Equal(63, q.Keys);
    }
}
