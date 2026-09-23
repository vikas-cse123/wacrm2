import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  AdSourceCell,
  FacebookMark,
  InstagramMark,
} from "./ad-source-cell";

describe("lead source brand marks", () => {
  it("Facebook renders the in-repo asset /icons/fb.png", () => {
    const html = renderToStaticMarkup(<FacebookMark className="h-6 w-6" />);
    expect(html).toContain("fb.png");
    expect(html).not.toContain("#1877F2");
    expect(html).not.toContain(">f<");
    expect(html).not.toContain("<svg");
  });

  it("Instagram renders the in-repo asset /icons/Insta.png", () => {
    const html = renderToStaticMarkup(<InstagramMark className="h-6 w-6" />);
    expect(html).toContain("Insta.png");
    expect(html).not.toContain("linearGradient");
    expect(html).not.toContain("#1877F2");
    expect(html).not.toContain("<svg");
  });

  it("the two platforms never share a mark", () => {
    const fb = renderToStaticMarkup(<FacebookMark />);
    const ig = renderToStaticMarkup(<InstagramMark />);
    expect(fb).not.toBe(ig);
  });
});

describe("AdSourceCell", () => {
  it("links the exact stored Facebook URL with no URL text or arrow", () => {
    const html = renderToStaticMarkup(
      <AdSourceCell sourceUrl="https://fb.me/9NXAdJ5P2" />,
    );
    expect(html).toContain('href="https://fb.me/9NXAdJ5P2"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain("fb.png");
    expect(html).not.toContain("fb.me/9NXAdJ5P2</");
    expect(html).not.toContain("ExternalLink");
    expect(html).not.toContain("arrow");
    expect(html).not.toContain("<svg");
  });

  it("links the exact stored Instagram URL with no URL text or arrow", () => {
    const html = renderToStaticMarkup(
      <AdSourceCell sourceUrl="https://instagram.com/p/ABC123" />,
    );
    expect(html).toContain('href="https://instagram.com/p/ABC123"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain("Insta.png");
    expect(html).not.toContain("instagram.com/p/ABC123</");
    expect(html).not.toContain("ExternalLink");
    expect(html).not.toContain("arrow");
    expect(html).not.toContain("<svg");
  });

  it("renders a non-clickable placeholder for missing URLs", () => {
    for (const missing of [null, undefined, ""]) {
      const html = renderToStaticMarkup(<AdSourceCell sourceUrl={missing} />);
      expect(html).toContain("—");
      expect(html).not.toContain("<a");
    }
  });

  it("renders a non-clickable placeholder for unrecognized hosts (no generic icon)", () => {
    const html = renderToStaticMarkup(
      <AdSourceCell sourceUrl="https://example.com/some-ad" />,
    );
    expect(html).toContain("—");
    expect(html).not.toContain("<a");
    expect(html).not.toContain("<svg");
  });

  it("is keyboard-focusable with an accessible label", () => {
    const html = renderToStaticMarkup(
      <AdSourceCell sourceUrl="https://fb.me/9NXAdJ5P2" />,
    );
    expect(html).toContain('aria-label="Open Facebook ad"');
  });
});

describe("Lead Source column placement (Workspace table)", () => {
  const pageSrc = readFileSync(
    join(process.cwd(), "src/app/(dashboard)/workspace/page.tsx"),
    "utf8",
  );

  it("header reads Lead Source and is the final header cell", () => {
    const header = pageSrc.slice(0, pageSrc.indexOf("</TableHeader>"));
    expect(header).toContain("Lead Source");
    expect(header.slice(header.lastIndexOf("<TableHead"))).toContain(
      "Lead Source",
    );
  });

  it("the AdSourceCell is the final body cell of its row", () => {
    const fromCell = pageSrc.slice(pageSrc.indexOf("<AdSourceCell"));
    const rowTail = fromCell.slice(0, fromCell.indexOf("</TableRow>"));
    expect(rowTail).not.toContain("<TableCell");
  });
});
