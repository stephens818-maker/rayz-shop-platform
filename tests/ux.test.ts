import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { columnsThatFit } from "@/domain/calendar-layout";
import { Command, commandScore, rankCommands, strongMatch } from "@/domain/command-search";
import { barChartOf, reportBarChart } from "@/domain/report-charts";
import type { ReportTable } from "@/domain/report-views";
import { GO_TO, hotkeyOf, isTypingTarget, shortcutGroups } from "@/domain/shortcuts";
import { THEME_SCRIPT, isDark, parseThemePref } from "@/domain/theme";

const cmd = (label: string, group = "Pages", keywords?: string): Command => ({ id: label, label, group, keywords });

describe("command palette search", () => {
  const items = [cmd("Calendar"), cmd("Campaign Center", "Pages", "marketing"), cmd("Cash drawer"), cmd("Sales & checkout"), cmd("Tip payouts", "Pages", "Payroll"), cmd("Sales tax", "Reports", "report finance")];

  it("puts a label that starts with the query first, then word starts, then anywhere", () => {
    expect(rankCommands("ca", items).map((c) => c.label).slice(0, 3)).toEqual(["Calendar", "Cash drawer", "Campaign Center"]);
    expect(rankCommands("checkout", items)[0].label).toBe("Sales & checkout");
  });

  it("needs every word to match, and matches keywords and the group", () => {
    expect(rankCommands("sales tax", items).map((c) => c.label)).toEqual(["Sales tax"]);
    expect(rankCommands("payroll", items).map((c) => c.label)).toEqual(["Tip payouts"]);
    expect(rankCommands("marketing", items).map((c) => c.label)).toEqual(["Campaign Center"]);
    expect(rankCommands("zzz", items)).toEqual([]);
  });

  it("forgives skipped letters and accents", () => {
    expect(rankCommands("cshdr", items)[0].label).toBe("Cash drawer");
    expect(commandScore("cafe", cmd("Café hours"))).not.toBeNull();
  });

  it("a label every word starts is strong enough to list above client matches", () => {
    expect(strongMatch("rock island", cmd("Switch to Rock Island", "Switch shop"))).toBe(true);
    expect(strongMatch("tip", cmd("Tip payouts"))).toBe(true);
    expect(strongMatch("jackson", cmd("Sales & checkout"))).toBe(false);
    expect(strongMatch("payroll", cmd("Tip payouts", "Pages", "Payroll"))).toBe(false);
  });

  it("keeps the list as is with no query", () => {
    expect(rankCommands("  ", items)).toEqual(items);
  });
});

describe("keyboard shortcuts", () => {
  it("names a key press", () => {
    expect(hotkeyOf({ key: "K", metaKey: true })).toBe("mod+k");
    expect(hotkeyOf({ key: "k", ctrlKey: true })).toBe("mod+k");
    expect(hotkeyOf({ key: "Enter", ctrlKey: true })).toBe("mod+enter");
    expect(hotkeyOf({ key: "ArrowLeft" })).toBe("arrowleft");
    expect(hotkeyOf({ key: "?" })).toBe("?");
    expect(hotkeyOf({ key: "k", altKey: true })).toBeNull();
    expect(hotkeyOf({ key: "Shift" })).toBeNull();
  });

  it("stays out of the way while typing, but not on a checkbox", () => {
    expect(isTypingTarget({ tagName: "INPUT", type: "text" })).toBe(true);
    expect(isTypingTarget({ tagName: "INPUT", type: "search" })).toBe(true);
    expect(isTypingTarget({ tagName: "TEXTAREA" })).toBe(true);
    expect(isTypingTarget({ tagName: "DIV", isContentEditable: true })).toBe(true);
    expect(isTypingTarget({ tagName: "INPUT", type: "checkbox" })).toBe(false);
    expect(isTypingTarget({ tagName: "BUTTON" })).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
  });

  it("the help sheet lists each jump once, with the platform's modifier", () => {
    const g = shortcutGroups(GO_TO, true);
    expect(g.map((x) => x.title)).toEqual(["Everywhere", "Calendar", "Checkout"]);
    expect(g[0].items[0].keys).toEqual(["⌘", "K"]);
    expect(shortcutGroups(GO_TO, false)[0].items[0].keys).toEqual(["Ctrl", "K"]);
    expect(new Set(GO_TO.map((x) => x.key)).size).toBe(GO_TO.length);
    expect(g[0].items.filter((i) => i.keys[0] === "G")).toHaveLength(GO_TO.length);
  });
});

