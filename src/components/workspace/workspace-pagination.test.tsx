import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { WorkspacePagination } from "./workspace-pagination";

// ---------------------------------------------------------------------------
// Enterprise pagination footer — state rendering. Paging math lives
// in workspace-pagination.ts (tested there); these tests lock the
// visual contract: zones, disabled states, active page, range
// text, and page-size options.
// ---------------------------------------------------------------------------

function render(
  overrides: Partial<Parameters<typeof WorkspacePagination>[0]> = {}
) {
  return renderToStaticMarkup(
    <WorkspacePagination
      page={0}
      totalPages={4}
      total={80}
      pageSize={25}
      rowsOnPage={25}
      onPage={vi.fn()}
      onPageSize={vi.fn()}
      {...overrides}
    />
  );
}

/** The full opening <button …> tag carrying the given aria-label. */
function buttonTag(html: string, label: string): string {
  const idx = html.indexOf(`aria-label="${label}"`);
  expect(idx).toBeGreaterThan(-1);
  const start = html.lastIndexOf("<button", idx);
  return html.slice(start, html.indexOf(">", idx) + 1);
}

/** Every opening <button …> tag in the markup. */
function allButtonTags(html: string): string[] {
  const tags: string[] = [];
  let from = 0;
  for (;;) {
    const start = html.indexOf("<button", from);
    if (start === -1) return tags;
    const end = html.indexOf(">", start);
    tags.push(html.slice(start, end + 1));
    from = end + 1;
  }
}

describe("WorkspacePagination", () => {
  it("first page: First/Previous disabled, Next/Last enabled, page 1 active", () => {
    const html = render({ page: 0, totalPages: 18, total: 450 });
    expect(html).toContain("1–25 of 450");
    expect(html).toContain("Page 1 of 18");
    expect(html).toContain('aria-current="page"');
    expect(buttonTag(html, "First page")).toContain("disabled=");
    expect(buttonTag(html, "Previous page")).toContain("disabled=");
    expect(buttonTag(html, "Next page")).not.toContain("disabled=");
    expect(buttonTag(html, "Last page")).not.toContain("disabled=");
  });

  it("middle page: nothing disabled, window with ellipsis", () => {
    const html = render({ page: 9, totalPages: 18, total: 450 });
    expect(html).toContain("226–250 of 450");
    expect(html).toContain("Page 10 of 18");
    for (const tag of allButtonTags(html)) {
      expect(tag).not.toContain("disabled=");
    }
    expect(html).toContain("…");
  });

  it("final page: Next/Last disabled, First/Previous enabled", () => {
    const html = render({ page: 17, totalPages: 18, total: 450, rowsOnPage: 25 });
    expect(html).toContain("Page 18 of 18");
    expect(buttonTag(html, "Next page")).toContain("disabled=");
    expect(buttonTag(html, "Last page")).toContain("disabled=");
    expect(buttonTag(html, "First page")).not.toContain("disabled=");
  });

  it("offers the 25/50/75/100 page sizes with an accessible label", () => {
    const html = render();
    expect(html).toContain('aria-label="Rows per page"');
    // Closed Radix select shows the current size; the full option
    // list renders from WORKSPACE_PAGE_SIZES on open.
    expect(html).toContain(">25<");
    const src = readFileSync(
      `${process.cwd()}/src/components/workspace/workspace-pagination.tsx`,
      "utf8"
    );
    expect(src).toContain("WORKSPACE_PAGE_SIZES.map");
  });

  it("page numbers collapse below the sm breakpoint", () => {
    const html = render();
    expect(html).toContain("hidden");
    expect(html).toContain("sm:flex");
  });
});
