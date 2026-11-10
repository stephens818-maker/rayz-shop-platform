import { inArray, sql } from "drizzle-orm";
import Papa from "papaparse";
import { db } from "@/db";
import { customerSquireIds, customers } from "@/db/schema";
import { cleanName } from "@/domain/customers";
import { scoreDuplicate } from "@/domain/duplicates";
import { familyColumns } from "@/domain/family-import";
import { localDateOf, todayLocal } from "@/lib/time";
import { Actor } from "./audit";
import { mergeDuplicatePairs, type Customer } from "./customers";
import { mapHeaders, parseSquireDateTime } from "./importer";

export interface SquireReconcileResult {
  /** Rows in the file with a birthday. */
  withBirthday: number;
  /** People the file lists more than once under different Squire IDs by the same full name and birthday (one client at several Squire shops). */
  inFile: number;
  /** Clients whose empty birthday the file filled in. */
  birthdaysFilled: number;
  /** Records folded into one profile: the same full name and birthday, and no phone or email that disagrees. */
  merged: number;
  /** Same name and birthday but something disagrees: left on the duplicates page for a person to decide. */
  review: number;
  problems: { line?: number; message: string }[];
}

const ids = (list: readonly string[]) => sql`(${sql.join(
  list.map((i) => sql`${i}::uuid`),
  sql`, `,
)})`;

/** Same phone and email or one side missing them: nothing on file says these are two people. */
function agrees(a: Customer, b: Customer): boolean {
  const differ = (x: string | null, y: string | null) => !!x && !!y && x !== y;
  if (differ(a.phone, b.phone) || differ(a.email, b.email)) return false;
  if (a.guardianId && b.guardianId && a.guardianId !== b.guardianId) return false;
  if (a.guardianId === b.id || b.guardianId === a.id) return false;
  const s = scoreDuplicate(side(a), side(b));
  return s.signals.includes("same_name") && s.signals.includes("birthday") && !s.conflicts.length;
}

const side = (c: Customer) => ({ firstName: c.firstName, lastName: c.lastName, nickname: c.nickname, phone: c.phone, email: c.email, birthday: c.birthday, zip: c.addressZip });

/**
 * After a Squire clients import: one profile per client across every shop. The importer already
 * folds rows that share a Squire ID, or an email or phone with a compatible name, into one client.
 * This adds the birthday: it fills in birthdays the file has and the profile doesn't, then merges
 * any two clients with the same full name and birthday when no phone or email on either says
 * they're two people (the same person at two Squire shops under different numbers). Pairs where
 * something disagrees are counted and left for the duplicates page's Squire tab, as "likely".
 * Pairs someone already marked "not the same person" are left alone. A dry run only reads the
 * file. Returns null when the file has no Squire ID or birthday column.
 */
