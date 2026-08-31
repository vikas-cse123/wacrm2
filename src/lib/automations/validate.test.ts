import { describe, expect, it } from "vitest";
import {
  validateStepsForActivation,
  validateTriggerForActivation,
} from "./validate";

describe("validateStepsForActivation", () => {
  it("rejects empty or missing step lists", () => {
    expect(validateStepsForActivation([])).toEqual([
      { path: "steps", message: "active automations need at least one step" },
    ]);
    expect(
      validateStepsForActivation(undefined as unknown as never[]),
    ).toEqual([
      { path: "steps", message: "active automations need at least one step" },
    ]);
  });

  it("passes a fully-populated step set", () => {
    const issues = validateStepsForActivation([
      { step_type: "send_message", step_config: { text: "hi" } },
      {
        step_type: "wait",
        step_config: { amount: 5, unit: "minutes" },
      },
      { step_type: "add_tag", step_config: { tag_id: "tag-uuid" } },
      { step_type: "close_conversation", step_config: {} },
    ]);
    expect(issues).toEqual([]);
  });

  it("accepts a fully-configured send_media step", () => {
    const issues = validateStepsForActivation([
      {
        step_type: "send_media",
        step_config: {
          media_type: "document",
          media_url: "https://x.supabase.co/storage/v1/object/public/flow-media/account-acct-1/invoice.pdf",
          caption: "Invoice",
          filename: "invoice.pdf",
        },
      },
    ]);
    expect(issues).toEqual([]);
  });

  it("flags send_media when media_type or media_url is missing", () => {
    const issues = validateStepsForActivation([
      { step_type: "send_media", step_config: { media_type: "", media_url: "" } },
      { step_type: "send_media", step_config: { media_type: "audio", media_url: "x" } },
    ]);
    expect(issues.map((i) => i.path)).toEqual([
      "steps[0].media_type",
      "steps[0].media_url",
      "steps[1].media_type",
    ]);
  });

  it("accepts a fully-configured rotate send_media step", () => {
    const issues = validateStepsForActivation([
      {
        step_type: "send_media",
        step_config: {
          selection_mode: "rotate",
          rotation_key: "rk-1",
          messages: [
            { media_type: "image", media_url: "https://x.example/a.png" },
            { media_type: "document", media_url: "https://x.example/b.pdf", caption: "B" },
          ],
        },
      },
    ]);
    expect(issues).toEqual([]);
  });

  it("flags rotate send_media with fewer than 2 messages", () => {
    const issues = validateStepsForActivation([
      {
        step_type: "send_media",
        step_config: {
          selection_mode: "rotate",
          messages: [{ media_type: "image", media_url: "https://x.example/a.png" }],
        },
      },
      { step_type: "send_media", step_config: { selection_mode: "rotate", messages: [] } },
    ]);
    expect(issues.map((i) => i.path)).toEqual([
      "steps[0].messages",
      "steps[1].messages",
    ]);
  });

  it("flags a rotate entry missing its media file or type", () => {
    const issues = validateStepsForActivation([
      {
        step_type: "send_media",
        step_config: {
          selection_mode: "rotate",
          messages: [
            { media_type: "image", media_url: "https://x.example/a.png" },
            { media_type: "", media_url: "" },
          ],
        },
      },
    ]);
    expect(issues.map((i) => i.path)).toEqual([
      "steps[0].messages[1].media_type",
      "steps[0].messages[1].media_url",
    ]);
  });

  it("treats a legacy send_media without selection_mode as fixed (backward compatible)", () => {
    const issues = validateStepsForActivation([
      {
        step_type: "send_media",
        step_config: { media_type: "image", media_url: "https://x.example/a.png" },
      },
    ]);
    expect(issues).toEqual([]);
  });

  it("accepts explicit fixed mode with no messages array", () => {
    const issues = validateStepsForActivation([
      {
        step_type: "send_media",
        step_config: {
          selection_mode: "fixed",
          media_type: "image",
          media_url: "https://x.example/a.png",
        },
      },
    ]);
    expect(issues).toEqual([]);
  });

  it("accepts fixed mode with a stale 1-message array (builder keeps it on toggle back)", () => {
    const issues = validateStepsForActivation([
      {
        step_type: "send_media",
        step_config: {
          selection_mode: "fixed",
          media_type: "image",
          media_url: "https://x.example/a.png",
          messages: [{ media_type: "image", media_url: "" }],
        },
      },
    ]);
    expect(issues).toEqual([]);
  });

  it("accepts fixed mode with a stale multi-message array", () => {
    const issues = validateStepsForActivation([
      {
        step_type: "send_media",
        step_config: {
          selection_mode: "fixed",
          media_type: "image",
          media_url: "https://x.example/a.png",
          messages: [
            { media_type: "image", media_url: "https://x.example/a.png" },
            { media_type: "", media_url: "" },
            { media_type: "video", media_url: "" },
          ],
        },
      },
    ]);
    expect(issues).toEqual([]);
  });

  it("flags every required field that is missing", () => {
    const issues = validateStepsForActivation([
      { step_type: "send_message", step_config: { text: "  " } },
      { step_type: "send_template", step_config: {} },
      { step_type: "add_tag", step_config: { tag_id: "" } },
    ]);
    expect(issues.map((i) => i.path)).toEqual([
      "steps[0].text",
      "steps[1].template_name",
      "steps[2].tag_id",
    ]);
  });

  it("checks wait amount and unit boundaries", () => {
    const issues = validateStepsForActivation([
      { step_type: "wait", step_config: { amount: 0, unit: "minutes" } },
      { step_type: "wait", step_config: { amount: 5, unit: "seconds" } },
      { step_type: "wait", step_config: { amount: -1, unit: "hours" } },
      {
        step_type: "wait",
        step_config: { amount: Number.POSITIVE_INFINITY, unit: "days" },
      },
    ]);
    expect(issues.map((i) => i.path)).toEqual([
      "steps[0].amount",
      "steps[1].unit",
      "steps[2].amount",
      "steps[3].amount",
    ]);
  });

  it("validates webhook URLs", () => {
    const good = validateStepsForActivation([
      {
        step_type: "send_webhook",
        step_config: { url: "https://hooks.example.com/in" },
      },
    ]);
    expect(good).toEqual([]);

    const noUrl = validateStepsForActivation([
      { step_type: "send_webhook", step_config: {} },
    ]);
    expect(noUrl.map((i) => i.message)).toContain("webhook URL is required");

    const wrongProtocol = validateStepsForActivation([
      {
        step_type: "send_webhook",
        step_config: { url: "ftp://files.example.com" },
      },
    ]);
    expect(wrongProtocol.map((i) => i.message)).toContain(
      "webhook URL must use http or https",
    );

    const garbage = validateStepsForActivation([
      { step_type: "send_webhook", step_config: { url: "not a url" } },
    ]);
    expect(garbage.map((i) => i.message)).toContain(
      "webhook URL is not a valid URL",
    );
  });

  it("validates assign_conversation only when mode is 'specific'", () => {
    const roundRobinNoAgent = validateStepsForActivation([
      {
        step_type: "assign_conversation",
        step_config: { mode: "round_robin" },
      },
    ]);
    expect(roundRobinNoAgent).toEqual([]);

    const specificMissingAgent = validateStepsForActivation([
      { step_type: "assign_conversation", step_config: { mode: "specific" } },
    ]);
    expect(specificMissingAgent.map((i) => i.path)).toEqual([
      "steps[0].agent_id",
    ]);
  });

  it("flags create_deal when required fields are missing", () => {
    const issues = validateStepsForActivation([
      { step_type: "create_deal", step_config: {} },
    ]);
    expect(issues.map((i) => i.path).sort()).toEqual([
      "steps[0].pipeline_id",
      "steps[0].stage_id",
      "steps[0].title",
    ]);
  });

  it("flags update_contact_field when field or value is missing", () => {
    const issues = validateStepsForActivation([
      { step_type: "update_contact_field", step_config: { field: "name" } },
      {
        step_type: "update_contact_field",
        step_config: { field: "", value: "x" },
      },
    ]);
    expect(issues.map((i) => i.path)).toEqual([
      "steps[0].value",
      "steps[1].field",
    ]);
  });

  it("recursively walks condition branches with stable dot-paths", () => {
    const issues = validateStepsForActivation([
      {
        step_type: "condition",
        step_config: { subject: "tag", operand: "vip" },
        branches: {
          yes: [{ step_type: "add_tag", step_config: { tag_id: "" } }],
          no: [
            {
              step_type: "send_message",
              step_config: { text: "" },
            },
          ],
        },
      },
    ]);
    expect(issues.map((i) => i.path)).toEqual([
      "steps[0].yes.steps[0].tag_id",
      "steps[0].no.steps[0].text",
    ]);
  });

  it("reports an issue for unknown step types", () => {
    const issues = validateStepsForActivation([
      { step_type: "do_a_barrel_roll", step_config: {} },
    ]);
    expect(issues).toEqual([
      { path: "steps[0]", message: "unknown step type: do_a_barrel_roll" },
    ]);
  });

  it("flags condition subject/operand independently", () => {
    const issues = validateStepsForActivation([
      { step_type: "condition", step_config: {} },
    ]);
    expect(issues.map((i) => i.path).sort()).toEqual([
      "steps[0].operand",
      "steps[0].subject",
    ]);
  });
});

