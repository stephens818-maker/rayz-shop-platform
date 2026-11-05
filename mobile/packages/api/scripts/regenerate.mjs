import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pkg = resolve(here, "..");
const repo = resolve(pkg, "../../..");
const outJson = resolve(pkg, "openapi/v1.json");
const outTs = resolve(pkg, "src/generated/v1.ts");

mkdirSync(dirname(outJson), { recursive: true });
mkdirSync(dirname(outTs), { recursive: true });

const dump = `
import { openApiDocument } from "./src/server/openapi.ts";
process.stdout.write(JSON.stringify(openApiDocument("https://api.rayzbs.com"), null, 2));
`;

const json = execFileSync("pnpm", ["exec", "tsx", "-e", dump], {
  cwd: repo,
  encoding: "utf8",
  stdio: ["ignore", "pipe", "inherit"],
});
writeFileSync(outJson, json.endsWith("\n") ? json : `${json}\n`);
execFileSync("pnpm", ["exec", "openapi-typescript", outJson, "-o", outTs], {
  cwd: pkg,
  stdio: "inherit",
});
console.log("Wrote", outJson, "and", outTs);
