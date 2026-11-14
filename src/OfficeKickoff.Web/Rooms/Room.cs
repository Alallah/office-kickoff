using OfficeKickoff.Sim;
using OfficeKickoff.Web.Protocol;

namespace OfficeKickoff.Web.Rooms;

/// <summary>
/// One room: its members, teams, settings and the current match.
///
/// Concurrency: every field is guarded by <see cref="_gate"/>, taken both by hub calls and by the
/// game loop thread. Messages are built inside the lock into an <see cref="Outbox"/> and sent
/// after it is released (<see cref="Dispatch"/>), so a slow network never stalls the simulation.
/// </summary>
public sealed class Room
{
    public const int MaxMembers = 12;
    public const string Lobby = "lobby";
    public const string Playing = "match";
    public const string Finished = "results";

    public static readonly TimeSpan AnnounceAfter = TimeSpan.FromSeconds(5);
    public static readonly TimeSpan LobbyGrace = TimeSpan.FromSeconds(20);
    public static readonly TimeSpan AfterMatchGrace = TimeSpan.FromSeconds(60);
    public static readonly TimeSpan HostGrace = TimeSpan.FromSeconds(10);
    public static readonly TimeSpan EmptyLifetime = TimeSpan.FromSeconds(120);
    public static readonly TimeSpan PingBroadcastInterval = TimeSpan.FromSeconds(1);

    private const int ChatLimit = 5;
    private static readonly TimeSpan ChatWindow = TimeSpan.FromSeconds(10);
    private const int EmoteLimit = 2;
    private static readonly TimeSpan EmoteWindow = TimeSpan.FromSeconds(1);

    /// <summary>Consecutive failing ticks after which a broken match is abandoned.</summary>
    private const int FailuresBeforeAbandon = 60;

    private readonly object _gate = new();
    private readonly object _sendGate = new();
    private readonly RoomServices _services;
    private readonly ILogger _log;

    private readonly List<Member> _members = [];
    private readonly TeamConfigDto[] _teams = new TeamConfigDto[2];
    private MatchSettings _settings = MatchSettings.FromPreset(null).Normalized();
    private TeamDto[]? _teamDtos;
    private string _phase = Lobby;
    private int _hostId;
    private int _nextMemberId = 1;
    private long _arrivals;
    private int _nextColor;
    private bool _closed;

    // Current match. The seats and humans are captured at kickoff and outlive member changes.
    private int _matchId;
    private Match? _match;
    private HumanSeat?[] _seats = new HumanSeat?[4];
    private HumanInfoDto[] _humans = [];
    private PlayerInfoDto[] _players = [];
    private MatchInitDto? _init;
    private MatchResultDto? _result;
    private readonly int[] _acks = new int[4];
    private readonly List<float[]> _pendingEvents = [];
    private int _ticksSinceSnap;
    private bool _nonFiniteLogged;
    private int _failures;
    private bool _failureLogged;

    private long _stateVersion;
    private long _sentStateVersion;

    private DateTimeOffset _lobbySince;
    private DateTimeOffset? _emptySince;
    private bool _pingDirty;
    private DateTimeOffset _lastStateBroadcast;

    public Room(string code, bool practice, RoomServices services)
    {
        Code = code;
        Practice = practice;
        _services = services;
        _log = services.Loggers.CreateLogger<Room>();

        // Two different presets to start with.
        var catalog = services.Catalog;
        int home = Random.Shared.Next(catalog.Count);
        int away = (home + 1 + Random.Shared.Next(catalog.Count - 1)) % catalog.Count;
        _teams[0] = catalog.Preset(home);
        _teams[1] = catalog.Preset(away);

        _lobbySince = Now;
        _emptySince = Now;
    }

    public string Code { get; }

    public bool Practice { get; }

    /// <summary>SignalR group of the room's connections.</summary>
    public string Group => "room:" + Code;

    private DateTimeOffset Now => _services.Time.GetUtcNow();

    // ------------------------------------------------------------------------------------
    //  Read-only views (tests, diagnostics)
    // ------------------------------------------------------------------------------------

    public string Phase
    {
        get { lock (_gate) return _phase; }
    }

    public int MatchId
    {
        get { lock (_gate) return _matchId; }
    }

    public bool IsClosed
    {
        get { lock (_gate) return _closed; }
    }

    public RoomStateDto State()
    {
        lock (_gate) return BuildState();
    }

