/**
 * The Morning Dashboard laid out once (headline tiles and sections of metric rows, tables, bar
 * charts and lists) and rendered from that layout as the in-app page, a mobile-friendly HTML email,
 * plain text, a PDF and a one-line text message. Pure: no database, no clock.
 */
import { formatDate } from "@/lib/time";
import { PdfDoc, fitText } from "@/lib/pdf";
import {
  Cmp,
  EXCEPTION_CATEGORIES,
  EXCEPTION_LABEL,
  MorningDashboard,
  MorningSection,
  PphFigures,
  SECTION_LABEL,
  SEVERITY_RANK,
  ShopRef,
  appLink,
  change,
  changeLabel,
  changeWords,
  cmpOf,
  dashboardLink,
  dollars,
  handleCount,
  hoursLabel,
  minLabel,
  money,
  pctLabel,
  periodLabels,
  plural,
  reportLink,
  urgentCount,
} from "./morning-dashboard";
import { PPH_LABEL, type PphMeasure, pphCents, pphOf, pphText } from "./pph";
import { ptsLabel } from "./rebook";

/** `hours` values are minutes, shown as hours. */
export type ValueKind = "money" | "int" | "pct" | "minutes" | "hours";
export type Tone = "good" | "bad" | "neutral";

export interface MetricRow {
  label: string;
  day: string;
  dayChange: string;
  dayTone: Tone;
  wtd: string;
  wtdChange: string;
  wtdTone: Tone;
}

export type Block =
  | { kind: "metrics"; rows: MetricRow[] }
  /** `narrow`: the columns a phone-width email keeps; every column otherwise. */
  | { kind: "table"; title?: string; columns: string[]; rows: string[][]; numeric: boolean[]; narrow?: number[] }
  | { kind: "bars"; title: string; legend?: [string, string]; rows: { label: string; value: number; valueLabel: string; prior?: number }[] }
  | { kind: "list"; title?: string; items: { title: string; detail?: string; severity?: "high" | "medium" | "low"; href?: string }[] }
  | { kind: "note"; text: string };

export interface DocSection {
  key: MorningSection | "saved_reports";
  title: string;
  subtitle?: string;
  link?: { label: string; href: string };
  blocks: Block[];
}

export interface Tile {
  label: string;
  value: string;
  change: string;
  tone: Tone;
  sub: string;
}

export interface MorningDoc {
  subject: string;
  title: string;
  dateLabel: string;
  versionLabel: string;
  coverage: string;
  tiles: Tile[];
  sections: DocSection[];
  dashboardUrl: string;
  settingsUrl: string;
}

const fmt = (k: ValueKind, v: number) =>
  k === "money" ? money(v) : k === "pct" ? pctLabel(v) : k === "minutes" ? minLabel(v) : k === "hours" ? hoursLabel(v) : Math.round(v).toLocaleString("en-US");

function tone(cur: number, prev: number, inverse: boolean): Tone {
  const c = change(cur, prev);
  if (c === null || Math.round(c * 100) === 0) return "neutral";
  return c > 0 !== inverse ? "good" : "bad";
}

/** Percentages compare in points, not percent of percent. */
function pctChange(cur: number, prev: number) {
  if (!prev && !cur) return "—";
  const pts = Math.round((cur - prev) * 100);
  return pts === 0 ? "even" : `${pts > 0 ? "▲" : "▼"} ${Math.abs(pts)} pts`;
}

function metric(label: string, c: Cmp, k: ValueKind, inverse = false): MetricRow {
  const ch = k === "pct" ? pctChange : changeLabel;
  return {
    label,
    day: fmt(k, c.day),
    dayChange: ch(c.day, c.prior),
    dayTone: tone(c.day, c.prior, inverse),
    wtd: fmt(k, c.wtd),
    wtdChange: ch(c.wtd, c.wtdPrior),
    wtdTone: tone(c.wtd, c.wtdPrior, inverse),
  };
}

const shopNames = (xs: readonly ShopRef[]) => xs.map((s) => s.name).join(", ");

/** The note under a section that covers fewer shops than the version (missing report permissions). */
function partial(d: MorningDashboard, shops: readonly ShopRef[]): Block[] {
  return shops.length < d.version.shops.length ? [{ kind: "note", text: `Covers ${shopNames(shops)}: the shops where you can see this report.` }] : [];
}

/** Emails list the top barbers and the first few items of each kind to handle; the page and PDF list everything. */
export const EMAIL_BARBER_ROWS = 15;
export const EMAIL_EXCEPTION_ROWS = 5;

