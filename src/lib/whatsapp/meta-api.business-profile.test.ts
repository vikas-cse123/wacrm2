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
}
let captured: Captured | null = null;
let responseBody: unknown = {};
let responseOk = true;

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
    }
    captured = {
      url,
      method: init?.method ?? "GET",
      body,
      contentType: headers.get("content-type"),
    };
    return {
      ok: responseOk,
      status: responseOk ? 200 : 400,
      json: async () => responseBody,
    } as Response;
  });
}

describe("business profile meta-api helpers", () => {
  beforeEach(() => {
    captured = null;
    responseBody = {};
    responseOk = true;
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

  it("uploads the photo as multipart and returns the handle", async () => {
    responseBody = { handle: "photo-handle-1" };
    const result = await uploadProfilePhoto({
      phoneNumberId: "pn-1",
      accessToken: "tok",
      fileName: "photo.jpg",
      mimeType: "image/jpeg",
      bytes: new Uint8Array([1, 2, 3]),
    });
    expect(result).toEqual({ handle: "photo-handle-1" });
    expect(captured?.url).toBe(
      "https://graph.facebook.com/v21.0/pn-1/profile/photo",
    );
    expect(captured?.body).toBe("[form-data]");
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
