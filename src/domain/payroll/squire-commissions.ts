import type { SquireImportTotals } from "@/db/schema";
import { csvCells } from "./time-csv";

/** Someone the report's names can match: Squire's own name for them first, then the name in the app. */
export interface SquireStaff {
  id: string;
  label: string;
  first: string;
  last: string | null;
  squireName: string | null;
  /** Works at the shop being imported: only they match on a first name alone. */
  atShop: boolean;
}

export interface SquireCommissionRow {
  staffId: string;
  squireName: string;
  workedCenti: number;
  otCenti: number;
  ptoCenti: number;
  trainingCenti: number;
  serviceCents: number;
  productCents: number;
  tipsCents: number;
  salesTaxCents: number;
}

export interface ParsedSquireCommissions {
  rows: SquireCommissionRow[];
  /** Any error means nothing is imported. */
  errors: string[];
  /** Kept with the import and shown: things that were left out on purpose. */
  notes: string[];
  totals: SquireImportTotals;
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

const COLUMNS = {
  name: ["name", "barber", "employee", "staff", "employeename"],
  hours: ["hoursworked", "hours", "totalhours"],
  total: ["total", "netsales"],
  tips: ["tips", "totaltips"],
  tipParts: ["squiretips", "postips", "giftcardtips"],
  tax: ["tax", "salestax"],
  ot: ["othours", "ot", "othrs", "overtime", "overtimehours"],
  pto: ["pto", "ptohours", "ptohrs", "paidtime", "paidtimehours"],
  training: ["training", "traininghours", "traininghrs"],
  shop: ["shop", "location", "store"],
} as const;

type Col = Exclude<keyof typeof COLUMNS, "tipParts">;
type Head = Partial<Record<Col, number>> & { tipParts: number[] };

/** Dollars as Squire prints them ("$1,234.56", "(12.00)", "-") in cents; null when it isn't a number. */
export function squireCents(raw: string | undefined): number | null {
  const s = (raw ?? "").trim();
  if (!s || s === "-" || s === "$-" || s === "$ -") return 0;
  const neg = /^\(.*\)$/.test(s) || s.startsWith("-");
  const t = s.replace(/[()$,\s-]/g, "");
  if (!/^\d+(\.\d+)?$/.test(t)) return null;
  const cents = Math.round(Number(t) * 100);
  return neg ? -cents : cents;
}

/** Hours as decimals ("69.53") or h:mm ("69:32"), in hundredths; null when it isn't a number of hours. */
export function squireCentiHours(raw: string | undefined): number | null {
  const s = (raw ?? "").trim();
  if (!s || s === "-") return 0;
  const hm = /^(\d+):([0-5]\d)$/.exec(s);
  if (hm) return Math.round((Number(hm[1]) + Number(hm[2]) / 60) * 100);
  if (!/^\d+(\.\d+)?$/.test(s.replace(/,/g, ""))) return null;
  return Math.round(Number(s.replace(/,/g, "")) * 100);
}

const splitLine = (line: string, tabs: boolean) => (tabs ? line.split("\t").map((c) => c.trim()) : csvCells(line));

function headerOf(cells: string[]): Head | null {
  const n = cells.map(norm);
  const at = (names: readonly string[]) => n.findIndex((h) => names.includes(h));
  if (at(COLUMNS.name) < 0 || at(COLUMNS.total) < 0) return null;
  const out: Head = { tipParts: n.flatMap((x, k) => ((COLUMNS.tipParts as readonly string[]).includes(x) ? [k] : [])) };
  for (const k of Object.keys(COLUMNS).filter((x): x is Col => x !== "tipParts")) {
    const i = at(COLUMNS[k]);
    if (i >= 0) out[k] = i;
  }
  return out;
}

/**
 * Squire's Commissions report for one shop and pay period, as exported or copied from Squire: a
 * service block, then a product block, each with its own header row (Name, Hours Worked, …, Total,
 * …, Tips, …, Tax). Per person: hours worked (OT included) from column B, service and product sales
 * from each block's Total (net of tax and tips), tips from the service block's Tips (or its Squire,
 * POS and Gift Card Tips added up), as the workbook takes them, and sales tax from both, for reference. Squire has no OT, PTO or training hours; extra
 * columns with those headers are read when someone adds them. Names match Squire's name for the
 * person (Staff → Squire name), then the name in the app, then a first name only one person at the
 * shop has. With a Shop/Location column, only that shop's rows count. Any problem is an error and
 * nothing is imported.
 */
export function parseSquireCommissions(text: string, o: { staff: SquireStaff[]; shop?: { name: string; slug: string } }): ParsedSquireCommissions {
  const totals: SquireImportTotals = { workedCenti: 0, serviceCents: 0, productCents: 0, tipsCents: 0, salesTaxCents: 0, unassignedServiceCents: 0, unassignedProductCents: 0 };
  const errors: string[] = [];
  const notes: string[] = [];
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
  const firstLine = lines.find((l) => l.trim()) ?? "";
  if (!firstLine) return { rows: [], errors: ["The file is empty."], notes, totals };
  const tabs = firstLine.includes("\t") && !firstLine.includes(",");

  const keyed = new Map<string, Set<string>>();
  const add = (k: string | null | undefined, id: string, map = keyed) => {
    if (!k || !norm(k)) return;
    const set = map.get(norm(k)) ?? new Set<string>();
    set.add(id);
    map.set(norm(k), set);
  };
  const bySquire = new Map<string, Set<string>>();
  const byFirst = new Map<string, Set<string>>();
  for (const s of o.staff) {
    add(s.squireName, s.id, bySquire);
    add(s.label, s.id);
    add([s.first, s.last].filter(Boolean).join(" "), s.id);
    if (s.atShop) add(s.first, s.id, byFirst);
  }
  const labelOf = new Map(o.staff.map((s) => [s.id, s.label]));
  const match = (name: string): { id: string } | { error: string } | null => {
    for (const [map, how] of [
      [bySquire, "Squire name"],
      [keyed, "name"],
      [byFirst, "first name at this shop"],
    ] as const) {
      const hit = map.get(norm(name)) ?? (map === byFirst ? map.get(norm(name.split(/\s+/)[0] ?? "")) : undefined);
      if (!hit?.size) continue;
      if (hit.size > 1) return { error: `"${name}" matches more than one person by ${how} (${[...hit].map((id) => labelOf.get(id)).join(", ")}). Set each one's Squire name under Staff.` };
      return { id: [...hit][0] };
    }
    return null;
  };

  type Acc = SquireCommissionRow & { blocks: Set<number>; productHours: number | null };
  const byStaff = new Map<string, Acc>();
  let block = -1;
  let head: Head = { tipParts: [] };
  let shopFilteredOut = 0;
  const shopKeys = o.shop ? new Set([norm(o.shop.name), norm(o.shop.slug)]) : null;

  lines.forEach((line, i) => {
    if (!line.trim()) return;
    const n = i + 1;
    const cells = splitLine(line, tabs);
    const h = headerOf(cells);
    if (h) {
      block++;
      head = h;
      if (block > 1) errors.push(`Line ${n}: a third header row. The report has a service block and a product block only.`);
      return;
    }
    if (block < 0 || head.name === undefined || cells.filter(Boolean).length < 2) return;
    const name = (cells[head.name] ?? "").trim();
    if (!name || /^(grand\s+)?totals?:?$/i.test(name)) return;
    if (head.shop !== undefined && shopKeys && !shopKeys.has(norm(cells[head.shop] ?? ""))) {
      shopFilteredOut++;
      return;
    }
    const kind = block === 0 ? "service" : "product";
    const amount = (k: number, label: string) => {
      const v = squireCents(cells[k]);
      if (v === null) errors.push(`Line ${n} (${name}): ${label} "${cells[k]}" isn't an amount.`);
      return v ?? 0;
    };
    const money = (c: Col, label: string) => (head[c] === undefined ? 0 : amount(head[c]!, label));
    const hours = (c: Col, label: string) => {
      if (head[c] === undefined) return 0;
      const v = squireCentiHours(cells[head[c]!]);
      if (v === null) errors.push(`Line ${n} (${name}): ${label} "${cells[head[c]!]}" isn't a number of hours.`);
      return v ?? 0;
    };
    const total = money("total", "Total");
    if (/^unassigned/i.test(name)) {
      if (kind === "service") totals.unassignedServiceCents += total;
      else totals.unassignedProductCents += total;
      return;
    }
    const tips = head.tips !== undefined ? money("tips", "Tips") : head.tipParts.reduce((a, k) => a + amount(k, "Tips"), 0);
    const tax = money("tax", "Tax");
    const worked = hours("hours", "Hours Worked");
    const ot = hours("ot", "OT hours");
    const pto = hours("pto", "PTO hours");
    const training = hours("training", "Training hours");
    const m = match(name);
    if (!m) {
      if (!total && !tips && !worked) notes.push(`${name}: no figures on the ${kind} report, and no match here; left out.`);
      else errors.push(`Line ${n}: no one here matches "${name}". Set their Squire name under Staff, then import again.`);
      return;
    }
    if ("error" in m) {
      errors.push(`Line ${n}: ${m.error}`);
      return;
    }
    const acc: Acc = byStaff.get(m.id) ?? {
      staffId: m.id,
      squireName: name,
      workedCenti: 0,
      otCenti: 0,
      ptoCenti: 0,
      trainingCenti: 0,
      serviceCents: 0,
      productCents: 0,
      tipsCents: 0,
      salesTaxCents: 0,
      blocks: new Set(),
      productHours: null,
    };
    if (acc.blocks.has(block)) {
      errors.push(`Line ${n}: ${labelOf.get(m.id)} is on the ${kind} report twice${acc.squireName !== name ? ` (as "${acc.squireName}" and "${name}")` : ""}.`);
      return;
    }
    acc.blocks.add(block);
    acc.salesTaxCents += tax;
    if (kind === "service") {
      acc.workedCenti = worked;
      acc.serviceCents = total;
      acc.tipsCents = tips;
    } else {
      acc.productCents = total;
      acc.productHours = worked;
      if (tips) notes.push(`${name}: $${(tips / 100).toFixed(2)} of tips on the product report aren't counted; tips come from the service report, as in the workbook.`);
    }
    if (ot && !acc.otCenti) acc.otCenti = ot;
    if (pto && !acc.ptoCenti) acc.ptoCenti = pto;
    if (training && !acc.trainingCenti) acc.trainingCenti = training;
    byStaff.set(m.id, acc);
  });

  if (block < 0) errors.push("No header row with Name and Total. Export Squire's Commissions report for the shop and pay period, or copy it with its headers.");
  if (shopFilteredOut) notes.push(`${shopFilteredOut} row${shopFilteredOut === 1 ? "" : "s"} for other shops left out.`);
  const rows: SquireCommissionRow[] = [];
  for (const a of byStaff.values()) {
    if (![a.workedCenti, a.productHours ?? 0, a.otCenti, a.ptoCenti, a.trainingCenti, a.serviceCents, a.productCents, a.tipsCents, a.salesTaxCents].some(Boolean)) continue;
    if (!a.blocks.has(0) && a.productHours !== null) a.workedCenti = a.productHours;
    else if (a.productHours && a.productHours !== a.workedCenti)
      notes.push(`${a.squireName}: the product report has ${(a.productHours / 100).toFixed(2)} hours, the service report ${(a.workedCenti / 100).toFixed(2)}; the service report's are used.`);
    if (a.otCenti > a.workedCenti) errors.push(`${a.squireName}: ${(a.otCenti / 100).toFixed(2)} OT hours is more than their ${(a.workedCenti / 100).toFixed(2)} hours worked (which include OT).`);
    if (a.workedCenti < 0) errors.push(`${a.squireName}: hours worked can't be negative.`);
    const { blocks: _b, productHours: _p, ...row } = a;
    rows.push(row);
    totals.workedCenti += a.workedCenti;
    totals.serviceCents += a.serviceCents;
    totals.productCents += a.productCents;
    totals.tipsCents += a.tipsCents;
    totals.salesTaxCents += a.salesTaxCents;
  }
  if (!errors.length && !rows.length) errors.push("No one's figures are in the file.");
  rows.sort((a, b) => a.squireName.localeCompare(b.squireName));
  return { rows, errors, notes, totals };
}
