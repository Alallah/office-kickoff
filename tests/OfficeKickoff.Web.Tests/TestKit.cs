using System.Collections.Concurrent;
using System.Diagnostics;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http.Connections;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.AspNetCore.SignalR.Client;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Microsoft.Extensions.Logging.Abstractions;
using OfficeKickoff.Sim;
using OfficeKickoff.Web.Protocol;
using OfficeKickoff.Web.Rooms;
using OfficeKickoff.Web.Services;

namespace OfficeKickoff.Web.Tests;

/// <summary>A clock the tests move by hand, so housekeeping deadlines can pass instantly.</summary>
public sealed class ManualTimeProvider : TimeProvider
{
    private long _ticks = DateTimeOffset.UtcNow.UtcTicks;

    public override DateTimeOffset GetUtcNow() => new(Interlocked.Read(ref _ticks), TimeSpan.Zero);

    public void Advance(TimeSpan by) => Interlocked.Add(ref _ticks, by.Ticks);
}

/// <summary>The real application on a test server, with a manual clock.</summary>
public sealed class KickoffFactory : WebApplicationFactory<Program>
{
    public ManualTimeProvider Clock { get; } = new();

    public RoomManager Rooms => Services.GetRequiredService<RoomManager>();

    protected override void ConfigureWebHost(IWebHostBuilder builder)
    {
        builder.UseEnvironment("Development");
        builder.ConfigureTestServices(services =>
        {
            services.RemoveAll<TimeProvider>();
            services.AddSingleton<TimeProvider>(Clock);
        });
    }

    public async Task<TestClient> Connect(string? playerId = null)
    {
        var server = Server;
        var connection = new HubConnectionBuilder()
            .WithUrl(new Uri(server.BaseAddress, "hub/game"), options =>
            {
                options.Transports = HttpTransportType.WebSockets;
                options.SkipNegotiation = true;
                options.WebSocketFactory = async (context, token) =>
                    await server.CreateWebSocketClient().ConnectAsync(context.Uri, token);
            })
            .Build();
        var client = new TestClient(connection, playerId ?? Guid.NewGuid().ToString("N"));
        await connection.StartAsync();
        return client;
    }
}

/// <summary>A browser stand-in: one hub connection that records everything the server pushes.</summary>
public sealed class TestClient : IAsyncDisposable
{
    public TestClient(HubConnection connection, string playerId)
    {
        Connection = connection;
        PlayerId = playerId;
        connection.On<RoomStateDto>("RoomState", s =>
        {
            States.Enqueue(s);
            Latest = s;
        });
        connection.On<SnapDto>("Snap", s =>
        {
            Interlocked.Increment(ref _snapCount);
            LastSnap = s;
            Snaps.Enqueue(s);
            while (Snaps.Count > 400) Snaps.TryDequeue(out _);
        });
        connection.On<MatchInitDto>("MatchInit", m => Inits.Enqueue(m));
        connection.On<MatchResultDto>("MatchEnd", r => Ends.Enqueue(r));
        connection.On<ChatDto>("Chat", c => Chats.Enqueue(c));
        connection.On<EmoteDto>("Emote", e => Emotes.Enqueue(e));
        connection.On<string>("Closed", r => Closed.Enqueue(r));
    }

    private int _snapCount;
    private int _seq;

    public HubConnection Connection { get; }
    public string PlayerId { get; }
    public int MemberId { get; private set; }

    public ConcurrentQueue<RoomStateDto> States { get; } = new();
    public ConcurrentQueue<SnapDto> Snaps { get; } = new();
    public ConcurrentQueue<MatchInitDto> Inits { get; } = new();
    public ConcurrentQueue<MatchResultDto> Ends { get; } = new();
    public ConcurrentQueue<ChatDto> Chats { get; } = new();
    public ConcurrentQueue<EmoteDto> Emotes { get; } = new();
    public ConcurrentQueue<string> Closed { get; } = new();

    public volatile RoomStateDto? Latest;
    public volatile SnapDto? LastSnap;

    public int SnapCount => Volatile.Read(ref _snapCount);

    public async Task<JoinResult> Join(string code, string nickname = "", string page = "lobby", string color = "", string celebration = "")
    {
        var result = await Connection.InvokeAsync<JoinResult>("Join", new JoinRequest
        {
            Code = code,
            PlayerId = PlayerId,
            Nickname = nickname,
            Color = color,
            Celebration = celebration,
            Page = page,
        });
        if (result.Ok)
        {
            MemberId = result.MemberId;
            Latest ??= result.Room;
        }

        return result;
    }

    public Task Send(string method, params object?[] args) => Connection.SendCoreAsync(method, args);

    public Task Invoke(string method, params object?[] args) => Connection.InvokeCoreAsync(method, args);

