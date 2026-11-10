import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { OPENAPI_BASE_URL, openApiFiles } from "@/server/openapi-files";

describe("openapi/*.json, which the apps generate their API types from", () => {
  for (const [name, text] of Object.entries(openApiFiles(OPENAPI_BASE_URL)))
    it(`openapi/${name} matches the code (pnpm openapi:dump)`, () => {
      expect(readFileSync(join(process.cwd(), "openapi", name), "utf8") === text, `openapi/${name} is out of date: run pnpm openapi:dump`).toBe(true);
    });
});
