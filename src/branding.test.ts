import { existsSync, readFileSync, statSync } from "node:fs";
import { execSync } from "node:child_process";
import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// WACRM branding — public/logo.png is the single source of truth.
// ---------------------------------------------------------------------------

const root = process.cwd();
const src = (rel: string) => readFileSync(`${root}/${rel}`, "utf8");

describe("1. /logo.png exists and loads", () => {
  it("is present and non-empty", () => {
    const p = `${root}/public/logo.png`;
    expect(existsSync(p)).toBe(true);
    expect(statSync(p).size).toBeGreaterThan(0);
  });
});

describe("2–6. product surfaces use /logo.png", () => {
  const usages: Array<[string, string]> = [
    ["sidebar", "src/components/layout/sidebar.tsx"],
    ["login", "src/app/(auth)/login/page.tsx"],
    ["signup", "src/app/(auth)/signup/page.tsx"],
    ["forgot-password", "src/app/(auth)/forgot-password/page.tsx"],
    ["legal header", "src/app/(legal)/layout.tsx"],
    ["landing header + footer", "src/app/page.tsx"],
  ];

  it.each(usages)("%s renders /logo.png", (_label, rel) => {
    expect(src(rel)).toContain('"/logo.png"');
  });

  it("signup uses it in both invite and standard cards", () => {
    const matches = src("src/app/(auth)/signup/page.tsx").match(/"\/logo\.png"/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(2);
  });
});

describe("7. favicon uses /logo.png with no conflicts", () => {
  it("metadata icons reference /logo.png", () => {
    const layout = src("src/app/layout.tsx");
    expect(layout).toContain('icon: "/logo.png"');
    expect(layout).toContain('shortcut: "/logo.png"');
    expect(layout).toContain('apple: "/logo.png"');
  });

  it("the icon route renders /logo.png", () => {
    const icon = src("src/app/icon.tsx");
    expect(icon).toContain('"logo.png"');
  });

  it("no stale favicon asset shadows the route", () => {
    expect(existsSync(`${root}/public/favicon.ico`)).toBe(false);
    expect(existsSync(`${root}/src/app/favicon.ico`)).toBe(false);
  });

  it("manifest icons reference /logo.png", () => {
    const manifest = src("src/app/manifest.ts");
    const matches = manifest.match(/'\/logo\.png'/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(3);
  });

  it("open-graph images reference /logo.png", () => {
    const landing = src("src/app/page.tsx");
    expect(landing).toContain("url: '/logo.png'");
    expect(landing).toContain("images: ['/logo.png']");
  });
});

describe("8. no stale WACRM logo reference remains", () => {
  it("whatsappmax-logo.png appears nowhere in src", () => {
    const out = execSync(
      "grep -rn 'whatsappmax-logo' src/ --exclude=branding.test.ts || true",
      {
        cwd: root,
        encoding: "utf8",
      },
    );
    expect(out.trim()).toBe("");
  });

  it("the replaced asset file is gone (single source of truth)", () => {
    expect(existsSync(`${root}/public/whatsappmax-logo.png`)).toBe(false);
  });
});

describe("9. aspect ratio preserved (no distortion)", () => {
  it("all logo Images keep square dimensions", () => {
    for (const rel of [
      "src/components/layout/sidebar.tsx",
      "src/app/(auth)/login/page.tsx",
      "src/app/(auth)/signup/page.tsx",
      "src/app/(auth)/forgot-password/page.tsx",
      "src/app/(legal)/layout.tsx",
      "src/app/page.tsx",
    ]) {
      const content = src(rel);
      const pairs = [...content.matchAll(/src="\/logo\.png"[\s\S]{0,200}?width=\{(\d+)\}[\s\S]{0,80}?height=\{(\d+)\}/g)];
      expect(pairs.length).toBeGreaterThan(0);
      for (const [, w, h] of pairs) {
        expect(w).toBe(h);
      }
    }
  });
});

describe("10. unrelated third-party logos untouched", () => {
  it("fb/instagram/travel-crm/competitor assets still referenced", () => {
    expect(src("src/components/workspace/ad-source-cell.tsx")).toContain("/icons/fb.png");
    expect(src("src/components/workspace/ad-source-cell.tsx")).toContain("/icons/Insta.png");
    expect(src("src/components/layout/sidebar.tsx")).toContain(
      "/icons/travel-agency-crm.png",
    );
    expect(src("src/app/page.tsx")).toContain("/logos/interakt.svg");
  });
});

describe("11. layout unchanged", () => {
  it("sidebar brand row and auth card shells intact", () => {
    const sidebar = src("src/components/layout/sidebar.tsx");
    expect(sidebar).toContain('href="/dashboard"');
    expect(sidebar).toContain("h-8 w-8 rounded-lg");
    const login = src("src/app/(auth)/login/page.tsx");
    expect(login).toContain("max-w-md");
    expect(login).toContain("Welcome back");
  });
});