describe("theme", () => {
  it("is light until someone picks dark or matching the device", () => {
    expect(parseThemePref(null)).toBe("light");
    expect(parseThemePref("nonsense")).toBe("light");
    expect(parseThemePref("dark")).toBe("dark");
    expect(isDark("system", true)).toBe(true);
    expect(isDark("system", false)).toBe(false);
    expect(isDark("light", true)).toBe(false);
  });

  it("the pre-paint script agrees with isDark", () => {
    const run = (stored: string | null, systemDark: boolean) => {
      const classes = new Set<string>();
      const document = { documentElement: { classList: { toggle: (c: string, on: boolean) => (on ? classes.add(c) : classes.delete(c)) } } };
      const localStorage = { getItem: () => stored };
      const matchMedia = () => ({ matches: systemDark });
      new Function("document", "localStorage", "matchMedia", THEME_SCRIPT)(document, localStorage, matchMedia);
      return classes.has("dark");
    };
    for (const p of [null, "light", "dark", "system"]) for (const sys of [true, false]) expect(run(p, sys)).toBe(isDark(parseThemePref(p), sys));
  });
});

describe("the day board fits its barbers across", () => {
  it("pages barbers instead of scrolling sideways once columns would be narrower than 120px", () => {
    expect(columnsThatFit(1200)).toBe(9);
    expect(columnsThatFit(800)).toBe(6);
    expect(columnsThatFit(360)).toBe(2);
    expect(columnsThatFit(100)).toBe(1);
  });
});

describe("report bar charts", () => {
  const t = (over: Partial<ReportTable>): ReportTable => ({ id: "t", title: "T", columns: [], rows: [], ...over });

  it("ranks the first money column by the label columns, without subtotals or totals", () => {
    const c = barChartOf(
      t({
        columns: [{ label: "Shop" }, { label: "Barber" }, { label: "Visits", kind: "int" }, { label: "Net sales", kind: "money" }],
        rows: [
          ["Moline", "Kat", 10, 50000],
          ["Moline", "Dre", 12, 70000],
          ["Moline", null, 22, 120000],
          ["Total", null, 22, 120000],
        ],
        rowStyles: [undefined, undefined, "subtotal", "total"],
      }),
    );
    expect(c).toMatchObject({ shape: "rank", kind: "money", title: "Net sales by shop and barber" });
    expect(c!.bars).toEqual([
      { label: "Moline · Dre", value: 70000 },
      { label: "Moline · Kat", value: 50000 },
    ]);
  });

  it("keeps dates in order as columns", () => {
    const c = barChartOf(
      t({
        columns: [{ label: "Day" }, { label: "Tickets", kind: "int" }],
        rows: [
          ["2026-10-01", 4],
          ["2026-10-02", 9],
          ["2026-10-03", 2],
        ],
      }),
    );
    expect(c?.shape).toBe("time");
    expect(c?.bars.map((b) => b.value)).toEqual([4, 9, 2]);
  });

  it("keeps the top 12 and says so", () => {
    const rows = Array.from({ length: 20 }, (_, i) => [`Barber ${i}`, i * 100]);
    const c = barChartOf(t({ columns: [{ label: "Barber" }, { label: "Tips", kind: "money" }], rows }));
    expect(c?.bars).toHaveLength(12);
    expect(c?.bars[0]).toEqual({ label: "Barber 19", value: 1900 });
    expect(c?.subtitle).toBe("Top 12 of 20");
  });

  it("skips tables that don't chart: metric rows, shop pivots, one row, nothing to measure, all zero", () => {
    expect(barChartOf(t({ columns: [{ label: "Metric" }, { label: "Moline", kind: "money" }], rows: [["Net", 1], ["Tax", 2]], rowKinds: ["money", "money"] }))).toBeNull();
    expect(barChartOf(t({ columns: [{ label: "Metric" }, { label: "Moline", kind: "money" }, { label: "Total", kind: "money" }], rows: [["Net", 1, 1], ["Tax", 2, 2]], totalColumn: true }))).toBeNull();
    expect(barChartOf(t({ columns: [{ label: "Barber" }, { label: "Tips", kind: "money" }], rows: [["Kat", 5]] }))).toBeNull();
    expect(barChartOf(t({ columns: [{ label: "Barber" }, { label: "Rate", kind: "pct" }], rows: [["Kat", 0.5], ["Dre", 0.4]] }))).toBeNull();
    expect(barChartOf(t({ columns: [{ label: "Barber" }, { label: "Tips", kind: "money" }], rows: [["Kat", 0], ["Dre", 0]] }))).toBeNull();
    expect(barChartOf(t({ exportOnly: true, columns: [{ label: "Barber" }, { label: "Tips", kind: "money" }], rows: [["Kat", 5], ["Dre", 6]] }))).toBeNull();
  });

  it("a report charts its first table that can be charted", () => {
    const skip = t({ id: "a", columns: [{ label: "Barber" }, { label: "Rate", kind: "pct" }], rows: [["Kat", 0.5], ["Dre", 0.4]] });
    const use = t({ id: "b", columns: [{ label: "Service" }, { label: "Sold", kind: "int" }], rows: [["Cut", 5], ["Beard", 3]] });
    expect(reportBarChart([skip, use])?.id).toBe("b");
    expect(reportBarChart([skip])).toBeNull();
  });
});

