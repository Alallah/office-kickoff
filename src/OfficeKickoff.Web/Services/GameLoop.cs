using System.Diagnostics;
using System.Runtime.InteropServices;
using OfficeKickoff.Sim;
using OfficeKickoff.Web.Rooms;

namespace OfficeKickoff.Web.Services;

/// <summary>
/// The fixed 60 Hz heartbeat of every room, on one dedicated thread: simulation steps, snapshots
/// and periodic housekeeping.
/// </summary>
public sealed class GameLoop(RoomManager rooms, ILogger<GameLoop> log) : BackgroundService
{
    /// <summary>Most steps run in one iteration after a stall; the rest of the backlog is dropped.</summary>
    public const int MaxCatchUpSteps = 5;

    public static readonly TimeSpan HousekeepingInterval = TimeSpan.FromMilliseconds(250);

    protected override Task ExecuteAsync(CancellationToken stoppingToken)
    {
        var done = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var thread = new Thread(() =>
        {
            try
            {
                Run(stoppingToken);
                done.TrySetResult();
            }
            catch (Exception ex)
            {
                log.LogCritical(ex, "The game loop stopped");
                done.TrySetException(ex);
            }
        })
        {
            IsBackground = true,
            Name = "Game loop",
            Priority = ThreadPriority.AboveNormal,
        };
        thread.Start();
        return done.Task;
    }

    private void Run(CancellationToken stop)
    {
        // Thread.Sleep(1) sleeps a whole 15.6 ms scheduler tick on Windows unless the timer
        // resolution is raised; that would make the 60 Hz loop stutter.
        bool raised = OperatingSystem.IsWindows() && TimeBeginPeriod(1) == 0;
        try
        {
            var clock = Stopwatch.StartNew();
            double step = Tuning.TickSeconds;
            double previous = clock.Elapsed.TotalSeconds;
            double accumulator = 0;
            double nextHousekeeping = 0;
            log.LogInformation("Game loop running at {Rate} Hz", Tuning.TickRate);

            while (!stop.IsCancellationRequested)
            {
                double now = clock.Elapsed.TotalSeconds;
                accumulator += now - previous;
                previous = now;

                int steps = (int)(accumulator / step);
                if (steps > MaxCatchUpSteps)
                {
                    steps = MaxCatchUpSteps;
                    accumulator = accumulator % step;
                }
                else
                {
                    accumulator -= steps * step;
                }

                for (int i = 0; i < steps; i++) Guard(rooms.Tick, "tick");

                if (now >= nextHousekeeping)
                {
                    nextHousekeeping = now + HousekeepingInterval.TotalSeconds;
                    Guard(rooms.Housekeep, "housekeeping");
                }

                Thread.Sleep(1);
            }
        }
        finally
        {
            if (raised) TimeEndPeriod(1);
        }
    }

    private void Guard(Action action, string what)
    {
        try
        {
            action();
        }
        catch (Exception ex)
        {
            log.LogError(ex, "Game loop {What} failed", what);
        }
    }

#pragma warning disable SYSLIB1054 // LibraryImport would need unsafe code enabled for the whole app.
    [DllImport("winmm.dll", EntryPoint = "timeBeginPeriod")]
    private static extern uint TimeBeginPeriod(uint milliseconds);

    [DllImport("winmm.dll", EntryPoint = "timeEndPeriod")]
    private static extern uint TimeEndPeriod(uint milliseconds);
#pragma warning restore SYSLIB1054
}