export function morningDoc(d: MorningDashboard, o: { barberRows?: number; exceptionRows?: number } = {}): MorningDoc {
  const cap = <T,>(xs: T[]): { rows: T[]; more: Block[] } =>
    o.barberRows && xs.length > o.barberRows ? { rows: xs.slice(0, o.barberRows), more: [{ kind: "note", text: `And ${xs.length - o.barberRows} more on the dashboard.` }] } : { rows: xs, more: [] };
  const L = periodLabels(d.periods);
  const p = d.periods;
  const sections: DocSection[] = [];
  const tiles: Tile[] = [];
  const s = d.sales;
  const u = d.utilization;
  const t = d.traffic;
  if (s) {
    tiles.push({ label: "Net sales", value: dollars(s.net.day), change: changeLabel(s.net.day, s.net.prior), tone: tone(s.net.day, s.net.prior, false), sub: `WTD ${dollars(s.net.wtd)} · ${changeWords(s.net.wtd, s.net.wtdPrior)}` });
    tiles.push({ label: "Tickets", value: s.tickets.day.toLocaleString("en-US"), change: changeLabel(s.tickets.day, s.tickets.prior), tone: tone(s.tickets.day, s.tickets.prior, false), sub: `Avg ticket ${money(s.avgTicket.day)}` });
  }
  if (u) tiles.push({ label: "Utilization", value: pctLabel(u.utilization.day), change: pctChange(u.utilization.day, u.utilization.prior), tone: tone(u.utilization.day, u.utilization.prior, false), sub: `${hoursLabel(u.booked.day)} of ${hoursLabel(u.available.day)} booked` });
  if (t) tiles.push({ label: "No-shows", value: t.noShows.day.toLocaleString("en-US"), change: changeLabel(t.noShows.day, t.noShows.prior), tone: tone(t.noShows.day, t.noShows.prior, true), sub: `${plural(t.cancellations.day, "cancellation")}` });
  const ex = d.exceptions;
  const urgent = urgentCount(d);
  const toHandle = handleCount(d);

  if (ex) {
    const items = [...ex.items].sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);
    const blocks: Block[] = [];
    for (const c of EXCEPTION_CATEGORIES) {
      const mine = items.filter((i) => i.category === c);
      if (!mine.length) continue;
      const shown = o.exceptionRows ? mine.slice(0, o.exceptionRows) : mine;
      blocks.push({ kind: "list", title: EXCEPTION_LABEL[c], items: shown.map((i) => ({ title: `${i.shop ? `${i.shop}: ` : ""}${i.title}`, detail: i.detail, severity: i.severity, href: appLink(d, i.href) })) });
      if (shown.length < mine.length) blocks.push({ kind: "note", text: `And ${mine.length - shown.length} more on the dashboard.` });
    }
    const clear = ex.categories.filter((c) => !items.some((i) => i.category === c));
    if (clear.length) blocks.push({ kind: "note", text: `All clear: ${clear.map((c) => EXCEPTION_LABEL[c].toLowerCase()).join(", ")}.` });
    sections.push({ key: "exceptions", title: SECTION_LABEL.exceptions, subtitle: toHandle ? `${toHandle} to handle${urgent ? `, ${urgent} urgent` : ""}` : "Nothing to handle", blocks });
  }

  if (d.today) {
    const blocks: Block[] = [];
    if (d.today.clients?.length) blocks.push({ kind: "list", title: "Clients booked today", items: d.today.clients.map((x) => ({ title: `${x.label} booked today` })) });
    for (const sh of d.today.shops) {
      if (!sh.open) {
        blocks.push({ kind: "note", text: `${sh.shop.name}: ${sh.hours}.` });
        continue;
      }
      blocks.push({
        kind: "table",
        title: `${sh.shop.name} · ${sh.hours} · ${plural(sh.appointments, "appointment")} · ${hoursLabel(sh.openMin)} open`,
        columns: ["Barber", "Hours", "Booked", "Open time"],
        numeric: [false, false, true, false],
        rows: sh.barbers.length
          ? sh.barbers.map((b) => [`${b.label}${b.partlyOff ? " (part off)" : ""}`, b.hours, String(b.booked), b.open.length ? `${hoursLabel(b.openMin)}: ${b.open.join(", ")}` : "Fully booked"])
          : [["Nobody is scheduled", "", "", ""]],
      });
      const away = [...sh.callIns.map((c) => `${c.label} called in (${c.kind}${c.when ? `, ${c.when}` : ""})`), ...sh.off.map((o) => `${o.label} off${o.why ? ` (${o.why})` : ""}`)];
      if (away.length) blocks.push({ kind: "note", text: `${sh.shop.name} out today: ${away.join("; ")}.` });
    }
    sections.push({ key: "today", title: `${SECTION_LABEL.today}: ${L.today}`, link: { label: "Calendar", href: appLink(d, "/admin/calendar") }, blocks });
  }

  if (d.milestones) {
    const m = d.milestones;
    const blocks: Block[] = [];
    if (m.achieved.length) blocks.push({ kind: "list", title: "Reached", items: m.achieved.map((x) => ({ title: x.text, detail: [x.shop, formatDate(x.on, "EEE MMM d")].filter(Boolean).join(", ") })) });
    if (m.upcoming.length) blocks.push({ kind: "list", title: "Coming up", items: m.upcoming.map((x) => ({ title: x.text })) });
    sections.push({ key: "milestones", title: SECTION_LABEL.milestones, subtitle: "Worth a shout-out", link: { label: "Milestones", href: appLink(d, "/admin/milestones") }, blocks });
  }

  if (s) {
    const blocks: Block[] = [
      {
        kind: "metrics",
        rows: [
          metric("Gross sales", s.gross, "money"),
          metric("Net sales", s.net, "money"),
          metric("Services", s.services, "money"),
          metric("Products", s.products, "money"),
          metric("Tips", s.tips, "money"),
          metric("Card fees", s.cardFees, "money", true),
          metric("Refunds", s.refunds, "money", true),
          ...(s.voids ? [metric("Voids", s.voids, "money", true)] : []),
          metric("Tickets", s.tickets, "int"),
          metric("Average ticket", s.avgTicket, "money"),
        ],
      },
    ];
    const days = s.daily.filter((x) => x.net || x.prior);
    if (days.length > 1)
      blocks.push({
        kind: "bars",
        title: "Net sales by day, this week against last",
        legend: ["This week", "Last week"],
        rows: days.map((x) => ({ label: formatDate(x.date, "EEE"), value: x.net, valueLabel: dollars(x.net), prior: x.prior })),
      });
    if (s.byShop.length > 1)
      blocks.push({
        kind: "bars",
        title: `Net sales by location, ${L.dayShort}`,
        rows: [...s.byShop].sort((a, b) => b.net.day - a.net.day).map((x) => ({ label: x.shop.name, value: x.net.day, valueLabel: `${dollars(x.net.day)} · ${changeLabel(x.net.day, x.net.prior)}`, prior: x.net.prior })),
      });
    if (s.byBarber?.length) {
      const c = cap(s.byBarber);
      blocks.push({
        kind: "table",
        title: s.ownOnly ? "Your sales" : "By barber",
        columns: ["Barber", "Net", "Services", "Products", "Tips", "Tickets", "WTD net"],
        numeric: [false, true, true, true, true, true, true],
        narrow: [0, 1, 4, 5, 6],
        rows: c.rows.map((b) => [b.label, money(b.net), money(b.services), money(b.products), money(b.tips), String(b.tickets), money(b.netWtd)]),
      });
      blocks.push(...c.more);
    }
    sections.push({ key: "sales", title: SECTION_LABEL.sales, subtitle: `${L.day} against ${L.prior}; ${L.wtd.toLowerCase()} against the same days last week`, link: { label: "Sales summary", href: reportLink(d, "/admin/reports/sales", p.reportDay, p.reportDay, s.shops) }, blocks: [...blocks, ...partial(d, s.shops)] });
  }

  if (t)
    sections.push({
      key: "traffic",
      title: SECTION_LABEL.traffic,
      link: { label: "KPIs", href: reportLink(d, "/admin/reports/kpis", p.reportDay, p.reportDay, t.shops) },
      blocks: [
        {
          kind: "metrics",
          rows: [
            metric("New clients", t.newClients, "int"),
            metric("Returning clients", t.returningClients, "int"),
            metric("Bookings made", t.bookingsMade, "int"),
            metric("  Online", t.online, "int"),
            metric("  Walk-in", t.walkIns, "int"),
            metric("  Front desk", t.frontDesk, "int"),
            metric("Appointments", t.visits, "int"),
            metric("Cancellations", t.cancellations, "int", true),
            metric("No-shows", t.noShows, "int", true),
          ],
        },
        ...partial(d, t.shops),
      ],
    });

  if (u) {
    const blocks: Block[] = [{ kind: "metrics", rows: [metric("Utilization", u.utilization, "pct"), metric("Hours booked", u.booked, "hours"), metric("Hours available", u.available, "hours")] }];
    if (u.cutTimes) blocks.push({ kind: "note", text: `Average cut ${minLabel(u.cutTimes.avgActualMin)} against ${minLabel(u.cutTimes.avgBookedMin)} booked, over ${plural(u.cutTimes.n, "timed service")}.` });
    const c = cap(u.barbers);
    if (u.barbers.length)
      blocks.push({
        kind: "table",
        title: u.ownOnly ? "Your time" : "By barber",
        columns: u.cutTimes ? ["Barber", "Booked", "Available", "Utilization", "WTD", "Avg cut", "Booked for"] : ["Barber", "Booked", "Available", "Utilization", "WTD"],
        numeric: [false, true, true, true, true, true, true],
        narrow: u.cutTimes ? [0, 3, 4, 5, 6] : [0, 1, 3, 4],
        rows: c.rows.map((b) => [
          b.label,
          hoursLabel(b.bookedMin),
          hoursLabel(b.availableMin),
          pctLabel(b.utilization),
          pctLabel(b.utilizationWtd),
          ...(u.cutTimes ? [minLabel(b.avgActualMin), minLabel(b.avgBookedMin)] : []),
        ]),
      });
    blocks.push(...c.more);
    sections.push({ key: "utilization", title: SECTION_LABEL.utilization, link: { label: "Barber performance", href: reportLink(d, "/admin/reports/barbers", p.reportDay, p.reportDay, u.shops) }, blocks: [...blocks, ...partial(d, u.shops)] });
  }

  if (d.pph) {
    const x = d.pph;
    const P = (f: PphFigures) => pphCents(f.service, f.product, f.centi);
    const at = (per: "day" | "prior" | "wtd" | "wtdPrior"): PphFigures => ({ centi: x.centi[per], service: x.service[per], product: x.product[per] });
    const row = (label: string, m: PphMeasure): MetricRow => {
      const v = (per: "day" | "prior" | "wtd" | "wtdPrior") => pphOf(P(at(per)), m);
      const ch = (cur: number | null, prev: number | null) => (cur === null || prev === null ? "—" : changeLabel(cur, prev));
      const tn = (cur: number | null, prev: number | null) => (cur === null || prev === null ? "neutral" : tone(cur, prev, false));
      return { label, day: pphText(v("day"), money), dayChange: ch(v("day"), v("prior")), dayTone: tn(v("day"), v("prior")), wtd: pphText(v("wtd"), money), wtdChange: ch(v("wtd"), v("wtdPrior")), wtdTone: tn(v("wtd"), v("wtdPrior")) };
    };
    const blocks: Block[] = [
      {
        kind: "metrics",
        rows: [row(PPH_LABEL.service, "service"), row(PPH_LABEL.product, "product"), row(PPH_LABEL.total, "total"), metric("Worked hours", cmpOf((per) => x.centi[per] * 0.6), "hours")],
      },
    ];
    if (x.brand)
      blocks.push({ kind: "note", text: `Brand service PPH: ${pphText(P(x.brand.day).servicePph, money)} on the day, ${pphText(P(x.brand.wtd).servicePph, money)} week to date.` });
    if (x.byShop.length > 1)
      blocks.push({
        kind: "table",
        title: "By location",
        columns: ["Location", `Service PPH ${L.dayShort}`, "WTD service PPH", "WTD total PPH"],
        numeric: [false, true, true, true],
        rows: x.byShop.map((s) => [s.shop.name, pphText(P(s.day).servicePph, money), pphText(P(s.wtd).servicePph, money), pphText(P(s.wtd).totalPph, money)]),
      });
    const c = cap(x.byBarber);
    if (x.byBarber.length)
      blocks.push({
        kind: "table",
        title: x.ownOnly ? "Your PPH" : "By barber, highest week-to-date service PPH first",
        columns: ["Barber", `Service PPH ${L.dayShort}`, "WTD service PPH", "WTD product PPH", "WTD total PPH", "WTD hours"],
        numeric: [false, true, true, true, true, true],
        narrow: [0, 1, 2, 4],
        rows: c.rows.map((b) => [b.label, pphText(P(b.day).servicePph, money), pphText(P(b.wtd).servicePph, money), pphText(P(b.wtd).productPph, money), pphText(P(b.wtd).totalPph, money), hoursLabel(b.wtd.centi * 0.6)]),
      });
    blocks.push(...c.more);
    sections.push({
      key: "pph",
      title: SECTION_LABEL.pph,
      subtitle: "Sales before tax and tips per clocked worked hour; N/A with no hours",
      link: { label: "PPH report", href: reportLink(d, "/admin/reports/pph", p.wtdFrom, p.reportDay, x.shops) },
      blocks: [...blocks, ...partial(d, x.shops)],
    });
  }

  if (d.rebook) {
    const r = d.rebook;
    const blocks: Block[] = [
      {
        kind: "metrics",
        rows: [metric("Rebook rate", r.rebook, "pct"), metric("New-client rebook rate", r.newRebook, "pct"), metric("Visits rebooked", r.rebooked, "int"), metric("Visits", r.visits, "int")],
      },
    ];
    if (r.brand) blocks.push({ kind: "note", text: `Brand average: ${pctLabel(r.brand.day)} on the day, ${pctLabel(r.brand.wtd)} week to date.` });
    const c = cap(r.byBarber ?? []);
    if (r.byBarber?.length)
      blocks.push({
        kind: "table",
        title: r.ownOnly ? "Your rebook rate" : "By barber",
        columns: ["Barber", L.dayShort, "Visits", "WTD", "WTD visits", ...(r.brand ? ["WTD vs brand"] : [])],
        numeric: [false, true, true, true, true, false],
        narrow: r.brand ? [0, 1, 3, 5] : [0, 1, 3],
        rows: c.rows.map((b) => [b.label, pctLabel(b.rate), String(b.visits), pctLabel(b.wtdRate), String(b.wtdVisits), ...(r.brand ? [ptsLabel(b.wtdRate, r.brand.wtd) ?? "—"] : [])]),
      });
    blocks.push(...c.more);
    const sv = r.secondVisit;
    blocks.push({
      kind: "note",
      text: `${plural(r.future, "appointment")} on the books.${sv.judged ? ` 2nd-visit retention: ${pctLabel(sv.back / sv.judged)} of ${plural(sv.judged, "new client")} first seen ${formatDate(sv.from, "MMM d")}–${formatDate(sv.to, "MMM d")} came back within 60 days${sv.brand !== null ? ` (brand ${pctLabel(sv.brand)})` : ""}.` : ""}`,
    });
    sections.push({
      key: "rebook",
      title: SECTION_LABEL.rebook,
      subtitle: "Left with their next visit booked",
      link: { label: "Rebook rate", href: reportLink(d, "/admin/reports/rebook", p.wtdFrom, p.reportDay, r.shops) },
      blocks: [...blocks, ...partial(d, r.shops)],
    });
  }

  if (d.loyalty) {
    const lo = d.loyalty.loyalty;
    const gc = d.loyalty.giftCards;
    const rows: MetricRow[] = [];
    if (lo) rows.push(metric("Loyalty rewards earned", lo.rewardsIssued, "int"), metric("Rewards redeemed", lo.rewardsRedeemed, "int"), metric("Rewards value redeemed", lo.redeemedCents, "money"), metric("Clients earning", lo.members, "int"));
    if (gc) rows.push(metric("Gift cards sold", gc.soldN, "int"), metric("Gift card sales", gc.soldCents, "money"), metric("Gift cards redeemed", gc.redeemedCents, "money"));
    const blocks: Block[] = [{ kind: "metrics", rows }];
    if (gc) blocks.push({ kind: "note", text: `Still owed on gift cards issued here: ${money(gc.outstandingCents)}.` });
    const link = lo ? { label: "Loyalty", href: reportLink(d, "/admin/reports/loyalty", p.reportDay, p.reportDay, lo.shops) } : { label: "Gift cards", href: reportLink(d, "/admin/reports/gift-cards", p.reportDay, p.reportDay, gc!.shops) };
    sections.push({ key: "loyalty", title: SECTION_LABEL.loyalty, link, blocks: [...blocks, ...partial(d, lo?.shops ?? gc!.shops)] });
  }

  if (d.marketing) {
    const m = d.marketing;
    sections.push({
      key: "marketing",
      title: m.openingsOnly ? "We have openings" : SECTION_LABEL.marketing,
      subtitle: "Messages sent on the day, and the bookings, redemptions and revenue credited to them so far",
      link: m.openingsOnly ? { label: "Openings report", href: reportLink(d, "/admin/reports/openings", p.reportDay, p.reportDay, m.shops) } : { label: "Campaign Center report", href: reportLink(d, "/admin/reports/campaign-center", p.reportDay, p.reportDay, m.shops) },
      blocks: [
        { kind: "metrics", rows: [metric("Sends", m.sends, "int"), metric("Clicks", m.clicks, "int"), metric("Bookings", m.bookings, "int"), metric("Coupon redemptions", m.redemptions, "int"), metric("Attributed revenue", m.revenue, "money")] },
        ...partial(d, m.shops),
      ],
    });
  }

  if (d.reviews) {
    const r = d.reviews;
    const blocks: Block[] = [{ kind: "metrics", rows: [metric("Review link clicks", r.clicks, "int"), metric("Review follow-ups sent", r.followUps, "int")] }];
    if (r.byShop.length > 1) blocks.push({ kind: "bars", title: `Clicks by location, ${L.dayShort}`, rows: [...r.byShop].sort((a, b) => b.clicks.day - a.clicks.day).map((x) => ({ label: x.shop.name, value: x.clicks.day, valueLabel: String(x.clicks.day), prior: x.clicks.prior })) });
    sections.push({ key: "reviews", title: SECTION_LABEL.reviews, link: { label: "Reviews report", href: reportLink(d, "/admin/reports/reviews", p.reportDay, p.reportDay, r.shops) }, blocks: [...blocks, ...partial(d, r.shops)] });
  }

  if (d.savedReports?.length)
    sections.push({
      key: "saved_reports",
      title: "Your custom reports",
      subtitle: "Totals as of this morning, for the dates each report covers",
      link: { label: "Custom reports", href: appLink(d, "/admin/reports/custom") },
      blocks: [{ kind: "list", items: d.savedReports.map((r) => ({ title: r.name, detail: r.lines.join(" · "), href: appLink(d, r.href) })) }],
    });

  const skipped = p.skipped.length ? ` (${p.skipped.map((x) => formatDate(x, "EEEE")).join(", ")} closed)` : "";
  const headline = s ? `: ${dollars(s.net.day)} net, ${changeWords(s.net.day, s.net.prior)}` : "";
  const flag = urgent ? ` · ${urgent} urgent` : toHandle ? ` · ${toHandle} to handle` : "";
  return {
    subject: `Morning Dashboard ${formatDate(p.today, "EEE MMM d")}${d.version.scope === "all" ? "" : ` · ${d.version.label}`}${headline}${flag}`,
    title: `Good morning, ${d.firstName}`,
    dateLabel: L.today,
    versionLabel: d.version.label,
    coverage: `Numbers for ${L.day}${skipped}, against ${L.prior}.`,
    tiles,
    sections,
    dashboardUrl: dashboardLink(d),
    settingsUrl: appLink(d, "/admin/digest"),
  };
}