    public MatchResultDto? LastResult
    {
        get { lock (_gate) return _result; }
    }

    /// <summary>Runs <paramref name="read"/> on the live match under the room lock (tests).</summary>
    internal T? WithMatch<T>(Func<Match, T> read)
    {
        lock (_gate) return _match is null ? default : read(_match);
    }

    // ------------------------------------------------------------------------------------
    //  Joining and leaving
    // ------------------------------------------------------------------------------------

    public JoinResult Join(string connectionId, JoinRequest? request)
    {
        if (request?.PlayerId is not { Length: >= 8 and <= 64 } playerId) return Fail("invalid");
        string page = request.Page == Playing ? Playing : Lobby;

        var outbox = new Outbox();
        JoinResult result;
        lock (_gate)
        {
            if (_closed) return Fail("not_found");
            var now = Now;

            var member = _members.Find(m => m.PlayerId == playerId);
            if (member is null)
            {
                string wanted = TextRules.Clean(request.Nickname, Vocabulary.MaxNickname);
                if (wanted.Length > 0)
                {
                    member = _members.Find(m => !m.Connected &&
                        (string.Equals(m.RequestedName, wanted, StringComparison.OrdinalIgnoreCase) ||
                         string.Equals(m.Name, wanted, StringComparison.OrdinalIgnoreCase)));
                    if (member is not null) member.PlayerId = playerId;
                }
            }

            string? announce = null;
            if (member is null)
            {
                if (_members.Count >= MaxMembers) return Fail("full");
                member = CreateMember(playerId, request);
                _members.Add(member);
                announce = $"{member.Name} joined";
            }
            else
            {
                if (member.ConnectionId is { } old && old != connectionId)
                {
                    outbox.Closed(old, "replaced");
                    outbox.RemoveFromGroup(old);
                }

                if (!member.Connected && member.DisconnectAnnounced) announce = $"{member.Name} is back";
            }

            bool newConnection = member.ConnectionId != connectionId;
            member.ConnectionId = connectionId;
            member.Connected = true;
            member.Page = page;
            member.DisconnectAnnounced = false;
            _emptySince = null;
            if (newConnection)
            {
                member.Link = new SnapLink(connectionId);
                ResetSeatInput(member);
            }

            if (_hostId == 0 || _members.TrueForAll(m => m.Id != _hostId)) _hostId = member.Id;

            outbox.AddToGroup(connectionId);
            if (announce is not null) Announce(outbox, announce);

            // A practice room starts playing the moment its host opens the match page.
            bool started = false;
            if (Practice && _phase == Lobby && page == Playing && member.Id == _hostId)
            {
                if (member.Team != 0 && HumansOn(0, member) < Vocabulary.HumansPerTeam) member.Team = 0;
                started = StartMatchLocked(outbox, skipInitFor: connectionId);
            }

            var state = started ? BuildState() : BroadcastState(outbox);

            result = new JoinResult
            {
                Ok = true,
                MemberId = member.Id,
                Room = state,
                Catalog = _services.Catalog.Dto,
                Match = _phase != Lobby ? InitNow() : null,
                Result = _phase == Finished ? _result : null,
            };

            // Something to draw straight away; the regular stream follows from the game loop.
            if (page == Playing && _phase != Lobby && _match is not null && member.Link is { } link)
            {
                bool bad = false;
                outbox.Snap(link, Snapshots.Build(_match, _acks, ref bad));
            }
        }

        Dispatch(outbox);
        return result;
    }

    private static JoinResult Fail(string error) => new() { Ok = false, Error = error };

    private Member CreateMember(string playerId, JoinRequest request)
    {
        int id = _nextMemberId++;
        string requested = TextRules.Clean(request.Nickname, Vocabulary.MaxNickname);
        string name = requested.Length > 0 ? requested : $"Player {id}";
        name = TextRules.Unique(name, _members.Select(m => m.Name), Vocabulary.MaxNickname);

        int home = HumansOn(0, null), away = HumansOn(1, null);
        int team = home <= away ? 0 : 1;
        if (Math.Min(home, away) >= Vocabulary.HumansPerTeam) team = -1;

        return new Member
        {
            PlayerId = playerId,
            Id = id,
            Arrival = ++_arrivals,
            Name = name,
            RequestedName = requested,
            Color = TextRules.IsColor(request.Color) ? request.Color.ToLowerInvariant() : NextColor(),
            Celebration = Vocabulary.Celebrations.Contains(request.Celebration) ? request.Celebration : Vocabulary.Celebrations[0],
            AutoSwitch = request.AutoSwitch,
            Team = team,
        };
    }

