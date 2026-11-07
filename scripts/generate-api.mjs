/**
 * `pnpm generate:api` from the repo root: the apps' API types from this checkout's server code.
 * The platform's dependencies are installed at the root from its own lockfile (never a workspace
 * with mobile/, so Vercel's install never pulls in Expo), openapi/*.json are written from the code,
 * then mobile/ runs its own generate (openapi-typescript) against them.
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const run = (args, cwd = root) => execFileSync("pnpm", args, { cwd, stdio: "inherit" });

if (!existsSync(join(root, "node_modules/.bin/tsx"))) run(["install", "--frozen-lockfile"]);
run(["exec", "tsx", "scripts/openapi-dump.ts"]);

const mobile = join(root, "mobile");
if (!existsSync(join(mobile, "package.json"))) {
  console.log("No mobile/ in this checkout: openapi/v1.json and openapi/staff-v1.json are up to date.");
  process.exit(0);
}
if (!existsSync(join(mobile, "node_modules"))) run(["install", "--frozen-lockfile"], mobile);
run(["generate:api"], mobile);
