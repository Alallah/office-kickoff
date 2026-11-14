namespace OfficeKickoff.Web.Rooms;

/// <summary>All rooms of this server, in memory.</summary>
public sealed class RoomManager(RoomServices services, ILogger<RoomManager> log)
{
    public const int MaxRooms = 200;
    private const int MaxCodeAttempts = 500;

    private readonly object _gate = new();
    private readonly Dictionary<string, Room> _rooms = new(StringComparer.Ordinal);

    /// <summary>Copy of the room list for the game loop, replaced on every change.</summary>
    private volatile Room[] _list = [];

    private readonly Dictionary<Room, int> _failures = [];

    public int Count => _list.Length;

    public IReadOnlyList<Room> Rooms => _list;

    /// <summary>A new room, or null when the server already has <see cref="MaxRooms"/> rooms.</summary>
    public Room? Create(bool practice)
    {
        lock (_gate)
        {
            if (_rooms.Count >= MaxRooms) return null;
            for (int attempt = 0; attempt < MaxCodeAttempts; attempt++)
            {
                string code = RoomCodes.Random();
                if (!RoomCodes.IsAcceptable(code) || _rooms.ContainsKey(code)) continue;

                var room = new Room(code, practice, services);
                _rooms[code] = room;
                _list = [.. _rooms.Values];
                log.LogInformation("Room {Code} created{Practice}", code, practice ? " (practice)" : "");
                return room;
            }

            log.LogWarning("No free room code found after {Attempts} attempts", MaxCodeAttempts);
            return null;
        }
    }

    /// <summary>The room with this code (any case, surrounding spaces ignored), or null.</summary>
    public Room? Find(string? code)
    {
        string? normalized = RoomCodes.Normalize(code);
        if (normalized is null) return null;
        lock (_gate) return _rooms.GetValueOrDefault(normalized);
    }

    public bool Remove(string code)
    {
        Room? room;
        lock (_gate)
        {
            if (!_rooms.Remove(code, out room)) return false;
            _list = [.. _rooms.Values];
            _failures.Remove(room);
        }

        room.Close();
        log.LogInformation("Room {Code} deleted", code);
        return true;
    }

    /// <summary>One simulation step for every room. One room's failure never affects the others.</summary>
    public void Tick()
    {
        foreach (var room in _list)
        {
            try
            {
                room.Tick();
            }
            catch (Exception ex)
            {
                LogOnce(room, ex, "tick");
            }
        }
    }

    /// <summary>Periodic upkeep of every room; deletes rooms that have been empty too long.</summary>
    public void Housekeep()
    {
        foreach (var room in _list)
        {
            bool dead;
            try
            {
                dead = room.Housekeep();
            }
            catch (Exception ex)
            {
                LogOnce(room, ex, "housekeeping");
                continue;
            }

            if (dead) Remove(room.Code);
        }
    }

    private void LogOnce(Room room, Exception ex, string what)
    {
        lock (_gate)
        {
            _failures.TryGetValue(room, out int count);
            _failures[room] = count + 1;
            if (count > 0 && count % 3600 != 0) return;
        }

        log.LogError(ex, "Room {Code}: {What} failed", room.Code, what);
    }
}
