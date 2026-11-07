import { and, eq, gte, inArray, isNull, lte } from "drizzle-orm";
import { db } from "@/db";
import { receiptDeliveries, reviewClicks, sales, staff } from "@/db/schema";
import { Cell, Column, ListRow, ViewCtx, listTable } from "@/domain/report-views";
import { endOfLocalDay, startOfLocalDay } from "@/lib/time";
import type { ReportData } from "./report-data";
import { ReportScope, staffSelection } from "./reports";

const text = (label: string): Column => ({ label });
const int = (label: string): Column => ({ label, kind: "int" });
const pct = (label: string): Column => ({ label, kind: "pct", sum: false });

const COLUMNS = [
  int("Follow-ups sent"),
  int("Clicks from receipts"),
  int("Clicks from follow-ups"),
  int("Clicks"),
  int("Tickets with a click"),
  int("Follow-ups clicked"),
  pct("Follow-up click rate"),
];
/** Cells after the label: sent, receipt clicks, follow-up clicks, clicks, tickets clicked, follow-ups clicked, rate. */
const rate = (c: Cell[]): Cell[] => {
  const sent = Number(c[1]) || 0;
  return [...c.slice(0, 7), sent ? (Number(c[6]) || 0) / sent : null];
};

/**
 * Google review links by location and barber: follow-ups sent and clicks on the link, from the
 * receipt page and from follow-ups. Clicks count against the ticket's barber and location. Google
 * doesn't report whether a review was posted, so this is clicks, not reviews.
 */
export async function reviewReportData(scope: ReportScope, loc: ViewCtx): Promise<ReportData> {
  if (!scope.shopIds.length) return { stats: [], tables: [] };
  const from = startOfLocalDay(scope.from);
  const to = endOfLocalDay(scope.to);
  const sel = staffSelection(scope);
  const [sent, clicks] = await Promise.all([
    db
      .select({ shopId: receiptDeliveries.shopId, staffId: sales.staffId, saleId: receiptDeliveries.saleId })
      .from(receiptDeliveries)
      .innerJoin(sales, eq(sales.id, receiptDeliveries.saleId))
      .where(
        and(
          eq(receiptDeliveries.purpose, "review"),
          isNull(receiptDeliveries.skipped),
          inArray(receiptDeliveries.shopId, scope.shopIds),
          gte(receiptDeliveries.createdAt, from),
          lte(receiptDeliveries.createdAt, to),
          sel ? inArray(sales.staffId, sel) : undefined,
        ),
      ),
    db
      .select({ shopId: reviewClicks.shopId, staffId: reviewClicks.staffId, saleId: reviewClicks.saleId, source: reviewClicks.source })
      .from(reviewClicks)
      .where(and(inArray(reviewClicks.shopId, scope.shopIds), gte(reviewClicks.createdAt, from), lte(reviewClicks.createdAt, to), sel ? inArray(reviewClicks.staffId, sel) : undefined)),
  ]);
  const ids = [...new Set([...sent, ...clicks].map((r) => r.staffId).filter((x): x is string => !!x))];
  const labels = new Map(ids.length ? (await db.select({ id: staff.id, label: staff.displayLabel }).from(staff).where(inArray(staff.id, ids))).map((s) => [s.id, s.label]) : []);
  const barber = (id: string | null) => (id ? (labels.get(id) ?? "") : "No barber");
  const shopName = new Map(loc.shops.map((s) => [s.id, s.name]));

  // One row per event; tickets with a click and follow-ups clicked count once per ticket.
  type Ev = { shopId: string; staffId: string | null; counts: [number, number, number, number, number, number] };
  const events: Ev[] = [
    ...sent.map((r) => ({ shopId: r.shopId, staffId: r.staffId, counts: [1, 0, 0, 0, 0, 0] as Ev["counts"] })),
    ...clicks.map((c) => ({ shopId: c.shopId, staffId: c.staffId, counts: [0, c.source === "receipt" ? 1 : 0, c.source === "follow_up" ? 1 : 0, 1, 0, 0] as Ev["counts"] })),
  ];
  const seen = new Set<string>();
  for (const c of clicks) {
    if (!seen.has(c.saleId)) {
      seen.add(c.saleId);
      events.push({ shopId: c.shopId, staffId: c.staffId, counts: [0, 0, 0, 0, 1, 0] });
    }
  }
  const followed = new Set<string>();
  for (const c of clicks.filter((x) => x.source === "follow_up")) {
    if (!followed.has(c.saleId)) {
      followed.add(c.saleId);
      events.push({ shopId: c.shopId, staffId: c.staffId, counts: [0, 0, 0, 0, 0, 1] });
    }
  }
  const rows = (label: (e: Ev) => string, key: (e: Ev) => string): ListRow[] => events.map((e) => ({ shopId: e.shopId, staffId: e.staffId, key: key(e), cells: rate([label(e), ...e.counts, null]) }));
  const bySent = (a: Cell[], b: Cell[]) => Number(b[4]) - Number(a[4]) || Number(b[1]) - Number(a[1]) || String(a[0]).localeCompare(String(b[0]));

  const followUpClicks = clicks.filter((c) => c.source === "follow_up").length;
  return {
    stats: [
      { label: "Follow-ups sent", value: String(sent.length) },
      { label: "Clicks", value: String(clicks.length), hint: `${clicks.length - followUpClicks} from receipts, ${followUpClicks} from follow-ups` },
      { label: "Tickets with a click", value: String(seen.size) },
      { label: "Follow-up click rate", value: sent.length ? `${Math.round((followed.size / sent.length) * 100)}%` : "—", hint: `${followed.size} of ${sent.length} follow-ups clicked` },
    ],
    tables: [
      listTable(loc, {
        id: "barbers",
        title: "By barber",
        subtitle: "Clicks count against the ticket's barber.",
        columns: [text("Barber"), ...COLUMNS],
        rows: rows(
          (e) => barber(e.staffId),
          (e) => e.staffId ?? "none",
        ),
        merge: true,
        derive: rate,
        sort: bySent,
      }),
      listTable(loc, {
        id: "locations",
        title: "By location",
        columns: [text("Location"), ...COLUMNS],
        rows: rows(
          (e) => shopName.get(e.shopId) ?? "",
          (e) => e.shopId,
        ),
        merge: true,
        derive: rate,
        sort: bySent,
      }),
    ],
    notes: [
      "Clicks are taps on Leave a review on the receipt page and on the link in the review follow-up. Link previews and email scanners aren't counted, and a client who taps twice counts twice (Tickets with a click counts them once).",
      "Google doesn't tell us whether a review was posted, so these are clicks, not reviews. Every client gets the same link: nobody is picked or skipped by rating, tip or refund.",
    ],
  };
}
