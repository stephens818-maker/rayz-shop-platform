import { describe, expect, it } from "vitest";
import { createSecureTokenStore, type KeyValueStore } from "./web-secure";

describe("web token storage", () => {
  it("keeps the session token out of plaintext storage", async () => {
    const mem = new Map<string, string>();
    const storage: KeyValueStore = {
      getItem: (key) => mem.get(key) ?? null,
      setItem: (key, value) => mem.set(key, value),
      removeItem: (key) => mem.delete(key),
    };
    const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
    const store = createSecureTokenStore(storage, async () => key);
    await store.setItem("rayz.customer.session", "cust.secret-token");
    expect(mem.get("rayz.customer.session")).not.toContain("cust.secret-token");
    expect(await store.getItem("rayz.customer.session")).toBe("cust.secret-token");
    await store.removeItem("rayz.customer.session");
    expect(await store.getItem("rayz.customer.session")).toBeNull();
  });
});