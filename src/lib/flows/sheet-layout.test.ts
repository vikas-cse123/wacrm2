// ============================================================
// V3 slim-columns layout tests + V1/V2 frozen-layout regression tests.
//
// V3 (new sheets): completed = Name? + Phone + Time + answers;
// incomplete = Name + Phone + Time + answers + Flow Run ID (hidden,
// always last). "Flow Name" / "User ID" must never appear in V3 output.
//
// V1/V2 (existing sheets): layouts frozen byte-for-byte — new rows must
// keep aligning with headers written before this change.
// ============================================================

import { describe, expect, it } from "vitest";

import {
  CURRENT_SHEET_SCHEMA_VERSION,
  STANDARD_COLUMNS_V1,
  STANDARD_COLUMNS_V2,
  STANDARD_COLUMNS_V3,
  standardColumnsForSchemaVersion,
} from "../google/sheets";
import {
  buildCompletedHeader,
  buildCompletedRow,
  buildIncompleteHeader,
  buildIncompleteRow,
  collectNewAnswerKeys,
  completedAnswerOffset,
  completedStandardLength,
  CURRENT_INCOMPLETE_SCHEMA_VERSION,
  INCOMPLETE_RUN_ID_HEADER,
  incompleteBaseOffset,
  incompleteLeadingHeader,
  incompleteRunIdColumnIndex,
  partitionSheetKeys,
  resolveFreshLinkSchemaVersion,
  type CompletedLayoutInput,
  type IncompleteLayoutInput,
  WHATSAPP_NAME_HEADER,
} from "./sheet-layout";

function completedInput(
  overrides: Partial<CompletedLayoutInput> = {},
): CompletedLayoutInput {
  return {
    schemaVersion: 3,
    nameHeader: "Name",
    nameValue: "Asha",
    contactPhone: "+911234567890",
    flowName: "Welcome Flow",
    submissionTime: "2:25 PM, 14 Jul 2026",
    contactId: "contact-uuid-1",
    answerKeys: ["city", "age"],
    answerHeaders: ["Which city?", "Age?"],
    activeKeys: new Set(["city", "age"]),
    vars: { city: "Goa", age: 31 },
    ...overrides,
  };
}

describe("sheet schema versions", () => {
  it("V3 is the current version and holds only Phone + Time", () => {
    expect(CURRENT_SHEET_SCHEMA_VERSION).toBe(3);
    expect([...STANDARD_COLUMNS_V3]).toEqual([
      "Phone Number",
      "Submission Time",
    ]);
  });

  it("V1/V2 constants are untouched (frozen legacy layouts)", () => {
    expect([...STANDARD_COLUMNS_V1]).toEqual([
      "Name",
      "Phone Number",
      "Flow Name",
      "Submission Time",
      "User ID",
    ]);
    expect([...STANDARD_COLUMNS_V2]).toEqual([
      "Phone Number",
      "Flow Name",
      "Submission Time",
      "User ID",
    ]);
  });

  it("standardColumnsForSchemaVersion routes nullish/1→V1, 2→V2, 3+→V3", () => {
    expect(standardColumnsForSchemaVersion(null)).toBe(STANDARD_COLUMNS_V1);
    expect(standardColumnsForSchemaVersion(undefined)).toBe(
      STANDARD_COLUMNS_V1,
    );
    expect(standardColumnsForSchemaVersion(1)).toBe(STANDARD_COLUMNS_V1);
    expect(standardColumnsForSchemaVersion(2)).toBe(STANDARD_COLUMNS_V2);
    expect(standardColumnsForSchemaVersion(3)).toBe(STANDARD_COLUMNS_V3);
    expect(standardColumnsForSchemaVersion(99)).toBe(STANDARD_COLUMNS_V3);
  });
});

