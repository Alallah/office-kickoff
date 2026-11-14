namespace OfficeKickoff.Web.Models;

/// <summary>Model of the Home page.</summary>
/// <param name="Error">
/// Optional error to show: "notfound" (no room with that code), "closed" (the room was deleted),
/// "full" (the room has its maximum number of members), "busy" (the server has its maximum number
/// of rooms) or "replaced" (this player opened the room in another tab).
/// </param>
/// <param name="Code">Room code to pre-fill in the join box, if any.</param>
public sealed record HomeViewModel(string? Error = null, string? Code = null);

/// <summary>Model of the Lobby and Match pages.</summary>
/// <param name="Code">Validated, upper-case room code.</param>
public sealed record RoomPageModel(string Code);
