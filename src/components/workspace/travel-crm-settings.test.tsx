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

describe("Itinerary Defaults display names — never raw UUIDs", () => {
  it("renders the resolved destination/city label as SelectValue children", () => {
    const src = readFileSync(
      `${process.cwd()}/src/components/workspace/travel-crm-settings.tsx`,
      "utf8",
    );
    // Explicit ID → name resolution, stored UUIDs stay the Select value.
    expect(src).toContain("destinationLabelForValue(destinations, row.destination)");
    expect(src).toContain("cityLabelForValue(cityOptions, row.city)");
    expect(src).toContain("destinationLabel !== null ? destinationLabel : undefined");
    expect(src).toContain("cityLabel !== null ? cityLabel : undefined");
    // The stored UUID still travels as the option value (never the name).
    expect(src).toContain("resolveSelectValue(destinations, row.destination)");
  });
});
