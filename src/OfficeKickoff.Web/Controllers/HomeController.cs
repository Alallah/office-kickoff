using Microsoft.AspNetCore.Mvc;
using OfficeKickoff.Web.Models;
using OfficeKickoff.Web.Rooms;

namespace OfficeKickoff.Web.Controllers;

/// <summary>Home page, room creation and joining by code. Every redirect is built with the URL helpers so an IIS sub-path works.</summary>
public sealed class HomeController(RoomManager rooms) : Controller
{
    [HttpGet("/")]
    public IActionResult Index(string? error, string? code) => View(new HomeViewModel(error, code));

    /// <summary>
    /// No antiforgery token: there is no authentication to protect, and an IIS app pool without a
    /// user profile would lose its key ring on every recycle, rejecting every form.
    /// </summary>
    [HttpPost("/create")]
    [IgnoreAntiforgeryToken]
    public IActionResult Create()
    {
        var room = rooms.Create(practice: false);
        return room is null
            ? RedirectToAction(nameof(Index), new { error = "busy" })
            : RedirectToAction(nameof(RoomController.Lobby), "Room", new { code = room.Code });
    }

    [HttpPost("/practice")]
    [IgnoreAntiforgeryToken]
    public IActionResult Practice()
    {
        var room = rooms.Create(practice: true);
        return room is null
            ? RedirectToAction(nameof(Index), new { error = "busy" })
            : RedirectToAction(nameof(RoomController.Match), "Room", new { code = room.Code });
    }

    [HttpGet("/join")]
    public IActionResult Join(string? code)
    {
        var room = rooms.Find(code);
        if (room is not null) return RedirectToAction(nameof(RoomController.Lobby), "Room", new { code = room.Code });
        return RedirectToAction(nameof(Index), new { error = "notfound", code = RoomCodes.Normalize(code) });
    }

    [HttpGet("/healthz")]
    public IActionResult Health() => Content("ok", "text/plain");

    [Route("/error")]
    [ResponseCache(Duration = 0, Location = ResponseCacheLocation.None, NoStore = true)]
    public IActionResult Error()
    {
        Response.StatusCode = StatusCodes.Status500InternalServerError;
        return View();
    }
}
