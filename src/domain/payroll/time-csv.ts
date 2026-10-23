import { DateTime } from "luxon";
import { SHOP_TZ } from "@/lib/time";
import type { EntryKind } from "./overtime";

export interface CsvStaff {
  id: string;
  label: string;
  first: string;
  last: string | null;
  number: string | null;
  isolvedName: string | null;
}

export interface CsvShop {
  id: string;
  name: string;
  slug: string;
}

export interface ParsedShift {
  staffId: string;
  shopId: string;
  kind: EntryKind;
  startsAt: Date;
  endsAt: Date;
  note: string | null;
}

/** Splits one CSV line, with quoted fields ("a, b") and doubled quotes inside them. */
export function csvCells(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (c === '"') q = false;
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === ",") {
      out.push(cur.trim());
      cur = "";
    } else cur += c;
  }
  out.push(cur.trim());
  return out;
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

function parseDate(s: string): string | null {
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/.exec(s);
  const [y, m, d] = iso ? [iso[1], iso[2], iso[3]] : us ? [us[3].length === 2 ? `20${us[3]}` : us[3], us[1], us[2]] : [];
  if (!y) return null;
  const dt = DateTime.fromObject({ year: Number(y), month: Number(m), day: Number(d) }, { zone: SHOP_TZ });
  return dt.isValid ? dt.toISODate() : null;
}

function parseTime(s: string): { h: number; m: number } | null {
  const t = /^(\d{1,2}):(\d{2})(?::\d{2})?\s*([ap]\.?m\.?)?$/i.exec(s.trim());
  if (!t) return null;
  let h = Number(t[1]);
  const m = Number(t[2]);
  const ap = t[3]?.[0]?.toLowerCase();
  if (ap === "p" && h < 12) h += 12;
  if (ap === "a" && h === 12) h = 0;
  return h < 24 && m < 60 ? { h, m } : null;
}

/**
 * Shifts from a CSV with a header row: employee, shop, date, start, end, and optional kind
 * (worked, training, pto) and note. The employee is matched by iSolved Employee Number, iSolved
 * name, or the name shown in the app; times are shop time, and an end before the start runs past midnight.
 */
export function parseTimeCsv(csv: string, o: { staff: CsvStaff[]; shops: CsvShop[] }): { rows: ParsedShift[]; errors: string[] } {
  const lines = csv.split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) return { rows: [], errors: ["The file is empty."] };
  const head = csvCells(lines[0]).map(norm);
  const col = (...names: string[]) => head.findIndex((h) => names.includes(h));
  const ci = { emp: col("employee", "key", "employeenumber", "name"), shop: col("shop", "location", "paygroup"), date: col("date", "day"), start: col("start", "in", "clockin"), end: col("end", "out", "clockout"), kind: col("kind", "type"), note: col("note", "notes") };
  const missing = (["emp", "shop", "date", "start", "end"] as const).filter((k) => ci[k] < 0);
  if (missing.length) return { rows: [], errors: [`The header needs columns for employee, shop, date, start and end (missing: ${missing.join(", ")}).`] };

  const byKey = new Map<string, string>();
  for (const s of o.staff) {
    for (const k of [s.number, s.isolvedName, s.label, [s.first, s.last].filter(Boolean).join(" "), s.last ? `${s.last}, ${s.first}` : null]) if (k) byKey.set(norm(k), s.id);
  }
  const shopOf = new Map<string, string>();
  for (const s of o.shops) for (const k of [s.name, s.slug]) shopOf.set(norm(k), s.id);

  const rows: ParsedShift[] = [];
  const errors: string[] = [];
  lines.slice(1).forEach((line, i) => {
    const c = csvCells(line);
    const n = i + 2;
    const staffId = byKey.get(norm(c[ci.emp] ?? ""));
    const shopId = shopOf.get(norm(c[ci.shop] ?? ""));
    const date = parseDate(c[ci.date] ?? "");
    const st = parseTime(c[ci.start] ?? "");
    const en = parseTime(c[ci.end] ?? "");
    const kindRaw = ci.kind >= 0 ? (c[ci.kind] ?? "").toLowerCase() : "";
    const kind: EntryKind | null = !kindRaw || kindRaw === "worked" || kindRaw === "work" ? "worked" : kindRaw === "training" ? "training" : kindRaw === "pto" ? "pto" : null;
    const problems = [!staffId && `no employee "${c[ci.emp] ?? ""}"`, !shopId && `no shop "${c[ci.shop] ?? ""}"`, !date && "bad date", (!st || !en) && "bad time", !kind && `unknown kind "${kindRaw}"`].filter(Boolean);
    if (problems.length) {
      errors.push(`Line ${n}: ${problems.join(", ")}.`);
      return;
    }
    const s = DateTime.fromISO(date!, { zone: SHOP_TZ }).set({ hour: st!.h, minute: st!.m });
    let e = DateTime.fromISO(date!, { zone: SHOP_TZ }).set({ hour: en!.h, minute: en!.m });
    if (e <= s) e = e.plus({ days: 1 });
    rows.push({ staffId: staffId!, shopId: shopId!, kind: kind!, startsAt: s.toJSDate(), endsAt: e.toJSDate(), note: ci.note >= 0 ? c[ci.note] || null : null });
  });
  return { rows, errors };
}
