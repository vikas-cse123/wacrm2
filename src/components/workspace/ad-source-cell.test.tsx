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

describe("Lead Received replaces the Lead Source icon column", () => {
  const pageSrc = readFileSync(
    join(process.cwd(), "src/app/(dashboard)/workspace/page.tsx"),
    "utf8",
  );

  it("no Lead Source header or icon cell remains in the table", () => {
    expect(pageSrc).not.toContain("Lead Source\n");
    expect(pageSrc).not.toContain("<AdSourceCell");
    expect(pageSrc).not.toContain("LEAD_SOURCE_VIS_ID");
  });

  it("the stored Lead Received field renders through the custom-cell path", () => {
    expect(pageSrc).toContain("receivedDefaults");
    expect(pageSrc).toContain("isLeadReceivedField");
  });
});
