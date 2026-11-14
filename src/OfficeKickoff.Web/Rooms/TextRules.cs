using System.Globalization;
using System.Text;

namespace OfficeKickoff.Web.Rooms;

/// <summary>Sanitising of every string that arrives from a browser.</summary>
public static class TextRules
{
    /// <summary>
    /// Removes control and formatting characters (bidi overrides, zero-width tricks), collapses
    /// whitespace runs, trims, and cuts to <paramref name="maxLength"/> UTF-16 units without
    /// splitting a surrogate pair. Never returns null.
    /// </summary>
    public static string Clean(string? text, int maxLength)
    {
        if (string.IsNullOrEmpty(text) || maxLength <= 0) return "";

        // Bound the work on hostile input before looking at every character.
        if (text.Length > maxLength * 8) text = text[..(maxLength * 8)];

        var sb = new StringBuilder(Math.Min(text.Length, maxLength + 4));
        bool pendingSpace = false;
        for (int i = 0; i < text.Length; i++)
        {
            char c = text[i];
            if (char.IsHighSurrogate(c))
            {
                if (i + 1 < text.Length && char.IsLowSurrogate(text[i + 1]))
                {
                    var cat = CharUnicodeInfo.GetUnicodeCategory(text, i);
                    if (cat is not (UnicodeCategory.PrivateUse or UnicodeCategory.Format or UnicodeCategory.OtherNotAssigned))
                    {
                        FlushSpace(sb, ref pendingSpace);
                        sb.Append(c).Append(text[i + 1]);
                    }
                }

                i++;
                continue;
            }

            if (char.IsLowSurrogate(c)) continue;

            if (char.IsWhiteSpace(c))
            {
                pendingSpace = sb.Length > 0;
                continue;
            }

            var category = char.GetUnicodeCategory(c);
            if (category is UnicodeCategory.Control or UnicodeCategory.PrivateUse or UnicodeCategory.OtherNotAssigned
                or UnicodeCategory.LineSeparator or UnicodeCategory.ParagraphSeparator)
            {
                continue;
            }

            // Format characters are dropped, except the zero-width joiner that glues emoji together.
            if (category == UnicodeCategory.Format && c != '‍') continue;

            FlushSpace(sb, ref pendingSpace);
            sb.Append(c);
        }

        string result = sb.ToString();
        if (result.Length > maxLength)
        {
            int cut = maxLength;
            if (char.IsLowSurrogate(result[cut]) && char.IsHighSurrogate(result[cut - 1])) cut--;
            result = result[..cut];
        }

        return result.Trim();
    }

    private static void FlushSpace(StringBuilder sb, ref bool pendingSpace)
    {
        if (pendingSpace && sb.Length > 0) sb.Append(' ');
        pendingSpace = false;
    }

    /// <summary>True for "#rrggbb" (either case).</summary>
    public static bool IsColor(string? value)
    {
        if (value is null || value.Length != 7 || value[0] != '#') return false;
        for (int i = 1; i < 7; i++)
        {
            if (!char.IsAsciiHexDigit(value[i])) return false;
        }

        return true;
    }

    /// <summary>The colour in lower case, or <paramref name="fallback"/> when it is not "#rrggbb".</summary>
    public static string Color(string? value, string fallback) =>
        IsColor(value) ? value!.ToLowerInvariant() : fallback;

    /// <summary>
    /// Makes <paramref name="name"/> unique (case-insensitively) among <paramref name="taken"/> by
    /// appending 2, 3, ... and shortening the base so the result still fits.
    /// </summary>
    public static string Unique(string name, IEnumerable<string> taken, int maxLength)
    {
        var set = new HashSet<string>(taken, StringComparer.OrdinalIgnoreCase);
        if (!set.Contains(name)) return name;
        for (int n = 2; n < 1000; n++)
        {
            string suffix = n.ToString(CultureInfo.InvariantCulture);
            string stem = name;
            if (stem.Length + suffix.Length > maxLength)
            {
                int cut = Math.Max(0, maxLength - suffix.Length);
                if (cut > 0 && char.IsLowSurrogate(stem[cut]) && char.IsHighSurrogate(stem[cut - 1])) cut--;
                stem = stem[..cut].TrimEnd();
            }

            string candidate = stem + suffix;
            if (!set.Contains(candidate)) return candidate;
        }

        return name;
    }
}