describe("V3 completed layout", () => {
  it("headers are Name | Phone | Time | answers (no Flow Name / User ID)", () => {
    expect(buildCompletedHeader(completedInput())).toEqual([
      "Name",
      "Phone Number",
      "Submission Time",
      "Which city?",
      "Age?",
    ]);
  });

  it("values follow the exact header order", () => {
    expect(buildCompletedRow(completedInput())).toEqual([
      "Asha",
      "+911234567890",
      "2:25 PM, 14 Jul 2026",
      "Goa",
      "31",
    ]);
  });

  it("omits the leading Name cell when the flow captures no name", () => {
    const input = completedInput({ nameHeader: null, nameValue: null });
    expect(buildCompletedHeader(input)).toEqual([
      "Phone Number",
      "Submission Time",
      "Which city?",
      "Age?",
    ]);
    expect(buildCompletedRow(input)).toEqual([
      "+911234567890",
      "2:25 PM, 14 Jul 2026",
      "Goa",
      "31",
    ]);
  });

  it("leaves inactive (sheet_include:false) answer cells empty but aligned", () => {
    const input = completedInput({ activeKeys: new Set(["city"]) });
    const header = buildCompletedHeader(input);
    const row = buildCompletedRow(input);
    expect(header).toHaveLength(row.length);
    expect(row).toEqual([
      "Asha",
      "+911234567890",
      "2:25 PM, 14 Jul 2026",
      "Goa",
      "",
    ]);
  });

  it("header/value parity across versions, name on/off, empty answers", () => {
    for (const schemaVersion of [1, 2, 3]) {
      for (const withName of [true, false]) {
        for (const answers of [[], ["q1"]]) {
          const input = completedInput({
            schemaVersion,
            nameHeader: withName ? "Name" : null,
            nameValue: withName ? "Asha" : null,
            answerKeys: answers,
            answerHeaders: answers,
            activeKeys: new Set(answers),
            vars: { q1: "x" },
          });
          expect(buildCompletedHeader(input)).toHaveLength(
            buildCompletedRow(input).length,
          );
        }
      }
    }
  });

  it("no V3 header or row ever contains Flow Name / User ID", () => {
    const header = buildCompletedHeader(completedInput());
    const row = buildCompletedRow(completedInput()).map(String);
    for (const cell of [...header, ...row]) {
      expect(cell).not.toBe("Flow Name");
      expect(cell).not.toBe("User ID");
    }
    expect(header).not.toContain("Welcome Flow");
    expect(row).not.toContain("contact-uuid-1");
  });
});

describe("V1/V2 completed regression (existing sheets)", () => {
  it("V2 keeps Phone | Flow Name | Time | User ID + answers", () => {
    const input = completedInput({ schemaVersion: 2 });
    expect(buildCompletedHeader(input)).toEqual([
      "Name",
      "Phone Number",
      "Flow Name",
      "Submission Time",
      "User ID",
      "Which city?",
      "Age?",
    ]);
    expect(buildCompletedRow(input)).toEqual([
      "Asha",
      "+911234567890",
      "Welcome Flow",
      "2:25 PM, 14 Jul 2026",
      "contact-uuid-1",
      "Goa",
      "31",
    ]);
  });

  it("V1 keeps the blanked legacy leading Name cell", () => {
    const input = completedInput({ schemaVersion: 1, nameHeader: null });
    expect(buildCompletedHeader(input)).toEqual([
      "Name",
      "Phone Number",
      "Flow Name",
      "Submission Time",
      "User ID",
      "Which city?",
      "Age?",
    ]);
    // First value cell stays blank (WhatsApp-name source removed) so every
    // later cell keeps aligning under its original header.
    expect(buildCompletedRow(input)[0]).toBe("");
    expect(buildCompletedRow(input)).toHaveLength(
      buildCompletedHeader(input).length,
    );
  });

  it("healing offsets derive from the stored version (never hardcoded)", () => {
    expect(completedStandardLength(1)).toBe(5);
    expect(completedStandardLength(2)).toBe(4);
    expect(completedStandardLength(3)).toBe(2);
    // base = name cell (when present) + standards
    expect(completedAnswerOffset(2, true)).toBe(5);
    expect(completedAnswerOffset(2, false)).toBe(4);
    expect(completedAnswerOffset(3, true)).toBe(3);
    expect(completedAnswerOffset(3, false)).toBe(2);
    expect(completedAnswerOffset(1, false)).toBe(5);
  });
});

