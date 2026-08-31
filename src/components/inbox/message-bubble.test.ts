import { describe, expect, it } from "vitest";
import type { Message } from "@/types";
import { interactiveRenderKind } from "./message-bubble";

function msg(overrides: Partial<Message>): Message {
  return {
    id: "m1",
    conversation_id: "conv-1",
    sender_type: "customer",
    content_type: "interactive",
    status: "delivered",
    created_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

const BUTTONS = [
  { id: "reply_travel", title: "Travel Agency Owner" },
  { id: "reply_tour", title: "Tour Operator" },
  { id: "reply_cab", title: "Cab services" },
];

describe("interactiveRenderKind", () => {
  it("incoming button reply → inbound-reply (tapped title, interactive_reply_id)", () => {
    const m = msg({
      sender_type: "customer",
      content_text: "Travel Agency Owner",
      interactive_reply_id: "reply_travel",
    });
    expect(interactiveRenderKind(m)).toEqual({
      kind: "inbound-reply",
      buttons: [],
    });
  });

  it("outgoing bot prompt with stored buttons → outgoing-prompt, buttons in order", () => {
    const m = msg({
      sender_type: "bot",
      content_text: "What best describes your business?",
      interactive_buttons: BUTTONS,
    });
    expect(interactiveRenderKind(m)).toEqual({
      kind: "outgoing-prompt",
      buttons: BUTTONS,
    });
  });

  it("outgoing bot prompt with NULL interactive_buttons (historical row) → plain", () => {
    const m = msg({
      sender_type: "bot",
      content_text: "Awesome! Ubaid ✨ What best describes your business?",
      interactive_buttons: undefined,
    });
    expect(interactiveRenderKind(m)).toEqual({
      kind: "plain",
      buttons: [],
    });
  });

  it("outgoing bot prompt with an empty buttons array → plain (safe render)", () => {
    const m = msg({ sender_type: "bot", interactive_buttons: [] });
    expect(interactiveRenderKind(m)).toEqual({ kind: "plain", buttons: [] });
  });

  it("malformed stored entries are filtered out instead of crashing the render", () => {
    const m = msg({
      sender_type: "bot",
      interactive_buttons: [
        { id: "a", title: "Yes" },
        null,
        { id: "b" },
        { title: "No title id" },
        { id: "c", title: 42 as unknown as string },
      ] as Message["interactive_buttons"],
    });
    const r = interactiveRenderKind(m);
    expect(r.kind).toBe("outgoing-prompt");
    expect(r.buttons).toEqual([{ id: "a", title: "Yes" }]);
  });

  it("non-interactive content types → plain (untouched)", () => {
    expect(
      interactiveRenderKind(msg({ content_type: "text", content_text: "hi" })),
    ).toEqual({ kind: "plain", buttons: [] });
  });
});
