// ============================================================
// Workspace "Ad Source" helpers — Workspace-specific, no Google
// Sheets involvement. Reads the existing first-touch CTWA value
// (contacts.source_url); never creates, reconstructs, or modifies
// attribution data.
// ============================================================

export type AdSourcePlatform = "facebook" | "instagram" | "other";

function hostnameOf(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    const withScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed)
      ? trimmed
      : `https://${trimmed}`;
    const url = new URL(withScheme);
    if (!url.hostname.includes(".")) return null;
    return url.hostname.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Platform for an icon cell. Facebook = facebook.com/fb.me,
 * Instagram = instagram.com, anything else parseable = other,
 * missing/unparseable = null (renders "—", never a link).
 */
export function adSourcePlatform(value: string | null | undefined): AdSourcePlatform | null {
  if (value === null || value === undefined) return null;
  const host = hostnameOf(value);
  if (!host) return null;
  const bare = host.replace(/^www\./, "");
  if (bare === "facebook.com" || bare.endsWith(".facebook.com") || bare === "fb.me" || bare.endsWith(".fb.me")) {
    return "facebook";
  }
  if (bare === "instagram.com" || bare.endsWith(".instagram.com")) {
    return "instagram";
  }
  return "other";
}

/**
 * Safe link target for the icon, or null when the cell must not
 * link. Absolute http(s) URLs are used verbatim; protocol-less
 * values upgrade to https. All other schemes and bare words → null.
 */
export function toSafeAdSourceHref(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  if (!trimmed || /[\s<>"]/.test(trimmed)) return null;
  try {
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed)) {
      const url = new URL(trimmed);
      if (url.protocol !== "http:" && url.protocol !== "https:") return null;
      return trimmed;
    }
    const url = new URL(`https://${trimmed}`);
    if (!url.hostname.includes(".")) return null;
    return `https://${trimmed}`;
  } catch {
    return null;
  }
}

/** Accessible label for the icon link. */
export function adSourceLabel(platform: AdSourcePlatform): string {
  switch (platform) {
    case "facebook":
      return "Open Facebook ad";
    case "instagram":
      return "Open Instagram ad";
    case "other":
      return "Open ad source";
  }
}