describe("text contrast (WCAG AA)", () => {
  const css = readFileSync("src/app/globals.css", "utf8");
  const dark = readFileSync("src/app/dark.css", "utf8");
  const oklch = (v: string) => {
    const [L, C, h] = v.match(/oklch\(([\d.]+)%\s+([\d.]+)\s+([\d.]+|none)\)/)!.slice(1).map((x) => (x === "none" ? 0 : Number(x)));
    const a = C * Math.cos((h * Math.PI) / 180);
    const b = C * Math.sin((h * Math.PI) / 180);
    const l = (L / 100 + 0.3963377774 * a + 0.2158037573 * b) ** 3;
    const m = (L / 100 - 0.1055613458 * a - 0.0638541728 * b) ** 3;
    const s = (L / 100 - 0.0894841775 * a - 1.291485548 * b) ** 3;
    const rgb = [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s, -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s];
    const [r, g, bl] = rgb.map((x) => Math.min(1, Math.max(0, x)));
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const ratio = (fg: string, bg: string) => {
    const [x, y] = [oklch(fg), oklch(bg)].sort((p, q) => q - p);
    return (x + 0.05) / (y + 0.05);
  };
  const varIn = (src: string, name: string) => src.match(new RegExp(`${name}:\\s*(oklch\\([^)]*\\))`))![1];

  it("muted greys reach 4.5:1 on white, zinc-50, zinc-100 and zinc-200 in light mode", () => {
    const surfaces = ["oklch(100% 0 0)", "oklch(98.5% 0 0)", "oklch(96.7% 0.001 286.375)", "oklch(92% 0.004 286.32)"];
    for (const v of ["--text-faint", "--text-muted"]) for (const bg of surfaces) expect(ratio(varIn(css, v), bg)).toBeGreaterThanOrEqual(4.5);
  });

  it("and on the dark card, page, zinc-100 and zinc-200 surfaces in dark mode", () => {
    const surfaces = ["--color-white", "--color-zinc-50", "--color-zinc-100", "--color-zinc-200"].map((v) => varIn(dark, v));
    for (const v of ["--text-faint", "--text-muted"]) for (const bg of surfaces) expect(ratio(varIn(dark, v), bg)).toBeGreaterThanOrEqual(4.5);
  });
});
