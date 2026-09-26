import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import {
  buildDialogInputs,
  FunnelSelect,
  resizeAgeRows,
  resolveDepartureCityOnCountryChange,
  seedTravelerForm,
  seedValues,
  travelerAgeCount,
  travelerFormToOverrides,
  TravelCrmAction,
  validateTravelerForm,
  type TravelerForm,
} from "./travel-crm-action";
import {
  LEAD_RECEIVED_OPTIONS,
  LEAD_TYPE_OPTIONS,
  STAGE_OPTIONS,
} from "@/lib/flows/workspace-defaults";
import { departureCityOptions } from "@/lib/integrations/travel-crm/departure-catalog";

describe("TravelCrmAction (Phase 3: connected)", () => {
  it("renders the Create action without a Created state", () => {
    const html = renderToStaticMarkup(
      <TravelCrmAction flowId="flow-1" runId="run-1" />
    );
    expect(html).toContain("Create in Travel CRM");
    expect(html).not.toContain("Creating");
    expect(html).not.toContain("Created in Travel CRM");
    expect(html).not.toContain("Lead Created");
  });
});

describe("buildDialogInputs (missing fields + always Name/Phone)", () => {
  const base = {
    available: ["customerName", "phone"],
    missing: ["travelStartDate", "leadSource", "services"],
    ambiguous: [],
    invalid: [],
    ready: false,
  };

  it("lists exactly the missing inputs with prefilled values", () => {
    const inputs = buildDialogInputs(
      base,
      { customerName: "Rahul", phone: "+911234567890", travelStartDate: null, services: ["Flight"] },
      {
        leadSource: [{ value: "WHATSAPP", label: "WhatsApp" }],
        leadType: null,
        leadStage: null,
        services: [{ value: "FLIGHT", label: "Flight" }],
      },
      null,
    );
    expect(inputs.map((i) => i.field)).toEqual([
      "customerName",
      "phone",
      "leadSource",
      "leadType",
      "leadStage",
      "departureCountry",
      "departureCity",
      "services",
      "assignedToEmail",
      "travelStartDate",
    ]);
    // Name/Phone lead the dialog, prefilled from the canonical WACRM
    // flow-run values (same contact/submission data), editable.
    expect(inputs[0].field).toBe("customerName");
    expect(inputs[1].field).toBe("phone");
    expect(inputs.find((i) => i.field === "customerName")?.value).toBe("Rahul");
    expect(inputs.find((i) => i.field === "phone")?.value).toBe("+911234567890");
    expect(inputs.find((i) => i.field === "customerName")?.label).toBe("Name");
    expect(inputs.find((i) => i.field === "phone")?.label).toBe("Phone");
    // Received renders as an editable select with live options when
    // the mapping flags it.
    const received = inputs.find((i) => i.field === "leadSource");
    expect(received?.kind).toBe("select");
    expect(received?.label).toBe("Received");
    expect(received?.options).toEqual([{ value: "WHATSAPP", label: "WhatsApp" }]);
    // Type/Stage always render too — here on the canonical
    // Workspace fallback sets (no live options in this fixture),
    // so they can never degrade to text inputs.
    const type = inputs.find((i) => i.field === "leadType");
    expect(type?.kind).toBe("select");
    expect(type?.label).toBe("Type");
    expect(type?.options?.map((o) => o.label)).toEqual([...LEAD_TYPE_OPTIONS]);
    const stage = inputs.find((i) => i.field === "leadStage");
    expect(stage?.kind).toBe("select");
    expect(stage?.label).toBe("Stage");
    expect(stage?.options?.map((o) => o.label)).toEqual([...STAGE_OPTIONS]);
    // Known services value rides along.
    expect(inputs.find((i) => i.field === "services")?.value).toEqual(["Flight"]);
  });

  it("requires the assignee member when the owner email is missing", () => {
    const inputs = buildDialogInputs(
      { ...base, missing: ["assignedToEmail"] },
      {},
      null,
      "assignment-required",
    );
    expect(inputs.map((i) => i.field)).toContain("assignedToEmail");
    expect(inputs.find((i) => i.field === "assignedToEmail")?.kind).toBe("member");
  });

  it("ambiguous input fields surface candidates as hints", () => {
    const inputs = buildDialogInputs(
      {
        available: [],
        missing: [],
        ambiguous: [{ field: "destination", candidates: ["Goa", "Bali"] }],
        invalid: [],
        ready: false,
      },
      {},
      null,
      null,
    );
    // Legacy single destination ambiguity is subsumed by the
    // multi-row itinerary editor (Destination/City/Nights + Add
    // More/Remove) — the editor is shown instead of a lone text input.
    const itin = inputs.find((i) => i.field === "itinerary");
    expect(itin).toBeDefined();
    expect(itin?.kind).toBe("itinerary");
    expect(inputs.find((i) => i.field === "destination")).toBeUndefined();
  });

  it("never includes email or rooms as manual inputs", () => {
    const inputs = buildDialogInputs(
      {
        available: [],
        missing: ["email", "rooms", "travelStartDate"],
        ambiguous: [{ field: "email", candidates: ["a@b.co", "c@d.co"] }],
        invalid: [{ field: "rooms", reason: "bad-count" }],
        ready: false,
      },
      { email: null, rooms: null, assignedToEmail: "agent@acme.com" },
      null,
      null,
    );
    // Name/Phone always lead; email/rooms never appear. The funnel
    // trio and departure pair always render (canonical fallbacks
    // when the server sends no option lists).
    expect(inputs.map((i) => i.field)).toEqual([
      "customerName",
      "phone",
      "leadSource",
      "leadType",
      "leadStage",
      "departureCountry",
      "departureCity",
      "travelStartDate",
    ]);
    for (const f of ["leadSource", "leadType", "leadStage"] as const) {
      expect(inputs.find((i) => i.field === f)?.kind).toBe("select");
    }
  });

  it("Received always renders, prefilled from the Workspace row", () => {
    const inputs = buildDialogInputs(
      {
        available: ["leadSource", "customerName"],
        missing: ["leadType", "leadStage"],
        ambiguous: [],
        invalid: [],
        ready: false,
      },
      { leadSource: "FACEBOOK_ADS", assignedToEmail: "agent@acme.com" },
      {
        leadSource: [{ value: "FACEBOOK_ADS", label: "Facebook Ads" }],
        leadType: null,
        leadStage: null,
        services: null,
      },
      null,
    );
    expect(inputs.map((i) => i.field)).toEqual([
      "customerName",
      "phone",
      "leadSource",
      "leadType",
      "leadStage",
      "departureCountry",
      "departureCity",
    ]);
    // Row-resolved enum seeds the Received select even though the
    // mapping marks it available; Type/Stage ride the canonical
    // fallbacks (no live options in this fixture).
    expect(inputs.find((i) => i.field === "leadSource")?.value).toBe("FACEBOOK_ADS");
    expect(inputs.find((i) => i.field === "leadSource")?.kind).toBe("select");
    for (const f of ["leadType", "leadStage"] as const) {
      expect(inputs.find((i) => i.field === f)?.kind).toBe("select");
    }
  });
});

