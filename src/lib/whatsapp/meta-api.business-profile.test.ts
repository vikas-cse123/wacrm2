import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getBusinessProfile,
  updateBusinessProfile,
  uploadProfilePhoto,
} from "./meta-api";

interface Captured {
  url: string;
  method?: string;
  body?: unknown;
  contentType?: string | null;
  auth?: string | null;
  fileOffset?: string | null;
}
let captured: Captured | null = null;
let calls: Captured[] = [];
let responseBody: unknown = {};
let responseOk = true;
// Queued bodies for multi-step flows (upload session → upload).
let responseQueue: unknown[] = [];

function stubFetch() {
  return vi.fn(async (url: string, init?: RequestInit) => {
    const headers = new Headers(init?.headers as HeadersInit);
    let body: unknown;
    if (typeof init?.body === "string") {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    } else if (init?.body instanceof FormData) {
      body = "[form-data]";
    } else if (init?.body instanceof Uint8Array) {
      body = "[bytes]";
    }
    captured = {
      url,
      method: init?.method ?? "GET",
      body,
      contentType: headers.get("content-type"),
      auth: headers.get("authorization"),
      fileOffset: headers.get("file_offset"),
    };
    calls.push(captured);
    const next = responseQueue.length > 0 ? responseQueue.shift() : responseBody;
    return {
      ok: responseOk,
      status: responseOk ? 200 : 400,
      json: async () => next,
    } as Response;
  });
}

describe("business profile meta-api helpers", () => {
  beforeEach(() => {
    captured = null;
    calls = [];
    responseBody = {};
    responseOk = true;
    responseQueue = [];
    vi.stubGlobal("fetch", stubFetch());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reads the profile from the business-profile edge", async () => {
    responseBody = {
      about: "Hi",
      vertical: "TRAVEL",
      websites: ["https://a.example"],
      profile_picture_url: "https://cdn/p.jpg",
    };
    const profile = await getBusinessProfile({
      phoneNumberId: "pn-1",
      accessToken: "tok",
    });
    expect(captured?.url).toBe(
      "https://graph.facebook.com/v21.0/pn-1/whatsapp_business_profile?fields=about,address,description,email,profile_picture_url,vertical,websites",
    );
    expect(profile).toMatchObject({
      about: "Hi",
      vertical: "TRAVEL",
      websites: ["https://a.example"],
    });
  });

  it("unwraps Meta's { data: [profile] } envelope (live shape)", async () => {
    responseBody = {
      data: [
        {
          about: "Best trips",
          address: "1 Main St",
          description: "We plan trips.",
          email: "test@example.com",
          profile_picture_url: "https://example.com/photo.jpg",
          vertical: "TRAVEL",
          websites: ["https://example.com"],
        },
      ],
    };
    const profile = await getBusinessProfile({
      phoneNumberId: "pn-1",
      accessToken: "tok",
    });
    expect(profile).toEqual({
      about: "Best trips",
      address: "1 Main St",
      description: "We plan trips.",
      email: "test@example.com",
      profile_picture_url: "https://example.com/photo.jpg",
      vertical: "TRAVEL",
      websites: ["https://example.com"],
    });
  });

  it("posts only the supplied fields with messaging_product", async () => {
    responseBody = { success: true };
    await updateBusinessProfile({
      phoneNumberId: "pn-1",
      accessToken: "tok",
      fields: { about: "New" },
    });
    expect(captured?.method).toBe("POST");
    expect(captured?.url).toBe(
      "https://graph.facebook.com/v21.0/pn-1/whatsapp_business_profile",
    );
    expect(captured?.body).toEqual({
      messaging_product: "whatsapp",
      about: "New",
    });
    expect(captured?.contentType).toContain("application/json");
  });

  it("uploads the photo via resumable upload and returns the image handle", async () => {
    // 1. upload-session creation, 2. byte upload returning the handle.
    responseQueue = [{ id: "upload:session-1" }, { h: "photo-handle-1" }];
    const result = await uploadProfilePhoto({
      appId: "app-1",
      accessToken: "tok",
      fileName: "photo.jpg",
      mimeType: "image/jpeg",
      bytes: new Uint8Array([1, 2, 3]),
    });
    expect(result).toEqual({ handle: "photo-handle-1" });
    expect(calls).toHaveLength(2);
    // Session creation carries the file metadata, never the bytes.
    expect(calls[0]?.url).toContain(
      "https://graph.facebook.com/v21.0/app-1/uploads?",
    );
    expect(calls[0]?.url).toContain("file_name=photo.jpg");
    expect(calls[0]?.url).toContain("file_length=3");
    expect(calls[0]?.body).not.toBe("[bytes]");
    // Byte upload hits the session id with OAuth + file_offset.
    expect(calls[1]?.url).toBe(
      "https://graph.facebook.com/v21.0/upload:session-1",
    );
    expect(calls[1]?.auth).toBe("OAuth tok");
    expect(calls[1]?.fileOffset).toBe("0");
    expect(calls[1]?.body).toBe("[bytes]");
    // The invalid edge is never called.
    for (const c of calls) {
      expect(c.url).not.toContain("/profile/photo");
    }
  });

  it("sends the image handle as profile_picture_handle on the profile edge", async () => {
    responseBody = { success: true };
    await updateBusinessProfile({
      phoneNumberId: "pn-1",
      accessToken: "tok",
      fields: { profile_picture_handle: "photo-handle-1" },
    });
    expect(captured?.method).toBe("POST");
    expect(captured?.url).toBe(
      "https://graph.facebook.com/v21.0/pn-1/whatsapp_business_profile",
    );
    expect(captured?.body).toEqual({
      messaging_product: "whatsapp",
      profile_picture_handle: "photo-handle-1",
    });
  });

  it("fails the upload when the session creation fails", async () => {
    responseOk = false;
    responseBody = { error: { message: "Invalid app id.", code: 100 } };
    await expect(
      uploadProfilePhoto({
        appId: "bad-app",
        accessToken: "tok",
        fileName: "photo.jpg",
        mimeType: "image/jpeg",
        bytes: new Uint8Array([1, 2, 3]),
      }),
    ).rejects.toThrow(/Invalid app id/);
  });

  it("fails the upload when no image handle is returned", async () => {
    responseQueue = [{ id: "upload:session-1" }, {}];
    await expect(
      uploadProfilePhoto({
        appId: "app-1",
        accessToken: "tok",
        fileName: "photo.jpg",
        mimeType: "image/jpeg",
        bytes: new Uint8Array([1, 2, 3]),
      }),
    ).rejects.toThrow(/handle/);
  });

  it("surfaces Meta errors without leaking the token", async () => {
    responseOk = false;
    responseBody = {
      error: { message: "Invalid OAuth access token.", code: 190 },
    };
    await expect(
      getBusinessProfile({ phoneNumberId: "pn-1", accessToken: "tok" }),
    ).rejects.toThrow(/Invalid OAuth access token.*code 190/);
  });
});