describe("V3 incomplete layout", () => {
  it("headers are Name | Phone | Time | answers | Flow Run ID", () => {
    expect(buildIncompleteHeader(3, ["city"])).toEqual([
      "Name",
      "Phone Number",
      "Submission Time",
      "city",
      "Flow Run ID",
    ]);
  });

  it("rows match the header order with the run id last", () => {
    expect(
      buildIncompleteRow({
        schemaVersion: 3,
        contactName: "Asha",
        contactPhone: "+911234567890",
        flowName: "Welcome Flow",
        submissionTime: "2:25 PM, 14 Jul 2026",
        contactId: "contact-uuid-1",
        vars: { city: "Goa" },
        answerColumns: ["city"],
        runId: "run-uuid-9",
      }),
    ).toEqual([
      "Asha",
      "+911234567890",
      "2:25 PM, 14 Jul 2026",
      "Goa",
      "run-uuid-9",
    ]);
  });

  it("V2 incomplete layout is unchanged (existing sheets)", () => {
    expect(buildIncompleteHeader(2, ["city"])).toEqual([
      "Name",
      "Phone Number",
      "Flow Name",
      "Submission Time",
      "User ID",
      "city",
      "Flow Run ID",
    ]);
    expect(
      buildIncompleteRow({
        schemaVersion: 2,
        contactName: "Asha",
        contactPhone: "+911234567890",
        flowName: "Welcome Flow",
        submissionTime: "2:25 PM, 14 Jul 2026",
        contactId: "contact-uuid-1",
        vars: { city: "Goa" },
        answerColumns: ["city"],
        runId: "run-uuid-9",
      }),
    ).toEqual([
      "Asha",
      "+911234567890",
      "Welcome Flow",
      "2:25 PM, 14 Jul 2026",
      "contact-uuid-1",
      "Goa",
      "run-uuid-9",
    ]);
  });

  it("nullish incomplete version defaults to frozen v2", () => {
    expect(buildIncompleteHeader(null, [])).toEqual(buildIncompleteHeader(2, []));
    expect(buildIncompleteHeader(undefined, [])).toEqual(
      buildIncompleteHeader(2, []),
    );
  });

  it("Flow Run ID index is always last and version-derived (hide target)", () => {
    for (const schemaVersion of [2, 3]) {
      for (const answers of [[], ["a"], ["a", "b", "c"]]) {
        const header = buildIncompleteHeader(schemaVersion, answers);
        const idx = incompleteRunIdColumnIndex(schemaVersion, answers);
        expect(idx).toBe(header.length - 1);
        expect(header[idx]).toBe(INCOMPLETE_RUN_ID_HEADER);
        expect(incompleteBaseOffset(schemaVersion)).toBe(
          1 + standardColumnsForSchemaVersion(schemaVersion).length,
        );
      }
    }
    // V3 is two columns slimmer than V2, so the key shifts left by two.
    expect(incompleteRunIdColumnIndex(3, ["a", "b"])).toBe(
      incompleteRunIdColumnIndex(2, ["a", "b"]) - 2,
    );
  });

  it("no V3 incomplete header/row contains Flow Name / User ID", () => {
    const header = buildIncompleteHeader(3, ["city"]);
    const row = buildIncompleteRow({
      schemaVersion: 3,
      contactName: "Asha",
      contactPhone: "+911234567890",
      flowName: "Welcome Flow",
      submissionTime: "t",
      contactId: "contact-uuid-1",
      vars: {},
      answerColumns: ["city"],
      runId: "run-1",
    }).map(String);
    expect(header).not.toContain("Flow Name");
    expect(header).not.toContain("User ID");
    expect(row).not.toContain("Welcome Flow");
    expect(row).not.toContain("contact-uuid-1");
  });
});

describe("dynamic answer-column healing", () => {
  it("appends unseen keys in first-seen order without moving existing ones", () => {
    const { answerColumns, newKeys } = collectNewAnswerKeys(["b"], [
      { a: 1, b: 2 },
      { c: 3, a: 4 },
    ]);
    expect(answerColumns).toEqual(["b", "a", "c"]);
    expect(newKeys).toEqual(["a", "c"]);
  });

  it("returns stored keys untouched when nothing is new", () => {
    const stored = ["a", "b"];
    const { answerColumns, newKeys } = collectNewAnswerKeys(stored, [
      { a: 1 },
      null,
      undefined,
    ]);
    expect(answerColumns).toEqual(["a", "b"]);
    expect(newKeys).toEqual([]);
  });

  it("new answer cells land before the trailing Run ID (never after it)", () => {
    const stored = ["a"];
    const { answerColumns } = collectNewAnswerKeys(stored, [{ a: 1, b: 2 }]);
    for (const schemaVersion of [2, 3]) {
      const header = buildIncompleteHeader(schemaVersion, answerColumns);
      expect(header[header.length - 1]).toBe(INCOMPLETE_RUN_ID_HEADER);
      expect(header).toContain("b");
      expect(header.indexOf("b")).toBeLessThan(
        header.indexOf(INCOMPLETE_RUN_ID_HEADER),
      );
    }
  });
});