    private string NextColor()
    {
        var colors = Vocabulary.PlayerColors;
        for (int k = 0; k < colors.Length; k++)
        {
            int index = (_nextColor + k) % colors.Length;
            if (_members.TrueForAll(m => !string.Equals(m.Color, colors[index], StringComparison.OrdinalIgnoreCase)))
            {
                _nextColor = index + 1;
                return colors[index];
            }
        }

        return colors[_nextColor++ % colors.Length];
    }

    private int HumansOn(int team, Member? except)
    {
        int count = 0;
        foreach (var m in _members)
        {
            if (m.Team == team && m != except) count++;
        }

        return count;
    }

    public void Leave(string connectionId)
    {
        var outbox = new Outbox();
        lock (_gate)
        {
            var m = Caller(connectionId);
            if (m is null) return;
            RemoveMember(m, outbox, $"{m.Name} left");
            outbox.RemoveFromGroup(connectionId);
            BroadcastState(outbox);
        }

        Dispatch(outbox);
    }

    public void Disconnected(string connectionId)
    {
        var outbox = new Outbox();
        lock (_gate)
        {
            var m = Caller(connectionId);
            if (m is null) return;
            m.Connected = false;
            m.ConnectionId = null;
            m.Link = null;
            m.DisconnectedAt = Now;
            m.DisconnectAnnounced = false;
            SendAway(m);
            if (_members.TrueForAll(x => !x.Connected)) _emptySince = Now;
            BroadcastState(outbox);
        }

        Dispatch(outbox);
    }

    /// <summary>Deletes the room: remaining connections are told Closed("closed").</summary>
    public void Close()
    {
        var outbox = new Outbox();
        lock (_gate)
        {
            if (_closed) return;
            _closed = true;
            _match = null;
            foreach (var m in _members)
            {
                if (m.ConnectionId is not { } c) continue;
                outbox.Closed(c, "closed");
                outbox.RemoveFromGroup(c);
            }
        }

        Dispatch(outbox);
    }

    private Member? Caller(string connectionId)
    {
        if (_closed) return null;
        foreach (var m in _members)
        {
            if (m.ConnectionId == connectionId) return m;
        }

        return null;
    }

    private void RemoveMember(Member m, Outbox outbox, string announcement)
    {
        _members.Remove(m);
        if (m.HumanId >= 0 && _seats[m.HumanId] is { } seat && seat.Member == m)
        {
            SendAway(m);
            seat.Member = null;
        }

        m.HumanId = -1;
        Announce(outbox, announcement);
        if (m.Id == _hostId) HandOverHost(outbox, anyoneIfNoneConnected: true);
        if (_members.TrueForAll(x => !x.Connected)) _emptySince ??= Now;
    }

    /// <summary>Hands the footballer of a seated member to the AI.</summary>
    private void SendAway(Member m)
    {
        if (m.HumanId < 0 || _seats[m.HumanId] is not { } seat || seat.Member != m) return;
        seat.Queue.Clear();
        if (seat.AtControls)
        {
            seat.AtControls = false;
            _match?.SetHumanConnected(seat.HumanId, false);
        }
    }

    private void ResetSeatInput(Member m)
    {
        if (m.HumanId < 0 || _seats[m.HumanId] is not { } seat || seat.Member != m) return;
        seat.Queue.Clear();
        seat.Ack = 0;
        seat.Silence = 0;
        _acks[seat.HumanId] = 0;
    }

    private void HandOverHost(Outbox outbox, bool anyoneIfNoneConnected)
    {
        Member? next = null;
        foreach (var m in _members)
        {
            if (m.Connected && (next is null || m.Arrival < next.Arrival)) next = m;
        }

        if (next is null && anyoneIfNoneConnected && _members.Count > 0) next = _members[0];
        if (next is null)
        {
            if (_members.Count == 0) _hostId = 0;
            return;
        }

        if (next.Id == _hostId) return;
        _hostId = next.Id;
        Announce(outbox, $"{next.Name} is now the host");
    }

    // ------------------------------------------------------------------------------------
    //  Lobby
    // ------------------------------------------------------------------------------------