// ───────────────────────────── Plain text ─────────────────────────────

export function renderMorningText(d: MorningDashboard): { subject: string; body: string } {
  const doc = morningDoc(d, { barberRows: EMAIL_BARBER_ROWS, exceptionRows: EMAIL_EXCEPTION_ROWS });
  const lines: string[] = [`${doc.title},`, "", `${doc.dateLabel} · ${doc.versionLabel}`, doc.coverage];
  if (doc.tiles.length) {
    lines.push("");
    for (const t of doc.tiles) lines.push(`${t.label}: ${t.value} (${t.change.replace("▲", "up").replace("▼", "down")})  ${t.sub}`);
  }
  for (const s of doc.sections) {
    lines.push("", s.title.toUpperCase());
    if (s.subtitle) lines.push(s.subtitle);
    for (const b of s.blocks) lines.push(...textBlock(b));
    if (s.link) lines.push(`  ${s.link.label}: ${s.link.href}`);
  }
  lines.push("", `Open the dashboard: ${doc.dashboardUrl}`, "", `You get this because you manage one or more of the shops. The brand chooses who gets it under Setup → Morning Dashboard email: ${doc.settingsUrl}`);
  return { subject: doc.subject, body: lines.join("\n").replace(/[▲▼]/g, (m) => (m === "▲" ? "+" : "-")) };
}