describe("new-sheet creation vs relink preservation", () => {
  it("brand-new spreadsheets adopt the current (V3) version", () => {
    expect(resolveFreshLinkSchemaVersion(null, "new-id")).toBe(3);
    expect(resolveFreshLinkSchemaVersion(undefined, "new-id")).toBe(3);
  });

  it("linking a different spreadsheet resets to V3 even with history", () => {
    expect(
      resolveFreshLinkSchemaVersion(
        { spreadsheet_id: "old", header_written: true, schema_version: 1 },
        "new-id",
      ),
    ).toBe(3);
  });

  it("relinking the same spreadsheet preserves its stored version", () => {
    expect(
      resolveFreshLinkSchemaVersion(
        { spreadsheet_id: "same", header_written: true, schema_version: 1 },
        "same",
      ),
    ).toBe(1);
    expect(
      resolveFreshLinkSchemaVersion(
        { spreadsheet_id: "same", header_written: true, schema_version: 2 },
        "same",
      ),
    ).toBe(2);
    expect(
      resolveFreshLinkSchemaVersion(
        { spreadsheet_id: "same", header_written: true, schema_version: 3 },
        "same",
      ),
    ).toBe(3);
  });

  it("same spreadsheet without a written header still adopts V3", () => {
    expect(
      resolveFreshLinkSchemaVersion(
        { spreadsheet_id: "same", header_written: false, schema_version: 2 },
        "same",
      ),
    ).toBe(3);
  });
});

describe("V4 incomplete layout (no fixed contact Name)", () => {
  function incompleteV4(
    overrides: Partial<IncompleteLayoutInput> = {},
  ): IncompleteLayoutInput {
    return {
      schemaVersion: 4,
      contactName: "WA Profile Name",
      contactPhone: "+911234567890",
      flowName: "Welcome Flow",
      submissionTime: "2:25 PM, 14 Jul 2026",
      contactId: "contact-uuid-1",
      vars: { name: "Asha", rooms: "2" },
      answerColumns: ["name", "rooms"],
      runId: "run-uuid-9",
      ...overrides,
    };
  }

  it("declares version 5 as the current incomplete version", () => {
    expect(CURRENT_INCOMPLETE_SCHEMA_VERSION).toBe(5);
  });

  it("headers are Phone | Time | answers | Flow Run ID (no leading Name)", () => {
    expect(buildIncompleteHeader(4, ["name", "rooms"])).toEqual([
      "Phone Number",
      "Submission Time",
      "name",
      "rooms",
      "Flow Run ID",
    ]);
  });

  it("rows match the header exactly with no contact-Name cell", () => {
    const header = buildIncompleteHeader(4, ["name", "rooms"]);
    const row = buildIncompleteRow(incompleteV4());
    expect(row).toEqual([
      "+911234567890",
      "2:25 PM, 14 Jul 2026",
      "Asha",
      "2",
      "run-uuid-9",
    ]);
    expect(row).toHaveLength(header.length);
  });

  it("flow-collected Name remains as a normal answer column", () => {
    const header = buildIncompleteHeader(4, ["name", "rooms"]);
    expect(header).toContain("name");
    const row = buildIncompleteRow(incompleteV4()).map(String);
    expect(row).toContain("Asha");
    expect(row).not.toContain("WA Profile Name");
    expect(row).not.toContain("Welcome Flow");
    expect(row).not.toContain("contact-uuid-1");
  });

  it("V2/V3 incomplete layouts keep their frozen leading Name", () => {
    expect(buildIncompleteHeader(2, ["a"])[0]).toBe("Name");
    expect(buildIncompleteHeader(3, ["a"])[0]).toBe("Name");
    expect(buildIncompleteHeader(null, ["a"])[0]).toBe("Name");
    expect(
      buildIncompleteRow({
        ...incompleteV4(),
        schemaVersion: 2,
        answerColumns: ["a"],
        vars: { a: "x" },
      })[0],
    ).toBe("WA Profile Name");
  });

  it("V4 offsets drop the Name cell; V2/V3 offsets unchanged", () => {
    expect(incompleteBaseOffset(4)).toBe(2);
    expect(incompleteBaseOffset(3)).toBe(3);
    expect(incompleteBaseOffset(2)).toBe(5);
    expect(incompleteRunIdColumnIndex(4, ["a", "b"])).toBe(4);
    const header = buildIncompleteHeader(4, ["a", "b"]);
    expect(incompleteRunIdColumnIndex(4, ["a", "b"])).toBe(header.length - 1);
    expect(header[header.length - 1]).toBe(INCOMPLETE_RUN_ID_HEADER);
  });

  it("completed builder maps v4 input onto the unchanged V3 layout", () => {
    const v3 = completedInput({ schemaVersion: 3 });
    const v4 = completedInput({ schemaVersion: 4 });
    expect(buildCompletedHeader(v4)).toEqual(buildCompletedHeader(v3));
    expect(buildCompletedRow(v4)).toEqual(buildCompletedRow(v3));
  });
});

