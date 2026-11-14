using System.Globalization;
using OfficeKickoff.Web.Protocol;

namespace OfficeKickoff.Web.Rooms;

/// <summary>
/// Decides which colours the two teams actually wear so that shirts never clash with each
/// other, with the pitch, or with the goalkeepers. Colour distance is CIE76 delta-E in CIELAB.
/// </summary>
public static class KitResolver
{
    public const string PitchColor = "#17603a";

    /// <summary>Two outfield shirts closer than this are a clash.</summary>
    public const double ShirtClash = 38;

    /// <summary>An outfield shirt closer than this to the grass is hard to see.</summary>
    public const double PitchClash = 30;

    /// <summary>A keeper shirt closer than this to an outfield shirt or the grass is replaced.</summary>
    public const double KeeperClash = 30;

    private const string White = "#ffffff";
    private const string Ink = "#111111";

    /// <summary>Shirts tried, in order, when neither of a team's own colours works.</summary>
    public static readonly string[] OutfieldFallbacks =
        ["#f5f5f5", "#1b1b1b", "#ffd60a", "#e63946", "#3a86ff", "#ff7f11", "#9d4edd", "#00b4d8"];

    /// <summary>Goalkeeper shirts tried, in order, when the configured one clashes.</summary>
    public static readonly string[] KeeperFallbacks =
        ["#b6ff3c", "#ff2fd0", "#00e5ff", "#ffb703", "#f1f1f1", "#2b2d42", "#ff5400", "#8338ec"];

    /// <summary>Kits for [home, away].</summary>
    public static KitDto[] Resolve(TeamConfigDto home, TeamConfigDto away)
    {
        // Home keeps its primary unless it disappears into the grass.
        var (homeShirt, homeTrim) = PickOutfield(home, null);
        var (awayShirt, awayTrim) = PickOutfield(away, homeShirt);

        string homeKeeper = PickKeeper(home.Keeper, homeShirt, awayShirt, null);
        string awayKeeper = PickKeeper(away.Keeper, homeShirt, awayShirt, homeKeeper);

        return
        [
            Kit(homeShirt, homeTrim, homeKeeper, !Same(homeShirt, home.Primary)),
            Kit(awayShirt, awayTrim, awayKeeper, !Same(awayShirt, away.Primary)),
        ];
    }

    private static KitDto Kit(string shirt, string trim, string keeper, bool swapped) => new()
    {
        Primary = shirt,
        Secondary = trim,
        Keeper = keeper,
        Text = TextOn(shirt),
        Swapped = swapped,
    };

    private static (string Shirt, string Trim) PickOutfield(TeamConfigDto team, string? rival)
    {
        string primary = TextRules.Color(team.Primary, OutfieldFallbacks[0]);
        string secondary = TextRules.Color(team.Secondary, OutfieldFallbacks[1]);

        if (OutfieldOk(primary, rival)) return (primary, secondary);
        if (OutfieldOk(secondary, rival)) return (secondary, primary);

        foreach (string candidate in OutfieldFallbacks)
        {
            if (OutfieldOk(candidate, rival)) return (candidate, BestTrim(candidate, primary, secondary));
        }

        // Unreachable with the fallback list above; keep a readable answer anyway.
        string last = rival is not null && Distance(rival, White) < ShirtClash ? Ink : White;
        return (last, BestTrim(last, primary, secondary));
    }

    private static bool OutfieldOk(string shirt, string? rival) =>
        Distance(shirt, PitchColor) >= PitchClash && (rival is null || Distance(shirt, rival) >= ShirtClash);

    /// <summary>Of the team's two colours, the one that stands out more on the given shirt.</summary>
    private static string BestTrim(string shirt, string primary, string secondary) =>
        Distance(shirt, primary) >= Distance(shirt, secondary) ? primary : secondary;

    private static string PickKeeper(string? configured, string homeShirt, string awayShirt, string? otherKeeper)
    {
        string keeper = TextRules.Color(configured, KeeperFallbacks[0]);
        if (KeeperOk(keeper, homeShirt, awayShirt, otherKeeper)) return keeper;

        foreach (string candidate in KeeperFallbacks)
        {
            if (KeeperOk(candidate, homeShirt, awayShirt, otherKeeper)) return candidate;
        }

        // Two keepers looking alike is the least bad compromise.
        foreach (string candidate in KeeperFallbacks)
        {
            if (KeeperOk(candidate, homeShirt, awayShirt, null)) return candidate;
        }

        return keeper;
    }

    private static bool KeeperOk(string keeper, string homeShirt, string awayShirt, string? otherKeeper) =>
        Distance(keeper, homeShirt) >= KeeperClash &&
        Distance(keeper, awayShirt) >= KeeperClash &&
        Distance(keeper, PitchColor) >= KeeperClash &&
        (otherKeeper is null || Distance(keeper, otherKeeper) >= KeeperClash);

    /// <summary>"#ffffff" or "#111111", whichever has the higher WCAG contrast on <paramref name="background"/>.</summary>
    public static string TextOn(string background)
    {
        double l = RelativeLuminance(background);
        double onWhite = (1.05) / (l + 0.05);
        double onInk = (l + 0.05) / (RelativeLuminance(Ink) + 0.05);
        return onWhite >= onInk ? White : Ink;
    }

    private static bool Same(string a, string? b) => string.Equals(a, b, StringComparison.OrdinalIgnoreCase);

    // ------------------------------------------------------------------------------------
    //  Colour maths
    // ------------------------------------------------------------------------------------

    /// <summary>CIE76 delta-E between two "#rrggbb" colours.</summary>
    public static double Distance(string a, string b)
    {
        var (l1, a1, b1) = ToLab(a);
        var (l2, a2, b2) = ToLab(b);
        double dl = l1 - l2, da = a1 - a2, db = b1 - b2;
        return Math.Sqrt(dl * dl + da * da + db * db);
    }

    public static (double L, double A, double B) ToLab(string hex)
    {
        var (r, g, b) = Linear(hex);

        // sRGB (D65) to XYZ, normalised by the D65 white point.
        double x = (0.4124564 * r + 0.3575761 * g + 0.1804375 * b) / 0.95047;
        double y = 0.2126729 * r + 0.7151522 * g + 0.0721750 * b;
        double z = (0.0193339 * r + 0.1191920 * g + 0.9503041 * b) / 1.08883;

        double fx = F(x), fy = F(y), fz = F(z);
        return (116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz));

        static double F(double t) => t > 216.0 / 24389 ? Math.Cbrt(t) : (24389.0 / 27 * t + 16) / 116;
    }

    private static double RelativeLuminance(string hex)
    {
        var (r, g, b) = Linear(hex);
        return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    }

    private static (double R, double G, double B) Linear(string hex)
    {
        string h = TextRules.IsColor(hex) ? hex : White;
        return (Channel(h, 1), Channel(h, 3), Channel(h, 5));

        static double Channel(string h, int at)
        {
            double c = int.Parse(h.AsSpan(at, 2), NumberStyles.HexNumber, CultureInfo.InvariantCulture) / 255.0;
            return c <= 0.04045 ? c / 12.92 : Math.Pow((c + 0.055) / 1.055, 2.4);
        }
    }
}
