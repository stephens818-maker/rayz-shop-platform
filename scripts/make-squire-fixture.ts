/** Writes the realistic Squire sample export to samples/squire/realistic/. Usage: pnpm tsx scripts/make-squire-fixture.ts [YYYY-MM-DD] */
import { mkdirSync, writeFileSync } from "node:fs";
import { makeSquireFixture } from "./squire-fixture";

const fx = makeSquireFixture({ exportDate: process.argv[2] });
const dir = "samples/squire/realistic";
mkdirSync(dir, { recursive: true });
for (const [kind, text] of Object.entries(fx.files)) writeFileSync(`${dir}/${kind}.csv`, text);
writeFileSync(`${dir}/expected.json`, JSON.stringify({ exportDate: fx.exportDate, ...fx.expected }, null, 2) + "\n");
console.log(`Wrote ${dir} (export date ${fx.exportDate})`);
for (const [kind, text] of Object.entries(fx.files)) console.log(`  ${kind}.csv: ${text.trim().split("\r\n").length - 1} rows`);
