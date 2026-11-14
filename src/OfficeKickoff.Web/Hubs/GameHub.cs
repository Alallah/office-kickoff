using Microsoft.AspNetCore.SignalR;
using OfficeKickoff.Web.Protocol;
using OfficeKickoff.Web.Rooms;

namespace OfficeKickoff.Web.Hubs;

/// <summary>
/// The SignalR hub at /hub/game. A thin shell: every rule lives in <see cref="Room"/>. The room a
/// connection joined is remembered in <see cref="HubCallerContext.Items"/>; calls from a connection
/// that never joined (or was replaced) find no member there and are ignored.
/// </summary>
public sealed class GameHub(RoomManager rooms) : Hub<IGameClient>, IGameServer
{
    private const string RoomKey = "okRoom";

    private Room? CurrentRoom => Context.Items.TryGetValue(RoomKey, out var room) ? room as Room : null;

    private string ConnectionId => Context.ConnectionId;

    public Task<JoinResult> Join(JoinRequest request)
    {
        if (request?.PlayerId is not { Length: >= 8 and <= 64 }) return Task.FromResult(Fail("invalid"));

        var room = rooms.Find(request.Code);
        if (room is null) return Task.FromResult(Fail("not_found"));

        // One connection belongs to one room: joining another one leaves the previous seat behind.
        var previous = CurrentRoom;
        if (previous is not null && previous != room) previous.Disconnected(ConnectionId);

        var result = room.Join(ConnectionId, request);
        if (result.Ok) Context.Items[RoomKey] = room;
        else if (previous == room) Context.Items.Remove(RoomKey);
        return Task.FromResult(result);
    }

    public Task Leave()
    {
        var room = CurrentRoom;
        if (room is not null)
        {
            room.Leave(ConnectionId);
            Context.Items.Remove(RoomKey);
        }

        return Task.CompletedTask;
    }

    public Task SetTeam(int team)
    {
        CurrentRoom?.SetTeam(ConnectionId, team);
        return Task.CompletedTask;
    }

    public Task SetReady(bool ready)
    {
        CurrentRoom?.SetReady(ConnectionId, ready);
        return Task.CompletedTask;
    }

    public Task SetProfile(ProfileDto profile)
    {
        CurrentRoom?.SetProfile(ConnectionId, profile);
        return Task.CompletedTask;
    }

    public Task SetTeamConfig(int team, TeamConfigDto config)
    {
        CurrentRoom?.SetTeamConfig(ConnectionId, team, config);
        return Task.CompletedTask;
    }

    public Task SetSettings(MatchSettingsDto settings)
    {
        CurrentRoom?.SetSettings(ConnectionId, settings);
        return Task.CompletedTask;
    }

    public Task StartMatch()
    {
        CurrentRoom?.StartMatch(ConnectionId);
        return Task.CompletedTask;
    }

    public Task Rematch()
    {
        CurrentRoom?.Rematch(ConnectionId);
        return Task.CompletedTask;
    }

    public Task BackToLobby()
    {
        CurrentRoom?.BackToLobby(ConnectionId);
        return Task.CompletedTask;
    }

    public Task Input(InputDto input)
    {
        CurrentRoom?.Input(ConnectionId, input);
        return Task.CompletedTask;
    }

    public Task Emote(int emote)
    {
        CurrentRoom?.Emote(ConnectionId, emote);
        return Task.CompletedTask;
    }

    public Task Chat(string text)
    {
        CurrentRoom?.Chat(ConnectionId, text);
        return Task.CompletedTask;
    }

    public Task<long> Ping() => Task.FromResult(DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());

    public Task ReportPing(int milliseconds)
    {
        CurrentRoom?.ReportPing(ConnectionId, milliseconds);
        return Task.CompletedTask;
    }

    public override Task OnDisconnectedAsync(Exception? exception)
    {
        CurrentRoom?.Disconnected(ConnectionId);
        return base.OnDisconnectedAsync(exception);
    }

    private static JoinResult Fail(string error) => new() { Ok = false, Error = error };
}

/// <summary><see cref="IClientGateway"/> over the hub context, usable from any thread.</summary>
public sealed class HubClientGateway(IHubContext<GameHub, IGameClient> hub) : IClientGateway
{
    public IGameClient Group(string group) => hub.Clients.Group(group);

    public IGameClient Client(string connectionId) => hub.Clients.Client(connectionId);

    public Task AddToGroupAsync(string connectionId, string group) => hub.Groups.AddToGroupAsync(connectionId, group);

    public Task RemoveFromGroupAsync(string connectionId, string group) => hub.Groups.RemoveFromGroupAsync(connectionId, group);
}