describe("sheet_include partitioning (incomplete-sheets contract)", () => {
  const nodes = [
    {
      node_key: "name",
      node_type: "collect_input",
      config: { var_key: "name", prompt_text: "Your name?" },
    },
    {
      node_key: "rooms",
      node_type: "collect_input",
      config: { var_key: "rooms", prompt_text: "Rooms?" },
    },
    {
      node_key: "send_buttons",
      node_type: "send_buttons",
      config: { text: "Pick", sheet_include: false },
    },
    {
      node_key: "send_buttons_4",
      node_type: "send_buttons",
      config: { text: "Pick again", sheet_include: false },
    },
    {
      node_key: "menu",
      node_type: "send_list",
      config: { text: "Menu", sheet_include: false },
    },
    {
      node_key: "color",
      node_type: "send_buttons",
      config: { text: "Color?" },
    },
  ];

  it("disabled collect/buttons/list keys land in disabledKeys only", () => {
    const { includedKeys, disabledKeys } = partitionSheetKeys(nodes);
    expect([...disabledKeys].sort()).toEqual([
      "menu",
      "send_buttons",
      "send_buttons_4",
    ]);
    expect(includedKeys.has("name")).toBe(true);
    expect(includedKeys.has("rooms")).toBe(true);
    expect(includedKeys.has("color")).toBe(true);
    expect(includedKeys.has("send_buttons")).toBe(false);
  });

  it("enabled send_buttons/send_list stay included", () => {
    const { disabledKeys } = partitionSheetKeys([
      {
        node_key: "color",
        node_type: "send_buttons",
        config: { text: "Color?" },
      },
    ]);
    expect(disabledKeys.size).toBe(0);
  });

  it("same key: disabled earlier + enabled later → enabled claims it", () => {
    const { includedKeys, disabledKeys } = partitionSheetKeys([
      {
        node_key: "pick",
        node_type: "send_buttons",
        config: { text: "A", sheet_include: false },
      },
      {
        node_key: "pick",
        node_type: "send_buttons",
        config: { text: "B" },
      },
    ]);
    expect(includedKeys.has("pick")).toBe(true);
    expect(disabledKeys.has("pick")).toBe(false);
  });

  it("same key: enabled earlier + disabled later → stays included", () => {
    const { includedKeys, disabledKeys } = partitionSheetKeys([
      {
        node_key: "pick",
        node_type: "send_buttons",
        config: { text: "A" },
      },
      {
        node_key: "pick",
        node_type: "send_buttons",
        config: { text: "B", sheet_include: false },
      },
    ]);
    expect(includedKeys.has("pick")).toBe(true);
    expect(disabledKeys.has("pick")).toBe(false);
  });

  it("non-question nodes never contribute keys", () => {
    const { includedKeys, disabledKeys } = partitionSheetKeys([
      { node_key: "end", node_type: "end", config: {} },
      {
        node_key: "start",
        node_type: "start",
        config: { sheet_include: false },
      },
    ]);
    expect(includedKeys.size).toBe(0);
    expect(disabledKeys.size).toBe(0);
  });

  it("stored disabled columns keep position but write blank", () => {
    const answerColumns = ["name", "send_buttons", "rooms"];
    const header = buildIncompleteHeader(4, answerColumns);
    expect(header).toEqual([
      "Phone Number",
      "Submission Time",
      "name",
      "send_buttons",
      "rooms",
      "Flow Run ID",
    ]);
    const row = buildIncompleteRow({
      schemaVersion: 4,
      contactName: "WA",
      contactPhone: "p",
      flowName: "f",
      submissionTime: "t",
      contactId: "c",
      vars: { name: "Asha", send_buttons: "Yes", rooms: "2" },
      answerColumns,
      runId: "run-1",
      inactiveKeys: new Set(["send_buttons"]),
    });
    expect(row).toHaveLength(header.length);
    // send_buttons keeps index 3 but goes blank; neighbors untouched.
    expect(row[3]).toBe("");
    expect(row[2]).toBe("Asha");
    expect(row[4]).toBe("2");
  });

  it("unknown keys (deleted nodes) are never blanked", () => {
    const row = buildIncompleteRow({
      schemaVersion: 2,
      contactName: "WA",
      contactPhone: "p",
      flowName: "f",
      submissionTime: "t",
      contactId: "c",
      vars: { ghost: "kept" },
      answerColumns: ["ghost"],
      runId: "run-1",
      inactiveKeys: new Set(["send_buttons"]),
    });
    expect(row).toContain("kept");
  });

  it("new disabled keys are filtered before persisting answer columns", () => {
    const stored = ["name"];
    const { answerColumns: healed, newKeys: rawNew } = collectNewAnswerKeys(
      stored,
      [{ name: "A", send_buttons: "Yes", rooms: "2" }],
    );
    expect(healed).toEqual(["name", "send_buttons", "rooms"]);
    const { disabledKeys } = partitionSheetKeys(nodes);
    const newKeys = rawNew.filter((k) => !disabledKeys.has(k));
    expect(newKeys).toEqual(["rooms"]);
    expect([...stored, ...newKeys]).toEqual(["name", "rooms"]);
  });
});