    public void SetTeam(string connectionId, int team) => Act(connectionId, (m, outbox) =>
    {
        if (_phase != Lobby || team is < -1 or > 1 || team == m.Team) return;
        if (team >= 0 && HumansOn(team, m) >= Vocabulary.HumansPerTeam) return;
        m.Team = team;
        BroadcastState(outbox);
    });

    public void SetReady(string connectionId, bool ready) => Act(connectionId, (m, outbox) =>
    {
        if (_phase != Lobby || m.Ready == ready) return;
        m.Ready = ready;
        BroadcastState(outbox);
    });

    public void SetProfile(string connectionId, ProfileDto? profile) => Act(connectionId, (m, outbox) =>
    {
        if (profile is null) return;
        bool changed = false;

        if (profile.Nickname is not null)
        {
            string wanted = TextRules.Clean(profile.Nickname, Vocabulary.MaxNickname);
            if (wanted.Length > 0)
            {
                string unique = TextRules.Unique(wanted, _members.Where(x => x != m).Select(x => x.Name), Vocabulary.MaxNickname);
                if (unique != m.Name)
                {
                    m.Name = unique;
                    changed = true;
                }

                m.RequestedName = wanted;
            }
        }

        if (TextRules.IsColor(profile.Color))
        {
            string color = profile.Color!.ToLowerInvariant();
            changed |= color != m.Color;
            m.Color = color;
        }

        if (profile.Celebration is not null)
        {
            string celebration = Vocabulary.Celebrations.Contains(profile.Celebration) ? profile.Celebration : Vocabulary.Celebrations[0];
            changed |= celebration != m.Celebration;
            m.Celebration = celebration;
        }

        if (profile.AutoSwitch is bool autoSwitch)
        {
            m.AutoSwitch = autoSwitch;
            if (_match is not null && m.HumanId >= 0 && _seats[m.HumanId]?.Member == m)
            {
                _match.SetHumanAutoSwitch(m.HumanId, autoSwitch);
            }
        }

        if (changed) BroadcastState(outbox);
    });

    public void SetTeamConfig(string connectionId, int team, TeamConfigDto? config) => Act(connectionId, (m, outbox) =>
    {
        if (_phase != Lobby || team is < 0 or > 1 || config is null) return;
        if (m.Id != _hostId && m.Team != team) return;
        _teams[team] = TeamRules.Normalize(config, _teams[team], _services.Catalog.IsPresetId);
        _teamDtos = null;
        BroadcastState(outbox);
    });

    public void SetSettings(string connectionId, MatchSettingsDto? settings) => Act(connectionId, (m, outbox) =>
    {
        if (_phase != Lobby || m.Id != _hostId || settings is null) return;
        _settings = TeamRules.FromDto(settings);
        _teamDtos = null;
        BroadcastState(outbox);
    });

    public void StartMatch(string connectionId) => Act(connectionId, (m, outbox) =>
    {
        if (_phase != Lobby || m.Id != _hostId) return;
        StartMatchLocked(outbox, skipInitFor: null);
    });

    public void Rematch(string connectionId) => Act(connectionId, (m, outbox) =>
    {
        if (_phase != Finished || m.Id != _hostId) return;
        StartMatchLocked(outbox, skipInitFor: null);
    });

    public void BackToLobby(string connectionId) => Act(connectionId, (m, outbox) =>
    {
        if (_phase == Lobby || m.Id != _hostId) return;
        ReturnToLobby(outbox);
    });

    private void Act(string connectionId, Action<Member, Outbox> action)
    {
        var outbox = new Outbox();
        lock (_gate)
        {
            var m = Caller(connectionId);
            if (m is null) return;
            action(m, outbox);
        }

        Dispatch(outbox);
    }

    // ------------------------------------------------------------------------------------
    //  Chat, emotes, pings
    // ------------------------------------------------------------------------------------

    public void Chat(string connectionId, string? text) => Act(connectionId, (m, outbox) =>
    {
        string clean = TextRules.Clean(text, Vocabulary.MaxChat);
        if (clean.Length == 0 || !Allow(m.ChatTimes, ChatLimit, ChatWindow)) return;
        outbox.Chat(new ChatDto { MemberId = m.Id, Name = m.Name, Team = m.Team, Text = clean, System = false });
    });

