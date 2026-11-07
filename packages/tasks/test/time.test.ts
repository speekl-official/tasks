import { describe, expect, it } from "vitest";

import {
  formatIso,
  isIsoTimestamp,
  minutesSince,
  nowIso,
  parseIso,
  parseSince,
} from "../src/core/time.js";
import { isTaskError } from "../src/errors.js";

const NOW = new Date("2026-09-22T12:00:00.750Z");

function usageError(fn: () => unknown): void {
  try {
    fn();
    expect.unreachable("should have thrown");
  } catch (err) {
    expect(isTaskError(err)).toBe(true);
    if (isTaskError(err)) expect(err.exitCode).toBe(2);
  }
}

describe("timestamps", () => {
  it("formats instants at second precision with a Z", () => {
    expect(formatIso(NOW)).toBe("2026-09-22T12:00:00Z");
    expect(nowIso()).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  });

  it("accepts only the canonical form of a real instant", () => {
    expect(isIsoTimestamp("2026-09-21T09:14:00Z")).toBe(true);
    expect(isIsoTimestamp("2028-02-29T23:59:59Z")).toBe(true);
    for (const bad of [
      "2026-09-21",
      "2026-09-21T09:14Z",
      "2026-09-21T09:14:00.000Z",
      "2026-09-21T09:14:00+00:00",
      "2026-09-21t09:14:00z",
      "2026-09-21 09:14:00Z",
      "2026-02-30T00:00:00Z",
      "2026-09-21T24:00:00Z",
      "2026-13-01T00:00:00Z",
      " 2026-09-21T09:14:00Z",
    ]) {
      expect(isIsoTimestamp(bad)).toBe(false);
    }
  });

  it("parses a canonical timestamp and refuses anything else", () => {
    expect(parseIso("2026-09-21T09:14:00Z").toISOString()).toBe(
      "2026-09-21T09:14:00.000Z",
    );
    usageError(() => parseIso("yesterday"));
  });

  it("measures minutes since an instant", () => {
    expect(minutesSince(new Date("2026-09-22T11:30:00.750Z"), NOW)).toBe(30);
    expect(minutesSince(new Date("2026-09-22T12:01:00.750Z"), NOW)).toBe(-1);
  });
});

describe("--since", () => {
  it("passes a timestamp through", () => {
    expect(parseSince("2026-09-21T09:14:00Z", NOW)).toBe(
      "2026-09-21T09:14:00Z",
    );
  });

  it("reads a date as UTC midnight", () => {
    expect(parseSince("2026-09-21", NOW)).toBe("2026-09-21T00:00:00Z");
  });

  it.each([
    ["30m", "2026-09-22T11:30:00Z"],
    ["12h", "2026-09-22T00:00:00Z"],
    ["7d", "2026-09-15T12:00:00Z"],
    ["2w", "2026-09-08T12:00:00Z"],
    ["0m", "2026-09-22T12:00:00Z"],
  ])("reads the duration %s back from now", (arg, expected) => {
    expect(parseSince(arg, NOW)).toBe(expected);
  });

  it.each([
    "",
    "7",
    "7x",
    "-1d",
    "1.5h",
    "d",
    "7D",
    "7 d",
    "2026-02-30",
    "soon",
  ])("refuses %j as a usage error", (arg) => {
    usageError(() => parseSince(arg, NOW));
  });
});
