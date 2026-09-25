import { describe, expect, it } from "vitest";

import { GET } from "./route";

describe("GET /api/version", () => {
  it("returns a build signal without secrets", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      ok: boolean;
      commit: unknown;
      builtAt: unknown;
    };
    expect(json.ok).toBe(true);
    expect(typeof json.commit).toBe("string");
    expect(JSON.stringify(json)).not.toMatch(/key|token|secret/i);
  });
});
