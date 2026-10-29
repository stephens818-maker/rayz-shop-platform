import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * postgres.js types lock_timeout as a number of milliseconds. A string such as "5s" fails
 * `next build`. Vercel preview builds for d4216cc, 5fa0090 and 21b4e62 failed on that.
 */
describe("the database client", () => {
  const text = readFileSync(resolve(__dirname, "../src/db/index.ts"), "utf8");

  it("sets lock_timeout in milliseconds", () => {
    expect(text).toMatch(/lock_timeout:\s*5_000/);
    expect(text).not.toMatch(/lock_timeout:\s*["']/);
  });
});
