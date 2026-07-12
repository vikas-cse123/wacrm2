import { describe, expect, it } from "vitest";

import { linkify } from "./linkify";

describe("linkify", () => {
  it("returns a single text segment when there is no URL", () => {
    expect(linkify("just some plain text")).toEqual([
      { type: "text", value: "just some plain text" },
    ]);
  });

  it("returns an empty array for empty input", () => {
    expect(linkify("")).toEqual([]);
  });

  it("linkifies a bare https URL", () => {
    expect(linkify("https://youtube.com/shorts/OauNB-doAK4")).toEqual([
      {
        type: "link",
        value: "https://youtube.com/shorts/OauNB-doAK4",
        href: "https://youtube.com/shorts/OauNB-doAK4",
      },
    ]);
  });

  it("keeps surrounding text as separate segments", () => {
    expect(linkify("see https://x.com now")).toEqual([
      { type: "text", value: "see " },
      { type: "link", value: "https://x.com", href: "https://x.com" },
      { type: "text", value: " now" },
    ]);
  });

  it("prefixes a scheme onto bare www links", () => {
    const segments = linkify("visit www.example.com");
    expect(segments).toEqual([
      { type: "text", value: "visit " },
      { type: "link", value: "www.example.com", href: "https://www.example.com" },
    ]);
  });

  it("trims trailing sentence punctuation out of the link", () => {
    expect(linkify("go to https://x.com.")).toEqual([
      { type: "text", value: "go to " },
      { type: "link", value: "https://x.com", href: "https://x.com" },
      { type: "text", value: "." },
    ]);
  });

  it("drops an unbalanced wrapping paren but keeps inner ones", () => {
    expect(linkify("(https://en.wikipedia.org/wiki/Foo_(bar))")).toEqual([
      { type: "text", value: "(" },
      {
        type: "link",
        value: "https://en.wikipedia.org/wiki/Foo_(bar)",
        href: "https://en.wikipedia.org/wiki/Foo_(bar)",
      },
      { type: "text", value: ")" },
    ]);
  });

  it("handles multiple URLs in one message", () => {
    const segments = linkify(
      "https://a.com and https://b.com/path?q=1",
    );
    expect(segments).toEqual([
      { type: "link", value: "https://a.com", href: "https://a.com" },
      { type: "text", value: " and " },
      {
        type: "link",
        value: "https://b.com/path?q=1",
        href: "https://b.com/path?q=1",
      },
    ]);
  });

  it("preserves query strings with the si= param from share links", () => {
    const url =
      "https://youtube.com/shorts/6DtifHqe3y8?si=po6K9tvJ-MOIBjYn";
    expect(linkify(url)).toEqual([{ type: "link", value: url, href: url }]);
  });
});
