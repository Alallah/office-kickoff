using Microsoft.Net.Http.Headers;
using OfficeKickoff.Sim;
using OfficeKickoff.Web.Hubs;
using OfficeKickoff.Web.Rooms;
using OfficeKickoff.Web.Services;

var builder = WebApplication.CreateBuilder(args);

// One tuning instance for the whole server: class defaults, overridden by the "Tuning" section.
var tuning = new Tuning();
builder.Configuration.GetSection("Tuning").Bind(tuning);
builder.Services.AddSingleton(tuning);

builder.Services.AddSingleton(TimeProvider.System);
builder.Services.AddSingleton(sp => TeamCatalog.Load(
    sp.GetRequiredService<IWebHostEnvironment>().ContentRootPath,
    sp.GetRequiredService<ILoggerFactory>().CreateLogger<TeamCatalog>()));
builder.Services.AddSingleton<IClientGateway, HubClientGateway>();
builder.Services.AddSingleton<RoomServices>();
builder.Services.AddSingleton<RoomManager>();
builder.Services.AddHostedService<GameLoop>();

builder.Services.AddControllersWithViews();
builder.Services.AddSignalR(options =>
{
    // Must match js/shared/net.js (withKeepAliveInterval 4000, withServerTimeout 15000).
    options.KeepAliveInterval = TimeSpan.FromSeconds(4);
    options.ClientTimeoutInterval = TimeSpan.FromSeconds(15);
    options.MaximumReceiveMessageSize = 32 * 1024;
    options.EnableDetailedErrors = builder.Environment.IsDevelopment();
});

var app = builder.Build();

// Fail at start-up, not on the first join, if the team presets are missing or broken.
app.Services.GetRequiredService<TeamCatalog>();

if (!app.Environment.IsDevelopment())
{
    app.UseExceptionHandler("/error");
}

// No HTTPS redirection and no HSTS: IIS terminates TLS where there is any, and plain-http
// intranet hosting must keep working.
app.UseStaticFiles(new StaticFileOptions
{
    // Revalidate every time (ETag / Last-Modified) so a redeploy is picked up at once.
    OnPrepareResponse = context => context.Context.Response.Headers[HeaderNames.CacheControl] = "no-cache",
});

app.UseRouting();
app.MapControllers();
app.MapHub<GameHub>("/hub/game");

app.Run();

/// <summary>Entry point; partial so integration tests can use WebApplicationFactory&lt;Program&gt;.</summary>
public partial class Program;
