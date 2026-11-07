import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const APP = resolve(__dirname, "../src/app");
const SRC = resolve(__dirname, "../src");

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

const handlers = walk(APP)
  .filter((f) => f.endsWith("/route.ts"))
  .map((f) =>
    ("/" + relative(APP, f).replace(/\/?route\.ts$/, ""))
      .split("/")
      .filter((s) => !/^\(.*\)$/.test(s))
      .join("/"),
  )
  .filter((p) => !p.startsWith("/api/"));

const handlerRe = handlers.map((p) => ({ p, re: new RegExp("^" + p.replace(/\[[^\]]+\]/g, "[^/]+").replace(/\./g, "\\.") + "$") }));

/** Opening `<Link …>` and `<LinkButton …>` tags, with braces balanced so arrow functions in props don't end the tag. */
function linkTags(text: string) {
  const out: string[] = [];
  for (const m of text.matchAll(/<(Link|LinkButton)\b/g)) {
    let depth = 0;
    let i = m.index! + m[0].length;
    for (; i < text.length; i++) {
      const c = text[i];
      if (c === "{") depth++;
      else if (c === "}") depth--;
      else if (c === ">" && depth === 0) break;
    }
    out.push(text.slice(m.index!, i + 1));
  }
  return out;
}

function hrefPath(tag: string) {
  const m = tag.match(/\bhref=(?:"([^"]*)"|\{`([^`]*)`\}|\{"([^"]*)"\})/);
  const raw = m?.[1] ?? m?.[2] ?? m?.[3];
  if (!raw) return null;
  return raw.replace(/\$\{[^}]*\}/g, "x").split(/[?#]/)[0];
}

describe("links to file routes don't prefetch", () => {
  const files = walk(SRC).filter((f) => f.endsWith(".tsx"));

  it("finds the route handlers", () => {
    expect(handlers).toContain("/admin/client-data/access/export");
    expect(handlers).toContain("/admin/import/[runId]/errors");
  });

  it("a Link to a route handler sets prefetch={false}, so viewing the page doesn't run (and audit) an export", () => {
    const bad: string[] = [];
    let checked = 0;
    for (const f of files) {
      for (const tag of linkTags(readFileSync(f, "utf8"))) {
        const path = hrefPath(tag);
        if (!path) continue;
        const hit = handlerRe.find(({ re }) => re.test(path));
        if (!hit) continue;
        checked++;
        if (!/\bprefetch=\{false\}/.test(tag)) bad.push(`${relative(SRC, f)}: ${hit.p}`);
      }
    }
    expect(checked).toBeGreaterThan(0);
    expect(bad).toEqual([]);
  });
});
