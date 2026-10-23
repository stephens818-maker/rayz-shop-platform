import { describe, expect, it } from "vitest";
import { bootGate } from "./boot-gate";

describe("app config gate", () => {
  const config = { launched: true, launchAt: "2026-01-01T00:00:00.000Z", minVersion: { ios: "3.0.0", android: "1.0.0" }, forceUpdateBelow: { ios: "3.0.0", android: "2.0.0" } };

  it("forces an update from minVersion and shows coming soon until launch", () => {
    expect(bootGate(config, "2.9.0")).toBe("update");
    expect(bootGate({ ...config, launched: false, launchAt: "2026-12-01T00:00:00.000Z" }, "3.0.0")).toBe("coming-soon");
    expect(bootGate(config, "3.0.0")).toBe("open");
  });

  it("stays closed when config fails, and updates Android from its own minimum or HTTP 426", () => {
    expect(bootGate(null, "3.0.0")).toBe("offline");
    expect(bootGate(undefined, "3.0.0", "android")).toBe("offline");
    expect(bootGate(config, "1.5.0", "android")).toBe("update");
    expect(bootGate(config, "2.0.0", "android")).toBe("open");
    expect(bootGate(null, "1.0.0", "android", 426)).toBe("update");
    expect(bootGate({ minSupportedVersion: { ios: "1.0.0", android: "1.0.0" } }, "0.9.0", "android")).toBe("update");
    expect(bootGate({ minSupportedVersion: { ios: "1.0.0", android: "1.0.0" } }, "1.0.0", "android")).toBe("open");
  });
});