function textBlock(b: Block): string[] {
  switch (b.kind) {
    case "metrics":
      return b.rows.map((r) => `  ${r.label.trim()}: ${r.day} (${r.dayChange}) · WTD ${r.wtd} (${r.wtdChange})`);
    case "table":
      return [...(b.title ? [`  ${b.title}`] : []), ...b.rows.map((r) => `    ${r.filter(Boolean).join(" · ")}`)];
    case "bars":
      return [`  ${b.title}`, ...b.rows.map((r) => `    ${r.label}: ${r.valueLabel}`)];
    case "list":
      return [...(b.title ? [`  ${b.title}`] : []), ...b.items.flatMap((i) => [`  ${i.severity === "high" ? "!" : "-"} ${i.title}`, ...(i.detail ? [`      ${i.detail}`] : [])])];
    case "note":
      return [`  ${b.text}`];
  }
}

// ───────────────────────────── Text message ─────────────────────────────

/** One line for a text: the headline numbers, today's open time, what needs attention, and the link. */
export function renderMorningSms(d: MorningDashboard): string {
  const L = periodLabels(d.periods);
  const parts: string[] = [];
  if (d.sales) parts.push(`${dollars(d.sales.net.day)} net (${changeWords(d.sales.net.day, d.sales.net.prior)} vs ${L.prior}), ${plural(d.sales.tickets.day, "ticket")}`);
  if (d.sales) parts.push(`WTD ${dollars(d.sales.net.wtd)}`);
  if (d.traffic && d.traffic.noShows.day) parts.push(plural(d.traffic.noShows.day, "no-show"));
  if (d.rebook?.visits.day) parts.push(`${pctLabel(d.rebook.rebook.day)} rebooked`);
  if (d.today) {
    const working = d.today.shops.reduce((a, s) => a + s.barbers.length, 0);
    const open = d.today.shops.reduce((a, s) => a + s.openMin, 0);
    parts.push(`today ${plural(working, "barber")}, ${hoursLabel(open)} open`);
    const first = d.today.clients?.[0];
    if (first) parts.push(`${first.label} booked`);
  }
  const ms = d.milestones?.achieved[0] ?? d.milestones?.upcoming[0];
  if (ms) parts.push(ms.text);
  const n = handleCount(d);
  if (n) {
    const u = urgentCount(d);
    parts.push(`${n} to handle${u ? ` (${u} urgent)` : ""}`);
  }
  const who = d.version.scope === "all" ? "" : ` ${d.version.label}`;
  return `Ray'z${who} ${formatDate(d.periods.reportDay, "EEE M/d")}: ${parts.join("; ") || "nothing to report"}. ${dashboardLink(d)}`;
}

