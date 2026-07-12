import { describe, expect, it } from "vitest";

import {
  buttonTitleForReplyId,
  completionTime,
  isRunComplete,
  questionText,
  reconstructRunQA,
  type FlowNodeLite,
  type FlowRunEventLite,
  type FlowRunLite,
} from "./reconstruct";
import type { TrackedFlow } from "./tracked-flows";

const collectNameNode: FlowNodeLite = {
  node_key: "collect_name",
  node_type: "collect_input",
  config: { prompt_text: "What's your name?", var_key: "Name" },
};

const nightsNode: FlowNodeLite = {
  node_key: "send_buttons_6",
  node_type: "send_buttons",
  config: {
    text: "How many nights are you planning to stay?",
    buttons: [
      { reply_id: "opt_4n", title: "4N / 5D", next_node_key: "a" },
      { reply_id: "opt_5n", title: "5N / 6D", next_node_key: "b" },
      { reply_id: "opt_6n", title: "6N / 7D with Cruise", next_node_key: "c" },
    ],
  },
};

const listNode: FlowNodeLite = {
  node_key: "list_1",
  node_type: "send_list",
  config: {
    text: "Pick a city",
    sections: [
      { rows: [{ reply_id: "sg", title: "Singapore", next_node_key: "x" }] },
    ],
  },
};

const nodesByKey = new Map<string, FlowNodeLite>([
  [collectNameNode.node_key, collectNameNode],
  [nightsNode.node_key, nightsNode],
  [listNode.node_key, listNode],
]);

const baseRun: FlowRunLite = {
  id: "run-1",
  flow_id: "flow-1",
  status: "active",
  vars: { Name: "Mikey" },
  started_at: "2026-07-13T10:00:00.000Z",
  ended_at: null,
  current_node_key: "send_buttons_6",
};

describe("questionText", () => {
  it("reads prompt_text for collect_input and text for buttons/list", () => {
    expect(questionText(collectNameNode)).toBe("What's your name?");
    expect(questionText(nightsNode)).toBe(
      "How many nights are you planning to stay?",
    );
    expect(questionText(listNode)).toBe("Pick a city");
  });

  it("returns null for a non-question node", () => {
    expect(
      questionText({ node_key: "m", node_type: "send_message", config: {} }),
    ).toBeNull();
  });
});

describe("buttonTitleForReplyId", () => {
  it("maps a button reply_id to its title", () => {
    expect(buttonTitleForReplyId(nightsNode, "opt_5n")).toBe("5N / 6D");
  });
  it("maps a list row reply_id to its title", () => {
    expect(buttonTitleForReplyId(listNode, "sg")).toBe("Singapore");
  });
  it("returns null for an unknown reply_id", () => {
    expect(buttonTitleForReplyId(nightsNode, "nope")).toBeNull();
  });
});

describe("isRunComplete", () => {
  const tracked: TrackedFlow = {
    flowId: "flow-1",
    completionNodeKey: "send_buttons_6",
  };

  it("is complete when the run reached the completion node (event)", () => {
    const events: FlowRunEventLite[] = [
      {
        event_type: "node_entered",
        node_key: "send_buttons_6",
        payload: {},
        created_at: "2026-07-13T10:01:00.000Z",
      },
    ];
    expect(isRunComplete({ ...baseRun, current_node_key: null }, events, tracked)).toBe(true);
  });

  it("is complete when it is the current node even without an event", () => {
    expect(isRunComplete(baseRun, [], tracked)).toBe(true);
  });

  it("is not complete when the node was never reached", () => {
    const other: FlowRunLite = { ...baseRun, current_node_key: "collect_name" };
    expect(isRunComplete(other, [], tracked)).toBe(false);
  });

  it("falls back to status='completed' when no completion node configured", () => {
    const noNode: TrackedFlow = { flowId: "flow-1" };
    expect(isRunComplete({ ...baseRun, status: "completed" }, [], noNode)).toBe(true);
    expect(isRunComplete({ ...baseRun, status: "active" }, [], noNode)).toBe(false);
  });
});

describe("completionTime", () => {
  it("uses the first node_entered timestamp for a custom completion node", () => {
    const events: FlowRunEventLite[] = [
      {
        event_type: "node_entered",
        node_key: "send_buttons_6",
        payload: {},
        created_at: "2026-07-13T10:05:00.000Z",
      },
    ];
    expect(
      completionTime(baseRun, events, {
        flowId: "flow-1",
        completionNodeKey: "send_buttons_6",
      }),
    ).toBe("2026-07-13T10:05:00.000Z");
  });

  it("uses ended_at when completion is status-based", () => {
    expect(
      completionTime(
        { ...baseRun, ended_at: "2026-07-13T11:00:00.000Z" },
        [],
        { flowId: "flow-1" },
      ),
    ).toBe("2026-07-13T11:00:00.000Z");
  });
});

describe("reconstructRunQA", () => {
  it("pairs each asked question with its answer (button + collected var)", () => {
    const events: FlowRunEventLite[] = [
      {
        event_type: "message_sent",
        node_key: "collect_name",
        payload: {},
        created_at: "2026-07-13T10:00:01.000Z",
      },
      {
        event_type: "reply_received",
        node_key: "collect_name",
        payload: { reply_kind: "text", text_length: 5 },
        created_at: "2026-07-13T10:00:02.000Z",
      },
      {
        event_type: "message_sent",
        node_key: "send_buttons_6",
        payload: {},
        created_at: "2026-07-13T10:00:03.000Z",
      },
      {
        event_type: "reply_received",
        node_key: "send_buttons_6",
        payload: { reply_kind: "interactive_reply", reply_id: "opt_6n" },
        created_at: "2026-07-13T10:00:04.000Z",
      },
    ];

    const qa = reconstructRunQA(baseRun, nodesByKey, events);

    expect(qa.order).toEqual(["collect_name", "send_buttons_6"]);
    expect(qa.byNode.collect_name).toEqual({
      question: "What's your name?",
      answer: "Mikey",
    });
    expect(qa.byNode.send_buttons_6).toEqual({
      question: "How many nights are you planning to stay?",
      answer: "6N / 7D with Cruise",
    });
  });

  it("records an asked-but-unanswered question with a null answer", () => {
    const events: FlowRunEventLite[] = [
      {
        event_type: "message_sent",
        node_key: "send_buttons_6",
        payload: {},
        created_at: "2026-07-13T10:00:03.000Z",
      },
    ];
    const qa = reconstructRunQA(baseRun, nodesByKey, events);
    expect(qa.order).toEqual(["send_buttons_6"]);
    expect(qa.byNode.send_buttons_6.answer).toBeNull();
  });
});