    public void Emote(string connectionId, int emote) => Act(connectionId, (m, outbox) =>
    {
        if (emote < 0 || emote >= Vocabulary.Emotes.Length || !Allow(m.EmoteTimes, EmoteLimit, EmoteWindow)) return;
        int human = _phase != Lobby && m.HumanId >= 0 && _seats[m.HumanId]?.Member == m ? m.HumanId : -1;
        outbox.Emote(new EmoteDto { MemberId = m.Id, HumanId = human, Emote = emote });
    });

    private bool Allow(Queue<DateTimeOffset> times, int limit, TimeSpan window)
    {
        var now = Now;
        while (times.Count > 0 && now - times.Peek() >= window) times.Dequeue();
        if (times.Count >= limit) return false;
        times.Enqueue(now);
        return true;
    }

    public void ReportPing(string connectionId, int milliseconds)
    {
        lock (_gate)
        {
            var m = Caller(connectionId);
            if (m is null) return;
            int ping = Math.Clamp(milliseconds, 0, 99_999);
            if (ping == m.Ping) return;
            m.Ping = ping;
            _pingDirty = true;
        }
    }

    private void Announce(Outbox outbox, string text) =>
        outbox.Chat(new ChatDto { MemberId = 0, Name = "", Team = -1, Text = text, System = true });

    // ------------------------------------------------------------------------------------
    //  Match lifecycle
    // ------------------------------------------------------------------------------------

    private bool StartMatchLocked(Outbox outbox, string? skipInitFor)
    {
        var settings = _settings.Normalized();
        int size = settings.TeamSize;
        var config = new MatchConfig
        {
            Settings = settings,
            Formations = [Formations.Resolve(_teams[0].Formation, size), Formations.Resolve(_teams[1].Formation, size)],
            Practice = Practice,
            KickoffTeam = _matchId % 2,
        };

        var match = new Match(config, _services.Tuning, seed: Random.Shared.Next(1, int.MaxValue));

        foreach (var m in _members) m.HumanId = -1;
        var seats = new HumanSeat?[4];
        var humans = new List<HumanInfoDto>(4);
        for (int team = 0; team < 2; team++)
        {
            int id = team * Vocabulary.HumansPerTeam;
            foreach (var m in _members)
            {
                if (m.Team != team) continue;
                if (id >= (team + 1) * Vocabulary.HumansPerTeam) break;
                if (match.AddHuman(id, team, m.AutoSwitch) < 0) continue;

                // Presence comes from input flow: everyone starts away until their inputs arrive.
                match.SetHumanConnected(id, false);
                var info = new HumanInfoDto
                {
                    HumanId = id,
                    MemberId = m.Id,
                    Name = m.Name,
                    Team = team,
                    Color = m.Color,
                    Celebration = m.Celebration,
                };
                seats[id] = new HumanSeat(id, m, info);
                humans.Add(info);
                m.HumanId = id;
                id++;
            }
        }

        _match = match;
        _seats = seats;
        _humans = humans.ToArray();
        Array.Clear(_acks);
        _players = BuildPlayers(match);
        _matchId++;
        _phase = Playing;
        _result = null;
        _pendingEvents.Clear();
        _ticksSinceSnap = 0;
        _nonFiniteLogged = false;
        _failures = 0;
        _failureLogged = false;
        foreach (var m in _members) m.Link?.Carried.Clear();

        var pitch = match.Pitch;
        _init = new MatchInitDto
        {
            MatchId = _matchId,
            Practice = Practice,
            Pitch = new PitchDto
            {
                Width = pitch.Width,
                Height = pitch.Height,
                GoalWidth = pitch.GoalWidth,
                GoalDepth = pitch.GoalDepth,
                PostRadius = pitch.PostRadius,
                CornerRadius = pitch.CornerRadius,
                BoxDepth = pitch.BoxDepth,
                BoxHalfWidth = pitch.BoxHalfWidth,
                CenterRadius = pitch.CenterRadius,
            },
            Tuning = _services.Tuning,
            Settings = TeamRules.ToDto(settings),
            Teams = TeamDtos(),
            Players = _players,
            Humans = _humans,
            Tick = match.State.Tick,
        };

        BroadcastState(outbox);
        foreach (var m in _members)
        {
            if (m is { Connected: true, IsMatchPage: true, ConnectionId: { } c } && c != skipInitFor) outbox.MatchInit(c, _init);
        }

        return true;
    }