export async function reconcileSquireClients(csv: string, opts: { dryRun: boolean; actor: Actor; now?: Date }): Promise<SquireReconcileResult | null> {
  const parsed = Papa.parse<Record<string, string>>(csv.replace(/^\uFEFF/, ""), { header: true, skipEmptyLines: "greedy" });
  const headers = parsed.meta.fields ?? [];
  const base = mapHeaders(headers, "clients");
  const birthdayCol = familyColumns(headers).birthday;
  if (!base.squireId || !birthdayCol) return null;
  const today = todayLocal(opts.now ?? new Date());
  const cell = (r: Record<string, string>, h: string | undefined) => (h ? r[h]?.trim() || undefined : undefined);
  const nameOf = (r: Record<string, string>) => {
    const full = cell(r, base.fullName);
    const named = [cell(r, base.firstName), cell(r, base.lastName)].filter(Boolean).join(" ");
    return cleanName(named || (full?.includes(",") ? full.split(",").reverse().join(" ") : full));
  };
  const result: SquireReconcileResult = { withBirthday: 0, inFile: 0, birthdaysFilled: 0, merged: 0, review: 0, problems: [] };
  const birthdays = new Map<string, { day: string; line: number }>();
  const people = new Map<string, Set<string>>();
  parsed.data.forEach((r, i) => {
    const squireId = cell(r, base.squireId);
    const raw = cell(r, birthdayCol);
    if (!squireId || !raw) return;
    const when = parseSquireDateTime(raw);
    const day = when ? localDateOf(when) : null;
    if (!day || day > today) {
      result.problems.push({ line: i + 2, message: `"${raw}" isn't a birthday the import can read.` });
      return;
    }
    result.withBirthday++;
    const had = birthdays.get(squireId);
    if (had && had.day !== day) result.problems.push({ line: i + 2, message: `Squire client ${squireId} has two birthdays in the file; the first (row ${had.line}) is used.` });
    if (!had) birthdays.set(squireId, { day, line: i + 2 });
    const name = nameOf(r);
    if (name && name.includes(" ")) {
      const key = `${name}|${day}`;
      people.set(key, (people.get(key) ?? new Set()).add(squireId));
    }
  });
  result.inFile = [...people.values()].filter((s) => s.size > 1).length;
  if (opts.dryRun || !birthdays.size) return result;

  const owners = new Map<string, string>();
  const squireIds = [...birthdays.keys()];
  for (let i = 0; i < squireIds.length; i += 1000) {
    const rows = await db
      .select({ squireId: customerSquireIds.squireId, customerId: customerSquireIds.customerId })
      .from(customerSquireIds)
      .where(inArray(customerSquireIds.squireId, squireIds.slice(i, i + 1000)));
    for (const r of rows) owners.set(r.squireId, r.customerId);
  }
  const fills = [...birthdays].flatMap(([sid, b]) => (owners.has(sid) ? [{ id: owners.get(sid)!, d: b.day }] : []));
  if (!fills.length) return result;
  const filled = (await db.execute(sql`
    update customers c set birthday = x.d::date, birth_year = extract(year from x.d::date)::int
    from (select distinct on (id) id, d from jsonb_to_recordset(${JSON.stringify(fills)}::jsonb) as r(id uuid, d text) order by id) x
    where c.id = x.id and c.birthday is null
    returning c.id`)) as unknown as { id: string }[];
  result.birthdaysFilled = filled.length;

  const touched = [...new Set(fills.map((f) => f.id))];
  const pairs: { a: string; b: string }[] = [];
  for (let i = 0; i < touched.length; i += 1000) {
    const batch = touched.slice(i, i + 1000);
    const rows = (await db.execute(sql`
      select least(a.id, b.id) a_id, greatest(a.id, b.id) b_id
      from customers a join customers b on b.id <> a.id and b.birthday = a.birthday
        and lower(btrim(b.first_name)) = lower(btrim(a.first_name)) and lower(btrim(b.last_name)) = lower(btrim(a.last_name))
      where a.id in ${ids(batch)} and a.birthday is not null and coalesce(btrim(a.last_name), '') <> ''
        and not exists (select 1 from customer_duplicate_dismissals d where d.a_id = least(a.id, b.id) and d.b_id = greatest(a.id, b.id))`)) as unknown as {
      a_id: string;
      b_id: string;
    }[];
    for (const r of rows) pairs.push({ a: r.a_id, b: r.b_id });
  }
  const unique = [...new Map(pairs.map((p) => [`${p.a}|${p.b}`, p])).values()];
  if (!unique.length) return result;
  const records = new Map(
    (await db.select().from(customers).where(inArray(customers.id, [...new Set(unique.flatMap((p) => [p.a, p.b]))]))).map((c) => [c.id, c]),
  );
  const sure = unique.filter((p) => agrees(records.get(p.a)!, records.get(p.b)!));
  result.review = unique.length - sure.length;
  if (sure.length) {
    const r = await mergeDuplicatePairs(sure, opts.actor);
    result.merged = r.merged;
    result.review += r.failed.length;
    if (r.failed.length) result.problems.push({ message: `${r.failed.length} same-name-and-birthday pair${r.failed.length === 1 ? "" : "s"} couldn't be merged automatically: see the duplicates page.` });
  }
  return result;
}
