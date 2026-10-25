import { describe, expect, it } from "vitest";
import {
  type MorningDashboard,
  changeLabel,
  changeWords,
  cmp,
  hasContent,
  handleCount,
  morningPeriods,
  morningSettings,
  parseMorningSettings,
  urgentCount,
  versionPlans,
} from "@/domain/morning-dashboard";
import { EMAIL_BARBER_ROWS, EMAIL_EXCEPTION_ROWS, morningDoc, renderMorningHtml, renderMorningPdf, renderMorningSms, renderMorningText } from "@/domain/morning-render";
import { weekdayOf } from "@/lib/time";

const MONDAY = "2026-10-26";
const openExceptSunday = (d: string) => weekdayOf(d) !== 0;
const CORAL = { id: "11111111-1111-4111-8111-111111111111", name: "Coralville" };
const ROCK = { id: "22222222-2222-4222-8222-222222222222", name: "Rock & Roll <Island>" };

function dash(o: Partial<MorningDashboard> = {}): MorningDashboard {
  const shops = [CORAL, ROCK];
  const barbers = Array.from({ length: 20 }, (_, i) => ({ staffId: `b${i}`, label: `Barber ${i + 1}`, net: 10_000 - i * 100, services: 9_000, products: 1_000, tips: 1_500, tickets: 4, netWtd: 40_000 }));
  return {
    firstName: "Ray",
    version: { scope: "all", label: "All locations", shops },
    periods: morningPeriods(MONDAY, openExceptSunday),
    baseUrl: "https://rayz.test",
    sales: {
      shops,
      gross: cmp(130_000, 110_000, 600_000, 550_000),
      net: cmp(120_000, 100_000, 560_000, 500_000),
      services: cmp(100_000, 90_000, 480_000, 450_000),
      products: cmp(20_000, 10_000, 80_000, 50_000),
      tips: cmp(18_000, 15_000, 80_000, 70_000),
      cardFees: cmp(3_000, 2_500, 14_000, 13_000),
      refunds: cmp(0, 1_000, 2_000, 1_000),
      tickets: cmp(30, 25, 140, 130),
      avgTicket: cmp(4_000, 4_000, 4_000, 3_846),
      voids: cmp(500, 0, 500, 0),
      byShop: [
        { shop: CORAL, net: cmp(80_000, 60_000), tickets: cmp(20, 15) },
        { shop: ROCK, net: cmp(40_000, 40_000), tickets: cmp(10, 10) },
      ],
      byBarber: barbers,
      ownOnly: false,
      daily: [
        { date: "2026-10-18", net: 0, prior: 0 },
        { date: "2026-10-19", net: 90_000, prior: 80_000 },
        { date: "2026-10-24", net: 120_000, prior: 100_000 },
      ],
    },
    traffic: {
      shops,
      newClients: cmp(5, 4),
      returningClients: cmp(25, 21),
      bookingsMade: cmp(40, 35),
      online: cmp(28, 20),
      walkIns: cmp(6, 8),
      frontDesk: cmp(6, 7),
      visits: cmp(34, 30),
      cancellations: cmp(2, 3),
      noShows: cmp(1, 0),
    },
    utilization: {
      shops,
      booked: cmp(1_500, 1_400),
      available: cmp(2_000, 2_000),
      utilization: cmp(0.75, 0.7, 0.72, 0.7),
      barbers: [{ staffId: "b0", label: "Barber 1", bookedMin: 420, availableMin: 480, utilization: 0.875, utilizationWtd: 0.8, avgActualMin: 32, avgBookedMin: 30, timed: 8 }],
      ownOnly: false,
      cutTimes: { avgActualMin: 32, avgBookedMin: 30, n: 8 },
    },
    loyalty: { loyalty: null, giftCards: { shops: [CORAL], soldN: cmp(2, 1), soldCents: cmp(10_000, 5_000), redeemedCents: cmp(2_500, 0), outstandingCents: 123_400 } },
    marketing: { shops, openingsOnly: false, sends: cmp(200, 0), clicks: cmp(30, 0), bookings: cmp(4, 0), redemptions: cmp(2, 0), revenue: cmp(16_000, 0) },
    reviews: { shops, clicks: cmp(6, 3), followUps: cmp(20, 18), byShop: [] },
    today: {
      date: MONDAY,
      shops: [
        {
          shop: CORAL,
          open: true,
          hours: "9:00 AM–7:00 PM",
          appointments: 18,
          barbers: [{ staffId: "b0", label: "Makenna", hours: "9:00 AM–5:00 PM", partlyOff: false, booked: 9, openMin: 90, open: ["2:00 PM–3:30 PM"] }],
          off: [{ label: "Jessica", why: "vacation" }],
          callIns: [{ label: "Delaney", kind: "sick", when: "all day" }],
          openMin: 90,
        },
        { shop: ROCK, open: false, hours: "Closed for the remodel", appointments: 0, barbers: [], off: [], callIns: [], openMin: 0 },
      ],
    },
    exceptions: {
      categories: ["punches", "overtime", "stock", "payouts"],
      items: [
        { category: "punches", severity: "high", shop: ROCK.name, title: "Kat didn't clock out Saturday", href: "/admin/time-clock" },
        { category: "overtime", severity: "medium", shop: null, title: "Jamie is on track for 43 hours", detail: "Over 40 by Thursday", href: "/admin/payroll" },
        { category: "payouts", severity: "low", shop: CORAL.name, title: "$812.00 deposit on its way", href: "/admin/payouts" },
      ],
    },
    milestones: null,
    rebook: null,
    ...o,
  };
}

