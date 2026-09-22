import { describe, expect, it } from "vitest";

import { parseNewFlowInput } from "./new-flow-input";

const UUID = "dab466d7-7263-4e7b-ba40-071709b2b60c";

describe("parseNewFlowInput", () => {
  it("treats ordinary names as blank flows", () => {
    expect(parseNewFlowInput("Singapore Chat Automation")).toEqual({
      kind: "blank",
      name: "Singapore Chat Automation",
    });
  });

  it("treats an exact UUID as a copy source", () => {
    expect(parseNewFlowInput(UUID)).toEqual({
      kind: "copy",
      sourceFlowId: UUID,
    });
  });

  it("trims whitespace before matching", () => {
    expect(parseNewFlowInput(`  ${UUID}  `)).toEqual({
      kind: "copy",
      sourceFlowId: UUID,
    });
  });

  it("treats partial UUIDs as blank names, never copy sources", () => {
    expect(parseNewFlowInput("dab466d7-7263")).toEqual({
      kind: "blank",
      name: "dab466d7-7263",
    });
  });

  it("treats random text as blank names", () => {
    expect(parseNewFlowInput("65380837-b289-44b0-a778")).toEqual({
      kind: "blank",
      name: "65380837-b289-44b0-a778",
    });
  });

  it("is case-insensitive for hex but still exact-length", () => {
    expect(parseNewFlowInput(UUID.toUpperCase()).kind).toBe("copy");
    expect(parseNewFlowInput(`${UUID}-extra`).kind).toBe("blank");
  });
});
