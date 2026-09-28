import { afterEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  createBrowserClient: vi.fn((url: string, key: string, opts: unknown) => ({
    url,
    key,
    opts,
  })),
}));

vi.mock("@supabase/ssr", () => ({
  createBrowserClient: (url: string, key: string, opts: unknown) =>
    h.createBrowserClient(url, key, opts),
}));

const ORIGINAL_DOMAIN = process.env.NEXT_PUBLIC_SUPABASE_COOKIE_DOMAIN;

afterEach(() => {
  if (ORIGINAL_DOMAIN === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_COOKIE_DOMAIN;
  else process.env.NEXT_PUBLIC_SUPABASE_COOKIE_DOMAIN = ORIGINAL_DOMAIN;
  vi.resetModules();
});

describe("createClient (browser)", () => {
  it("enables persistent sessions, token auto-refresh, and PKCE detection", async () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://supabase.whatsappmax.in";
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon";
    delete process.env.NEXT_PUBLIC_SUPABASE_COOKIE_DOMAIN;
    const { createClient } = await import("./client");
    createClient();

    const [, , opts] = h.createBrowserClient.mock.calls[0] as [
      string,
      string,
      { auth: Record<string, unknown>; cookieOptions: Record<string, unknown> },
    ];
    expect(opts.auth).toMatchObject({
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
    });
    // Host-only when no cookie domain is configured.
    expect(opts.cookieOptions).toEqual({});
  });

  it("shares the session across apex/www when a cookie domain is configured", async () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://supabase.whatsappmax.in";
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon";
    process.env.NEXT_PUBLIC_SUPABASE_COOKIE_DOMAIN = ".whatsappmax.in";
    const { createClient } = await import("./client");
    createClient();

    const [, , opts] = h.createBrowserClient.mock.calls[0] as [
      string,
      string,
      { cookieOptions: { domain?: string } },
    ];
    expect(opts.cookieOptions).toEqual({ domain: ".whatsappmax.in" });
  });
});