describe("Morning Dashboard settings", () => {
  it("defaults to 7:02 AM for owners and managers, every section on, no PDF or text", () => {
    expect(morningSettings(undefined)).toMatchObject({
      enabled: true,
      sendAtMin: 7 * 60 + 2,
      roles: ["brand_owner", "brand_admin", "regional_manager", "shop_manager"],
      skipClosedDays: true,
      coverLastOpenDay: true,
      pdf: false,
      sms: false,
      sections: { sales: true, traffic: true, utilization: true, rebook: true, loyalty: true, marketing: true, reviews: true, today: true, exceptions: true, milestones: true },
    });
  });

  it("takes any minute in the morning and refuses one outside it", () => {
    expect(parseMorningSettings({ sendAtMin: 6 * 60 + 47 }).success).toBe(true);
    expect(parseMorningSettings({ sendAtMin: 13 * 60 }).success).toBe(false);
    expect(parseMorningSettings({ sendAtMin: 3 * 60 + 59 }).success).toBe(false);
    expect(parseMorningSettings({ versions: { "not-an-id": { kind: "both" } } }).success).toBe(false);
  });

  it("carries the earlier digest's sections over", () => {
    const s = morningSettings({ sendAtMin: 420, sections: { sales: false, staff: false, alerts: true } });
    expect(s.sendAtMin).toBe(420);
    expect(s.sections).toMatchObject({ sales: false, today: false, exceptions: true, traffic: true });
  });
});

describe("Morning Dashboard periods", () => {
  it("covers Saturday on Monday when the shops are closed Sundays", () => {
    expect(morningPeriods(MONDAY, openExceptSunday)).toEqual({
      today: MONDAY,
      reportDay: "2026-10-24",
      compareDay: "2026-10-17",
      wtdFrom: "2026-10-18",
      wtdPriorFrom: "2026-10-11",
      wtdPriorTo: "2026-10-17",
      skipped: ["2026-10-25"],
    });
  });

  it("covers yesterday on other days, and yesterday even when closed if told to", () => {
    expect(morningPeriods("2026-10-28", openExceptSunday)).toMatchObject({ reportDay: "2026-10-27", compareDay: "2026-10-20", wtdFrom: "2026-10-25", skipped: [] });
    expect(morningPeriods(MONDAY, openExceptSunday, false)).toMatchObject({ reportDay: "2026-10-25", skipped: [] });
    expect(morningPeriods(MONDAY, () => false)).toMatchObject({ reportDay: "2026-10-25" });
  });
});

describe("Morning Dashboard versions", () => {
  it("gives one shop its own version and several the all-locations one unless asked otherwise", () => {
    expect(versionPlans([], undefined)).toEqual([]);
    expect(versionPlans(["a"], undefined)).toEqual([{ scope: "a", shopIds: ["a"] }]);
    expect(versionPlans(["a", "b"], undefined)).toEqual([{ scope: "all", shopIds: ["a", "b"] }]);
    expect(versionPlans(["a", "b"], { kind: "per_shop", shopIds: [] })).toEqual([
      { scope: "a", shopIds: ["a"] },
      { scope: "b", shopIds: ["b"] },
    ]);
    expect(versionPlans(["a", "b", "c"], { kind: "both", shopIds: ["a", "c"] }).map((p) => p.scope)).toEqual(["all", "a", "c"]);
    expect(versionPlans(["a", "b"], { kind: "combined", shopIds: ["b", "z"] })).toEqual([{ scope: "b", shopIds: ["b"] }]);
    expect(versionPlans(["a", "b"], { kind: "both", shopIds: ["z"] })).toEqual([]);
  });
});

