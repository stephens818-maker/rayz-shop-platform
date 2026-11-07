import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Charles's real payroll data stays in the gitignored private/ folder. When it's on this machine, no
 * tracked file may carry its names, iSolved keys or amounts. Failures list file paths and line
 * numbers only, so the output is safe to paste.
 */
const ROOT = join(__dirname, "..");
const PRIVATE = join(ROOT, "tests/fixtures/payroll-golden/private/golden.json");
const ANON = join(ROOT, "tests/fixtures/payroll-golden/anon/golden.json");

type Golden = {
  rows: { inputs: { name: string } }[];
  export_tabs: Record<string, { rows: { key: string; isolved_name: string }[] }>;
};

function numbers(o: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(o)) o.forEach((v) => numbers(v, out));
  else if (o && typeof o === "object") Object.values(o).forEach((v) => numbers(v, out));
  else if (typeof o === "number" && Math.abs(o) >= 1) {
    if (!Number.isInteger(o)) {
      out.add(o.toFixed(2));
      if (String(o).length > 6) out.add(String(o));
    } else if (Math.abs(o) >= 100) out.add(String(o));
  }
  return out;
}

const tracked = (): string[] =>
  execFileSync("git", ["ls-files"], { cwd: ROOT, encoding: "utf8" })
    .split("\n")
    .filter((f) => f && !f.startsWith("tests/fixtures/payroll-golden/private/") && !/\.(xlsx|png|jpe?g|ico|svg|woff2?|lock)$|pnpm-lock\.yaml$/.test(f))
    .filter((f) => existsSync(join(ROOT, f)));

const lineOf = (text: string, at: number) => text.slice(0, at).split("\n").length;

describe.skipIf(!existsSync(PRIVATE))("real payroll data stays out of the repo", () => {
  const golden = JSON.parse(readFileSync(PRIVATE, "utf8")) as Golden;
  const files = tracked().map((f) => ({ f, text: readFileSync(join(ROOT, f), "utf8") }));

  it("no tracked file has a real employee's full name or iSolved key", () => {
    const names = new Set<string>();
    const keys = new Set<string>();
    for (const r of golden.rows) if (r.inputs.name.trim().includes(" ")) names.add(r.inputs.name.trim().toLowerCase());
    for (const tab of Object.values(golden.export_tabs)) {
      for (const r of tab.rows) {
        const key = String(r.key).trim();
        if (/^\d{4,}$/.test(key)) keys.add(key);
        const [last, first] = r.isolved_name.split(",").map((x) => x.trim());
        if (!last || !first) continue;
        names.add(r.isolved_name.trim().toLowerCase());
        names.add(`${first.split(/\s+/)[0]} ${last}`.toLowerCase());
        names.add(`${last}, ${first.split(/\s+/)[0]}`.toLowerCase());
      }
    }
    const hits: string[] = [];
    for (const { f, text } of files) {
      const lower = text.toLowerCase();
      for (const n of names) if (lower.includes(n)) hits.push(`${f}:${lineOf(text, lower.indexOf(n))} (a name)`);
      for (const k of keys) {
        const m = new RegExp(`(?<![\\w.])${k}(?![\\w.])`).exec(text);
        if (m) hits.push(`${f}:${lineOf(text, m.index)} (a key)`);
      }
    }
    expect(hits).toEqual([]);
  });

  it("docs and tests carry no amount, rate or hours value found only in the real data", () => {
    const real = numbers(golden);
    for (const n of numbers(JSON.parse(readFileSync(ANON, "utf8")))) real.delete(n);
    const hits: string[] = [];
    for (const { f, text } of files) {
      if (!/^(docs\/|tests\/|[^/]+\.md$)/.test(f)) continue;
      for (const m of text.matchAll(/(?<![\w.])\d[\d,]*\.\d+(?!\d)|(?<![\w.])\d{3,}(?![\w.])/g)) {
        const t = m[0].replace(/,/g, "");
        if (t.replace(/\D/g, "").length < 5) continue;
        const twoDp = t.includes(".") && t.split(".")[1].length >= 2 && real.has(Number(t).toFixed(2));
        if (real.has(t) || twoDp) hits.push(`${f}:${lineOf(text, m.index!)}`);
      }
    }
    expect(hits).toEqual([]);
  });
});
