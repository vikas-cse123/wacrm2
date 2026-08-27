import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  isEmailConfigured,
  sendEmail,
  sendEmailViaResend,
  sendEmailViaSmtp,
} from "./send";

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn());
});

afterEach(() => {
  // Restore env to the pristine test baseline (vitest sets these at
  // module load; we must not leak RESEND_* / SMTP_* into other files).
  process.env = { ...ORIGINAL_ENV };
  delete process.env.RESEND_API_KEY;
  delete process.env.RESEND_FROM;
  delete process.env.SMTP_HOST;
  delete process.env.SMTP_PORT;
  delete process.env.SMTP_USER;
  delete process.env.SMTP_PASSWORD;
  delete process.env.SMTP_FROM;
  delete process.env.SMTP_SECURE;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("isEmailConfigured", () => {
  it("is false when no provider is configured", () => {
    expect(isEmailConfigured()).toBe(false);
  });

  it("is true when only Resend is configured", () => {
    process.env.RESEND_API_KEY = "re_test";
    expect(isEmailConfigured()).toBe(true);
  });

  it("is true when only SMTP is configured", () => {
    process.env.SMTP_HOST = "smtp.example.com";
    expect(isEmailConfigured()).toBe(true);
  });
});

describe("sendEmailViaResend", () => {
  it("posts the message and returns the Resend message id on 200", async () => {
    process.env.RESEND_API_KEY = "re_test";
    process.env.RESEND_FROM = "WACRM <noreply@example.com>";
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ id: "resend-id-1" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const result = await sendEmailViaResend({
      to: "sales@agency.com",
      subject: "New lead",
      text: "Body",
    });

    expect(result.messageId).toBe("resend-id-1");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.resend.com/emails");
    expect((init.headers as Record<string, string>).Authorization).toBe(
      "Bearer re_test",
    );
    const body = JSON.parse(String(init.body));
    expect(body.from).toBe("WACRM <noreply@example.com>");
    expect(body.to).toEqual(["sales@agency.com"]);
    expect(body.subject).toBe("New lead");
    expect(body.text).toBe("Body");
  });

  it("throws on a non-2xx response", async () => {
    process.env.RESEND_API_KEY = "re_test";
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(
        JSON.stringify({ message: "from address not verified" }),
        { status: 403, headers: { "Content-Type": "application/json" } },
      ),
    );
    await expect(
      sendEmailViaResend({ to: "x@example.com", subject: "s", text: "b" }),
    ).rejects.toThrow(/from address not verified/);
  });

  it("throws when no API key is configured", async () => {
    await expect(
      sendEmailViaResend({ to: "x@example.com", subject: "s", text: "b" }),
    ).rejects.toThrow(/Resend API key not configured/);
  });
});

describe("sendEmail dispatcher", () => {
  it("routes to Resend when RESEND_API_KEY is set", async () => {
    process.env.RESEND_API_KEY = "re_test";
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ id: "resend-id" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const result = await sendEmail({
      to: "x@example.com",
      subject: "s",
      text: "b",
    });
    expect(result.messageId).toBe("resend-id");
  });

  it("routes to SMTP when only SMTP is configured", async () => {
    process.env.SMTP_HOST = "127.0.0.1";
    process.env.SMTP_PORT = "2525";
    // No real SMTP server in tests — expect it to attempt a connection
    // and fail fast with a transport error, which proves it did NOT go
    // through Resend (no fetch call) and used the SMTP path instead.
    await expect(
      sendEmail({ to: "x@example.com", subject: "s", text: "b" }),
    ).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("throws when neither provider is configured", async () => {
    await expect(
      sendEmail({ to: "x@example.com", subject: "s", text: "b" }),
    ).rejects.toThrow(/Email provider not configured/);
  });
});

describe("sendEmailViaSmtp", () => {
  it("throws 'SMTP not configured' when no SMTP host is set", async () => {
    await expect(
      sendEmailViaSmtp({ to: "x@example.com", subject: "s", text: "b" }),
    ).rejects.toThrow(/SMTP not configured/);
  });
});