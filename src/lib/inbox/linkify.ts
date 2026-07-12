/**
 * Splits message text into plain-text and URL segments so the inbox can
 * render bare links as clickable anchors without resorting to
 * dangerouslySetInnerHTML (segments become React nodes at the call site).
 *
 * Kept as a pure function (no JSX) so it stays unit-testable under the
 * node test environment.
 */

export type TextSegment = { type: "text"; value: string };
export type LinkSegment = { type: "link"; value: string; href: string };
export type LinkifySegment = TextSegment | LinkSegment;

// Matches http(s):// URLs and bare www. domains. We keep the pattern
// permissive on the path/query but stop at whitespace; trailing
// punctuation is trimmed afterwards so "(see https://x.com)." doesn't
// swallow the ")" or ".".
const URL_REGEX = /(https?:\/\/[^\s]+|www\.[^\s]+)/gi;

// Trailing characters that are almost never part of a URL when a link
// sits at the end of a sentence or inside brackets.
const TRAILING_PUNCTUATION = /[.,!?;:'"]+$/;

/**
 * Strips a single balanced trailing ")" only when the URL has no matching
 * "(" — e.g. "(https://en.wikipedia.org/wiki/Foo_(bar))" keeps its inner
 * parens but drops the wrapping one.
 */
function trimTrailing(url: string): { url: string; trailing: string } {
  let trailing = "";

  // Peel generic trailing punctuation first.
  let match = url.match(TRAILING_PUNCTUATION);
  if (match) {
    trailing = match[0] + trailing;
    url = url.slice(0, -match[0].length);
  }

  // Then an unbalanced closing paren.
  while (url.endsWith(")")) {
    const opens = (url.match(/\(/g) ?? []).length;
    const closes = (url.match(/\)/g) ?? []).length;
    if (closes <= opens) break;
    trailing = ")" + trailing;
    url = url.slice(0, -1);
  }

  // Re-peel punctuation that a stripped paren may have exposed
  // (e.g. "https://x.com).").
  match = url.match(TRAILING_PUNCTUATION);
  if (match) {
    trailing = match[0] + trailing;
    url = url.slice(0, -match[0].length);
  }

  return { url, trailing };
}

/** Prefixes a scheme onto bare "www." links so the href is absolute. */
function toHref(url: string): string {
  return /^https?:\/\//i.test(url) ? url : `https://${url}`;
}

export function linkify(text: string): LinkifySegment[] {
  if (!text) return [];

  const segments: LinkifySegment[] = [];
  let lastIndex = 0;

  for (const match of text.matchAll(URL_REGEX)) {
    const raw = match[0];
    const start = match.index ?? 0;

    const { url, trailing } = trimTrailing(raw);

    // A match that is nothing but punctuation once trimmed is not a link.
    if (!url) continue;

    if (start > lastIndex) {
      segments.push({ type: "text", value: text.slice(lastIndex, start) });
    }

    segments.push({ type: "link", value: url, href: toHref(url) });

    if (trailing) {
      segments.push({ type: "text", value: trailing });
    }

    lastIndex = start + raw.length;
  }

  if (lastIndex < text.length) {
    segments.push({ type: "text", value: text.slice(lastIndex) });
  }

  return segments;
}
