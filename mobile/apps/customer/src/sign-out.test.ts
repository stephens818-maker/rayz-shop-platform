import { describe, expect, it } from "vitest";
import { signOutSession } from "./sign-out";

describe("sign out", () => {
  it("clears the query cache before the session token", async () => {
    const order: string[] = [];
    await signOutSession(
      { clear: () => order.push("cache") },
      async () => {
        order.push("session");
      },
    );
    expect(order).toEqual(["cache", "session"]);
  });
});