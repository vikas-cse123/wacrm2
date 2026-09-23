import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  QR_PREFILLED_MESSAGE_MAX_LENGTH,
  createMetaQrCode,
  deleteMetaQrCode,
  isMetaQrNotFoundError,
  isQrImageFormat,
  listMetaQrCodes,
  normalizeQrImageFormat,
  updateMetaQrCode,
  validateQrPrefilledMessage,
} from "./meta-api";

// fetch is stubbed per-test; any unexpected network call fails loudly.
function stubFetch(handler: (url: string, init?: RequestInit) => Response) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => handler(url, init)),
  );
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const ARGS = {
  phoneNumberId: "pn-1",
  accessToken: "test-token",
};

beforeEach(() => {
  stubFetch(() => {
    throw new Error("unexpected Meta call");
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("validateQrPrefilledMessage", () => {
  it("rejects empty and blank messages", () => {
    expect(() => validateQrPrefilledMessage("")).toThrow(/required/);
    expect(() => validateQrPrefilledMessage("   ")).toThrow(/required/);
    expect(() => validateQrPrefilledMessage(null)).toThrow(/required/);
  });

  it("trims and accepts a valid message", () => {
    expect(validateQrPrefilledMessage("  Hi there  ")).toBe("Hi there");
  });

  it(`rejects messages longer than ${QR_PREFILLED_MESSAGE_MAX_LENGTH} chars`, () => {
    expect(() =>
      validateQrPrefilledMessage("x".repeat(QR_PREFILLED_MESSAGE_MAX_LENGTH + 1)),
    ).toThrow(/characters or fewer/);
  });
});

describe("isQrImageFormat / normalizeQrImageFormat", () => {
  it("accepts SVG and PNG case-insensitively", () => {
    expect(isQrImageFormat("SVG")).toBe(true);
    expect(isQrImageFormat("png")).toBe(true);
    expect(isQrImageFormat("jpg")).toBe(false);
    expect(normalizeQrImageFormat("png")).toBe("PNG");
    expect(normalizeQrImageFormat("bogus")).toBe("SVG");
  });
});

describe("createMetaQrCode", () => {
  it("POSTs to the message_qrdls edge with the Meta payload", async () => {
    const seen: Array<{ url: string; body: Record<string, unknown> }> = [];
    stubFetch((url, init) => {
      seen.push({ url, body: JSON.parse(String(init?.body)) });
      return jsonResponse({
        code: "ABC123",
        prefilled_message: "Hi",
        deep_link_url: "https://wa.me/message/ABC123",
        qr_image_url: "https://example.com/qr.svg",
      });
    });

    const qr = await createMetaQrCode({
      ...ARGS,
      prefilledMessage: "Hi",
      imageFormat: "SVG",
    });

    expect(seen).toHaveLength(1);
    expect(seen[0].url).toBe(
      "https://graph.facebook.com/v21.0/pn-1/message_qrdls",
    );
    expect(seen[0].body).toMatchObject({
      messaging_product: "whatsapp",
      prefilled_message: "Hi",
      generate_qr_image: "SVG",
    });
    expect(qr).toMatchObject({
      code: "ABC123",
      deep_link_url: "https://wa.me/message/ABC123",
    });
    // Authorization header carries the token (server-side only).
    const headers = (vi.mocked(fetch).mock.calls[0][1]?.headers ?? {}) as Record<
      string,
      string
    >;
    expect(headers.Authorization).toBe("Bearer test-token");
  });

  it("surfaces Meta errors without leaking the token", async () => {
    stubFetch(() =>
      jsonResponse(
        { error: { message: "Invalid parameter", code: 100 } },
        400,
      ),
    );
    await expect(
      createMetaQrCode({ ...ARGS, prefilledMessage: "Hi" }),
    ).rejects.toThrow(/Invalid parameter/);
  });

  it("throws when Meta returns no QR code", async () => {
    stubFetch(() => jsonResponse({ ok: true }));
    await expect(
      createMetaQrCode({ ...ARGS, prefilledMessage: "Hi" }),
    ).rejects.toThrow(/did not return a QR code/);
  });
});

describe("listMetaQrCodes", () => {
  it("GETs the edge and normalizes the data array", async () => {
    const seen: string[] = [];
    stubFetch((url) => {
      seen.push(url);
      return jsonResponse({
        data: [
          {
            code: "A1",
            prefilled_message: "Hello",
            deep_link_url: "https://wa.me/message/A1",
            qr_image_url: "https://example.com/a.svg",
          },
          { code: "", prefilled_message: "bad" },
          "garbage",
        ],
      });
    });

    const list = await listMetaQrCodes(ARGS);
    expect(seen[0]).toBe(
      "https://graph.facebook.com/v21.0/pn-1/message_qrdls",
    );
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ code: "A1" });
  });

  it("returns an empty list when Meta has no data array", async () => {
    stubFetch(() => jsonResponse({}));
    await expect(listMetaQrCodes(ARGS)).resolves.toEqual([]);
  });
});

describe("updateMetaQrCode", () => {
  it("POSTs code + prefilled_message to the same edge", async () => {
    const seen: Array<{ body: Record<string, unknown> }> = [];
    stubFetch((_url, init) => {
      seen.push({ body: JSON.parse(String(init?.body)) });
      return jsonResponse({
        code: "A1",
        prefilled_message: "Updated",
        deep_link_url: "https://wa.me/message/A1",
        qr_image_url: "https://example.com/a.svg",
      });
    });

    const qr = await updateMetaQrCode({
      ...ARGS,
      code: "A1",
      prefilledMessage: "Updated",
    });
    expect(seen[0].body).toMatchObject({
      code: "A1",
      prefilled_message: "Updated",
    });
    expect(seen[0].body).not.toHaveProperty("generate_qr_image");
    expect(qr.prefilled_message).toBe("Updated");
  });

  it("requires a code", async () => {
    await expect(
      updateMetaQrCode({ ...ARGS, code: "", prefilledMessage: "Hi" }),
    ).rejects.toThrow(/code is required/);
  });
});

describe("deleteMetaQrCode", () => {
  it("DELETEs the code-scoped edge", async () => {
    const seen: Array<{ url: string; method?: string }> = [];
    stubFetch((url, init) => {
      seen.push({ url, method: init?.method });
      return jsonResponse({ success: true });
    });
    await deleteMetaQrCode({ ...ARGS, code: "A1" });
    expect(seen[0]).toMatchObject({
      url: "https://graph.facebook.com/v21.0/pn-1/message_qrdls/A1",
      method: "DELETE",
    });
  });
});

describe("isMetaQrNotFoundError", () => {
  it("detects already-deleted codes", () => {
    expect(
      isMetaQrNotFoundError(new Error("QR code does not exist (code 100)")),
    ).toBe(true);
    expect(isMetaQrNotFoundError(new Error("boom"))).toBe(false);
    expect(isMetaQrNotFoundError(null)).toBe(false);
  });
});