    private PlayerInfoDto[] BuildPlayers(Match match)
    {
        var players = match.State.Players;
        var result = new PlayerInfoDto[players.Length];
        for (int i = 0; i < players.Length; i++)
        {
            ref readonly var p = ref players[i];
            var roster = _teams[p.Team].Roster;
            var entry = p.Slot < roster.Count ? roster[p.Slot] : null;
            result[i] = new PlayerInfoDto
            {
                Index = i,
                Team = p.Team,
                Slot = p.Slot,
                Keeper = p.IsKeeper,
                Name = entry?.Name ?? $"Player {p.Slot + 1}",
                Number = entry?.Number ?? p.Slot + 1,
            };
        }

        return result;
    }

    /// <summary>The match's init message stamped with the current tick.</summary>
    private MatchInitDto? InitNow()
    {
        if (_init is null) return null;
        return new MatchInitDto
        {
            MatchId = _init.MatchId,
            Practice = _init.Practice,
            Pitch = _init.Pitch,
            Tuning = _init.Tuning,
            Settings = _init.Settings,
            Teams = _init.Teams,
            Players = _init.Players,
            Humans = _init.Humans,
            Tick = _match?.State.Tick ?? _init.Tick,
        };
    }

    private void ReturnToLobby(Outbox outbox)
    {
        _match = null;
        _seats = new HumanSeat?[4];
        _humans = [];
        _players = [];
        _init = null;
        _result = null;
        _pendingEvents.Clear();
        Array.Clear(_acks);
        _phase = Lobby;
        _lobbySince = Now;
        foreach (var m in _members)
        {
            m.Ready = false;
            m.HumanId = -1;
            m.Link?.Carried.Clear();
        }

        BroadcastState(outbox);
    }

    // ------------------------------------------------------------------------------------
    //  Inputs and the tick
    // ------------------------------------------------------------------------------------

    public void Input(string connectionId, InputDto? input)
    {
        if (input is null) return;
        lock (_gate)
        {
            if (_phase != Playing || _match is null) return;
            var m = Caller(connectionId);
            if (m is null || !m.IsMatchPage || m.HumanId < 0) return;
            var seat = _seats[m.HumanId];
            if (seat is null || seat.Member != m) return;

            seat.Queue.Enqueue(QueuedInput.From(input));
            seat.Silence = 0;
            if (!seat.AtControls)
            {
                seat.AtControls = true;
                _match.SetHumanConnected(seat.HumanId, true);
            }
        }
    }

    /// <summary>Advances the match by one 1/60 s step. Called by the game loop (and directly by tests).</summary>
    public void Tick()
    {
        var outbox = new Outbox();
        lock (_gate)
        {
            if (_closed || _phase != Playing || _match is null) return;
            try
            {
                TickLocked(outbox);
                _failures = 0;
            }
            catch (Exception ex)
            {
                _failures++;
                if (!_failureLogged)
                {
                    _failureLogged = true;
                    _log.LogError(ex, "Room {Code}: match {MatchId} failed to step", Code, _matchId);
                }

                if (_failures >= FailuresBeforeAbandon)
                {
                    _log.LogError("Room {Code}: abandoning match {MatchId} after repeated failures", Code, _matchId);
                    outbox.Items.Clear();
                    Announce(outbox, "The match hit a server problem and was abandoned.");
                    ReturnToLobby(outbox);
                }
            }
        }

        Dispatch(outbox);
    }

    private void TickLocked(Outbox outbox)
    {
        var match = _match!;
        foreach (var seat in _seats)
        {
            if (seat is not { AtControls: true }) continue;
            if (++seat.Silence >= HumanSeat.SilenceTicks)
            {
                // Background tab, alt-tab or a stalled network: the AI plays until inputs resume.
                seat.AtControls = false;
                seat.Queue.Clear();
                match.SetHumanConnected(seat.HumanId, false);
                continue;
            }

            var input = seat.Queue.Next(out bool fresh);
            match.SetInput(seat.HumanId, input.ToPlayerInput());
            if (fresh)
            {
                seat.Ack = input.Seq;
                _acks[seat.HumanId] = input.Seq;
            }
        }

        match.Step();

        bool bad = false;
        var events = match.Events;
        for (int i = 0; i < events.Count; i++)
        {
            var e = events[i];
            _pendingEvents.Add(Snapshots.Event(e, ref bad));
        }

        _ticksSinceSnap++;
        if (match.IsOver)
        {
            NoteNonFinite(bad);
            Finish(outbox, match);
            return;
        }

        if (_ticksSinceSnap >= Math.Max(1, _services.Tuning.SnapshotEveryTicks))
        {
            _ticksSinceSnap = 0;
            bad |= QueueSnapshots(outbox, match);
        }

        NoteNonFinite(bad);
    }