    /// <summary>One input; the sequence number counts up from 1 like the browser's.</summary>
    public Task Input(float mx, float my, int keys = 0, float ax = 0f, float ay = 0f) =>
        Connection.SendAsync("Input", new InputDto { Seq = ++_seq, MoveX = mx, MoveY = my, AimX = ax, AimY = ay, Keys = keys });

    public int LastSeq => _seq;

    /// <summary>Sends inputs at ~60 Hz for the given time.</summary>
    public async Task Stream(TimeSpan duration, float mx, float my)
    {
        var clock = Stopwatch.StartNew();
        while (clock.Elapsed < duration)
        {
            await Input(mx, my);
            await Task.Delay(16);
        }
    }

    public MemberDto? Me => Latest?.Members.FirstOrDefault(m => m.Id == MemberId);

    public async ValueTask DisposeAsync()
    {
        try
        {
            await Connection.DisposeAsync();
        }
        catch
        {
            // Already gone.
        }
    }
}

public static class Wait
{
    /// <summary>Polls until <paramref name="condition"/> holds; false on timeout.</summary>
    public static async Task<bool> Until(Func<bool> condition, int timeoutMs = 5000)
    {
        var clock = Stopwatch.StartNew();
        while (clock.ElapsedMilliseconds < timeoutMs)
        {
            if (condition()) return true;
            await Task.Delay(15);
        }

        return condition();
    }

    public static async Task True(Func<bool> condition, string because, int timeoutMs = 5000) =>
        Assert.True(await Until(condition, timeoutMs), because);
}

/// <summary>Captures what a room sends, for tests that drive a <see cref="Room"/> directly.</summary>
public sealed class RecordingGateway : IClientGateway
{
    public ConcurrentQueue<(string Target, string Method, object? Payload)> Sent { get; } = new();

    /// <summary>Lets a test keep a snapshot send to a connection "in flight" (return a pending task).</summary>
    public Func<string, Task?>? SnapResult { get; set; }

    public (string Target, string Method, object? Payload)[] ToArray() => Sent.ToArray();

    public IGameClient Group(string group) => new Recorder(this, "group:" + group);

    public IGameClient Client(string connectionId) => new Recorder(this, connectionId);

    public Task AddToGroupAsync(string connectionId, string group)
    {
        Sent.Enqueue((connectionId, "AddToGroup", group));
        return Task.CompletedTask;
    }

    public Task RemoveFromGroupAsync(string connectionId, string group)
    {
        Sent.Enqueue((connectionId, "RemoveFromGroup", group));
        return Task.CompletedTask;
    }

    public IEnumerable<T> Payloads<T>(string method, string? target = null) =>
        Sent.Where(s => s.Method == method && (target is null || s.Target == target)).Select(s => (T)s.Payload!);

    private sealed class Recorder(RecordingGateway owner, string target) : IGameClient
    {
        private Task Log(string method, object? payload)
        {
            owner.Sent.Enqueue((target, method, payload));
            return Task.CompletedTask;
        }

        public Task RoomState(RoomStateDto state) => Log(nameof(RoomState), state);
        public Task Snap(SnapDto snap)
        {
            owner.Sent.Enqueue((target, nameof(Snap), snap));
            return owner.SnapResult?.Invoke(target) ?? Task.CompletedTask;
        }
        public Task MatchInit(MatchInitDto init) => Log(nameof(MatchInit), init);
        public Task MatchEnd(MatchResultDto result) => Log(nameof(MatchEnd), result);
        public Task Emote(EmoteDto emote) => Log(nameof(Emote), emote);
        public Task Chat(ChatDto chat) => Log(nameof(Chat), chat);
        public Task Closed(string reason) => Log(nameof(Closed), reason);
    }
}

public static class Kit
{
    private static readonly Lazy<TeamCatalog> SharedCatalog =
        new(() => TeamCatalog.Load(AppContext.BaseDirectory, NullLogger.Instance));

    public static TeamCatalog Catalog => SharedCatalog.Value;

    public static (Room Room, RecordingGateway Sent, ManualTimeProvider Clock) NewRoom(bool practice = false, Tuning? tuning = null)
    {
        var gateway = new RecordingGateway();
        var clock = new ManualTimeProvider();
        var services = new RoomServices(tuning ?? new Tuning(), Catalog, gateway, clock, NullLoggerFactory.Instance);
        return (new Room("TEST", practice, services), gateway, clock);
    }

    public static JoinRequest Request(string playerId, string nickname = "", string page = "lobby", string color = "") => new()
    {
        Code = "TEST",
        PlayerId = playerId,
        Nickname = nickname,
        Color = color,
        Page = page,
    };

    public static TeamConfigDto ValidTeam() => TeamRules.Clone(Catalog.Dto.TeamPresets[0]);
}