describe("Received/Type/Stage editable selects (row-initialized)", () => {
  const mapping = {
    available: ["customerName"],
    missing: ["leadSource", "leadType"],
    ambiguous: [],
    invalid: [],
    ready: false,
  };
  const receivedOptions = [
    { value: "WEBSITE", label: "Website" },
    { value: "FACEBOOK_ADS", label: "Facebook Ads" },
    { value: "INSTAGRAM_ADS", label: "Instagram Ads" },
  ];
  const liveOptions = {
    leadSource: [{ value: "WHATSAPP", label: "WhatsApp" }],
    leadType: [{ value: "HOT", label: "Hot" }],
    leadStage: null,
    services: null,
  };

  it("renders flagged funnel fields as selects holding the row-resolved enums", () => {
    const inputs = buildDialogInputs(
      mapping,
      {
        leadSource: "INSTAGRAM_ADS",
        leadType: "HOT",
        rowLeadSource: "Instagram Ads",
        rowLeadType: "Hot",
        assignedToEmail: "agent@acme.com",
      },
      liveOptions,
      null,
      receivedOptions,
    );
    const received = inputs.find((i) => i.field === "leadSource");
    const type = inputs.find((i) => i.field === "leadType");
    expect(received?.kind).toBe("select");
    expect(received?.label).toBe("Received");
    expect(received?.options).toEqual(receivedOptions);
    // The input holds the canonical enum (Select shows its label);
    // the row display keys are never consumed as a second source.
    expect(received?.value).toBe("INSTAGRAM_ADS");
    expect(type?.kind).toBe("select");
    expect(type?.label).toBe("Type");
    expect(type?.options).toEqual([{ value: "HOT", label: "Hot" }]);
    expect(type?.value).toBe("HOT");
    // Stage always renders too — here on the canonical Workspace
    // fallback (no live Stage options in this fixture).
    const stage = inputs.find((i) => i.field === "leadStage");
    expect(stage?.kind).toBe("select");
    expect(stage?.label).toBe("Stage");
    expect(stage?.options?.map((o) => o.label)).toEqual([...STAGE_OPTIONS]);
    expect(stage?.value).toBeNull();
  });

  it("falls back to live options when the dedicated list is absent", () => {
    const inputs = buildDialogInputs(
      mapping,
      { leadSource: "WHATSAPP", assignedToEmail: "agent@acme.com" },
      liveOptions,
      null,
      null,
    );
    const received = inputs.find((i) => i.field === "leadSource");
    expect(received?.kind).toBe("select");
    expect(received?.options).toEqual([{ value: "WHATSAPP", label: "WhatsApp" }]);
    expect(received?.value).toBe("WHATSAPP");
  });

  it("empty stays empty (nothing invented)", () => {
    const inputs = buildDialogInputs(
      mapping,
      { assignedToEmail: "agent@acme.com" },
      liveOptions,
      null,
      receivedOptions,
    );
    expect(inputs.find((i) => i.field === "leadSource")?.value).toBeNull();
    expect(inputs.find((i) => i.field === "leadType")?.value).toBeNull();
  });

  it("ambiguous funnel fields surface candidates as select hints", () => {
    const inputs = buildDialogInputs(
      {
        available: [],
        missing: [],
        ambiguous: [{ field: "leadType", candidates: ["Hot", "Warm"] }],
        invalid: [],
        ready: false,
      },
      { leadType: null, assignedToEmail: "agent@acme.com" },
      liveOptions,
      null,
      receivedOptions,
    );
    const type = inputs.find((i) => i.field === "leadType");
    expect(type?.kind).toBe("select");
    expect(type?.hint).toBe(
      "Multiple values found: Hot / Warm — pick or type the correct one.",
    );
  });

  it("the dedicated option list itself is unchanged", () => {
    // The 12-option Received list still carries canonical enums.
    const picked = receivedOptions.find((o) => o.label === "Facebook Ads");
    expect(picked).toEqual({ value: "FACEBOOK_ADS", label: "Facebook Ads" });
  });

  it("funnel fallbacks are the exact canonical Workspace label sets", () => {
    const inputs = buildDialogInputs(
      { available: [], missing: [], ambiguous: [], invalid: [], ready: true },
      { assignedToEmail: "agent@acme.com" },
      { leadSource: null, leadType: null, leadStage: null, services: null },
      null,
      null,
    );
    // Even with no live options anywhere, all three funnel fields
    // render as selects with the canonical label order — never text
    // inputs, never missing.
    expect(inputs.find((i) => i.field === "leadSource")?.options?.map((o) => o.label)).toEqual([
      ...LEAD_RECEIVED_OPTIONS,
    ]);
    expect(inputs.find((i) => i.field === "leadType")?.options?.map((o) => o.label)).toEqual([
      ...LEAD_TYPE_OPTIONS,
    ]);
    expect(inputs.find((i) => i.field === "leadStage")?.options?.map((o) => o.label)).toEqual([
      ...STAGE_OPTIONS,
    ]);
  });
});

