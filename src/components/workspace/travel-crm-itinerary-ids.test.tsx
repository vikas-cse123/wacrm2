// Regression: a stored destination/city ID with no matching lookup
// option (stale or archived master) must render the "Select"
// placeholder — never the raw UUID. Base UI's Select.Value renders
// an unmatched controlled value verbatim, so components pass
// `resolveSelectValue()` output (undefined when unmatched) as the
// Select value. (Note: SSR always shows the raw value even for
// matched IDs — Base UI resolves item labels client-side — so this
// file asserts the fallback path, while label resolution itself is
// covered by destinationLabelForValue/cityLabelForValue unit tests.)

import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { resolveSelectValue } from "@/lib/integrations/travel-crm/itineraries";

const SG_ID = "11111111-2222-3333-4444-555555555555";
const STALE_ID = "99999999-8888-7777-6666-555555555555";
const DESTINATIONS = [{ value: SG_ID, label: "Singapore" }];

function triggerHtml(value: string | undefined) {
  return renderToStaticMarkup(
    <Select value={value} onValueChange={() => {}}>
      <SelectTrigger aria-label="Destination">
        <SelectValue placeholder="Select" />
      </SelectTrigger>
      <SelectContent>
        {DESTINATIONS.map((o) => (
          <SelectItem key={o.value} value={o.value}>
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>,
  );
}

function triggerHtmlWithLabel(value: string | undefined, label: string | undefined) {
  return renderToStaticMarkup(
    <Select value={value} onValueChange={() => {}}>
      <SelectTrigger aria-label="Destination">
        <SelectValue placeholder="Select">{label ?? undefined}</SelectValue>
      </SelectTrigger>
      <SelectContent>
        {DESTINATIONS.map((o) => (
          <SelectItem key={o.value} value={o.value}>
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>,
  );
}

describe("stale itinerary IDs never render raw UUIDs", () => {
  it("7/10. unmatched stored ID resolves to undefined and renders 'Select'", () => {
    const value = resolveSelectValue(DESTINATIONS, STALE_ID);
    expect(value).toBeUndefined();
    const html = triggerHtml(value);
    expect(html).toContain("Select");
    expect(html).not.toContain(STALE_ID);
  });

  it("matched stored ID passes through for client-side label display", () => {
    expect(resolveSelectValue(DESTINATIONS, SG_ID)).toBe(SG_ID);
  });

  it("explicit label children render the name — never the raw UUID (SSR-safe)", () => {
    // Base UI resolves matched item labels client-side only, so SSR can
    // print the raw value. The dialog now resolves ID → label explicitly
    // and passes it as Select.Value children, guaranteeing the human-
    // readable name renders everywhere (SSR, hydration, closed popup).
    const html = triggerHtmlWithLabel(SG_ID, "Singapore");
    expect(html).toContain("Singapore");
    // The stored UUID only survives as the option's value attribute —
    // it is never rendered as the trigger's visible text.
    expect(html).not.toContain(`>${SG_ID}<`);
  });

  it("unmatched stored ID with explicit label children renders the placeholder", () => {
    const html = triggerHtmlWithLabel(undefined, undefined);
    expect(html).toContain("Select");
    expect(html).not.toContain(STALE_ID);
  });
});
