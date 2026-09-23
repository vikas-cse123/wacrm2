import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  role: "admin" as string | null,
  config: {
    phone_number_id: "pn-1",
    access_token: "enc-token",
    meta_app_id: "app-1",
  } as Record<string, string | null> | null,
  uploadBehavior: "ok" as "ok" | "fail",
  updateBehavior: "ok" as "ok" | "fail",
  metaCalls: [] as Array<{ kind: string; fields?: unknown; appId?: unknown }>,
  refetchedUrl: "https://cdn.meta/photo-new.jpg",
}));

vi.mock("@/lib/auth/account", () => ({
  requireRole: async (role: string) => {
    if (h.role !== role && !(h.role === "owner" && role === "admin")) {
      const err = new Error("Forbidden") as Error & { status: number };
      err.status = 403;
      throw err;
    }
    return { supabase: fakeSupabase(), accountId: "acct-1" };
  },
  toErrorResponse: (err: unknown) => {
    const status =
      err instanceof Error && "status" in err
        ? Number((err as { status: unknown }).status) || 500
        : 500;
    return Response.json(
      { error: err instanceof Error ? err.message : "Internal server error" },
      { status },
    );
  },
}));

function fakeSupabase() {
  return {
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({ data: h.config, error: null }),
        }),
      }),
    }),
  };
}

vi.mock("@/lib/whatsapp/encryption", () => ({
  decrypt: () => "plain-token",
}));

vi.mock("@/lib/whatsapp/meta-api", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/whatsapp/meta-api")>();
  return {
    ...actual,
    uploadProfilePhoto: async (args: {
      appId: string;
      fileName: string;
      mimeType: string;
      bytes: Uint8Array;
    }) => {
      h.metaCalls.push({ kind: "upload", appId: args.appId });
      if (h.uploadBehavior === "fail") {
        throw new Error("Resumable upload failed: 400");
      }
      return { handle: "image-handle-1" };
    },
    updateBusinessProfile: async (args: {
      fields: Record<string, unknown>;
    }) => {
      h.metaCalls.push({ kind: "update", fields: args.fields });
      if (h.updateBehavior === "fail") {
        throw new Error("Meta API error: 400");
      }
    },
    getBusinessProfile: async () => {
      h.metaCalls.push({ kind: "get" });
      return {
        about: null,
        address: null,
        description: null,
        email: null,
        profile_picture_url: h.refetchedUrl,
        vertical: null,
        websites: [],
      };
    },
  };
});

const { POST } = await import("./route");

function photoRequest() {
  const form = new FormData();
  form.append(
    "file",
    new File([new Uint8Array([1, 2, 3])], "photo.jpg", {
      type: "image/jpeg",
    }),
  );
  return new Request("https://app.test/api/whatsapp/business-profile/photo", {
    method: "POST",
    body: form,
  });
}

function bodyText(json: Record<string, unknown>): string {
  return JSON.stringify(json);
}

beforeEach(() => {
  h.role = "admin";
  h.config = {
    phone_number_id: "pn-1",
    access_token: "enc-token",
    meta_app_id: "app-1",
  };
  h.uploadBehavior = "ok";
  h.updateBehavior = "ok";
  h.metaCalls = [];
  h.refetchedUrl = "https://cdn.meta/photo-new.jpg";
  vi.stubEnv("META_APP_ID", "");
});

describe("POST /api/whatsapp/business-profile/photo", () => {
  it("uploads, sets profile_picture_handle, and returns the refetched profile_picture_url", async () => {
    const res = await POST(photoRequest());
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.profile).toMatchObject({
      profile_picture_url: "https://cdn.meta/photo-new.jpg",
    });
    const kinds = h.metaCalls.map((c) => c.kind);
    expect(kinds).toEqual(["upload", "update", "get"]);
    expect(
      h.metaCalls.find((c) => c.kind === "update")?.fields,
    ).toEqual({ profile_picture_handle: "image-handle-1" });
    // Token never exposed to the client.
    expect(bodyText(json)).not.toContain("plain-token");
    expect(bodyText(json)).not.toContain("enc-token");
  });

  it("reports upload failures separately without touching the profile", async () => {
    h.uploadBehavior = "fail";
    const res = await POST(photoRequest());
    expect(res.status).toBe(502);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.stage).toBe("upload");
    expect(typeof json.error).toBe("string");
    expect(h.metaCalls.map((c) => c.kind)).toEqual(["upload"]);
    expect(bodyText(json)).not.toContain("plain-token");
  });

  it("reports profile-update failures separately (photo not applied)", async () => {
    h.updateBehavior = "fail";
    const res = await POST(photoRequest());
    expect(res.status).toBe(502);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.stage).toBe("update");
    expect(typeof json.error).toBe("string");
    // Upload happened, update was attempted, but no success payload.
    expect(h.metaCalls.map((c) => c.kind)).toEqual([
      "upload",
      "update",
    ]);
    expect(json).not.toHaveProperty("profile");
    expect(bodyText(json)).not.toContain("plain-token");
  });

  it("requires a Meta App ID for the app-scoped upload", async () => {
    h.config = {
      phone_number_id: "pn-1",
      access_token: "enc-token",
      meta_app_id: null,
    };
    const res = await POST(photoRequest());
    expect(res.status).toBe(400);
    const json = (await res.json()) as Record<string, unknown>;
    expect(typeof json.error).toBe("string");
    expect(h.metaCalls).toEqual([]);
  });

  it("falls back to the env Meta App ID when the account has none", async () => {
    h.config = {
      phone_number_id: "pn-1",
      access_token: "enc-token",
      meta_app_id: null,
    };
    vi.stubEnv("META_APP_ID", "env-app-9");
    const res = await POST(photoRequest());
    expect(res.status).toBe(200);
    expect(h.metaCalls.find((c) => c.kind === "upload")?.appId).toBe(
      "env-app-9",
    );
  });

  it("rejects non-admin callers (RBAC preserved)", async () => {
    h.role = "member";
    const res = await POST(photoRequest());
    expect(res.status).toBe(403);
    expect(h.metaCalls).toEqual([]);
  });
});