describe("FunnelSelect (shared Workspace chip surface)", () => {  it("paints the selected value with the Workspace chip", () => {
    // Lead Type "Hot" uses the exact shared chip (strong red) —
    // the same mapping the Workspace cells render through.
    const html = renderToStaticMarkup(
      <FunnelSelect
        label="Type"
        value="HOT"
        options={[{ value: "HOT", label: "Hot" }]}
        fieldName="Lead Type"
        onChange={() => {}}
      />,
    );
    expect(html).toContain("Hot");
    expect(html).toContain("#dc2626");
  });

  it("renders an empty trigger with no chip when cleared", () => {
    const html = renderToStaticMarkup(
      <FunnelSelect
        label="Stage"
        value=""
        options={[{ value: "NEW_LEAD", label: "New Lead" }]}
        fieldName="Stage"
        onChange={() => {}}
      />,
    );
    expect(html).not.toContain("#dbeafe");
    expect(html).toContain("Stage");
  });
});

describe("services multi-select input", () => {
  const mapping = {
    available: ["customerName"],
    missing: ["services"],
    ambiguous: [],
    invalid: [],
    ready: false,
  };
  const liveOptions = {
    leadSource: null,
    leadType: null,
    leadStage: null,
    services: [
      { value: "HOTEL", label: "Hotel" },
      { value: "FLIGHT", label: "Flight" },
    ],
  };

  it("services renders as multi with live options passed through", () => {
    const inputs = buildDialogInputs(mapping, {}, liveOptions, null, null);
    const services = inputs.find((i) => i.field === "services");
    expect(services?.kind).toBe("multi");
    expect(services?.options).toEqual(liveOptions.services);
  });

  it("prefilled flow defaults ride along as the input value", () => {
    const inputs = buildDialogInputs(
      mapping,
      { services: ["HOTEL", "SIGHTSEEING"] },
      liveOptions,
      null,
      null,
    );
    expect(inputs.find((i) => i.field === "services")?.value).toEqual([
      "HOTEL",
      "SIGHTSEEING",
    ]);
  });
});

