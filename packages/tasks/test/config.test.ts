import { describe, expect, it } from "vitest";

import { parseConfig } from "../src/core/config.js";
import { isTaskError } from "../src/errors.js";

describe("config", () => {
  it("defaults statuses and derives roles from list position", () => {
    const config = parseConfig("");
    expect(config.statuses).toEqual(["PENDING", "IN_PROGRESS", "DONE"]);
    expect(config.roles).toEqual({
      ready: "PENDING",
      claimed: "IN_PROGRESS",
      done: "DONE",
    });
  });

  it("derives roles positionally for a fully renamed status set", () => {
    const config = parseConfig(`
statuses: [TODO, DOING, REVIEW, SHIPPED]
`);
    expect(config.roles).toEqual({ ready: "TODO", claimed: "DOING", done: "SHIPPED" });
  });

  it("allows explicit role overrides", () => {
    const config = parseConfig(`
statuses: [TODO, DOING, REVIEW, SHIPPED]
roles:
  done: REVIEW
`);
    expect(config.roles.done).toBe("REVIEW");
    expect(config.roles.ready).toBe("TODO");
  });

  describe("default transition rule", () => {
    const config = parseConfig("");

    it("permits stepping forward one status", () => {
      expect(config.canTransition("PENDING", "IN_PROGRESS")).toBe(true);
      expect(config.canTransition("IN_PROGRESS", "DONE")).toBe(true);
    });

    it("permits stepping back one status, including out of the last one", () => {
      expect(config.canTransition("IN_PROGRESS", "PENDING")).toBe(true);
      expect(config.canTransition("DONE", "IN_PROGRESS")).toBe(true);
    });

    it("refuses to skip forward", () => {
      expect(config.canTransition("PENDING", "DONE")).toBe(false);
    });

    it("refuses to skip backward", () => {
      expect(config.canTransition("DONE", "PENDING")).toBe(false);
    });

    it("refuses a no-op transition", () => {
      expect(config.canTransition("DONE", "DONE")).toBe(false);
    });
  });

  it("lets an explicit transitions list fully replace the default rule", () => {
    const config = parseConfig(`
transitions:
  - [PENDING, IN_PROGRESS]
  - [IN_PROGRESS, DONE]
  - [DONE, PENDING]
`);
    expect(config.canTransition("DONE", "PENDING")).toBe(true);
    // Adjacent-but-unlisted is now illegal: the list replaces, not extends.
    expect(config.canTransition("IN_PROGRESS", "PENDING")).toBe(false);
  });

  it("rejects a role naming a status that does not exist", () => {
    expect(() => parseConfig(`roles:\n  done: SHIPPED\n`)).toThrowError(/not in `statuses`/);
  });

  it("rejects transitions referencing an unknown status", () => {
    expect(() => parseConfig(`transitions:\n  - [PENDING, SHIPPED]\n`)).toThrowError(
      /not in `statuses`/,
    );
  });

  it("rejects a config where claim could never succeed", () => {
    // ready -> claimed is not in the explicit transition list.
    expect(() =>
      parseConfig(`
transitions:
  - [IN_PROGRESS, DONE]
`),
    ).toThrowError(/could never succeed/);
  });

  it("rejects unknown top-level keys", () => {
    try {
      parseConfig("nonsense: true\n");
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(isTaskError(err)).toBe(true);
      if (isTaskError(err)) expect(err.exitCode).toBe(2);
    }
  });

  it("does not coerce active_phase that looks like a date", () => {
    const config = parseConfig(`active_phase: "2026-q1"\n`);
    expect(config.activePhase).toBe("2026-q1");
  });
});
