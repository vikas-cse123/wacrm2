import { describe, it, expect } from "vitest";
import { uniqueCopyName } from "./duplicate";

describe("uniqueCopyName", () => {
  it("appends ' - Copy' when the base name is free", () => {
    expect(uniqueCopyName("Welcome Flow", [])).toBe("Welcome Flow - Copy");
    expect(uniqueCopyName("Welcome Flow", ["Other Flow"])).toBe(
      "Welcome Flow - Copy",
    );
  });

  it("bumps the suffix when the base copy already exists", () => {
    expect(uniqueCopyName("Welcome Flow", ["Welcome Flow - Copy"])).toBe(
      "Welcome Flow - Copy 2",
    );
  });

  it("keeps incrementing past multiple collisions", () => {
    expect(
      uniqueCopyName("Welcome Flow", [
        "Welcome Flow - Copy",
        "Welcome Flow - Copy 2",
        "Welcome Flow - Copy 3",
      ]),
    ).toBe("Welcome Flow - Copy 4");
  });

  it("handles whitespace around existing names", () => {
    expect(uniqueCopyName("Welcome Flow", ["  Welcome Flow - Copy  "])).toBe(
      "Welcome Flow - Copy 2",
    );
  });

  it("treats non-copy names as non-colliding", () => {
    expect(
      uniqueCopyName("Welcome Flow", ["Welcome Flow - Copy Cat"]),
    ).toBe("Welcome Flow - Copy");
  });
});