describe("Travelers section (Adults/CWB/CWOB/Infants + ages)", () => {
  const blank: TravelerForm = {
    adults: "2",
    cwb: "",
    cwob: "",
    infants: "",
    cwbAges: [],
    cwobAges: [],
    infantAges: [],
  };

  it("1. Adults defaults to 1 when prefill has nothing", () => {
    expect(seedTravelerForm({}).adults).toBe("1");
    expect(seedTravelerForm({ adults: null }).adults).toBe("1");
    expect(seedTravelerForm({ adults: 2 }).adults).toBe("2");
  });

  it("2+3+4. Adults rejects 0, empty, and negatives", () => {
    for (const adults of ["0", "", "   ", "-1", "-2"]) {
      expect(validateTravelerForm({ ...blank, adults })).not.toBeNull();
    }
    expect(validateTravelerForm({ ...blank, adults: "two" })).not.toBeNull();
    expect(validateTravelerForm({ ...blank, adults: "1.5" })).not.toBeNull();
  });

  it("5. validation blocks Create (submit returns before any send)", () => {
    expect(validateTravelerForm({ ...blank, adults: "0" })).toContain("Adults");
  });

  it("6+7+8. CWB/CWOB/Infants are optional (empty omitted)", () => {
    expect(validateTravelerForm(blank)).toBeNull();
    expect(validateTravelerForm({ ...blank, cwb: "0", infants: "0" })).toBeNull();
    expect(validateTravelerForm({ ...blank, cwob: "two" })).not.toBeNull();
    expect(validateTravelerForm({ ...blank, infants: "-1" })).not.toBeNull();
  });

  it("9+10+11. counts create the matching number of age rows", () => {
    expect(resizeAgeRows([], 2)).toEqual(["", ""]);
    expect(resizeAgeRows(["5"], 2)).toEqual(["5", ""]);
    expect(resizeAgeRows([], 0)).toEqual([]);
    expect(travelerAgeCount("2")).toBe(2);
    expect(travelerAgeCount("")).toBe(0);
    expect(travelerAgeCount("two")).toBe(0);
  });

  it("12. reducing a count drops the extra age rows safely", () => {
    expect(resizeAgeRows(["3", "5", "7"], 1)).toEqual(["3"]);
    const shrunk = resizeAgeRows(["3", "5"], 0);
    expect(shrunk).toEqual([]);
  });

  it("13. blank optional ages never block creation", () => {
    expect(
      validateTravelerForm({ ...blank, cwb: "2", cwbAges: ["", "  "] }),
    ).toBeNull();
    expect(
      validateTravelerForm({ ...blank, infants: "1", infantAges: [""] }),
    ).toBeNull();
  });

  it("rejects non-numeric ages only when entered", () => {
    expect(
      validateTravelerForm({ ...blank, cwb: "1", cwbAges: ["abc"] }),
    ).not.toBeNull();
    expect(
      validateTravelerForm({ ...blank, cwb: "1", cwbAges: ["120"] }),
    ).not.toBeNull();
  });

  it("14–18. form maps to the Travel CRM payload keys", () => {
    expect(
      travelerFormToOverrides({
        adults: "2",
        cwb: "1",
        cwob: "0",
        infants: "1",
        cwbAges: ["5", ""],
        cwobAges: [],
        infantAges: ["1"],
      }),
    ).toEqual({
      adults: 2,
      childrenWithBed: 1,
      childrenWithoutBed: 0,
      infants: 1,
      childrenWithBedAges: [5],
      childrenWithoutBedAges: [],
      infantAges: [1],
    });
  });

  it("empty optionals map to null/[] (never invented)", () => {
    expect(travelerFormToOverrides({ ...blank, adults: "1" })).toEqual({
      adults: 1,
      childrenWithBed: null,
      childrenWithoutBed: null,
      infants: null,
      childrenWithBedAges: [],
      childrenWithoutBedAges: [],
      infantAges: [],
    });
  });

  it("replaces the standalone Adults input with one grouped section", () => {
    const inputs = buildDialogInputs(
      { available: [], missing: ["adults"], ambiguous: [], invalid: [], ready: false },
      { assignedToEmail: "agent@acme.com" },
      null,
      null,
    );
    expect(inputs.map((i) => i.field)).toContain("travelers");
    expect(inputs.map((i) => i.field)).not.toContain("adults");
    const travelers = inputs.find((i) => i.field === "travelers");
    expect(travelers?.kind).toBe("travelers");
    expect(travelers?.label).toBe("Travelers *");
    // Seeded Adults default rides along as the input value.
    expect(travelers?.value).toMatchObject({ adults: "1" });
    // Position preserved: where Adults used to sit.
    const fields = inputs.map((i) => i.field);
    expect(fields.indexOf("travelers")).toBeGreaterThan(fields.indexOf("departureCity"));
  });

  it("prefilled traveler values seed the section", () => {
    const inputs = buildDialogInputs(
      { available: [], missing: ["adults"], ambiguous: [], invalid: [], ready: false },
      {
        adults: 2,
        childrenWithBed: 1,
        childrenWithBedAges: [5],
        assignedToEmail: "agent@acme.com",
      },
      null,
      null,
    );
    expect(inputs.find((i) => i.field === "travelers")?.value).toMatchObject({
      adults: "2",
      cwb: "1",
      cwbAges: ["5"],
    });
  });

  it("ambiguous adults surface candidates as hints on the section", () => {
    const inputs = buildDialogInputs(
      {
        available: [],
        missing: [],
        ambiguous: [{ field: "adults", candidates: ["2", "3"] }],
        invalid: [],
        ready: false,
      },
      { assignedToEmail: "agent@acme.com" },
      null,
      null,
    );
    const travelers = inputs.find((i) => i.field === "travelers");
    expect(travelers?.hint).toContain("2");
    expect(travelers?.hint).toContain("3");
  });
});