describe("V5 incomplete layout (WhatsApp Name leading)", () => {
  function incompleteV5(
    overrides: Partial<IncompleteLayoutInput> = {},
  ): IncompleteLayoutInput {
    return {
      schemaVersion: 5,
      contactName: "WA Profile",
      contactPhone: "+91",
      flowName: "F",
      submissionTime: "t",
      contactId: "c-1",
      vars: { name: "Asha", rooms: "2" },
      answerColumns: ["name", "rooms"],
      runId: "run-1",
      ...overrides,
    };
  }

  it("headers are WhatsApp Name | Phone | Time | answers | Flow Run ID", () => {
    expect(WHATSAPP_NAME_HEADER).toBe("WhatsApp Name");
    expect(incompleteLeadingHeader(5)).toBe("WhatsApp Name");
    expect(incompleteLeadingHeader(4)).toBeNull();
    expect(incompleteLeadingHeader(3)).toBe("Name");
    expect(incompleteLeadingHeader(2)).toBe("Name");
    expect(
      buildIncompleteHeader(5, ["name", "rooms"], ["Name", "Rooms?"]),
    ).toEqual([
      "WhatsApp Name",
      "Phone Number",
      "Submission Time",
      "Name",
      "Rooms?",
      "Flow Run ID",
    ]);
  });

  it("rows carry the contact value first and match header width", () => {
    const header = buildIncompleteHeader(5, ["name"], ["Name"]);
    const row = buildIncompleteRow(incompleteV5({ answerColumns: ["name"] }));
    expect(row[0]).toBe("WA Profile");
    expect(row).toHaveLength(header.length);
    expect(row.slice(1)).toEqual(["+91", "t", "Asha", "run-1"]);
  });

  it("flow-collected Name stays a normal answer column", () => {
    const row = buildIncompleteRow(incompleteV5()).map(String);
    expect(row).toContain("Asha");
    expect(row.filter((c) => c === "WA Profile")).toHaveLength(1);
  });

  it("V2/V3/V4 leading labels are frozen", () => {
    expect(buildIncompleteHeader(2, [])[0]).toBe("Name");
    expect(buildIncompleteHeader(3, [])[0]).toBe("Name");
    expect(buildIncompleteHeader(4, [])).toEqual([
      "Phone Number",
      "Submission Time",
      "Flow Run ID",
    ]);
  });

  it("answer labels default to raw keys (legacy) unless mapped", () => {
    expect(buildIncompleteHeader(5, ["send_buttons"])).toEqual([
      "WhatsApp Name",
      "Phone Number",
      "Submission Time",
      "send_buttons",
      "Flow Run ID",
    ]);
  });

  it("Run ID stays last with V5 offsets", () => {
    expect(incompleteBaseOffset(5)).toBe(3);
    expect(incompleteRunIdColumnIndex(5, ["a", "b"])).toBe(5);
  });
});
