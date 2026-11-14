using System.Net;
using Microsoft.AspNetCore.Mvc.Testing;

namespace OfficeKickoff.Web.Tests.Integration;

public class PageTests(KickoffFactory factory) : IClassFixture<KickoffFactory>
{
    private HttpClient Client() => factory.CreateClient(new WebApplicationFactoryClientOptions { AllowAutoRedirect = false });

    [Fact]
    public async Task Home_page_renders()
    {
        var response = await Client().GetAsync("/");
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Contains("text/html", response.Content.Headers.ContentType?.ToString());
    }

    [Fact]
    public async Task Home_page_renders_with_an_error_and_code()
    {
        var response = await Client().GetAsync("/?error=notfound&code=ABCD");
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
    }

    [Fact]
    public async Task Create_redirects_to_the_lobby_of_a_new_room()
    {
        var client = Client();
        var response = await client.PostAsync("/create", null);
        Assert.Equal(HttpStatusCode.Redirect, response.StatusCode);

        string location = response.Headers.Location!.OriginalString;
        Assert.Matches("^/room/[A-HJ-NP-Z]{4}$", location);
        string code = location[^4..];
        Assert.NotNull(factory.Rooms.Find(code));

        var lobby = await client.GetAsync(location);
        Assert.Equal(HttpStatusCode.OK, lobby.StatusCode);
        Assert.Contains(code, await lobby.Content.ReadAsStringAsync());

        var lower = await client.GetAsync("/room/" + code.ToLowerInvariant());
        Assert.Equal(HttpStatusCode.Redirect, lower.StatusCode);
        Assert.Equal(location, lower.Headers.Location!.OriginalString);
    }

    [Fact]
    public async Task Practice_redirects_to_the_match_page_of_a_practice_room()
    {
        var client = Client();
        var response = await client.PostAsync("/practice", null);
        Assert.Equal(HttpStatusCode.Redirect, response.StatusCode);

        string location = response.Headers.Location!.OriginalString;
        Assert.Matches("^/room/[A-HJ-NP-Z]{4}/match$", location);
        var room = factory.Rooms.Find(location.Split('/')[2]);
        Assert.NotNull(room);
        Assert.True(room!.Practice);

        var page = await client.GetAsync(location);
        Assert.Equal(HttpStatusCode.OK, page.StatusCode);
    }

    [Fact]
    public async Task Join_with_a_known_code_goes_to_the_lobby_in_any_case()
    {
        var room = factory.Rooms.Create(practice: false)!;
        var response = await Client().GetAsync("/join?code=%20" + room.Code.ToLowerInvariant() + "%20");
        Assert.Equal(HttpStatusCode.Redirect, response.StatusCode);
        Assert.Equal("/room/" + room.Code, response.Headers.Location!.OriginalString);
    }

    [Fact]
    public async Task Join_with_an_unknown_code_goes_home_with_notfound()
    {
        var response = await Client().GetAsync("/join?code=zzzz");
        Assert.Equal(HttpStatusCode.Redirect, response.StatusCode);
        Assert.Equal("/?error=notfound&code=ZZZZ", response.Headers.Location!.OriginalString);

        var garbage = await Client().GetAsync("/join?code=%3Cscript%3E");
        Assert.Equal("/?error=notfound", garbage.Headers.Location!.OriginalString);
    }

    [Theory]
    [InlineData("/room/QQQQ")]
    [InlineData("/room/QQQQ/match")]
    public async Task Unknown_rooms_redirect_home(string url)
    {
        var response = await Client().GetAsync(url);
        Assert.Equal(HttpStatusCode.Redirect, response.StatusCode);
        Assert.StartsWith("/?error=notfound", response.Headers.Location!.OriginalString);
    }

    [Fact]
    public async Task Health_check_says_ok()
    {
        var response = await Client().GetAsync("/healthz");
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal("ok", await response.Content.ReadAsStringAsync());
    }

    [Fact]
    public async Task Static_files_are_always_revalidated()
    {
        var response = await Client().GetAsync("/css/theme.css");
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal("no-cache", response.Headers.CacheControl?.ToString());
        Assert.True(response.Headers.ETag is not null || response.Content.Headers.LastModified is not null);
    }

    [Fact]
    public async Task Posts_work_without_an_antiforgery_token()
    {
        var content = new FormUrlEncodedContent([new KeyValuePair<string, string>("x", "1")]);
        var response = await Client().PostAsync("/create", content);
        Assert.Equal(HttpStatusCode.Redirect, response.StatusCode);
    }
}
