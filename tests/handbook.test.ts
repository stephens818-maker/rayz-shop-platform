import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { rankCommands } from "@/domain/command-search";
import { HANDBOOK, handbookFor } from "@/domain/handbook";
import type { Permission } from "@/domain/permissions";

describe("handbook", () => {
  it("matches the markdown pages and stays out of search without the right permission", () => {
    for (const t of HANDBOOK) {
      const path = `docs/handbook/${t.slug}.md`;
      expect(existsSync(path), path).toBe(true);
      const md = readFileSync(path, "utf8");
      expect(md.startsWith(`# ${t.title}`), t.slug).toBe(true);
      for (const step of t.steps) expect(md, t.slug).toContain(step);
    }
    const desk = handbookFor(new Set<Permission>(["timeclock.punch", "clients.message"]));
    expect(desk.some((t) => t.slug === "my-pay")).toBe(false);
    expect(desk.some((t) => t.slug === "texting")).toBe(true);
    expect(desk.some((t) => t.slug === "inventory")).toBe(false);
    const hits = rankCommands(
      "check in",
      desk.map((t) => ({ id: t.slug, label: t.title, group: "Handbook", keywords: t.keywords })),
    );
    expect(hits[0]?.id).toBe("check-in");
    const pay = handbookFor(new Set<Permission>(["compensation.own"]));
    expect(pay.some((t) => t.slug === "my-pay")).toBe(true);
  });
});
