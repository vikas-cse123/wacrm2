import { describe, expect, it } from "vitest";

import { buildDialogInputs } from "./travel-crm-action";

// ---------------------------------------------------------------------------
// Services section visibility — the multi-select renders whenever
// the mapping still needs services OR the dialog already carries
// preselected services (flow defaults or lead data). Prefill
// without a visible input was the reported bug: saved defaults
// resolved server-side yet the dialog showed no Services section.
// ---------------------------------------------------------------------------

const LIVE_OPTIONS = {
  leadSource: null,
  leadType: null,
  leadStage: null,
  services: [
    { value: "CRUISE", label: "Cruise" },
    { value: "FLIGHT", label: "Flight" },
    { value: "HOTEL", label: "Hotel" },
    { value: "SIGHTSEEING", label: "Sightseeing" },
  ],
};

function mapping(over: Partial<{
  available: string[];
  missing: string[];
}> = {}) {
  return {
    available: over.available ?? [],
    missing: over.missing ?? [],
    ambiguous: [],
    invalid: [],
    ready: false,
  };
}

describe("Services section appears in the completion dialog", () => {
  it("6. renders for flow-defaulted services even when mapping is available", () => {
    const inputs = buildDialogInputs(
      mapping({ available: ["services"], missing: ["assignedToEmail"] }),
      {
        services: ["HOTEL", "SIGHTSEEING"],
        assignedToEmail: null,
      },
      LIVE_OPTIONS,
      "assignment-required",
    );
    const services = inputs.find((i) => i.field === "services");
    expect(services).toBeDefined();
    expect(services?.kind).toBe("multi");
    // Prefilled defaults ride along as the input value.
    expect(services?.value).toEqual(["HOTEL", "SIGHTSEEING"]);
    // Live options flow through for the checkboxes.
    expect(services?.options).toEqual(LIVE_OPTIONS.services);
  });

  it("2+3+4+5. each configured default is preselected; others are not", () => {
    const inputs = buildDialogInputs(
      mapping({ available: ["services"], missing: ["assignedToEmail"] }),
      { services: ["Cruise", "Flight", "Hotel"], assignedToEmail: null },
      LIVE_OPTIONS,
      "assignment-required",
    );
    // The input value carries exactly the configured labels —
    // nothing invented, nothing dropped.
    expect(inputs.find((i) => i.field === "services")?.value).toEqual([
      "Cruise",
      "Flight",
      "Hotel",
    ]);
  });

  it("still renders when the mapping needs services (no prefill)", () => {
    const inputs = buildDialogInputs(
      mapping({ missing: ["services"] }),
      { assignedToEmail: "agent@acme.com" },
      LIVE_OPTIONS,
      null,
    );
    const services = inputs.find((i) => i.field === "services");
    expect(services?.kind).toBe("multi");
    expect(services?.value).toBeNull();
  });

  it("stays hidden only when unneeded AND unprefilled", () => {
    const inputs = buildDialogInputs(
      mapping({ available: ["services", "customerName"], missing: ["travelStartDate"] }),
      { assignedToEmail: "agent@acme.com" },
      LIVE_OPTIONS,
      null,
    );
    expect(inputs.find((i) => i.field === "services")).toBeUndefined();
    expect(inputs.map((i) => i.field)).toContain("travelStartDate");
  });

  it("never re-asks email/rooms while showing services", () => {
    const inputs = buildDialogInputs(
      mapping({ available: ["services"], missing: ["email", "rooms"] }),
      { services: ["HOTEL"], assignedToEmail: "agent@acme.com" },
      LIVE_OPTIONS,
      null,
    );
    expect(inputs.find((i) => i.field === "services")?.kind).toBe("multi");
    expect(inputs.find((i) => i.field === "email")).toBeUndefined();
    expect(inputs.find((i) => i.field === "rooms")).toBeUndefined();
  });
});
