import { afterEach, describe, expect, it } from "vitest";

import {
  AUTH_SESSION_COOKIE_MAX_AGE_SECONDS,
  MIN_SESSION_PERSISTENCE_SECONDS,
  getAuthCookieOptions,
} from "./cookie-options";

const ORIGINAL = process.env.NEXT_PUBLIC_SUPABASE_COOKIE_DOMAIN;

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_COOKIE_DOMAIN;
  else process.env.NEXT_PUBLIC_SUPABASE_COOKIE_DOMAIN = ORIGINAL;
});

describe("getAuthCookieOptions", () => {
  it("is host-only (no domain) when no cookie domain is configured", () => {
    delete process.env.NEXT_PUBLIC_SUPABASE_COOKIE_DOMAIN;
    expect(getAuthCookieOptions()).toEqual({});
  });

  it("sets the apex domain when NEXT_PUBLIC_SUPABASE_COOKIE_DOMAIN is configured", () => {
    process.env.NEXT_PUBLIC_SUPABASE_COOKIE_DOMAIN = ".whatsappmax.in";
    expect(getAuthCookieOptions()).toEqual({ domain: ".whatsappmax.in" });
  });

  it("ignores a blank/whitespace cookie domain", () => {
    process.env.NEXT_PUBLIC_SUPABASE_COOKIE_DOMAIN = "   ";
    expect(getAuthCookieOptions()).toEqual({});
  });
});

describe("session persistence duration", () => {
  it("the enforced auth-cookie lifetime is at least the 30-day requirement", () => {
    expect(AUTH_SESSION_COOKIE_MAX_AGE_SECONDS).toBeGreaterThanOrEqual(
      MIN_SESSION_PERSISTENCE_SECONDS,
    );
    expect(MIN_SESSION_PERSISTENCE_SECONDS).toBe(30 * 24 * 60 * 60);
  });
});