describe("validateTriggerForActivation", () => {
  it("accepts a valid keyword_match config", () => {
    expect(
      validateTriggerForActivation("keyword_match", {
        keywords: ["hello", "hi"],
        match_type: "exact",
      }),
    ).toEqual([]);
  });

  it("rejects keyword_match with empty keyword array", () => {
    const issues = validateTriggerForActivation("keyword_match", {
      keywords: [],
      match_type: "exact",
    });
    expect(issues.map((i) => i.path)).toContain("trigger.keywords");
  });

  it("rejects keyword_match with whitespace-only entries", () => {
    const issues = validateTriggerForActivation("keyword_match", {
      keywords: ["hi", "   "],
      match_type: "contains",
    });
    expect(issues.map((i) => i.message)).toContain(
      "keywords cannot be empty strings",
    );
  });

  it("rejects keyword_match with an unknown match_type", () => {
    const issues = validateTriggerForActivation("keyword_match", {
      keywords: ["hi"],
      match_type: "fuzzy",
    });
    expect(issues.map((i) => i.path)).toContain("trigger.match_type");
  });

  it("accepts keyword_match with a missing match_type (defaults to contains)", () => {
    expect(
      validateTriggerForActivation("keyword_match", { keywords: ["hi"] }),
    ).toEqual([]);
  });

  it("requires schedule on time_based triggers", () => {
    expect(validateTriggerForActivation("time_based", {})).toEqual([
      { path: "trigger.schedule", message: "schedule is required" },
    ]);
    expect(
      validateTriggerForActivation("time_based", { schedule: "0 9 * * *" }),
    ).toEqual([]);
  });

  it("requires tag_id on tag_added triggers", () => {
    expect(validateTriggerForActivation("tag_added", {})).toEqual([
      { path: "trigger.tag_id", message: "tag is required" },
    ]);
    expect(
      validateTriggerForActivation("tag_added", { tag_id: "tag-uuid" }),
    ).toEqual([]);
  });

  it("does not flag unknown trigger types (handled elsewhere)", () => {
    expect(validateTriggerForActivation("some_future_trigger", {})).toEqual([]);
  });
});
