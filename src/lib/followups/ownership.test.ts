import { describe, expect, it } from "vitest";

import { canManageReminder } from "./ownership";

describe("canManageReminder", () => {
  it("lets the creator manage their own reminder at any role", () => {
    for (const role of ["agent", "admin", "owner"] as const) {
      expect(
        canManageReminder(role, { created_by: "user-1" }, "user-1"),
      ).toBe(true);
    }
  });

  it("blocks teammates but allows the admin override", () => {
    const row = { created_by: "user-1" };
    expect(canManageReminder("agent", row, "user-2")).toBe(false);
    expect(canManageReminder("viewer", row, "user-2")).toBe(false);
    expect(canManageReminder("admin", row, "user-2")).toBe(true);
    expect(canManageReminder("owner", row, "user-2")).toBe(true);
  });

  it("fails closed on legacy rows without a creator", () => {
    expect(canManageReminder("agent", { created_by: null }, "user-1")).toBe(false);
    expect(canManageReminder("agent", {}, "user-1")).toBe(false);
    expect(canManageReminder("admin", { created_by: null }, "user-1")).toBe(true);
  });
});
