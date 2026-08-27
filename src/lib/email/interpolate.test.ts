import { describe, expect, it } from "vitest";

import { interpolateEmail } from "./interpolate";

const CTX = {
  vars: { name: "Priya", email: "priya@example.com", answer: "pricing" },
  contact: {
    name: "Priya Sharma",
    email: "priya@example.com",
    phone: "+919876543210",
    company: "Acme",
  },
  flowName: "New Lead Intake",
};

describe("interpolateEmail", () => {
  it("passes plain text through untouched", () => {
    expect(interpolateEmail("hello", CTX)).toBe("hello");
    expect(interpolateEmail("", CTX)).toBe("");
  });

  it("interpolates {{vars.*}} from the snapshot", () => {
    expect(interpolateEmail("Hi {{vars.name}}", CTX)).toBe("Hi Priya");
    expect(interpolateEmail("Stage: {{vars.answer}}", CTX)).toBe(
      "Stage: pricing",
    );
  });

  it("interpolates {{contact.*}} fields", () => {
    expect(interpolateEmail("{{contact.name}}", CTX)).toBe("Priya Sharma");
    expect(interpolateEmail("{{contact.email}}", CTX)).toBe(
      "priya@example.com",
    );
    expect(interpolateEmail("{{contact.phone}}", CTX)).toBe("+919876543210");
    expect(interpolateEmail("{{contact.company}}", CTX)).toBe("Acme");
  });

  it("interpolates {{flow.name}}", () => {
    expect(interpolateEmail("Flow: {{flow.name}}", CTX)).toBe(
      "Flow: New Lead Intake",
    );
  });

  it("renders missing vars and fields as empty strings", () => {
    expect(interpolateEmail("{{vars.nope}}", CTX)).toBe("");
    expect(interpolateEmail("{{contact.title}}", CTX)).toBe("");
    expect(interpolateEmail("{{unknown.foo}}", CTX)).toBe("");
    expect(interpolateEmail("{{flow}}", CTX)).toBe("");
  });

  it("handles null contact / flow context", () => {
    expect(
      interpolateEmail("{{contact.name}} / {{flow.name}}", {
        vars: {},
        contact: null,
        flowName: null,
      }),
    ).toBe(" / ");
  });

  it("tolerates whitespace inside braces", () => {
    expect(interpolateEmail("{{ vars.name }}", CTX)).toBe("Priya");
  });

  it("matches a realistic notification body", () => {
    const body = [
      "New lead has reached the pricing stage.",
      "",
      "Name: {{contact.name}}",
      "Phone: {{contact.phone}}",
      "Flow: {{flow.name}}",
      "Answer: {{vars.answer}}",
    ].join("\n");
    const out = interpolateEmail(body, CTX);
    expect(out).toContain("Name: Priya Sharma");
    expect(out).toContain("Phone: +919876543210");
    expect(out).toContain("Flow: New Lead Intake");
    expect(out).toContain("Answer: pricing");
  });
});