    private void NoteNonFinite(bool bad)
    {
        if (!bad || _nonFiniteLogged) return;
        _nonFiniteLogged = true;
        _log.LogWarning("Room {Code}: match {MatchId} produced a non-finite number; sent as 0", Code, _matchId);
    }

    /// <summary>Queues one snapshot per match-page connection. Returns true when a value was not finite.</summary>
    private bool QueueSnapshots(Outbox outbox, Match match)
    {
        bool bad = false;
        var snap = Snapshots.Build(match, _acks, ref bad);
        float[][] fresh = _pendingEvents.Count > 0 ? _pendingEvents.ToArray() : [];
        _pendingEvents.Clear();

        foreach (var m in _members)
        {
            if (!m.Connected || !m.IsMatchPage || m.Link is not { } link) continue;

            // A slow client drops frames instead of building a backlog; its events wait for the next one.
            if (link.Busy)
            {
                if (fresh.Length > 0) link.Carry(fresh);
                continue;
            }

            float[][]? events;
            if (link.Carried.Count > 0)
            {
                link.Carried.AddRange(fresh);
                events = link.Carried.ToArray();
                link.Carried.Clear();
            }
            else
            {
                events = fresh.Length > 0 ? fresh : null;
            }

            outbox.Snap(link, Snapshots.WithEvents(snap, events));
        }

        return bad;
    }

    private void Finish(Outbox outbox, Match match)
    {
        try
        {
            _result = Results.Build(_matchId, match, _humans, _players, _services.Tuning);
            _phase = Finished;
            NoteNonFinite(QueueSnapshots(outbox, match));
            outbox.MatchEnd(_result);
            BroadcastState(outbox);
        }
        catch (Exception ex)
        {
            _log.LogError(ex, "Room {Code}: could not finish match {MatchId}; returning to the lobby", Code, _matchId);
            outbox.Items.Clear();
            ReturnToLobby(outbox);
        }
    }

    // ------------------------------------------------------------------------------------
    //  Housekeeping
    // ------------------------------------------------------------------------------------

    /// <summary>
    /// Periodic upkeep: disconnect announcements, removal of members who stayed away, host
    /// hand-over and coalesced ping broadcasts. Returns true when the room should be deleted.
    /// </summary>
    public bool Housekeep()
    {
        var outbox = new Outbox();
        bool dead;
        lock (_gate)
        {
            if (_closed) return true;
            var now = Now;
            bool changed = false;

            foreach (var m in _members.ToArray())
            {
                if (m.Connected) continue;
                var away = now - m.DisconnectedAt;
                if (!m.DisconnectAnnounced && away >= AnnounceAfter)
                {
                    m.DisconnectAnnounced = true;
                    Announce(outbox, $"{m.Name} lost connection");
                }

                if (_phase != Lobby) continue;

                // Seats survive a match; after it, the returning lobby gives absentees a minute.
                var deadline = m.DisconnectedAt >= _lobbySince ? m.DisconnectedAt + LobbyGrace : _lobbySince + AfterMatchGrace;
                if (now >= deadline)
                {
                    RemoveMember(m, outbox, $"{m.Name} left");
                    changed = true;
                }
            }

            var host = _members.Find(m => m.Id == _hostId);
            if (host is null)
            {
                int before = _hostId;
                HandOverHost(outbox, anyoneIfNoneConnected: true);
                changed |= before != _hostId;
            }
            else if (!host.Connected && now - host.DisconnectedAt >= HostGrace)
            {
                // Only the host can rematch or return to the lobby: never leave the room stranded.
                int before = _hostId;
                HandOverHost(outbox, anyoneIfNoneConnected: false);
                changed |= before != _hostId;
            }

            if (_pingDirty && now - _lastStateBroadcast >= PingBroadcastInterval) changed = true;
            if (changed) BroadcastState(outbox);

            if (_members.Exists(m => m.Connected))
            {
                _emptySince = null;
                dead = false;
            }
            else
            {
                _emptySince ??= now;
                dead = now - _emptySince.Value >= EmptyLifetime;
            }
        }

        Dispatch(outbox);
        return dead;
    }

