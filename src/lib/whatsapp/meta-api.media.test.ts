import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { downloadMediaStream, sendMediaMessage } from "./meta-api";

// Capture the JSON body each helper POSTs to Meta so we can assert the
// exact payload shape per media kind without hitting the network.
interface CapturedBody {
  type?: string;
  image?: Record<string, unknown>;
  video?: Record<string, unknown>;
  document?: Record<string, unknown>;
  audio?: Record<string, unknown>;
}
let captured: CapturedBody | null = null;

function okFetch() {
  return vi.fn(async (_url: string, init?: RequestInit) => {
    captured = init?.body ? (JSON.parse(init.body as string) as CapturedBody) : null;
    return {
      ok: true,
      json: async () => ({ messages: [{ id: "wamid.TEST" }] }),
    } as Response;
  });
}

const BASE = {
  phoneNumberId: "test-phone",
  accessToken: "test-token",
  to: "1234567890",
  link: "https://cdn.example.com/file",
} as const;

describe("sendMediaMessage — payload shape", () => {
  beforeEach(() => {
    captured = null;
    vi.stubGlobal("fetch", okFetch());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends image with a caption and no filename", async () => {
    await sendMediaMessage({ ...BASE, kind: "image", caption: "hello", filename: "x.png" });
    expect(captured?.type).toBe("image");
    expect(captured?.image).toEqual({ link: BASE.link, caption: "hello" });
    expect(captured?.image?.filename).toBeUndefined();
  });

  it("sends document with both caption and filename", async () => {
    await sendMediaMessage({
      ...BASE,
      kind: "document",
      caption: "invoice",
      filename: "invoice.pdf",
    });
    expect(captured?.type).toBe("document");
    expect(captured?.document).toEqual({
      link: BASE.link,
      caption: "invoice",
      filename: "invoice.pdf",
    });
  });

  it("sends audio with NO caption and NO filename (Meta rejects both)", async () => {
    await sendMediaMessage({
      ...BASE,
      kind: "audio",
      caption: "should be dropped",
      filename: "voice.ogg",
    });
    expect(captured?.type).toBe("audio");
    expect(captured?.audio).toEqual({ link: BASE.link });
  });

  it("throws when no link is provided", async () => {
    await expect(
      sendMediaMessage({ ...BASE, link: "", kind: "image" }),
    ).rejects.toThrow(/requires a link/);
  });
});

describe("downloadMediaStream — Range passthrough without buffering", () => {
  let seenHeaders: Record<string, string> = {};

  beforeEach(() => {
    seenHeaders = {};
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        const headers = new Headers(init?.headers as Record<string, string>);
        headers.forEach((value, key) => {
          seenHeaders[key] = value;
        });
        return {
          ok: true,
          status: 206,
          headers: new Headers({
            "content-type": "video/mp4",
            "content-range": "bytes 0-1023/5000",
            "content-length": "1024",
          }),
          body: "stream-body",
        } as unknown as Response;
      }),
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("forwards the browser Range header and returns Meta's 206 untouched", async () => {
    const res = await downloadMediaStream({
      downloadUrl: "https://cdn.meta/video",
      accessToken: "tok",
      range: "bytes=0-1023",
    });
    expect(seenHeaders["range"]).toBe("bytes=0-1023");
    expect(seenHeaders["authorization"]).toBe("Bearer tok");
    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe("bytes 0-1023/5000");
    // Streams through — no buffering into memory.
    expect(res.body).toBe("stream-body");
  });

  it("omits Range when the browser sent none", async () => {
    await downloadMediaStream({
      downloadUrl: "https://cdn.meta/video",
      accessToken: "tok",
    });
    expect(seenHeaders["range"]).toBeUndefined();
  });

  it("throws on Meta errors so the route can 500 with a fallback", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 404 }) as Response),
    );
    await expect(
      downloadMediaStream({ downloadUrl: "https://cdn.meta/x", accessToken: "tok" }),
    ).rejects.toThrow(/404/);
  });
});
