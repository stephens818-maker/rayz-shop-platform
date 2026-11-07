/**
 * Writes the customer API (/api/v1) and staff app API (/api/staff/v1) OpenAPI documents to
 * openapi/, for the mobile repo's `pnpm generate:api` (openapi-typescript reads them). Committed,
 * so the apps' types can be generated without the platform's toolchain; tests/openapi-committed
 * fails when they drift from the code. `--check` only compares.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { OPENAPI_BASE_URL, openApiFiles } from "../src/server/openapi-files";

const dir = join(process.cwd(), "openapi");
const check = process.argv.includes("--check");
let stale = 0;
mkdirSync(dir, { recursive: true });
for (const [name, text] of Object.entries(openApiFiles(OPENAPI_BASE_URL))) {
  const path = join(dir, name);
  let was = "";
  try {
    was = readFileSync(path, "utf8");
  } catch {}
  if (was === text) continue;
  stale++;
  if (check) console.error(`openapi/${name} is out of date: run pnpm openapi:dump`);
  else {
    writeFileSync(path, text);
    console.log(`Wrote openapi/${name}`);
  }
}
if (check && stale) process.exit(1);
