using OfficeKickoff.Sim;
using OfficeKickoff.Web.Services;

namespace OfficeKickoff.Web.Rooms;

/// <summary>Everything a room needs from the outside world, in one place so tests can build rooms directly.</summary>
public sealed class RoomServices(Tuning tuning, TeamCatalog catalog, IClientGateway gateway, TimeProvider time, ILoggerFactory loggers)
{
    public Tuning Tuning { get; } = tuning;
    public TeamCatalog Catalog { get; } = catalog;
    public IClientGateway Gateway { get; } = gateway;
    public TimeProvider Time { get; } = time;
    public ILoggerFactory Loggers { get; } = loggers;
}
