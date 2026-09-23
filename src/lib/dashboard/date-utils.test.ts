import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DOW_SHORT_MON_FIRST,
  daysAgoStart,
  getDashboardRange,
  lastNDayKeys,
  localDayKey,
  mondayIndex,
  startOfLocalDay,
} from "./date-utils";

describe("startOfLocalDay", () => {
  it("zeroes out the time of a given date", () => {
    const d = new Date("2026-05-18T13:45:22.500");
    const out = startOfLocalDay(d);
    expect(out.getHours()).toBe(0);
    expect(out.getMinutes()).toBe(0);
    expect(out.getSeconds()).toBe(0);
    expect(out.getMilliseconds()).toBe(0);
    expect(out.getFullYear()).toBe(d.getFullYear());
    expect(out.getMonth()).toBe(d.getMonth());
    expect(out.getDate()).toBe(d.getDate());
  });

  it("does not mutate the input", () => {
    const d = new Date("2026-05-18T13:45:22.500");
    const before = d.getTime();
    startOfLocalDay(d);
    expect(d.getTime()).toBe(before);
  });
});

describe("daysAgoStart", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-18T13:45:22"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns midnight N days before today", () => {
    const out = daysAgoStart(3);
    expect(out.getHours()).toBe(0);
    expect(out.getDate()).toBe(15);
    expect(out.getMonth()).toBe(4); // May
    expect(out.getFullYear()).toBe(2026);
  });

  it("daysAgoStart(0) is today at midnight", () => {
    const out = daysAgoStart(0);
    expect(out.getDate()).toBe(18);
    expect(out.getHours()).toBe(0);
  });

  it("crosses month boundaries cleanly", () => {
    vi.setSystemTime(new Date("2026-05-02T08:00:00"));
    const out = daysAgoStart(5);
    expect(out.getMonth()).toBe(3); // April (0-indexed)
    expect(out.getDate()).toBe(27);
  });
});

describe("localDayKey", () => {
  it("emits YYYY-MM-DD in local components", () => {
    const d = new Date(2026, 0, 9, 23, 59); // Jan 9, locally
    expect(localDayKey(d)).toBe("2026-01-09");
  });

  it("zero-pads month and day", () => {
    const d = new Date(2026, 8, 5); // Sep 5
    expect(localDayKey(d)).toBe("2026-09-05");
  });

  it("accepts ISO strings as input", () => {
    expect(localDayKey("2026-12-31T23:00:00")).toBe("2026-12-31");
  });
});

describe("lastNDayKeys", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-18T08:30:00"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns n consecutive chronological keys ending today", () => {
    expect(lastNDayKeys(3)).toEqual(["2026-05-16", "2026-05-17", "2026-05-18"]);
  });

  it("returns just today for n=1", () => {
    expect(lastNDayKeys(1)).toEqual(["2026-05-18"]);
  });

  it("rolls back across a month boundary", () => {
    vi.setSystemTime(new Date("2026-05-02T08:00:00"));
    expect(lastNDayKeys(4)).toEqual([
      "2026-04-29",
      "2026-04-30",
      "2026-05-01",
      "2026-05-02",
    ]);
  });
});

describe("mondayIndex", () => {
  it("maps Monday → 0 and Sunday → 6", () => {
    expect(mondayIndex(new Date("2026-05-18"))).toBe(0); // Mon
    expect(mondayIndex(new Date("2026-05-19"))).toBe(1); // Tue
    expect(mondayIndex(new Date("2026-05-23"))).toBe(5); // Sat
    expect(mondayIndex(new Date("2026-05-24"))).toBe(6); // Sun
  });

  it("aligns with DOW_SHORT_MON_FIRST labels", () => {
    expect(DOW_SHORT_MON_FIRST[mondayIndex(new Date("2026-05-18"))]).toBe(
      "Mon",
    );
    expect(DOW_SHORT_MON_FIRST[mondayIndex(new Date("2026-05-24"))]).toBe(
      "Sun",
    );
  });
});

describe("getDashboardRange", () => {
  const NOW = new Date("2026-09-22T10:00:00");

  it("covers today with yesterday as previous", () => {
    const r = getDashboardRange("today", NOW);
    expect(localDayKey(r.start)).toBe("2026-09-22");
    expect(localDayKey(r.end)).toBe("2026-09-23");
    expect(r.label).toBe("Today");
  });

  it("covers yesterday", () => {
    const r = getDashboardRange("yesterday", NOW);
    expect(localDayKey(r.start)).toBe("2026-09-21");
    expect(localDayKey(r.end)).toBe("2026-09-22");
    expect(r.label).toBe("Yesterday");
  });

  it("covers the Monday-start week", () => {
    const r = getDashboardRange("week", NOW);
    expect(localDayKey(r.start)).toBe("2026-09-21");
    expect(r.label).toBe("This week");
  });

  it("covers the calendar month", () => {
    const r = getDashboardRange("month", NOW);
    expect(localDayKey(r.start)).toBe("2026-09-01");
    expect(r.label).toBe("This month");
  });

  it("covers the trailing 30 days including today", () => {
    const r = getDashboardRange("last30days", NOW);
    expect(localDayKey(r.start)).toBe("2026-08-24");
    expect(localDayKey(r.end)).toBe("2026-09-23");
    expect(r.label).toBe("Last 30 days");
    const spanDays = Math.round(
      (r.end.getTime() - r.start.getTime()) / 86_400_000,
    );
    expect(spanDays).toBe(30);
  });

  it("honors an explicit custom range", () => {
    const r = getDashboardRange("custom", NOW, "2026-09-01", "2026-09-10");
    expect(localDayKey(r.start)).toBe("2026-09-01");
    expect(localDayKey(r.end)).toBe("2026-09-11");
  });
});
