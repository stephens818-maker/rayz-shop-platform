import { describe, expect, it } from "vitest";
import { signedInSession } from "./sign-in-state";

describe("staff sign-in", () => {
  it("clears the step-up token when a session is saved", () => {
    const next = signedInSession({ token: "staff.1", refreshToken: "sref.1", firstName: "Makenna", staffId: "1" });
    expect(next.stepUp).toBeNull();
    expect(next.unlocked).toBe(false);
    expect(next.session.firstName).toBe("Makenna");
  });
});
