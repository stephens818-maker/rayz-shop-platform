import { describe, expect, it } from "vitest";
import { bootGate } from "./boot-gate";

describe("app config gate", () => {
  const config = { launched: true, launchAt: "2026-01-01T00:00:00.000Z", minVersion: { ios: "3.0.0" } };

  it("forces an update from minVersion and shows coming soon until launch", () => {
    expect(bootGate(config, "2.9.0")).toBe("update");
    expect(bootGate({ ...config, launched: false, launchAt: "2026-12-01T00:00:00.000Z" }, "3.0.0")).toBe("coming-soon");
    expect(bootGate(config, "3.0.0")).toBe("open");
  });
});