using Microsoft.AspNetCore.Mvc;
using OfficeKickoff.Web.Models;
using OfficeKickoff.Web.Rooms;

namespace OfficeKickoff.Web.Controllers;

/// <summary>The lobby and match pages of a room. Unknown rooms send the visitor home with error=notfound.</summary>
public sealed class RoomController(RoomManager rooms) : Controller
{
    [HttpGet("/room/{code}")]
    public IActionResult Lobby(string code) => Page(code, "Lobby");

    [HttpGet("/room/{code}/match")]
    public IActionResult Match(string code) => Page(code, "Match");

    private IActionResult Page(string code, string view)
    {
        var room = rooms.Find(code);
        if (room is null || room.IsClosed)
        {
            return RedirectToAction(nameof(HomeController.Index), "Home", new { error = "notfound", code = RoomCodes.Normalize(code) });
        }

        // Canonical upper-case URL, so a shared link always looks the same.
        if (!string.Equals(code, room.Code, StringComparison.Ordinal))
        {
            return RedirectToAction(view, new { code = room.Code });
        }

        return View(view, new RoomPageModel(room.Code));
    }
}