    // ------------------------------------------------------------------------------------
    //  State and sending
    // ------------------------------------------------------------------------------------

    private RoomStateDto BroadcastState(Outbox outbox)
    {
        var state = BuildState();
        outbox.RoomState(state, ++_stateVersion);
        _pingDirty = false;
        _lastStateBroadcast = Now;
        return state;
    }

    private RoomStateDto BuildState()
    {
        var members = new MemberDto[_members.Count];
        for (int i = 0; i < members.Length; i++) members[i] = _members[i].ToDto(_hostId);
        return new RoomStateDto
        {
            Code = Code,
            Phase = _phase,
            Practice = Practice,
            HostId = _hostId,
            MatchId = _matchId,
            Members = members,
            Teams = TeamDtos(),
            Settings = TeamRules.ToDto(_settings),
        };
    }

    /// <summary>Both teams with resolved kits. Cached; the objects are never modified once built.</summary>
    private TeamDto[] TeamDtos()
    {
        if (_teamDtos is not null) return _teamDtos;
        var kits = KitResolver.Resolve(_teams[0], _teams[1]);
        int size = _settings.TeamSize;
        _teamDtos =
        [
            new TeamDto { Config = _teams[0], Kit = kits[0], Formation = Formations.Resolve(_teams[0].Formation, size) },
            new TeamDto { Config = _teams[1], Kit = kits[1], Formation = Formations.Resolve(_teams[1].Formation, size) },
        ];
        return _teamDtos;
    }

    /// <summary>
    /// Starts every send in the outbox, in order, without waiting for any of them. A separate
    /// lock keeps sends from different calls in a consistent order per connection, and a room
    /// state older than one already sent is dropped.
    /// </summary>
    private void Dispatch(Outbox outbox)
    {
        if (outbox.IsEmpty) return;
        var gateway = _services.Gateway;
        lock (_sendGate)
        {
            foreach (var item in outbox.Items)
            {
                Task task;
                try
                {
                    switch (item.Kind)
                    {
                        case OutKind.AddToGroup:
                            task = gateway.AddToGroupAsync(item.Connection!, Group);
                            break;
                        case OutKind.RemoveFromGroup:
                            task = gateway.RemoveFromGroupAsync(item.Connection!, Group);
                            break;
                        case OutKind.RoomState:
                            if (item.Version <= _sentStateVersion) continue;
                            _sentStateVersion = item.Version;
                            task = gateway.Group(Group).RoomState((RoomStateDto)item.Payload!);
                            break;
                        case OutKind.MatchInit:
                            task = gateway.Client(item.Connection!).MatchInit((MatchInitDto)item.Payload!);
                            break;
                        case OutKind.MatchEnd:
                            task = gateway.Group(Group).MatchEnd((MatchResultDto)item.Payload!);
                            break;
                        case OutKind.Snap:
                            task = gateway.Client(item.Connection!).Snap((SnapDto)item.Payload!);
                            item.Link!.Pending = task;
                            break;
                        case OutKind.Chat:
                            task = gateway.Group(Group).Chat((ChatDto)item.Payload!);
                            break;
                        case OutKind.Emote:
                            task = gateway.Group(Group).Emote((EmoteDto)item.Payload!);
                            break;
                        case OutKind.Closed:
                            task = gateway.Client(item.Connection!).Closed((string)item.Payload!);
                            break;
                        default:
                            continue;
                    }
                }
                catch (Exception ex)
                {
                    _log.LogDebug(ex, "Room {Code}: {Kind} could not be sent", Code, item.Kind);
                    continue;
                }

                if (!task.IsCompletedSuccessfully) Observe(task, item.Kind);
            }
        }
    }

    private void Observe(Task task, OutKind kind) =>
        task.ContinueWith(
            static (t, state) =>
            {
                var (log, code, k) = ((ILogger, string, OutKind))state!;
                log.LogDebug(t.Exception, "Room {Code}: {Kind} send failed", code, k);
            },
            (_log, Code, kind),
            CancellationToken.None,
            TaskContinuationOptions.OnlyOnFaulted | TaskContinuationOptions.ExecuteSynchronously,
            TaskScheduler.Default);
}
