using System.Security.Cryptography;
using OfficeKickoff.Web.Protocol;

namespace OfficeKickoff.Web.Rooms;

/// <summary>Four-letter room codes: easy to read out across an office (no I or O), never rude.</summary>
public static class RoomCodes
{
    public const string Alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ";

    private static readonly HashSet<string> RudeWords = new(StringComparer.Ordinal)
    {
        "ANAL", "ANUS", "ARSE", "BUTT", "CRAP", "CUNT", "DAMN", "DYKE", "FUCK", "FUKK", "FUXX",
        "HELL", "JERK", "JUGS", "KUNT", "MUFF", "PRAT", "PUKE", "RAPE", "SCUM", "SHAG", "SHAT", "SLAG",
        "SLUT", "SPAZ", "SUCK", "TURD", "TWAT", "WANK", "HUMP", "PUSY", "PRCK", "DUMB", "UGLY", "FATS",
        "NUTS", "BARF", "PERV", "HATE", "KYKE", "GAYS", "DRUG", "PUBE",
    };

    private static readonly string[] RudeParts =
        ["ASS", "CUM", "FAG", "FCK", "FUC", "FUK", "FUX", "KKK", "SEX", "XXX", "WTF", "STD", "NAZ", "JEW", "CNT", "TWT", "DCK", "PNS"];

    /// <summary>True when the code is acceptable to hand out.</summary>
    public static bool IsAcceptable(string code) =>
        code.Length == Vocabulary.RoomCodeLength && code.All(c => Alphabet.Contains(c)) &&
        !RudeWords.Contains(code) && !RudeParts.Any(code.Contains);

    public static string Random()
    {
        Span<char> chars = stackalloc char[Vocabulary.RoomCodeLength];
        for (int i = 0; i < chars.Length; i++) chars[i] = Alphabet[RandomNumberGenerator.GetInt32(Alphabet.Length)];
        return new string(chars);
    }

    /// <summary>Upper-cased and trimmed; null unless it has the shape of a room code.</summary>
    public static string? Normalize(string? code)
    {
        if (code is null) return null;
        string c = code.Trim().ToUpperInvariant();
        return c.Length == Vocabulary.RoomCodeLength && c.All(ch => ch is >= 'A' and <= 'Z') ? c : null;
    }
}