describe("Morning Dashboard formatting", () => {
  it("labels changes against last week", () => {
    expect(changeLabel(110, 100)).toBe("▲ 10%");
    expect(changeLabel(90, 100)).toBe("▼ 10%");
    expect(changeLabel(100, 100)).toBe("even");
    expect(changeLabel(5, 0)).toBe("new");
    expect(changeLabel(0, 0)).toBe("—");
    expect(changeWords(120, 100)).toBe("up 20%");
    expect(changeWords(0, 0)).toBe("no change");
  });

  it("counts what needs handling, leaving out status like a deposit on its way", () => {
    expect(urgentCount(dash())).toBe(1);
    expect(handleCount(dash())).toBe(2);
    const empty = dash({ sales: null, traffic: null, utilization: null, loyalty: null, marketing: null, reviews: null, today: null, exceptions: null });
    expect(hasContent(empty)).toBe(false);
    expect(hasContent(dash())).toBe(true);
  });
});

describe("Morning Dashboard layout", () => {
  it("puts exceptions and today first, then the numbers, with links into the app", () => {
    const doc = morningDoc(dash());
    expect(doc.subject).toBe("Morning Dashboard Mon Oct 26: $1,200 net, up 20% · 1 urgent");
    expect(doc.coverage).toBe("Numbers for Saturday, Oct 24 (Sunday closed), against last Saturday.");
    expect(doc.sections.map((s) => s.key)).toEqual(["exceptions", "today", "sales", "traffic", "utilization", "loyalty", "marketing", "reviews"]);
    expect(doc.tiles.map((t) => t.label)).toEqual(["Net sales", "Tickets", "Utilization", "No-shows"]);
    const sales = doc.sections.find((s) => s.key === "sales")!;
    expect(sales.link?.href).toBe(`https://rayz.test/admin/reports/sales?from=2026-10-24&to=2026-10-24&shop=${CORAL.id}&shop=${ROCK.id}`);
    expect(doc.dashboardUrl).toBe(`https://rayz.test/admin/morning?date=${MONDAY}&shop=${CORAL.id}&shop=${ROCK.id}`);
    expect(doc.settingsUrl).toBe("https://rayz.test/admin/digest");
  });

  it("shows costs going up as bad, and utilization changes in points", () => {
    const doc = morningDoc(dash());
    const rows = doc.sections.flatMap((s) => s.blocks.flatMap((b) => (b.kind === "metrics" ? b.rows : [])));
    const row = (label: string) => rows.find((r) => r.label.trim() === label)!;
    expect(row("Card fees")).toMatchObject({ dayChange: "▲ 20%", dayTone: "bad" });
    expect(row("Refunds")).toMatchObject({ dayChange: "▼ 100%", dayTone: "good" });
    expect(row("Net sales")).toMatchObject({ day: "$1,200.00", dayChange: "▲ 20%", dayTone: "good", wtd: "$5,600.00", wtdChange: "▲ 12%" });
    expect(row("Utilization")).toMatchObject({ day: "75%", dayChange: "▲ 5 pts", wtdChange: "▲ 2 pts" });
    expect(row("No-shows")).toMatchObject({ dayChange: "new", dayTone: "neutral" });
  });

  it("notes a section that covers fewer shops than the version", () => {
    const doc = morningDoc(dash());
    const loyalty = doc.sections.find((s) => s.key === "loyalty")!;
    expect(loyalty.blocks).toContainEqual({ kind: "note", text: "Covers Coralville: the shops where you can see this report." });
    expect(doc.sections.find((s) => s.key === "sales")!.blocks.some((b) => b.kind === "note" && b.text.startsWith("Covers"))).toBe(false);
  });

  it("lists the top barbers in the email and every barber on the page and in the PDF", () => {
    const table = (barberRows?: number) =>
      morningDoc(dash(), { barberRows })
        .sections.find((s) => s.key === "sales")!
        .blocks.find((b) => b.kind === "table" && b.title === "By barber");
    expect(table(EMAIL_BARBER_ROWS)).toMatchObject({ rows: expect.any(Array) });
    expect((table(EMAIL_BARBER_ROWS) as { rows: unknown[] }).rows).toHaveLength(EMAIL_BARBER_ROWS);
    expect((table() as { rows: unknown[] }).rows).toHaveLength(20);
  });

  it("leaves closed days out of the daily chart", () => {
    const bars = morningDoc(dash()).sections.find((s) => s.key === "sales")!.blocks.find((b) => b.kind === "bars" && b.title.startsWith("Net sales by day"));
    expect(bars).toMatchObject({ rows: [{ label: "Mon" }, { label: "Sat" }] });
  });

  it("lists the first few of each kind to handle in the email and all of them on the page", () => {
    const base = dash();
    const many = Array.from({ length: 8 }, (_, i) => ({ category: "overtime" as const, severity: "high" as const, shop: "Moline", title: `Barber ${i} is on track for 44h`, href: "/admin/timesheets" }));
    const d = dash({ exceptions: { ...base.exceptions!, items: [...base.exceptions!.items, ...many] } });
    const lists = (o?: { exceptionRows: number }) => morningDoc(d, o).sections[0].blocks;
    const overtime = (bs: ReturnType<typeof lists>) => bs.find((b) => b.kind === "list" && b.title === "Overtime risk") as { items: unknown[] };
    expect(overtime(lists({ exceptionRows: EMAIL_EXCEPTION_ROWS })).items).toHaveLength(EMAIL_EXCEPTION_ROWS);
    expect(lists({ exceptionRows: EMAIL_EXCEPTION_ROWS })).toContainEqual({ kind: "note", text: "And 4 more on the dashboard." });
    expect(overtime(lists()).items).toHaveLength(9);
    expect(renderMorningHtml(d)).toContain("And 4 more on the dashboard.");
  });
});