describe("seedValues (dialog-open prefill preservation)", () => {  it("11. prefilled funnel enums survive dialog open; row display keys never leak", () => {
    const values = seedValues({
      customerName: "Rahul",
      phone: "+911234567890",
      leadSource: "FACEBOOK_ADS",
      leadType: "FRESH",
      leadStage: "NEW_LEAD",
      rowLeadSource: "Facebook Ads",
      rowLeadType: "Fresh",
      rowLeadStage: "New Lead",
      assignedToEmail: "agent@acme.com",
    });
    // The FunnelSelect initial values: exact server prefill enums.
    expect(values).toMatchObject({
      leadSource: "FACEBOOK_ADS",
      leadType: "FRESH",
      leadStage: "NEW_LEAD",
    });
    // Row display keys feed nothing — no second value source.
    expect(values).not.toHaveProperty("rowLeadSource");
    expect(values).not.toHaveProperty("rowLeadType");
    expect(values).not.toHaveProperty("rowLeadStage");
  });
});

describe("Departure Country/City catalog selects (saved flow defaults)", () => {
  // Regression condition: saving Travel CRM Settings marks both
  // fields available (not missing). The dialog must still render
  // them, prefilled from the saved defaults.
  const savedMapping = {
    available: ["customerName", "departureCountry", "departureCity"],
    missing: ["travelStartDate"],
    ambiguous: [],
    invalid: [],
    ready: false,
  };

  it("1+9. saved India/Delhi render prefilled even though marked available", () => {
    const inputs = buildDialogInputs(
      savedMapping,
      {
        departureCountry: "India",
        departureCity: "Delhi",
        assignedToEmail: "agent@acme.com",
      },
      null,
      null,
    );
    const country = inputs.find((i) => i.field === "departureCountry");
    const city = inputs.find((i) => i.field === "departureCity");
    expect(country?.kind).toBe("select");
    expect(country?.label).toBe("Departure Country");
    expect(country?.value).toBe("India");
    expect(city?.kind).toBe("select");
    expect(city?.label).toBe("Departure City");
    expect(city?.value).toBe("Delhi");
    // Country options come from the copied catalog.
    expect(country?.options?.some((o) => o.value === "India")).toBe(true);
    // City options are the Indian catalog list containing Delhi.
    expect(city?.options).toEqual(
      departureCityOptions("India").map((o) => ({ value: o.value, label: o.label })),
    );
    expect(city?.options?.some((o) => o.value === "Delhi")).toBe(true);
    // Saved defaults seed dialog state verbatim (initial values).
    expect(
      seedValues({ departureCountry: "India", departureCity: "Delhi" }),
    ).toMatchObject({ departureCountry: "India", departureCity: "Delhi" });
  });

  it("3. no saved defaults still render; city stays empty", () => {
    const inputs = buildDialogInputs(
      {
        available: ["customerName"],
        missing: ["travelStartDate", "departureCountry", "departureCity"],
        ambiguous: [],
        invalid: [],
        ready: false,
      },
      { assignedToEmail: "agent@acme.com" },
      null,
      null,
    );
    const country = inputs.find((i) => i.field === "departureCountry");
    const city = inputs.find((i) => i.field === "departureCity");
    expect(country?.kind).toBe("select");
    expect(country?.value).toBeNull();
    expect(city?.kind).toBe("select");
    expect(city?.value).toBeNull();
    // No crash, no invention: the catalog list is ready while the
    // selection stays empty (the control waits for a country).
    expect(city?.options).toEqual(
      departureCityOptions("").map((o) => ({ value: o.value, label: o.label })),
    );
  });

  it("4. city options follow the prefilled country via the catalog", () => {
    const forCountry = (c: string | null) =>
      buildDialogInputs(
        savedMapping,
        {
          departureCountry: c,
          departureCity: null,
          assignedToEmail: "agent@acme.com",
        },
        null,
        null,
      ).find((i) => i.field === "departureCity")?.options ?? null;
    expect(forCountry("India")).toEqual(
      departureCityOptions("India").map((o) => ({ value: o.value, label: o.label })),
    );
    expect(forCountry("France")).toEqual(
      departureCityOptions("France").map((o) => ({ value: o.value, label: o.label })),
    );
    expect(forCountry("India")).not.toEqual(forCountry("France"));
  });

  it("5. changing country clears only an incompatible city", () => {
    // Agra is India-list-only; Dubai is curated-list-only.
    expect(resolveDepartureCityOnCountryChange("United Arab Emirates", "Agra")).toBe("");
    expect(resolveDepartureCityOnCountryChange("India", "Dubai")).toBe("");
    expect(resolveDepartureCityOnCountryChange("United Arab Emirates", "Dubai")).toBe("Dubai");
    expect(resolveDepartureCityOnCountryChange("India", "Delhi")).toBe("Delhi");
    expect(resolveDepartureCityOnCountryChange("India", "")).toBe("");
  });
});