// ───────────────────────────── HTML email ─────────────────────────────

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
const C = { ink: "#18181b", sub: "#52525b", faint: "#a1a1aa", line: "#e4e4e7", bg: "#f4f4f5", card: "#ffffff", good: "#15803d", goodBg: "#dcfce7", bad: "#b91c1c", badBg: "#fee2e2", flat: "#52525b", flatBg: "#f4f4f5", bar: "#18181b", barPrior: "#d4d4d8", accent: "#b45309" };
const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

function chip(text: string, t: Tone) {
  const [fg, bg] = t === "good" ? [C.good, C.goodBg] : t === "bad" ? [C.bad, C.badBg] : [C.flat, C.flatBg];
  return `<span style="display:inline-block;padding:1px 6px;border-radius:9px;background:${bg};color:${fg};font-size:11px;font-weight:600;white-space:nowrap">${esc(text)}</span>`;
}

function bar(value: number, max: number, color: string, height = 8) {
  const w = max > 0 ? Math.max(0, Math.min(100, Math.round((value / max) * 100))) : 0;
  if (w === 0) return `<div style="height:${height}px;line-height:${height}px;font-size:0">&nbsp;</div>`;
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse"><tr><td width="${w}%" style="background:${color};height:${height}px;line-height:${height}px;font-size:0;border-radius:2px">&nbsp;</td>${w < 100 ? `<td style="font-size:0">&nbsp;</td>` : ""}</tr></table>`;
}