describe("Morning Dashboard renderers", () => {
  it("renders a mobile-friendly HTML email with charts, escaped names and links", () => {
    const html = renderMorningHtml(dash());
    expect(html).toMatch(/^<!doctype html>/);
    expect(html).toContain('<meta name="viewport" content="width=device-width,initial-scale=1">');
    expect(html).toContain("@media (max-width:480px)");
    expect(html).toContain("Rock &amp; Roll &lt;Island&gt;: Kat didn&#39;t clock out Saturday");
    expect(html).not.toContain("<Island>");
    expect(html).toContain("Net sales by day, this week against last");
    expect(html).toContain("Net sales by location, Sat");
    expect(html).toMatch(/<td width="\d+%" style="background:#18181b/);
    expect(html).toContain(`href="https://rayz.test/admin/morning?date=${MONDAY}&amp;shop=${CORAL.id}&amp;shop=${ROCK.id}"`);
    expect(html).toContain('href="https://rayz.test/admin/time-clock"');
    expect(html).toContain("And 5 more on the dashboard.");
    // Seven-column barber tables keep their key columns on a phone.
    expect(html).toContain(".m-hide{display:none!important}");
    expect(html).toContain('<td class="m-hide" align="right" style="padding:4px 4px;color:#a1a1aa;font-size:11px;border-bottom:1px solid #e4e4e7">Services</td>');
    expect(html).not.toMatch(/<td class="m-hide"[^>]*>Net<\/td>/);
    expect(html).toContain("Delaney called in (sick, all day); Jessica off (vacation)");
    expect(html).toContain("Rock &amp; Roll &lt;Island&gt;: Closed for the remodel.");
  });

  it("renders plain text without arrows for the text part", () => {
    const t = renderMorningText(dash());
    expect(t.subject).toBe("Morning Dashboard Mon Oct 26: $1,200 net, up 20% · 1 urgent");
    expect(t.body).not.toMatch(/[▲▼]/);
    expect(t.body).toContain("Net sales: $1,200.00 (+ 20%) · WTD $5,600.00 (+ 12%)");
    expect(t.body).toContain("NEEDS ATTENTION\n2 to handle, 1 urgent");
    expect(t.body).toContain(`Open the dashboard: https://rayz.test/admin/morning?date=${MONDAY}`);
  });

  it("fits the headline in one text message", () => {
    const sms = renderMorningSms(dash());
    expect(sms).toBe(
      `Ray'z Sat 10/24: $1,200 net (up 20% vs last Saturday), 30 tickets; WTD $5,600; 1 no-show; today 1 barber, 1.5h open; 2 to handle (1 urgent). https://rayz.test/admin/morning?date=${MONDAY}&shop=${CORAL.id}&shop=${ROCK.id}`,
    );
    const one = renderMorningSms(dash({ version: { scope: CORAL.id, label: "Coralville", shops: [CORAL] }, sales: null, traffic: null, today: null, exceptions: null }));
    expect(one).toBe(`Ray'z Coralville Sat 10/24: nothing to report. https://rayz.test/admin/morning?date=${MONDAY}&shop=${CORAL.id}`);
  });

  it("adds the team's milestones after today, and the first one to the text", () => {
    const d = dash({
      milestones: {
        achieved: [{ text: "Jamie hit 1,000 cuts", on: MONDAY, shop: CORAL.name }],
        upcoming: [{ text: "Casey's 5-year work anniversary Friday", on: "2026-10-30" }],
      },
    });
    const doc = morningDoc(d);
    expect(doc.sections.map((s) => s.key).slice(0, 3)).toEqual(["exceptions", "today", "milestones"]);
    const m = doc.sections.find((s) => s.key === "milestones")!;
    expect(m.link?.href).toBe("https://rayz.test/admin/milestones");
    expect(m.blocks).toEqual([
      { kind: "list", title: "Reached", items: [{ title: "Jamie hit 1,000 cuts", detail: "Coralville, Mon Oct 26" }] },
      { kind: "list", title: "Coming up", items: [{ title: "Casey's 5-year work anniversary Friday" }] },
    ]);
    expect(renderMorningText(d).body).toContain("STAFF MILESTONES\nWorth a shout-out\n  Reached\n  - Jamie hit 1,000 cuts");
    expect(renderMorningHtml(d)).toContain("Casey&#39;s 5-year work anniversary Friday");
    expect(renderMorningSms(d)).toContain("; Jamie hit 1,000 cuts; 2 to handle");
  });

  it("shows the rebook rate after utilization, per barber against the brand, and in the text", () => {
    const d = dash({
      rebook: {
        shops: [CORAL, ROCK],
        visits: cmp(20, 18, 90, 80),
        rebooked: cmp(12, 9, 45, 40),
        rebook: cmp(0.6, 0.5, 0.5, 0.5),
        newRebook: cmp(0.5, 0.25, 0.4, 0.4),
        brand: { day: 0.55, wtd: 0.47 },
        future: 140,
        secondVisit: { from: "2026-07-27", to: "2026-08-25", judged: 40, back: 26, brand: 0.6 },
        byBarber: [{ staffId: "b0", label: "Makenna", visits: 8, rate: 0.75, wtdVisits: 30, wtdRate: 0.6 }],
        ownOnly: false,
      },
    });
    const doc = morningDoc(d);
    const keys = doc.sections.map((s) => s.key);
    expect(keys.indexOf("rebook")).toBe(keys.indexOf("utilization") + 1);
    const r = doc.sections.find((s) => s.key === "rebook")!;
    expect(r.link?.href).toBe(`https://rayz.test/admin/reports/rebook?from=2026-10-18&to=2026-10-24&shop=${CORAL.id}&shop=${ROCK.id}`);
    expect(r.blocks[0]).toMatchObject({ kind: "metrics", rows: [{ label: "Rebook rate", day: "60%", dayChange: "▲ 10 pts", wtd: "50%" }, { label: "New-client rebook rate" }, { label: "Visits rebooked" }, { label: "Visits" }] });
    expect(r.blocks).toContainEqual({ kind: "note", text: "Brand average: 55% on the day, 47% week to date." });
    expect(r.blocks).toContainEqual(expect.objectContaining({ kind: "table", title: "By barber", rows: [["Makenna", "75%", "8", "60%", "30", "+13 pts"]] }));
    expect(r.blocks).toContainEqual({ kind: "note", text: "140 appointments on the books. 2nd-visit retention: 65% of 40 new clients first seen Jul 27–Aug 25 came back within 60 days (brand 60%)." });
    expect(renderMorningSms(d)).toContain("; 1 no-show; 60% rebooked; today");
    expect(renderMorningText(d).body).toContain("REBOOK RATE\nLeft with their next visit booked\n  Rebook rate: 60% (▲ 10 pts)".replace("▲", "+"));
    const none = morningDoc({ ...d, rebook: { ...d.rebook!, secondVisit: { from: "2026-07-27", to: "2026-08-25", judged: 0, back: 0, brand: null } } });
    expect(none.sections.find((s) => s.key === "rebook")!.blocks).toContainEqual({ kind: "note", text: "140 appointments on the books." });
  });

  it("renders a PDF", () => {
    const pdf = renderMorningPdf(dash());
    expect(Buffer.from(pdf.slice(0, 5)).toString()).toBe("%PDF-");
    expect(pdf.length).toBeGreaterThan(2_000);
  });
});
