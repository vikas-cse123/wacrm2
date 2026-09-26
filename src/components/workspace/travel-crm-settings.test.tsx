import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";

import { TravelCrmSettings } from "./travel-crm-settings";

describe("TravelCrmSettings", () => {
  it("renders the settings button for a selected flow", () => {
    const html = renderToStaticMarkup(
      <TravelCrmSettings flowId="flow-1" flowName="Kashmir Honeymoon" />,
    );
    expect(html).toContain("Travel CRM Settings");
    // Closed dialog renders no settings content yet.
    expect(html).not.toContain("Default Services");
  });

  it("disables the trigger without a selected flow", () => {
    const html = renderToStaticMarkup(
      <TravelCrmSettings flowId={null} flowName="Workspace" />,
    );
    expect(html).toContain("Travel CRM Settings");
    expect(html).toContain("disabled");
  });
});

describe("Workspace page wiring", () => {
  const page = readFileSync(
    `${process.cwd()}/src/app/(dashboard)/workspace/page.tsx`,
    "utf8",
  );

  it("mounts per-flow settings beside the table controls", () => {
    expect(page).toContain("TravelCrmSettings");
    expect(page).toContain("flowName={flowDisplayName(activeFlowName)}");
    // Remount per flow so switching flows reloads configuration.
    expect(page).toContain("key={flowId ?? 'no-flow'}");
  });
});