const hide = (b: Extract<Block, { kind: "table" }>, i: number) => (b.narrow && !b.narrow.includes(i) ? ' class="m-hide"' : "");

function htmlBlock(b: Block): string {
  switch (b.kind) {
    case "metrics":
      return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;font-size:13px">
<tr><td style="padding:4px 0;color:${C.faint};font-size:11px">&nbsp;</td><td align="right" style="padding:4px 6px;color:${C.faint};font-size:11px">Day</td><td style="padding:4px 0"></td><td align="right" style="padding:4px 6px;color:${C.faint};font-size:11px">Week to date</td><td style="padding:4px 0"></td></tr>
${b.rows
  .map(
    (r) =>
      `<tr><td style="padding:5px 0;border-top:1px solid ${C.line};color:${r.label.startsWith(" ") ? C.sub : C.ink};${r.label.startsWith(" ") ? "padding-left:12px;" : ""}">${esc(r.label.trim())}</td><td align="right" style="padding:5px 6px;border-top:1px solid ${C.line};font-weight:600;white-space:nowrap">${esc(r.day)}</td><td align="right" style="padding:5px 0;border-top:1px solid ${C.line}">${chip(r.dayChange, r.dayTone)}</td><td align="right" style="padding:5px 6px;border-top:1px solid ${C.line};white-space:nowrap">${esc(r.wtd)}</td><td align="right" style="padding:5px 0;border-top:1px solid ${C.line}">${chip(r.wtdChange, r.wtdTone)}</td></tr>`,
  )
  .join("\n")}
</table>`;
    case "table":
      return `${b.title ? `<div style="margin:14px 0 6px;font-size:13px;font-weight:600;color:${C.ink}">${esc(b.title)}</div>` : ""}<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;font-size:12px">
<tr>${b.columns.map((c, i) => `<td${hide(b, i)}${b.numeric[i] ? ' align="right"' : ""} style="padding:4px 4px;color:${C.faint};font-size:11px;border-bottom:1px solid ${C.line}">${esc(c)}</td>`).join("")}</tr>
${b.rows.map((r) => `<tr>${r.map((c, i) => `<td${hide(b, i)}${b.numeric[i] ? ' align="right"' : ""} style="padding:5px 4px;border-bottom:1px solid ${C.line};color:${i === 0 ? C.ink : C.sub};${b.numeric[i] ? "white-space:nowrap;" : ""}">${esc(c)}</td>`).join("")}</tr>`).join("\n")}
</table>`;
    case "bars": {
      const max = Math.max(1, ...b.rows.map((r) => Math.max(r.value, r.prior ?? 0)));
      const legend = b.legend
        ? `<span style="font-weight:400;color:${C.faint};font-size:11px">&nbsp;&nbsp;<span style="display:inline-block;width:8px;height:8px;background:${C.bar}"></span> ${esc(b.legend[0])} &nbsp;<span style="display:inline-block;width:8px;height:8px;background:${C.barPrior}"></span> ${esc(b.legend[1])}</span>`
        : "";
      return `<div style="margin:14px 0 6px;font-size:13px;font-weight:600;color:${C.ink}">${esc(b.title)}${legend}</div><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;font-size:12px">
${b.rows
  .map(
    (r) =>
      `<tr><td width="28%" style="padding:3px 6px 3px 0;color:${C.sub};white-space:nowrap;overflow:hidden">${esc(r.label)}</td><td style="padding:3px 0">${bar(r.value, max, C.bar)}${r.prior !== undefined ? `<div style="height:2px;font-size:0;line-height:2px">&nbsp;</div>${bar(r.prior, max, C.barPrior, 5)}` : ""}</td><td width="30%" align="right" style="padding:3px 0 3px 6px;color:${C.ink};white-space:nowrap">${esc(r.valueLabel)}</td></tr>`,
  )
  .join("\n")}
</table>`;
    }
    case "list":
      return `${b.title ? `<div style="margin:12px 0 4px;font-size:13px;font-weight:600;color:${C.ink}">${esc(b.title)}</div>` : ""}${b.items
        .map((i) => {
          const dot = i.severity === "high" ? C.bad : i.severity === "medium" ? C.accent : C.faint;
          const title = i.href ? `<a href="${esc(i.href)}" style="color:${C.ink};text-decoration:none">${esc(i.title)}</a>` : esc(i.title);
          return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;font-size:13px"><tr><td width="14" valign="top" style="padding:6px 0"><div style="width:8px;height:8px;border-radius:4px;background:${dot};margin-top:4px"></div></td><td style="padding:5px 0;border-bottom:1px solid ${C.line}">${title}${i.detail ? `<div style="color:${C.sub};font-size:12px;margin-top:2px">${esc(i.detail)}</div>` : ""}</td></tr></table>`;
        })
        .join("\n")}`;
    case "note":
      return `<div style="margin:8px 0;color:${C.sub};font-size:12px">${esc(b.text)}</div>`;
  }
}

function htmlTile(t: Tile) {
  return `<td width="50%" valign="top" style="padding:6px"><div style="background:${C.card};border:1px solid ${C.line};border-radius:10px;padding:12px">
<div style="font-size:11px;color:${C.sub};text-transform:uppercase;letter-spacing:.04em">${esc(t.label)}</div>
<div style="font-size:24px;font-weight:700;color:${C.ink};margin:4px 0">${esc(t.value)} ${chip(t.change, t.tone)}</div>
<div style="font-size:12px;color:${C.sub}">${esc(t.sub)}</div></div></td>`;
}

export function renderMorningHtml(d: MorningDashboard): string {
  const doc = morningDoc(d, { barberRows: EMAIL_BARBER_ROWS, exceptionRows: EMAIL_EXCEPTION_ROWS });
  const tileRows: string[] = [];
  for (let i = 0; i < doc.tiles.length; i += 2) tileRows.push(`<tr>${htmlTile(doc.tiles[i])}${doc.tiles[i + 1] ? htmlTile(doc.tiles[i + 1]) : '<td width="50%"></td>'}</tr>`);
  const sections = doc.sections
    .map(
      (s) => `<tr><td style="padding:8px 12px"><div style="background:${C.card};border:1px solid ${C.line};border-radius:10px;padding:14px 16px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse"><tr><td style="font-size:16px;font-weight:700;color:${C.ink}">${esc(s.title)}</td>${s.link ? `<td align="right" style="font-size:12px;white-space:nowrap"><a href="${esc(s.link.href)}" style="color:${C.accent};text-decoration:none;font-weight:600">${esc(s.link.label)} &rsaquo;</a></td>` : ""}</tr></table>
${s.subtitle ? `<div style="font-size:12px;color:${C.sub};margin:2px 0 6px">${esc(s.subtitle)}</div>` : ""}
${s.blocks.map(htmlBlock).join("\n")}
</div></td></tr>`,
    )
    .join("\n");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="x-apple-disable-message-reformatting"><title>${esc(doc.subject)}</title>
<style>@media (max-width:480px){.wrap{width:100%!important}.tiles td{display:block!important;width:100%!important;box-sizing:border-box}.m-hide{display:none!important}}</style></head>
<body style="margin:0;padding:0;background:${C.bg};font-family:${FONT};color:${C.ink}">
<div style="display:none;max-height:0;overflow:hidden;color:${C.bg}">${esc(doc.coverage)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.bg}"><tr><td align="center" style="padding:16px 8px">
<table role="presentation" class="wrap" width="600" cellpadding="0" cellspacing="0" style="width:600px;max-width:100%;border-collapse:collapse">
<tr><td style="padding:18px 16px;background:${C.ink};border-radius:12px 12px 0 0;color:#fff">
<div style="font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:#d4d4d8">Ray'z Barber Shop · Morning Dashboard</div>
<div style="font-size:22px;font-weight:700;margin-top:6px">${esc(doc.title)}</div>
<div style="font-size:13px;color:#e4e4e7;margin-top:4px">${esc(doc.dateLabel)} · ${esc(doc.versionLabel)}</div>
<div style="font-size:12px;color:#a1a1aa;margin-top:2px">${esc(doc.coverage)}</div>
</td></tr>
${doc.tiles.length ? `<tr><td style="padding:8px 6px 0"><table role="presentation" class="tiles" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse">${tileRows.join("")}</table></td></tr>` : ""}
${sections}
<tr><td align="center" style="padding:16px 12px 8px"><a href="${esc(doc.dashboardUrl)}" style="display:inline-block;background:${C.ink};color:#fff;text-decoration:none;font-weight:600;font-size:14px;padding:11px 22px;border-radius:8px">Open the dashboard</a></td></tr>
<tr><td align="center" style="padding:8px 24px 24px;font-size:11px;color:${C.faint}">You get this because you manage one or more of the shops; each copy covers only the shops and reports you can see. The brand chooses who gets it under <a href="${esc(doc.settingsUrl)}" style="color:${C.faint}">Setup › Morning Dashboard email</a>.</td></tr>
</table></td></tr></table></body></html>`;
}

// ───────────────────────────── PDF ─────────────────────────────

export function renderMorningPdf(d: MorningDashboard): Uint8Array {
  const doc = morningDoc(d);
  const pdf = new PdfDoc();
  const M = 40;
  const W = pdf.width - 2 * M;
  let y = 48;
  const room = (h: number) => {
    if (y + h > pdf.height - 40) {
      pdf.addPage();
      y = 48;
    }
  };
  const plain = (s: string) => s.replace(/▲/g, "+").replace(/▼/g, "-").replace(/—/g, "-");
  pdf.text(M, y, "RAY'Z BARBER SHOP - MORNING DASHBOARD", { size: 8, gray: 0.4 });
  y += 18;
  pdf.text(M, y, doc.title, { size: 16, bold: true });
  y += 16;
  pdf.text(M, y, `${doc.dateLabel} - ${doc.versionLabel}`, { size: 10 });
  y += 13;
  pdf.text(M, y, doc.coverage, { size: 9, gray: 0.35 });
  y += 18;
  if (doc.tiles.length) {
    const tw = W / doc.tiles.length;
    doc.tiles.forEach((t, i) => {
      const x = M + i * tw;
      pdf.rect(x + 2, y, tw - 4, 46);
      pdf.text(x + 8, y + 12, t.label.toUpperCase(), { size: 7, gray: 0.35 });
      pdf.text(x + 8, y + 28, t.value, { size: 14, bold: true });
      pdf.text(x + 8, y + 40, fitText(plain(`${t.change} - ${t.sub}`), tw - 16, 7), { size: 7, gray: 0.35 });
    });
    y += 58;
  }
  for (const s of doc.sections) {
    room(40);
    pdf.text(M, y, s.title, { size: 12, bold: true });
    y += 4;
    pdf.line(M, y, M + W, y, { width: 0.75, gray: 0.2 });
    y += 12;
    if (s.subtitle) {
      pdf.text(M, y, fitText(s.subtitle, W, 8), { size: 8, gray: 0.35 });
      y += 12;
    }
    for (const b of s.blocks) {
      if (b.kind === "metrics") {
        room(14);
        const cols = [M + 200, M + 290, M + 400, M + W];
        pdf.text(cols[0], y, "Day", { size: 7, gray: 0.45, align: "right" });
        pdf.text(cols[2], y, "Week to date", { size: 7, gray: 0.45, align: "right" });
        y += 10;
        for (const r of b.rows) {
          room(12);
          pdf.text(M + (r.label.startsWith(" ") ? 10 : 0), y, r.label.trim(), { size: 9 });
          pdf.text(cols[0], y, r.day, { size: 9, bold: true, align: "right" });
          pdf.text(cols[1], y, plain(r.dayChange), { size: 8, gray: 0.35, align: "right" });
          pdf.text(cols[2], y, r.wtd, { size: 9, align: "right" });
          pdf.text(cols[3], y, plain(r.wtdChange), { size: 8, gray: 0.35, align: "right" });
          y += 12;
        }
      } else if (b.kind === "table") {
        room(26);
        if (b.title) {
          pdf.text(M, y, fitText(b.title, W, 9, true), { size: 9, bold: true });
          y += 12;
        }
        const first = Math.min(150, W * 0.3);
        const rest = (W - first) / Math.max(1, b.columns.length - 1);
        const xOf = (i: number) => (i === 0 ? M : M + first + rest * (i - 1));
        const draw = (cells: string[], o: { size: number; gray?: number; bold?: boolean }) =>
          cells.forEach((c, i) => {
            const w = i === 0 ? first - 4 : rest - 4;
            if (b.numeric[i]) pdf.text(xOf(i) + rest - 4, y, fitText(plain(c), w, o.size, o.bold), { ...o, align: "right" });
            else pdf.text(xOf(i), y, fitText(plain(c), i === b.columns.length - 1 ? W - (xOf(i) - M) : w, o.size, o.bold), o);
          });
        draw(b.columns, { size: 7, gray: 0.45 });
        y += 10;
        for (const r of b.rows) {
          room(11);
          draw(r, { size: 8 });
          y += 11;
        }
      } else if (b.kind === "bars") {
        room(26);
        pdf.text(M, y, b.title, { size: 9, bold: true });
        y += 12;
        const max = Math.max(1, ...b.rows.map((r) => Math.max(r.value, r.prior ?? 0)));
        const bw = W - 200;
        for (const r of b.rows) {
          room(14);
          pdf.text(M, y, fitText(r.label, 90, 8), { size: 8 });
          pdf.rect(M + 95, y - 7, Math.max(0.5, (bw * Math.max(0, r.value)) / max), 6, 0.15);
          if (r.prior !== undefined) pdf.rect(M + 95, y, Math.max(0.5, (bw * Math.max(0, r.prior)) / max), 3, 0.75);
          pdf.text(M + W, y, fitText(plain(r.valueLabel), 100, 8), { size: 8, align: "right" });
          y += 14;
        }
      } else if (b.kind === "list") {
        room(14);
        if (b.title) {
          pdf.text(M, y, b.title, { size: 9, bold: true });
          y += 12;
        }
        for (const i of b.items) {
          room(i.detail ? 22 : 12);
          pdf.text(M, y, `${i.severity === "high" ? "!" : "-"} ${fitText(i.title, W - 12, 9)}`, { size: 9, bold: i.severity === "high" });
          y += 11;
          if (i.detail) {
            pdf.text(M + 10, y, fitText(plain(i.detail), W - 10, 8), { size: 8, gray: 0.35 });
            y += 11;
          }
        }
      } else {
        room(12);
        pdf.text(M, y, fitText(plain(b.text), W, 8), { size: 8, gray: 0.35 });
        y += 12;
      }
      y += 4;
    }
    y += 10;
  }
  room(14);
  pdf.text(M, y, fitText(`Open the dashboard: ${doc.dashboardUrl}`, W, 8), { size: 8, gray: 0.35 });
  return pdf.toBytes();
}
